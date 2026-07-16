# 定点借鉴分析：pi-ai 的 reasoning_content 解析 → 硬化 rev-agent 最脆的 SSE hack

> 缘起：pi 调研裁决(`基于pi-agent实现是否更简单-调研裁决.md`)点出"pi-ai 原生解析 reasoning_content(注释明写 llama.cpp)极可能退役 rev-agent 最脆的 reasoningRewriteFetch hack——不 re-platform 也能定点摘过来的高价值项;一个待实测点：pi 是否覆盖 lemonade/Qwen3.6 确切的 SSE 字段形状"。本文分析并落地。

## 一、rev-agent 现状：reasoningRewriteFetch 为何"最脆"
本地 OpenAI 兼容端点(lemonade/llama.cpp)把思考链放**非标** `delta.reasoning_content`,`@ai-sdk/openai` 不认 → 静默丢弃。rev-agent 用 custom fetch 拦 SSE 流、把 `reasoning_content` 改写成内联 `<think>…</think>`,再靠 `extractReasoningMiddleware({tagName:'think'})` 拆回标准 reasoning part(`src/llm.ts`)。这套机制本身是**核心且必要**的(见 §3 实测：千问一次回答产 1424 字符 reasoning_content,不改写全丢)。潜在脆点：
1. **chunk 边界不对齐(潜在 bug,非当前触发)**：原实现每次 `chunk.split('\n')`,但 `TransformStream` 的 chunk 边界**不保证**落在换行处——chunk 可能切在半个 `data: {…}` 里 → `JSON.parse` 失败 → 走 `catch` 原样透传半行 → 该 reasoning 增量被丢/坏。**⚠️ 实测(§3)：当前 lemonade+千问+LAN 路径上 307/307 chunk 全部行对齐,此 bug 0 触发**;它只在换网络条件/代理/其他 backend/更长 reasoning 时才可能真发生,是**防御性保险**而非当下正在犯的错。
2. **字段单一**：只认 `reasoning_content`,不认 `reasoning` / `reasoning_text`。**⚠️ 对千问是 no-op**(千问只发 reasoning_content),只对其它本地端点(lm-studio/ollama/其它 llama.cpp 构建)有意义。
3. 两跳(fetch 改写 → 中间件再拆)+ 依赖 `@ai-sdk/openai` 不暴露 SSE 解析、只能从 fetch 层 hack。

## 二、pi-ai 的做法(已核源码)
`pi-0.80.6/packages/ai/src/api/openai-completions.ts:364-389`:**在 SSE 解析器内部**原生处理 reasoning,注释明写 `// Some endpoints return reasoning in reasoning_content (llama.cpp), or reasoning (other openai compatible endpoints)`:
- 按 `["reasoning_content", "reasoning", "reasoning_text"]` 顺序取**首个非空**(注释：避免 chutes.ai 同时返回两个字段导致重复)。
- 直接 emit 标准 `thinking_delta` 事件(无 `<think>` 标签中转、无 fetch 拦截)。
- 请求侧另有 `thinkingFormat:"qwen"`(enable_thinking)/`"qwen-chat-template"` 内置——Qwen3.6 开关免写。

## 三、⭐ 待实测点 → RESOLVED(源码级确凿)
**pi 确实覆盖 lemonade/Qwen3.6 的 `reasoning_content` SSE 形状,而且更全更稳：**
- pi 检查的**第一个字段就是** `reasoning_content`,且注释直接点名 **llama.cpp**(lemonade 的推理引擎)——等于官方标注支持这条链路。
- rev-agent 早已**实测** Qwen3.6 走 `reasoning_content`(hack 存在的唯一理由)——两边指向同一字段。
- pi 多覆盖 `reasoning`/`reasoning_text`,rev-agent 只认 1 个。
→ 结论：待实测点消解。pi 处理 rev-agent 处理的**同一字段**,方式更健壮(SSE 解析器内、无 chunk 边界问题、多字段)。

## 四、怎么借(两条路,不 re-platform)
| 方案 | 做什么 | 成本 | 取舍 |
|---|---|---|---|
| **(B) 定点硬化现有 hack**(本次已做) | 把 pi 的两条经验搬进 rev-agent 的 reasoningRewriteFetch：①跨 chunk **行缓冲**(只处理完整行、半行留到下次、flush 冲尾)修 chunk 边界 bug;②字段扩到 `reasoning_content ?? reasoning ?? reasoning_text` | 极小(改 `llm.ts` 一个函数) | 保留 `@ai-sdk/openai`;hack 仍在但不再脆。零新依赖。**已落地(commit bd1e7d7)** |
| (C) 采用 pi-ai `ai` 包做本地 provider | 本地 backend 改用 `@earendil-works/pi-ai` 的 openai-completions,**整段退役** reasoningRewriteFetch + extractReasoningMiddleware | 中(新依赖 + 本地 backend 的 LLM 抽象换层 + 回归) | 对齐 pi 裁决的"路线 C：定点借鉴";彻底消除 hack,但引入 pi-ai 依赖、需重测。**未做,列为可选未来项** |

## 五、本次落地(方案 B,commit bd1e7d7)
`src/llm.ts` reasoningRewriteFetch:
- **跨 chunk 行缓冲**:`buf += chunk`;`lastIndexOf('\n')` 切出完整行处理、剩余半行留 `buf`;`flush` 冲掉尾行。→ 消除 chunk 边界切半行导致 JSON.parse 失败丢 reasoning 的**潜在** bug。
- **3 字段**:`d.reasoning_content ?? d.reasoning ?? d.reasoning_text`,三者都清空。

## 五之一、⭐ 实测复核：这两个改动对千问"正确吗、有用吗"
被问到"对千问真的正确且有用吗",做了两组实测(脚本见 scratchpad `probe-sse.ts` / `probe-transform.ts`):

**(A) 正确性 —— 对抗测试(故意把 SSE 行切在 chunk 中间):**
| 实现 | 3 段 reasoning(AAA/BBB/CCC) | 结论 |
|---|---|---|
| 旧 `chunk.split('\n')` | 只拿到 `<think>AAA`,**丢 BBB/CCC** | 行被切时**真会丢 reasoning** |
| 新 跨-chunk 缓冲 | `<think>AAABBBCCC` **完整** | ✓ 修复正确;行对齐时逐字节等价旧实现、零额外延迟 → 严格占优、无回退 |

**(B) 对千问是否有用 —— 抓真实网络层 307 个 chunk:**
| 度量 | 实测值 | 含义 |
|---|---|---|
| chunk 未以 `\n` 结尾 | **0 / 307** | lemonade SSE 帧**全部行对齐** → 边界 bug 在此路径 **0 触发** → 缓冲是**防御性保险**,非当下修复 |
| 出现的 reasoning 字段 | **只有 `reasoning_content`** | 加的另 2 字段对千问是**纯 no-op**(只利其它 backend) |
| reasoning 字符 | 1424 | 核心改写机制(本轮之前就有)**确实在救命** |

**诚实定性：** 本轮两个改动 = **正确(已证)+ 严格占优(无回退)+ 但对千问当前路径是防御性、非雪中送炭**。真正对千问有价值的是**本轮之前**就存在的 reasoning 改写机制;本轮是"锦上添花的健壮性 + 跨 backend 可移植性"。早前把它称作"修掉真 bug"对千问**过头了**,应为"潜在 bug"。

## 六、结论
- 待实测点**已解**:pi 覆盖 lemonade/Qwen3.6 的 reasoning_content(源码 + llama.cpp 注释确凿)。
- **不 re-platform** 即拿到 pi 的健壮性经验——方案 B 以最小成本让 hack 更健壮 + 跨 backend 可移植;对千问是防御性保险(实测 0 触发、无回退),对其它 backend 才有当下价值。
- 若未来要**彻底退役** hack,方案 C(采用 pi-ai `ai` 包做本地 provider)是干净路径,但属中等改动 + 需回归,列为可选,不急。

## 关联
- [[基于pi-agent实现是否更简单-调研裁决]](本借鉴点出处;整体裁决=继续自研+定点借鉴,本文是"定点借鉴"的一次落地)
- `src/llm.ts`(reasoningRewriteFetch,已硬化)
- pi 源码：`packages/ai/src/api/openai-completions.ts:364-389`
