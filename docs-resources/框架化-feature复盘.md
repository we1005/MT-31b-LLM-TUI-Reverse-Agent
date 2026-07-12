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
| 3 得到 | **多 seed(n=3)**：M2A 错锚点鲁棒 **hit 3/3**(每次抓出"案卷有误"不盲信)；正向 M2C(device+正确案卷) **3/3 / 110s 中位 / hops7** vs M2B(solo) **2/3 / 255s / hops0**。 |
| 4 有效？ | ✅ **有效(多 seed)**：负向 3/3 防盲信；正向案卷把"bimodal 2/3 且慢"变"可靠 3/3 + **2.3× 快** + 更深"。**诚实修正**:solo Device 多 seed 其实 2/3(非之前单跑的 always-fail/reads=0，那是坏样本)——案卷的赢点是**可靠+速度+深度**，不是"救活全失败"。 |
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
| 3 得到 | 离线机制 **14/14**；**多 seed(n=3, EasyNotes)**：有 playbook(M3E) **hit 3/3 / hops6 中位** vs 无 playbook(M3D) **2/3 / hops0**；dur 约平(254 vs 269)。 |
| 4 有效？ | ⚠️→✅ **意外地 modest positive**(超出"预测无效"):+可靠性(3/3 vs 2/3)+**深度(hops 6 vs 0)**——playbook"跟深跳/查恒真 getter"引导让它追更深。**n=3 CI 宽，2/3-vs-3/3 差是单样本可能是噪声；hops-depth(6 vs 0) 是最稳信号。** |
| 5 必要？ | 从"存疑"上调:crack-audit playbook(本项目真归纳)在有 GT 的深多跳题上确有正向;必要性中。手写栈 playbook(Unity/Flutter)仍未被本地题库覆盖到,价值待证。 |
| 6 过度设计？ | 重估:**不是纯累赘**(有正向信号)→**不砍**。仍守铁律(系统按硬信号推+只作 context+优先自动生长)。 |
| 7 能挽救/改进？ | 无需挽救;可改进=多题多 seed 确认 + 优先让自动生长(MVP-4)替代手写 seed。 |
| 8 裁决 | **保留**(从"准备砍"翻成"留,谨慎乐观")——多 seed 显示 modest positive(可靠+更深)。这正是"别凭孤立/预判就砍子特性,让消融说话"铁律的活例。多题多 seed 再确认强度。 |
证据：`scripts/test-playbook.ts`；待 `_scratch/pi-bench/ab2/results.csv`。

---

## 汇总裁决（多 seed 复核后·终）
- **Feature 1(守卫软化)**：✅ 多 seed 证难题净胜、普通题不退化。**保留，合 main 候选。**
- **Feature 2(corpus 锚点自检)**：✅ 多 seed 证负向 3/3 防盲信 + 正向案卷 3/3+2.3×快+更深。**保留。** 诚实修正:solo Device 是 bimodal 2/3 非全失败。
- **Feature 3(playbook)**：⚠️→✅ **翻盘**:曾判"最可能过度设计、准备砍"，多 seed 却是 modest positive(3/3 vs 2/3 + hops6 vs 0)。**保留(谨慎乐观)**，多题多 seed 再定强度。**教训:没让消融说话前差点错杀——印证"别凭预判砍子特性"铁律。**
> 三者均保留;整体(全开)相比裸框架在难/深多跳题上净正。共同的诚实保留:n=3 CI 宽、单题、temp 噪声——绝对幅度需更多 seed/更多题收窄(下一步 10 题能力测试正好扩样本)。
