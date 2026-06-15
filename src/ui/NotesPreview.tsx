/**
 * 工作笔记预览：tail /tmp/work-notes.md 最后 6 行。
 * 每 3 秒重读一次（agent 写入时不会触发 React，需要轮询）。
 */
import { useEffect, useState } from 'react';
import { readFile } from 'node:fs/promises';

export interface NotesPreviewProps {
  path: string;
  /** 拉取间隔 ms，默认 3000 */
  pollMs?: number;
  /** 显示行数，默认 6 */
  maxLines?: number;
}

export function NotesPreview({ path, pollMs = 3000, maxLines = 6 }: NotesPreviewProps) {
  const [tail, setTail] = useState<string[]>([]);
  const [exists, setExists] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const txt = await readFile(path, 'utf-8');
        if (cancelled) return;
        setExists(true);
        const lines = txt.trimEnd().split('\n');
        setTail(lines.slice(-maxLines));
      } catch {
        if (!cancelled) setExists(false);
      }
    }
    refresh();
    const t = setInterval(refresh, pollMs);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [path, pollMs, maxLines]);

  if (!exists) {
    return (
      <box paddingX={1}>
        <text fg="gray">
          <em>笔记：{path}（尚未创建）</em>
        </text>
      </box>
    );
  }

  return (
    <box flexDirection="column" border borderStyle="single" borderColor="gray" paddingX={1}>
      <text fg="gray">
        <b>📝 {path}</b> (last {tail.length}/{maxLines} lines)
      </text>
      {tail.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 滚动追加，index 稳定
        <text key={i} fg="gray" wrapMode="char">
          {line.slice(0, 200)}
        </text>
      ))}
    </box>
  );
}
