/**
 * 消息流：滚动显示 agent 输出（user / assistant / tool / system 四类色块）。
 * 简化版：scrollbox + 自动追加到底（agent 主流程顺序追加，rarely 跳跃）。
 */

export type Role =
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool-call'
  | 'tool-result'
  | 'tool-denied'
  | 'system'
  | 'error';

export interface UIMessage {
  id: string;
  role: Role;
  /** 主体内容 */
  text: string;
  /** 工具名（tool-* 类才用）*/
  toolName?: string;
}

export interface MessageListProps {
  messages: UIMessage[];
}

const ROLE_STYLE: Record<Role, { fg: string; prefix: string }> = {
  user: { fg: 'cyan', prefix: '› ' },
  assistant: { fg: 'white', prefix: '' },
  reasoning: { fg: '#6b7280', prefix: '💭 ' }, // 暗灰思考流（Q1：救回 Qwen reasoning_content）
  'tool-call': { fg: 'magenta', prefix: '→ ' },
  'tool-result': { fg: 'gray', prefix: '  ← ' },
  'tool-denied': { fg: 'red', prefix: '  ✗ ' },
  system: { fg: 'gray', prefix: '' },
  error: { fg: 'red', prefix: '✗ ' },
};

export function MessageList({ messages }: MessageListProps) {
  return (
    <scrollbox flexGrow={1} flexDirection="column">
      {messages.map((m) => {
        // 稳定性:未知 role 回退到 system 样式,绝不让一条坏消息 (ROLE_STYLE[role] undefined) 抛错炸掉整个消息流→白屏。
        const style = ROLE_STYLE[m.role] ?? ROLE_STYLE.system;
        return (
          <box key={m.id} flexDirection="row" marginBottom={0}>
            <text fg={style.fg} wrapMode="word">
              {style.prefix}
              {m.toolName ? `[${m.toolName}] ` : ''}
              {m.text}
            </text>
          </box>
        );
      })}
    </scrollbox>
  );
}
