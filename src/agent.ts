/**
 * Agent 主循环（Plan-Act + tool 审批 + budget 监控）。
 *
 * 单步循环：每次只跑一轮 LLM → 拿到 tool_calls → 审批/执行 → 续轮，直到 LLM 不再要工具。
 * 不放 execute 在 tool 定义里，而是手动 dispatch，强制走 classify → approve → run 流程。
 */
import { generateText, type LanguageModel, type ModelMessage } from 'ai';
import { EventEmitter } from 'node:events';
import { Budget } from './budget.ts';
import type { Approval, ToolRegistry } from './tools/index.ts';

export interface ToolCallPending {
  id: string;
  name: string;
  args: unknown;
  approval: Approval;
}

export interface AgentEvents {
  assistant: (text: string) => void;
  toolCall: (call: ToolCallPending) => void;
  toolResult: (id: string, name: string, result: unknown) => void;
  toolDenied: (id: string, name: string, reason: string) => void;
  budget: (used: number, max: number, level: 'green' | 'yellow' | 'red') => void;
  warn: (msg: string) => void;
  error: (e: Error) => void;
  done: (reason: string) => void;
}

export type ApprovalDecider = (call: ToolCallPending) => Promise<boolean>;

export interface AgentOpts {
  model: LanguageModel;
  tools: ToolRegistry;
  budget: Budget;
  systemPrompt: string;
  /** 用户决策：true = 同意 / false = 拒绝 */
  approve: ApprovalDecider;
  /** 最大循环轮次（防死循环），默认 30 */
  maxSteps?: number;
  /** Zod 校验失败重试次数（把错误喂回模型让它修 args），默认 2 */
  maxRetries?: number;
  /** 检测到"宣布下一步却无工具调用"时最多注入几次续跑提示，默认 2 */
  maxNudges?: number;
  /** 预算过红线(90%)后还允许几步探索，超过强制收尾（补 budget 不硬停的 D4），默认 3 */
  maxRedSteps?: number;
  /** 单步 LLM 调用超时（ms），防本地后端 stall 永久 hang（A1）。默认 120_000 */
  stepTimeoutMs?: number;
  /** 单步 LLM 输出 token 上限，防单轮爆炸（A1）。默认 8_000 */
  maxOutputTokens?: number;
  /** 可重试错误（网络/5xx/超时）的重试次数，指数退避（A2）。默认 2 */
  maxLlmRetries?: number;
}

/** 判断 LLM 调用错误是否可重试（网络抖动/限流/5xx/超时/abort），据此决定退避重试还是直接 throw（A2）。 */
function isRetryableError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  const name = e instanceof Error ? e.name.toLowerCase() : '';
  return (
    name === 'aborterror' ||
    name === 'timeouterror' ||
    /\b(?:429|500|502|503|504)\b/.test(msg) ||
    /timeout|timed out|econnreset|econnrefused|enotfound|etimedout|socket hang up|fetch failed|network|rate.?limit|overloaded|temporarily/.test(
      msg,
    )
  );
}

/** sleep 用于指数退避（避免直接 setTimeout 泄漏）。 */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 判断助手本轮文本是否是「实质结论」（可以安全收尾），而非过程叙述/续跑意图。
 * 返回 false → loop 会注入一次收尾/续跑指令，防止 agent 拿到线索却不写答案就 done
 * （见 CTF benchmark：security-1/2/3、raw-apk-1 均停在"让我换个方式…"中间态，最终答案从未写出）。
 *
 * 判据（满足任一即视为结论）：
 *  1) 出现显式结论标记（## 最终结论 / 最终答案 / final answer …）
 *  2) 文本较长（>240 字符）且不以过渡语结尾——通常是已经在组织成段的答案
 * 反之，短文本、或以"让我…/换个方式…/进入阶段…/let me…"等过渡语收尾 → 判为过程态。
 */
/**
 * 判断助手本轮文本是否以「宣布下一步却没做」的续跑意图结尾（如"让我换个方式…/我要做：用 jadx…"）。
 * 这是 CTF benchmark 里唯一验证过的真实断链信号（raw-apk-3 / security-1/2 都栽在这）。
 * 只看结尾意图、不看长度——短的正常收尾（如"进程正常退出。"）不该被误判。
 * 显式「## 最终结论」标记直接视为已完成（返回 false）。
 */
function endsWithContinuationIntent(text: string): boolean {
  const t = text.trim();
  if (!t) return true; // 空文本 + 无工具调用 = 退化的空停，视为需要 nudge
  if (/##\s*最终结论|最终(答案|结论)|final\s+(answer|conclusion)/i.test(t)) return false;
  // 尾行是 markdown 标题（如 "## 阶段2：grep 搜索…"）= 打了个章节标题就停手，属断链宣布。
  const lastLine = t.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  if (/^#{1,6}\s/.test(lastLine)) return true;
  // 取「最后一句」：按换行/中文句号/英文句点/感叹问号切，取最后一个非空段。
  // 续跑意图（"让我…/我要做…/进入阶段2…/let me…"）通常独占最后一句，只在这一句里判，
  // 避免被正文里前面的句子干扰、也不强求贴 $（尾句可能带标点或 markdown 星号）。
  const segs = t
    .split(/[\n。！？!?]|\.(?=\s|$)/)
    .map((s) => s.replace(/[*_`#\s]/g, '').trim())
    .filter(Boolean);
  const last = segs[segs.length - 1] ?? '';
  if (!last) return false;
  const INTENT = [
    /让我/,
    /我(要|需要|准备|来|现在|接下来)/,
    /(换个|换一种|另一种)方式/,
    /(接下来|下一步)/,
    /进入阶段/,
    /(先|再)(来|去|跑|搜|读|试|看|确认|提取)/,
    /\blet me\b/i,
    /\bi'?ll\b/i,
    /\bnext\b.*\bi/i,
  ];
  return INTENT.some((re) => re.test(last));
}

export class Agent extends EventEmitter {
  private messages: ModelMessage[] = [];
  private stepCount = 0;
  private nudgeCount = 0;
  private redSteps = 0;
  private forcedFinish = false;
  private readonly systemPrompt: string;
  private readonly opts: Required<AgentOpts>;

  constructor(opts: AgentOpts) {
    super();
    this.opts = {
      maxSteps: 30,
      maxRetries: 2,
      maxNudges: 2,
      maxRedSteps: 3,
      stepTimeoutMs: 120_000,
      maxOutputTokens: 8_000,
      maxLlmRetries: 2,
      ...opts,
    } as Required<AgentOpts>;
    this.systemPrompt = opts.systemPrompt;
    // system 不放进 messages（v6 警告 prompt injection 风险），改用 generateText 的 system 字段
    // 把 budget 事件接到 agent emitter 上方便 UI 统一订阅
    this.opts.budget.on('change', (used, max, level) => this.emit('budget', used, max, level));
    this.opts.budget.on('yellow', (used, max) =>
      this.emit('warn', `Token 已达 70% (${used}/${max})，建议尽快用 append_note 存盘并准备重启会话`),
    );
    this.opts.budget.on('red', (used, max) =>
      this.emit('warn', `🚨 Token 已达 90% (${used}/${max})，立即写笔记并重启`),
    );
  }

  /** 添加用户消息 */
  addUserMessage(text: string): void {
    this.messages.push({ role: 'user', content: text });
  }

  /**
   * 重置「每轮」计数器（A6）。交互模式下每次用户新消息前调用——否则 stepCount/nudgeCount/
   * redSteps/forcedFinish 跨轮累加，跑满 maxSteps 后会话彻底卡死、新消息无响应。
   * maxSteps 语义因此是「每轮上限」而非「整会话上限」。budget 是会话级累计，不重置。
   */
  resetTurnCounters(): void {
    this.stepCount = 0;
    this.nudgeCount = 0;
    this.redSteps = 0;
    this.forcedFinish = false;
  }

  /**
   * 带超时(A1) + 有限重试(A2)的单步 LLM 调用。
   * - AbortController + stepTimeoutMs：本地后端 stall 不再永久 hang，超时抛 AbortError。
   * - maxOutputTokens：防单轮输出爆炸。
   * - 可重试错误（网络/5xx/超时/abort）指数退避重试 maxLlmRetries 次；不可重试直接抛。
   */
  private async callLLM(): Promise<Awaited<ReturnType<typeof generateText>>> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.opts.maxLlmRetries; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.opts.stepTimeoutMs);
      try {
        return await generateText({
          model: this.opts.model,
          system: this.systemPrompt,
          messages: this.messages,
          tools: this.opts.tools.asAiSdkTools(),
          abortSignal: ac.signal,
          maxOutputTokens: this.opts.maxOutputTokens,
          // 单步：v6 默认就是单步，需要循环就靠外层 while
        });
      } catch (e) {
        lastErr = e;
        if (attempt < this.opts.maxLlmRetries && isRetryableError(e)) {
          const backoff = 1000 * 2 ** attempt; // 1s, 2s, 4s...
          this.emit(
            'warn',
            `LLM 调用失败(${e instanceof Error ? e.message.slice(0, 80) : e})，${backoff}ms 后重试 ${attempt + 1}/${this.opts.maxLlmRetries}`,
          );
          await delay(backoff);
          continue;
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  /** 跑主循环，直到 LLM 不再要 tool 或撞到 maxSteps */
  async run(): Promise<void> {
    while (this.stepCount < this.opts.maxSteps) {
      this.stepCount++;
      try {
        const result = await this.callLLM();

        // 1) 累加 budget（A5：后端不报 usage 时用估算兜底，否则硬止损静默失效）
        let tokens = result.usage?.totalTokens ?? 0;
        if (tokens <= 0) {
          // lemonade/本地 OpenAI 兼容端点常不回 usage → 估算本轮 in+out 兜底
          const inText = this.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
          tokens = Budget.estimate(inText) + Budget.estimate(result.text ?? '');
          this.emit('warn', `后端未返回 token usage，用估算兜底 +${tokens}（防预算失控）`);
        }
        if (tokens > 0) this.opts.budget.add(tokens);

        // 2) emit 文本（如果有）
        if (result.text) {
          this.messages.push({ role: 'assistant', content: result.text });
          this.emit('assistant', result.text);
        }

        // 2.5) budget 硬止损（补 D4）：nudge 只在 agent 自愿停手时介入，但有的 agent 会在 red 线
        //      之后继续狂调工具烧 token（见 CTF security-1：red 后仍跑到 456% 才停）。
        //      这里在预算 red 后再放行 maxRedSteps 步探索，超过就强制转收尾（一次性），避免失控。
        if (this.opts.budget.level() === 'red' && !this.forcedFinish) {
          this.redSteps++;
          if (this.redSteps > this.opts.maxRedSteps) {
            this.forcedFinish = true;
            this.emit('warn', `预算已过红线且探索 ${this.redSteps - 1} 步仍无收敛，强制收尾（budget ${this.opts.budget.used}/${this.opts.budget.max}）`);
            this.messages.push({
              role: 'user',
              content:
                'Token 预算已耗尽，停止一切工具调用。请立即用你目前已确认的证据，输出以「## 最终结论」开头、' +
                '逐条回答用户全部问题的最终答案；对尚未证实的点，明确标注为"待确认"并给出你的最佳推断。不要再调用任何工具。',
            });
            continue;
          }
        }

        // 3) 没有 tool calls：本应结束，但要防两类断链（见 CTF benchmark）：
        //    (a) 宣布下一步却没发工具调用（security-3/raw-apk-3 打印"进入阶段2"后直接 done）
        //    (b) 一路"让我换个方式…"过程叙述，最终答案从未写出（security-1/2/3、raw-apk-1）
        //    可疑判据 = 两个正交信号任一命中（finishReason 移植自 opencode prompt.ts:1464）：
        //    (1) 文本以「宣布下一步却没做」结尾（endsWithContinuationIntent）——benchmark 里唯一
        //        验证过的真实断链，不分 finishReason 都要拦（raw-apk-3 的 finishReason 就是 stop）。
        //    (2) finishReason 异常(unknown/length/error/other) 且 文本空——本地 OpenAI 兼容端点被
        //        截断/异常停的退化空停，也要 nudge。
        //    finishReason 干净(stop)且文本不是续跑意图结尾 → 信任完成（简单任务正常收尾不误伤）。
        //    budget red 时也 nudge（逼它先落答案再停）；超 nudge 次数才真放行。
        if (!result.toolCalls || result.toolCalls.length === 0) {
          const text = result.text ?? '';
          const finish = result.finishReason ?? 'unknown';
          const finishIsClean = finish === 'stop' || finish === 'end_turn';
          const suspicious = endsWithContinuationIntent(text) || (!finishIsClean && text.trim().length < 40);
          if (suspicious && this.nudgeCount < this.opts.maxNudges) {
            this.nudgeCount++;
            const red = this.opts.budget.level() === 'red';
            this.emit(
              'warn',
              `未产出实质结论就要收尾（finishReason=${finish}, nudge ${this.nudgeCount}/${this.opts.maxNudges}${red ? ', budget red 强制收尾' : ''}）`,
            );
            this.messages.push({
              role: 'user',
              content: red
                ? 'Token 预算即将耗尽，必须立即停止探索。请用你目前已掌握的证据，直接输出以「## 最终结论」开头、' +
                  '尽可能覆盖用户全部问题的答案（哪怕部分不确定也要给出你的最佳判断和已确认的事实），不要再调用任何工具，不要用"让我…"过渡语。'
                : '你还没有给出最终答案。若信息已足够，请立即输出以「## 最终结论」开头、逐条回答用户所有问题的完整答案；' +
                  '若确实还缺关键信息，请立即发起对应的 shell/grep/read_file 工具调用继续，不要用"让我…/换个方式…/进入阶段…"这类过渡语收尾。',
            });
            continue;
          }
          this.emit('done', finish);
          return;
        }

        // 4) 把 assistant 的 tool-call 消息放进历史（v6 message shape）
        // 直接复用 result.response.messages（已经是正确格式）
        for (const m of result.response?.messages ?? []) {
          if (m.role === 'assistant' && !this.alreadyAppended(m)) {
            this.messages.push(m);
          }
        }

        // 5) 逐个 tool call → 审批 → 执行
        for (const tc of result.toolCalls) {
          // ai SDK v6: tc 含 { toolCallId, toolName, input }
          // biome-ignore lint/suspicious/noExplicitAny: SDK 类型未完全公开
          const args = (tc as any).input ?? (tc as any).args;
          // biome-ignore lint/suspicious/noExplicitAny: SDK 类型未完全公开
          const id = (tc as any).toolCallId ?? '';
          // biome-ignore lint/suspicious/noExplicitAny: SDK 类型未完全公开
          const name = (tc as any).toolName ?? '';

          const approval = this.opts.tools.classify(name, args);

          if (approval === 'deny') {
            this.emit('toolDenied', id, name, 'classified_as_deny');
            this.appendToolResult(id, name, { error: 'denied: dangerous command' });
            continue;
          }

          // ask 类要走用户审批；auto 类直接放行
          if (approval === 'ask') {
            const ok = await this.opts.approve({ id, name, args, approval });
            if (!ok) {
              this.emit('toolDenied', id, name, 'user_denied');
              this.appendToolResult(id, name, { error: 'user_denied' });
              continue;
            }
          }

          this.emit('toolCall', { id, name, args, approval });
          const { result: r, error } = await this.opts.tools.run(name, args);
          if (error) {
            this.appendToolResult(id, name, { error });
            this.emit('toolResult', id, name, { error });
          } else {
            this.appendToolResult(id, name, r);
            this.emit('toolResult', id, name, r);
          }
        }
      } catch (e: unknown) {
        this.emit('error', e instanceof Error ? e : new Error(String(e)));
        throw e;
      }
    }
    this.emit('warn', `已达最大循环数 ${this.opts.maxSteps}，强制结束`);
    this.emit('done', 'max_steps');
  }

  private appendToolResult(id: string, name: string, output: unknown): void {
    // ai SDK v6 tool result message
    this.messages.push({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: id,
          toolName: name,
          // biome-ignore lint/suspicious/noExplicitAny: SDK 接受 any 形态
          output: { type: 'json', value: output as any },
        },
      ],
    });
  }

  private alreadyAppended(m: ModelMessage): boolean {
    // 简化：用引用相等；正式实现用 message id
    return this.messages.some((existing) => existing === m);
  }

  /** 暴露当前消息历史用于 UI 渲染 / 持久化 */
  getMessages(): ModelMessage[] {
    return [...this.messages];
  }

  get step(): number {
    return this.stepCount;
  }
}
