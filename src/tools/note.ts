/**
 * 工作笔记追加工具。
 * 写入 /tmp/work-notes.md（或 config 指定）。首次写入时自动 cp 模板。
 * 这是唯一的 write 类工具，必须弹审批。
 */
import { appendFile, copyFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Tool } from './index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
// src/tools/note.ts → 上三级 = MT-NP管理器/
const TEMPLATE_PATH = resolve(HERE, '..', '..', '..', 'LLM工作笔记模板.md');

export const noteInputSchema = z.object({
  section: z
    .string()
    .min(1)
    .max(80)
    .describe('小标题，例如 "阶段 1 摘要" / "发现：sign 调到 native"'),
  content: z
    .string()
    .min(1)
    .max(2000)
    .describe('正文 markdown。控制在 2KB 内，避免笔记本身变臃肿'),
  notesPath: z
    .string()
    .default('/tmp/work-notes.md')
    .describe('笔记目标路径，默认 /tmp/work-notes.md'),
});

export type NoteInput = z.infer<typeof noteInputSchema>;

export interface NoteResult {
  ok: boolean;
  path: string;
  bytesAppended?: number;
  error?: string;
}

async function ensureFile(path: string): Promise<void> {
  try {
    await stat(path);
  } catch {
    // 不存在：先复制模板
    try {
      await copyFile(TEMPLATE_PATH, path);
    } catch (e: unknown) {
      // 模板不存在也无妨，append 时会自动创建
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw e;
      }
    }
  }
}

export async function appendNote(args: NoteInput): Promise<NoteResult> {
  const path = args.notesPath ?? '/tmp/work-notes.md';
  try {
    await ensureFile(path);
    const ts = new Date().toISOString().slice(11, 16); // HH:MM UTC
    const block = `\n\n## [${ts}] ${args.section}\n\n${args.content}\n`;
    await appendFile(path, block, 'utf-8');
    return { ok: true, path, bytesAppended: Buffer.byteLength(block, 'utf-8') };
  } catch (e: unknown) {
    return { ok: false, path, error: (e as Error).message };
  }
}

export const noteTool: Tool<NoteInput, NoteResult> = {
  name: 'append_note',
  description:
    '把发现追加到工作笔记 /tmp/work-notes.md。首次自动 cp 模板。这是写入类工具，每次调用都会弹审批。',
  inputSchema: noteInputSchema,
  classify: () => 'ask', // 永远要审批
  execute: appendNote,
};
