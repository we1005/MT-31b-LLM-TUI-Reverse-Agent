/**
 * Agent 主循环（Plan-Act + tool 审批 + budget 监控）。
 *
 * 单步循环：每次只跑一轮 LLM → 拿到 tool_calls → 审批/执行 → 续轮，直到 LLM 不再要工具。
 * 不放 execute 在 tool 定义里，而是手动 dispatch，强制走 classify → approve → run 流程。
 */
import { type LanguageModel, type ModelMessage, streamText } from 'ai';
import { EventEmitter } from 'node:events';
import { Budget } from './budget.ts';
import { Ledger } from './memory/ledger.ts';
import type { Approval, ToolRegistry } from './tools/index.ts';

export interface ToolCallPending {
  id: string;
  name: string;
  args: unknown;
  approval: Approval;
}

export interface AgentEvents {
  assistant: (text: string) => void;
  /** 流式：assistant 正文增量（消灭死屏，Q1）。UI 可实时拼接上屏。 */
  assistantDelta: (delta: string) => void;
  /** 流式：思考链增量（Qwen reasoning_content 救回后的 reasoning-delta）。UI 显暗灰折叠流。 */
  reasoningDelta: (delta: string) => void;
  toolCall: (call: ToolCallPending) => void;
  toolResult: (id: string, name: string, result: unknown) => void;
  toolDenied: (id: string, name: string, reason: string) => void;
  budget: (used: number, max: number, level: 'green' | 'yellow' | 'red') => void;
  warn: (msg: string) => void;
  error: (e: Error) => void;
  done: (reason: string) => void;
}

export type ApprovalDecider = (call: ToolCallPending) => Promise<boolean>;

/** callLLM 归一化返回：字段与原 generateText 结果兼容，外层 while 无需改。 */
interface NormalizedResult {
  text: string;
  // biome-ignore lint/suspicious/noExplicitAny: SDK toolCalls 泛型异构
  toolCalls: any[];
  finishReason: string;
  // biome-ignore lint/suspicious/noExplicitAny: SDK usage 类型
  usage: any;
  // biome-ignore lint/suspicious/noExplicitAny: SDK response.messages 形态
  response: { messages?: any[] } | undefined;
}

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
  /** 单步 LLM 调用**空闲**超时（ms）——首 token 后两次 part 之间的最大间隔。默认 120_000 */
  stepTimeoutMs?: number;
  /** 首 token 超时（ms）——本地 35B prefill 大上下文+长 CoT 可能几分钟才吐首字，给更宽限。默认 300_000 */
  firstTokenTimeoutMs?: number;
  /** 单步 LLM 输出 token 上限，防单轮爆炸（A1）。默认 8_000 */
  maxOutputTokens?: number;
  /** 可重试错误（网络/5xx/超时）的重试次数，指数退避（A2）。默认 2 */
  maxLlmRetries?: number;
  /** 折叠已读 tool-result 封 prefill 二次增长（方案B）。默认 true */
  compactHistory?: boolean;
  /** 折叠时保留最近几条 tool 结果不折叠。默认 3 */
  keepRecent?: number;
  /**
   * 仅当真实上下文(contextTokens)超此值才启动折叠。默认 160_000（256k 上限下留足余量）。
   * 动机(SWA)：折叠会原地改历史中段、破坏 llama.cpp 稳定前缀→触发全量重算；日常运行 ctx 才几 k~几十 k，
   * 远够 256k 装下，此时**不折叠**保前缀最省。只有逼近上限才折一次(接受那一次重算)止血。
   */
  compactThreshold?: number;
  /** 真实上下文(contextTokens)超此值触发硬止损收尾，留足生成余量。默认 40_000（128k 的 ~1/3） */
  ctxCeiling?: number;
  /** 工具调用累计超此值仍无任何台账产出 → 注入一次"换策略"软提醒（治迷路空转）。默认 8 */
  exploreCap?: number;
  /** 追链任务台账记满此跳数 → 主动提示评估收尾拼图（治"追够了不停手"）。默认 4 */
  enoughHops?: number;
  /** 连续几步无任何新 read/grep/hop（原地打转）→ 强制收尾报告已确认证据。默认 3。不依赖 hops，堵"有进展后又卡死"。 */
  stallCap?: number;
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
  // 尾行是 markdown 标题（"## 阶段2：grep…"）或步骤宣告（"**Step 3: 精读 C19184**"）
  // = 打了个标题/步骤号就停手，属断链宣布。
  const lastLine = t.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  const bareLine = lastLine.replace(/[*_`#\s]/g, '');
  if (/^#{1,6}\s/.test(lastLine)) return true;
  if (/^(step|阶段|步骤)\s*[0-9一二三四五六]/i.test(bareLine.replace(/^\*+/, '')) || /^step[0-9]/i.test(bareLine)) return true;
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
    /继续(看|追|查|读|分析|深入|精读|定位|展开|追踪|跟进)/, // "继续看 C19184" 这类续跑宣告
    /(先|再)(来|去|跑|搜|读|试|看|确认|提取)/,
    /\blet me\b/i,
    /\bi'?ll\b/i,
    /\bnext\b.*\bi/i,
    /\b(let'?s|continue|now\s+look|keep\s+(looking|reading|digging))/i,
  ];
  return INTENT.some((re) => re.test(last));
}

export class Agent extends EventEmitter {
  private messages: ModelMessage[] = [];
  private stepCount = 0;
  private nudgeCount = 0;
  private redSteps = 0;
  private forcedFinish = false;
  private toolCallTotal = 0;
  private wrapNudged = false;
  private wrapFinished = false;
  /** 进度停滞检测：上次的 (reads+greps+hops) 进度标量 + 连续无进展步数。 */
  private lastProgress = 0;
  private stallSteps = 0;
  private readonly foldedIds = new Set<string>();
  private dedupHits = 0;
  private explorationNudges = 0;
  /** 带外结构化台账（阶段1）：系统维护，不进 messages，绕 v6 配对。收编 hopWritten/hopCount 脆弱正则。 */
  private readonly ledger = new Ledger();
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
      firstTokenTimeoutMs: 300_000,
      maxOutputTokens: 8_000,
      maxLlmRetries: 2,
      compactHistory: true,
      keepRecent: 3,
      compactThreshold: 160_000, // SWA：ctx 未逼近上限就不折叠，保稳定前缀（见 compactThreshold 注释）
      // 256k 窗口下把硬止损从 40k(旧128k的~1/3) 上调到 120k：过早收尾会白费大窗口；
      // 且现在收尾走 ledger O(1) 链路草稿 + 稳定前缀每步只重算新增，大上下文已远比 run3 时安全。
      ctxCeiling: 120_000,
      exploreCap: 8,
      enoughHops: 4,
      stallCap: 3,
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
    this.ledger.setGoal(text); // verbatim 记住首条任务
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
    this.toolCallTotal = 0;
    this.dedupHits = 0;
    this.explorationNudges = 0;
    this.wrapNudged = false;
    // 注：ledger 是会话级累积（跨轮保留已确认链路），不在每轮重置。
  }

  /**
   * 带超时(A1) + 有限重试(A2) + **流式(Q1)** 的单步 LLM 调用。
   * - streamText + fullStream：text-delta / reasoning-delta 实时 emit，消灭 Qwen 推理期死屏。
   * - AbortController + stepTimeoutMs：本地后端 stall 不再永久 hang；流开始后每收到一个 part 续期
   *   （token 在流就说明后端活着，超时只针对"卡住不吐"）。
   * - maxOutputTokens：防单轮输出爆炸。
   * - 可重试错误（网络/5xx/超时/abort）指数退避重试 maxLlmRetries 次；不可重试直接抛。
   * 返回归一化结果，字段与原 generateText 兼容，外层 while 逻辑不变。
   */
  private async callLLM(): Promise<NormalizedResult> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.opts.maxLlmRetries; attempt++) {
      const ac = new AbortController();
      // 超时分两段（本地 reasoning 小模型友好）：
      // - 首 token 前：用更宽的 firstTokenTimeoutMs——本地 35B prefill 大上下文 + 长 CoT 可能几分钟才吐首字，
      //   统一 120s 空闲超时会把"正常但慢"误判为 stall 而 abort（实测 lemonade 卡顿时 ctx=113 都被误杀）。
      // - 首 token 后：切到较紧的 stepTimeoutMs 空闲超时——已在吐了还长时间断流才是真 stall。
      let gotFirst = false;
      let timer = setTimeout(() => ac.abort(), this.opts.firstTokenTimeoutMs);
      const bump = () => {
        clearTimeout(timer);
        timer = setTimeout(() => ac.abort(), gotFirst ? this.opts.stepTimeoutMs : this.opts.firstTokenTimeoutMs);
      };
      const markFirst = () => {
        if (!gotFirst) gotFirst = true;
      };
      try {
        // SWA 稳定前缀（针对 llama.cpp 滑窗/SWA 模型）：system 保持**静态**（=systemPrompt，逐轮逐字节不变），
        // 常驻台账改为「每步临时拼到 messages 末尾」的 ephemeral 消息——**不写回 this.messages**。
        // 根因：SWA 模型下 llama.cpp 只复用「逐字节相同的最长公共前缀」的 KV；台账原本拼在 system(prompt 最头部)
        //   且每步都变 → 前缀从第一个 token 就断 → 每步 forcing full re-processing（上下文越长越卡，即"越聊越卡"）。
        // 移到末尾后：[静态 system + 只追加的真实历史] 是稳定前缀，每步只重算「本轮新增 + 台账」这一小截。
        const led = this.ledger.render();
        const callMessages: ModelMessage[] = led
          ? [...this.messages, { role: 'user', content: `【系统进度台账·非用户输入，直接用，别重新推导已确认的跳】\n${led}` }]
          : this.messages;
        const result = streamText({
          model: this.opts.model,
          system: this.systemPrompt,
          messages: callMessages,
          tools: this.opts.tools.asAiSdkTools(),
          abortSignal: ac.signal,
          maxOutputTokens: this.opts.maxOutputTokens,
        });

        let text = '';
        for await (const part of result.fullStream) {
          bump();
          switch (part.type) {
            case 'text-delta': {
              // v6 的 text-delta 用 .text 字段
              const d = (part as { text?: string }).text ?? '';
              if (d) {
                markFirst(); // 首字已到 → 超时切到较紧的空闲档
                text += d;
                this.emit('assistantDelta', d);
              }
              break;
            }
            case 'reasoning-delta': {
              const d = (part as { text?: string }).text ?? '';
              if (d) {
                markFirst();
                this.emit('reasoningDelta', d);
              }
              break;
            }
            case 'error':
              throw (part as { error?: unknown }).error ?? new Error('stream error');
            default:
              break; // tool-call/tool-result/start/finish 等由下面 await 汇总
          }
        }

        // 流跑完，汇总最终结构（await 已解析的 promise，不再有网络等待）
        return {
          text,
          toolCalls: await result.toolCalls,
          finishReason: await result.finishReason,
          usage: await result.usage,
          response: await result.response,
        };
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

  /**
   * 当前上下文真实 token 估算（Step0 诚实标尺）。
   * 注意与 budget.used 区别：budget.used 是每步历史估算的**累加**(super-linear 伪量)；
   * 这个是对**当前** messages 估算一次，反映真实 prefill 大小，是判断"上下文是否失控"的正确指标。
   */
  contextTokens(): number {
    let s = 0;
    for (const m of this.messages) {
      s += Budget.estimate(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
    }
    return s;
  }

  /**
   * 折叠已读 tool-result（方案 B，直击根因）：除最近 keepRecent 条外，把 tool 消息里
   * 原始 output.value 换成轻量 stub，保留 toolCallId/toolName（v6 要求 tool-call↔result 配对）。
   * 根因：callLLM 每步全量重发 messages，而每次 tool 原始结果永久累积 → prefill 二次增长(冲到173k)。
   * 折叠后每步输入从"所有类体累加"变成"最近K个类体+笔记+正文"的近似常量。
   * 永不折叠：append_note 结果（是台账）、assistant 正文（跳结论在这里）。需要旧内容时模型自己重读。
   */
  private compactHistory(): void {
    if (!this.opts.compactHistory) return;
    // SWA 稳定前缀：ctx 未逼近上限就**不折叠**——折叠会原地改历史中段=破坏 llama.cpp 前缀=全量重算。
    // 日常运行 ctx 才几 k~几十 k，256k 装得下，保前缀最省；只有真快撑满才折一次止血（接受那一次重算）。
    if (this.contextTokens() < this.opts.compactThreshold) return;
    // 收集所有 tool 消息的下标
    const toolIdx: number[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      if (this.messages[i]!.role === 'tool') toolIdx.push(i);
    }
    // 保留最近 keepRecent 条 tool 结果不折叠
    const foldBefore = toolIdx.length - this.opts.keepRecent;
    for (let k = 0; k < foldBefore; k++) {
      const i = toolIdx[k]!;
      // biome-ignore lint/suspicious/noExplicitAny: v6 tool message content 形态
      const content = (this.messages[i] as any).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part?.type !== 'tool-result') continue;
        const id = part.toolCallId;
        if (this.foldedIds.has(id)) continue;
        const name = part.toolName ?? '';
        // append_note 结果是台账，永不折叠
        if (name === 'append_note') continue;
        // 折叠成「可逆 view」而非丢弃（借鉴 OpenHands/Claude Code/Hermes：丢出上下文≠删除，留可重读指针）。
        // 逆向场景巧合：被折叠的类体本就在反编译产物磁盘上，指针=原文件路径，模型用现成 read_file 就能按需重取。
        // 这直击"追对链路却因类体被折叠而产不出图"的病根，零新工具、零 LLM。
        const v = part.output?.value ?? {};
        let reread = '需要时用 read_file/grep 按原参数重取';
        if (typeof v === 'object' && v) {
          if (name === 'read_file' && v.path) {
            const start = v.range?.start ?? 1;
            const end = v.range?.end ?? '';
            reread = `重看用: read_file(path="${v.path}", start=${start}${end ? `, lines=${Math.max(1, (end - start + 1))}` : ''})`;
          } else if (name === 'grep' && v.path) {
            reread = `重跑用: grep(pattern="${v.pattern ?? '<原pattern>'}", path="${v.path}")`;
          }
        }
        const hint = typeof v === 'object' ? { path: v.path, range: v.range, hits: Array.isArray(v.hits) ? v.hits.length : undefined } : {};
        part.output = {
          type: 'json',
          value: { folded: true, tool: name, ...hint, reread },
        };
        this.foldedIds.add(id);
      }
    }
  }

  /** 去重守卫：该工具调用是否已做过（ledger）。命中返回提示串，否则 null。 */
  // biome-ignore lint/suspicious/noExplicitAny: 工具 args 异构
  private dedupHit(name: string, args: any): string | null {
    if (!args || typeof args !== 'object') return null;
    if (name === 'read_file' && typeof args.path === 'string') {
      const start = typeof args.start === 'number' ? args.start : 1;
      const end = start + (typeof args.lines === 'number' ? args.lines : 200) - 1;
      if (this.ledger.hasRead(args.path, start, end)) {
        return `${args.path} 的 ${start}-${end} 行之前已读过（见进度台账 §已读类），不重复读；若要看别处用不同 start/lines。`;
      }
    } else if (name === 'grep' && typeof args.pattern === 'string' && typeof args.path === 'string') {
      if (this.ledger.hasGrep(args.pattern, args.path)) {
        return `grep "${args.pattern}" @ ${args.path} 之前已搜过（见进度台账 §已搜），换更精确的 pattern 或去读命中类。`;
      }
    }
    return null;
  }

  /** 跑主循环，直到 LLM 不再要 tool 或撞到 maxSteps */
  async run(): Promise<void> {
    while (this.stepCount < this.opts.maxSteps) {
      this.stepCount++;
      try {
        // Step0/B：先折叠旧 tool 结果封住 prefill 二次增长，再打真实 ctx 标尺
        this.compactHistory();
        // 记忆表现遥测（用户要求：每步记录上下文记忆表现，非只成败）：
        // ctx=真实上下文 folded=已折叠tool结果数 dedup=重复读被拦次数 台账 hops/reads/greps
        const ms = this.ledger.stats();
        this.emit(
          'warn',
          `[ctx=${this.contextTokens()} step=${this.stepCount} folded=${this.foldedIds.size} dedup=${this.dedupHits} hops=${ms.hops}(✓${ms.corroborated}) reads=${ms.reads} greps=${ms.greps}]`,
        );

        // 进度停滞硬止损（不依赖 hops，堵"有进展后又卡死"）：连续 stallCap 步 (reads+greps+hops) 无增长
        //   = 原地打转（resume 实测：追到2跳后死磕幻觉类 C18330，dedup 提示也不听，reads/greps 卡死不动，
        //   但 hops=2 让 hops==0 探索 nudge 永不触发→空转到 300s 墙钟）。直接强制收尾报告已确认证据。
        const progress = ms.reads + ms.greps + ms.hops;
        if (progress > this.lastProgress) {
          this.lastProgress = progress;
          this.stallSteps = 0;
        } else if (this.stepCount > 1) {
          this.stallSteps++;
        }
        if (this.stallSteps >= this.opts.stallCap && !this.forcedFinish) {
          this.forcedFinish = true;
          this.emit('warn', `连续 ${this.stallSteps} 步无新进展(原地打转)，强制收尾报告已确认证据`);
          this.messages.push({
            role: 'user',
            content:
              `你已连续 ${this.stallSteps} 步没有任何新进展（在重复无效操作，如反复读不存在/读过的文件）。停止一切工具调用，` +
              '立即用已确认的证据输出以「## 最终结论」开头的答案；把已追出的每一跳写成 `A.方法 → B.方法 | 证据 类:行` 链路图，' +
              '未证实的环节标"待确认"给最佳推断。不要再调用任何工具。' +
              (this.ledger.hopCount() ? `\n\n已确认链路草稿：\n${this.ledger.renderChainGraph()}` : ''),
          });
          continue;
        }

        // 迷路空转干预（可复触发+升级）：hops=0 且工具调用每再积累 exploreCap 次 → 介入一次。
        // Round1/2 Via 发现：一次性提醒不够,agent 会迷路到 maxSteps;dedup 打转多次也没二次干预。
        // 第1次:换策略(反向追踪)。第≥2次:判定此题起点定位超出能力→强制收尾报告卡点,不放任烧到 maxSteps。
        if (!this.forcedFinish && this.ledger.hopCount() === 0 && this.toolCallTotal >= this.opts.exploreCap * (this.explorationNudges + 1)) {
          this.explorationNudges++;
          if (this.explorationNudges >= 2 && !this.forcedFinish) {
            // 第2次仍0台账 = 起点客观定位不出,止损:让它报告已排除的、卡在哪,不再空烧
            this.forcedFinish = true;
            this.emit('warn', `探索 ${this.toolCallTotal} 次、${this.explorationNudges} 轮干预仍0台账，判定起点难定位，强制收尾报告卡点`);
            this.messages.push({
              role: 'user',
              content:
                `你已 ${this.toolCallTotal} 次工具调用仍连不出第一跳，这条链的起点在当前混淆下很难静态定位。停止探索，` +
                '直接输出以「## 最终结论」开头的报告：说明你已确认的锚点(如 loadUrl 在哪个类)、已排除的路径、' +
                '卡在哪一环、以及建议的下一步(如需要动态 frida hook 才能确定入口)。不要再调用工具。',
            });
            continue;
          }
          this.emit('warn', `已探索 ${this.toolCallTotal} 次仍无台账，注入换策略提醒(第${this.explorationNudges}次)`);
          this.messages.push({
            role: 'user',
            content:
              `你已 ${this.toolCallTotal} 次工具调用但还没连出任何一跳——定位策略在原地打转。**立即改用反向追踪**：` +
              '(1) 先 grep 明确的终点锚点(如 `loadUrl`)定位它在哪个类哪行；(2) 再 grep 谁调用了那个方法，一层层反向回溯到入口；' +
              '(3) 每确认一跳立刻写台账 `跳N: 调用者.方法 → 锚点.方法 | 证据行`。别再从模糊的起点正向盲搜。',
          });
          continue;
        }

        // 台账足量主动收尾提示（loop Round1 Via-b5 发现：台账机制起效了(写了6跳)，但"追够了该停下拼图"
        // 这个判断小模型仍没有——会一直追到 maxSteps 不收尾）。台账≥enoughHops 且还没写最终结论 →
        // 主动提示"主干够了就拼台账收尾"（一次性，不硬砍，agent 仍可判断确需再追）。
        const hopN = this.ledger.hopCount();
        if (
          !this.wrapNudged &&
          hopN >= this.opts.enoughHops &&
          !/##\s*最终结论/.test(this.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join(''))
        ) {
          this.wrapNudged = true;
          this.emit('warn', `台账已记 ${hopN} 跳，提示评估是否可收尾拼图`);
          this.messages.push({
            role: 'user',
            content:
              `你已经记录了 ${hopN} 跳台账（见进度台账），链路主干可能已经通了。请评估：如果从入口到终点的主链已连上，` +
              '就立刻把逐行台账拼成以「## 最终结论」开头的链路图收尾，别再为支线细节继续追；' +
              '只有当主链确实还缺关键的中间跳时，才继续追那一跳。',
          });
          continue;
        }

        const result = await this.callLLM();

        // 1) 累加 budget（A5 修正2）：只累加**本轮新增输出** outputTokens，绝不加 totalTokens。
        //    根因(Via实测123k/80k但真实ctx才6.7k)：lemonade 其实**会**回 usage，而 totalTokens =
        //    inputTokens(每步含增长的历史 prefill) + outputTokens → 累加是 super-linear 伪量。
        //    budget 语义是"模型累计输出成本"，只该记 outputTokens(每步真新增)，线性诚实。
        //    上下文失控由 ctxCeiling(真实 contextTokens) 独立守。
        const usage = result.usage as { outputTokens?: number } | undefined;
        let tokens = usage?.outputTokens ?? 0;
        if (tokens <= 0) tokens = Budget.estimate(result.text ?? ''); // 后端不报时用输出文本估
        if (tokens > 0) this.opts.budget.add(tokens);

        // SWA 前缀缓存命中遥测：cached/input = llama.cpp 复用的 KV 前缀比例。
        // 高(→100%)=稳定前缀生效、每步只算新增；低(→0%)=前缀被破坏、全量重算(即"越聊越卡")。
        const uAny = result.usage as { inputTokens?: number; cachedInputTokens?: number } | undefined;
        const inTok = uAny?.inputTokens ?? 0;
        const cachedTok = uAny?.cachedInputTokens ?? 0;
        if (inTok > 0 && this.stepCount > 1) {
          this.emit('warn', `[prefix-cache 命中 ${Math.round((cachedTok / inTok) * 100)}% (cached=${cachedTok}/${inTok})]`);
        }

        // 2) emit 文本（如果有）+ 从正文提升结构化台账（收编脆弱正则计数 → ledger 唯一真相源）
        if (result.text) {
          this.messages.push({ role: 'assistant', content: result.text });
          this.emit('assistant', result.text);
          this.ledger.promoteFromProse(result.text); // 捞"跳N: A→B|证据"进 ledger.hops(去重+交叉核验)
        }

        // 2.5) 硬止损（补 D4）：nudge 只在 agent 自愿停手时介入，但有的 agent 会在超限后继续狂调工具。
        //      触发主判据改用**真实上下文** contextTokens() 超 ctxCeiling（budget.used 是累加伪量，
        //      wave2 实测 ctx 已平台化在 5k 但 budget 仍虚报 159% → 不能用它做止损）；
        //      budget.level red 保留为兜底或条件之一。超阈后再放行 maxRedSteps 步，仍不收敛就强制收尾。
        const ctxNow = this.contextTokens();
        if ((ctxNow > this.opts.ctxCeiling || this.opts.budget.level() === 'red') && !this.forcedFinish) {
          this.redSteps++;
          if (this.redSteps > this.opts.maxRedSteps) {
            this.forcedFinish = true;
            this.emit('warn', `上下文/预算过线且探索 ${this.redSteps - 1} 步仍无收敛，强制收尾（ctx=${ctxNow}/${this.opts.ctxCeiling}）`);
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
            const hn = this.ledger.hopCount();
            const enough = hn >= this.opts.enoughHops;
            // 收尾时把 ledger 已积累的链路图草稿直接给模型（O(1)，不在巨上下文重推）
            const chainDraft = enough || red ? `\n\n已确认链路草稿（直接整理成最终图）：\n${this.ledger.renderChainGraph()}` : '';
            this.messages.push({
              role: 'user',
              content:
                (red || enough
                  ? `${red ? 'Token 预算即将耗尽' : `你已记录 ${hn} 跳台账、链路主干已基本清晰`}，立即停止探索。` +
                    '直接把台账拼成以「## 最终结论」开头的链路图（A.x → B.y → C.z 形式），' +
                    '对未证实的点标"待确认"给最佳推断即可，不要再调用任何工具、不要用"让我…"过渡语。'
                  : '你还没有给出最终答案。若信息已足够，请立即输出以「## 最终结论」开头、逐条回答用户所有问题的完整答案；' +
                    '若确实还缺关键信息，请立即发起对应的 shell/grep/read_file 工具调用继续，不要用"让我…/换个方式…/进入阶段…"这类过渡语收尾。') +
                chainDraft,
            });
            continue;
          }
          // nudge 配额耗尽但仍"宣布下一步却没做/退化空停"——别裸 done 把半截思考当答案丢给用户。
          // 降级为一次性强制收尾：用已确认证据(含 ledger O(1) 链路草稿)拼「## 最终结论」。
          // (MCP链路实测:模型追对 C7671 入口+caller,却反复"让我读取AbstractC3962"不发调用,2次nudge后裸done→用户啥也没拿到)
          if (suspicious && !this.forcedFinish) {
            this.forcedFinish = true;
            this.emit('warn', `nudge 配额耗尽仍未落答案，强制收尾报告已确认证据（finishReason=${finish}）`);
            this.messages.push({
              role: 'user',
              content:
                '停止一切工具调用与"让我…"过渡语。立即用你目前已确认的证据，输出以「## 最终结论」开头、' +
                '逐条回答用户全部问题的最终答案；把已追出的每一跳写成 `A.方法 → B.方法 | 证据 类:行` 的链路图，' +
                '对尚未证实的环节标注"待确认"并给最佳推断。不要再调用任何工具。' +
                (this.ledger.hopCount() ? `\n\n已确认链路草稿：\n${this.ledger.renderChainGraph()}` : ''),
            });
            continue;
          }
          // 终极安全网：已在台账攒了链路跳、却从没写「## 最终结论」就想 clean done——
          //   极可能是"追对了但漏了收尾拼图"（SWA run 实测：追出4跳 C7671→C11960→C8897→
          //   AbstractC10122→C16122，但最后一句是陈述句、未被 suspicious 命中而直接 done，链路图没画）。
          //   用 ledger O(1) 草稿逼它补一次收尾。与 suspicious 判据正交，堵检测句式的漏网。
          const hasConclusion = /##\s*最终结论|最终(答案|结论)/.test(
            this.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join(''),
          );
          if (this.ledger.hopCount() >= 1 && !hasConclusion && !this.wrapFinished) {
            this.wrapFinished = true;
            this.emit('warn', `已累计 ${this.ledger.hopCount()} 跳台账但未写最终结论，注入一次收尾拼图`);
            this.messages.push({
              role: 'user',
              content:
                '停止一切工具调用。你已在进度台账确认了多跳链路，现在**必须**输出以「## 最终结论」开头的完整链路图：' +
                '每跳写成 `A.方法 → B.方法 | 证据 类:行`，未证实的环节标"待确认"给最佳推断。不要再用"继续追…/让我…"等过渡语。' +
                `\n\n已确认链路草稿（直接整理成最终图）：\n${this.ledger.renderChainGraph()}`,
            });
            continue;
          }
          this.emit('done', finish);
          return;
        }

        // 累计工具调用数（供迷路空转软提醒判据）
        this.toolCallTotal += result.toolCalls.length;

        // 有 tool calls = 有实质进展 → 重置 nudge 配额。
        // 修 loop 发现：nudgeCount 原是「全轮固定配额」，难任务多轮后耗尽就放行 done（sig-chain 就栽在此）。
        // 改成「连续空转计数」：只要这轮真发了工具调用(有进展)就清零，nudge 只惩罚"连续宣布却不做"。
        // 话痨但有进展的 agent 不再被配额掐死，只有真原地空转的才被止损。forcedFinish(硬止损)不重置。
        this.nudgeCount = 0;

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

          // 去重守卫（ledger）：重复 read 同范围 / 重复 grep 同 pattern+path → 不真跑，回台账提示省充气。
          const dup = this.dedupHit(name, args);
          if (dup) {
            this.dedupHits++;
            this.appendToolResult(id, name, { deduped: true, note: dup });
            this.emit('toolResult', id, name, { deduped: true, note: dup });
            continue;
          }

          const { result: r, error } = await this.opts.tools.run(name, args);
          if (error) {
            this.appendToolResult(id, name, { error });
            this.emit('toolResult', id, name, { error });
          } else {
            this.ledger.observeToolResult(name, args, r); // 系统自动抽 reads/greps 进台账(零LLM)
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
