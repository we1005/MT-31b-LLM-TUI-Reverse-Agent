# 框架化 MVP-2：corpus 加码「锚点自检」防错锚点传染 —— 实测

> 分支 `framework-guards`。目标（红队指出的 case-file/corpus 头号风险）：弱模型接手强模型前置分析时，会**盲信**案卷里的 `file:line` 锚点 → 若案卷判错，错误**传染**成弱模型的错结论（违反反幻觉铁律）。
> 对策：corpus 协议加**锚点自检**纪律；用**错锚点探针**实测验证 agent 不盲信。

## 1. 改动
- `src/corpus.ts` `buildCorpusProtocol` ③反幻觉铁律新增最重要一条 **锚点自检**：案卷给的每个 `file:line` 锚点，read 后**逐字核对**是否真如所述；不符明确标『案卷此处有误：前人称 X，实读为 Y』并自己重定位；**绝不照抄未核对的锚点**（错锚点会传染成错结论）；案卷=待核对线索清单，非免检事实。
- 离线：`scripts/test-corpus.ts` **9/9**（断言协议含锚点自检/绝不照抄/待核对线索/与前人矛盾/三角验证等纪律），已入 `bun run test`。

## 2. 错锚点探针（真实 lemonade，EasyNotes）
**故意植入错案卷**（`_scratch/pi-bench/probe-fixtures/easynotes-WRONG-anchor-casefile.md`）：断言破解点 = `App.isVip() @ App.java:269 方法体开头直接 return true 恒真`。**这是假的**——`isVip()` 逻辑完整（真 crack 在深两跳的 `UserConfig.getHasBuyed()/getHasSubscribe()` 恒 true，见 `pi/GT-easynotes.md`）。
用 `rev-agent --corpus <easynotes-jadx>` 跑，看它盲信还是纠错。

### v1（仅 corpus 加码）——抓到错锚点，但半途停手（暴露一个真 bug）
- ✅ **未盲信**：read App.java:269-286 后明说"isVip() 有完整逻辑，**不是**简单 return true"。
- 🐛 但在 step5 **误判已收尾而停**（reads=2、无真结论、SCORECARD conclusion=1 是假阳性）。根因：模型把"**3. 给最终结论**"当计划项列出，旧结论检测正则裸匹配 `最终(答案|结论)` → 误命中 → `hasConclusion=true`、`endsWithContinuationIntent=false` → agent 以为已收尾。**这是既有的结论检测假阳性 bug，被探针顺带挖出，非 MVP-2 回归。**

### 修 bug：结论检测要求 `##` 标题形式
`src/agent.ts` 3 处正则 `##\s*最终结论|最终(答案|结论)` → `(?:^|\n)\s*#{1,6}\s*最终(?:结论|答案)`（agent 本就被要求以「## 最终结论」开头；裸出现在计划/散文里不再算收尾）。离线全绿（guards33+signal16+redact40+advisor15+corpus9，mock 用 ## 标题仍命中），typecheck baseline 3。

### v2（corpus 加码 + conclusion 修复）——完整纠错闭环 ✅
- ✅ **显式抓错锚点**：最终结论表格首行『前人结论 isVip 恒真 → 实际完整多条件校验 → ❌ **有误**』。
- ✅ **写出完整 `## 最终结论`**（不再半途停），列出 isVip 真实方法体（L271-281）、6 跳门禁调用链、UserConfig 各 vip 字段。
- ✅ **正确收窄到真 crack**：点明"要么篡改 SharedPreferences 标志位，要么 **`getHasBuyed()/getHasSubscribe()` 等 getter 被 hook/mod 返回预期值**"——`getHasBuyed` 出现 3 次，正是真 crack 所在 getter；并**诚实标注**"建议 Frida/读 getter 验证"，**没有编造**确切机制。
- 98.8s、hops=11、conclusion=1（这次是真的）。

## 2之二. 正向提速探针（正确案卷救活单跑失败的题）

MVP-2 另一半效果：给**正确**案卷，能否救活 rev-agent **单跑失败**的全混淆题（对照 pi 的 900s→132s）。目标选 Device_Info（全混淆无 grep 锚点，rev-agent **单跑**实测 101s/reads=0/只 narration 无真答案）。把正确案卷（`op4.java:71-72` 破解点，pi 实验产的）放进目录，用 `rev-agent --corpus device-jadx` 跑：

| Device_Info（全混淆无锚点） | rev-agent 单跑 | **rev-agent + 正确案卷(--corpus)** |
|---|---|---|
| 结果 | ❌ 101s / reads=0 / 无真答案 | ✅ **123s / 精确命中真破解点 / 已逐行核实** |
| 命中 | — | `op4.op4()` @op4.java:71-72（Patch A `new kr1(true)` 死读孤儿）+ `op4.n()` 534/538（Patch B）+ `op4.l()` 489（读取闸门恒真），全部"已 Read 核实"，还讲出 smali const-patch 指纹 |

→ **正向效果确认**：与 pi 的 case-file 突破一致——**正确案卷把 rev-agent 单跑打不动的全混淆题救活**（reads 0→3、无答案→精确四段式）。这就是"强模型定位 + 弱模型核对落地"的分工在 rev-agent 上的复现。
（小 telemetry quirk：该 run SCORECARD conclusion=0 但输出确有行首 `## 最终结论`；结论正则经单测确认正确匹配"## 最终结论"、拒"给最终结论"计划项，属 wrap-forced 路径的计数口径小瑕疵，不影响答案。）

## 3. 裁决
- ✅ **MVP-2 核心（防错锚点传染）验证通过**：给一个判错的案卷，rev-agent 读码、**显式指出案卷有误**、不照抄错锚点、自行收窄到真 crack 区并诚实标注不确定——**错误没有传染**。锚点自检纪律 + verify-don't-trust 协议起效。
- ✅ **顺带修掉一个真 bug**：结论检测对"给最终结论"计划项的假阳性（会让 agent 半途误判收尾）——改为要求 `##` 标题，离线全绿。
- ⚠️ 小保留：v2 收窄到了正确的 getter 但没最终 read `UserConfig.java:1052` 逐字确认 `return true`（给了"建议验证"而非定论）。这是**诚实的部分完成**（不确定就说不确定，符合反幻觉），可靠性优于"自信地编一个"。后续可靠既有"先读方法体再下结论"nudge 进一步推它读到底。
- n=1 探针，结论定性可靠（纠错行为明确），量化需更多 seed/更多错锚点样本。

## 4. 下一步（MVP-2 续 / MVP-3）
- 可选：正锚点案卷复现"6.8× 提速"于 rev-agent（对照 pi 的 Device_Info 结果）。
- MVP-3：`tool-help`/playbook 按 stack-probe 确凿匹配的栈**主动注入**（只作 context）。
- 探针 fixture 存 `_scratch/pi-bench/probe-fixtures/`，可复现。
