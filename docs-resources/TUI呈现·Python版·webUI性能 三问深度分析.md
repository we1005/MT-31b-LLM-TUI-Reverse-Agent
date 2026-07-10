# TUI 呈现 / Python 版 / web-UI 性能 —— 三问深度分析

> **日期**：2026-07-10
> **方法**：问题1（TUI 呈现什么）读真实源码 + 复核；问题2-3（Python 版 / web-UI 性能）用 4 个 agent 并行深度 web search（带 URL 出处）+ 首席综合。
> **用户三问**：(1) tool-use 动作和思考过程有没有呈现到 TUI？(2) 再写一个 Python 版本值不值？(3) 做 web-UI 会性能下降吗，像 cursor/claude/opencode 那样的差距？

---

## 0. 先立标尺：唯一的性能瓶颈是本地推理，其余都是零头

回答三问前先钉死一个量化事实——它同时决定了三问的答案。

rev-agent 每个 turn 的耗时 = **63.5 tok/s 的 Qwen3.6-35B 推理**。token 每 ~15.7ms 到一个，200 token 回复 ~3.15s，长回复几十秒到分钟级。把各种"性能担忧"摊进这个分母：

| 担忧项 | 量级 | 占单轮(~3.15s)比例 |
|---|---|---|
| **本地 LLM 推理** | 秒~分钟 | **~99%+** |
| Electron 打字回显延迟 | 31ms | ~1.0%（10s 回复则 0.3%） |
| 本地 websocket 每消息往返 | ~2ms | ~0.06% |
| 纯 TUI 渲染一帧 | 5-10ms | 舍入误差 |
| 语言运行时开销（Bun/Python 单 turn 内） | ms 级 | 比一次 turn 小 3-4 个数量级 |

**"感觉重要"vs"实际瓶颈"的分野**：人本能会纠结语言/UI 选型，但那恰恰**不 load-bearing**。唯一 load-bearing 的是"推理那几秒里屏幕上有没有东西在动"。所以三问里 **只有 Q1 真值得动**，而且几乎零成本。

---

## Q1：tool-use 动作和思考过程，有没有呈现到 TUI？

### 结论
**我第一遍自查只说对了一半。深查源码后的真相更严重一档：不是"没有独立 reasoning 流"，而是 rev-agent 在整段推理期间根本是「死屏」。** 这是三问里唯一真正值得投入的，也是最高性价比的一处。

### 已呈现的（我自查对的部分）
读 `src/ui/App.tsx` + `MessageList.tsx` 确认，TUI 确实呈现：
- **工具调用**：`onToolCall` → 紫色 `→ [工具名] {args前120字}`（`App.tsx:109-115`、`MessageList.tsx:24`）
- **工具结果**：`onToolResult` → 灰色 `← [工具名] {result前200字}`
- **工具拒绝**：红色 `✗`；**审批弹窗**：`ToolApproval` 覆盖层；**budget 进度条**、**笔记 tail**
- **assistant 文本**：白色

### 真缺口（深查才发现）
- `src/agent.ts:7` 导入的是 **`generateText`（阻塞式）**，全程**没有 `streamText`/`fullStream`**；`grep -r reasoning src/` **零命中**——即完全没解析思考链。
- 关键在 emit 时机：**assistant 文本是整个 turn 全部生成完才一次性 emit**。含义：Qwen3.6 这种 thinking 模型在秒级~分钟级推理里，绝大多数 token 花在 CoT 上，而 `generateText` 阻塞到最后才吐字——**用户等的那几十秒里，TUI 什么都不动。**

### 调研佐证（这是业界正式立项修的痛点）
- **opencode #12028**（已实现）：thinking 被隐藏时界面无反馈、显得冻结 → 方案是加 `Thinking… + 已用时长`。
- **Smashing Magazine**（AI 透明度设计模式）：agent 停 20 秒不是在下载而是在思考，裸 spinner 让用户焦虑，要"有内容的进度"（Living Breadcrumb / 状态行）。
- **opencode #15774**（坑）：LM Studio + Qwen 走独立 `reasoning_content` 字段时，TUI 在反引号处提前截断，且给 Anthropic 的修复不适用于 OpenAI 兼容 provider。

### 建议（按性价比排序）
1. **[最高 ROI，几乎必做] `generateText` → `streamText`。** Vercel AI SDK v6（已在用）的 `fullStream` 把 `text-delta`/`reasoning-delta`/`tool-call`/`tool-result` 做成并列 stream part，`for await + switch(part.type)` 分别路由。先让 `text-delta` 实时上屏，直接消灭死屏。
2. **[零成本] 加状态行 `思考中 · {elapsed}s · {tok/s}`。** 复用已有的 63.5 tok/s 常数 + budget 条，就是 opencode #12028 的最小可行修复。
3. **[对逆向 agent 尤其值] reasoning 做成 dim/灰色、默认折叠、可展开的独立流。** v6 里多一个 `case 'reasoning-delta'`。CoT 里"为什么 grep 这个类 / 在验证哪个假设"正是最该被审计、也最该让你在死等时间里读的内容。补齐后三色（紫工具/灰结果/白文本）变四层（+ 暗灰思考），与 Claude Code（灰斜体 thinking）/ opencode 对齐。
4. **[前置必查的坑] 先确认 lemonade 回的 Qwen 思考格式**——是 (a) `content` 内联 `<think>` 标签，还是 (b) 独立 `reasoning_content` 字段（跟 lemonade_config 记的 gemma4 问题同源）。`curl` lemonade 流式端点看原始 SSE 里 reasoning 在哪个字段，确认 `@ai-sdk/openai` 是否映射进 reasoning part，否则踩 opencode #15774 的截断/空输出坑。

---

## Q2：再写一个 Python 版本值不值？

### 结论
**不值得，工程上是净亏。** 不会让 agent 变快也不会变慢（瓶颈在 LLM），却要把已跑通的东西重做一遍。除非明确要接 Python 独有的库——而这项目恰好一个都用不上。

### 依据（web 调研，带出处）
- **性能收益 ≈ 0**：语言运行时开销以 ms 计，比单次 LLM turn 小 3-4 个数量级。所有"Python 慢/快"基准测的都是用不到的维度——israeli-tech-radar 那篇 asyncio 快 22% 是 **5000 并发连接**的服务器吞吐；反方向 TS 快 20-25% 是多 provider 编排。**单用户、一次只等一条流的 rev-agent，两个数字都不 load-bearing。**
- **Bun 唯一硬优势被架构抵消**：Bun 冷启 8-15ms（实测 `bun --version` 0.02-0.14s），Python import 依赖后落 200-800ms（HN 实测 `import requests` 单独 250ms）。但 Python 官方优化文档自己的结论是"避免启动税的最佳方案是跑常驻进程"——**rev-agent 已经是 OpenTUI 常驻会话，启动税一会话只付一次**，那 0.1s 对交互几乎无感。
- **Python 唯一能打的牌你不用**：Blaxel 选型框架说 Python 赢在 ML-heavy / LangChain·DSPy / notebook / eval harness。rev-agent 不训练、不推理、不 RAG、不 eval——只是 HTTP 调本地 LLM + 跑 jadx/grep。需要的 HTTP+subprocess+JSON 两边都是标准库级；Python 的 ML 深度**一个都用不上**。GIL/free-threading 对单用户 I/O-bound 不进画面。
- **分发痛点对本项目 MOOT**：PyInstaller 不能交叉编译、GLIBC 只向前兼容、uv 至今无 bundle 命令（uv#5802 open）——都是 Python 痛点，但 memory 写明"私自使用不分发"，这条既不该成为选 Bun 的理由也不该黑 Python。

### 建议
保持 Bun/TS。重写成本 = **重新解决已解决的问题**：现有 2283 行 TS + Vercel AI SDK v6 的流式/tool-calling/结构化输出已跑通；Python 侧没有 AI SDK v6 对应物，得用 Pydantic AI/LiteLLM 自拼 streaming+tool loop，还要把 OpenTUI（审批/budget/note tail）用 Textual 全部重做——产出**同一个 I/O-bound agent**。若真想要第二实现，该问的不是"哪个更快"而是"**为什么维护两份**"。把这精力投到 Q1 的 streaming，收益天差地别。

---

## Q3：做 web-UI 会性能下降吗？是不是像 cursor/claude/opencode 的差距？

### 结论
**延迟维度上"web-UI 会变慢"基本是伪命题**——增量只占单轮 0.05%~1%，感知不到。真正代价是**内存和多进程复杂度**，不是速度。而且——

### 先纠正一个前提错误：Cursor 不是 CLI
把 Cursor 归为"纯 CLI 工具"是**类别错误**。三者是三种 UI 范式：

| 工具 | 范式 | 启动 / 内存 |
|------|------|-----------|
| **Cursor** | **Electron GUI**（VS Code fork，内置 Chromium） | 1-5s / idle 200-300MB / 每 app 捆 ~150MB Chromium |
| **Claude Code** | 单进程 CLI/TUI（React+Ink，无浏览器引擎） | 快 / 低 |
| **opencode** | client-server 拆分 TUI（Hono HTTP server + TUI 客户端） | 每按键触发 server 调用加几 ms 本地 HTTP 延迟 |

**rev-agent 属于第 2 类，和 Claude Code 同范式**——而且用的 OpenTUI(Zig 核心) 正是 **opencode 从 Go/Bubble Tea 迁移后收敛到的同一个框架**，在启动/渲染上比 Claude Code 的纯 JS Ink 更有底气（opencode 团队自承"Node/Ink 启动比 Go 慢"）。实测 0.02-0.14s 冷启动是原生 CLI 级，比 Cursor/Electron 的 1-5s 快 1-2 个数量级。

### "差距"的真相
SitePoint 基准：Cursor 小任务比 Claude Code 快 ~12%，但 Claude Code 少用 5.5x token、返工少 30%。**这个差距来自交互模式（Cursor 的 <100ms tab 补全 vs Claude Code 的 30-90s 自主 agent 回合），不是 UI 渲染快慢。** 拿它当 web-UI 决策标尺是错的。

### 延迟测算（对 63.5 tok/s）
- Electron 打字延迟 31ms / 3150ms ≈ **1.0%**（10s 回复则 0.3%）
- 本地 websocket 每消息 ~2ms / 3150ms ≈ **0.06%**
- token 间隔 15.7ms，终端渲染 5-10ms、ws 单跳 µs~2ms 都**远快于 token 到达速度**，不会掉帧/积压

**UI 层选什么，用户在这个负载下感知不到延迟差异。**

### 真正的代价：内存 + 复杂度
- **数据**（gethopp N=1 方向性）：Tauri 6 窗口 ~172MB vs Electron ~409MB；idle Tauri 30-40MB vs Electron 200-300MB；bundle Tauri 8.6MiB vs Electron 244MiB。VS Code(Electron) 带扩展典型 800MB-1.2GB。
- **本地 IPC 延迟极低**：同机 Unix domain socket 往返 ~2ms（应用层含框架），裸 socket 更低。

### 建议（按内存+复杂度决策，不按速度）
- **绝不用 Electron**：凭空多背 ~150MB+ Chromium 常驻，把一个 2283 行、单进程、冷启 0.02-0.14s 的轻量工具从原生 CLI 级拽回 Electron 级，换来的性能收益是零。
- **若确实想要 web-UI**（看反编译代码高亮、调用图可视化、大段 smali diff 这类 TUI 天生弱的富交互）：最省事是"**Bun 起本地 HTTP/WS server + 用已开的浏览器打开**"，额外常驻进程 ≈ 0；其次 Tauri（+30-40MB，用系统 WebView）。代价是把"`bun src/index.tsx` 直接跑"的单进程极简心智拆成 前端构建 + 后端 server + WS 协议 + 状态同步——**这才是真实成本**。
- **默认建议：保持单进程 OpenTUI TUI。** 对"私用不分发"的单用户本地工具是最省事且性能最优的。TUI 那 5-10ms 低延迟裕量在秒级推理面前是浪费，但单进程的极简运维是实打实收益。

---

## 一个跨问题的收敛点

Q1 里那套 `fullStream` 的 **text / reasoning / tool 三流分离抽象是与前端无关的**。无论以后走 Python 还是 web-UI，这个抽象都通用，**不构成选型分叉点**。所以正确顺序：**先在现有 Bun/OpenTUI 上做掉 Q1 的 streaming（唯一真影响体验的事），Q2/Q3 维持现状**，等真出现"必须 Python 库"或"必须富交互可视化"的硬需求时再谈——目前两者都不存在。

---

## 一句话总结

- **Q1（该做）**：`generateText` → `streamText` + "思考中·秒数·tok/s"状态行 + reasoning 独立 dim 流。前置：确认 lemonade 的 Qwen reasoning 是内联 `<think>` 还是独立 `reasoning_content`，避开 opencode #15774 截断坑。**这是三问里唯一真影响体验的。**
- **Q2（别做）**：写 Python = 净亏，零性能收益，重做已跑通的 AI SDK 流式 + OpenTUI 界面。
- **Q3（默认别做）**：web-UI 不会变慢（延迟占比 <1%），代价是内存和复杂度；要做就用"浏览器+本地 server"或 Tauri、绝不用 Electron。且 Cursor 是 Electron GUI 不是 CLI，别拿它当标尺。

**性能瓶颈 100% 在 63.5 tok/s 的本地推理——别在零头上做架构决策。**

---

## 附：来源（web 调研）

- 终端延迟：danluu.com/term-latency、beuke.org/terminal-latency
- Tauri vs Electron 内存：gethopp.app/blog/tauri-vs-electron；electronjs.org/docs performance；tech-insider.org/zed-vs-vscode-2026
- 本地 IPC 延迟：yanxurui.cc/posts（TCP/UDS/namedpipe 基准）
- Python 启动/打包：pythondev.readthedocs.io/startup_time；news.ycombinator.com/item?id=46230192；github.com/astral-sh/uv#5802、#13503
- 语言选型：blaxel.ai/blog/typescript-vs-python-ai-agents；medium.com israeli-tech-radar asyncio vs Node
- Bun：strapi.io/blog/bun-vs-nodejs
- thinking 呈现：opencode #12028 / #15774；Smashing Magazine AI transparency patterns
- 工具对比：SitePoint Cursor vs Claude Code 基准

（详细 findings 见 workflow wf_bac229bc-b74 journal）

## 关联
- TUI 源码：`src/ui/App.tsx`、`MessageList.tsx`；主循环 `src/agent.ts`（generateText 在此，待改 streamText）
- reasoning 格式坑：lemonade_config.md 记的 gemma4 reasoning_content 问题同源
- 能力边界：[[completeness_audit_2026_07_09]]
