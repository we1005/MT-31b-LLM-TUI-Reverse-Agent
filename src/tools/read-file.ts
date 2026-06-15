/**
 * 文件读取工具。
 * 强制 ≤ 200 行（铁律 2 编进 Zod schema），自动 UTF-8 解码。
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Tool } from './index.ts';

export const MAX_LINES = 200;

export const readFileInputSchema = z.object({
  path: z.string().min(1).describe('文件绝对路径或相对工作目录的路径'),
  start: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe('起始行号（1-indexed）'),
  lines: z
    .number()
    .int()
    .min(1)
    .max(MAX_LINES)
    .default(MAX_LINES)
    .describe(`要读的行数，硬上限 ${MAX_LINES}（铁律 2）。超过用多次调用 + start 翻页`),
});

export type ReadFileInput = z.infer<typeof readFileInputSchema>;

export interface ReadFileResult {
  ok: boolean;
  path: string;
  totalLines?: number;
  range?: { start: number; end: number };
  content?: string;
  truncated?: boolean;
  error?: string;
}

export async function readFileTool(args: ReadFileInput): Promise<ReadFileResult> {
  let txt: string;
  try {
    txt = await readFile(args.path, 'utf-8');
  } catch (e: unknown) {
    return { ok: false, path: args.path, error: `read_failed: ${(e as Error).message}` };
  }

  const all = txt.split('\n');
  const total = all.length;
  const start = Math.min(args.start, total);
  const end = Math.min(start + args.lines - 1, total);

  if (start > total) {
    return { ok: false, path: args.path, totalLines: total, error: 'start_beyond_eof' };
  }

  const slice = all.slice(start - 1, end);
  const content = slice.map((line, i) => `${start + i}: ${line}`).join('\n');
  const truncated = total > end;

  return {
    ok: true,
    path: args.path,
    totalLines: total,
    range: { start, end },
    content,
    truncated,
  };
}

export const readFileToolDef: Tool<ReadFileInput, ReadFileResult> = {
  name: 'read_file',
  description: `读取文件指定行范围，自动加行号前缀。强制单次 ≤ ${MAX_LINES} 行（铁律 2）。超出用多次 + start 翻页。`,
  inputSchema: readFileInputSchema,
  classify: () => 'auto',
  execute: readFileTool,
};
