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

const DEFAULT_NOTES_PATH = '/tmp/work-notes.md';

/** 笔记 schema 工厂：notesPath 的默认值可配（统一到 --notes 指定的路径，见 makeNoteTool）。 */
export function noteInputSchemaFor(defaultNotesPath: string = DEFAULT_NOTES_PATH) {
  return z.object({
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
      .default(defaultNotesPath)
      .describe(`笔记目标路径，默认 ${defaultNotesPath}`),
  });
}

export const noteInputSchema = noteInputSchemaFor();

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

/** 工厂:生成把 notesPath 默认值统一到 defaultNotesPath 的 append_note 工具(agent 省略 notesPath 时就写这里)。
 *  autoApprove=true（顺路发现缓存开启时用）→ classify 返回 'auto' 免审批，减 TUI 摩擦让模型肯顺手记发现；
 *  默认 false 保持"永远审批"原行为。 */
export function makeNoteTool(defaultNotesPath: string = DEFAULT_NOTES_PATH, autoApprove = false): Tool<NoteInput, NoteResult> {
  return {
    name: 'append_note',
    description: `把发现追加到工作笔记 ${defaultNotesPath}。首次自动 cp 模板。${autoApprove ? '' : '这是写入类工具，每次调用都会弹审批。'}`,
    inputSchema: noteInputSchemaFor(defaultNotesPath),
    classify: () => (autoApprove ? 'auto' : 'ask'), // 默认永远审批；顺路发现缓存开启则自动放行
    // 兜底:即便 args.notesPath 缺失(极端情况),也用配置的默认路径而非硬编码 /tmp。
    execute: (args) => appendNote({ ...args, notesPath: args.notesPath ?? defaultNotesPath }),
  };
}

export const noteTool: Tool<NoteInput, NoteResult> = makeNoteTool();
