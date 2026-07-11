# 篡改 APK 安全审计能力测优记录

> 用途：用第三方破解 mod APK(apk-moded/)测 rev-agent 的**防御性安全审计**能力——找出破解点 + 技术 + 链路 + 给原开发者的加固方案。
> 合规：全程**只读分析已存在的破解**以理解攻击面 + 给防御方案，**不产出任何破解/重打包**。守住"只读不内置破解"红线。
> 判分：出题前由更强模型(Claude 云 agent)亲自读码定 ground truth；rev-agent(本地 35B)应试。

---

## 第 1 轮（2026-07-11）：Device Info / Battery Guru / Podcast Addict Premium mod

### 出题（云 agent 读码验证的 ground truth）
- **device-crack-01**：破解点 `defpackage.op4.<init>(Context)`（op4.java:71-72）——把 `getBoolean("is_ad_free",false)` 结果**丢弃**、`new kr1(true)` 把熵值 StateFlow 硬编码为 true → `op4.l()` 恒真；`op4.n(boolean)` 忽略入参强制置真。技术=本地 entitlement 硬编码 + 校验短路 + PinkiePie(Lucky Patcher)广告中和。修复=Play Billing 服务端复核/Play Integrity/签名指纹校验/服务端签名 entitlement token。
- **battery-crack-01**：破解点 `ub1.e()`（ub1.java:336）返回构造函数写死的 `this.k=true`；真校验 `ub1.d()`(遍历 SKU 调 `nn0.k` 查 BillingClient)保留但被旁路。技术=isPremium getter 短路成硬编码真值、真校验留死代码。
- **podcast-crack-01**：Premium 旁路(gz0 等)。

### 表现（35B 应试，判分词严格=偏低但要结合实际读产出）
| 题 | 判分词命中 | 实际质量 |
|---|---|---|
| battery | 3/14 | **实际好**：找到 ub1.e()/this.k=true 破解点 + nn0.k 真校验旁路 + 合理修复表。判分词是"作者原话式短语"→埋没 |
| device | 4/18→**6/18(修 Defect G 后)** | v1 reads=0 幻觉编造"isProbablePrime 素数熵值校验"；v2 读真码找到 `new kr1(true)` + PinkiePie，**零幻觉** |
| podcast | 1/12 | 偏弱，stall 兜底 |

### 发现并修（Defect G）+ 洞见
**Defect G：审计/逆向 reads=0(只 grep 从不读方法体)就下结论 → 幻觉编造机制。**
- 现象(device v1)：只 grep 2 次(0 read)就下结论，命中的 4 词全是 grep 回显里的字符串；分析部分**幻觉**出代码里根本没有的"isProbablePrime(10) 素数熵值校验"，修复建议"把参数从 10 提到 20+"荒谬。对安全审计 agent 是最危险的失败(自信瞎编)。
- 根因：Defect F 只拦"0 工具调用"，拦不住"只 grep 不 read_file"——grep 只定位字符串位置、看不到方法逻辑。
- 修复(`src/agent.ts`)：把 no-tool-call 收尾前的"未调查"守卫从 `toolCallTotal===0` 扩到 `|| ledger.stats().reads===0`——从没 read_file 读过方法体正文就想下结论 → 一次性 nudge"先 read_file 读关键方法体核实，绝不凭 grep 回显/先验编造"。
- A/B(device 同题)：v1 reads=0/幻觉/4-18 → v2 **reads=5/零幻觉/找到 new kr1(true)+PinkiePie/6-18**。确定性守卫测试 scripts/test-guards.ts 同步(16/16)。

**洞见 1：判分放宽**——审计题主判分词该用**破解点标识**(ub1.e/this.k=true/op4/new kr1(true)/PinkiePie)，别用整段修复措辞(同义不同词会漏判，埋没 battery 这种真做对的)。

**洞见 2：硬审计的解药 = 卡住求助/思路反馈**——35B 独立啃不动的完整审计(找篡改点+技术+链路+修复)，靠 `--ask-when-stuck` 输出困境报告→更强模型给思路→`--strategy`/TUI 反哺续跑(该机制已在 np-r9 0/7→7/7、mtmod-r12 3/9→9/9 端到端验证)。这就是"小模型 + 人类/强模型在环"做真实安全审计的落地路径。

### 能力定位（诚实）
35B **读了真码时**能找到这类"硬编码 entitlement / getter 短路 / 校验留死代码"的破解点并给合理防御方案(battery 实证)；但**易在混淆代码里读不够就幻觉**(Defect G，已修，逼读方法体缓解)，**完整多要素审计(点+技术+链路+修复全齐)仍是能力边缘**，靠思路反馈机制补齐。

---

## 第 2 轮（2026-07-11）：Code Editor / EasyNotes / Snaptube + 两个能力指标 + 3 缺陷

### 引入两个能力指标（用户要求）
- **指标1「介入次数/原地打转」**：scorecard 埋点 `interventions = nudges + explore_nudges + stall + forced + escalations`。越少=agent 越顺、越少需强模型/用户介入。harness 汇总每轮总数/均值。
- **指标2「模型潜能」**：**质量评审**(强模型按 rubric 打分:破解点/技术/链路/修复各0-5 + 幻觉 + overall/100)，**取代失效的关键词判分**。关键词判分严重误导(battery 关键词 3/14 但质量 91)。

### 全 6 mod 质量评审（overall/100，非关键词）
| mod | 无引导质量 | 幻觉 | 破解点定位 | 说明 |
|---|---|---|---|---|
| **battery** | **91 优秀** | 无 | 5/5 | 精准 ub1.e()→this.k=true + 死代码 nn0.k + 4条修复全对 |
| **podcast** | **82 好** | 无 | 5/5 | 命中 gz0.d/f/g + unreachable 指纹 + 技术 |
| easynotes | 54 部分 | minor | 3/5 | 得 getHasBuyed/Subscribe 硬编码，漏 getHasBuyedNeedCheck |
| device | 48 部分 | minor | 2.5/5 | 漏真铁证 new kr1(true)，主次倒置追成广告SDK |
| code | 15→修后大改善 | major→无 | 1→高 | v1 reads=0 幻觉搞错类；v2 reads=7 锁定真门 AbstractC2068ih0.h()→return !true |
| snaptube | 8 wrong | major | 0/5 | 漏 PinkiePie invoke替换 stub，编造 premium.ads.a |

### 清晰规律（能力定位）
**破解点是"可读的硬编码 getter/常量"且 agent 读到了 → 优秀(91/82)；破解点隐蔽(snaptube smali invoke替换)或 agent 没读够(reads=0) → 幻觉暴跌(8-15)。头号敌人 = 不读真码就自信编造机制(违"只读不瞎编"红线)。**

### 本轮发现并修的 3 缺陷
- **Defect G**：审计 reads=0(只 grep 不读方法体)就下结论 → 幻觉。修=Defect F 守卫扩到 `|| reads===0`，逼先 read_file 读方法体。A/B: device v1 reads=0幻觉 → v2 reads=5零幻觉找到 new kr1(true)；**Defect G 缺口**(stall/forced 在循环顶部先触发、绕过 no-tool-call 分支的读码 nudge)→ 由下面反幻觉铁律兜底。
- **Defect H**：审计/理解类任务 hops=0(非"跳N"链路格式)，读了码却"宣告下一步就 done/只写计划"，原收尾安全网 #6 要 hops≥1 兜不住。修=#6 扩到 `hops≥1 || reads>0`，逼输出完整报告(审计题要求破解点/技术/链路/修复四部分齐全)。
- **反幻觉铁律**(最高杠杆)：给所有强制收尾/wrap 结论提示加铁律——"只基于实际 read_file 读到并能引用 file:line 的内容下结论；没读到/没定位到的明说'未能证实'，严禁编造代码里不存在的机制/字节码/类名——找不到远好于瞎编"。A/B: code v1 reads=0/幻觉/搞错类(15分) → v2 reads=7/无 stall/31次锁定真门 AbstractC2068ih0.h()→return !true。
- 确定性守卫测试 scripts/test-guards.ts 全程 16/16 无回归。

### 思路反馈机制在审计上的表现（指标2 的潜能测量）
- 对 device/podcast 用 `--strategy`(我 Opus 给思路)：破解点定位准(crackPointScore 4-5)、介入次数降(guided device=0)，**但答案易被截断/陷入叙述循环**(device 即使给思路仍"## 第1步/第2步 读取"循环，35B 在强混淆多部分审计上的报告组装能力是真天花板)。
- 结论：思路反馈能**补齐定位**，但"组装完整四部分审计报告"对 35B 仍吃力——这类 mod 建议**拆成两步下达**(先定位篡改点，再单独让它就该点写技术+链路+修复)，或用 TUI 分步引导。

### 阶段结论
rev-agent **具备真实安全审计能力**(battery 91/podcast 82 无引导优秀)，能找出硬编码/getter短路类破解并给合理防御方案。**主要短板 = 隐蔽篡改(smali invoke替换)定位 + 不读真码时的幻觉**——后者已由 Defect G + 反幻觉铁律显著缓解(code v1→v2)。合规上守住"只读分析、不瞎编、不产出破解"。
