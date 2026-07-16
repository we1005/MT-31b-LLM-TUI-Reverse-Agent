# rev-agent 跨 app 出题优化记录

> 每轮按 6 要素记录：**为什么出题 / 解法 / 检验哪些能力 / 表现(含组件计分卡) / 优化后改进 / 优化方法**。
> 诚实铁律：本地 temp>0 单次 run 非确定；失败/退步照实写。判分只匹最终 stdout。rev-agent→lemonade 调用严格串行。

---

## 第 1 轮（2026-07-11）：CHM 阅读器 + 抖音 —— 跨 app 泛化 + preflight/Ledger 缺陷

### 1. 为什么出这个题
此前测优几乎只用 MT 家族反编译产物，怕机制**过拟合 MT**。故换两个差异极大的**非 MT** app 验证泛化：
- **CHM 阅读器**（com.pdagate.chmreader，87 文件，小而干净，UI 层类名可读、库层单字母混淆但带 `compiled from:` 注释）；
- **抖音**（5274 文件，海量第三方 SDK 噪音 tongdun/squareup/meitu…，混合混淆）。

### 2. 解法（ground truth，出题时云 agent 亲自读码验证）
- **chm-easy-itsf-header**：解析 CHM 文件头的类 = `com.a.a.ae`（`HeaderITSF.java`），魔数 `"ITSF"`（ae.java:6），编码映射方法 `ae.a()` default 返回 `CP1252`。证据 ae.java:6/20/38。
- **chm-medium-fulltext-search**：全文搜索链 `f.a(View)`(SearchDialog)→`AsyncTask.doInBackground`→`k.a(ak)`(ChmDocumentCache)→`k.d()`→`new t("/$FIftiMain")`(FileFIftiMain 全文索引)。证据 f.java:107/133、k.java:147/127、t.java:7。
- **dy-checkSSSign-sig-verify**：`RequestValidator.checkSSSign` = 校验 `MD5("ByteDance"+MD5(str3)) == RSADecoder.decodeSign(str2)`；RSADecoder 用硬编码 1024-bit RSA 公钥 + `RSA/ECB/PKCS1Padding` `DECRYPT_MODE` 解 Base64 签名；摘要长度异常 fail-open。证据 RequestValidator.java:8-18、RSADecoder.java:15-19、c.java:58-91。

### 3. 检验 agent 哪些能力
| 题 | 主要检验 |
|---|---|
| chm-easy | 单类定位（魔数 "ITSF" 锚点）+ 读懂 switch 映射表 |
| chm-medium | UI→库 3-4 跳链路追踪 + 收尾拼图（终点 `$FIftiMain`）|
| dy-checkSSSign | **强噪音(5274文件)中定位** + 逆向密码学算法（双重 MD5 + RSA 公钥解密）+ fail-open/close 判断 |
| 共同 | **跨 app 泛化**（机制不过拟合 MT）、SWA 稳定前缀在陌生 app 上是否成立 |

### 4. 表现（含组件计分卡）
**v1（改前）**：chm 两题 **exit=2 秒退**（preflight 误杀，见下）；抖音 5/6 命中、有结论、cache 60-85%。
**v2（修 preflight 后）3 题全过**：

| 题 | exit | 判分 | 结论 | steps | cache均/低 | max_ctx |
|---|---|---|---|---|---|---|
| chm-easy | 0 | **3/3** | ✅ | 4 | 77/63% | 2.8k |
| dy-checkSSSign | 0 | **6/6** | ✅ | 4 | 72/60% | 4.2k |
| chm-medium | 0 | **5/5** | ✅ | 8 | 77/63% | 8.3k |

**组件计分卡（据 `[SCORECARD]` 埋点，✅达标/⚠️薄弱）**：

| 组件 | 证据(v2) | 评分 |
|---|---|---|
| SWA 稳定前缀 | cache_avg 72-77%、min 60-63%（3 个陌生 app 一致）| ✅ 跨 app 成立 |
| ctx 控制/压缩 | max_ctx 2.8k-8.3k，folded=0（远低于 ctxCeiling）| ✅ |
| 收尾 | conclusion=1 ×3 | ✅ |
| 工具层 | dedup=0、无工具报错 | ✅ |
| 探索效率 | 4-8 步达标；chm-medium explore_nudge=1（合理，帮它换策略）| ✅ |
| 最终正确性 | 3/3、6/6、5/5 | ✅ HIT |
| **Ledger 台账抽取** | **chm-medium hops=19 ✓5（真链路仅 ~4 跳，✓率 26%）** | **⚠️ 过度抽取（本轮薄弱点）** |

### 5. 优化后改进如何
本轮抓到并修 **2 个真缺陷**：

**缺陷 A：preflight 误杀正常包嵌套的源码树。**
- 现象：CHM 两题 `--workdir=chm-jadx/sources`（含 87 .java）却 exit=2 秒退、报"没找到源码树"。
- 根因：`looksLikeSourceTree` 只递归**一层**——过拟合 MT 的**扁平混淆包** `l/C7671.java`（.java 在 sources 下 1 层）；CHM 是正常包嵌套 `com/pdagate/chmreaderlib/*.java`（3 层深）→ 漏判。
- 改进：**19 万文件的 CHM 从 exit=2（0 分）→ 3/3+5/5 全过**。且 MT/DY/CHM 本地验证不回归。

**缺陷 B：Ledger.promoteFromProse 过度抽取 hop。**
- 现象：chm-medium 真链路 ~4 跳却记 **hops=19 ✓5**（每步复述 + 最终 ASCII 链路图每行箭头都被当新跳）。
- 改进（A/B，同题实跑）：**hops 19 → 11**（✓ 5→6）。台账噪声显著降低。
- 诚实边界：11 仍高于 ~4 真跳（剩余多为模型提到的合法二级调用 + 键粒度），**不影响正确性（仍 5/5）**；按"不过拟合"原则不再死磕该信号（hopCount 是信号非结果，真正可信的是 ✓corroborated 数）。

### 6. 优化方法（具体代码）
- **preflight**（`src/preflight.ts`）：`looksLikeSourceTree` 的一层检查 → `hasSourceFileDeep(dir, 6)` **有界递归**（命中即早退、限深 6、每层 slice 60），覆盖任意深度正常包结构。偏宽松是对的：误放行成本低（agent 跑起来报告无关代码），误拦真源码树成本高（任务跑不了）。
- **Ledger**（`src/memory/ledger.ts`）：`promoteFromProse` 去重从**原文去重**改为**语义键去重**（`hopKeyPart(from)→hopKeyPart(to)` 抽第一个 类/类.方法 标识小写）；两端抽不到标识 = ASCII 图/装饰行，直接丢。单测 19/19 过（含过度抽取治理用例）。
- **埋点**（`src/agent.ts`）：收尾常开 emit 一行 `[SCORECARD] steps/ledger(hops✓reads greps)/cache_avg·min/max_ctx/folded/dedup/nudges/explore_nudges/stall/forced/wrap/conclusion`，供逐组件打分。计分卡常开（便宜且每轮要），重量级 dump 才 gate 进 --debug。

### 结论
跨 app 泛化**成立**：CHM（小/新）+ 抖音（大/强噪音）上 SWA 稳定前缀（cache 60-77%）+ 记忆系统 + 收尾都工作，答案全对。本轮净收益 = 修掉一个会**误杀几乎所有正常 app** 的 preflight bug（高价值）+ 收敛 Ledger 抽取噪声 + 建立组件计分卡。

---

## 第 2 轮（2026-07-11）：Via 浏览器 + NP管理器 + 抖音 —— 广度验证 + 收尾安全网首次 live 触发

### 1. 为什么出这个题
第 1 轮已证 CHM/抖音泛化。第 2 轮扩广度到差异更大的 3 类：**Via**（Chromium/WebView 浏览器，receiver→service 控制流）、**NP管理器**（20655 文件的安卓逆向工具，AXML 二进制解析）、**抖音**（另一密码学子系统 TTNet token）。验证机制在「组件间 intent 转发链」「二进制格式解析」「AES/HMAC 加密」等不同代码形态上是否稳。

### 2. 解法（ground truth，云 agent 读码验证）
- **via-download-pause-flow**：`DownloadReceiver.onReceive`（PAUSE）→ 构 Intent 到 `DownloadService`、`setAction`+`putExtra(Name.MARK,getLongExtra)` 复制 long 任务 id → `DownloadService.onStartCommand` switch → `f9775e.o(longExtra)` 执行暂停。
- **via-readaloud-play-flow**：`ReadAloudReceiver`（`startsWith` 门控）→ 复制 **String** id（对比 download 是 long）→ `ReadAloudService.onStartCommand` PLAY → `f9779e.e(getStringExtra)` 查任务、`getIntExtra("index")` → `g(tVarE)` 播放；`o.a.l` 按 SDK≥26 走 `startForegroundService`。
- **np-axml-chunktype-nodeheader**：AndroidBinXmlParser 按 ChunkType 258=XmlStartElement/259=XmlEndElement 分派，NodeHeader 读 lineNo/comment，头 16 字节。
- **np-axml-genid-resourcemap**：`genId` 从 StringItem `res-auto`/`substring(35)`/ResourceMapChunk rawStrings 生成资源 id。
- **dy2-ttnet-token-etm**：TtTokenEncryptor（com.bytedance.ttnet.f.b）`AES/CBC/PKCS5Padding` + `HmacSHA256`，字段 f3975d/f3976e，`Arrays.equals` 比对，16/32/64 长度常量。

### 3. 检验能力
组件间 intent 转发链追踪（Via ×2，含 long vs String extra 类型辨析）· 二进制格式解析逆向（NP AXML ×2，chunk type 常量）· 对称加密+HMAC 算法逆向（抖音 TTNet）· **20655 文件超大树里定位**（NP）。

### 4. 表现（组件计分卡）
**5 题全 HIT、全出结论、exit=0**：

| 题 | 判分 | steps | cache均/低 | max_ctx | 关键计分 |
|---|---|---|---|---|---|
| via-download-pause | **9/9** | 6 | 81/74% | 4.2k | **wrap=1**（收尾安全网触发）|
| via-readaloud-play | **10/11** | 8 | 80/64% | 9k | hops=10 ✓3 |
| np-axml-chunktype | **8/10** | 2 | 59% | 2k | 2 步秒定位 |
| np-axml-genid | **7/7** | 5 | 80/57% | 4.3k | |
| dy2-ttnet-token | **10/10** | 4 | 73/57% | 4.4k | |

组件评分：SWA 稳定前缀 ✅（cache 57-81% 跨 4 app 稳）· ctx 控制 ✅（max 2-9k，folded=0）· 收尾 ✅（5/5 结论，其中 #6 安全网首次 live 触发）· 工具层 ✅（dedup=0 无报错）· 探索效率 ✅（2-8 步）· 最终正确性 ✅（5/5）· **Ledger 抽取 ⚠️ 仍偏噪**（via-readaloud hops=10 vs ~2-3 真跳，✓3 更接近真值）。

### 5. 优化后改进如何
本轮**无新缺陷需修**——5 题全过，第 1 轮修的 preflight/Ledger 直接受益（NP 20655 文件树、Via/CHM 正常包嵌套都不再被 preflight 误杀）。关键正向验证：**收尾安全网 #6 首次在真实运行中触发并产出结论**（via-download `wrap=1`），证明第 1 轮之前加的该机制有效。

### 6. 优化方法
无代码改动。**复发弱点确认**：Ledger.promoteFromProse 的 hop 计数在"模型写详细链路图/复述"时仍偏高（via-readaloud 10 vs 真 2-3）。结论同第 1 轮：hopCount 是信号非结果，真正可信的是 **✓corroborated 数**；不再为该信号过拟合调参。**下一步候选优化**：让 `hopCount()`/enoughHops 判据改用 corroborated 数而非 raw hops，使"足量收尾"判据更准（待某轮 raw-hop 噪声真正误导了行为时再动）。

---

## 第 3 轮（2026-07-11）：CHM 深挖(LZX/MHT) + 抖音 captcha + Via 路由 —— 含 hard 题

### 1. 为什么出题
挑更深/更硬的子系统：CHM 的 **LZX 解压器**（hard，位运算+Huffman 树+fall-through switch）和 MHT/MIME 解析；抖音 captcha AES；Via Trampoline intent 路由。看 agent 在「hard 算法逆向」上是否够得着。

### 2. 解法（ground truth）
- **chm-r3-1（hard，LZX）**：`ah.a(byte[])` 读 3-bit block-type（enum 1=verbatim/2=alignOffset/3=uncompressed）+ 24-bit 长度；aligned-offset 块额外建 8 符号×3-bit 的对齐树 `e()`，switch case 3 fall-through 到 case 2。
- **chm-r3-2（MHT）**：`c.a(...)` 按 Content-Transfer-Encoding 分 base64/quoted-printable/raw；QP 剥 `=EF=BB=BF` BOM、`=XX` 十六进制解码。
- **dy-r3-captcha-aes**：captcha 模块 AES 加解密。
- **via-r3-trampoline**：Trampoline intent 路由分发。

### 3. 检验能力
hard 位级算法逆向（LZX：3-bit/24-bit 字段、Huffman、fall-through）· MIME 解码逻辑 · intent 路由分发追踪 · 大混淆库里靠 `compiled from:` 注释+字面量锚点定位。

### 4. 表现（组件计分卡）
**4 题全 HIT、全出结论、exit=0**：

| 题 | 判分 | steps | cache均/低 | max_ctx | 计分 |
|---|---|---|---|---|---|
| chm-r3-1 (hard LZX) | **9/10** | 4 | 75/51% | 7.8k | hops=0 |
| chm-r3-2 (MHT) | **5/7** | 5 | 81/57% | 4.5k | dedup=1 |
| dy-r3-captcha-aes | **8/9** | 8 | 79/56% | 7.9k | explore_nudge=1 |
| via-r3-trampoline | **5/5** | 9 | 82/73% | 5.8k | dedup=1, explore_nudge=1 |

组件评分：SWA ✅（cache 51-82%）· ctx ✅（4.5-7.9k）· 收尾 ✅（4/4 结论）· 工具层 ✅（dedup 触发 2 次=去重守卫工作）· 探索 ✅（4-9 步，explore_nudge 2 次帮换策略）· 正确性 ✅（含 hard 9/10）· **Ledger hops ⚠️**（chain 题 hops=0：模型没按"跳N: A→B"格式写，promote 抽不到——见下）。

### 5. 优化后改进如何
**无新缺陷需修**（4/4 HIT，含 hard 题）。**积累的一致性观察**：多轮下来 hops 计数不稳（有时过度抽取如 R1 的 19、R2 的 10，有时 chain 题 hops=0）——因为它依赖模型自觉按固定格式写台账行，而模型格式随机。**但这从不影响结果**：真正起效的是 ledger **自动**抽取的 reads/greps（系统维护、不靠模型自觉）+ 收尾安全网。hops 只是"锦上添花"信号。

### 6. 优化方法
无代码改动。**结论沉淀**：hops 的可靠性天花板受限于"指望模型按格式写"，不值得为它调参。真正的收尾判据应更多依赖**系统自动量**(reads/greps 增长、progress stall)而非 hops——这已在 stall 止损（用 reads+greps+hops 之和）里部分做到。R1-R3 三轮验证：**preflight 修复 + SWA + 自动记账 + 收尾安全网 = 跨 5 个 app(CHM/抖音/Via/NP)、13 题全 HIT 的稳定底座**；hops 噪声是已知 benign 边界。

---

## 第 4 轮（2026-07-11）：NP apksig/dexlib2 + 抖音 telecom + CHM 书签 —— 进度停滞止损首次 live 触发

### 1. 为什么出题
NP 里 Google 原版 apksig/dexlib2（去混淆、原名保留）是干净格式常量目标；抖音 telecom 一键取号 XOR+Base64；CHM 书签 JSON 持久化。测格式常量精确读取 + 弱混淆变换逆向 + 文件持久化路径追踪。

### 2. 解法（ground truth）
- **np-r4-zip-eocd**：`C7414`（apkzlib EOCD 解析），magic 101010256(0x06054b50)，"records split in multiple disks" 处比对 disk-count vs total-records。
- **np-r4-dex-endian**：`DexUtil.m56073`，endian tag 305419896(0x12345678)=接受、2018915346=big-endian 拒、其余 InvalidFile。
- **dy-r4-telecom-packstring**：`TeleUtils.packString` 每字节 XOR 0x9D(-99) + Base64。
- **chm-r4-bookmark-persist**：BookmarkManager JSON 持久化到 getExternalFilesDir/bookmarks。

### 3. 检验能力
格式魔数/常量精确读取（apksig EOCD、dex endian tag）· 位运算变换逆向（telecom XOR）· 文件持久化路径追踪 · 抗混淆（NP 自身混淆但 bundled 库干净）。

### 4. 表现（组件计分卡）
**4 题全 HIT、全出结论、exit=0**：

| 题 | 判分 | steps | cache均/低 | max_ctx | 计分 |
|---|---|---|---|---|---|
| chm-r4-bookmark | 5/6 | 15 | 87/68% | 9.6k | nudges=1（断链防护触发仍收尾）|
| **dy-r4-telecom** | 8/11 | 11 | 83/64% | 8.3k | **stall=1 forced=1（进度停滞止损触发）** |
| np-r4-zip-eocd | 6/6 | 3 | 69/50% | 2.8k | 秒定位 |
| np-r4-dex-endian | 7/7 | 3 | 74/59% | 2.6k | 秒定位 |

组件评分：SWA ✅（cache 50-87%，chm-bookmark 87% 很高）· ctx ✅· 收尾 ✅（4/4）· **止损 ✅ 首次实测**（dy-telecom stall+forced 正常介入并产出结论）· 断链防护 ✅（chm-bookmark nudges=1）· 正确性 ✅.

### 5. 优化后改进如何
**无新缺陷需修**。关键正向验证：**进度停滞硬止损（stallCap=3，前轮为修 resume 300s 墙钟加的）首次在真实运行中触发**——dy-telecom 原地打转时被及时 forced 收尾、仍产出 8/11 的结论。连同 R2 的收尾安全网 #6，两个"兜底安全网"都已 live 验证有效。

### 6. 优化方法
无代码改动。**里程碑**：R1-R4 共 17 题跨 CHM/抖音/Via/NP 四 app**全 HIT**；两个安全网（收尾拼图 #6、进度停滞止损）+ SWA 稳定前缀（cache 稳定 50-95%）+ 自动记账 + preflight 修复，构成稳定底座。截至 R4 唯一持续 benign 弱点=hops 计数噪声（不影响结果）。R6 起转压力题（长链/多读/强噪）主动逼下一个真弱点。

---

## 第 5 轮（2026-07-11）：NP apksig-block/BER + Via 下载文件名 + 抖音青少年口令 —— 止损守卫再触发

### 1. 为什么出题
NP bundled apksig 的 APK Signing Block 定位（魔数 'APK Sig Block 42'）+ ASN.1 BER 位运算解码；Via 下载文件名 MIME 扩展名覆盖；抖音青少年模式口令本地变换（square+XOR-5+hex）。

### 2. 解法（ground truth）
- **np-r5-apksigblock**：`ApkUtilsLite.findApkSigningBlock`，magic LO=2334950737559900225('APK Sig ')/HI=3617552046287187010('Block 42')，24 字节 footer @ cdOffset-24，头尾 size 一致性校验。
- **np-r5-berencoding**：`BerEncoding` getTagClass=(b&255)>>6、getTagNumber=b&31、ID_FLAG_CONSTRUCTED=32、SEQUENCE=16/SET=17。
- **via-r5-dlfilename**：下载文件名按 MIME 覆盖扩展名。
- **dy-r5-teenmode-passcode**：青少年口令 square+XOR-5+hex 变换后送 checkTeenagePassword。

### 3. 检验能力
64-bit 魔数常量精确读取 + size 一致性算术（apksig）· 位运算解码全套（BER）· MIME→扩展名映射 · 多步数值变换逆向（teenmode）。

### 4. 表现（组件计分卡）
**4 题全 HIT、全出结论、exit=0**：

| 题 | 判分 | steps | cache均/低 | max_ctx | 计分 |
|---|---|---|---|---|---|
| np-r5-apksigblock | **10/10** | 3 | 76/61% | 2.6k | 秒定位 |
| np-r5-berencoding | 8/10 | 2 | 53/53% | 2.6k | |
| via-r5-dlfilename | 8/10 | 6 | 73/58% | 11.6k | 上下文较大 |
| **dy-r5-teenmode** | 5/8 | 13 | 86/56% | 8.6k | **stall=1 forced=1**，hops=2 **✓2**（全核验）|

组件评分：SWA ✅（53-86%）· ctx ✅（2.6-11.6k）· 收尾 ✅· **止损 ✅ 再次触发**（dy-teenmode）· 探索 ✅· 正确性 ✅.

### 5. 优化后改进如何
**无新缺陷需修**。**新发现的一致模式**：抖音的**变换/加密逆向题**（R4 telecom、R5 teenmode）**都触发进度停滞止损**——模型倾向死磕字节级精确操作而原地打转，止损守卫每次都及时兜底并产出部分可接受答案（8/11、5/8）。这是安全网**按设计工作**，非缺陷；但揭示这类题接近本地 35B 的能力天花板。dy-teenmode 的 hops=2 **✓2**（100% 交叉核验）是本轮 Ledger 质量最好的一次。

### 6. 优化方法
无代码改动。**结论**：止损守卫在"接近能力天花板的硬逆向题"上是高频且有效的兜底（R4/R5 各触发一次，均产出结论未空转）。这类题不该继续加难（会变不可达），而应作为"能力边界标定"保留。

---

## 第 6 轮（2026-07-11）：压力题（长链/多读/强噪）—— 逼出 forcedFinish「只劝不强制」真缺陷

### 1. 为什么出题
前 5 轮"够得着"题基本全过=在验证不在找问题。本轮**主动出压力题逼弱点**：NP v2 签名 6 跳长链（跨 5 类 + jadx 反编译陷阱）、CHM 需读 8+ 类的解压全链、抖音强噪音（309 个同名 d.java）设备注册缓存链。仍守"够得着"底线（起点高区分度锚点）。

### 2. 解法（ground truth）
- **np-r6-v2sign（hard 6跳）**：`generateApkSignatureSchemeV2Block`→`computeContentDigests`→`computeOneMbChunkContentDigests`→lambda→`ChunkDigester.run`（逐块哈希），分块 1048576 字节，chunk 前缀 0xa5、顶层前缀 0x5a（藏在 `SocksProxyConstants.V4_REPLY_REQUEST_GRANTED`=90）；JCA 名经 `getContentDigestAlgorithm`→`getJcaMessageDigestAlgorithm`="SHA-256"。
- **chm-r6-compressed-entry（hard 多读）**：CHMContentProvider→ChmDocument→HeaderITSF/ITSP→ChunkPMGL→DirectoryEntry→LZXCoder 取条目内容全链（需读 8+ 类）。
- **dy-r6-deviceregister（hard 强噪）**：`device_parameters.dat` 起点，DES 加密缓存链 + key 推导 + 责任链编排（309 个同名类里精确锁定）。

### 3. 检验能力
超长链保持（6 跳/5 类）· 多类聚合（8+ 类）· 反编译噪音陷阱（0x5a 被误配成 SocksProxyConstants，须点常量定义）· 海量同名类精确抗噪定位。

### 4. 表现（组件计分卡）
| 题 | 结果 | steps | cache | 关键 |
|---|---|---|---|---|
| **np-r6-v2sign** | ❌ **exit=124 超时 / 0/12 / 无结论** | 15→墙钟 | — | **forcedFinish 后仍 grep→撞墙** |
| chm-r6-multiread | ⚠️ 2/19（有结论）| 11 | 85% | stall=1 forced=1，reads=3（该读8+类）|
| dy-r6-deviceregister | ✅ **14/16** | 8 | 79% | hops=6 **✓5**，309 同名类精确定位——**抗噪极强** |

组件评分：抗噪 ✅（dy-r6 14/16）· SWA ✅· **止损/收尾 ❌ 在长链上失效**（np-r6 forcedFinish 未能真终止）· 多类聚合 ⚠️（chm-r6 只读 3 类就被止损，能力/参数边界）。

### 5. 优化后改进如何（发现并修 1 真缺陷）
**缺陷 C：forcedFinish「只劝不强制」→ 长链硬题撞墙钟。**
- 现象（np-r6 v1 遥测铁证）：step13 exploration 升级触发 forcedFinish（注入"停止探索、不要再调用工具"），但 35B **无视指令**，step14-15 继续 grep（greps 12→15）、ctx 涨到 18.8k，直到 480s 墙钟被杀 → exit=124、0/12、无结论、无 scorecard。
- 根因：`forcedFinish` 仅注入一条消息（劝告式），循环仍执行模型请求的工具。听话模型 OK，不听话的小模型跑飞。
- 修复（A/B）：同题 v2 **exit=0、done(18步)、10/12、有结论、budget 6869/80k**（vs v1 超时 0/12）。
- **诚实边界**：v2 scorecard 显示 forced=0——本次模型自己连出了链路，**强制终止路径未被 live 复现**，10/12 含非确定性成分。但缺陷由 v1 遥测确证，修复逻辑有界（见下）。

### 6. 优化方法（`src/agent.ts`）
`forcedFinish` 从劝告式改为**强制式**：进入 forcedFinish 后，模型若仍返回 tool_calls，一律**拒执行**并回喂"工具已禁用，立即输出 ## 最终结论"；且加 `maxForcedSteps=2` 硬上限——强制收尾后至多再 2 步不落结论就 `emit('done','forced_finish_exhausted')` 直接终止。**逻辑保证**：任何原因的强制收尾（探索卡/stall/budget/ctx）此后至多 maxForcedSteps 步必终止，与模型是否听话无关——根治撞墙钟。

**里程碑**：R6 是首个"压力诊断轮"，成功逼出并修复长链硬缺陷。**能力边界标定**：35B 在"够得着"题（≤4跳、起点明确）稳定全 HIT；6 跳长链/8+类多读处于能力边缘（靠安全网兜底出部分答案）；强噪音抗干扰能力强（14/16）。

---

## 第 7 轮（2026-07-11）：长链复测 + 逼出 grep 空转逃过 stall 的缺陷

### 1. 为什么出题
复测 R6 修的 forcedFinish（NP sourcestamp 5 跳硬链）+ NP verity Merkle 树 + Via readaloud 音频设备移除链 + CHM MultiPartsURL。看长链修复实效 + 继续找边界。

### 2. 解法（ground truth，节选）
- **np-r7-sourcestamp（hard 5跳）**：verifySourceStamp→读 "stamp-cert-sha256" 条目→V2SourceStampVerifier.verify（block id 1845461005）→verifyV2SourceStamp→verifySourceStampCertificate（对证书 DER 算 SHA-256，Arrays.equals 比对）。
- **np-r7-verity**：VerityTreeBuilder，SHA-256/4096 分块，salt 前置，自底向上零填充，根哈希取前 4096 字节。
- **via-r7-readaloud**：onAudioDevicesRemoved→dispatch ReadAloudReceiver.PAUSE→onStartCommand→pause（保留可续，非清空）。
- **chm-r7-multiparts**：MultiPartsURL 按 "::" 分隔解析 MS-ITS URL。

### 3. 检验能力
长链保持（sourcestamp 5跳）· fs-verity 算法 · 音频回调→receiver→service 链 · URL 分段解析。

### 4. 表现（组件计分卡）
| 题 | 结果 | steps | cache | 计分 |
|---|---|---|---|---|
| chm-r7-multiparts | 5/5 | 3 | 76% | wrap=1, hops=7 **✓7**(全核验) |
| **via-r7-readaloud** | ❌ **exit=124 超时/3/6** | 17→墙 | — | **grep 空转（reads 卡3十步、每步+1grep）逃过 stall** |
| np-r7-verity | 7/8 | 2 | 52% | 秒定位 |
| **np-r7-sourcestamp(hard 5跳)** | ✅ **8/8** | 12 | 85% | 325s 干净 done，hops=8 |

亮点：**5 跳硬链 8/8 干净通过**（R6 担心的长链已不是问题）。缺陷：via-r7 medium 题超时。

### 5. 优化后改进如何（发现并修 1 真缺陷）
**缺陷 D：grep 空转逃过 stall 检测 → 撞墙钟。**
- 现象（via-r7 v1 遥测铁证）：reads 从 step8 卡在 3 整整 10 步不动，但 greps 每步 +1（3→10）；模型反复搜定位不到的 `o.a.l` 目标空转。stall 守卫进度标量 = reads+greps+hops，**每步新 grep 就算"有进展"→ stall 永不触发**；exploration 升级又差一点（toolCallTotal 13<阈值16）→ 无安全网 → 撞 480s 墙、0 结论。
- 修复（A/B）：同题 v2 **done(14步)、6/6、有结论**（vs v1 超时 3/6）。
- **诚实边界**：v2 scorecard forced=0——本次模型改为持续读文件（reads 3→8）而非空转，**grep 空转止损路径未被 live 复现**，6/6 含非确定性成分。缺陷由 v1 遥测确证，修复逻辑有界。

### 6. 优化方法（`src/agent.ts`）
加**只看 reads+hops 的 grep 空转止损**：连续 `readHopStallCap=5` 步没读进任何新代码、也没连出新跳（哪怕每步 +grep）→ 判定"搜不到目标空转"，强制收尾。与原 stall（reads+greps+hops 全冻结，stallCap=3）正交，专堵"每步换 grep 逃过 stallCap"。配合 R6 的 forcedFinish 强制化，保证任何空转最终必终止、产出报告，不再撞墙钟。

**元结论（R6+R7）**：两个安全网修复的失败模式都由 v1 遥测确证，但因 temp>0 单次 A/B 无法可靠复现触发路径（重跑模型"恰好更好"）；其价值是**有界兜底保证**（最坏必终止）而非"每次触发"。这是本地小模型测优的固有限制，如实记录。

---

## 第 8 轮（2026-07-11）：引入 modv6（MT MOD 变体，第 5 个 app）—— 广度验证

### 1. 为什么出题
前 7 轮覆盖 CHM/抖音/Via/NP。引入 **modv6**（MT2.14.5 第三方 MOD/重打包版，21980 文件）验证机制在"被修改/重打包"的代码上也成立，扩到第 5 个 app。

### 2. 解法（ground truth）
- **via-r8-download-notif-trampoline**：下载通知 → trampoline → service 链。
- **dy-r8-deeplink-userprofile**：AdsAppActivity.b() 按 URI host=user + path=/profile/ 分发到 UserProfileActivity，uid 取自 URI。
- **modv6-r8-axml-flag-decode**：AttributesExtractor.decode() FLAG 类型按值**降序**迭代、`(value&key)==key` 位测、`^=key` 清位、`|` 分隔；表来自 /a_mod/attrs.xml。
- **modv6-r8-stringfog-xor**：StringFogImpl decrypt = Base64.decode(flag2 NO_WRAP) 后 XOR（key="UTF-8"，重复循环），对称编解码。

### 3. 检验能力
deeplink URI 分发追踪 · AXML FLAG 位运算解码 · 重复密钥 XOR+Base64 编解码逆向 · **重打包/MOD 代码泛化**。

### 4. 表现（组件计分卡）
**4 题全 HIT、全出结论、exit=0**：

| 题 | 判分 | steps | cache | 计分 |
|---|---|---|---|---|
| via-r8-download-notif | **4/4** | 5 | 80% | hops=5 |
| dy-r8-deeplink | **6/6** | 5 | 75% | |
| modv6-r8-axml-flag | 5/9 | 4 | 78% | 核心对,细节位操作词漏 |
| modv6-r8-stringfog | 4/9 | 2 | 74% | 核心对(UTF-8+Base64+XOR),细节漏 |

组件评分：SWA ✅（74-80%）· ctx ✅· 收尾 ✅（4/4）· 正确性 ✅（全 HIT，核心逻辑对）· 无安全网触发（都顺利）。

### 5. 优化后改进如何
**无新缺陷**。**广度里程碑**：跨 app 泛化扩到第 5 个 app（含重打包 MOD），机制不过拟合。一致能力画像再确认：**抓主逻辑准，穷举细节（9 关键词里的细枝末节）偏弱**（modv6 两道 5/9、4/9，但核心算法都对）——这是 35B 能力特征，非缺陷。

### 6. 优化方法
无代码改动。**阶段小结（R1-R8，32 题跨 5 app）**：4 个真修复（preflight 深递归 / Ledger 语义键去重 / forcedFinish 强制化 / grep 空转止损）+ 3 层安全网（stall / grep空转 / forcedFinish 有界终止）+ SWA 稳定前缀（cache 稳定 48-95%）+ 组件计分卡埋点，构成对本地 35B 稳健的逆向 agent 底座。能力边界清晰：≤4 跳/明确起点稳过、5 跳硬链可过、8+ 类多读与穷举细节是天花板（靠安全网兜底出核心）、强噪音抗干扰强。

---

## 第 9 轮（2026-07-11）：压力（难定位/深多读）—— 安全网 live 验证 + Defect E(shell导航误杀) + 能力边界

### 1. 为什么出题
继续压力路线找边界：NP **难定位** hook 引擎（在 Pine/SandHook 两个第三方框架干扰中，找 np.* 自研的单字母类 np.lsp.a）、CHM **深多读** 压缩读取链（需读 6+ 类）、Via 够得着对照。

### 2. 解法（ground truth）
- **np-r9-hookengine（hard 难定位）**：grep `native.*Member` → 3 候选(Pine/SandHook/np.lsp.a)，按包名排除两个第三方 → np.lsp.a(doHook/doUnhook/initHook + m42207 工厂 + m42208 trampoline)。
- **chm-r9-compressed-read-chain（hard 深多读）**：ChmDocument→HeaderITSF/ITSP→ChunkPMGL/PMGI→DirectoryEntry→FileControlData→LZXCoder 取压缩条目全链。
- **via-r9-search-widget**：SearchWidget→Shell→vURL 加载。

### 3. 检验能力
干扰中精确定位（3 候选排 2）· 深多类聚合（6+ 类）· 组件链追踪。

### 4. 表现（组件计分卡）
| 题 | 结果 | steps | cache | 计分 |
|---|---|---|---|---|
| chm-r9-deepread | **15/23** | 7 | 72% | **reads=9**(读9类) hops=13**✓8**——比 R6 的 2/19 大改善 |
| **via-r9-widget** | 5/6 | 12 | 84% | **stall=1 forced=1 live 触发, 228s 干净终止(未撞墙)** |
| **np-r9-hookengine** | ❌ **0/7** | 7 | 89% | reads=0 greps=0, forced；模型只 ls 不 grep/read |

### 5. 优化后改进如何
**里程碑1 — 安全网 live 验证**：via-r9 **首次在真实运行中触发 stall+forcedFinish 并干净终止**（228s 出 5/6 结论，未撞 480s 墙）——补上了 R6/R7 之前因非确定性没能 live 复现的验证缺口。**证明有界兜底真的有效。**

**里程碑2 — Defect E（shell 导航被 stall 误杀）已修**：
- 现象（np-r9 v1）：模型用 `shell ls sources/`→`ls np/` 合法导航(方向对,看到 lsp/)，但 stall 进度标量只算 reads+greps+hops、**不算 shell** → reads+greps+hops 冻结 → 误判空转 → step6 强制收尾 → 0/7。
- 修复：把**去重后的成功 shell 命令数**计入 total-freeze stall 进度（新目录 ls=进展）。A/B：v2 total-freeze 不再误触发（改由 grep-spin 正确兜底）。

**能力边界（诚实）**：np-r9 v2 仍 0/7——修复让 shell 导航不被误杀，但**模型本身在这道"干扰中定位"硬题上策略就错了**：7 步全 `shell ls`，从头到尾没 grep/没 read 任何候选类，始终没从"列目录"过渡到"读代码"。这是 35B 的能力天花板，harness 正确地有界兜底（grep-spin→forced→出结论→无超时），但答案错。**不是 harness 能修的缺陷。**

### 6. 优化方法
- **Defect E 修复**（`src/agent.ts`）：新增 `shellCmdsSeen` Set，成功 shell 调用去重计数，计入 total-freeze stall 的 `progress = reads+greps+hops+shellCmdsSeen.size`。grep-spin 守卫(reads+hops)保持不变作为"只探不读"的兜底。
- **coherence 修**（审计发现）：wrap-nudge（"评估是否收尾"软提示）加 `!forcedFinish` 守卫——已强制收尾时不再发软提示，避免与 forcedFinish 硬指令信号打架 + 白耗一步。
- **守卫组合审计结论**：所有置 forcedFinish 的守卫(stall/grep空转/探索升级/ctx硬停/wrap-nudge)均 gated `!forcedFinish`；forcedFinish 强制执行 maxForcedSteps=2 有界；maxSteps=30 终极上界。无死循环、无冲突。

**R1-R9 阶段总账（35 题跨 5 app）**：5 个真缺陷修复（preflight 深递归 / Ledger 语义键去重 / forcedFinish 强制化 / grep 空转止损 / shell 导航计入进度）+ coherence 修 + 3 层有界安全网(live 验证)。能力边界清晰：**够得着题(≤4跳/明确起点/1-2候选)稳定全 HIT；深多读(6-9类)可达 15/23；强噪音抗干扰强(14/16)；"多候选精确排除定位"是天花板(np-r9 0/7)；穷举细节偏弱**。

---

## 第 10 轮（2026-07-11）：引入 mtmod（第 6 app）+ Defect F（未读码就下结论）+ 确定性守卫测试突破

### 1. 为什么出题
引入 **mtmod**（MT 另一个 MOD 变体，22783 文件）到第 6 个 app。mtmod 有道翻译加解密 + VIP 协议门控（native 校验，只读理解，不构造绕过）；抖音 ttplatform 授权；Via readaloud 音频自动暂停。

### 2/3. 解法与能力（略，见 bank-round10.json）
mtmod 有道：C12344.m27613，sign=MD5("client=...&key=yU5nT5dK3eZ1pI4j")，响应 AES/CBC/PKCS5Padding，key/iv=MD5(aesKey)/MD5(aesIv)。mtmod VIP：C14722.m32202，FTP 恒免费，C3607.m9888()(native) 是 VIP 门。

### 4. 表现（组件计分卡）
| 题 | 结果 | steps | 计分 |
|---|---|---|---|
| mtmod-r10-02 VIP门控 | **9/10** | 4 | reads=2 读码后答对 |
| via-r10-readaloud | 6/11 | 11 | stall+forced live 触发,270s 干净终止 |
| dy-r10-ttplatform | 5/17 | 5 | concl=False(有内容无「##最终结论」头,hops=0 wrap-net未兜——软miss,不影响判分) |
| **mtmod-r10-01 有道** | 4/10 | **1步!** | **reads=0 greps=0——没读一行码就下结论(凭先验蒙)** |

### 5. 优化后改进如何（发现并修 Defect F + 确定性验证突破）
**缺陷 F：逆向 agent 未读码就下结论（幻觉风险）。**
- 现象（mtmod-r10-01 v1）：模型 1 步、0 工具调用、没 grep 没 read 任何代码，直接凭"有道翻译=MD5+AES"通用先验输出结论，蒙对 4/10。对逆向 agent 是危险幻觉（该核实的没核实）。
- 修复：no-tool-call 收尾前，若全程 `toolCallTotal===0` → nudge 一次"先 grep/read_file 核实源码再下结论"（一次性，不听则有界放行）。
- A/B：v2 拿 **10/10**（真去 grep webfanyi + read C12344/C5642）——但诚实说 v2 模型这轮自己就先 grep 了、守卫**未 live 触发**（同 R6/R7 非确定性）。

**🎯 里程碑 — 确定性守卫测试（`scripts/test-guards.ts`）**：
R6/R7/R10 三个安全网修复，live A/B 因 temp>0"模型碰巧更好"**始终无法可靠复现触发路径**。破法：**手搓最小 LanguageModelV3（绕开 ai/test 的 zod/v4 依赖坑）+ 注入 Agent，脚本化失败行为**，确定性断言守卫：
- Defect F：0 工具下结论 → "先读码核实"提醒**必触发、只一次、仍有界收尾** ✓✓✓
- R7 grep 空转：每步只 grep 不 read → 空转止损**触发** ✓
- R6 forcedFinish：其后模型仍要工具 → **工具硬禁(forced_finish_tools_disabled) + <15 步有界终止(maxSteps=25 内)** ✓✓
- **7/7 通过**。彻底补上 live A/B 复现不了的验证缺口——守卫的触发+有界终止现在有**确定性证明**。

### 6. 优化方法
- **Defect F**（`src/agent.ts`）：`noInvestigateNudged` 一次性守卫，toolCallTotal===0 收尾前 nudge 读码核实。
- **确定性守卫回归测试**（`scripts/test-guards.ts`）：mock V3 model 脚本化 Defect F / grep空转 / forcedFinish 场景，7 断言。以后改这些守卫必跑此测试防回归。
- **诚实元结论定案**：本地 temp>0 单次 live A/B **不适合验证"失败模式触发"**（重跑常表现更好）；正解是 **mock-LLM 确定性单测**。live A/B 只适合看"稳定下限/outcome 改善"。这条方法论已补进 [[agent_test_harness_method]]。

**R1-R10 总账（40 题跨 6 app）**：6 真缺陷修复（preflight深递归 / Ledger语义键去重 / forcedFinish强制化 / grep空转止损 / shell导航计入进度 / 未读码下结论）+ coherence 修 + 3 层有界安全网（确定性测试 7/7 证明）+ SWA 稳定前缀。demo.sh 5/5 + test-resume 7/7 + test-guards 7/7 无回归。

---

## 第 11 轮（2026-07-11）：NP v4/fs-verity 硬链 —— 安全网多次 live 验证，收敛无新缺陷

### 1-3. 题目
NP apksig **v4/fs-verity 验证链**(V4SchemeVerifier.verify→parseAndVerifySignatureBlock→verifyRootHashAndTree→computeChunkVerityTreeAndDigest，5跳，比对 Merkle 根哈希)；抖音 TTToken 内容加密；CHM 最近打开列表(MRU)持久化。

### 4. 表现（组件计分卡）
| 题 | 结果 | steps | cache | 计分 |
|---|---|---|---|---|
| **np-r11-v4-fsverity(hard 5跳)** | **6/6** | 11 | 81% | hops=14 **✓13**, explore_nudge=2, **forced=1(live 触发仍拿满分)** |
| chm-r11-mru | 5/11 | 8 | 80% | **stall=1 forced=1(live 触发,198s 干净终止)**, reads=0 greps=6(只搜不读被兜) |
| dy-r11-tttoken | 5/5 | 8 | 80% | reads=4 干净 |

### 5. 优化后改进如何
**无新缺陷（收敛信号）**。关键：**安全网又两次 live 验证**——np-r11 硬 5 跳链上 forcedFinish 触发(explore_nudge×2 升级)后**305s 干净终止且拿 6/6 满分**（追对链路+优雅收尾）；chm-r11 stall+forced 触发后 198s 干净终止出部分答案。**均无超时**。连同 R9 via-r9、R10 via-r10、确定性 test-guards 7/7，安全网的"有界终止"已在实战 + 单测双重反复证明。

### 6. 优化方法
无代码改动。**收敛判定**：R10 Defect F 后连续一轮(R11)3 题全 HIT、无新缺陷、安全网多次优雅兜底——6 个缺陷修复后系统进入稳态。R11 的 np-fsverity 6/6(hard 5跳)是硬链能力的又一强证。

**R1-R11 总账（43 题跨 6 app）**：6 真缺陷全修 + coherence 修 + 3 层有界安全网(实战+确定性单测双证) + SWA 稳定前缀。demo/resume/guards 三套回归全绿。**优化已收敛**：够得着题稳过、硬链可过(含 6/6)、能力天花板(多候选定位/穷举细节)由安全网优雅兜底出核心答案、绝不超时/跑飞。

---

## 第 12 轮（2026-07-11）：新任务类型（native 边界 / 枚举 / 持久化）—— 诚实性 + 广度

### 1. 为什么出题
前 11 轮以链路追踪为主。第 12 轮换**新任务类型**探未测维度：native 边界题(测**诚实性**：是否如实标注"需 frida/动态"而非幻觉 .so 内部)、枚举题(测**广度**：列全某集合)、持久化子系统理解题。

### 2/3. 题目与能力
- **via-r12-enum-download-actions**（enumerate）：列全 DownloadService.onStartCommand switch 的 5 个 action 常量。测穷举完整性。
- **mtmod-r12-native-exec-pty**（native-boundary）：MT 终端 Java→native 边界(Exec.createSubprocess→libterm.so)。测诚实标注。
- **dy-r12-keva**（persistence）：抖音 Keva 键值存储 SP 迁移决策 + value tag 方案 + 单进程写去重。测深理解。

### 4. 表现（组件计分卡）
| 题 | 结果 | steps | 计分 |
|---|---|---|---|
| via-r12-enum | **5/5** | 2 | 秒枚举全集 |
| mtmod-r12-native | 7/9 | 11 | FORCED；**诚实标注 native/frida/.so 不幻觉** ✓，但漏定位 Exec/createSubprocess |
| dy-r12-keva | 7/11 | 7 | stall+forced 兜底，深理解题部分覆盖 |

### 5. 优化后改进如何
**无新缺陷**。**关键正向发现**：native 边界题上 agent **诚实守住红线**——命中 native/frida/动态/.so/libterm/loadLibrary，明确说"真实逻辑在 .so、静态读不到、需动态分析"，**没有幻觉编造 .so 内部**（守住"只读分析不瞎编"）。枚举题 5/5 说明广度任务也 OK。mtmod-native 漏定位 Exec = 定位 partial（非缺陷；后由卡住求助功能验证：给思路后 3/9→9/9）。

### 6. 优化方法
无代码改动。**新类型验证**：agent 不只会链路追踪，枚举/native边界/持久化理解都能做；且 native 边界诚实性经受住考验。

---

## 新功能：卡住求助 / 思路反馈机制（2026-07-11，用户需求）—— 端到端验证成功

### 需求
35B 在难题上原地打转时，不再"强制猜答案收尾"，而是**停下、输出详细困境报告**；用户把报告交给更强的模型取得思路，反哺给 rev-agent 按思路续跑。

### 实现（`--ask-when-stuck`，默认关，不影响自动化/CTF harness）
- **agent.ts**：三套卡住守卫(stall/grep空转/探索连不出第一跳)触发时，`stuckIntervene()` 三选一——
  - `continue`：TUI 有 askStrategy 回调且拿到思路 → 注入+重置卡住计数，会话内续跑；
  - `stop`：--once 无回调(haltWhenStuck) → 设 stuckHalted、输出困境报告、exit=3 等外部；
  - `forced`：未开/超 maxEscalations(3)/无思路且非halt → 回退原强制收尾。
- `buildStuckReport()`：目标+已走步数/工具数+已确认跳(renderChainGraph)+调查足迹(render)+卡点+求助指引。
- **两种反哺**（用户要求都实现）：
  - **TUI 粘贴**：run-interactive 的 strategyChannel（复刻 approvalChannel）——报告显示在消息流，输入框切"🆘粘贴思路"模式，回车 resolve 续跑，/skip 放弃。
  - **--once 命令行**：卡住 exit=3 + 报告写 `<notes>.stuck.md`；重跑 `--once --strategy "<思路>"` 前置注入思路按此分析。
- **确定性单测**（`scripts/test-guards.ts`，16/16）：stuck 事件+报告、思路注入重置续跑、maxEscalations 上限、上限后回退有界、--once haltWhenStuck→stuckHalted+stuck_halt。

### 端到端 live 验证（我 Opus 扮演"更强模型"给思路）
| 题(app/失败模式) | run1(--ask-when-stuck) | run2(--strategy 反哺) |
|---|---|---|
| np-r9 hook引擎(NP/多候选难定位) | exit=3、**0/7**、只 ls 不 read | **7/7 满分**、3步直读 np/lsp/a.java |
| mtmod-r12 终端(mtmod/Java→native边界) | exit=3、**3/9**、找到 Exec 但卡住 | **9/9 满分** + 诚实标注 native/frida/libterm/.so |

**结论**：思路反馈闭环把 35B 独立做不出的硬题(0/7、3/9)经一轮人类+强模型介入变满分(7/7、9/9)，且 run2 均在 ~3 步按思路直达目标文件。机制可行、高效，且不牺牲诚实性（native 边界如实标注、不幻觉 .so 内部）。这是"小模型能力天花板"问题的实用解法——不再靠猜，而是把困住的点精确外包给更强模型。
