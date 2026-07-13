# MT-31b-LLM-TUI-Reverse-Agent

> 自研轻量 **TS/Bun agent CLI**，驱动**本地 lemonade 后端（Qwen3.6-35B-A3B MoE）**做**安卓 APK 逆向**。强制把「4 阶段渐进探索协议 + 7 铁律 + Token 预算」作为 system prompt 注入；带 TUI / `--once` / `--web` / MCP-server 四种前端，自带带外结构化台账、止损守卫、脱敏云端顾问、案卷续分析等机制。

一句话：**用一套强约束的框架 + 记忆/止损机制，把一个能力有上限的本地小模型，压成一个能干活的安卓逆向 agent。**

---

## 这个 wiki 有什么

| 页面 | 内容 |
|---|---|
| [[Quickstart]] | 30 秒跑起来（安装 / 四种前端 / 测试） |
| [[Architecture]] | 端到端数据流 Mermaid + Agent 单步循环 + 组件速查（按层） |
| [[Mechanisms]] | 🔬 约 60 个机制逐条详解（SWA/记忆/守卫/框架化/协议/安全/后端），含 file:line 与"治什么" |
| [[Context Memory System]] | 🧠 为 256K 小模型×超大反编译产物定制的记忆层：带外台账 + SWA 稳定前缀(0%→97%) + 可逆折叠 + 消融裁决 |
| [[Comparisons]] | 📊 六组实测对比（rev vs pi / 案卷 handoff / F1 守卫 / F3 playbook / 10 题分层 / 脱敏 0 泄露） |
| [[Showcase Benchmark Questions]] | 🎯 6 道精选题（覆盖静态定位→深链混淆→平坦化 ceiling），含真值/陷阱/实测 |
| [[Iron Laws]] | ⚠️ 动手前必读的铁律（单并发 / 只读合规 / SWA 稳定前缀 …） |
| [[Experiments and Findings]] | 实测沉淀：pi-agent 基准 / 框架化守卫 / 云端顾问 / 能力上限标定（含诚实的多 seed 修正） |
| [[Onboarding for Agents]] | 给其他 agent/模型的快速上手包（对应仓库 `onboarding/`） |
| [[Roadmap]] | 路线（框架化 MVP-0..4 已合 main / 顺路发现缓存已证伪 / 上限突破） |

---

## 30 秒认识它

```bash
cd rev-agent && bun install
bun src/index.tsx --once "找出 MCP server 入口类" --workdir ../work/mt-jadx --backend lemonade --auto-approve
bun src/index.tsx          # 交互 TUI
bun src/index.tsx --web    # 浏览器前端 :5178
```

主流程：`用户任务 → Agent.run() 单步循环(streamText → toolCall → 审批/执行 → 续轮) → 4 工具(shell/grep/read_file/append_note) → lemonade(Qwen3.6)`。

后端实况：`http://192.168.9.101:13305/api/v1`，模型 `Huihui-Qwen3.6-35B-A3B-abliterated-ggml`（**单并发**）。

---

## 项目现状（诚实版）

- ✅ 核心 agent（4 前端）/ 带外台账 / SWA 稳定前缀 / 止损守卫 / 脱敏云端顾问 / 案卷模式 / 前置探栈 / 笔记续传 / pi-agent 接入 + 基准，均已交付。
- 📌 **已标定的能力上限**：本地 35B + keyword-grep 在**全混淆无锚点**的破解定位上打不动（模型天花板，非框架的锅）。可靠破壁靠**强模型前置案卷 / 云端顾问**（把"搜索题"降级成弱模型擅长的"核对题"，实测把一道超时空答的题翻成 132s 正确）。
- ✅ 已合 main：框架化 MVP-0..4——多 seed 消融定默认（F1 signal 默认开 / F2 corpus / F3 playbook 默认关 opt-in / F4 判分器）；见 [[Experiments and Findings]] §3。顺路发现缓存经阶段0 双否决**不合并**（§6）。

> ⚖️ **合规**：全程**只读**逆向分析。产出定位为"给原开发者的防御加固建议"，**不产出可用破解、不修改 APK、不生成 patch**。详见 [[Iron Laws]]。
