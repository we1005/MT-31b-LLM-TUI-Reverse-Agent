/**
 * 配置加载：~/.config/rev-agent/config.toml（XDG）+ 默认值。
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';

/**
 * 后端类型：
 * - `lemonade`  — AMD lemonade-sdk（默认 :8000/api/v1，OpenAI 兼容）
 * - `lm-studio` — LM Studio（默认 :1234/v1，OpenAI 兼容）
 * - `ollama`    — Ollama（默认 :11434/v1，OpenAI 兼容）
 * - `local`     — 任意 OpenAI 兼容本地 endpoint，必须显式给 baseURL
 * - `claude`    — Anthropic 云
 * - `openai`    — OpenAI 云
 */
export type Backend = 'lemonade' | 'lm-studio' | 'ollama' | 'local' | 'claude' | 'openai';

export interface Config {
  backend: Backend;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  /** Token 预算上限，默认 80_000（128k 上下文留 50% 给思考） */
  tokenBudget: number;
  /** 工作笔记路径 */
  notesPath: string;
  /** prompt 文件路径覆盖 */
  promptPath?: string;
  /** 工作目录（agent 默认 cwd） */
  workdir?: string;
  /** 自动审批所有工具（危险，仅 --once 默认开） */
  autoApprove: boolean;
}

export const DEFAULT_CONFIG: Config = {
  backend: 'lemonade',
  // 默认走 lemonade 已加载的 Qwen3.6 35B MoE（避免 gemma-4 触发 lemonade #2014 自动加载 bug）
  model: 'Huihui-Qwen3.6-35B-A3B-abliterated-ggml',
  // backend 决定默认 baseURL，见 llm.ts 的 BACKEND_DEFAULTS
  tokenBudget: 80_000,
  notesPath: '/tmp/work-notes.md',
  autoApprove: false,
};

function configPath(): string {
  const xdg = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
  return join(xdg, 'rev-agent', 'config.toml');
}

export async function loadConfig(overridePath?: string): Promise<Config> {
  const path = overridePath ?? configPath();
  let parsed: Record<string, unknown> = {};
  try {
    const raw = await readFile(path, 'utf-8');
    parsed = parseToml(raw) as Record<string, unknown>;
  } catch (e: unknown) {
    // 文件不存在用默认配置，其他错误抛出
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
  } as Config;
}

/** 合并 CLI 参数（最高优先级） + 配置文件 + 默认值 */
export function mergeConfig(base: Config, override: Partial<Config>): Config {
  const merged: Config = { ...base };
  for (const k of Object.keys(override) as (keyof Config)[]) {
    const v = override[k];
    if (v !== undefined && v !== null) {
      // biome-ignore lint/suspicious/noExplicitAny: cross-field assignment
      (merged as any)[k] = v;
    }
  }
  return merged;
}
