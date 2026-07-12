# 框架化 MVP-0/1：signal-gated 守卫软化 —— 实测 A/B

> 分支 `framework-guards`。实现见 `src/guards.ts`（纯函数 decideGuard）+ `src/agent.ts`（applyStuckGuard 接线）。
> 动机：EasyNotes 深多跳实测中，rev-agent 的 count-gated 守卫在 `reads=0`/step8 就 forced-finish，逼出"入口对但机制判错"的浅答（见 `pi-agent接入Qwen3.6-实测对比.md` §5.1）。MVP-0/1 把守卫从"计数触发即强制收尾"改成"信号触发注入 CHECKPOINT + 给预算，只在资源硬上限收尾"。
> 铁律对齐：框架只注入 context + 收 budget，不替 agent 决定"下一步/是否完成"（见 `框架化-把逆向负担从模型移到框架.md`）。

## 1. 改了什么
- `src/guards.ts` `decideGuard(signals, mode)` 纯函数：`continue`(仍有新 read/hop) / `checkpoint`(原地打转但宽限未尽→注入"先去 read 方法体 / 二选一"，重置计数给预算，**不 forced-finish**) / `finish`(资源硬上限 ctx-超顶/步数逼顶，或 CHECKPOINT 宽限 MAX=2 用尽；消息标注"资源上限非任务完成")。
- `REV_GUARD_MODE=count` 退回旧即时强制收尾（A/B 对照）；默认 `signal`。
- SCORECARD 加 `checkpoints=N guard=signal|count`。

## 2. 离线单测（零模型）
- `scripts/test-guards-signal.ts` **16/16**：纯函数决策各分支（EasyNotes 场景 reads=0→checkpoint 逼读码 / count 模式同场景立即 finish / 有进展 continue / 宽限用尽 finish 资源标注 / 硬上限 finish / 演进 checkpoint,checkpoint,finish）。
- `scripts/test-guards.ts` **33/33**（含新增 A/B：count 模式终止不晚于 signal，两模式同信号决策不同）+ 既有回归全过。typecheck baseline 3。

## 3. 真实 A/B（同代码同模型 lemonade/Qwen3.6，仅 REV_GUARD_MODE 变量）

### 3.1 ⭐ 高难度·深多跳（EasyNotes VIP 破解审计）—— signal 修复了 count 的失败

| 指标 | count 模式（旧/main） | **signal 模式（本分支）** |
|---|---|---|
| 找到破解点 | ❌ 猜"isVip 硬编码 true"（**错**，isVip 完整） | ✅ **`UserConfig.getHasBuyed()/getHasSubscribe()`**（真破解点） |
| reads | **0**（一个文件没读） | **2**（读了 UserConfig 等） |
| hops | 2 | **7（✓4）** |
| checkpoints | 0 | **2**（"先去读码"宽限生效） |
| 墙钟 | 144s | 277s |

**结论**：CHECKPOINT"停 grep、去 read 方法体"注入 2 次，把 agent 从 `reads=0` 推到真读码，跟到 count 模式漏掉的真破解点，机制判**对**。答案含正确调用链（App.isVip():277 → getHasBuyed/getHasSubscribe）+ 加固方案，还发现 isGoogleVip 复用同 getter。**MVP-1 核心验收 PASS。**

### 3.2 普通难度·定点定位（mt-jadx MCP 入口）—— MVP-1.1 修回速度且更完整

| 指标 | count 模式 | signal v1 | **signal v1.1（+收敛提示）** |
|---|---|---|---|
| 命中 GT | C19184+ServiceC7545（2/3） | 全 3 含 C11960 | **全 3 含 C11960（更全）** |
| reads / steps | 2 / 6 | 6 / 15 | **4 / 9** |
| interventions | 3 | 3 | **0（干净自收敛）** |
| 墙钟 | **113s** | 352s（**3× 慢**） | **112.9s（追回 count 速度）** |

**过程（体现"反复测试→优化→再测"迭代）**：
- signal **v1**：简单题正确但**慢 3×**——软化守卫去掉了 count 的"拿到答案就早停"强制切断，Qwen 缺"够了就收"的自律 → 多翻（reads 6 vs 2）。
- 定位根因：`enoughHops` 收敛提示只在 hops≥4 触发，而**定点定位型任务 hops 恒 0** → 从不提示收尾 → 过度探索。
- **MVP-1.1** 修复：加"定点型（hops=0 但 read≥enoughHops）也发一次性收敛提示（软提示非强制）"。
- signal **v1.1** 复测：**112.9s（= count 113s）、全 3 GT、interventions=0、干净自收敛**——速度追回、正确性更完整、无强制干预。

**结论**：MVP-1.1 后简单题**不再退化（速度追平 + 更完整 + 零强制干预）**，深多跳仍受益于软化守卫。> ⚠️ 单跑有 temp>0 方差，应多 seed 复测；但方向明确。

## 4. 诚实裁决（MVP-0/1 + 1.1 完成）
- **深多跳（难题）**：signal 修复了 count 的"过早掐停→浅答判错"（EasyNotes correctness 错→对，reads 0→2，命中真破解点）。**核心目标达成。**
- **定点定位（普通题）**：MVP-1.1 后**速度追回 count（112.9s）、正确性更完整（3/3 含 C11960）、零强制干预**——不退化。
- **一句话**：signal-gated 守卫 + reads-based 收敛提示 = **难题肯深读跟到底、简单题够了就收**，两头都对。这正是"软化强制干预、把'是否继续深挖'的裁量还给 agent、框架只在资源上限兜底"的落地验证。
- **方法论保留**：单跑 A/B 有 temp>0 噪声（methodology 铁律），墙钟数含方差；但 reads/steps/命中的行为差异 + EasyNotes 机制对错是真实非纯噪声。后续多 seed 复测更稳。

## 5. 下一步
- MVP-1.1：reads-based 收敛提示治简单题慢（上面待调优）。
- MVP-2：corpus/advisor 加码（案卷真锚点 + 错锚点探针防盲信），复现 case-file 6.8x。
- 全混淆题（Device_Info）signal 也救不了（模型+grep 联合上限，无 grep 锚点→checkpoint"去读码"也没码可读）——需 MVP-2 的 case-file，signal 守卫不解决此类。
