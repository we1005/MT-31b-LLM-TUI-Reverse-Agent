/**
 * LLM 后端切换 (Vercel AI SDK v6)。
 * 支持 lemonade / lm-studio / ollama / 任意 OpenAI 兼容本地 endpoint / Anthropic Claude / OpenAI 官方。
 */
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import type { Backend, Config } from './config.ts';

export interface CreateLLMOpts {
  backend: Backend;
  model?: string;
  baseURL?: string;
  apiKey?: string;
}

/** 每个 backend 的默认 baseURL 和默认 model id */
const BACKEND_DEFAULTS: Record<Backend, { baseURL?: string; model: string; apiKey: string }> = {
  lemonade: {
    // 实际 lemonade 服务运行在 LAN 服务器上，端口 13305（不是默认 8000）
    // 注意：默认模型是 Qwen3.6（已加载），不要切 gemma-4 — 触发 lemonade 10.x #2014 bug
    //   （extra_models_dir 本地 GGUF 通过 OpenAI API 自动加载时会误判为 HF model 触发 404）
    //   切其他模型需用户在服务器侧先 `lemonade load <id>` 手动加载。
    // 通过 CLI --base-url / --model 或 ~/.config/rev-agent/config.toml 覆盖
    baseURL: 'http://192.168.9.101:13305/api/v1',
    model: 'Huihui-Qwen3.6-35B-A3B-abliterated-ggml',
    apiKey: 'lemonade',
  },
  'lm-studio': {
    baseURL: 'http://localhost:1234/v1',
    model: 'gemma-3-27b-it',
    apiKey: 'lm-studio',
  },
  ollama: {
    baseURL: 'http://localhost:11434/v1',
    model: 'gemma3:27b',
    apiKey: 'ollama',
  },
  local: {
    // local 必须显式提供 baseURL
    model: 'gemma-3-27b-it',
    apiKey: 'local',
  },
  claude: {
    model: 'claude-opus-4-7',
    apiKey: '', // 必须从 env 或 opts.apiKey
  },
  openai: {
    model: 'gpt-4o',
    apiKey: '', // 必须从 env 或 opts.apiKey
  },
  volcengine: {
    // 火山引擎方舟 Coding Plan endpoint（不是 ark.cn-beijing.volces.com/api/v3，那是按量计费！）
    // 必须用 /api/coding/v3 才走 Coding Plan 套餐额度
    baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    model: 'doubao-seed-code',
    apiKey: '', // 必须从 env (ARK_API_KEY) 或 opts.apiKey
  },
};

export function createLLM(opts: CreateLLMOpts): LanguageModel {
  const defaults = BACKEND_DEFAULTS[opts.backend];
  const model = opts.model ?? defaults.model;

  switch (opts.backend) {
    case 'lemonade':
    case 'lm-studio':
    case 'ollama':
    case 'local': {
      const baseURL = opts.baseURL ?? defaults.baseURL;
      if (!baseURL) {
        throw new Error(`backend=${opts.backend} 必须显式提供 baseURL（CLI --base-url 或 config.toml）`);
      }
      // 必须走 chat completions API（不是 v6 默认的 Responses API，本地服务一般不支持）
      const provider = createOpenAI({
        baseURL,
        apiKey: opts.apiKey ?? defaults.apiKey,
      });
      return provider.chat(model);
    }
    case 'claude': {
      const apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'];
      if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY env var or --api-key required for backend=claude');
      }
      const provider = createAnthropic({ apiKey });
      return provider(model);
    }
    case 'openai': {
      const apiKey = opts.apiKey ?? process.env['OPENAI_API_KEY'];
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY env var or --api-key required for backend=openai');
      }
      const provider = createOpenAI({ apiKey });
      return provider(model);
    }
    case 'volcengine': {
      const apiKey = opts.apiKey ?? process.env['ARK_API_KEY'];
      if (!apiKey) {
        throw new Error('ARK_API_KEY env var or --api-key required for backend=volcengine');
      }
      const baseURL = opts.baseURL ?? defaults.baseURL;
      const provider = createOpenAI({ baseURL, apiKey });
      return provider.chat(model);
    }
  }
}

/** 从配置直接造 LanguageModel */
export function createLLMFromConfig(cfg: Config): LanguageModel {
  return createLLM({
    backend: cfg.backend,
    model: cfg.model,
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
  });
}

/** 列出所有支持的 backend，用于 CLI --help */
export const SUPPORTED_BACKENDS: Backend[] = [
  'lemonade',
  'lm-studio',
  'ollama',
  'local',
  'claude',
  'openai',
  'volcengine',
];
