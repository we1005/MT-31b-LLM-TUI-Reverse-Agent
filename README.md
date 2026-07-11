# rev-agent

本地 LLM agent CLI，专为安卓 APK 逆向场景设计。

强制把"4 阶段渐进探索协议 + 7 铁律 + Token 预算"作为 system prompt 注入，并配一套**针对小参数本地模型的上下文记忆系统**（带外结构化台账 + 稳定前缀 + 断链/空转兜底），让本地模型（默认 Qwen3.6-35B-A3B MoE，256k 窗口）在长链路逆向任务上可控、不发散、追完必收尾。

参考栈对齐 [Cline CLI](https://github.com/cline/cline/tree/main/apps/cli)（OpenTUI + Vercel AI SDK），但 **agent loop 自己写**，避免 Cline monorepo 的复杂依赖。

## 装好的依赖

- 运行时：`bun >= 1.2`
- LLM 抽象：`ai@6.0.196` + `@ai-sdk/openai@3.0.67` + `@ai-sdk/anthropic@3.0.81`
- Schema：`zod@4.4.3`
- CLI：`commander@14.0.3`
- TUI：`@opentui/core@0.1.102` + `@opentui/react@0.1.102`
- MCP：`@modelcontextprotocol/sdk@1.29.0`

## 配置

默认走本地 LAN 上的 lemonade（**Qwen3.6-35B-A3B MoE，已加载**）：

```toml
# ~/.config/rev-agent/config.toml （可选，纯 CLI 参数也行）
backend = "lemonade"
model   = "Huihui-Qwen3.6-35B-A3B-abliterated-ggml"   # ← lemonade 侧已加载的默认模型
baseURL = "http://192.168.9.101:13305/api/v1"          # 你 lemonade 服务地址（LAN，端口 13305，路径 /api/v1）
tokenBudget = 80000
notesPath   = "/tmp/work-notes.md"
```

支持的 backend（默认值逐字取自 `src/llm.ts` 的 `BACKEND_DEFAULTS`）：

| backend | 默认 baseURL | 默认 model | apiKey 来源 |
|---|---|---|---|
| `lemonade`   | `http://192.168.9.101:13305/api/v1` | `Huihui-Qwen3.6-35B-A3B-abliterated-ggml` | 内置 `lemonade` |
| `lm-studio`  | `http://localhost:1234/v1` | `gemma-3-27b-it` | 内置 |
| `ollama`     | `http://localhost:11434/v1` | `gemma3:27b` | 内置 |
| `local`      | 必须 `--base-url` 显式 | `gemma-3-27b-it` | 内置 |
| `claude`     | 走 Anthropic 云 | `claude-opus-4-7` | env `ANTHROPIC_API_KEY` / `--api-key` |
| `openai`     | 走 OpenAI 云 | `gpt-4o` | env `OPENAI_API_KEY` / `--api-key` |
| `volcengine` | `https://ark.cn-beijing.volces.com/api/coding/v3` | `doubao-seed-code` | env `ARK_API_KEY` / `--api-key` |

> 本地端点（lemonade/lm-studio/ollama/local）都走 `provider.chat(model)`（chat completions，**不是** v6 默认的 Responses API，后者本地端点会 404），并挂 `reasoningRewriteFetch` + `withReasoning` 中间件救回思考链（见下文「流式与思考链」）。
> `volcengine` 必须用 `/api/coding/v3` 才走 Coding Plan 套餐额度（`/api/v3` 是按量计费）。

⚠️ **lemonade #2014 bug**：lemonade 10.x 里 `extra_models_dir` 导入的本地 GGUF 经 OpenAI API 自动加载时会误判为 HF model 触发 `Failed to fetch model info from HF API (404)`。**默认 Qwen3.6 已手动加载不受影响；切其他模型前必须先在服务器侧 `lemonade load <id> [--ctx-size N]` 手动预加载**，且**不要**切 `gemma-4-26B-A4B-it-uncensored`（会立即触发该 bug）。

## 用法

### 交互模式（默认，OpenTUI）

```bash
bun src/index.tsx
```

富 TUI：消息流（user/assistant/思考链/tool-call/结果分色）+ 工作笔记实时预览 + Token 预算进度条 + 工具审批弹窗（按 y/n）。正文与思考链均为流式增量上屏。

### 一次性任务（`--once`，脚本化/CI/评分用）

```bash
# 默认 §1 短 system prompt
bun src/index.tsx --once "在 ../work/mt-jadx/sources 里找 MT 2.26.5 的 MCP 入口类" --workdir ../work/mt-jadx/sources

# 复杂任务用 §2 长 prompt（含 7 铁律全文）
bun src/index.tsx --once "追出 MCP 请求处理的完整调用链路，每跳给证据行，最后画链路图" --verbose --workdir <源码树>

# 切 backend
bun src/index.tsx --once "..." --backend claude   # 须设 ANTHROPIC_API_KEY
```

`--once` 下正文走 **stdout**、日志/思考链走 **stderr**（评分脚本只读 stdout）。默认拒绝 write 类工具，加 `--auto-approve` 全放行。

### 从工作笔记续传（`--resume`）

```bash
bun src/index.tsx --resume --notes /tmp/work-notes.md --once "继续" --workdir <源码树>
```

用 §3 续传 prompt，把上一会话笔记全文注入首条消息、抽出 §4「下一步」接着干；笔记缺失/空则明确报错，不静默退化。

### MCP server 模式（`--mcp-server`）

```bash
bun src/index.tsx --mcp-server              # stdio transport，把 4 个工具暴露给 Claude Code / Cursor 反向调用
bun src/index.tsx --mcp-server --allow-write # 放行 ask/write 类工具（默认拒）
```

### CLI flags 全表

| flag | 说明 |
|---|---|
| `-b, --backend <name>` | 后端：lemonade/lm-studio/ollama/local/claude/openai/volcengine（默认 lemonade） |
| `-m, --model <id>` | model id（不给按 backend 默认） |
| `-u, --base-url <url>` | 覆盖 baseURL（local backend 必需） |
| `-k, --api-key <key>` | 覆盖 API key（云端 backend） |
| `--verbose` | 用 §2 长 prompt（默认 §1；§9 避坑块自动追加到 §1/§2/§3） |
| `--resume` | 从 `--notes` 笔记续传（§3 prompt） |
| `--once <task>` | 非交互单任务，正文 stdout、日志/思考 stderr |
| `--auto-approve` | 所有工具自动放行（仅 --once 建议） |
| `--workdir <path>` | agent 的 cwd（影响 grep/read_file 相对路径，并显式注入模型防路径幻觉） |
| `--budget <tokens>` | Token 预算上限（默认 80000） |
| `--notes <path>` | 工作笔记路径（默认 /tmp/work-notes.md） |
| `--mcp-server` | 进入 MCP server（stdio） |
| `--allow-write` | MCP server 下放行 ask/write 类工具 |
| `-V, --version` | 打印版本立即退出（<200ms，不 import 重模块） |

### 跑验收

```bash
bun run demo          # MVP 验收 5 项（scripts/demo.sh）
bash scripts/test-resume.sh   # V0.3 续传验收
bun scripts/test-mcp.ts       # MCP server 端到端
```

## 工具白名单

agent 只能调下面 4 个工具（`ToolRegistry` 编译期静态注册，无插件系统）：

| 工具 | 类别 | 审批 | 说明 |
|---|---|---|---|
| `shell` | mixed | 查询 auto / 写入 ask / 危险 deny | 仅白名单内逆向工具（jadx/apktool/apkid/adb/frida/grep/strings/…），`rm -rf / sudo / curl / wget / ssh / dd` 硬拒 |
| `read_file` | read | auto | 硬限单次 ≤ 200 行（铁律 2 编进 Zod schema，`MAX_LINES=200`） |
| `grep` | read | auto | 优先 ripgrep，硬限单次 ≤ 50 命中（`MAX_HITS=50`） |
| `append_note` | write | **always ask** | 追加工作笔记，首次自动 cp 模板 |

shell 审批分级：`auto`（`aapt2 dump`/`apkid`/`jadx -d`/`grep`/`strings`…查询）· `ask`（`cp`/`mv`/`apktool b`/`apksigner sign`/`adb install`…写入或副作用）· `deny`（`rm -rf`/`sudo`/`curl`/`wget`/`ssh`/`dd`…危险或外泄）。

## 上下文记忆系统（为小参数本地模型定制）

核心痛点：小模型在多跳链路任务上会**发散**（一直读停不下）、**断链**（宣布下一步却不做/追对却不写答案）、**长上下文收尾慢**。对应机制（`src/agent.ts` + `src/memory/ledger.ts`）：

- **带外结构化台账 Ledger**：系统在每次 read/grep 后**自动**抽取 reads/greps（零 LLM、不靠模型自律），从正文正则捞出 `跳N: A→B | 证据 file:line` 式 Hop 并与已读范围**交叉核验**（打 ✓）。台账不进 messages（绕 v6 tool-call↔result 配对 bug），只在调用时临时渲染。类名/行号 **verbatim** 存。
- **稳定前缀（SWA 优化，治"越聊越卡"）**：`system` 逐字节保持静态，台账改为**每步临时拼到 `messages` 末尾**的 ephemeral 消息、不写回历史。于是 `[静态 system + 只追加历史]` 成为 llama.cpp 可复用的稳定 KV 前缀，每步只重算新增部分——实测前缀复用 **0%→97%**（台账放 system 头部时每步全量重算）。
- **可逆折叠 compactHistory**：真实上下文超 `compactThreshold`（默认 160k）才启动，把旧 tool-result 换成带 `reread` 指针的轻量 view（逆向场景里指针=磁盘原文件路径，模型用现成 read_file 就能重取）——**折叠 ≠ 删除**。ctx 未逼近上限时不折叠以保稳定前缀。
- **收尾 O(1)**：最终链路图由 `renderChainGraph()` 从已积累的 Hop 直接渲染，不在巨上下文里重推。

每步都打记忆遥测：`[ctx=… step=… folded=… dedup=… hops=…(✓…) reads=… greps=…]` + `prefix-cache 命中 …%`。

## Agent loop 健壮性

- **ctxCeiling 硬止损**（默认 120k）：用真实 `contextTokens()`（对当前 messages 估一次，反映真实 prefill）判超阈，而非 `budget.used`（那是 super-linear 累加伪量）；超阈再放行 `maxRedSteps` 步仍不收敛则强制收尾。
- **断链兜底 nudge**：无 tool-call 收尾前，若文本以"让我…/换个方式…/进入阶段N…/裸标题/步骤号"结尾（`endsWithContinuationIntent`，移植 opencode finishReason 判据）→ 注入续跑/收尾指令；配额耗尽仍不落答案则**降级为强制收尾**（用 ledger 草稿），不裸 done 丢答案。
- **收尾安全网**：台账攒了 ≥1 跳却从没写「## 最终结论」就想收尾 → 用链路草稿逼补收尾拼图。
- **进度停滞硬止损**（`stallCap=3`）：连续多步无新 read/grep/hop（原地打转，如死磕不存在的类）→ 强制收尾报告已确认证据。
- **迷路空转干预**（`exploreCap=8`）：多次调用仍连不出第一跳 → 注入「反向追踪」策略提醒，二次仍无进展判定起点难定位、强制收尾报告卡点。
- **两段超时**：首 token 前用宽 `firstTokenTimeoutMs`（300s，本地大模型 prefill 大上下文 + 长 CoT 可能几分钟才吐首字），首 token 后切紧的空闲超时（120s）；配 AbortController。
- **budget 线性计量**：只累加每步 `outputTokens`（诚实"累计输出成本"），不累加含历史 prefill 的 totalTokens。
- **dedup 去重守卫**：重复 read 同范围 / 重复 grep 同 pattern+path → 不真跑，回台账提示。
- LLM 可重试错误（网络/5xx/超时/abort）指数退避重试。

## 流式与思考链

- **streamText + fullStream**：正文（`assistantDelta`）与思考链（`reasoningDelta`）逐 part 实时上屏，消灭本地模型推理期死屏。
- **reasoning_content 救回**：本地 OpenAI 兼容端点（lemonade 等）把思考链放非标 `delta.reasoning_content` 字段，`@ai-sdk/openai` 会静默丢弃。`reasoningRewriteFetch` 拦截 SSE 流把它改写成内联 `<think>…</think>`，再由 `extractReasoningMiddleware({tagName:'think'})` 拆回标准 reasoning part。

## 协议层（system prompt 来源）

启动时从 `docs-resources/LLM首轮注入prompt.md` 抽取 prompt（锚点 + code fence）：

- 默认 `§1`（短）· `--verbose` 切 `§2`（长，加意图映射/卡住自救/笔记纪律）· `--resume` 用 `§3`（续传）
- `§9`「通用避坑块」**自动追加**到 §1/§2/§3 每节末尾（CTF benchmark 修复沉淀）

用 `REV_AGENT_PROMPT_PATH` env 或 config 的 `promptPath` 覆盖来源文件。

## 工作笔记

工作笔记（默认 `/tmp/work-notes.md`）是 agent 的显式长期记忆：

- 任务超 5 步、token 用 > 70% 时被 prompt 引导调 `append_note`
- 首次写入自动 cp `docs-resources/LLM工作笔记模板.md`
- 跨会话续传见上文 `--resume`

## 现状与非目标（V0.3）

**已实现**：4 工具 agent loop · 上下文记忆系统（Ledger + 稳定前缀 + 可逆折叠）· OpenTUI 交互 · `--once` / `--resume` 续传 · `--mcp-server`（对外暴露 4 工具）· preflight 源码级任务前置校验 · 7 后端切换。

**刻意不做**：

- ❌ sub-agent / 多 agent 协作
- ❌ Web UI
- ❌ RAG / 向量检索（grep + 笔记 + 带外台账够用）
- ❌ chroot/docker 沙箱（白名单 + timeout + 截断三层兜底）
- ❌ 对话持久化 DB（笔记落 /tmp + 带外 ledger 即可）
- ❌ 插件系统（ToolRegistry 编译期静态注册）
- ❌ 任何破解 / 绕过类预设（只读分析，合规红线）

## 项目结构

```
rev-agent/
├── src/
│   ├── index.tsx                CLI 主入口（commander，按 flag 动态 import 一个 runtime，保冷启动快）
│   ├── agent.ts                 Agent 主循环（Plan-Act + 审批 + budget + Ledger 集成，streamText）
│   ├── budget.ts                Token 预算 + 70%/90% 告警（EventEmitter）
│   ├── config.ts                config.toml 加载 + Backend 类型 + DEFAULT_CONFIG
│   ├── llm.ts                   后端切换（BACKEND_DEFAULTS + reasoningRewriteFetch + SUPPORTED_BACKENDS）
│   ├── preflight.ts             P0 源码级任务前置校验（缺源码树秒级 fail-fast 给反编译配方）
│   ├── prompts.ts               从 docs-resources/LLM首轮注入prompt.md 抽 §1/§2/§3（+ §9 自动追加）
│   ├── resume.ts                V0.3 笔记续传上下文构建
│   ├── memory/
│   │   └── ledger.ts            带外结构化台账（上下文记忆系统·阶段1）
│   ├── runtime/
│   │   ├── run-once.ts          --once / --resume 非交互执行（纯 stdout/stderr）
│   │   ├── run-interactive.ts   OpenTUI 交互入口（createCliRenderer + createRoot）
│   │   └── run-mcp-server.ts    --mcp-server：4 工具经 stdio 暴露
│   ├── tools/
│   │   ├── index.ts             ToolRegistry + classify(args)→auto|ask|deny
│   │   ├── shell.ts             白/黑名单 + timeout + 输出截断
│   │   ├── read-file.ts         Zod 强制 ≤200 行
│   │   ├── grep.ts              ripgrep 优先（真实路径解析 + BSD/GNU -E 兜底）+ ≤50 命中
│   │   └── note.ts              append-only 工作笔记
│   └── ui/
│       ├── App.tsx              OpenTUI 根组件（MessageList + NotesPreview + BudgetBar + 输入框）
│       ├── MessageList.tsx      消息流 scrollbox（分色）
│       ├── NotesPreview.tsx     工作笔记 tail 预览（3s 轮询）
│       ├── BudgetBar.tsx        Token 预算进度条（绿/黄/红）
│       └── ToolApproval.tsx     工具审批弹窗（y/n）
└── scripts/
    ├── demo.sh                  MVP 验收 5 项
    ├── benchmark-models.sh      多模型实战 benchmark（火山 Coding Plan × 10 + 本地 baseline）
    ├── gen-tool-help.sh         离线生成「递归 --help」文档库 → docs-resources/tool-help/
    ├── test-mcp.ts              MCP server 端到端测试
    └── test-resume.sh           V0.3 续传验收
```

## 关联协议文档（`docs-resources/`）

- `LLM首轮注入prompt.md` — system prompt 数据源（§1~§9）
- `LLM工作笔记模板.md` — 工作笔记模板源
- `上下文记忆系统-架构设计.md` — 记忆系统设计
- `实跑记录-追MCP请求处理链路.md` — 真实跑 + SWA/收尾优化 A/B（含实测数据）
- `如何给rev-agent下达逆向任务-使用指南.md` — 下指令方式
- （项目根 `Mac 安卓逆向工具与工作流指南.md` — 主指南：4 阶段渐进 + 7 工作流）

## 开发

```bash
bun install
bun typecheck       # tsc --noEmit
bun lint            # biome check src
bun format          # biome format --write src
bun start           # 跑 src/index.tsx
bun run demo        # MVP 验收
bun run compile     # bun build --compile → dist/rev-agent 单二进制
```

## License

私自使用。基于 Cline (Apache 2.0) 的设计思路，不分发。
