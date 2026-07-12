# pi-agent × 本地 Qwen3.6(lemonade) 实测：如何驱动 · 表现 · 与 rev-agent 对比

> 目标：把本地 Qwen3.6-35B(lemonade) 接入 pi-agent，驱动它跑逆向题（中/高难度），实测表现、找本地模型+pi 的上限、定「最佳设置」，并与自研 rev-agent 头对头对比。
> 配套：接入计划见同目录 `pi-agent接入Qwen3.6-计划.md`（9-agent workflow + 红队定稿）。
> 实测日期：2026-07-12。模型/后端：`lemonade http://192.168.9.101:13305/api/v1` 上的 `Huihui-Qwen3.6-35B-A3B-abliterated-ggml`（两边同一模型、同一后端、同一天）。铁律：lemonade 单并发，所有跑批严格串行。

---

## 1. 怎么驱动的？—— 不是 TUI 对话，是无头 CLI `-p`

pi 支持交互式 TUI，但**基准测试用的是无头单发模式 `pi -p`**（`--print`：处理完 prompt 跑完 agent 循环即退出，源码 `print-mode.ts`）。TUI 适合人机对话，脚本化批量评测必须用 `-p`。三条驱动方式对比：

| 方式 | 适用 | 本次是否用 |
|---|---|---|
| TUI 交互 | 人一句句对话、盯着看 | 否（不可脚本化批量） |
| **`pi -p "<任务>"` 无头单发** | 脚本化跑题、串行批量、抓指标 | ✅ **主用** |
| `--mode json` 事件流 | 需要解析思考流/工具流/token | ✅ 抓指标时用 |
| RPC/orchestrator | 编程式长驻驱动 | 否（本次不需要） |

**关键：pi `-p` 会自主跑完多轮 tool 循环**（LLM→toolCall→执行→回灌，直到给结论或超时），这点已实测确认（下方冒烟）——不是只回一轮。

### 1.1 接入：自定义 provider 扩展（不改 pi 源码）

lemonade 是 OpenAI 兼容端点，pi-ai 的 `openai-completions` 原生解析 Qwen 的 `reasoning_content`（注释点名 llama.cpp）。用 `registerProvider` 扩展即可，文件 `/Volumes/zhitai-7100/pi-0.80.6/lemonade-provider.ts`：

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.registerProvider("lemonade", {
    name: "Lemonade (local Qwen3.6-35B)",
    baseUrl: "http://192.168.9.101:13305/api/v1",
    apiKey: "lemonade",              // 任意非空串
    api: "openai-completions",
    models: [{
      id: "Huihui-Qwen3.6-35B-A3B-abliterated-ggml",
      name: "Qwen3.6-35B-A3B (lemonade)",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 8192,
      compat: {
        thinkingFormat: "qwen-chat-template", // 本地 llama.cpp 正确格式；"qwen"(顶层 enable_thinking)会被静默忽略
        maxTokensField: "max_tokens",
        supportsReasoningEffort: true,
      },
    }],
  });
}
```

### 1.2 用到的启动命令（逐字记录）

冒烟 + 列模型（确认接入成功）：
```bash
cd /Volumes/zhitai-7100/pi-0.80.6
node packages/coding-agent/dist/cli.js -e ./lemonade-provider.ts --list-models
# → lemonade  Huihui-Qwen3.6-35B-A3B-abliterated-ggml  262.1K  8.2K  reasoning=yes
```

无头跑一道题（text 模式，最终答案进 stdout）：
```bash
cd <目标工作目录，如 work/mt-jadx>
node /Volumes/zhitai-7100/pi-0.80.6/packages/coding-agent/dist/cli.js \
  -e /Volumes/zhitai-7100/pi-0.80.6/lemonade-provider.ts \
  --model lemonade/Huihui-Qwen3.6-35B-A3B-abliterated-ggml \
  --tools read,grep,find,ls,bash \        # CTF 分析题；apk 审计去掉 bash（只读合规）
  --mode text \
  --append-system-prompt "$(cat re-discipline.txt)" \   # 见 §4：RE 纪律是最关键设置
  -p "<任务文本>"
```

apk-moded 只读防御审计（工具去 bash/edit/write；系统提示整体 replace）：
```bash
node .../cli.js -e .../lemonade-provider.ts \
  --model lemonade/Huihui-Qwen3.6-35B-A3B-abliterated-ggml \
  --tools read,grep,find,ls \             # 物理只读：无 edit/write/bash
  --system-prompt "$(cat audit-sysprompt.txt)" \  # 整体替换默认 coding 人设(防"给patch"诱导)
  -p "<审计任务>"
```

指标抓取：pi 每次运行自动存会话到 `~/.pi/agent/sessions/<编码后的cwd>/*.jsonl`，逐行 `message` 事件含 `usage{totalTokens,output,reasoning,cacheRead}` 与 `content[].type=="toolCall"`（工具名/参数），据此统计工具分布、token、轮数。

---

## 2. Qwen 推理链是否正常经 pi？—— 是

`--mode json` 事件流里出现 `{"type":"thinking",...,"thinkingSignature":"reasoning_content"}` + `"provider":"lemonade"`，证明 Qwen 的 `reasoning_content` 被 pi-ai 正常解析成 thinking。注意：**text `-p` 模式最终答案只进 stdout、思考流不进 stderr**，要看思考必须用 `--mode json`（红队踩坑点）。

---

## 3. 中难度题实测 + rev-agent 头对头

**题目（medium，已知 GT）**：在 mt-jadx（MT 管理器 2.26.5，13 万 java 文件）里找 MCP server 入口类。GT = `l/C19184.java`(入口，注册工具) / `l/C11960.java`(JSON-RPC 路由) / `l/ServiceC7545.java`(Service 启动器)。此题 11 模型 benchmark 用过，可锚点判分。

| 配置 | 结果 | 命中 GT | 工具调用 | 墙钟 | token |
|---|---|---|---|---|---|
| **pi + 默认 coding 提示** | ❌ **超时无答案** | — | 27（13×bash 乱翻） | 701s（被 kill） | 58.6k(总) |
| **pi + RE 纪律提示** | ✅ 命中全部 3 个 GT + 枚举 10 个工具类 | C19184/C11960/ServiceC7545 | 18（grep6/read10/ls2，规矩） | 402s | 42.7k(总) |
| **rev-agent（同模型同题）** | ✅ C19184/ServiceC7545/C7671（pass） | C19184/ServiceC7545 | **4**（read2/grep1） | **113s** | **3.5k(仅输出)** |

> token 口径不同：pi 的 totalTokens 含 prefill+cache（输入侧），rev-agent 的 budget 仅计输出 token；不可直接相减。可比的是**墙钟**与**工具调用数**。

**读出来的东西：**
1. **pi 默认提示在大反编译树上会超时空转**：默认 coding 人设无「grep 先行 / ≤200 行 / 拿到答案就收尾」纪律，27 次工具里 13 次是 bash 乱 ls/find，700s 没收敛。
2. **注入 RE 纪律是决定性设置**：同题从「超时无答案」翻转成「命中全部 GT + 更深覆盖」，工具从 27(bash 重)→18(grep/read 规矩)，token 58.6k→42.7k。
3. **rev-agent 明显更高效**（3.5x 快、4x 少工具、输出 token 极省）：4 次工具 113s 拿到核心答案——协议、止损守卫、O(1) 台账是「焊死」在框架里的，比给 pi 临时塞 prompt 更紧。
4. **但 pi+RE 覆盖更广**：命中了 rev-agent 本次没强调的 C11960，并完整枚举了 10 个 MCP 工具类。即「给足纪律，pi+通用 agent 能挖得更宽，但代价是更慢更贵」。

---

## 4. 最佳设置（本地模型 + pi）—— 实测结论

| 设置 | 取值 | 依据 |
|---|---|---|
| **系统提示** | **必须注入 RE 纪律**（grep 先行 / ≤200 行 read / 拿到 file:line 证据即收尾 / 别 bash 乱翻）；审计题用 `--system-prompt` 整体替换默认 coding 人设 | §3 实测：默认提示超时，注入后翻转成功——**单项影响最大** |
| **thinkingFormat** | `qwen-chat-template`（本地 llama.cpp 正确请求侧格式） | 源码核实；`qwen`(顶层 enable_thinking) 会被静默忽略 |
| **thinking 门控** | `reasoning:true` + `-p` 默认 medium 会透传成 reasoningEffort→开思考（实测 json 流见 thinking） | openai-completions.ts:614 |
| **工具集** | 分析题 `read,grep,find,ls,bash`；**apk 审计 `read,grep,find,ls`（去 bash/edit/write=物理只读，合规）** | 红队；jadx 已反编，审计不需 bash |
| **输出模式** | 抓指标/看思考用 `--mode json`；只要最终答案用 `--mode text` | print-mode.ts |
| **超时** | 大树题给足（700–900s）；lemonade 单并发→**串行**，绝不并行起多个 pi | 铁律 |
| **扩展加载** | `-e ./lemonade-provider.ts`（快速）或放 `.pi/extensions/`（需 trust；无头下 trust 静默拒绝不阻塞） | project-trust.ts |

---

## 5. 高难度题（apk-moded 破解审计，只读防御）+ rev-agent 头对头

用真实的被破解 mod App 做只读防御审计，两个难度层，两 agent 同题同模型同天：

### 5.1 高难度·有锚点多跳（EasyNotes VIP mod，25852 java）

破解不在 `isVip()` 本身（它逻辑完整），而在**深两跳**的配置 getter。人工核实 GT：`UserConfig.getHasBuyed()`(UserConfig.java:1052-1054) 与 `getHasSubscribe()`(:1158-1160) 被 patch 成无条件 `return true`（仍调 prefs 但丢弃结果）；链路 = 功能点 → `App.isVip()`(App.java:277) → 这两个 getter。

| Agent | 结果 | 工具 | 墙钟 | 关键 |
|---|---|---|---|---|
| **pi + RE 纪律** | ✅ **精确命中真破解点** | 22（grep7/read15） | 207s | 跟到 UserConfig 两个 getter 的 `return true`，四段式全，加固建议到位，还发现 `isGoogleVip()` 复用同 getter |
| **rev-agent** | ⚠️ **入口对、机制错** | 8步（grep4/**read0**） | 144s | 只 grep 到 `App.isVip()` 是门禁 + 画了调用点，但**止损守卫在 step8 提前触发**(stall=1/forced=1)，**一个文件都没 read**(reads=0) 就收尾，猜成"isVip 硬编码 true"——而 isVip 其实完整，真 patch 在深两跳的 getter，它没跟到 |

**这是对中难度结论的反转**：中难度定点定位 rev-agent 更快更省，但**高难度深多跳里 pi 赢得干净**——pi 肯往下读（15 次 read）跟到真破解点，rev-agent 的抗空转守卫反而把它在 reads=0 时就掐停、逼出一个"看起来自信但没读证据、且机制判错"的答案。

### 5.2 高难度·无锚点全混淆（Device_Info Premium mod，7638 java）

破解点在混淆类（`defpackage/a,b,c…`）里，`grep premium/isPro/isVip` 全落空。

| Agent | 结果 | 工具 | 墙钟 |
|---|---|---|---|
| **pi + 审计 prompt** | ❌ **超时空答** | 47（grep30/read10） | 900s（被 kill，0 输出） |
| **rev-agent** | ⚠️ 快速失败、无实质答案 | 9步（grep4/read0） | 101s（stall+forced 触发，只narration） |

**两者都没做出真答案**——`grep premium` 在全混淆包里找不到锚点，谁都没读到真 patch。差异只在**失败姿势**：pi 死磕到 900s 墙钟、烧 66k token、0 产出；rev-agent 的止损守卫 101s 就优雅退出（但同样没答案，且 conclusion=1 是"输出最终结论"指令文本触发的假阳性）。→ **这是模型能力上限**（本地 35B + keyword-grep 在全混淆目标上打不动），不是 harness 的锅。

### 5.3 本地模型 + pi 的上限（实测标定）

- ✅ **能做**：定点定位（中难度）、**有 grep 锚点的深多跳破解审计**（EasyNotes：isVip 锚点 → 跟两跳到 UserConfig getter，精确命中）。这已经相当强——一个本地 35B 靠 pi 做出了带 file:line 证据的完整破解审计 + 加固方案。
- ❌ **打不动**：**无 grep 锚点/全混淆**的破解定位（Device_Info：类名全混淆、keyword 搜索归零）。此为**模型层上限**（rev-agent 同题也失败）。
- ⚠️ **pi 特有风险**：`-p` **无止损/预算/强制收尾**——一旦任务超出能力，会死磕到外层 timeout 且**0 产出**（Device_Info 900s 空答）。必须外挂 wall-clock timeout；理想是补一个"到点强制拿已读证据收尾"的守卫（正是 rev-agent 的看家机制）。

---

## 6. 最终总结与分工建议

**一句话**：给足 RE 纪律提示后，**本地 Qwen3.6 + pi 是一个相当能打的逆向 agent**——能独立做出有锚点的深多跳破解审计（EasyNotes 精确命中）；但它没有止损网，遇到超能力的目标会死磕到超时空答，且默认提示下必然超时。

**pi+本地模型 vs rev-agent（同模型）分工**：

| 维度 | pi + Qwen3.6（best settings） | rev-agent + Qwen3.6 |
|---|---|---|
| 定点定位（找某类/入口） | 能做但慢（402s/18工具） | **更快更省**（113s/4工具）——协议+台账焊死 |
| 深多跳破解审计（有锚点） | **更强**：肯深读、跟到真破解点 | 守卫易提前掐停→浅答/错判（EasyNotes reads=0 猜错） |
| 超能力目标（全混淆） | 死磕超时、**0 产出**（危险） | 快速失败、**总有兜底答案**（但也非真解） |
| 鲁棒性/永不挂 | 差（无止损，靠外层 timeout） | **强**（stall/budget/forced-finish 永远收尾） |
| 接入本地模型成本 | 低（一个 provider 扩展，见 §1） | 本就是本地优先自研 |
| 合规只读强制 | 强（`-t read,grep,find,ls` 物理只读） | 强（--once 默认拒 write） |

**建议**：
1. **要深挖破解审计** → 用 **pi + RE 纪律提示 + 外层 timeout**（它肯读、能跟深链），但务必包一层墙钟兜底防空答。
2. **要快速定点 / 要永不挂的稳定产出** → 用 **rev-agent**（协议+止损焊死，快且总有答案），代价是深多跳时可能被守卫掐浅。
3. **理想形态** = pi 的"肯深读"韧性 + rev-agent 的"到点强制收尾"守卫。rev-agent 的 stall/forced-finish 是双刃剑：给了鲁棒性，但会切断合理的深调查（EasyNotes 就吃了这亏）——值得据此回看 rev-agent 的 stallCap 是否在"有进展的深读"场景下过于激进。
4. **本地 35B 的硬上限**：全混淆无锚点的破解定位，两个 harness 都打不动——这是模型 + keyword-grep 策略的天花板，需要更强模型或动态分析（frida）才能破。

> ⚠️ 合规：全程只读逆向，apk-moded 审计用 `-t read,grep,find,ls` 物理排除 edit/write/bash，产出为**给原开发者的防御加固建议**，不产破解步骤、不改 APK。
