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
}

export class Agent extends EventEmitter {
  private messages: ModelMessage[] = [];
  private stepCount = 0;
  private readonly systemPrompt: string;
  private readonly opts: Required<AgentOpts>;

  constructor(opts: AgentOpts) {
    super();
    this.opts = {
      maxSteps: 30,
      maxRetries: 2,
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

        // 3) 没有 tool calls 就退出
        if (!result.toolCalls || result.toolCalls.length === 0) {
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
