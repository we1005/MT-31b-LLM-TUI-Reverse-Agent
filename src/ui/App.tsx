/**
 * rev-agent OpenTUI 根组件。
 * 布局：
 * ┌────────────────────────────────────────┐
 * │ MessageList (scrollbox, 主体)         │
 * ├────────────────────────────────────────┤
 * │ NotesPreview (笔记 tail, 6 行)        │
 * ├────────────────────────────────────────┤
 * │ BudgetBar (token 进度条)              │
 * ├────────────────────────────────────────┤
 * │ › input 输入框                        │
 * └────────────────────────────────────────┘
 * 当有 pending tool approval：覆盖一个 ToolApproval 弹窗。
 */
import { useTerminalDimensions } from '@opentui/react';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { nanoid } from 'nanoid';
import type { Agent } from '../agent.ts';
import { BudgetBar } from './BudgetBar.tsx';
import { MessageList, type UIMessage } from './MessageList.tsx';
import { NotesPreview } from './NotesPreview.tsx';
import { ToolApproval } from './ToolApproval.tsx';

interface PendingApproval {
  id: string;
  name: string;
  args: unknown;
  resolve: (ok: boolean) => void;
}

interface State {
  messages: UIMessage[];
  used: number;
  max: number;
  pending: PendingApproval | null;
  busy: boolean;
  input: string;
  /** 卡住求助：非 null 时输入框进入"粘贴思路"模式，提交的文本 resolve 给 agent 续跑（/skip=放弃→回退自动收尾）。 */
  strategyResolve: ((s: string | null) => void) | null;
}

type Action =
  | { type: 'msg'; m: UIMessage }
  | { type: 'delta'; role: 'assistant' | 'reasoning'; id: string; text: string }
  | { type: 'endStream' }
  | { type: 'budget'; used: number; max: number }
  | { type: 'pending'; p: PendingApproval | null }
  | { type: 'busy'; v: boolean }
  | { type: 'input'; v: string }
  | { type: 'strategyMode'; resolve: ((s: string | null) => void) | null };

const init: State = {
  messages: [],
  used: 0,
  max: 80_000,
  pending: null,
  busy: false,
  input: '',
  strategyResolve: null,
};

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'msg':
      return { ...s, messages: [...s.messages, a.m].slice(-200) }; // 硬截 200 条，防积压
    case 'delta': {
      // 流式增量：若末条消息就是这个 id 就追加，否则新建一条（消灭死屏）
      const last = s.messages[s.messages.length - 1];
      if (last && last.id === a.id) {
        const updated = { ...last, text: last.text + a.text };
        return { ...s, messages: [...s.messages.slice(0, -1), updated] };
      }
      const role = a.role === 'reasoning' ? 'reasoning' : 'assistant';
      return { ...s, messages: [...s.messages, { id: a.id, role, text: a.text }].slice(-200) };
    }
    case 'endStream':
      return s; // 流结束的收尾钩子（目前仅占位，delta 已即时上屏）
    case 'budget':
      return { ...s, used: a.used, max: a.max };
    case 'pending':
      return { ...s, pending: a.p };
    case 'busy':
      return { ...s, busy: a.v };
    case 'input':
      return { ...s, input: a.v };
    case 'strategyMode':
      return { ...s, strategyResolve: a.resolve };
  }
}

export interface ApprovalRequest {
  id: string;
  name: string;
  args: unknown;
  resolve: (ok: boolean) => void;
}

/** approval 通道：run-interactive 把 agent.approve 桥接到这里 */
export interface ApprovalChannel {
  /** UI 订阅：approval 请求来时通知 callback */
  subscribe: (cb: (r: ApprovalRequest) => void) => () => void;
}

/** 卡住求助请求：agent 卡住时带困境报告发来，UI 展示报告 + 收用户思路后 resolve（null=放弃）。 */
export interface StrategyRequest {
  report: string;
  resolve: (strategy: string | null) => void;
}
/** 求助通道：agent.askStrategy 用 ask(report) 触发，App 用 subscribe 接收。 */
export interface StrategyChannel {
  subscribe: (cb: (r: StrategyRequest) => void) => () => void;
}

export interface AppProps {
  agent: Agent;
  notesPath: string;
  onSubmit: (text: string) => Promise<void>;
  approvalChannel: ApprovalChannel;
  strategyChannel?: StrategyChannel;
}

export function App({ agent, notesPath, onSubmit, approvalChannel, strategyChannel }: AppProps) {
  const [state, dispatch] = useReducer(reducer, init);
  const { width, height } = useTerminalDimensions();
  const inputRef = useRef<{ value: string } | null>(null);

  // 订阅 approval 请求
  useEffect(() => {
    const unsub = approvalChannel.subscribe((r) => {
      dispatch({ type: 'pending', p: r });
    });
    return unsub;
  }, [approvalChannel]);

  // 订阅卡住求助请求：把困境报告作为一条 system 消息推进消息流(供用户阅读/复制)，并把输入框切到"粘贴思路"模式。
  useEffect(() => {
    if (!strategyChannel) return;
    const unsub = strategyChannel.subscribe((r) => {
      dispatch({ type: 'msg', m: { id: nanoid(), role: 'system', text: `🆘 卡住求助 — 请把下面的困境报告复制给更强的模型，取得思路后粘贴回输入框（/skip 放弃、回退自动收尾）：\n\n${r.report}` } });
      dispatch({ type: 'strategyMode', resolve: r.resolve });
      dispatch({ type: 'busy', v: false }); // 暂停忙碌态，等用户粘贴思路
    });
    return unsub;
  }, [strategyChannel]);

  // 流式增量的当前消息 id（每段 assistant/reasoning 连续增量拼进同一条）
  const streamIds = useRef<{ assistant: string | null; reasoning: string | null }>({
    assistant: null,
    reasoning: null,
  });

  // 绑定 agent 事件
  useEffect(() => {
    const onAssistantDelta = (delta: string) => {
      // reasoning 段结束→正文开始：重置 reasoning 流，开新 assistant 流
      streamIds.current.reasoning = null;
      if (!streamIds.current.assistant) streamIds.current.assistant = `a-${nanoid()}`;
      dispatch({ type: 'delta', role: 'assistant', id: streamIds.current.assistant, text: delta });
    };
    const onReasoningDelta = (delta: string) => {
      if (!streamIds.current.reasoning) streamIds.current.reasoning = `r-${nanoid()}`;
      dispatch({ type: 'delta', role: 'reasoning', id: streamIds.current.reasoning, text: delta });
    };
    const onAssistant = (_text: string) => {
      // 一轮结束：正文已由 assistantDelta 流式呈现，这里只重置流 id 供下一轮
      streamIds.current.assistant = null;
      streamIds.current.reasoning = null;
      dispatch({ type: 'endStream' });
    };
    const onToolCall = (call: { id: string; name: string; args: unknown }) => {
      const argStr = JSON.stringify(call.args).slice(0, 120);
      dispatch({
        type: 'msg',
        m: { id: call.id, role: 'tool-call', text: argStr, toolName: call.name },
      });
    };
    const onToolResult = (id: string, name: string, result: unknown) => {
      const text = (typeof result === 'string' ? result : JSON.stringify(result)).slice(0, 200);
      dispatch({ type: 'msg', m: { id: `${id}-r`, role: 'tool-result', text, toolName: name } });
    };
    const onToolDenied = (id: string, name: string, reason: string) => {
      dispatch({
        type: 'msg',
        m: { id: `${id}-d`, role: 'tool-denied', text: reason, toolName: name },
      });
    };
    const onBudget = (used: number, max: number) => {
      dispatch({ type: 'budget', used, max });
    };
    const onWarn = (msg: string) => {
      dispatch({ type: 'msg', m: { id: nanoid(), role: 'system', text: `⚠ ${msg}` } });
    };
    const onError = (e: Error) => {
      dispatch({ type: 'msg', m: { id: nanoid(), role: 'error', text: e.message } });
      dispatch({ type: 'busy', v: false });
    };
    const onDone = (_reason: string) => {
      dispatch({ type: 'busy', v: false });
    };

    agent.on('assistantDelta', onAssistantDelta);
    agent.on('reasoningDelta', onReasoningDelta);
    agent.on('assistant', onAssistant);
    agent.on('toolCall', onToolCall);
    agent.on('toolResult', onToolResult);
    agent.on('toolDenied', onToolDenied);
    agent.on('budget', onBudget);
    agent.on('warn', onWarn);
    agent.on('error', onError);
    agent.on('done', onDone);
    return () => {
      agent.off('assistantDelta', onAssistantDelta);
      agent.off('reasoningDelta', onReasoningDelta);
      agent.off('assistant', onAssistant);
      agent.off('toolCall', onToolCall);
      agent.off('toolResult', onToolResult);
      agent.off('toolDenied', onToolDenied);
      agent.off('budget', onBudget);
      agent.off('warn', onWarn);
      agent.off('error', onError);
      agent.off('done', onDone);
    };
  }, [agent]);

  const handleSubmit = useCallback(
    async (text: string) => {
      // 空/空白提交:忽略(不下发 onSubmit)但**仍清空输入框**——否则残留空白会前缀污染下一条输入(实测 quirk)。
      if (!text.trim()) {
        dispatch({ type: 'input', v: '' });
        return;
      }
      dispatch({ type: 'msg', m: { id: nanoid(), role: 'user', text } });
      dispatch({ type: 'input', v: '' });
      dispatch({ type: 'busy', v: true });
      try {
        await onSubmit(text);
      } catch (e: unknown) {
        dispatch({
          type: 'msg',
          m: { id: nanoid(), role: 'error', text: (e as Error).message },
        });
      } finally {
        dispatch({ type: 'busy', v: false });
      }
    },
    [onSubmit],
  );

  return (
    // height={height} 关键:必须显式约束到终端高度,否则 scrollbox(flexGrow) 会吃满屏、把 notes/budget/输入框挤出可视区→白屏(根 box 非 flex 容器,flexGrow 约束不住)。
    <box flexDirection="column" width={width} height={height}>
      {/* 消息流 */}
      <MessageList messages={state.messages} />

      {/* 笔记预览 */}
      <NotesPreview path={notesPath} />

      {/* 进度条 */}
      <BudgetBar used={state.used} max={state.max} />

      {/* 输入区 */}
      <box flexDirection="row" gap={1} paddingX={1} marginTop={0}>
        <text fg={state.busy ? 'yellow' : 'cyan'}>
          {state.busy ? '⏳' : '›'}
        </text>
        {/* biome-ignore lint/suspicious/noExplicitAny: OpenTUI 的 <input> 跟 React.JSX 的 HTML input 类型合并冲突，cast 绕过 */}
        <input
          flexGrow={1}
          placeholder={
            state.strategyResolve
              ? '🆘 粘贴更强模型给的分析思路后回车（/skip 放弃、回退自动收尾）'
              : state.busy
                ? '处理中...（按 Ctrl-C 取消）'
                : '输入任务后回车（/quit 退出）'
          }
          value={state.input}
          onInput={((value: string) => {
            inputRef.current = { value };
            dispatch({ type: 'input', v: value });
          }) as any}
          onSubmit={((value: string) => {
            if (value === '/quit') process.exit(0);
            // 卡住求助模式：提交的文本作为"思路"resolve 给 agent 续跑；/skip 或空=放弃→回退自动收尾。
            if (state.strategyResolve) {
              const r = state.strategyResolve;
              dispatch({ type: 'strategyMode', resolve: null });
              dispatch({ type: 'input', v: '' });
              const strat = value.trim() === '/skip' ? null : value;
              if (strat && strat.trim()) {
                dispatch({ type: 'msg', m: { id: nanoid(), role: 'user', text: `[思路] ${strat}` } });
                dispatch({ type: 'busy', v: true });
              }
              r(strat);
              return;
            }
            handleSubmit(value);
          }) as any}
        />
      </box>

      {/* 工具审批弹窗（覆盖最上层）*/}
      {state.pending && (
        <ToolApproval
          name={state.pending.name}
          args={state.pending.args}
          onChoice={(ok) => {
            state.pending!.resolve(ok);
            dispatch({ type: 'pending', p: null });
          }}
        />
      )}
    </box>
  );
}

/**
 * approval 通道工厂：在 UI 外侧（run-interactive）创建，
 * agent.approve 用 ask() 触发，App 用 subscribe() 接收。
 */
export function createApprovalChannel(): ApprovalChannel & {
  ask: (name: string, args: unknown) => Promise<boolean>;
} {
  let subscriber: ((r: ApprovalRequest) => void) | null = null;
  const queue: ApprovalRequest[] = [];

  const subscribe = (cb: (r: ApprovalRequest) => void) => {
    subscriber = cb;
    while (queue.length && subscriber) {
      subscriber(queue.shift()!);
    }
    return () => {
      subscriber = null;
    };
  };

  const ask = (name: string, args: unknown): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const req: ApprovalRequest = { id: nanoid(), name, args, resolve };
      if (subscriber) subscriber(req);
      else queue.push(req);
    });

  return { subscribe, ask };
}

/**
 * 卡住求助通道工厂：agent.askStrategy 用 ask(report) 触发（等用户在 TUI 粘贴思路），App 用 subscribe 接收。
 * 返回的 Promise 在用户提交思路(string)或放弃(/skip→null)时 resolve。
 */
export function createStrategyChannel(): StrategyChannel & {
  ask: (report: string) => Promise<string | null>;
} {
  let subscriber: ((r: StrategyRequest) => void) | null = null;
  const queue: StrategyRequest[] = [];

  const subscribe = (cb: (r: StrategyRequest) => void) => {
    subscriber = cb;
    while (queue.length && subscriber) subscriber(queue.shift()!);
    return () => {
      subscriber = null;
    };
  };

  const ask = (report: string): Promise<string | null> =>
    new Promise<string | null>((resolve) => {
      const req: StrategyRequest = { report, resolve };
      if (subscriber) subscriber(req);
      else queue.push(req);
    });

  return { subscribe, ask };
}
