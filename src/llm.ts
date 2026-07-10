/**
 * LLM 后端切换 (Vercel AI SDK v6)。
 * 支持 lemonade / lm-studio / ollama / 任意 OpenAI 兼容本地 endpoint / Anthropic Claude / OpenAI 官方。
 */
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { extractReasoningMiddleware, type LanguageModel, wrapLanguageModel } from 'ai';
import type { Backend, Config } from './config.ts';

/**
 * 本地 OpenAI 兼容端点（lemonade/lm-studio/ollama）常把思考链放在**非标准**的
 * `delta.reasoning_content` 字段里，而 @ai-sdk/openai 不认它 → 整段 reasoning 被静默丢弃
 * （见 opencode #15774；rev-agent 实测 Qwen3.6 走 reasoning_content）。
 *
 * 这个 custom fetch 拦截 SSE 流，把每个 chunk 的 `delta.reasoning_content` 增量改写成
 * `delta.content` 里的内联 `<think>…</think>`，再配合 extractReasoningMiddleware({tagName:'think'})
 * 把它拆回标准的 reasoning stream part。这样 fullStream 才有 reasoning-delta / text-delta。
 */
function reasoningRewriteFetch(baseFetch: typeof fetch = fetch): typeof fetch {
  return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const res = await baseFetch(input, init);
    // 只处理流式响应；非流式(或无 body)原样返回
    let isStream = false;
    try {
      isStream = !!init?.body && JSON.parse(init.body as string)?.stream === true;
    } catch {
      isStream = false;
    }
    if (!res.body || !isStream) return res;

    let thinkOpen = false;
    let thinkClosed = false;
    const transform = new TransformStream<string, string>({
      transform(chunk, ctrl) {
        const out: string[] = [];
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ') || line.includes('[DONE]')) {
            out.push(line);
            continue;
          }
          try {
            const j = JSON.parse(line.slice(6));
            const d = j.choices?.[0]?.delta;
            if (d) {
              const rc = d.reasoning_content;
              if (rc != null && rc !== '') {
                // reasoning 增量 → 开 <think>（首次）+ 内容，删掉非标字段
                d.content = (thinkOpen ? '' : ((thinkOpen = true), '<think>')) + rc;
                delete d.reasoning_content;
              } else if (d.content != null && d.content !== '' && thinkOpen && !thinkClosed) {
                // 第一个真正的 content → 先闭合 </think>
                d.content = `</think>${d.content}`;
                thinkClosed = true;
              }
            }
            out.push(`data: ${JSON.stringify(j)}`);
          } catch {
            out.push(line);
          }
        }
        ctrl.enqueue(out.join('\n'));
      },
      flush(ctrl) {
        // 流结束时 reasoning 从未闭合（回复全是思考、content 为空）→ 补一个闭合标签，避免 <think> 悬空
        if (thinkOpen && !thinkClosed) {
          ctrl.enqueue(
            `\ndata: ${JSON.stringify({ choices: [{ delta: { content: '</think>' }, index: 0, finish_reason: null }] })}\n`,
          );
        }
      },
    });

    const stream = res.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(transform)
      .pipeThrough(new TextEncoderStream());
    return new Response(stream, { headers: res.headers, status: res.status, statusText: res.statusText });
  };
}

/** 用 reasoning 中间件包住本地模型，让 reasoning_content 变成标准 reasoning part。 */
function withReasoning(model: LanguageModel): LanguageModel {
  return wrapLanguageModel({ model, middleware: extractReasoningMiddleware({ tagName: 'think' }) });
}

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
      // 本地端点常把思考链放 reasoning_content 非标字段 → custom fetch 改写 + reasoning 中间件救回
      const provider = createOpenAI({
        baseURL,
        apiKey: opts.apiKey ?? defaults.apiKey,
        fetch: reasoningRewriteFetch(),
      });
      return withReasoning(provider.chat(model));
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
