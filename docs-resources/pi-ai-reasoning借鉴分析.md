# 定点借鉴分析:pi-ai 的 reasoning_content 解析 → 硬化 rev-agent 最脆的 SSE hack

> 缘起:pi 调研裁决(`基于pi-agent实现是否更简单-调研裁决.md`)点出"pi-ai 原生解析 reasoning_content(注释明写 llama.cpp)极可能退役 rev-agent 最脆的 reasoningRewriteFetch hack——不 re-platform 也能定点摘过来的高价值项;一个待实测点:pi 是否覆盖 lemonade/Qwen3.6 确切的 SSE 字段形状"。本文分析并落地。

## 一、rev-agent 现状:reasoningRewriteFetch 为何"最脆"
本地 OpenAI 兼容端点(lemonade/llama.cpp)把思考链放**非标** `delta.reasoning_content`,`@ai-sdk/openai` 不认 → 静默丢弃。rev-agent 用 custom fetch 拦 SSE 流、把 `reasoning_content` 改写成内联 `<think>…</think>`,再靠 `extractReasoningMiddleware({tagName:'think'})` 拆回标准 reasoning part(`src/llm.ts`)。两个真实脆点:
1. **chunk 边界不对齐 bug(真 bug)**:原实现每次 `chunk.split('\n')`,但 `TransformStream` 的 chunk 边界**不保证**落在换行处——chunk 可能切在半个 `data: {…}` 里 → `JSON.parse` 失败 → 走 `catch` 原样透传半行 → 该 reasoning 增量被丢/坏。实践中 lemonade SSE 常按行对齐所以多数时候没暴露,但不是保证,是**间歇性 reasoning 损坏**隐患。
2. **字段单一**:只认 `reasoning_content`,不认 `reasoning` / `reasoning_text`(其它本地端点用)。
3. 两跳(fetch 改写 → 中间件再拆)+ 依赖 `@ai-sdk/openai` 不暴露 SSE 解析、只能从 fetch 层 hack。

## 二、pi-ai 的做法(已核源码)
`pi-0.80.6/packages/ai/src/api/openai-completions.ts:364-389`:**在 SSE 解析器内部**原生处理 reasoning,注释明写 `// Some endpoints return reasoning in reasoning_content (llama.cpp), or reasoning (other openai compatible endpoints)`:
- 按 `["reasoning_content", "reasoning", "reasoning_text"]` 顺序取**首个非空**(注释:避免 chutes.ai 同时返回两个字段导致重复)。
- 直接 emit 标准 `thinking_delta` 事件(无 `<think>` 标签中转、无 fetch 拦截)。
- 请求侧另有 `thinkingFormat:"qwen"`(enable_thinking)/`"qwen-chat-template"` 内置——Qwen3.6 开关免写。

## 三、⭐ 待实测点 → RESOLVED(源码级确凿)
**pi 确实覆盖 lemonade/Qwen3.6 的 `reasoning_content` SSE 形状,而且更全更稳:**
- pi 检查的**第一个字段就是** `reasoning_content`,且注释直接点名 **llama.cpp**(lemonade 的推理引擎)——等于官方标注支持这条链路。
- rev-agent 早已**实测** Qwen3.6 走 `reasoning_content`(hack 存在的唯一理由)——两边指向同一字段。
- pi 多覆盖 `reasoning`/`reasoning_text`,rev-agent 只认 1 个。
→ 结论:待实测点消解。pi 处理 rev-agent 处理的**同一字段**,方式更健壮(SSE 解析器内、无 chunk 边界问题、多字段)。

## 四、怎么借(两条路,不 re-platform)
| 方案 | 做什么 | 成本 | 取舍 |
|---|---|---|---|
| **(B) 定点硬化现有 hack**(本次已做) | 把 pi 的两条经验搬进 rev-agent 的 reasoningRewriteFetch:①跨 chunk **行缓冲**(只处理完整行、半行留到下次、flush 冲尾)修 chunk 边界 bug;②字段扩到 `reasoning_content ?? reasoning ?? reasoning_text` | 极小(改 `llm.ts` 一个函数) | 保留 `@ai-sdk/openai`;hack 仍在但不再脆。零新依赖。**已落地(commit bd1e7d7)** |
| (C) 采用 pi-ai `ai` 包做本地 provider | 本地 backend 改用 `@earendil-works/pi-ai` 的 openai-completions,**整段退役** reasoningRewriteFetch + extractReasoningMiddleware | 中(新依赖 + 本地 backend 的 LLM 抽象换层 + 回归) | 对齐 pi 裁决的"路线 C:定点借鉴";彻底消除 hack,但引入 pi-ai 依赖、需重测。**未做,列为可选未来项** |

## 五、本次落地(方案 B,commit bd1e7d7)
`src/llm.ts` reasoningRewriteFetch:
- **跨 chunk 行缓冲**:`buf += chunk`;`lastIndexOf('\n')` 切出完整行处理、剩余半行留 `buf`;`flush` 冲掉尾行。→ 修掉 chunk 边界 JSON.parse 失败丢 reasoning 的真 bug。
- **3 字段**:`d.reasoning_content ?? d.reasoning ?? d.reasoning_text`,三者都清空。
- 实测:`--once` reasoning 仍正常救回(💭×3)、输出 0 乱码 568 中文;typecheck baseline 3、test-guards 30/30、web 多轮对话流式正常。

## 六、结论
- 待实测点**已解**:pi 覆盖 lemonade/Qwen3.6 的 reasoning_content(源码 + llama.cpp 注释确凿)。
- **不 re-platform** 即拿到 pi 的健壮性经验——本次以最小成本(方案 B)修掉了 rev-agent 那段 hack 的**真 bug(chunk 边界)** + 补齐字段覆盖。
- 若未来要**彻底退役** hack,方案 C(采用 pi-ai `ai` 包做本地 provider)是干净路径,但属中等改动 + 需回归,列为可选,不急。

## 关联
- [[基于pi-agent实现是否更简单-调研裁决]](本借鉴点出处;整体裁决=继续自研+定点借鉴,本文是"定点借鉴"的一次落地)
- `src/llm.ts`(reasoningRewriteFetch,已硬化)
- pi 源码:`packages/ai/src/api/openai-completions.ts:364-389`
