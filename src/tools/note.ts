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
// 模板候选路径，按顺序探测（兼容迁移前/后 + 自定义部署），同 prompts.ts 做法。
// 旧代码硬编码 resolve(HERE,'..','..','..','LLM工作笔记模板.md') 指向迁移前的 MT-NP管理器/，
// 迁移后失效 → cp 静默失败 → 笔记没有 §0-§8 结构。
const TEMPLATE_CANDIDATES = [
  // 迁移后：rev-agent/docs-resources/LLM工作笔记模板.md
  resolve(HERE, '..', '..', 'docs-resources', 'LLM工作笔记模板.md'),
  // 项目根：rev-agent/LLM工作笔记模板.md
  resolve(HERE, '..', '..', 'LLM工作笔记模板.md'),
  // 迁移前：rev-agent/../LLM工作笔记模板.md
  resolve(HERE, '..', '..', '..', 'LLM工作笔记模板.md'),
];

/** 探测第一个存在的模板文件，找不到返回 null（append 时会自动建空文件） */
async function findTemplate(): Promise<string | null> {
  for (const p of TEMPLATE_CANDIDATES) {
    try {
      await stat(p);
      return p;
    } catch {
      // skip
    }
  }
  return null;
}

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
    // 不存在：先复制模板（探测真实模板路径，找不到就跳过，append 时自动建空文件）
    const template = await findTemplate();
    if (!template) return;
    try {
      await copyFile(template, path);
    } catch (e: unknown) {
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
