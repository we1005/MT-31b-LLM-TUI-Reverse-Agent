# 🚀 rev-agent 对接手册（其他 agent / 模型快速上手）

> 这是给**接手本项目的其他 agent / 不同模型**的入口文档。目标：5 分钟看懂项目、知道铁律、会跑会测、知道东西都在哪、能复现已有实验。
> 本文件夹 `onboarding/` = 专门的对接包；配合仓库根 `README.md`（更细的架构/健壮性/协议）与 `docs-resources/`（48+ 篇调研与实测沉淀）。

---

## 0. 一句话项目定位

> rev-agent = 自研轻量 **TS/Bun agent CLI**，驱动**本地 lemonade 后端（Qwen3.6-35B-A3B MoE）**做**安卓 APK 逆向**。强制把"4 阶段渐进探索协议 + 7 铁律 + Token 预算"作为 system prompt 注入。有 TUI / --once / --web / MCP-server 四种前端，自带带外结构化台账(ledger)、止损守卫、脱敏云端顾问、案卷续分析等机制。

主流程：`用户任务 → Agent.run() 单步循环(streamText → toolCall → 审批/执行 → 续轮) → 4 工具(shell/grep/read_file/append_note) → lemonade`。

---

## 1. ⚠️ 铁律（动手前必读，违反会踩坑或出事）

| # | 铁律 | 为什么 |
|---|---|---|
| 1 | **lemonade 单并发**：任何时刻只能有一个 agent 打后端；跑批**严格串行**，启动前 `pgrep -fl 'bun.*src/index.tsx\|coding-agent/dist/cli.js'` 确认无占用 | 并发会卡死后端(踩过) |
| 2 | **只用已加载的模型**（Qwen3.6），**不要触发切换/手动加载** | lemonade #2014 自动加载 bug；切模型需人在服务器侧 `lemonade load` |
| 3 | **SWA 稳定前缀**：台账/动态内容**只拼 messages 末尾**，**绝不进 system 头部** | 进 system 每步破前缀缓存，实测 0%→97% 命中差；治"越聊越卡" |
| 4 | **只读逆向合规**：不产出可用破解、不改 APK、不生成 patch/smali；apk 审计工具集限 `read,grep,find,ls`（物理排除 write） | 合规红线；产出定位为"给原开发者的防御加固" |
| 5 | **每个 workflow 调研 / 每次实验结果**都必须沉淀成 md（含结论）再 commit+push | 对话会压缩、后台结果会丢，只有落盘 md 是可跨会话复用/追溯的资产 |
| 6 | **git 默认在 main 上改**；除非用户明说才开分支 | 用户偏好 |
| 7 | commit trailer 用 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` | 用户约定 |
| 8 | typecheck **baseline = 3 个错误**（SDK 类型不匹配，非新增），不要为消它们改坏代码 | 已知基线 |

lemonade 实况：`http://192.168.9.101:13305/api/v1`，apiKey 任意串，模型 id `Huihui-Qwen3.6-35B-A3B-abliterated-ggml`。

---

## 2. 跑起来（30 秒）

```bash
cd /Volumes/zhitai-7100/reverse-agent/rev-agent
bun install                              # 装依赖
bun run typecheck                        # 应输出 3(baseline)
bun run test                             # 离线套件:guards33 + signal16 + redact40 + advisor15

# 单任务(脚本/评分用,结果走 stdout):
bun src/index.tsx --once "<任务>" --workdir <jadx目录> --backend lemonade --auto-approve --budget 80000
# 交互 TUI(默认):
bun src/index.tsx
# Web 前端:
bun src/index.tsx --web           # 默认 :5178
# MCP server(给 Claude Code/Cursor 反向调用):
bun src/index.tsx --mcp-server
# 从工作笔记续传 / 案卷续分析 / 卡住问云端:
bun src/index.tsx --resume --notes <path>
bun src/index.tsx --once "<任务>" --corpus <案卷目录>
bun src/index.tsx --once "<任务>" --consult-cloud --advisor-backend claude   # 默认关,需 key
```

逆向产物位置：`../work/{mt-jadx,...}`（CTF）、`../apk-moded/<name>-jadx/`（9 个被破解 App 审计目标）。

---

## 3. 代码地图（src/）

| 文件 | 职责 |
|---|---|
| `agent.ts` | **主循环**：单步 Plan-Act + 审批 + budget + 止损守卫 + 折叠 + 台账提升。**改动最敏感。** |
| `guards.ts` | 止损守卫**纯函数决策**(signal/count-gated)——框架化 MVP-0/1。 |
| `llm.ts` | 后端切换 + `reasoningRewriteFetch`(把本地 reasoning_content 救回成标准 reasoning part)。 |
| `redact.ts` / `advisor.ts` | 脱敏防火墙 / 云端顾问(卡住→脱敏问云端拿思路)。默认关。 |
| `memory/ledger.ts` | 带外结构化台账(零-LLM 抽 reads/greps/hops + 边派生)。 |
| `corpus.ts` / `stack-probe.ts` / `resume.ts` / `preflight.ts` | 案卷模式 / 前置探栈 / 笔记续传 / 源码树前置校验。 |
| `tools/` | 4 工具:`shell/grep/read-file/note` + `index.ts`(注册+分类 auto/ask/deny)。 |
| `ui/` | OpenTUI 前端:`App.tsx`(根)+MessageList/BudgetBar/NotesPreview/ToolApproval。 |
| `runtime/` | 四前端接线:`run-once / run-interactive / run-web-server / run-mcp-server`。 |
| `prompts.ts` | 从 `docs-resources/LLM首轮注入prompt.md` 抽 §1-§9 协议片段注入。 |

---

## 4. 知识/资产都在哪

- **本文件夹 `onboarding/`**：对接包——本 README + `TUI-输出代理与测试.md`（TUI I/O 代理与测试+代码）+ `测试与数据格式.md`（按模块测试计划+数据格式）+ `资产索引.md`（脚本/文档/产物全索引）。
- **仓库根 `README.md`**：详细架构图 / Agent loop 健壮性 / 上下文记忆系统 / 协议层 / 能力边界 / 🚧待办路线。
- **`docs-resources/`（48+ md）**：每次调研/实验的沉淀。重点：`pi-agent接入Qwen3.6-{计划,实测对比}.md`、`pi-agent实验复现手册.md`、`框架化-把逆向负担从模型移到框架.md`、`框架化-MVP-0-1-守卫软化-实测.md`、`混合后端-云端顾问-*.md`、`上下文记忆系统-架构设计.md`。
- **`scripts/`**：测试 + 判分 + 基准脚本（见 `资产索引.md`）。
- **`pi/`**：用 pi-agent 驱动本地模型的可复现产物（provider 扩展 / RE 纪律提示 / 审计提示 / runner / 案卷样例 / 前置分析 workflow）。
- **跨会话记忆**：`~/.claude/projects/-Volumes-zhitai-7100-reverse-agent/memory/`（`MEMORY.md` 是索引）——新会话首轮按 MEMORY.md 顺序读。

---

## 5. 当前状态 + 未完成 TODO（接手重点）

- ✅ 已交付：核心 agent(4 前端) / 台账 / SWA 稳定前缀 / 止损守卫 / 脱敏云端顾问 / 案卷模式 / 前置探栈 / 笔记续传 / pi-agent 接入+基准。
- 🚧 **进行中(分支 `framework-guards`)**：框架化 MVP-0/1/1.1（signal-gated 守卫软化）已实现+实测，正多 seed 加固；MVP-2(corpus/advisor 加码)/3/4 待续。见根 README 🚧待办 + `框架化-MVP-0-1-守卫软化-实测.md`。
- 🚧 **暂缓待办**：顺路发现缓存（阶段0 闸门先行，见 `顺路发现缓存-旁路语义记忆-深度分析.md`）。
- 📌 已标定上限：全混淆无 grep 锚点的破解定位是模型+keyword-grep 联合天花板；破壁靠强模型 case-file / 云端顾问。

---

## 6. 怎么复现已有实验

- **pi-agent × 本地模型 全套实验**（接入 / 中难度基准 / apk 审计 / 前置强模型案卷→pi 续跑）：逐条命令 + 所有 verbatim 提示词见 **`docs-resources/pi-agent实验复现手册.md`**。
- **守卫 A/B**（count vs signal）：`REV_GUARD_MODE=count|signal bun src/index.tsx --once ...`；批处理骨架见 `资产索引.md`。
- **TUI 输出代理与测试**：见 `onboarding/TUI-输出代理与测试.md`（含可直接跑的测试代码）。
- **改了模块该跑什么测**：见 `onboarding/测试与数据格式.md` 的按模块测试计划。
