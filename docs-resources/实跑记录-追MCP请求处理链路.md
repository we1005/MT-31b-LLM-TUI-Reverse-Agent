# 实跑记录：让 rev-agent 追 MT 2.26.5 的 MCP 请求处理链路

> **日期**：2026-07-10
> **目的**：拿 `work/mt-jadx/sources`（MT管理器 2.26.5 现成反编译产物）实跑一条"追 MCP HTTP 请求从进来到被处理的完整调用链路"，验证"怎么给 rev-agent 下逆向任务"并记录真实效果。
> **诚实说明**：这不是一次"一跑就完美"的演示。跑了 3 次，每次暴露一个真问题、修 2 个、诊断出 1 个根本边界。**如实记录全过程，包括没成功的部分——它比粉饰的成功案例更有参考价值。**

---

## 0. 任务与标准答案

**下达的任务**（方式 B，`--once` + `--workdir` 指向预反编译源码）：
> 追出「一个 MCP HTTP 请求从进来到被处理」的完整调用链路：(1) HTTP 请求校验入口(处理 origin/accept/mcp-protocol-version、返回 FORBIDDEN/405) → (2) 按 JSON-RPC method 分派的路由类 → (3) tools/call 委托给哪个工具注册表、如何执行具体 mt_apk_* 工具。每跳给 类.方法+证据行，最后画链路图。

**标准答案**（来自之前审计文档，ground truth）：
```
C7671.mo10786()  HTTP handler：校验 origin/accept/mcp-protocol-version，返回 FORBIDDEN/405
   ↓ 路由
C11960.m27598()  JSON-RPC 路由：按 method 分派 initialize/ping/tools/list/tools/call
   ↓ tools/call 委托 (字段 f39455)
C8897            ToolRegistry：m21694 列工具 / m21695 查并执行
   ↓
AbstractC10122   MCP tool 基类 → C16122(mt_apk_open)/C12662(mt_apk_search)… 8 个具体工具
（旁：C13672 Origin 白名单校验器，C19184 MCP server 主类，ServiceC7545 前台Service 启动入口）
```

---

## 1. 实跑对比

| 次 | 结果 | 根因 | 处置 |
|----|------|------|------|
| **run1** | ❌ 满世界瞎找，烧光预算没找到 | **agent 不知道自己的 workdir** —— 第一步就幻觉 `/tmp/workdir/`，去 `/Users/admin` 乱搜 | 修复 A：workdir 注入 |
| **run2** | ⚠️ 直接定位对了(ServiceC7545/C19184/C8897/C16122)，但 3 步就断链停手 | nudge 盲区："继续看 **C19184**"这种"继续+动词"结尾没被续跑检测覆盖 | 修复 B：扩 nudge 覆盖 |
| **run3** | ⚠️ **完整追对整条链路**(C7671→C11960→C8897→AbstractC10122→C16122→C13672)，但没写出最终链路图 | 探索太投入 budget 冲 217%，最后收尾生成撞 600s 墙钟(exit=124) | 诊断为 D4 残留+小模型长上下文限制，不再调参过拟合 |
| **run4**（2026-07-11，SWA+收尾修复后） | ✅ **完整追对 + 产出正确「## 最终结论」链路图**（跳1-4 全对 + 8 工具类 + 字段名 f25541/f39455/f29843 全对 + 旁路 C13672），exit=0 | run3 的收尾崩溃来自两处：①台账拼进 system 破坏 SWA 前缀→每步全量重算→大上下文收尾极慢撞墙钟；②"追对却漏收尾拼图"无安全网 | 修复 C（SWA 稳定前缀，见 §7）+ 修复 D（收尾安全网 #6）。收尾生成时 prefix-cache 命中 **97%**，不再爆墙钟 |

> **诚实备注**：本地模型 temp>0，单次 run 高度非确定——同一份 run4 代码，有的跑追出 4 跳、有的只 1 跳，但**收尾安全网保证只要台账里有跳就一定拼出 `## 最终结论`**，不再出现"追对了却啥也没交"。这是"稳定下限"的改善，不是"每次都完美"。

---

## 2. run1 根因与修复 A：workdir 对 LLM 是隐形的

**现象**：run1 第一条命令是 `ls /tmp/workdir/`（一个**幻觉的、不存在的**路径），然后一路 `ls /Users/admin`、`find /Users/admin -name "*.java"` 满盘瞎找，80k 预算烧光没找到，最后说"源码可能被移走了"。

**根因**（真设计缺陷）：`run-once.ts` 只 `process.chdir(opts.workdir)` 让**工具的相对路径**生效，但**从没把 workdir 告诉 LLM**。agent 完全不知道自己在哪，只能猜。
> 这也解释了为什么之前 benchmark 11/12 能过——**那些任务描述里都手写了绝对路径**（demo test4 = "在 $JADX/sources 里找…"）。一旦只靠 `--workdir`、任务里不写路径，这个洞就暴露。**`--workdir` 对 LLM 是隐形的。**

**修复 A**（`run-once.ts`）：chdir 后把当前工作目录**显式前缀进任务**：
```
【你的当前工作目录（所有相对路径基于此，反编译源码就在这里，直接用，不要去别处搜索）】
<cwd>
【任务】
<原任务>
```

---

## 3. run2 根因与修复 B：nudge 的续跑检测盲区

**现象**：修复 A 后，run2 第一步 grep 就**直接命中正确的类**（ServiceC7545/C19184/C8897/C16122），走对了路。但只 3 步（budget 17k/80k，21%）就 `done` 了，停在"继续看 **C19184（核心 HTTP server）**"。

**根因**：agent 那句"继续看 X"是典型的"宣布下一步却没做"断链，但 `endsWithContinuationIntent` 的续跑词表只有"让我/接下来/进入阶段"，没覆盖"继续+看/追/查"这类，漏网 → 被判为已完成 → done。

**修复 B**（`agent.ts`）：给续跑检测加 `继续(看|追|查|读|分析|深入|精读|定位…)` + `Step N:`/`阶段N` 步骤标题宣告 + 英文 `let's/continue/keep looking`。单测 7/7（新覆盖命中、实质结论不误伤）。

---

## 4. run3：追对了整条链路，但栽在收尾

**这次 agent 表现其实很好**——工具调用序列证明它**完整、正确地追踪了整条链路**：

```
grep MCP → grep FORBIDDEN|405 → grep origin|accept|MCP-Protocol → grep MCP-Protocol-Version
  → read C7671.java(校验入口 ✓)
  → grep mt_apk_ → read C11960.java(JSON-RPC 路由 ✓)
  → grep "class C8897" → read C8897.java(工具注册表 ✓)
  → grep AbstractC10122|mo4917 → read AbstractC10122.java(tool 基类 ✓)
  → read C16122.java(具体 mt_apk 工具 ✓)
  → grep C13672(Origin 校验器 ✓)
```

**每一跳都命中 ground truth 的正确类**——C7671→C11960→C8897→AbstractC10122→C16122→C13672 全对。作为"静态代码链路追踪"，它的**定位能力完全达标**。

**但没写出最终链路图**，三个机制打架：
1. agent 太投入，一个个类读下去，**budget 冲到 173603/80000 = 217%**；
2. red-gate（预算过红线 3 步后强制收尾）终于触发，注入"立即输出最终链路图"指令；
3. 但此时上下文已巨大（读了 6+ 个类），**本地 35B 生成那段长链路图极慢，撞了 600s 总墙钟 → abort → 重试 2 次仍 abort → exit=124**。

**诚实结论**：这不是"追不出链路"（它追出来了），是"**探索发散(D4 残留) + 小模型在超大上下文下收尾生成慢**"这个组合边界。red-gate 的 maxRedSteps=3 对这种"信息密集、每步都想多读一个类"的任务仍偏松。**这触及"本地 35B + 长上下文"的根本限制，不是再调一个参数能干净解决的**——所以停在诊断，不做第四次调参过拟合。

---

## 5. 结论：能力 vs 边界

| 维度 | 判断 |
|------|------|
| **链路追踪能力** | ✅ 达标。run3 完整、正确地追出 C7671→C11960→C8897→AbstractC10122→C16122→C13672，每跳命中 ground truth |
| **workdir 感知** | ✅ 已修（修复 A）——之前是隐形的，现在显式注入 |
| **断链防护** | ⚠️ 改善（修复 B）——覆盖更多续跑表达，但小模型总能造出新的漏网句式，是持续对抗 |
| **收尾产出** | ⚠️ 边界——信息密集任务下探索发散(budget 217%)+35B 长上下文生成慢，最终链路图没写全。这是本地小模型的根本限制 |

**给用户的实操建议**（从这次教训提炼）：
1. **任务描述里点明起点**（"从 FORBIDDEN/405 校验类开始"），这次 agent 正是靠它一步命中——比让它漫搜强。
2. **信息密集的多跳链路，拆成两条任务**：先"找出链路涉及的所有类"（run3 已能做到），再"读这几个类画链路图"。一次追 6 跳 + 画图，对 35B 偏重，容易在收尾处栽。
3. **用 TUI 而非 --once 做这种探索**：TUI 能看它流式追到哪、在 budget 涨太快时手动喊停让它先总结，避免 --once 的"一口气烧到 217% 撞墙"。

---

## 6. 连带修复（已进代码）
- **修复 A**：`src/runtime/run-once.ts` —— workdir 显式注入任务前缀（agent 不再幻觉路径瞎搜）
- **修复 B**：`src/agent.ts` `endsWithContinuationIntent` —— 续跑检测扩覆盖"继续X/Step N/let's continue"

## 7. SWA 稳定前缀优化（2026-07-11，修复 C，本次最大收获）

**背景**：用户本地 llama.cpp 跑 SWA/滑窗 MoE 模型（Qwen3.6-A3B），KV 缓存只在「本轮 prompt 前缀与上轮逐字节相同」时复用；前缀一变就 `forcing full prompt re-processing`，上下文越长每步越慢（"越聊越卡"）。

**rev-agent 自身的两处违规**（读代码定位）：
1. **首恶**：`callLLM` 把每步都在变的 **ledger 台账拼进 `system`**（prompt 最头部）→ 前缀从第一个 token 就失配 → **每步全量重算**。这正是 run3 收尾在大上下文里撞 600s 墙钟的根因之一。
2. `compactHistory` 原地折叠旧 tool 结果 → 改动历史中段 → 从折叠点起断前缀。

**修复 C**（4 处，`src/agent.ts`）：
- 台账移出 `system` → 每步临时拼到 `messages` 末尾的 ephemeral 消息（**不写回** this.messages）；`system` 恒等于静态 `systemPrompt`。→ `[静态 system + 只追加历史]` 成稳定前缀，每步只重算「新增 + 台账」。
- `compactThreshold`（默认 160k）：ctx 未逼近 256k 上限就**不折叠**，保前缀；只有快撑满才折一次止血。
- `ctxCeiling` 40k→120k：吃满 256k 窗口，不过早强制收尾。
- 新增 per-step **prefix-cache 命中率遥测**（`cachedInputTokens/inputTokens`）。

**客户端实证**（`scratchpad/swa-probe.ts`，串行 4 连发读 `prompt_tokens_details.cached_tokens`）：

| 模式 | cached / prompt | 复用率 |
|------|-----------------|--------|
| 冷启动 | 0 / 2277 | 0% |
| **【新】静态 system + 台账拼末尾** | 2273 / 2340 | **97%** |
| **【新】再追加一跳（前缀仍稳）** | 2273 / 2403 | **95%** |
| **【旧】台账塞进 system（sys 变）** | 0 / 2321 | **0%** |

**端到端**（run4 真实 agent）：每步命中 58%~97%，收尾生成链路图那步 **97%**（对比 run3 收尾撞墙钟）。**0%→97% 前缀复用 = 每步从"重算全部 2300+ token"变成"只算新增几十 token"**。

**修复 D（收尾安全网 #6）**：`agent.ts` no-tool-call 分支——只要 ledger 攒了 ≥1 跳、却从没写「## 最终结论」就想 clean done，用 ledger 的 O(1) `renderChainGraph()` 草稿逼模型补一次收尾。堵 `endsWithContinuationIntent` 的句式漏网（run4 前一版：追出 4 跳但最后一句是陈述句、没判可疑→裸 done、图没画）。

## 关联
- 下指令方式：`如何给rev-agent下达逆向任务-使用指南.md`
- 能力边界：`rev-agent 完整性审查与打包签名能力判断-存档.md`
- ground truth 来源：`MT 2.26.5 MCP 实现深度解析与 LSPatch v6 补漏分析.md`
