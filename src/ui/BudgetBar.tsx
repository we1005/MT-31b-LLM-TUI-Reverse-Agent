/**
 * Token 预算横向进度条。
 * < 70% 绿 / 70-90% 黄 / > 90% 红。
 */
import { useTerminalDimensions } from '@opentui/react';

export interface BudgetBarProps {
  used: number;
  max: number;
}

export function BudgetBar({ used, max }: BudgetBarProps) {
  const { width } = useTerminalDimensions();
  const ratio = Math.min(1, used / max);
  const color = ratio >= 0.9 ? 'red' : ratio >= 0.7 ? 'yellow' : 'green';

  // 留出标签长度
  const labelLen = `${formatK(used)}/${formatK(max)} (${Math.round(ratio * 100)}%)`.length;
  const barWidth = Math.max(10, width - labelLen - 6);
  const filled = Math.round(barWidth * ratio);
  const empty = barWidth - filled;

  return (
    <box flexDirection="row" gap={1}>
      <text fg={color}>{'█'.repeat(filled)}</text>
      <text fg="gray">{'░'.repeat(empty)}</text>
      <text fg={color}>
        {formatK(used)}/{formatK(max)} ({Math.round(ratio * 100)}%)
      </text>
    </box>
  );
}

function formatK(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}
