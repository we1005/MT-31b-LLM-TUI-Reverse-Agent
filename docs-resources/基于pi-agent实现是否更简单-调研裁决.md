> 调研缘起：用户问「基于 pi-agent(@earendil-works,badlogic/Mario Zechner)实现 rev-agent 是否更简单?」pi 源码在 /Volumes/zhitai-7100/pi-0.80.6。
> 方法：4 路并行(pi架构深读+上下文/TUI vs SWA+web解析对比+逐特性迁移映射)→ 综合裁决。Workflow wz4zlb2yq。

# 基于 pi-agent 实现 rev-agent 是否更简单?

## 结论先行(诚实版)

**不更简单。** 至少对"迁移一个已经调优过的 rev-agent"这件事不成立。

pi 让 rev-agent 的**外围管道**(provider 接线、reasoning_content 救回、TUI、流式、非交互、会话续传、模型发现)大幅变简单——这批东西约占工作量的 40%,而且大多是"删代码 + 改配置"。但 rev-agent 真正的价值内核——**针对本地小模型不自律的健壮性守卫 + SWA 稳定前缀 + 零-LLM Ledger 记忆**——恰恰是最难移植的 60%,而且与 pi 的三条核心设计取向(自动 LLM 摘要式 compaction / 并行工具 / 无权限弹窗 + "信任模型自我终止、不给 max-steps 旋钮")**正面冲突**。

一句话：**pi 解决的是 rev-agent 早就解决了的问题(外围),没解决 rev-agent 真正的瓶颈(小模型行为)。** 作为**全新项目**,pi 会更简单;作为**迁移已调优的 rev-agent**,总成本(order-of 2-4 周达功能对等 + 在小模型上重跑全部行为回归)远高于现状"定点移植 2 机制只花了几天"。之前"re-platform 成本 > 收益"的判断,对核心仍然成立。

推荐路线是 **(C) 继续自研 + 从 pi 定点借鉴两样东西**,不 re-platform。

---

## 1. pi 是什么 + 核心抽象/扩展点

pi = `@earendil-works/pi-agent`,作者 Mario Zechner(badlogic),Earendil 团队 2026-04 起维护。设计哲学(作者 manifesto):**loop 只跑到模型自己说完成、不提供 max-steps 之类旋钮、不做 plan mode / todo / compaction / MCP、无权限弹窗("run in a container or build your own")**。这套极简主义是为**信任前沿模型自律**而生的。

技术栈：自研 pi-ai(工具参数用 **typebox** `Type.Object`,不是 zod)+ 自研 pi-tui(差分渲染)+ Node ≥22.19(Bun 仅用于 `build:binary`)。TS 扩展经 jiti 热加载、无需编译、`/reload` 热更——这点和 rev-agent 现在 bun 直跑 TS 的工作流一致,迁移不引入构建步骤。

三层抽象 + 扩展点：

1. **pi-agent-core** — 低层 `agentLoop` + 有状态 `Agent` + 高层 `AgentHarness`(带 session / compaction / branch tree / skills)。`AgentLoopConfig` 暴露全套钩子：`transformContext` / `convertToLlm` / `beforeToolCall` / `afterToolCall` / `shouldStopAfterTurn` / `prepareNextTurn` / `getSteeringMessages` / `getFollowUpMessages`。内置 **steering / followUp / nextTurn 三种消息队列** + terminate 早停提示 + 截断工具调用安全兜底。`CustomAgentMessages` 支持声明合并自定义消息类型——正是 Ledger 带外消息的落点。
2. **pi-ai** — 多 provider 统一层。`createProvider` 接受任意 baseUrl + 空 key + `api:"openai-completions"`;这正是本地 lemonade 需要的 chat completions(非 Responses API)实现。
3. **pi-coding-agent** — CLI + 内置工具(read/bash/edit/write/grep/find/ls)+ jsonl session + extension 系统。Extension 通过默认导出工厂拿 `ExtensionAPI`,可 `registerProvider`/`registerTool`/`registerCommand`/`registerFlag`/`on(event)`,事件覆盖 session/agent/turn/message/tool/context/provider 全生命周期。

两条集成路径：**(a)** 做成 pi extension 跑在 `pi` CLI 内(白拿最多);**(b)** 用 SDK(`createAgentSession`/`runPrintMode`/`runRpcMode`/`InteractiveMode`)把 pi 当库嵌入,做薄壳 CLI。

---

## 2. 逐特性映射表

裁定口径：**白给**=一段配置/一个 flag 即可;**易移植**=纯逻辑 1:1 抄 + 接钩子;**难移植/冲突**=控制流重写或对抗 pi 默认行为。

| rev-agent 特性 | 源码 | 裁定 | 成本 & 说明 |
|---|---|---|---|
| 本地 lemonade(chat completions) | `llm.ts` | **白给(大赢)** | `models.json` 一段 `api:"openai-completions"` + baseUrl + dummy key,取代整个 `createOpenAI().chat()` + `BACKEND_DEFAULTS` 七个 case。空 key / `!cmd` / `$VAR` 兜底也内置。 |
| reasoning_content 救回 | `llm.ts:19-79` reasoningRewriteFetch | **白给(须实测)** | pi openai-completions 原生解析 `reasoning_content`/`reasoning`/`reasoning_text`(注释明写 llama.cpp),多轮用 thinkingSignature 回填;`thinkingFormat:"qwen"` 内置。**极可能整段退役 rev-agent 最脆的那段 SSE 改写 hack**。唯一待验证见 §4。 |
| 流式 agent loop(消死屏) | `agent.ts:289-368` | **白给** | pi agentLoop 是 async-generator 原生流式 + message_update delta。rev-agent 把 generateText 改 streamText 的那次改造白拿。 |
| 强制 system prompt 注入(4阶段协议+7铁律+Token预算) | `prompts.ts` | **白给+微扩展** | 静态注入 = `SYSTEM.md`/`APPEND_SYSTEM.md` 完全替换默认提示。§1/§2/§3 按 flag 切换 + §9 自动追加 = 开局设 `agent.state.systemPrompt` 的小扩展。约半天。**纪律约束见 §3。** |
| TUI(OpenTUI 栈) | `src/ui/*` | **白给** | pi-tui 差分渲染 + 全交互(streaming/status/键位/命令)整包替掉 `@opentui/core+react` + App.tsx。 |
| --once | `run-once.ts` | **白给** | `pi -p` print 模式取代。但退出码 2/3 语义须自建 CLI 层重实现。 |
| --resume | `resume.ts` | **易移植 + pi 额外白送** | notes-based resume 是纯 preflight,原样搬;pi 另白送更强的 JSONL 会话树 fork/switch(rev-agent 现在没有)。 |
| stack-probe / corpus / preflight | 同名文件 | **易移植** | 全是循环外、框架无关的纯函数(unzip -l 指纹 / 案卷扫描 / 源码树校验),原样抄。产物从"拼首条 user 消息"改走 `before_agent_start`。 |
| Ledger 记忆(零-LLM 边派生/dedup) | `memory/ledger.ts` | **易移植(接线中等)** | 类本体纯 TS 零框架依赖,1:1 抄。接线三处钩子：`afterToolCall`→observeToolResult、`message_end`→promoteFromProse、`transformContext`→render 注入。约 1-2 天。 |
| 4 工具白名单(shell/grep/read_file/note) | `tools/*` | **易移植(两处 caveat)** | grep/read = pi 内置 bash/grep/read 免写且更健壮;note = registerTool 加一个。caveat① zod→**typebox 机械转换**;caveat② shell 的 classify(auto/ask/deny)+ 白/黑名单**须拦截替换 pi 那把 YOLO by default 的 bash**——合规红线(sed -i / apktool b / adb install → ask)一个都不能丢。 |
| **SWA 稳定前缀** | `agent.ts callLLM 307-322` | **易移植但须验证(风险)** | 见 §3 详述。可保住,但要靠纪律 + 遥测核验,不是白拿。 |
| 可逆折叠 compaction | `agent.ts compactHistory` | **易移植但与 pi 默认冲突** | 折叠逻辑纯可抄;但**必须关掉 pi 默认自动 compaction**(LLM 摘要式,花 token + 破前缀),改 hook `session_before_compact` 返回自算 CompactionResult。 |
| **健壮性守卫**(stall/forced/nudge/dedup/ask-when-stuck) | `agent.ts` ~995 行绝大部分 | **难移植/冲突(最大工作量+最大风险)** | 见 §5 详述。约 1 周 + 重跑全 CTF/收敛题库回归。 |
| 预算语义(只累加 outputTokens、ctxCeiling 打真实 contextTokens、70%/90%) | `budget.ts` | **难移植** | pi 有 per-token 成本追踪但不是这套模型,守卫数学要重写并从 pi 的 usage 对象喂入(须确认 pi-ai 暴露 inputTokens/cachedInputTokens/outputTokens)。 |
| ask-when-stuck 面板 | `agent.ts` + UI | **半白给** | pi `examples/extensions/question.ts` 是现成的带 TUI 选项列表的 question 工具(sequential),可直接复用形态。 |
| --mcp-server(把自己暴露为 MCP server) | `run-mcp-server.ts` | **与 pi 正交,原样保留** | pi 声明 "No MCP",核心零 `@modelcontextprotocol` 引用。此模式本是独立 sdk stdio server 复用 4 工具实现、不经过 agent,原样留着即可;但 pi 不为其提供任何便利。 |
| 单并发铁律 | MEMORY 记载 | **冲突(铁律级)** | pi 工具 executionMode 默认可 **parallel**,须强制全部 sequential + 保证同时只有一个在途 LLM 调用,否则卡死 lemonade 后端(踩过的坑)。 |

---

## 3. 命根子：SWA 稳定前缀能否在 pi 上保住?(重点)

**能保住,而且是 pi 上难得的"结构性契合",但代价是纪律 + 验证,不是免费白拿。** 拆成能保住的理由和必须守住的纪律。

### 为什么天然契合(结构地基现成)

- **append-only 会话树**:pi session 只追加(`appendMessage`),历史消息在后续轮次字节不变——这是 token 最长公共前缀匹配的地基。
- **system prompt 每会话构建一次并缓存进 `agent.state.systemPrompt`**,只在工具/模型变更或 reload 时重建,**不每轮重算**——前缀不会因"每轮重建 system"而漂移。
- **对 lemonade/llama.cpp,pi 不发任何缓存指令**:`prompt_cache_key`/`cache_control` 断点只在 `api.openai.com` 或 `compat=anthropic` 时才打,本地 baseUrl 走不到。session 亲和 header 对 lemonade 无效但无害。=> 缓存**全靠服务端自动前缀匹配**,与 rev-agent SWA 依赖的**同一机制**。
- **`context` hook 是完美接缝**：每轮 LLM 前可改 messages,pi 对它 **deep copy 且输出只用于本次调用、不写回 session**。=> "带外 Ledger、零-LLM 边派生、拼 messages 末尾、不落历史"是**同一形状的接缝**。台账落在已缓存前缀之后,只有尾部变化,不失效前缀 KV。**rev-agent 实测 0%→97% / +37% 可原样映射。**

### 必须守住的三条纪律(否则 +37% 当场归零)

1. **绝不用 `before_agent_start` 往 system 头部注入动态内容**。协议/铁律用**静态 `customPrompt`**,动态台账只走 `context` hook 拼末尾。一旦每轮改 system 前缀,全失效。
2. **必须主动关掉 pi 默认自动 compaction**。它是 LLM 摘要式、破坏性地把摘要塞到 messages **最前**——一发生就一次性作废整段前缀 KV(这是所有 agent 通病,非 pi 独有,但要在收益核算里承认),还额外花一次串行 LLM 调用卡死单并发 lemonade。用 `session_before_compact` 覆盖成零-LLM stub 折叠。
3. **须先验证 pi 不把 `transformContext` 的输出持久化回 `agent.state.messages`**(研究读码显示是局部变量、不写回,但迁移前要实测确认),否则动态台账进历史 = 前缀立刻破、"越聊越卡"复发。

### 两处需知晓的小事

- **system 尾部污染**:pi 会在任何 customPrompt 之后追加 `Current date` 与 `cwd`(每日变化,当日内稳定)。若要求字节级前缀,须知晓这行——影响很小,一天内前缀仍稳定。
- **命中率遥测**：迁后要靠 `cachedInputTokens` 验证命中率没崩,须确认 pi-ai usage 对象暴露该字段(未证实)。

**小结**:SWA 这条命根子在 pi 上**可保住**,pi 甚至比 opencode 当年的接点更贴合。但"能保住"和"白拿"是两回事——它要求你放弃整条 wire 装配权、改用纪律 + 遥测来守。别把这条当成"pi 帮我解决了 SWA",它只是"pi 没主动破坏 SWA,且给了对的接缝"。

---

## 4. 本地 lemonade(chat completions + reasoning_content 救回)pi 支不支持?

**强支持,这是 pi 最大的白拿项。** 但有一条**必须迁移前实测**的验证点。

支持面：
- `api:"openai-completions"` 官方标注 "most compatible",就是 chat completions(**非 Responses API**),正是 lemonade 需要的。一行 `registerProvider` 或一段 models.json 记录搞定,可用 async 工厂 `fetch /v1/models` 动态发现模型。
- 原生解析 `reasoning_content`/`reasoning`/`reasoning_text`(取首个非空避免重复,注释明写 llama.cpp),多轮用 `thinkingSignature` 回填 assistant 消息(注释 "llama.cpp server + gpt-oss")。
- Qwen 思考开关内置：`thinkingFormat:"qwen"`(enable_thinking)/`"qwen-chat-template"`(chat_template_kwargs)。Qwen3.6-35B 开关免写。
- `compat`(supportsDeveloperRole/supportsReasoningEffort:false)+ `headers`($VAR/`!cmd` 插值)——rev-agent 原本没有这层。

=> **rev-agent 的 `reasoningRewriteFetch`(llm.ts 里最脆的一段 SSE 改写 hack)极可能整段作废。**

**待验证(不实测就迁 = 赌)**:pi-ai README 明说"不直接暴露 custom fetch hook"。issue #2020 讲的是**发送端** `enable_thinking`,没明说**接收端**是否解析 lemonade/Qwen3.6 **确切的** `delta.reasoning_content` SSE 形状。若 `thinkingFormat:"qwen"` 不覆盖这个字段,那在 pi 里补 SSE 改写反而比 rev-agent(ai-sdk provider 直接吃 fetch 参数)**更难**。**结论：先做一个 5 行 spike 打 lemonade 实测 reasoning 能不能出来,再谈迁移。** 这条也是路线 C 里唯一值得从 pi 白嫖的技术点。

---

## 5. 三条路线裁决

### (A) 在 pi 上重建 rev-agent(full re-platform)

- **更简单吗?** 外围更简单,整体**不更简单**。
- **省什么：** llm.ts 整个 provider 分支 + reasoningRewriteFetch + OpenTUI 栈 + streamText 改造 + budget 事件线 + 手写 resume;白送会话树 fork/switch、skills、prompt 模板、print/json/rpc 模式。
- **丢什么：** 整条 wire 装配权;要主动对抗 pi 三条默认(自动 compaction / 并行工具 / YOLO bash 无审批);MCP server 无对应;zod→typebox 全量转换;--once 退出码语义自建。
- **风险：** **最高。** 健壮性守卫的单步 inject-and-continue 控制流与 pi 的 generator turn 模型冲突——pi 在模型不发工具调用时**自然 agent_end**,而 rev-agent 要"检测断链→注入 user 引导→续跑"。须用 `shouldStopAfterTurn` + agent_end 里 push 消息 + 重驱动,等于**把外层 while 重建成扩展包装器**,且**未验证** pi 的 hook 能否"否决终止并强制再驱动一轮而非另起新 run"。阈值全是对小模型经验调出来的,须重跑全部 CTF/收敛题库回归。**成本 order-of 2-4 周达对等。**

### (B) 把 rev-agent 做成 pi extension

- **更简单吗?** 比 (A) 略省(保留 pi CLI 薄壳,不写 CLI 层),但**核心工作量与 (A) 基本相同**。
- **省什么：** 同 (A) 的外围白拿,且不用自己写 CLI 入口/交互;registerProvider/registerTool/registerFlag/registerCommand + context/tool_result/before_agent_start 钩子面齐全,ask-when-stuck 可复用 `question.ts`。
- **丢什么：** 同 (A) 一样丢 wire 装配权、要对抗默认、MCP server 无对应;还额外**绑定 pi 的 extension API**——而这套 hook/event API 仍在演进(小团队、文档偏薄、移动靶)。
- **风险：** 与 (A) 同源的核心风险(守卫控制流冲突 + 小模型行为重验)一个不少。extension 形态不降低这部分难度,只降低脚手架难度。

### (C) 继续自研 + 从 pi 定点借鉴(对齐既有"不 re-platform"决策)

- **更简单吗?** **增量上最简单,风险最低。**
- **省什么：** 什么结构都不动,已调优的守卫/SWA/Ledger 原样留着。从 pi 挖两样白嫖：**(a)** 用 pi 的 `models.json` qwen-compat 方案做小 spike,尝试**退役 reasoningRewriteFetch**(先实测 lemonade 兼容,见 §4);**(b)** 参考 pi-tui 行级差分重绘思路优化 OpenTUI 的推理期死屏。
- **丢什么：** **不丢任何结构性能力。** 放弃的只是"用一个更时髦框架"的心理满足感,以及 pi 白送的会话树 fork(rev-agent 现在只有 notes-resume——但这不是当前瓶颈)。
- **风险：** **最低。** 两个借鉴点都是可隔离的局部 spike,失败了回滚成本几乎为零。不绑定移动靶。

---

## 6. 明确推荐

**推荐路线 (C)：继续自研,不 re-platform,只从 pi 定点借鉴 reasoning_content 方案(先 spike)+ 差分渲染思路。**

理由,诚实排序：

1. **pi 的价值全在外围,而 rev-agent 的外围早已跑通。** provider/reasoning/TUI/resume/print——这些是 pi 白给,但 rev-agent 已经有了能用的版本。用 2-4 周重建外围去换"更优雅的外围",净收益为负。
2. **rev-agent 真正的皇冠明珠与 pi 的哲学正面对撞。** rev-agent 那 ~995 行守卫存在的唯一原因是**本地小模型 Qwen3.6 不自律**(宣布不做、追对不收尾、原地空转、0 工具下结论、幻觉编造)。pi 明确拒绝的正是这些"旋钮"(max-steps/plan-mode/compaction/审批弹窗)。迁到 pi = 把 rev-agent 的存在理由,搬到一个专门为"相信模型自律"而设计、且明确拒绝这些能力的框架上。这是范式错位,不是工具选型。
3. **主瓶颈是行为,不是知识/脚手架。** 之前的架构裁决已经指出瓶颈在小模型行为(11/12)不在知识/管道。pi 改善的是管道,不触及行为瓶颈。换框架不会让 Qwen3.6 变自律。
4. **绑定风险实打实。** pi 是小团队(Zechner + Earendil,2026-04 起)产物,文档偏薄、hook/event API 仍演进、且明确拒绝 rev-agent 所需的多项能力(MCP server / max-steps / plan mode / compaction)。绑定它 = 绑定一个有强烈主张、在移动、且方向与你相左的靶子。
5. **之前"定点移植 2 机制而非 re-platform"只花了几天,且证明有效。** 这条路径的经济性没有改变。pi 没提供推翻它的新理由。

**唯一值得立刻做的 pi 相关动作**：花半天做 §4 的 reasoning_content spike——若 `api:"openai-completions"` + `thinkingFormat:"qwen"` 能吃下 lemonade 的 `delta.reasoning_content`,就照抄这套配置思路**在 rev-agent 现有栈里**退役掉最脆的 reasoningRewriteFetch hack。这是从 pi 学一个"做法"、而非"搬一个框架"。

> 反过来说一句同样诚实的话：如果这是一个**从零开始**的新逆向 agent、且目标模型换成一个**自律的前沿模型**(不需要那 995 行守卫),那么 pi 会是比自研更简单的底座——它的 provider 层、reasoning 处理、context hook 对 SWA 的契合度都很好。但那不是 rev-agent 现在的处境。**用不用 pi,取决于你是否还需要打那些小模型行为补丁;只要还在打,就别搬家。**

## 关联
- [[上下文记忆系统-架构设计]](rev-agent 价值内核=SWA稳定前缀+Ledger+健壮性守卫,正是最难移植的 60%)
- [[ported_mechanisms]](既有决策：从cc-haha/opencode定点移植2机制而非re-platform——本调研对pi结论一致)
