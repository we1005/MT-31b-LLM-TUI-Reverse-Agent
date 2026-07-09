/**
 * Grep / ripgrep 工具。
 * 优先用 ripgrep（rg），强制 head 截断，避免上万行命中淹没上下文。
 */
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { Tool } from './index.ts';

export const MAX_HITS = 50;

export const grepInputSchema = z.object({
  pattern: z.string().min(1).describe('搜索模式。支持正则。例如 "extends Application" / "VipChecker"'),
  path: z.string().describe('搜索的目录或文件路径。建议先用 read_file 看 manifest 后再决定哪个目录搜'),
  glob: z.string().optional().describe('文件 glob 过滤，例如 "*.java" / "*.smali"'),
  ignoreCase: z.boolean().default(false),
  maxHits: z
    .number()
    .int()
    .min(1)
    .max(MAX_HITS)
    .default(20)
    .describe(`返回前 N 行命中，硬上限 ${MAX_HITS}（铁律 5）。命中过多就换更精确的 pattern`),
  fixedString: z
    .boolean()
    .default(false)
    .describe('true = 字面量搜索（不解析正则），适合搜含特殊字符的字符串如 "x-sign"'),
});

export type GrepInput = z.infer<typeof grepInputSchema>;

export interface GrepResult {
  ok: boolean;
  pattern: string;
  path: string;
  hits: string[];
  truncated: boolean;
  error?: string;
}

export async function runGrep(args: GrepInput): Promise<GrepResult> {
  // 优先 rg，fallback 到 grep
  const useRg = await hasCommand('rg');
  const cmd = useRg ? 'rg' : 'grep';
  const grepArgs = buildArgs(args, useRg);

  return new Promise<GrepResult>((resolve) => {
    const child = spawn(cmd, grepArgs, { timeout: 10_000 });
    let out = '';
    let err = '';
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString();
    });
    child.on('close', (code) => {
      const lines = out.split('\n').filter(Boolean);
      const max = args.maxHits ?? 20;
      const truncated = lines.length > max;
      const hits = lines.slice(0, max);
      // grep: exit 0 = found, 1 = no match, 2+ = error
      if (code === 1 || (code === 0 && hits.length === 0)) {
        resolve({ ok: true, pattern: args.pattern, path: args.path, hits: [], truncated: false });
      } else if (code !== 0 && code !== null) {
        resolve({
          ok: false,
          pattern: args.pattern,
          path: args.path,
          hits: [],
          truncated: false,
          error: err.slice(0, 1000) || `exit ${code}`,
        });
      } else {
        resolve({ ok: true, pattern: args.pattern, path: args.path, hits, truncated });
      }
    });
    child.on('error', (e) => {
      resolve({
        ok: false,
        pattern: args.pattern,
        path: args.path,
        hits: [],
        truncated: false,
        error: e.message,
      });
    });
  });
}

function buildArgs(args: GrepInput, useRg: boolean): string[] {
  const out: string[] = [];
  if (useRg) {
    out.push('-n'); // line number
    out.push('--no-heading');
    out.push('--color=never');
    if (args.ignoreCase) out.push('-i');
    if (args.fixedString) out.push('-F');
    if (args.glob) {
      out.push('-g');
      out.push(args.glob);
    }
    out.push(args.pattern, args.path);
  } else {
    // BSD/GNU grep fallback：默认走 -E（ERE），否则 BSD grep 是 BRE，pattern 里的 `|`
    // 交替会退化成字面量，导致 "MCP|mcp" 这类查询 0 命中（见 CTF benchmark D5）。
    // fixedString 时用 -F 字面量搜索，与 -E 互斥，故二选一。
    out.push(args.fixedString ? '-rnF' : '-rEn');
    if (args.ignoreCase) out.push('-i');
    if (args.glob) {
      out.push('--include');
      out.push(args.glob);
    }
    out.push('-e', args.pattern, args.path);
  }
  return out;
}

async function hasCommand(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('which', [name]);
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

export const grepTool: Tool<GrepInput, GrepResult> = {
  name: 'grep',
  description:
    '在目录/文件里搜 pattern，优先用 ripgrep。返回前 N 行命中（默认 20，硬上限 50）。比裸 grep -rln 安全，避免上万行命中淹没上下文。',
  inputSchema: grepInputSchema,
  classify: () => 'auto',
  execute: runGrep,
};
