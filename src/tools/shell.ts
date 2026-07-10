/**
 * 白名单 shell 工具。
 * 三层兜底：白名单（必含）+ 黑名单（必拒）+ 超时 + 输出截断。
 * 默认所有"查询类" allow，"写入类" 标 ask；明显危险 → deny。
 */
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { Approval, Tool } from './index.ts';

// 安卓逆向场景的允许命令前缀
const ALLOW_TOOLS = new Set([
  // 反编译 / 拆包
  'jadx',
  'jadx-gui',
  'apktool',
  'baksmali',
  'smali',
  'aapt2',
  'apksigner',
  'apkid',
  'androguard',
  'quark',
  'zipalign',
  // 设备
  'adb',
  'fastboot',
  'scrcpy',
  'frida',
  'frida-ps',
  'frida-ls',
  'frida-trace',
  'frida-pull',
  'frida-push',
  'objection',
  // 抓包
  'mitmdump',
  'mitmproxy',
  'mitmweb',
  // 通用
  'ls',
  'find',
  'wc',
  'file',
  'unzip',
  'head',
  'tail',
  'sed',
  'awk',
  'cat',
  'echo',
  'sort',
  'uniq',
  'cut',
  'tr',
  'rg',
  'grep',
  'strings',
  'nm',
  'objdump',
  'readelf',
  'openssl',
  'xxd',
  'shasum',
  'sha256sum',
  'md5sum',
  'stat',
  'env',
  'pwd',
  // 反编译辅助
  'ghidraRun',
]);

const DENY_PATTERNS = [
  /\brm\s+-rf?\b/,
  /\bsudo\b/,
  /\bchmod\s+[0-7]*7/, // 写权限给所有人
  /\bchown\b/,
  /\bcurl\b/,
  /\bwget\b/,
  /\bnc\b/,
  /\bssh\b/,
  /\bscp\b/,
  /\bdd\s+if=/,
  // 写块设备/真实设备节点才拦；放行 stderr/stdout 重定向到 /dev/null|/dev/stdout|/dev/stderr|/dev/fd/*
  // （之前 `/>\s*\/dev\b/` 把无害的 `2>/dev/null` 也误杀，见 CTF benchmark D6）
  />\s*\/dev\/(?!null\b|stdout\b|stderr\b|fd\/)/,
  /\bmkfs\b/,
  /:\(\)\s*\{/, // fork bomb
  /\blaunchctl\b/,
  /\bkillall\b/,
  /\bpkill\s+-9\b/,
];

// 写入类命令前缀：需要审批
const WRITE_PATTERNS = [
  /\b(?:cp|mv|mkdir|rmdir|rm|touch|ln)\b/,
  // 原地改文件（守只读红线，见完整性审查 B1）：sed -i / perl -i / 任意 -i 原地编辑。
  // 之前 `sed -i` 未被 WRITE 覆盖 → 判 auto，agent 能不经审批盲改 smali（把 return-void 改
  // return v0），这违背"只读分析"定位。补上后归 ask，打补丁必须人点头。
  /\bsed\b[^|]*\s-i\b/,
  /\bperl\b[^|]*\s-i\b/,
  /\b(?:baksmali|smali)\s+a(?:ssemble)?\b/, // smali 汇编回 dex = 写
  // 重定向写文件才需审批；放行丢弃输出到 /dev/null|stdout|stderr（无害，LLM 高频用 2>/dev/null）
  // 与 &fd-dup（2>&1）。见 CTF benchmark D6。
  />\s*(?!\/dev\/(?:null|stdout|stderr)\b)[^&|>\s]/,
  />>/,
  /\btee\b/,
  /\bapktool\s+b\b/, // 重打包
  /\bapksigner\s+sign\b/,
  /\bzipalign\b/,
  /\badb\s+(?:install|push|shell.*\b(?:rm|mv|cp)\b)/,
];

export const shellInputSchema = z.object({
  cmd: z.string().min(1).max(800).describe(
    '要执行的 shell 命令。仅允许下列工具前缀：jadx/apktool/baksmali/smali/aapt2/apksigner/apkid/androguard/quark/adb/fastboot/scrcpy/frida/objection/mitm*/grep/rg/head/tail/sed/awk/cat/strings/nm/openssl/file/find/ls/wc/unzip/zipalign/ghidraRun 等。禁止 rm -rf / sudo / curl / wget / ssh。',
  ),
  cwd: z.string().optional().describe('工作目录，绝对路径'),
  timeoutMs: z.number().int().min(100).max(60_000).default(5_000).describe('超时（ms），默认 5s'),
});

export type ShellInput = z.infer<typeof shellInputSchema>;

export interface ShellResult {
  ok: boolean;
  exitCode?: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  error?: string;
}

const MAX_OUT = 4096;

export async function runShell(args: ShellInput): Promise<ShellResult> {
  // 取首个 token 作为工具名校验
  const firstToken = args.cmd.trimStart().split(/\s+/)[0] ?? '';
  const baseName = firstToken.split('/').pop() ?? firstToken;

  if (!ALLOW_TOOLS.has(baseName)) {
    return { ok: false, stdout: '', stderr: '', truncated: false, error: `not_whitelisted: ${baseName}` };
  }
  if (DENY_PATTERNS.some((p) => p.test(args.cmd))) {
    return { ok: false, stdout: '', stderr: '', truncated: false, error: 'denylist_hit' };
  }

  return new Promise<ShellResult>((resolve) => {
    const child = spawn('bash', ['-c', args.cmd], {
      cwd: args.cwd,
      timeout: args.timeoutMs ?? 5_000,
    });
    let out = '';
    let err = '';
    let truncated = false;

    child.stdout?.on('data', (d: Buffer) => {
      if (out.length < MAX_OUT) out += d.toString();
      else truncated = true;
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (err.length < MAX_OUT) err += d.toString();
      else truncated = true;
    });
    child.on('close', (code) => {
      resolve({
        ok: code === 0,
        exitCode: code ?? -1,
        stdout: out.slice(0, MAX_OUT),
        stderr: err.slice(0, MAX_OUT),
        truncated,
      });
    });
    child.on('error', (e) => {
      resolve({ ok: false, stdout: '', stderr: '', truncated: false, error: e.message });
    });
  });
}

/** 决定审批等级：write 类命令需 ask，纯查询自动放行 */
export function classifyShellApproval(cmd: string): Approval {
  // 黑名单 → deny（运行时 runShell 也会拒，但提前给 UI 信号）
  if (DENY_PATTERNS.some((p) => p.test(cmd))) return 'deny';
  // 写入类 → ask
  if (WRITE_PATTERNS.some((p) => p.test(cmd))) return 'ask';
  // 其余 → auto
  return 'auto';
}

export const shellTool: Tool<ShellInput, ShellResult> = {
  name: 'shell',
  description:
    '执行白名单内的 shell 命令做安卓逆向工具调用（jadx/apktool/apkid/grep/adb/frida 等）。5s 超时，stdout/stderr 各截断 4KB。',
  inputSchema: shellInputSchema,
  classify: (args) => classifyShellApproval(args.cmd),
  execute: runShell,
};
