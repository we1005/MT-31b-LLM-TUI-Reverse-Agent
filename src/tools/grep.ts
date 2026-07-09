/**
 * Grep / ripgrep 工具。
 * 优先用 ripgrep（rg），强制 head 截断，避免上万行命中淹没上下文。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter as pathDelimiter, join as pathJoin } from 'node:path';
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
  // 解析出「真实可用」的 rg 绝对路径（跳过 shell function 假路径），拿不到再退回 BSD/GNU grep。
  // 移植自 cc-haha(泄露的 Claude Code)的 findUsableSystemRipgrep：spawn 无法解析 shell function，
  // 之前 `which rg` 命中的是 Claude Code 注入的 rg() function → spawn('rg') 找不到 → 静默退回
  // BSD grep BRE → `|` 交替失效。见 CTF benchmark D5。这里改为遍历 PATH 候选 + --version 验证。
  const rgPath = resolveRipgrepPath();
  const cmd = rgPath ?? 'grep';
  const grepArgs = buildArgs(args, rgPath !== null);

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

// rg 路径解析结果缓存（每进程只探测一次）。null = 探测过但没有可用 rg。
let cachedRgPath: string | null | undefined;

/**
 * 找出真实可用的 ripgrep 绝对路径，跳过 shell function / 别名等 spawn 无法执行的伪路径。
 * 移植自 cc-haha 的 findUsableSystemRipgrep：遍历 PATH 里的 `rg` 候选，逐个 `--version`，
 * 只采纳输出以 "ripgrep " 开头的真二进制。找不到返回 null（调用方退回 BSD/GNU grep -E）。
 * 与 cc-haha 不同：**不联网下载** rg 二进制（逆向环境要离线纯净），找不到就用 grep 兜底。
 */
function resolveRipgrepPath(): string | null {
  if (cachedRgPath !== undefined) return cachedRgPath;

  const isWin = process.platform === 'win32';
  const exts = isWin ? (process.env['PATHEXT'] || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => {
    const key = isWin ? p.toLowerCase() : p;
    if (p && !seen.has(key)) {
      seen.add(key);
      candidates.push(p);
    }
  };
  for (const dir of (process.env['PATH'] ?? '').split(pathDelimiter)) {
    if (!dir) continue;
    for (const ext of exts) add(pathJoin(dir, `rg${ext.toLowerCase()}`));
  }

  for (const cand of candidates) {
    if (!existsSync(cand)) continue;
    try {
      const r = spawnSync(cand, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      if (r.status === 0 && typeof r.stdout === 'string' && r.stdout.startsWith('ripgrep ')) {
        cachedRgPath = cand;
        return cand;
      }
    } catch {
      // skip this candidate
    }
  }
  cachedRgPath = null;
  return null;
}

export const grepTool: Tool<GrepInput, GrepResult> = {
  name: 'grep',
  description:
    '在目录/文件里搜 pattern，优先用 ripgrep。返回前 N 行命中（默认 20，硬上限 50）。比裸 grep -rln 安全，避免上万行命中淹没上下文。',
  inputSchema: grepInputSchema,
  classify: () => 'auto',
  execute: runGrep,
};
