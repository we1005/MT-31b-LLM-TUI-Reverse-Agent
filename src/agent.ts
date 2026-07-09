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
function looksLikeConclusion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // 1) 显式结论标记
  if (/##\s*最终结论|最终(答案|结论)|final\s+(answer|conclusion)/i.test(t)) return true;
  // 2) 结尾是过渡语 → 明确判为过程态（无论长短）
  const TRANSITION_TAIL = [
    /让我[^。\n]{0,20}$/,
    /(换个|换一种|另一种)方式[^。\n]{0,10}$/,
    /(接下来|下一步|现在)[^。\n]{0,20}$/,
    /进入阶段\s*[0-9一二三四][^。\n]{0,20}$/,
    /(先|再)(来|去|跑|搜|读|试|看|确认|提取)[^。\n]{0,20}$/,
    /\blet me\b[^.\n]{0,40}$/i,
    /\bi'?ll\s+(now\s+|then\s+)?(run|search|grep|read|extract|check|look|try)[^.\n]{0,40}$/i,
  ];
  if (TRANSITION_TAIL.some((re) => re.test(t))) return false;
  // 3) 足够长且不以过渡语结尾 → 视为已在组织答案（阈值 180，容纳一段紧凑的多问答复）
  return t.length > 180;
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

  /** 跑主循环，直到 LLM 不再要 tool 或撞到 maxSteps */
  async run(): Promise<void> {
    while (this.stepCount < this.opts.maxSteps) {
      this.stepCount++;
      try {
        const result = await generateText({
          model: this.opts.model,
          system: this.systemPrompt,
          messages: this.messages,
          tools: this.opts.tools.asAiSdkTools(),
          // 单步：v6 默认就是单步，需要循环就靠这个外层 while
        });

        // 1) 累加 budget
        const tokens = result.usage?.totalTokens ?? 0;
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
        //    统一判据：本轮文本不是「实质结论」→ 注入一次收尾/续跑指令。
        //    关键：即使 budget 已 red 也要 nudge —— 到点了更要逼它先落一版答案再停，
        //    只在 nudge 次数超限时才真放行（止损兜底）。
        if (!result.toolCalls || result.toolCalls.length === 0) {
          const text = result.text ?? '';
          const isConclusion = looksLikeConclusion(text);
          if (!isConclusion && this.nudgeCount < this.opts.maxNudges) {
            this.nudgeCount++;
            const red = this.opts.budget.level() === 'red';
            this.emit('warn', `未产出实质结论就要收尾（nudge ${this.nudgeCount}/${this.opts.maxNudges}${red ? ', budget red 强制收尾' : ''}）`);
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
          this.emit('done', result.finishReason ?? 'stop');
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
