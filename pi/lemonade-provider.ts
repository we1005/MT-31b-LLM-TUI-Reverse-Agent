/**
 * pi-agent 自定义 provider 扩展：接入本地 lemonade 上的 Qwen3.6-35B-A3B（OpenAI 兼容）。
 * 用法（快速测试）：pi -e ./lemonade-provider.ts --model lemonade/Huihui-Qwen3.6-35B-A3B-abliterated-ggml -p "..."
 * 或放 .pi/extensions/ / ~/.pi/agent/extensions/ 自动发现。
 *
 * 依据 docs/custom-provider.md：pi.registerProvider(name, { baseUrl, apiKey, api, models[] })。
 * lemonade：baseURL 13305/api/v1，apiKey 任意串；Qwen 思考链走 reasoning_content，
 *   pi-ai 的 openai-completions 原生解析（注释点名 llama.cpp）。thinkingFormat 选型见下（冒烟确认）。
 * 铁律：lemonade 单并发，驱动脚本必须串行。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("lemonade", {
    name: "Lemonade (local Qwen3.6-35B)",
    baseUrl: "http://192.168.9.101:13305/api/v1",
    apiKey: "lemonade",
    api: "openai-completions",
    models: [
      {
        id: "Huihui-Qwen3.6-35B-A3B-abliterated-ggml",
        name: "Qwen3.6-35B-A3B (lemonade)",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 8192,
        // 本地 llama.cpp(lemonade)：用 "qwen-chat-template"(chat_template_kwargs.enable_thinking
        // + preserve_thinking)——源码核实(openai-completions.ts)这是本地 Qwen 服务的正确请求侧格式；
        // "qwen"(顶层 enable_thinking) 会被 llama.cpp 静默忽略。reasoning_content 接收侧解析两者都走。
        // 注：enable_thinking 还受 call-time reasoningEffort 门控(:614)，-p 默认 medium 会透传→已开思考。
        compat: {
          thinkingFormat: "qwen-chat-template",
          maxTokensField: "max_tokens",
          supportsReasoningEffort: true,
        },
      },
    ],
  });
}
