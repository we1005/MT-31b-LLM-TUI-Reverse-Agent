# Comparisons（对比展示）

全部实测、同模型（本地 Qwen3.6-35B-A3B @ lemonade）、串行（单并发铁律）。原则：**诚实第一——单跑会骗人，凡结论标证据强度**。每节都有对应 `docs-resources/*.md` 详版。

---

## ① rev-agent vs pi-agent（+Qwen3.6）：三档难度头对头

把同一本地模型接进通用 coding agent [pi](https://github.com/earendil-works/pi)（自定义 provider，注入 RE 纪律提示），同题同模型对比 rev-agent：

| 场景 | pi + Qwen3.6（最佳设置） | rev-agent（同题同模型） | 谁更好 |
|---|---|---|---|
| **中难度定点定位**<br/>MT MCP 入口类, 13万 java | ✅ 命中全部 3 GT + 枚举 10 工具类<br/>18 工具(grep6/read10) · 402s · 42.7k | ✅ 命中核心 C19184/ServiceC7545<br/>4 工具(read2/grep1) · **113s · 3.5k** | **rev-agent**（3.5× 快 / 4× 少工具，协议+台账焊死） |
| **深多跳·有锚点**<br/>EasyNotes VIP mod, 25852 java | ✅ 精确命中真破解点（跟到 UserConfig 两 getter 的 return true）<br/>22 工具(grep7/**read15**) · 207s | ⚠️ 入口对机制错：止损守卫 step8 提前触发, reads=0 未读文件就收尾, 猜成 isVip 硬编码<br/>8 步(grep4/**read0**) · 144s | **pi**（肯深读 15 次跟到真破解点） |
| **全混淆·无锚点**<br/>Device_Info Premium mod, 7638 java | ❌ 超时空答：grep premium 全落空<br/>47 工具(grep30/read10) · **900s 被 kill** · 66k | ⚠️ 快速失败无实质答案：止损 101s 优雅退出但同样没答案<br/>9 步 · 101s | 平（模型层上限，两者单跑都打不动） |

> **takeaway**：中难度定位 rev-agent 更快更省（协议/止损/台账焊死）；深多跳有锚点 pi 赢得干净（肯深读跟到真点，而 rev-agent 抗空转守卫反把它在 reads=0 时掐停——这条正是后来 F1 signal 软化守卫要修的）；全混淆无锚点两者单跑都失败＝本地 35B + keyword-grep 的**模型层上限**，不是 harness 的锅。
> 源：`docs-resources/pi-agent接入Qwen3.6-实测对比.md`

## ② 强模型案卷 handoff（Device_Info 全混淆破解定位）

pi 单跑打不动的全混淆题，用**强模型先做前置分析产 case-file**（去混淆映射 + `file:line` 锚点 + 待核对清单）喂给 pi 续跑：

| 指标 | pi 单跑 | **pi + 前置强模型案卷**（仿 `--corpus`） |
|---|---|---|
| 结果 | ❌ 超时空答 | ✅ 正确四段式（直奔 `op4.java:71-72` 确认 `new kr1(true)` 恒真 patch） |
| 墙钟 | 900s（被 kill） | **132s** |
| token | 66k | **13.5k** |
| 工具调用 | 47（30 grep 乱搜） | **14（全 read, 0 grep）** |

> **takeaway**：案卷把 pi 打不动的**"搜索题"降级成它擅长的"核对题"**：失败→成功、**6.8× 快、5× 省**；`0 grep / 14 read` 是铁证。前提是案卷必须给**真去混淆锚点**而非泛泛散文。这就是 rev-agent `--corpus` 模式的价值，也是"强模型定位 + 弱模型核对"的分工——**能"搬动"模型上限（不"突破"）**。
> 源：`docs-resources/pi-agent接入Qwen3.6-实测对比.md`

## ③ F1 守卫 signal vs count（n=5 多 seed，playbook 均开）

框架化 MVP：把 count-gated 守卫（连续 N 步无进展→立即强制收尾）软化成 signal-gated（触发先注入 CHECKPOINT+给预算，只在资源硬上限收尾）。`REV_GUARD_MODE` A/B：

| 题 | 守卫 | 中位召回 | 均值 | gt_hit(≥0.5) | dur |
|---|---|---|---|---|---|
| q01-mcp（medium 定位） | A=signal | 1.00 | 1.00 | 5/5 | 219s |
| q01-mcp | B=count | 1.00 | 0.90 | 5/5 | 178s |
| q02-easynotes（hard 深多跳） | **A=signal** | **0.57** | **0.54** | **3/5** | 277s |
| q02-easynotes | B=count | 0.43 | 0.46 | 2/5 | 233s |

> **takeaway**：定位题两者都稳解（count 均值略低、快 ~1.2×，基本打平）；难题 signal 中位/均值/gt_hit 都略高，速度代价仅 ~1.2×（比担心的 1.5× 小）→ **signal 值得当默认**（留 `REV_GUARD_MODE=count` 回退，低后悔）。CI 必然重叠非统计显著，给的是方向。
> 源：`docs-resources/框架化-F1-F3-补证据-多seed.md`

## ④ F3 playbook ON vs OFF（5 道 crack 题）

栈感知 playbook 注入是否该当默认？q02/q06 n=5、q03/q05/q08 n=3：

| 题 | ON 中位召回 | ON gt_hit | OFF 中位召回 | OFF gt_hit | 谁更好 |
|---|---|---|---|---|---|
| q02-easynotes | 0.57 | 3/5 | **0.71** | **5/5** | OFF |
| q08-clone | 0.00 | 0/3 | **0.17** | **1/3** | OFF |
| q06-podcast | 0.00 | 0/5 | 0.00 | 0/5 | 平（都失败=模型上限） |
| q03-device | 0.00 | 0/3 | 0.00 | 0/3 | 平 |
| q05-code | 0.00 | 0/3 | 0.00 | 0/3 | 平 |

> **takeaway**：playbook ON 在 5 道题里**没有一道更好**（OFF 胜2 / 平3 / ON 胜0）；q06 上 ON 还纯烧时间（322s/11hops vs 248s/4hops 无回报）→ 从 n=3 的"翻盘保留"**升级为 firm 负面：默认 OFF**（opt-in 保留 crack 知识）。机制：扩表锚点成 **distractor** 把模型带偏（EasyNotes 真 crack 是 getHasBuyed，不同命名）。**教训：别凭 n=3 定 main 默认——CI 宽的"翻盘保留"经不起 n=5。**
> 源：`docs-resources/框架化-F1-F3-补证据-多seed.md`

## ⑤ 10 题能力测试分层（全框架开，budget 80k，单跑）

| id | 难度 | recall | hit/tot | 判读 |
|---|---|---|---|---|
| q01-mcp-entry | medium | **1.00** | 2/2 | ✅ 纯静态定位满分——框架核心强项 |
| q02-easynotes | hard | **0.86** | 6/7 | ✅ 只差一行号；playbook 原生锚点 getHasBuyed 奏效 |
| q06-podcast | hard | 0.67 | 2/3 | ◐ 找到 gz0.f/hasDonated |
| q05-code | hard | 0.33 | 2/6 | ◐ 找到 skuPremium，缺行号 |
| q03-device | hard | 0.25 | 1/4 | ◐ 概念对(op4/kr1)缺精确锚点 |
| q04-battery | hard | 0.00 | 0/4 | ✗ 计费协程深链没走通 |
| q07-snaptube | hard | 0.00 | 0/5 | ✗ 短名混淆；reads=1 疑早收尾 |
| q08-clone | medium | 0.00 | 0/6 | ✗ 真 miss（答的 leetrue 是零调用死代码） |
| q09-duolingo | medium | 0.00 | 0/8 | ✗ playbook 锚点缺口（已修，修后 surface 对锚点但仍未收敛） |
| q10-kuwo | ceiling | 0.00 | 0/5 | ✗ 控制流平坦化 ceiling（题目本就标 ceiling） |

> **takeaway**：平均锚点召回 **0.311**（单跑非多 seed 中位，绝对值仅供分层判读）。静态定位满分、常规命名破解题良好；深协程链/短名混淆/大体量多破解点召回坍塌。**5 个 miss 里只 1 个（q09 锚点缺口）框架可修，其余是模型上限或判分局限——如实归因，别把模型上限伪装成待修 bug。**
> 源：`docs-resources/框架化-能力测试闭环-10题.md`

## ⑥ 云端顾问脱敏防火墙：真实外部云端 0 泄露

| 验证组 | 配置 | 结果 | 泄露 |
|---|---|---|---|
| (a) 直连顾问 E2E | advisor=volcengine/minimax-m2.7（benchmark ARK key） | 11/11 通过 · 33s · clean payload 无明文包名/URL/IP/绝对路径/混淆类名 · 22 占位符 · 云端回思路+restore 还原 | **leaks=0** |
| (b) 全 agent 硬题自动触发 | main=本地 lemonade / advisor=volcengine（追 MT root shell 执行链 ≥5 跳） | 本地 35B 真卡住(6步只grep, hops=0 reads=0)→readHopStall 硬止损→自动脱敏(24占位符)→真打外部 volcengine→思路还原 1446 字注入→续跑解卡(**reads=9 hops=5**)→干净 done | **0 泄露** |

> **takeaway**：真实外部云端（火山引擎 volcengine/minimax-m2.7）已 **live 验证**：脱敏防火墙在真外网出境时 0 泄露（确定性台账清单 + 正则兜底 + fail-closed 扫描），云端方法论把本地小模型从空转（hops=0/reads=0）拉回到产出链路（reads=9/hops=5）+ 结论。**总开关默认关（`--consult-cloud`），不开则纯本地绝不出网。**
> 源：`docs-resources/混合后端-云端顾问-交付与验证.md`

---

## 一句话总纲

**决定成败的杠杆更多在"行为/流程编码 + 强模型前置案卷"，而非本地模型自身知识**（[[Roadmap]] / `docs-resources/框架化-把逆向负担从模型移到框架.md`）。框架把弱模型的"搜索/自律/记忆"短板补上，但**全混淆无锚点仍是模型层天花板**——破壁只能靠强模型 case-file / 云端顾问（搬动上限）或动态分析（frida，当前 harness 结构受限）。
