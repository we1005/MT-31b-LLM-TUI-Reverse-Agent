# 把本地 Qwen3.6(lemonade) 接入 pi-agent，并驱动两个交付的可执行计划（红队复审终版）

> 落盘建议：`/Volumes/zhitai-7100/reverse-agent/rev-agent/docs-resources/plan-pi-lemonade-接入与两交付.md`，写完即 `git add && git commit`。
> 本文所有关于 pi 行为的断言都带 `文件:行号`（pi 源码在本机 `/Volumes/zhitai-7100/pi-0.80.6/`）或真实 URL；无法从源码/文档证实的一律进「实测待验证点」，标 **需实测**，不粉饰。
> 本版已并入红队复审意见，逐条采纳/驳回见第 0.B 节；红队指出的成败关键实测点已提升为**阶段 0 必过冒烟闸门**（第 2.5 节），且修正了草稿一处会把人带沟里的错误观察方法。

---

## 0.A 一处关键路径纠错（先读）

侦察 JSON 里多处把 RE 协议文档写成 `/Volumes/zhitai-7100/reverse-agent/Mac 安卓逆向工具与工作流指南.md`，**该路径不存在**（`ls` 已确认 No such file）。真实位置在 `rev-agent/docs-resources/` 下，且有两份：

- `/Volumes/zhitai-7100/reverse-agent/rev-agent/docs-resources/LLM首轮注入prompt.md`（16591B，§1-§10，**这才是 rev-agent 真正注入模型的片段**，prompts.ts CANDIDATE_PATHS 只指向它）
- `/Volumes/zhitai-7100/reverse-agent/rev-agent/docs-resources/Mac 安卓逆向工具与工作流指南.md`（22192B，人读的工具/流程手册，不是注入片段）

**下文所有系统提示注入一律用 `docs-resources/LLM首轮注入prompt.md` 派生出的 pi 专用副本。**

---

## 0.B 红队复审与修正（逐条回应：采纳 / 驳回 + 为何）

红队把草稿里所有 `文件:行号` 级断言拿真实源码对了一遍，基础设施类断言基本成立，但揪出两个成败关键点被证伪/证悬，且草稿的冒烟观察方法有一处是错的。逐条处置如下：

| # | 红队意见 | 处置 | 依据 / 为何 |
|---|---|---|---|
| 1 | `-p` 无头会自主跑完多轮 tool 循环（架构层强支撑，仍缺端到端实测） | **采纳（定性成立，定量需实测）** | print 走同一 `session.prompt` 并 await 到终态（print-mode.ts:122/126/133-141），agent-loop 无 maxTurns/maxSteps 上限 → 「无硬轮数上限、靠外层 timeout」成立，`timeout 1800` 保留 |
| 2 | **【最严重】草稿冒烟观察点错了：text `-p` 模式根本不往 stderr 吐 thinking 流** | **完全采纳，已改写第 2.5 节** | 已亲验 print-mode.ts：text 分支只把最终 assistant 文本 `writeRawStdout` 到 **stdout**（:141），只有 error/aborted 走 `console.error`→stderr（:136/:150）；事件订阅 `session.subscribe(...writeRawStdout(...))` 只在 **json 分支**、且写 **stdout**（:104-106）。草稿「盯 `2> *.err` 找 thinking」永远是空的，会误判成接入失败去瞎调 thinkingFormat。**验证 reasoning 通路必须用 `--mode json` 解析 stdout 事件流。** |
| 3 | **【第二严重】`reasoning:true` 不够，`enable_thinking` 被 call-time 的 reasoningEffort 门控** | **采纳，已改写 2.a 与 2.5** | 已亲验 openai-completions.ts:614/616-618：`enable_thinking = !!options?.reasoningEffort`、`chat_template_kwargs = {enable_thinking: !!reasoningEffort, preserve_thinking:true}`。光在 model 写 `reasoning:true` 不开思考，必须当次调用带非空 reasoningEffort。**补充实测发现（比红队更精确）**：`:493` `reasoningEffort = clampedReasoning==="off" ? undefined : clampedReasoning`，而 `DEFAULT_THINKING_LEVEL=medium`（defaults.ts:3）——若 `-p` 路径真把 medium 透传成 reasoningEffort，则默认就 enable_thinking:true。**但"`-p` 是否真的把 default level 流到 reasoningEffort"仍未证实**，列为冒烟必验；保底做法是显式加 `:medium` 后缀（args.ts 支持 `provider/id:thinking`）。 |
| 4 | 项目本地 `.pi/extensions` trust 无头不卡死 | **采纳（成立）** | `!hasUI` 直接 `return false` 静默拒绝不阻塞（project-trust.ts）；用 `-e` 或全局扩展根本不走项目门控 |
| 5 | thinkingFormat / maxTokens 填错是**静默降质**不是硬报错，草稿"报错则回退"兜底无效 | **采纳，已改风险表 R2/R10 与 2.a 说明** | 选 `qwen`（顶层 `enable_thinking`）→ llama.cpp 多半静默忽略，思考漏正文，不抛异常；`max_completion_tokens` 同样静默。判定必须靠 json 模式看有无独立 reasoning 事件 + 看正文是否混入思考，不能等报错 |
| 6 | 交付物 2 应直接用 `--system-prompt` 整体替换，而非"先 append 不行再换" | **采纳（针对交付物 2），交付物 1 保留 append 先试** | append 在"你是写代码助手"后追加，两套人设并存，35B 小模型易被前半段带偏去"建议改代码/给 patch"，与交付物 2 只读红线冲突。交付物 2 直接 replace 更稳（工具层已 `-t read,grep,find,ls` 兜底，prompt 层也不该留诱导）。交付物 1 是分析题、无重打包风险，可先 append 实测 |
| 7 | R4 被夸大：jadx 已反编完、sources 在磁盘，审计不需要 bash，read+grep 足够；别为此加 bash（会破坏只读红线） | **采纳，已重写 R4** | 「没 bash 不能跑 rg/jadx」对本任务不成立——不需要再跑 jadx。保持 `-t read,grep,find,ls` 严格只读是对的 |
| 8 | 两个 runner 串行无 `&`，符合 lemonade 单并发铁律；heredoc\|while 子 shell 无害 | **采纳（成立）** | 循环体内就地起 pi、不依赖循环后读变量 |
| 9 | 判分器/题库/字段对得上；bank-crack.json 确无 `chain` 字段；bank copy 进 git 紧急且正确 | **采纳（成立）** | score-anchors.py 亲读，crack 分支读 `crack_point+chain+grade_keywords`；ephemeral scratchpad 随时会被清 |
| 10 | 合规只读成立，唯一补强是第 6 点 | **采纳** | 工具白名单物理排除 edit/write/bash |

**红队最终结论（采纳为本计划总纲）**：当前不能直接照全量跑，但离能跑很近，中间只挡着**一个必须先做的 json 冒烟**，且草稿给的观察方法是错的。最该先做的一步——见第 2.5 节阶段 0 闸门。

---

## 合规红线（醒目，写死进 prompt 与流程，不可越界）

> **本项目全程只读逆向。以下为不可协商红线，runner 与 prompt 双层强制：**
>
> 1. 只 `read/grep/find/ls` 反编译产物 `<name>-jadx/sources`；**不产出可用破解步骤、不生成 patch/smali、不重打包、不修改任何 APK。**
> 2. 工具层强制 `-t read,grep,find,ls`（不给 edit/write/bash）——物理上无法写文件到 APK。
> 3. 产出定位为**给原开发者的防御性加固建议**，不是给破解者的教程。
> 4. 交付物 2 系统提示用 `--system-prompt` 整体替换默认 coding 人设，杜绝"建议改代码/给 patch"的诱导（红队第 6 点）。
> 5. 只处理 `apk-moded/` 目录内已反编译源码；不联网、不下载、不起模拟器动态调试。

---

## 1. 目标、交付物与总体架构

### 1.1 两个交付物

- **交付物 1（CTF 应试）**：用 pi 驱动 lemonade/Qwen3.6，无头串行跑破解审计题库（`bank-crack.json`+`bank-crack2.json`+`bank-crack3.json`，共 **19 题、覆盖全部 9 个 App**），每题输出落 `<id>.out`，再用 `rev-agent/scripts/score-anchors.py` 做确定性锚点召回判分，产出 `_anchors.json` 记分卡。
- **交付物 2（apk-moded 只读防御审计）**：对 `apk-moded/` 下 9 个被违规破解 App 的 `<name>-jadx/sources` 逐个做**只读**审计，每 App 产出四段式报告：**破解点(类.方法+行号) / 破解手法 / 调用链 / 修复加固**。

> 交付物 1 的题库 task 本身就是四子问题（定位 file:line / 命名技术 / 追链路 / 加固方案），与交付物 2 高度同构，可复用同一 runner；交付物 2 不走判分器、改人读报告归档，且系统提示用 replace（红队第 6 点）。

### 1.2 架构图

```
                    ┌──────────────────────────────────────────────┐
                    │  串行驱动脚本 (shell, 严格单进程)              │
                    │  for 每题/每App:  pi -p ...  > <id>.out       │
                    │  ★ lemonade 单并发铁律：绝不并行起多个 pi     │
                    └───────────────┬──────────────────────────────┘
                                    │ 一次一个进程
                                    ▼
    ┌──────────────────────────────────────────────────────────────────┐
    │  pi CLI  (/Volumes/zhitai-7100/pi-0.80.6, dist/cli.js, v0.80.6)   │
    │  -p 无头 ──► agent-loop (while: LLM→toolCall→exec→回灌 到终态)     │
    │  reasoning 门控: enable_thinking = !!reasoningEffort              │
    │       (openai-completions.ts:614/616-618) → 必须带 thinking level │
    │  工具: 审计只读 → -t read,grep,find,ls (排除 bash/edit/write)     │
    │  系统提示: 交付1 --append-system-prompt / 交付2 --system-prompt   │
    │  provider "lemonade": api=openai-completions,                    │
    │       compat.thinkingFormat=qwen-chat-template                    │
    └───────────────────────────┬──────────────────────────────────────┘
                                │ OpenAI SDK → baseUrl + /chat/completions
                                ▼
    ┌──────────────────────────────────────────────────────────────────┐
    │  lemonade (llama.cpp 系) http://192.168.9.101:13305/api/v1        │
    │  model: Huihui-Qwen3.6-35B-A3B-abliterated-ggml                   │
    │  reasoning_content 流 → pi 解析成 thinking (仅在 json 事件流可见)  │
    │       (openai-completions.ts:364-395, 注释点名 llama.cpp)         │
    └──────────────────────────────────────────────────────────────────┘
                                │ 输出: text→stdout最终文本 / json→stdout事件流
                                ▼
    判分/归档: 交付1 score-anchors.py→_anchors.json；交付2 人读四段式报告
```

---

## 2. 接入步骤（可直接落地的产物）

### 2.a lemonade provider extension 完整 `.ts`

建议 copy 到项目内固定位置 `rev-agent/pi/lemonade.ts` 并入 git（现存离线冒烟通过的副本在 scratchpad `.../c0e365ae-.../scratchpad/lemonade.ts`，属 ephemeral，务必落 git）。完整内容：

```ts
/**
 * Lemonade local provider for pi (Qwen3.6 35B MoE served by lemonade).
 * 铁律: lemonade 单并发，绝不并行起多个 pi 打它。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("lemonade", {
    name: "Lemonade (local Qwen3.6)",
    baseUrl: "http://192.168.9.101:13305/api/v1", // OpenAI SDK 自动追加 /chat/completions
    apiKey: "lemonade",            // 字面量即可；lemonade 接受任意非空串
    api: "openai-completions",
    models: [
      {
        id: "Huihui-Qwen3.6-35B-A3B-abliterated-ggml",
        name: "Qwen3.6 35B A3B (lemonade)",
        reasoning: true,           // 必要但不充分：还需当次调用带 reasoningEffort
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,     // 256K 标称；真实窗口取决于 lemonade 启动 -c
        maxTokens: 32768,
        compat: {
          thinkingFormat: "qwen-chat-template", // 走 chat_template_kwargs
          maxTokensField: "max_tokens",         // llama.cpp 系吃 max_tokens
        },
      },
    ],
  });
}
```

**字段依据（都有源码），并已并入红队修正：**

| 字段 | 值 | 依据 / 红队修正 |
|---|---|---|
| `baseUrl` | `.../api/v1`（**不是 `/v1`**） | OpenAI SDK 自动补 `/chat/completions`，实打 `.../api/v1/chat/completions`（openai-completions.ts:532-537） |
| `apiKey` | 字面量 `"lemonade"` | env-api-keys.ts:74-106 的 envMap 无 lemonade 条目，不走环境变量回退，字面量直接透传 |
| `api` | `openai-completions` | lemonade=llama.cpp 系 |
| `reasoning` | `true` | **必要但不充分（红队第 3 点，已亲验）**：`enable_thinking = !!options?.reasoningEffort`（openai-completions.ts:614/617）。仅 `reasoning:true` 不带 reasoningEffort → 会发 `enable_thinking:false` 关掉思考。默认 `DEFAULT_THINKING_LEVEL=medium`（defaults.ts:3）**是否在 `-p` 路径流到 reasoningEffort 需实测**；保底显式加 `:medium` 后缀 |
| `compat.thinkingFormat` | `qwen-chat-template` | 发 `chat_template_kwargs={enable_thinking, preserve_thinking:true}`（openai-completions.ts:616-618，已亲验 `preserve_thinking:true` 在源码内，跨轮工具调用参数不退化）。**填错是静默降质不是报错（红队第 5 点）**：选 `qwen` 只发顶层 `enable_thinking`，llama.cpp 多半静默忽略、思考漏正文，不抛异常 |
| `compat.maxTokensField` | `max_tokens` | llama.cpp 惯例（openai-completions.ts:570-576）。**填错同样静默**（用默认输出上限），不能等报错，靠 json 模式判定 |

**可选加固**：llama.cpp 不认 developer role / reasoning_effort 顶层字段，稳妥可再加 `compat.supportsDeveloperRole:false`、`compat.supportsReasoningEffort:false`（默认版未加，见第 5 节权衡）。

### 2.b 放置 / 加载方式与 trust 处理

三条加载路径（loader.ts:672-677；config.ts:514-521 getAgentDir=`~/.pi/agent`；args.ts:149-151 `-e` 累加）：

| 方式 | 位置 | 需要 trust 吗 | 适用 |
|---|---|---|---|
| 全局扩展 | `~/.pi/agent/extensions/lemonade.ts` | **否**，自动加载 | 长期用，推荐 |
| CLI `-e` | `pi -e /abs/path/lemonade.ts ...` | **否** | 快速测试、脚本显式引 |
| 项目本地 | `<cwd>/.pi/extensions/lemonade.ts` | **是**（项目信任） | 想随仓库走，无头需 `--approve` |

**无头模式 trust 不会卡住（红队第 4 点确认成立）**：print/json/rpc 三种非交互模式，`resolveProjectTrusted` 在 `!hasUI` 时直接 `return false`（静默拒绝、不阻塞）——project-trust.ts:22-24/31-37/45-51；core/project-trust.ts:86-88；print 模式 `hasUI` 恒 false（main.ts:655）；extensions.md:1016 明列「Print mode: No-op」。全局与 `-e` 扩展不参与项目信任门控、总是加载（extensions.md:112/353；resource-loader.ts:494-501）。

**落地推荐**：安装到全局 `~/.pi/agent/extensions/lemonade.ts`；开发调试期用 `-e /abs/lemonade.ts`。**不要用项目本地 `.pi/extensions/`**（那条无头需 `--approve`，徒增变量）。

### 2.c 安装

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent   # bin 名: pi（供应链硬化）
# 或直接用本机已解包的:  node /Volumes/zhitai-7100/pi-0.80.6/packages/coding-agent/dist/cli.js
```

**已验证（离线、不触发推理）**：`pi --version` → `0.80.6` exit0；`pi -e /abs/lemonade.ts --list-models lemonade` → 表格行 `lemonade  Huihui-Qwen3.6-35B-A3B-abliterated-ggml  262.1K  8.2K  yes  no` exit0，证明 dist/cli.js 可跑、`-e` 加载 provider 无需信任提示。

### 2.5 阶段 0 冒烟闸门（★★ 全量跑之前必须全过，红队核心修正 ★★）

> **这是从"接入成功"到"能干活"的分界，务必最先跑，且必须用 json 模式看 stdout——不要按旧草稿去 text 模式 stderr 找 thinking，那里永远是空的。**

**闸门 0-1：看到 lemonade（不打后端）**
```bash
pi -e /Volumes/zhitai-7100/reverse-agent/rev-agent/pi/lemonade.ts --list-models lemonade
```
过：表格列出该模型。

**闸门 0-2：端点在线自检（串行，勿并发压测）**
```bash
curl -s http://192.168.9.101:13305/api/v1/models -H 'Authorization: Bearer lemonade'
```
过：返回含 `Huihui-Qwen3.6-35B-A3B-abliterated-ggml` 的模型列表。

**闸门 0-3：json 模式单条真推理（一次性验证三件成败关键事，红队指定的必过实测）**
```bash
cd /Volumes/zhitai-7100/reverse-agent/apk-moded/device-jadx/sources
pi -e /Volumes/zhitai-7100/reverse-agent/rev-agent/pi/lemonade.ts \
   --model lemonade/Huihui-Qwen3.6-35B-A3B-abliterated-ggml:medium \
   --mode json \
   -t read,grep,find,ls \
   -p "grep 出 op4.java 里和 is_ad_free 相关的行并说明它做了什么，用 file:line 引用" \
   > device-smoke.jsonl 2> device-smoke.err
```
**在 `device-smoke.jsonl`（stdout 事件流）里逐一核对三个必过项：**

- **(a) reasoning 通路通** —— 事件流里出现**独立的 reasoning/thinking 类型事件**（证明 reasoning_content 真被解析、`enable_thinking` 真的开了）。若正文里混入思考、或完全无 reasoning 事件 → `enable_thinking:false` 了，回到 2.a 检查：先确认 `:medium` 后缀是否透传成 reasoningEffort，再考虑 thinkingFormat 是否被 llama.cpp 静默忽略。**这是红队第 2/3/5 点合并的判定，不能靠 stderr、不能等报错。**
- **(b) `-p` 自主 tool 循环** —— 事件流里出现**多轮 `tool_call → tool_result → 再 tool_call` 序列后才 `agent_end`**（证明 print 不是回一轮就退、会跑满循环到终态；红队第 1 点定量确认）。
- **(c) trust 不卡死** —— 全程无信任提示阻塞、进程正常退出 exit0（红队第 4 点确认）。

**闸门通过标准**：(a)(b)(c) 全绿，并把结论（尤其 thinking level 是否需显式 `:medium`、thinkingFormat 是否 qwen-chat-template 生效、read+grep 是否够定位）写进 `bench/results/smoke-<ts>.md` 并 commit。**任一不过，禁止进阶段 1/2。**

> 说明：跑分与审计的全量运行仍可用 text 模式（判分器只吃纯文本 `.out`），但**"验证 reasoning 通路"这一步必须 json 看 stdout**。text 模式全量跑分只在闸门 0-3 三项全绿后才有意义。

---

## 3. 驱动 CTF（交付物 1）

### 3.1 题库与判分器现状

- 3 个 crack 题库在 **ephemeral scratchpad**（有丢失风险）：`.../scratchpad/ctf/{bank-crack.json,bank-crack2.json,bank-crack3.json}`，共 19 题（附录 A）。**第一步先 copy 进 git**：`rev-agent/bench/ctf/`（红队第 9 点：紧急）。
- 判分器 `rev-agent/scripts/score-anchors.py`：用法 `python3 score-anchors.py <bank.json> <results_dir> [out.json]`；对每个 `id` 读 `results_dir/<id>.out`，从 GT（crack 题取 `crack_point`+`chain`+`grade_keywords`，:52-54）抽 file:line/方法()/类名锚点，算归一化命中率 recall，打印每题 + `mean_anchor_recall`，写 `_anchors.json`（:63/:66-68/:80-84）。
- **判分口径诚实说明**：score-anchors.py 只是**确定性相对 Δ 指标**，不是绝对质量分。crack 题库绝对质量原用**强模型 rubric**（云端 Claude 亲读反编码评审；纯关键词判分已被证不可靠——battery 关键词仅 3/14 命中但真实质量 91，见 `docs-resources/出题记录-篡改APK破解审计题库理据.md:8-9`）。**本仓无 rubric judge 的脚本化实现**（open_question）。故：score-anchors 做可复现机械 A/B，绝对质量仍需人读或云端强模型复核。

### 3.2 注入 RE 协议为 system prompt（交付物 1）

- pi 默认系统提示偏"写代码 coding-agent"。交付物 1 是分析题、无重打包风险，**先用 `--append-system-prompt <file>` 追加 RE 协议**（args.ts:93-97；值可为文件路径，resource-loader.ts:50-65 `existsSync` 后 `readFileSync`；system-prompt.ts:48 拼末尾）。效果不足（被"写代码"人设带偏）再上 `--system-prompt` 整体替换（见风险 R8）。
- 注入文件用 **`LLM首轮注入prompt.md` 派生的 pi 专用副本**：其 §9 第 1 条是 **rev-agent 自研 shell 工具白名单约束**（禁 `cd DIR && cmd`、禁 for/while、禁 cp/mv，LLM首轮注入prompt.md:239-241）——**pi 的工具无此限制，这条注入进 pi 会误导，必须删**。预处理出 `rev-agent/pi/re-protocol-pi.md`：保留 §1 或 §2 正文 + §9 的反幻觉/台账/反向追踪约束（LLM首轮注入prompt.md:259-263/277-284/286-291），删掉 §9 第 1 条。选 §1（短~400tok）还是 §2（长~1100tok）**需实测**（open_question）。

### 3.3 无头做题模板

```bash
cd <题目 workdir>
pi -e /abs/lemonade.ts \
   --model lemonade/Huihui-Qwen3.6-35B-A3B-abliterated-ggml:medium \
   --append-system-prompt /Volumes/zhitai-7100/reverse-agent/rev-agent/pi/re-protocol-pi.md \
   -t read,grep,find,ls \
   -p "<题目 task 文本>" \
   > <results_dir>/<id>.out 2> <results_dir>/<id>.err
```
- `--model ...:medium`：显式带 thinking level 保底 reasoningEffort 非空（依 2.a / 闸门 0-3 结论决定是否必须）。
- `-t read,grep,find,ls`：默认只启用 read/bash/edit/write（sdk.ts:245；agent-session.ts:2536；system-prompt.ts:90），grep/find/ls 默认关（args.ts:386-388）。显式白名单同时排除 bash/edit/write，天然只读。**红队第 7 点：sources 已在磁盘，read+grep 足够定位，无需 bash 跑 jadx；不为此加 bash（会破坏只读红线）。** read+grep 是否够用仍标 open_question，若确实不够再评估。
- 输出捕获：text 模式取会话最后一条 assistant 消息所有 text 段写 stdout（print-mode.ts:129-141）。**判分器只吃纯文本 `.out`，text 模式最省事**；reasoning 通路已在闸门 0-3 用 json 单独验过，全量无需 json。

### 3.4 串行 runner 骨架（尊重单并发铁律）

`rev-agent/bench/run-ctf.sh`：
```bash
#!/usr/bin/env bash
set -uo pipefail
LEMON=/Volumes/zhitai-7100/reverse-agent/rev-agent/pi/lemonade.ts
PROTO=/Volumes/zhitai-7100/reverse-agent/rev-agent/pi/re-protocol-pi.md
MODEL=lemonade/Huihui-Qwen3.6-35B-A3B-abliterated-ggml:medium
BANKS="bank-crack.json bank-crack2.json bank-crack3.json"
CTF=/Volumes/zhitai-7100/reverse-agent/rev-agent/bench/ctf
OUT=/Volumes/zhitai-7100/reverse-agent/rev-agent/bench/results/ctf-$(date +%Y%m%d-%H%M%S)
mkdir -p "$OUT"

for bank in $BANKS; do
  python3 - "$CTF/$bank" <<'PY' | while IFS=$'\t' read -r id wd task; do
import json,sys
d=json.load(open(sys.argv[1],encoding='utf-8'))
arr=d if isinstance(d,list) else d.get('questions',[])
for q in arr:
    t=q.get('task','').replace('\t',' ').replace('\n','\\n')
    print(f"{q['id']}\t{q['workdir']}\t{t}")
PY
    echo ">>> [$id] cwd=$wd"
    task_real=$(printf '%b' "$task")           # 还原换行
    ( cd "$wd" && \
      timeout 1800 pi -e "$LEMON" --model "$MODEL" \
        --append-system-prompt "$PROTO" \
        -t read,grep,find,ls \
        -p "$task_real" ) \
      > "$OUT/$id.out" 2> "$OUT/$id.err"
    echo "    exit=$? bytes=$(wc -c < "$OUT/$id.out")"
    # ★ 串行：本题 pi 退出后才进下一题，绝不 & 后台并行
  done
done

for bank in $BANKS; do
  python3 /Volumes/zhitai-7100/reverse-agent/rev-agent/scripts/score-anchors.py \
    "$CTF/$bank" "$OUT" "$OUT/_anchors-${bank%.json}.json"
done
echo "结果目录: $OUT"
```
要点：`timeout 1800` 兜底防跑飞（pi **无 `--max-turns` 类硬轮数上限**，agent-loop 无显式轮数上限，红队第 1 点确认）；三个 bank 分别判分（id 全局唯一，写同一 results_dir 无冲突）；heredoc\|while 虽在子 shell 但循环体内就地起 pi、无害（红队第 8 点）。

### 3.5 判分与记分卡
`score-anchors.py` 打印每题 `recall=x.xx (hit/total) out✓/NO-OUT` 与平均，并写 `_anchors-*.json`。把三次汇总 + 每题 recall 誊进 `rev-agent/bench/results/ctf-<ts>/记分卡.md`（含结论），commit/push。**（memory 铁律：每次运行结果必须沉淀成 md 再 commit/push，对话会压缩、后台结果会丢。）**

---

## 4. 驱动 apk-moded 只读防御审计（交付物 2）

### 4.1 合规红线（见顶部醒目区，此处只列工具层强制）

- `-t read,grep,find,ls`：不给 edit/write/bash，物理层无法写文件/重打包。
- **系统提示用 `--system-prompt` 整体替换（红队第 6 点，非 append）**：避免默认"写代码助手"人设诱导 35B 去"建议改代码/给 patch"。
- 产出定位为给原开发者的防御加固建议。

### 4.2 每个 App 的四段式 prompt 模板

存 `rev-agent/pi/audit-prompt.txt`，`{APP}` 运行时替换。此文件同时作为 `--system-prompt` 的整体人设根基或 `-p` 的任务文本（见 4.3 二选一策略）：
```
你在对被违规破解的安卓 App「{APP}」做防御性安全审计（只读，禁止产出/重打包破解，禁止改 APK）。
当前目录是该 App 的 jadx 反编译源码树。基于你 read/grep 到并能引用 file:line 的证据作答，
没读到就明说"未证实"，不得臆测。按以下四段式输出，最后用「## 最终结论」收尾：

1) 破解点：被篡改绕过的 license/VIP/premium 校验位于哪个 类.方法 + 行号（file:line 精确定位）。
2) 破解手法：这处校验被如何攻破（如 StateFlow 写死 new X(true) / getter 恒真 / 返回值短路 /
   空方法中和 / entitlement 忽略入参 / native 边界绕过 等），命名该技术。
3) 调用链：从入口到该破解点的调用链，每跳一行台账「源 → 目标 | 证据 file:行」。
4) 修复加固：给原开发者的加固修复方案（如何让该校验重新生效并抗篡改）。
```

### 4.3 系统提示策略（交付物 2 用 replace）

推荐做法：把「你是只读安卓安全审计员，禁止产出破解/给 patch/改 APK」的人设 + §9 反幻觉台账约束，合成一份 `rev-agent/pi/audit-system.md`，作为 `--system-prompt` 整体替换默认人设；四段式任务文本走 `-p`。这样默认"coding-agent"人设被完全顶掉，不留诱导（红队第 6 点）。

### 4.4 串行批处理骨架

`rev-agent/bench/run-audit.sh`：
```bash
#!/usr/bin/env bash
set -uo pipefail
LEMON=/Volumes/zhitai-7100/reverse-agent/rev-agent/pi/lemonade.ts
SYS=/Volumes/zhitai-7100/reverse-agent/rev-agent/pi/audit-system.md   # 整体替换人设
TMPL=/Volumes/zhitai-7100/reverse-agent/rev-agent/pi/audit-prompt.txt
MODEL=lemonade/Huihui-Qwen3.6-35B-A3B-abliterated-ggml:medium
BASE=/Volumes/zhitai-7100/reverse-agent/apk-moded
OUT=/Volumes/zhitai-7100/reverse-agent/rev-agent/bench/results/audit-$(date +%Y%m%d-%H%M%S)
mkdir -p "$OUT"

declare -a DIRS=(battery clone code device duolingo easynotes podcast snaptube 酷我音乐)
for app in "${DIRS[@]}"; do
  wd="$BASE/$app-jadx/sources"
  [ -d "$wd" ] || { echo "SKIP $app (no $wd)"; continue; }
  name="${app/酷我音乐/kuwo}"
  prompt="$(sed "s/{APP}/$name/g" "$TMPL")"
  echo ">>> 审计 $name  cwd=$wd"
  ( cd "$wd" && timeout 1800 pi -e "$LEMON" --model "$MODEL" \
      --system-prompt "$SYS" -t read,grep,find,ls \
      -p "$prompt" ) > "$OUT/$name.md" 2> "$OUT/$name.err"
  echo "    exit=$? bytes=$(wc -c < "$OUT/$name.md")"
  # ★ 单并发：上一个 pi 退出后再起下一个
done
echo "报告目录: $OUT"
```

### 4.5 产物落盘
- 每 App 一份：`audit-<ts>/<name>.md`（battery/clone/code/device/duolingo/easynotes/podcast/snaptube/kuwo）。
- 汇总：`audit-<ts>/审计汇总.md`（9 App 四段式摘要 + 通用加固模式 + 与题库 GT 破解点对照）。commit/push。

---

## 5. 风险与实测待验证点

| # | 风险/待验证 | 现状/依据 | 缓解 |
|---|---|---|---|
| R1 | **Qwen reasoning 是否经 pi 正常解析** | 解析器天然吃 reasoning_content（openai-completions.ts:364-395，注释点名 llama.cpp）；abliterated build 是否产分离 reasoning_content 未端到端实测 | 闸门 0-3 用 **json 看 stdout reasoning 事件**（不是 stderr！红队第 2 点）；**需实测** |
| R2 | **thinkingFormat qwen vs qwen-chat-template + 填错静默降质** | 选 qwen-chat-template（chat_template_kwargs）对 llama.cpp 合理；选 qwen 只发顶层 enable_thinking，llama.cpp **静默忽略**、思考漏正文、不报错（红队第 5 点） | 闸门 0-3 看有无独立 reasoning 事件 + 正文是否混思考；**不能等报错**；**需实测** |
| R3 | **`enable_thinking` 被 reasoningEffort 门控（已亲验成立）** | `enable_thinking = !!options?.reasoningEffort`（openai-completions.ts:614/617）；`DEFAULT_THINKING_LEVEL=medium`（defaults.ts:3）是否在 `-p` 流到 reasoningEffort 未证实 | 保底显式 `--model ...:medium`；闸门 0-3 确认；**需实测 `-p` 默认是否已带 level** |
| R4 | **默认工具够不够 RE** | 默认 read/bash/edit/write（sdk.ts:245）；`-t read,grep,find,ls` 无 bash。**红队第 7 点：sources 已反编在磁盘，审计不需再跑 jadx，read+grep 足够，不为此加 bash（保只读红线）** | 若 read+grep 定位不够再评估；**需实测哪种够用**（open_question，但默认不加 bash） |
| R5 | **lemonade 单并发** | memory 铁律，已踩过并发卡死 | runner 全程串行、绝不 `&`；`timeout 1800` 兜底 |
| R6 | **大反编译产物 × 上下文 + `ls/find` dump 风险** | device sources 7638 文件；kuwo 重混淆；256K 标称、真实取决 lemonade `-c`。红队第 7 点补充：模型若用内置 `ls/find` dump 整棵树，单次输出几万行灌 context → 未定位先爆窗 | cwd 限单 App、prompt 引导先 grep 定位再精读；json 的 session stats 看上下文占比；**长题可能超窗，需实测** |
| R7 | **trust 无头卡住** | 已证不卡（project-trust.ts:22-24/86-88；extensions.md:1016，红队第 4 点确认） | 用 `-e` 或全局扩展；不用项目本地 `.pi/extensions/` |
| R8 | **pi 系统提示偏"写代码"** | coding-agent 默认人设 | 交付 1 先 append 测；**交付 2 直接 `--system-prompt` 整体替换（红队第 6 点）**；**需实测 append 够不够** |
| R9 | **§1 vs §2 注入、§9 删到什么程度** | §9 第 1 条 shell 白名单不适用 pi（LLM首轮注入prompt.md:239-241） | 预处理 re-protocol-pi.md；选版本**需实测** |
| R10 | **maxTokensField=max_tokens 填错静默** | llama.cpp 惯例（openai-completions.ts:570-576）；填错用默认上限、不报错（红队第 5 点） | 闸门 0-3 看输出是否被异常截断；**不能等报错** |
| R11 | **绝对质量分无 rubric judge** | 本仓只有 score-anchors.py（相对 Δ），rubric 需云端强模型，无脚本化实现 | score-anchors 机械 A/B；绝对质量人读或云端 Claude 复核 |
| R12 | **无 `--max-turns` 硬上限** | agent-loop 无 maxTurns/maxSteps（红队第 1 点确认）；-p 单进程无该 flag | 外层 `timeout 1800` 包一层（已在 runner） |

---

## 6. 分阶段落地（每阶段可独立验收）

### 阶段 0 — 冒烟闸门（最先做，全过才准进阶段 1/2）
1. copy lemonade.ts 到 `rev-agent/pi/`，装到 `~/.pi/agent/extensions/` 或用 `-e`；copy 3 个 bank 进 `rev-agent/bench/ctf/`（脱离 ephemeral，红队第 9 点紧急）。
2. 跑闸门 0-1、0-2、**0-3（json 模式，核对 (a) reasoning 事件 (b) 多轮 tool 循环 (c) 不卡死）**。
- **验收**：0-3 三项全绿；敲定 thinking level 是否需 `:medium`、thinkingFormat 是否生效、read+grep 是否够用，写 `smoke-<ts>.md` commit。任一不过则停。

### 阶段 1 — CTF 全量
1. 生成 `re-protocol-pi.md`（删 §9 shell 白名单条）。
2. 跑 `run-ctf.sh`（19 题串行），跑 `score-anchors.py`。
- **验收**：`ctf-<ts>/` 下 19 个 `<id>.out` 齐全（无 NO-OUT）、`_anchors-*.json` 生成、`记分卡.md` 有每题 recall + 平均 + 结论，已 commit/push。

### 阶段 2 — apk-moded 审计
1. 生成 `audit-system.md`（只读人设 replace）+ `audit-prompt.txt`；跑 `run-audit.sh`（9 App 串行）。
- **验收**：`audit-<ts>/` 下 9 份 `<name>.md` 均含完整四段式（破解点 file:line / 手法 / 调用链台账 / 加固）、无破解产物违规、`审计汇总.md` 已 commit/push。

### 阶段 3 — 与 rev-agent 自身结果对比
1. 用同题库/同 App、同 RE 协议、同 lemonade 后端，取 rev-agent 自己历史或新跑结果，与 pi 结果 A/B。
2. 维度：锚点召回均值、破解点 file:line 命中、幻觉率（谎称无 native/栈不存在等 memory 记录失败模式）、收尾质量、上下文/耗时。
- **验收**：`compare-<ts>.md` 给出 pi vs rev-agent 逐题 Δ 表 + 结论（pi 接 lemonade 值不值得替代/补充 rev-agent），commit/push。

---

## 附录 A — CTF 题库清单（已核实）

19 题覆盖全部 9 App（id | app | workdir 尾段）：

- **bank-crack.json (R1)**：`device-crack-01`(device) · `podcast-crack-01`(podcast) · `battery-crack-01`(battery)
- **bank-crack2.json (R2)**：`easynotes-crack-vip-getter-chain`(easynotes) · `code-crack-01`(code) · `snaptube-crack-pinkiepie-adstub`(snaptube)
- **bank-crack3.json (R3)**：`duolingo-crack-{1-stack-boundary,2-powerup-forced-true,3-max-feature-gate-bypass,4-il2cpp-not-premium}`(duolingo) · `kuwo-crack-{stack,vipstate,bytecode-proof,native-boundary,jsbundle-decoy}`(kuwo，workdir=`酷我音乐-jadx/sources`) · `clone-crack-{01,02,03,04}`(clone)

样例 GT（device-crack-01，题库 `crack_point`/`ground_truth` 字段）：`defpackage/op4.java:71-73` 丢弃 `getBoolean("is_ad_free")` 用 `new kr1(true)` 把 entitlement StateFlow 写死；`op4.l()@489-491` 恒真；`op4.n(boolean)@529-539` 忽略入参强制置真；附 `com/PinkiePie.java` 空方法中和广告（Lucky Patcher 风格）。可作审计输出对照答案。

注意：R1 的 bank-crack.json 条目**无 `chain` 字段**（有 `ground_truth` 但 score-anchors.py 不读它，:52-54 只读 crack_point+chain+grade_keywords）→ R1 锚点只来自 crack_point+grade_keywords，recall 基数偏小属正常（红队第 9 点确认）。

## 附录 B — 关键源码证据索引（pi 0.80.6 @ /Volumes/zhitai-7100/pi-0.80.6；★=本轮亲验）

- registerProvider 字段合并 / provider 名即选模型名：`packages/coding-agent/src/core/model-registry.ts:622-647`
- `--model provider/id[:thinking]` 解析：`src/cli/args.ts:89-90,239`；`src/core/model-resolver.ts:76-118,377,387-420`
- reasoning_content 解析(llama.cpp)：`packages/ai/src/api/openai-completions.ts:364-395`
- ★ **enable_thinking 被 reasoningEffort 门控 + chat_template_kwargs.preserve_thinking:true**：`openai-completions.ts:493,614,616-618`
- thinkingFormat qwen vs qwen-chat-template + `&& model.reasoning`/reasoningEffort 门控：`openai-completions.ts:605-669`
- maxTokensField：`openai-completions.ts:570-576,1230,1267-1293`
- baseUrl 自动补 /chat/completions：`openai-completions.ts:532-537`
- apiKey 字面量透传(无 lemonade env)：`packages/ai/src/env-api-keys.ts:74-106`
- 扩展加载三路径：`src/core/extensions/loader.ts:672-677`；`src/core/config.ts:514-521`；`src/cli/args.ts:149-151`
- 默认工具 read/bash/edit/write；grep/find/ls off：`src/core/sdk.ts:245`；`src/core/agent-session.ts:2536`；`src/core/system-prompt.ts:90`；`src/cli/args.ts:326,386-388`
- ★ **print 模式 text→stdout最终文本 / json→stdout事件流 / 仅 error 走 stderr**：`src/modes/print-mode.ts:104-106,115,135-136,141,150`；`src/cli/args.ts:140-146,244`；`src/main.ts:846`
- agent 循环终止语义（无 maxTurns）：`packages/agent/src/agent-loop.ts:170,174,196-214,271,274`
- 无头 trust 不卡 / --approve：`src/cli/project-trust.ts:22-51`；`src/core/project-trust.ts:46-52,86-88`；`src/core/trust-manager.ts:29-37,184-206`；`src/main.ts:655`；docs `extensions.md:112,353,1016`
- 系统提示注入(值可为文件)：`src/cli/args.ts:93-97,157-159,242`；`src/core/resource-loader.ts:50-65,474-488`；`src/core/system-prompt.ts:48`
- DEFAULT_THINKING_LEVEL=medium：`src/core/defaults.ts:3`
- 已实机验证(离线)：`pi --version`→0.80.6 exit0；`pi -e lemonade.ts --list-models lemonade`→列出模型 exit0
- 判分器：`rev-agent/scripts/score-anchors.py:11,52-54,63,66-68,80-88`
- RE 协议源与 §9 shell 白名单不适用：`rev-agent/docs-resources/LLM首轮注入prompt.md`(§1-§10,239-241,259-291)；`rev-agent/src/prompts.ts:50-84`
- crack 质量原用强模型 rubric：`rev-agent/docs-resources/出题记录-篡改APK破解审计题库理据.md:8-9`
- 外部 issue：#2770(reasoning 门控/思考漏正文)、#3325(preserve_thinking @0.67.67)、#3479(0.68.0 Qwen3.6 跨轮记忆无结论)

---

## 生成说明
本计划由 workflow `pi-agent-lemonade-plan`(9 agents: 3 web调研 + 3 源码落地 + 综合 + 红队 + 定稿, 558k token, 152 tool calls, 0 error) 产出并经主控审读。红队对 pi 源码逐条 file:line 核实，纠正了草稿 2 处成败关键(reasoning 门控 / text 模式观察点)。**执行结果与实测对比见同目录 `pi-agent接入Qwen3.6-实测对比.md`。**
