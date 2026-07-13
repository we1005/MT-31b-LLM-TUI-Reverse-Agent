# 框架化 · F1/F3 合并前补证据（n=5 多 seed 消融）

> 用户选「先补证据再合」——不从 n=3 单题（EasyNotes）下默认结论。单变量 A/B 消融、复用共享基线、n=5 seed、串行（lemonade 单并发）。
> Cells：A=signal守卫+playbook-on（默认基线）/ B=count守卫（F1消融）/ C=playbook-off（F3消融）。35 run 全完成。
> 判分：`merge-evidence-score.py`（复用 `score-anchors.py` 锚点抽取）。批处理反复被 kill，靠 manifest 续跑保进度。

---

## F1 消融：signal(A) vs count(B) 守卫（playbook 均开）

| 题 | cell | 中位召回 | 均值 | gt_hit(≥0.5) | hops | dur | recalls |
|----|------|---------|------|-------------|------|-----|---------|
| q01-mcp（medium 定位） | A=signal | 1.00 | 1.00 | 5/5 | 5 | 219s | [1,1,1,1,1] |
| | B=count | 1.00 | 0.90 | 5/5 | 4 | 178s | [1,1,.5,1,1] |
| q02-easynotes（hard 深多跳） | A=signal | **0.57** | **0.54** | **3/5** | 3 | 277s | [.86,0,.57,.86,.43] |
| | B=count | 0.43 | 0.46 | 2/5 | 4 | 233s | [.43,.71,.86,.14,.14] |

**读数**：
- **定位题(q01)**：两者都稳解（median 1.00）；count 均值略低(0.90，有一个 0.5 seed)、快 ~1.2×。基本打平。
- **难题(q02)**：signal 中位/均值/gt_hit **都略高**（0.57/0.54/3-of-5 vs 0.43/0.46/2-of-5），代价慢 ~1.2×。方向与 n=3 旧结论一致（signal 在难题净正）。
- **保留判定**：signal ≥ count 在可靠性上（难题小胜、易题打平），速度代价 ~1.2×（**比之前担心的 ~1.5× 小**）。**signal 值得当默认**，且有 `REV_GUARD_MODE=count` 回退 → 低后悔。

## F3 消融：playbook-on(A) vs off(C)（守卫均 signal）—— ⚠️ **n=5 推翻 n=3 旧结论**

| 题 | cell | 中位召回 | 均值 | gt_hit(≥0.5) | hops | dur | recalls |
|----|------|---------|------|-------------|------|-----|---------|
| q02-easynotes | A=pb-ON | 0.57 | 0.54 | 3/5 | 3 | 277s | [.86,0,.57,.86,.43] |
| | **C=pb-OFF** | **0.71** | **0.71** | **5/5** | **9** | 256s | [.86,.71,.71,.57,.71] |
| q06-podcast | A=pb-ON | 0.00 | 0.07 | 0/5 | 11 | 322s | [0,0,0,.33,0] |
| | C=pb-OFF | 0.00 | 0.13 | 0/5 | 4 | 248s | [0,0,.33,.33,0] |

**读数（诚实的反转）**：
- **q02-easynotes：playbook OFF 反而更好** —— C 中位 0.71 / 均值 0.71 / **5/5 都 ≥0.5** / 更深(hops 9 vs 3) / 还略快，全面优于 ON(0.57/0.54/3-of-5/hops3)。**playbook 在这题是净负。**
- **q06-podcast：两者都失败**（median 0），playbook ON 反而**多烧时间+hops**（322s/11 vs 248s/4）无回报。
- **旧 n=3「modest positive、翻盘保留」是噪声**：feature 复盘 F3 曾据 n=3（EasyNotes 3/3 vs 2/3、hops6 vs 0）把 playbook 从「准备砍」翻成「留」。**n=5 在同题上翻回**：OFF 反而 5/5、更深。旧的「深度优势」也反了（这次 OFF 更深）。
- **机制推测**：扩表后的 crack-audit playbook 塞进一大串「订阅/会员系」锚点，但 EasyNotes 的真 crack 是 `getHasBuyed`（不同命名）→ 多余锚点成**distractor** 把模型带偏。这正印证 findings-cache 裁决里「offGoal 常驻注入=distractor」的担忧。

---

## 裁决（据 n=5 收窄后）

| 特性 | n=3 旧结论 | **n=5 新证据** | main 默认建议 |
|------|-----------|--------------|--------------|
| **F1 signal 守卫** | 保留，合 main 候选 | **维持**：难题小胜、易题打平、速度代价仅 ~1.2%×降到 1.2× | ✅ **默认 signal**（留 count 回退），低后悔 |
| **F3 playbook 注入** | 翻盘「留(谨慎乐观)」 | **再翻**：neutral-to-negative（q02 OFF 全面胜、q06 ON 纯烧时间） | ❌ **不该当默认**：改默认 OFF（opt-in），或直接不合 main |

**最诚实的一句**：这轮补证据**证伪了 F3 playbook 该当默认**——n=3 的「保留」是噪声，n=5 更多样本把它翻回负面。这正是当初 feature 复盘自己写下的风险（「n=3 CI 宽、可能噪声」）成真，也是「先补证据再合」这个决定的价值兑现。

## 硬保留（别过度解读）
- **每个消融只有 2 题、n=5**。q02 temp 方差极大（signal 0–0.86）；中位有差但 **CI 必然重叠，非统计显著**。给的是**方向**不是定论。
- **F3「OFF 更好」主要靠 q02 单题**（q06 是地板效应/双失败，只证 ON 浪费时间）。firm 的结论是**否定式**：「playbook 不可靠地帮忙 → 没有当默认的理由」；「playbook 主动有害」仅 q02 单题提示。
- 要把 F3 从「不该默认」升级到「该删」，需更多题（尤其非 crack-audit 命中的题）再确认。

_证据：`_scratch/pi-bench/merge-evidence/{manifest.csv,_summary.json}` + 各 cell/s*/*.out；判分 `merge-evidence-score.py`。_
