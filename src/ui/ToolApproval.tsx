/**
 * 工具审批弹窗。
 * 展示工具名 + args 预览，等待用户按 y/n 决定。
 */
import { useKeyboard } from '@opentui/react';

export interface ToolApprovalProps {
  name: string;
  args: unknown;
  onChoice: (approved: boolean) => void;
}

export function ToolApproval({ name, args, onChoice }: ToolApprovalProps) {
  useKeyboard((evt) => {
    if (evt.name === 'y' || evt.name === 'return') {
      onChoice(true);
    } else if (evt.name === 'n' || evt.name === 'escape') {
      onChoice(false);
    }
  });

  const preview = JSON.stringify(args, null, 2).slice(0, 400);

  return (
    <box
      position="absolute"
      top={2}
      left={2}
      right={2}
      border
      borderStyle="rounded"
      borderColor="yellow"
      paddingX={1}
      flexDirection="column"
      backgroundColor="black"
      zIndex={100}
    >
      <text fg="yellow">
        <b>⚠ 工具审批：{name}</b>
      </text>
      <text fg="gray"> </text>
      <text fg="white" wrapMode="char">
        {preview}
      </text>
      <text fg="gray"> </text>
      <text fg="cyan">
        [<b fg="green">y</b>] 通过 &nbsp; [<b fg="red">n</b>] 拒绝 &nbsp;
        <em fg="gray">(Esc = 拒绝, Enter = 通过)</em>
      </text>
    </box>
  );
}
