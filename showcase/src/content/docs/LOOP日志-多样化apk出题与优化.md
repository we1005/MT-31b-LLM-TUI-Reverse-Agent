# LOOP 日志：多样化 APK 出题 · 实测 · 发现问题 · 优化

> **起于**：2026-07-10，`/loop 2h`（会话内 cron 0f9d4c15）。每轮拿一个 APK 反编译产物出逆向题、用本地 Qwen3.6 实跑、发现问题→改代码→验证。
> **本文档纪律**（用户要求）：每次出题和测试都沉淀于此——记录**出题思路、测试思路、发现的问题、每次改进的推理**，不只是结果。
> **累积基线**：3 问(P-发散/P-收尾/P-断链)已由 compactHistory折叠 + §9台账纪律 + ctxCeiling + nudge连续空转计数 解决（详见 `收敛优化loop-让小模型追多跳链路不发散.md`）。本 loop 在此基础上**换 app 换题型**继续找新问题。

---

## 素材库（非 MT，已探明）
| APK | 类型 | 大小 | 状态 |
|-----|------|------|------|
| Via 浏览器 mark.via.gp | 轻量浏览器 | 4.6M/单dex | ✅已反编 scratchpad/loop-apks/via-jadx (4209 java) |
| CHM 阅读器 | 阅读器 | 184K | 待反编 |
| 抖音 dysbb | 社交/native重 | 5.5M | 待反编 |
| 微博 RN/uniapp | 混合(JS) | - | 待反编 |
| OPPO 小布记忆 | 系统应用 | - | 待反编 |
| vivo 浏览器 | 浏览器 | - | 待反编 |

**出题多样化策略**：不同 app 出不同链路题型——浏览器(URL加载/广告拦截/JS注入)、社交(登录签名/接口鉴权)、混合(JS-native 桥)、系统应用(权限/IPC)。目的是让 agent 在**陌生代码库 + 不同混淆风格 + 不同链路形态**下暴露新失败模式。

---

## Round 1 — Via 浏览器 · URL 加载链路

**出题思路**：Via 是全新代码库(和 MT 文件管理器完全不同)，4209 混淆类(a/a0/a1…)+明文类(Search/Shell/BrowserApp)。出"地址栏输入→加载网页"链路——浏览器核心逻辑，给起点(Search/输入框)不给类名，测**跨 app 泛化**(机制是否只对 MT 过拟合)。

**测试思路**：全套优化机制(compactHistory+台账+ctxCeiling+nudge重置)不变，只换 app/题。看 ctx 是否仍平台化、台账是否执行、能否追出 loadUrl 终点。

**结果**：✅ 跨 app 泛化通过。ctx 平台化 ~4-6k(14步没爆)，7 台账+最终结论+链路图：
`Search.onCreate → Shell.a(提取输入) → a9.j.g(URL判断/拼合) → t4/b.loadUrl → WebView`。正确处理混淆类、诚实列待确认。

**发现的问题 → 优化**：budget 报 138%(110k/80k) 但真实 ctx 才 4.4k。
- **第一次误判修**：以为 lemonade 不回 usage、A5 兜底把整条 messages 重估累加(super-linear)。改成兜底只加 result.text。→ **仍 123%！没修好，诚实查因。**
- **查实根因**：lemonade **其实会回 usage**("估算兜底"warn=0次)，budget 累加的是 `totalTokens` = inputTokens(每步含增长 prefill) + outputTokens → 累加即 super-linear 伪量。我第一次改错了分支(改了不走的兜底)。
- **正确修**：budget 只累加 `outputTokens`(每步真新增输出)，绝不加 totalTokens。语义=模型累计输出成本，线性诚实。上下文失控由 ctxCeiling(真实 ctx)独立守。
- **教训**：别假设后端行为(以为不回 usage)——先探针实测。改完要验证到底(第一次改完没验证真实数字就以为好了，被 123% 打脸)。

**待验证**：budget outputTokens 修正后应大幅回落到真实输出量级(16步×几百 token ≈ 数千)。

### Round 1 后续（budget 两次修 + 迷路软提醒 + 暴露"丢弃式折叠"根因）
- **budget 第2次修(正确)**：探针实测发现 lemonade **会**回 usage，累加的 totalTokens 含每步 prefill = 伪量。
  改为只累加 outputTokens。验证：短任务 done=`budget=527/80000`(之前虚报几万)、Via 全程 green(非green=0)。**budget 修好 ✅**。
  教训：别假设后端行为(先探针)、改完看真实数字验证到底(第1次改完没验证被123%打脸)。
- **迷路软提醒(治 Round1 新失败)**：Via 起点(地址栏UI事件)难定位，agent 反复 grep/read 却不产出台账、
  ctx不高(nudge因有进展不触发)、maxSteps太松→撞墙。加 exploreCap=8：工具调用超8次仍0台账→注入一次"换策略/先落已确认"提醒。
  验证：Via 软提醒触发1次，**之后 agent 明显换策略、找对了加载链**(t4/b.java:272 loadUrl、r4/d.java G→H→loadUrl)。
- **但仍暴露更深根因**：Via-b4 追对了链路核心(G→H→r4.loadUrl 第183行)，**却始终不写台账、maxSteps=26 兜底停、0产出**。
  根因：**compactHistory 是"暴力丢弃式"压缩**——旧类体换 stub 直接扔，模型回头无法重看，只能靠自律写台账，
  而小模型自律不足(ranking 早预警)。软提醒只能提1次，不够。
- **→ 用户点破 + 转向**：上下文满该「压缩」不是「丢弃」。正查 OpenHands 等成熟 agent 的记忆压缩机制(LLM摘要式?
  是否第三方组件?)，看能否把"丢弃式折叠"升级成"摘要式压缩"(折叠时留一句 LLM 摘要而非直接扔)。research workflow wf_f2bac60c-5e7 进行中。

## 阶段性状态
3 问在 MT 上已解(compactHistory+台账+ctxCeiling+nudge)；换到陌生 app(Via) 暴露：
(a) budget 伪量[已修] (b) 迷路空转[软提醒缓解] (c) **丢弃式折叠+自律不足致追对却不收尾[待解,查 OpenHands 借鉴摘要式压缩]**。

---

## Round 2 — 上下文记忆系统重构（阶段1 Ledger）+ 记忆表现遥测

**转向**：用户指正"128K小模型必须有系统性记忆系统,别打补丁"。workflow 综合 OpenHands/ClaudeCode/Hermes,
设计出 3 模块架构(history真相+可逆view / ledger带外台账 / context-manager门面),砍掉近半过度设计。
详见 `上下文记忆系统-架构设计.md`。**阶段1 先做 Ledger**(带外/零配对风险/最高杠杆)。

**Ledger 实现**(src/memory/ledger.ts)：系统维护台账,不靠模型自律——
observeToolResult 自动抽 reads/greps(零LLM)、promoteFromProse 正则捞"跳N:A→B|证据"、
hasRead/hasGrep 去重守卫、render 拼 system 尾、renderChainGraph 收尾 O(1) 拼图。收编 hopWritten/hopCount 脆弱正则。

**记忆表现遥测**(用户要求每次记录记忆表现)：每步 emit `[ctx folded dedup hops reads greps]`。

### Via URL链路 实测记忆表现曲线(26步 maxSteps停)
```
ctx: 122→477→...→平台化 3-8k(folded 0→19 持续折叠✓)  ← 记忆压缩健康
reads: 0→4  greps: 0→4  ← observeToolResult 系统自动填台账✓(不靠模型)
hops: 全程 0  ← ❌ promoteFromProse 无米下锅:agent 22次工具调用没写过一行"跳"台账
dedup: 0     ← 没重复读(也没进展到能重复)
换策略提醒: step8触发1次  最终结论: 0(没拼出图)
```

### 诊断(记忆系统健康,但暴露"起点定位"新硬骨头)
- **记忆系统本身工作良好**：ctx 平台化、台账自动填 reads/greps、折叠持续。记忆表现指标健康。
- **真问题**：Via 地址栏URL加载入口**客观极难定位**(EditText监听→混淆回调→loadUrl 隔多层),
  agent 22次调用在 Shell/BrowserApp/l0 之间**始终连不出第一跳**→hops=0→promoteFromProse无输入→
  wrap提醒(需hops≥4)永不触发→迷路到maxSteps。**这不是记忆问题,是"正向追起点"对小模型太难**。
- **头脑风暴对策**：起点难定位时应换**反向追踪**——loadUrl 是明确锚点(grep得到),从 loadUrl 反向找
  调用者,比从模糊的"地址栏输入"正向追容易。逆向通用策略(反向切片),§9 没教。→ 下一步加。

### 收编成果(散补丁→ledger)
hopWritten/hopCount 脆弱正则[删] → ledger.hopCount()/promoteFromProse(结构化,交叉核验✓)。
exploration/wrap 提醒改读 ledger.hopCount()。dedup 守卫[新]防重复读。

### Round 2 续：升级干预 + 首token超时修复 + 后端卡顿阻断
- **迷路干预升级**：exploration nudge 从一次性→可复触发+升级(hops=0 且每再积 exploreCap 次工具调用介入一次；
  第1次换反向追踪策略、第≥2次判定起点难定位强制收尾报告卡点，不放任到 maxSteps)。收编 explorationNudged→explorationNudges 计数。
- **首 token 独立超时(修真缺陷)**：原 stepTimeoutMs=120s 是空闲超时,但首token前无part→本地35B prefill大ctx+长CoT
  可能几分钟才吐首字被误判stall而abort(实测 ctx=113 都被误杀)。改：首token前用 firstTokenTimeoutMs=300s,首token后切120s空闲。编译过。
- **⚠️ 后端卡顿阻断验证**：本轮末 lemonade/Qwen3.6 **卡死**(连"说hi"max_tokens=10 都卡满60-90s无响应,models接口秒回但生成卡)。
  demo test4 失败=ctx=113就abort(后端卡,**非ledger回归**)。MCP验证 step4 abort 同因。
  代码侧产出真实且静态验证(ledger单测全过/编译过/前几轮ctx平台化+dedup已实测),但**真实LLM端到端验证被后端阻断**。
  红线：不能碰服务器/重载模型。**等后端恢复再验 首token超时修复+ledger增益+MCP回归**。未验证不push。

## 本轮记忆系统落地小结(已静态验证,待后端恢复端到端验)
src/memory/ledger.ts(带外台账,单测全过) + agent.ts接入(observe自动填/promoteFromProse捞跳/hasRead-hasGrep去重/renderChainGraph收尾/stats遥测) +
首token超时修复 + 反向追踪§9 + 升级迷路干预。散补丁hopWritten/hopCount已收编入ledger。
记忆表现遥测每步 [ctx folded dedup hops reads greps] 已实测输出(Via曲线证明ctx平台化+台账自动填+dedup生效)。

## Round 3 — 多样化题库(30题) + 并发卡死教训 + 串行铁律

**后端无关的实质推进**(后端卡死期间做的真实工作)：
- **反编译 +2 产物**：CHM阅读器(87类,阅读器) + 抖音dysbb(5274类,social/native)。现共 7 产物：MT/NP/modv6/mtmod/via/chm/dy,覆盖 文件管理器/浏览器/阅读器/社交。
- **建题库 30 题**(workflow wf_d7765e98,落 scratchpad/ctf/bank-multi.json)：7 app 各 3-4 题,每题带 **ground truth(真实源码验证 file:line)** + **memoryStress(压测记忆系统哪点)** + **predictedFailure(预测失败模式)**。类型：链路追踪7/找类7/跨包6/安全点6/加固4。难度覆盖 easy-hard。
  例：Via广告拦截链 p4.j→p4.a(抽象默认null)→p4.b(组合遍历List)→空WebResourceResponse(text/plain);Via自有加密 b9.w0 AES/CBC/PKCS5+RSA/ECB+PBKDF2迭代次数。全部 verified。

**🔴 最重要发现——后端卡死是我自己并发误用造成的**：
- 用户点破：**lemonade 只支持单并发**。我之前同时跑多个后台 --once(Via/首token探针/MCP-led),把后端挤死。
- 一度误判"后端故障需重载",实际是并发。并发搞死后光停客户端救不回,需服务器侧重启。
- **铁律**(记入 [[lemonade_single_concurrency]]):rev-agent/lemonade 调用**必须串行**,任何时候只一个在跑。
  Claude workflow 并行出题OK(不碰lemonade),只有碰lemonade的调用要串行。
- 已删旧 2h cron(0f9d4c15,防它 fire 时并发),只留 **30m loop e942d367**(prompt 含串行探活指令)。

**当前状态**：后端仍需服务器侧恢复(被之前并发搞死)。题库30题就绪,等后端恢复后**串行**批量 live 验证：
首token超时修复(不再ctx=113 abort) + ledger增益(台账自动填/收尾拼图/dedup) + demo/resume回归。**未验证不 push**。

---
（后续轮次追加于下）
