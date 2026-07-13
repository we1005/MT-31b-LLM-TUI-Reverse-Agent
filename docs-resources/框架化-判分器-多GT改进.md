# 判分器改进 · 多破解点 grouped-GT（附：一次被对抗式验证推翻的假设）

> 分支 `framework-guards`。承 10 题闭环里我提的 TODO：「允许多 GT 锚点 /『命中任一真恒真门给部分分』，治多破解点 App 系统性低估」。
> 用 workflow 做：**对抗式验证候选备选破解点（默认否决）→ 实现 grouped-GT MAX-recall → 公平性审计防灌水**。7 个 Claude 子 agent，只读 grep/read 反编译源码（不碰 lemonade）。

---

## 一、动机（我当初的假设）
10 题闭环里 5 题 recall=0.00。我**曾断言** q08-clone / q09-duolingo 是「多破解点 App」——agent 找到了 GT 主点之外的**真**破解点却被单点 GT 判 0（尤其我说 clone 的 `com.mrlee.common.leetrue()` 也是真 crack）。于是想给判分器加"多 GT 分组、取 MAX recall"来纠偏。

## 二、对抗式验证结果 —— **假设不成立（我错了）**
把 5 个 0.00 题的 agent 单跑答案，逐个丢给独立核查员（默认怀疑：一个备选点只有①方法真身恒真/绕过 ②真被某付费/会员/去广告门禁**调用**，才算数）。

| 题 | agent 的备选答案 | 裁定 | 证据 |
|----|-----------------|------|------|
| q08-clone | `leetrue()`/`leefalse()`/`leenull()` @ com/mrlee/common.java | **correctly-zero** | 全树 grep `leetrue\|mrlee.common` → **仅命中定义文件自身，0 调用点**。恒真真身成立**但无人调用=死代码/modder 工具箱指纹壳**。真 crack `UserCache.C()` agent 全程没提。 |
| q09-duolingo | `zc/c1.a()`、`sl/n` | **correctly-zero** | `zc/c1.a()` 是 **void 促销频控/埋点写入**(记 `premium_offer_count`)——无 boolean、无 return true、不 gate 任何付费。`sl/n` 是 jadx 合成的 enum switch-map 编译产物。都红鲱鱼。 |
| q04/q07/q10 | 各自 claim | **correctly-zero** | 均未验证到 GT 外真恒真门。 |

**5/5 全 correctly-zero，verified_alt_anchors 全空**。即：**这 5 个 0.00 不是判分低估，就是真 miss**（红鲱鱼/死代码/合成产物/模型上限）。**我此前"clone 是多破解点、agent 找到真 alt"的说法被推翻**——我当时只核了 `leetrue` **存在**、没核它**被调用**，属确认偏误；对抗式全树 grep 抓出它零调用。

## 三、实现（能力加了，但本批一分未动）
`scripts/score-anchors.py`：
- 题目可选字段 `alt_crack_points: [{crack_point?, chain?, grade_keywords?}]`。判分时**主组 + 每个 alt 组各自算锚点集合与 recall，该题取各组 MAX**（记 `winning_group`）。
- **向后兼容**：无该字段 → `q.get('alt_crack_points') or []` → 只有 main 组 → 与旧版逐字节一致。经验证：cap-run1 重判 mean **0.311→0.311**、10 题 `winning_group` 全 main；旧 `bank-crack.json` 仍正常判（mean 0.295，全 main）。
- **平票**：组序固定 `[main, alt1, …]`，`max` 保留首个 → 平票归 main（确定性）。
- 合成 1 题单测：给一个 alt 组、其锚点匹配一个缺 main 锚点的 .out → `winning_group` 翻到 alt1、recall 0.0→1.0，证明 MAX 分组真的会触发。

**因 5/5 correctly-zero、verified_alt_anchors 全空 → 一个 alt 都没写进 bank**（bank-capability.json 未改，`grep -c alt_crack_points`=0）。→ **before==after，机制惰性，无题受益**。

## 四、公平性审计（对抗式，独立复核未采信实现方自述）
- `any_inflation=false`：bank 全 10 题无 alt 字段 → 根本不存在"涨分题" → 无从灌水。
- `scorer_backward_compat=true`：读代码 + 重跑 diff 逐字节一致。
- 抽查 q01/q02/q06 main 锚点确逐字命中 .out，判分器命中非造假。
- **设计风险备案（本轮未触发）**：MAX 对各组按各自锚点数归一化，未来若给某题加"锚点少而泛"的 alt 组（如仅 1 个恰好出现的 5 字符标识符），其 recall 可能虚高压过 main = 灌水通道。缓解=alt 锚点同样过 `len≥5` 过滤 + 必须逐字 substring 命中；**铁律：未来任何题加 alt 组，必须逐锚点核实"真恒真门 且 逐字在对应 .out"，本次的对抗式验证流程即模板**。

---

## 五、诚实裁决（8 问见 `框架化-feature复盘.md` §4）
- **有效？** 机制正确、向后兼容、零灌水——但**本批零收益**，因为**待纠偏的现象不存在**（假设被证伪）。
- **必要？** 弱：既然多破解点低估在本题库未被证实，此改进目前是**面向未来的能力储备 + 一次假设证伪的记录**，而非解决现有痛点。真价值 App（一 App 多个都被调用的恒真门）出现时它才生效。
- **过度设计？** 边界：+30 行、纯确定性、向后兼容、有单测——机制本身不算过度；但**为一个未证实的痛点建机制**踩到了"避免过度工程"的线。保留理由=成本极低且证伪过程本身产出了更重要的东西（纠正了我的错误归因）。
- **最大收获**：对抗式验证**推翻了我自己的假设**，把 q08 从"判分假阴"改判回"真 miss"。这正是"别把模型上限/自己的臆测伪装成待修 bug"铁律的活例——**连提出 fix 的人自己的前提都要被 red-team**。

_证据：`scripts/score-anchors.py`、`_scratch/pi-bench/cap-run1/_anchors_v2.json`、workflow `wf_ba2b84e7-688` journal（clone 全树零调用、duolingo void 埋点/合成 switch-map 的逐条证据）。_
