# pi-agent × 本地 Qwen3.6 实验复现手册（手动可复现，含所有 verbatim 提示词）

> 目的：把本轮所有实验（接入 / 中难度基准 / apk 破解审计 / **前置强模型案卷→pi 续跑**）做到**手动逐条可复现**。所有命令、系统提示、给强模型的提示、任务文本、判分方式均逐字记录。
> 结论文档见 `pi-agent接入Qwen3.6-{计划,实测对比}.md`；可复现产物在 `rev-agent/pi/`。
> 铁律：**lemonade 单并发**，任何时刻只能有一个 agent 打它，全部实验串行；跑前 `pgrep -fl 'coding-agent/dist/cli.js|bun.*src/index.tsx'` 确认无占用。

---

## 0. 环境与路径（写死的事实）

| 项 | 值 |
|---|---|
| pi 源码 | `/Volumes/zhitai-7100/pi-0.80.6/`（@earendil-works/pi-coding-agent v0.80.6，monorepo） |
| pi CLI | `node /Volumes/zhitai-7100/pi-0.80.6/packages/coding-agent/dist/cli.js` |
| lemonade | `http://192.168.9.101:13305/api/v1`，apiKey 任意串，模型 id `Huihui-Qwen3.6-35B-A3B-abliterated-ggml` |
| rev-agent | `/Volumes/zhitai-7100/reverse-agent/rev-agent`（`bun src/index.tsx`） |
| 逆向产物 | `work/mt-jadx`（CTF 中难度）、`apk-moded/<name>-jadx/`（9 个破解 App） |
| 可复现产物 | `rev-agent/pi/`（provider 扩展 / 两版系统提示 / runner / 案卷样例 / 前置分析 workflow 脚本 / GT） |
| 会话日志 | `~/.pi/agent/sessions/<编码后的cwd>/*.jsonl`（含 usage/toolCall） |

node v24 / npm 11 / bun 1.3。

---

## 1. 一次性接入（建一次，永久用）

```bash
cd /Volumes/zhitai-7100/pi-0.80.6
npm ci --ignore-scripts        # 装依赖(pi 安全规矩:不跑 lifecycle 脚本)
npm run build                  # 构建 5 个 TS 包(几分钟);产出 packages/coding-agent/dist/cli.js
```

provider 扩展 = `rev-agent/pi/lemonade-provider.ts`（放 pi 仓库根，用 `-e` 加载）。核心：
```ts
pi.registerProvider("lemonade", {
  name: "Lemonade (local Qwen3.6-35B)",
  baseUrl: "http://192.168.9.101:13305/api/v1", apiKey: "lemonade", api: "openai-completions",
  models: [{ id: "Huihui-Qwen3.6-35B-A3B-abliterated-ggml", name: "Qwen3.6-35B-A3B (lemonade)",
    reasoning: true, input: ["text"], cost: {input:0,output:0,cacheRead:0,cacheWrite:0},
    contextWindow: 262144, maxTokens: 8192,
    compat: { thinkingFormat: "qwen-chat-template", maxTokensField: "max_tokens", supportsReasoningEffort: true } }],
});
```

冒烟（确认接入 + 无头 tool 循环 + reasoning 通）：
```bash
cp rev-agent/pi/lemonade-provider.ts /Volumes/zhitai-7100/pi-0.80.6/lemonade-provider.ts
cd /Volumes/zhitai-7100/pi-0.80.6
node packages/coding-agent/dist/cli.js -e ./lemonade-provider.ts --list-models   # 应见 lemonade/Qwen3.6
# 建个含"SECRET_FLAG"的小目录，让它 read 后作答，验证 -p 自主 tool 循环
```

---

## 2. 实验 A：中难度定点定位（mt-jadx MCP 入口，已知 GT）

**GT**：`l/C19184.java`(入口/注册工具) `l/C11960.java`(JSON-RPC 路由) `l/ServiceC7545.java`(Service 启动器)。判分锚点 `C19184|C11960|ServiceC7545`。

**任务文本 T_medium**（三次跑都用同一句）：
```
在当前(工作)目录的反编译产物里，找出 MT 管理器 2.26.5 的 MCP server 入口类（真正实例化并注册工具的那个）。给出相对路径 + 类名，并说明它与 JSON-RPC 路由类、Android Service 启动器的关系。必须实际 read_file 确认。
```

**A1 · pi 默认提示**（结果：超时空答）：
```bash
cd /Volumes/zhitai-7100/reverse-agent/work/mt-jadx
node /Volumes/zhitai-7100/pi-0.80.6/packages/coding-agent/dist/cli.js \
  -e /Volumes/zhitai-7100/pi-0.80.6/lemonade-provider.ts \
  --model lemonade/Huihui-Qwen3.6-35B-A3B-abliterated-ggml \
  --tools read,grep,find,ls,bash --mode text \
  -p "<T_medium>"
```

**A2 · pi + RE 纪律**（结果：命中全部 GT）：在 A1 基础上加 `--append-system-prompt "$(cat rev-agent/pi/re-discipline.txt)"`。
> `re-discipline.txt` 全文见 `rev-agent/pi/re-discipline.txt`（核心：grep 先行、≤200 行 read、拿到 file:line 就收尾、别 bash 乱翻、~12 次工具内收尾）。

**A3 · rev-agent 头对头**（同题同模型）：
```bash
cd /Volumes/zhitai-7100/reverse-agent/rev-agent
bun src/index.tsx --once "<T_medium>" --workdir /Volumes/zhitai-7100/reverse-agent/work/mt-jadx \
  --backend lemonade --auto-approve --budget 80000
```

用 `rev-agent/pi/run-pi.sh <id> <workdir> <tools> <timeout_s> <sysprompt|-> [append|replace] <<< "<task>"` 可自动抓指标（耗时/tokens/工具分布，解析 session.jsonl）。

---

## 3. 实验 B：apk-moded 只读破解审计（pi vs rev-agent）

**合规**：只读；工具集 `read,grep,find,ls`（**不给 bash/edit/write**，物理只读）；系统提示用 **replace**（整体替换 pi 默认 coding 人设，防"给 patch"诱导）。审计系统提示 = `rev-agent/pi/audit-sysprompt.txt`（四段式输出：破解点/手法/调用链/加固）。

**任务文本 T_audit**（以 EasyNotes 为例，换 App 改名即可）：
```
审计这个被破解的 EasyNotes VIP mod 版：它是如何绕过原版的 VIP/会员校验解锁功能的？给出四段式结论（破解点 类.方法+行号 / 破解手法 / 调用链 / 修复加固）。只读分析。
```

**B1 · pi 审计**：
```bash
cd /Volumes/zhitai-7100/reverse-agent/apk-moded/easynotes-jadx
node /Volumes/zhitai-7100/pi-0.80.6/packages/coding-agent/dist/cli.js \
  -e /Volumes/zhitai-7100/pi-0.80.6/lemonade-provider.ts \
  --model lemonade/Huihui-Qwen3.6-35B-A3B-abliterated-ggml \
  --tools read,grep,find,ls --mode text \
  --system-prompt "$(cat /Volumes/zhitai-7100/reverse-agent/rev-agent/pi/audit-sysprompt.txt)" \
  -p "<T_audit>"
```

**B2 · rev-agent 审计**：`bun src/index.tsx --once "<T_audit>" --workdir <app>-jadx --backend lemonade --auto-approve --budget 80000`。

> 结果：**EasyNotes（isVip 可 grep，crack 深两跳在 `UserConfig.getHasBuyed/getHasSubscribe` 恒 true）→ pi 精确命中；rev-agent 守卫提前掐停(reads=0)判错机制。Device_Info（全混淆）→ pi 单跑超时空答（见实验 C 用案卷破解）。** GT 建立方式：手动 grep+read（如 EasyNotes 见 `pi/GT-easynotes.md`）。

---

## 4. ⭐ 实验 C：前置强模型案卷 → pi 续跑（突破 pi 单跑上限）

三步：**强模型前置分析 → 产出 case-file → pi 只读核对续跑**。

### 4.1 第一步：强模型前置分析（给强模型的提示词——**可手动粘贴给任意云端强模型**）

我用的是 Claude 多 agent workflow（脚本 `rev-agent/pi/frontanalysis-workflow.js`），但**手动复现只需把下面提示逐字发给一个强模型**（Claude/GPT/…，让它能读 `apk-moded/device-jadx/sources` 下文件）。

**公共上下文 CTX（每条搜索都带）**：
```
目标:Device Info Premium(包 com.ytheekshana.deviceinfo)的**被破解 mod 版**,反编译源码在 /Volumes/zhitai-7100/reverse-agent/apk-moded/device-jadx/sources。主包类名清晰(App/DonateActivity/SettingsActivity...),但付费/pro 判定藏在混淆的 defpackage/ 里(lh2/y60/gn1/l04/p62/w60 等匹配过 billing/purchase)。Device Info Pro 用"donate/pro"解锁(去广告+解锁 sensor/export 等)。任务:定位 mod 版是如何绕过 pro 校验的(哪处方法被 patch 成恒真/校验被短路/billing 结果被伪造)。只读分析,给 file:line 证据。
```

**4 路搜索角度（并行，各自 = CTX + 下面一条 + "用 Read/Grep/Glob 实际读文件，只报真读到的 file:line 标 confidence，找不到诚实说")**：
1. `consume`：搜"pro 状态在哪被消费/判定":grep 去广告、解锁功能、DonateActivity、SettingsActivity 里 if 判某 boolean 决定是否 pro 的地方,反查那个 boolean 来自哪个方法/字段。给 file:line。
2. `billing`：精读匹配过 billing/purchase 的 defpackage 类(lh2/y60/gn1/l04/p62/w60 等):找 BillingClient purchase 校验、queryPurchases、isPurchased/onPurchasesUpdated 被 stub 或恒真的地方。给 file:line。
3. `const-true`：搜典型 mod 特征:方法体先读 prefs/billing 结果却丢弃、然后无条件 return true/return 1;或 signature/license 校验被删被短路;或某 static boolean pro 字段被初始化成 true。全 sources 找。给 file:line。
4. `ads-gate`：搜广告门禁(Device Info Pro 主要卖点=去广告):grep AdView/MobileAds/isAdsRemoved/shouldShowAd,看去广告是不是靠同一个 pro 布尔,反查该布尔的赋值/判定点(mod 常在这恒真)。给 file:line。

**案卷综合提示（把 4 路结果喂给强模型，产出 case-file）**：
```
综合下列并行搜索结果,产出一份**给本地弱模型(pi+Qwen3.6)续分析用的 case-file**(markdown)。它自己单跑这题会因"混淆无 grep 锚点"而超时空答;你的 case-file 要把它缺的"锚点"补上。

<CTX>

【搜索结果】<4 路结果>

case_markdown 必须含:
1. **最可能的破解点**(类.方法 + file:line, 按置信度排序)。
2. **去混淆映射**:defpackage 短名 → 它实际是什么(billing helper / pro 判定 / 广告控制)。
3. **调用链假设**:从功能/UI 到破解点的链(带 file:line)。
4. **给 pi 的待验证清单**:让 pi 去 read 哪几个具体文件的哪几行来"确认"破解点(把它从"搜索"降级为"核对"——这是弱模型能做的)。
诚实:没定位到就说明"未定位到确切点,只给候选方向",不编造 file:line。
```
> 产出的案卷样例见 `rev-agent/pi/example-casefile-device.md`（本次强模型定位到 `op4.op4(Context)` @ `defpackage/op4.java:71-72`：弃读 `getBoolean("is_ad_free",false)` 后硬编码 `new kr1(true)`，含 VP1–VP6 待核对清单）。
> 若用 Claude Code workflow 复现：`Workflow({scriptPath:"rev-agent/pi/frontanalysis-workflow.js"})`（把脚本里的 ROOT 改成目标 App）。

### 4.2 第二步：把案卷存到 App 目录

```bash
# 把强模型产出的 case_markdown 存成 CASE-FILE.md
cp rev-agent/pi/example-casefile-device.md /Volumes/zhitai-7100/reverse-agent/apk-moded/device-jadx/CASE-FILE.md
```

### 4.3 第三步：pi 只读核对续跑（给 pi 的 handoff 提示词）

```bash
cd /Volumes/zhitai-7100/reverse-agent/apk-moded/device-jadx
CF=$(cat CASE-FILE.md)
node /Volumes/zhitai-7100/pi-0.80.6/packages/coding-agent/dist/cli.js \
  -e /Volumes/zhitai-7100/pi-0.80.6/lemonade-provider.ts \
  --model lemonade/Huihui-Qwen3.6-35B-A3B-abliterated-ggml \
  --tools read,grep,find,ls --mode text \
  --system-prompt "$(cat /Volumes/zhitai-7100/reverse-agent/rev-agent/pi/audit-sysprompt.txt)" \
  -p "前人(更强的模型)已对本 mod 做了前置分析，案卷如下。请**只读核对**案卷里的 VP1–VP6 清单(实际 read 那几个 file:line 确认字面量)，确认无误后输出四段式审计结论(破解点/手法/调用链/修复加固)。若核对发现案卷有误，如实指出。

===== 前置分析案卷 =====
$CF"
```

> **结果**：Device_Info 从"pi 单跑 900s 超时空答"→"pi+案卷 132s / 13.5k token / 14 工具(全 read 0 grep) 正确四段式审计"。机制：案卷把"无锚点搜索"(pi 死穴)降级成"照 file:line 核对"(pi 强项)。
> **注意**：prompt 明确要求"核对发现有误如实指出"——防止案卷判错时 pi 盲信传染幻觉。

---

## 5. 判分与指标

**确定性锚点判分**（CTF/审计通用）：
```bash
# bank.json 里每题带 ground_truth/evidence 或 crack_point/chain/grade_keywords；把 pi/rev-agent 输出存成 <id>.out
python3 /Volumes/zhitai-7100/reverse-agent/rev-agent/scripts/score-anchors.py <bank.json> <results_dir>
# 输出 _anchors.json：各题 GT 锚点(file:line + 类/方法) 在 .out 里的召回率
```

**从 pi 会话抽指标**（tokens/工具/轮数）：
```bash
SF=$(ls -t ~/.pi/agent/sessions/<编码cwd>/*.jsonl | head -1)   # 编码cwd = 绝对路径把 / 换成 -,前后加 --
# 逐行 message.usage.totalTokens/reasoning/cacheRead;content[].type=="toolCall" 的 name 计工具分布
```
（`run-pi.sh` 已封装此解析，产 `<id>.meta`。）

**rev-agent 指标**：stderr 里的 `[SCORECARD] steps=.. ledger(hops/reads/greps) ... forced=.. conclusion=..` 一行 + `✓ done (steps=.. budget=输出token)`。

---

## 6. 复现一个完整对比矩阵的顺序（串行！）

```
1) 一次性 setup(§1)  2) A1→A2→A3(§2 中难度三跑)
3) B1→B2(§3 每个 App 审计 pi vs rev-agent)
4) C(§4 强模型案卷→pi 续跑,专攻 B 里 pi 单跑失败的混淆 App)
每步跑前确认 lemonade 空闲;绝不并行。
```

产物落 `results/`（`<id>.out/.err/.meta`），结论汇总进 `pi-agent接入Qwen3.6-实测对比.md`。
