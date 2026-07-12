/**
 * 配置加载：~/.config/rev-agent/config.toml（XDG）+ 默认值。
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';

/**
 * 后端类型：
 * - `lemonade`   — AMD lemonade-sdk（默认 :8000/api/v1，OpenAI 兼容）
 * - `lm-studio`  — LM Studio（默认 :1234/v1，OpenAI 兼容）
 * - `ollama`     — Ollama（默认 :11434/v1，OpenAI 兼容）
 * - `local`      — 任意 OpenAI 兼容本地 endpoint，必须显式给 baseURL
 * - `claude`     — Anthropic 云
 * - `openai`     — OpenAI 云
 * - `volcengine` — 火山引擎方舟 Coding Plan（OpenAI 兼容，doubao/kimi/glm/deepseek/minimax 等套餐 SKU）
 */
export type Backend = 'lemonade' | 'lm-studio' | 'ollama' | 'local' | 'claude' | 'openai' | 'volcengine';

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

  // —— 混合后端：云端顾问 + 脱敏防火墙（总开关默认关；见 advisor.ts / redact.ts）——
  /** 总开关：卡住时脱敏后问云端顾问拿思路（默认 false，纯本地不出网） */
  consultCloud?: boolean;
  /** 顾问后端：claude/openai/volcengine 或任意 OpenAI 兼容（local/lemonade 也可，串行不外泄，用于自测） */
  advisorBackend?: Backend;
  /** 顾问 model id（按后端默认） */
  advisorModel?: string;
  /** 顾问 baseURL（advisorBackend=local 时必填） */
  advisorBaseURL?: string;
  /** 顾问 API key（云端后端用；缺省从 env） */
  advisorApiKey?: string;
  /** 脱敏档 0/1/2，默认 2（最严） */
  redactLevel?: number;
  /** 顾问调用次数上限（防"求助→重置→又打转→再求助"无限循环），默认 3 */
  maxConsults?: number;
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
