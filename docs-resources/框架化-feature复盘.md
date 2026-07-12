# 框架化 MVP-0..4 · Feature 复盘（8 问，可回溯）

> 按 memory `feature_review_rule` 铁律逐 feature 复盘。分支 `framework-guards`。诚实：单跑不算数，"是否有效"以多 seed 为准；多 seed 未完的标"待批处理 bwbjeym2g"。

---

## Feature 1：signal-gated 守卫软化（MVP-0/1/1.1，commit e9fc8bc/f74f1d7）

| # | 问 | 答 |
|---|---|---|
| 1 目的 | count-gated 守卫（连续 N 步无进展→立即强制收尾）在深多跳题**过早掐停**（EasyNotes 实测 reads=0/step8 就 force-finish → 判错机制）。 |
| 2 期望 | 难题不再过早收尾、肯深读到真 crack；普通题不退化。 |
| 3 得到 | **多 seed(n=3)**：难题 EasyNotes count gt_hit **2/3**(1/3 失败, reads=0)、hops0、344s → signal **3/3**、hops6、276s；普通题都 3/3，signal 212s vs count 136s(~1.5×)。 |
| 4 有效？ | ✅ **有效(多 seed)**：难题净胜(可靠+深度+不早停+中位更快)；普通题正确不退化(速度略付)。 |
| 5 必要？ | 必要：count 深多跳 ~1/3 失败率是真的。但仅在"真卡住"尾部起作用(多数 seed 守卫根本不触发)。 |
| 6 过度设计？ | 否：纯函数 decideGuard + 一个 env 开关 + CHECKPOINT 文本，轻量；MVP-1.1 收敛提示是治回归的最小补丁。 |
| 7 能挽救/改进？ | 普通题 ~1.5× 慢是残留代价 → 继续调收敛提示阈值收窄(已从单跑 3× 压到 1.5×)。 |
| 8 裁决 | **保留，值得合 main**(默认 signal + `REV_GUARD_MODE=count` 回退)；普通题速度可再调。 |
证据：`框架化-MVP-0-1-守卫软化-实测.md` + `_scratch/pi-bench/ab/results.csv`。

## Feature 2：corpus 锚点自检（MVP-2，commit 252ca44/befca85）

| # | 问 | 答 |
|---|---|---|
| 1 目的 | 弱模型盲信强模型前置案卷 → 错锚点**传染**成错结论(红队 #1 风险)。 |
| 2 期望 | 给判错案卷不盲信、显式纠错；给正确案卷能救活单跑失败的题。 |
| 3 得到 | 单探针 v2：抓出"❌案卷有误"+纠正到真 crack；正向：device 单跑 101s/reads=0/无答案 → +正确案卷 123s 精确命中 op4.java:71-72。**多 seed(M2A/B/C)待批处理 bwbjeym2g**。 |
| 4 有效？ | ✅ 初步有效(单探针两向都对)；**可靠性待多 seed**。 |
| 5 必要？ | 必要：corpus 原有 verify-don't-trust，锚点自检补最关键一条(逐字核对不照抄)；案卷 handoff 是破全混淆上限的唯一可落地通道(pi/rev 都证)。 |
| 6 过度设计？ | 否：只在既有 corpus 协议加一条文本 + 一个离线测，无新系统。 |
| 7 能挽救/改进？ | v1 顺带暴露 conclusion 检测假阳性 bug(已修)；正向 run 有 conclusion=0 telemetry 小瑕疵(答案正确，待查计数口径)。 |
| 8 裁决 | **保留**；多 seed 复测确认可靠性后合并。 |
证据：`框架化-MVP-2-corpus锚点自检-实测.md`。

## Feature 3：栈感知 playbook 注入 + 自动生长（MVP-3/4，commit 657a9da）—— ⚠️ 最需警惕过度设计

| # | 问 | 答 |
|---|---|---|
| 1 目的 | 提议 3"遇困搜知识库"，但解"弱模型不会自查"悖论 = 系统按**硬栈信号**主动推**程序性套路**。 |
| 2 期望 | 栈相关任务给对做法、提升收敛/正确率；只作 context 可无视。 |
| 3 得到 | 离线机制 **14/14**(匹配/只作 context/自动生长/持久往返)；**真实增益(M3 playbook on/off)待批处理 bwbjeym2g**。 |
| 4 有效？ | 机制成立；**真实增益未知**。按框架分析**预测：小/情境性，很可能不显著**——不预设有效。 |
| 5 必要？ | **存疑**：crack-audit 题不给 playbook 也常能做(EasyNotes 已证)。playbook 价值大概率只在陌生栈(Unity/Flutter/加固)题，而本地题库少这类。必要性偏弱→故列 MVP 最后最小。 |
| 6 过度设计？ | ⚠️ **这是全项目最可能过度设计的一环**——seed playbook 是手写知识(红队警告:脆、弱模型不查)。已按铁律最小化(系统主动推+只作 context+优先自动生长)，但仍需数据证其值。 |
| 7 能挽救/改进？ | 若多 seed 证无增益 → **退化为只保留 crack-audit 一条(本项目真归纳)+自动生长骨架，砍掉手写栈 playbook**。 |
| 8 裁决 | **暂定"机制留、效果待判"**；多 seed 若不显著→按框架预测**大幅收缩甚至砍手写部分**(诚实准备砍，不为已写的代码护短)。 |
证据：`scripts/test-playbook.ts`；待 `_scratch/pi-bench/ab2/results.csv`。

---

## 汇总裁决（当前）
- **Feature 1(守卫)**：多 seed 已证有效，保留合并候选。
- **Feature 2(锚点自检)**：单探针两向有效，多 seed 确认中。
- **Feature 3(playbook)**：机制成立但**必要性/有效性存疑，最可能过度设计**，效果待多 seed，准备按数据收缩。
> 待 batch2(bwbjeym2g) 完成后回填 Feature 2/3 的"得到/是否有效"，并据此定最终裁决。
