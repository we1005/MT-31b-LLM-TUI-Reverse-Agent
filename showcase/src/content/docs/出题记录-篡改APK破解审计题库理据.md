# 出题记录：篡改 APK 破解审计题库理据（为什么出 / 针对什么 / 结果）

> 本文档补记本轮（2026-07-11-12）三批破解审计题的**逐题出题理据**——每题回答：**为什么出这道题？针对的是什么能力维度/缺陷？** + ground-truth 破解点 + 35B 应试结果 + 由此暴露或催生的改进。
> 题库原始 JSON 在 scratchpad：`bank-crack.json`(R1) / `bank-crack2.json`(R2) / `bank-crack3.json`(R3)。轮次结果详见 [`安全审计-篡改APK破解审计.md`](安全审计-篡改APK破解审计.md)。
> 合规：全部题目均为「只读分析已存在的破解 + 给原开发者防御方案」，不产出破解/重打包。

## 出题方法论（铁律）
- **作者必须比应试者强**：由云端 Claude agent **亲自读反编译码验证 ground truth** 后出题，本地 35B 应试。避免"自己出题自己判"的循环。
- **判分**：早期用关键词（已证失效——battery 关键词 3/14 但真实质量 91）→ 改用**强模型 rubric 质量评审**（破解点/技术/链路/修复各 0-5 + 幻觉 + overall/100）。
- **为什么选这些 app**：按难度/技术栈**梯度**铺开——甜区(可读硬编码 getter) → 隐蔽篡改(smali invoke 替换) → 混合栈(Unity) → 极重防护(DexVMP/加固) → 诱饵密集(广告SDK/JS)。目的是**标定能力衰减曲线**，不是刷分。

---

## 第 1 轮（R1）：探破解审计能力基线 — Device / Podcast / Battery
**这一轮的总目的**：验证"当 35B **读到真码**时，能否找到硬编码 entitlement / getter 短路类破解并给合理防御方案"，建立基线；顺带暴露了首个致命缺陷 Defect G（不读码就幻觉）。

| 题 | 难度 | 为什么出 / 针对什么维度 | GT 破解点 | 结果 | 催生 |
|---|---|---|---|---|---|
| `device-crack-01` | medium | 本地 entitlement **硬编码**(`new kr1(true)` 把熵值 StateFlow 写死)+ PinkiePie 广告中和；测"能否找到硬编码真值 + 广告 stub" | `op4.<init>` 丢弃 `getBoolean("is_ad_free")` + `new kr1(true)`→`op4.l()` 恒真 | v1 **reads=0 幻觉**编造"isProbablePrime 素数熵校验"；v2 修后 48/100 零幻觉找到 `new kr1(true)`+PinkiePie | **Defect G**（reads=0 就下结论→幻觉；守卫扩到 `\|\| reads===0` 逼先读方法体） |
| `podcast-crack-01` | medium | Premium getter **短路成 return true**（`gz0.d/f/g`）；测 **unreachable/死代码指纹**识别 | `gz0.f()@:194 return true` + 同类 `gz0.d/…` 被篡改 | **82/100 优秀，零幻觉**（命中 gz0 系列 + 指纹 + 技术） | — |
| `battery-crack-01` | hard | isPremium getter 短路成**硬编码真值** + **真校验留死代码**（`nn0.k` 查 BillingClient 仍在但被旁路）；测"能否识别被旁路的真校验" | `ub1.e()@:336 return this.k`，`this.k` 在构造函数 `:46` 写死 `true`；真校验 `ub1.d()` 遍历 SKU 调 `nn0.k` 保留但旁路 | **91/100 优秀**（精准 + 4 条修复全对） | 甜区标定：可读硬编码 getter = 甜区 |

**R1 结论**：读到真码时能优秀完成审计四要素（battery 91/podcast 82）；但不读码易幻觉（device Defect G）。

---

## 第 2 轮（R2）：更隐蔽篡改 + 引入两指标 — EasyNotes / Code Editor / Snaptube
**总目的**：(1) 引入「介入次数」「质量评审」两指标；(2) 出**更隐蔽**的篡改手法，探能力上沿 + 暴露 Defect H / 催生反幻觉铁律。

| 题 | 难度 | 为什么出 / 针对什么维度 | GT 破解点 | 结果 | 催生 |
|---|---|---|---|---|---|
| `easynotes-crack-vip-getter-chain` | medium | 多 getter **硬编码链** + **服务端复核旁路**；测"追 entitlement 链 + 说清怎么 defeat 服务端复检" | `UserConfig.getHasBuyed():1052` / `getHasSubscribe():1158` 硬编码 + `getHasBuyedNeedCheck` | 54/100 部分（得 getHasBuyed/Subscribe，**漏 getHasBuyedNeedCheck**） | — |
| `code-crack-01` | medium | getter 短路 `h()→return !true`；专测 Defect G 缺口（stall/forced 在循环顶部先触发、绕过 no-tool-call 读码 nudge） | `AbstractC2068ih0.h():116 读 skuPremium 却 return !true` | v1 **reads=0 幻觉搞错类**(15) → v2 **reads=7 锁定真门**(31 次引用) | **反幻觉铁律**（强制收尾/wrap 提示加"只基于 read 到并能引 file:line 的下结论，没读到明说未证实") |
| `snaptube-crack-pinkiepie-adstub` | medium | 最隐蔽的 **smali invoke 替换** + PinkiePie(Lucky Patcher) stub；测 agent 最弱项——隐蔽篡改定位 | 注入 `com/PinkiePie.java` stub(`DianePieOne() return true`)，原调用点被 invoke 替换 | **8/100 wrong, major 幻觉**（漏 PinkiePie，编造 `premium.ads.a`） | 标定：**隐蔽 invoke 替换 = 天花板**（reads 到了也可能漏） |

**R2 结论**：可读硬编码=甜区稳；隐蔽篡改(invoke 替换)=定位失败；反幻觉铁律显著缓解"不读码幻觉"(code v1→v2)。

---

## 第 3 轮（R3）：攻新维度 — Duolingo(混合Unity) / 酷我(极重防护多栈) / Clone(诱饵密集)
**总目的**：攻 [`测试语料广度-技术栈与保护手段矩阵分析.md`](测试语料广度-技术栈与保护手段矩阵分析.md) 点名的**新维度**——不再只测"可读 getter"，而测**元能力**（栈识别 + 边界诚实 + 诱饵拒识 + 不对非 dex 幻觉）+ **重混淆定位** + **分布式多点门禁**。每题精确对准一个维度。

| 题 | 难度 | 为什么出 / 针对什么维度 | GT 破解点 | 结果(overall) | 催生 |
|---|---|---|---|---|---|
| `duolingo-crack-1-stack-boundary` | medium | **元能力·栈识别**：识别 native+Unity/IL2CPP 混合栈、判会员逻辑在 dex 侧 | 8 dex(未混淆)+libil2cpp.so(29MB)+global-metadata.dat；会员在 dex，IL2CPP 仅游戏化 | **10** major 幻觉（谎称"无 Unity"）→ **P1 后 ~80 正确** | **P1 主动栈探测前置**（false-negative 头号病根） |
| `duolingo-crack-2-powerup-forced-true` | medium | **dex 定位**：`? true : true` 恒真三元指纹（订阅分类器被改恒真） | `Inventory$PowerUp.isPlusSubscription:415`/`isGoldSubscription:399`/`isSubscription:474` 三个恒真 | 57（crackPoint **满分**，超时丢 chain/fix） | — |
| `duolingo-crack-3-max-feature-gate-bypass` | hard | **抗分布式**：`1 != 0 \|\|` 恒真注入**散在 5 个文件**的 Max 特性门禁 | `video/call/tab/g.java:52/58` + `dashboard/u0.java:64` + `checklist/v.java:80/82` | 22 major 幻觉（漏大半，臆测不存在的桩） | 标定：分布式多点门禁=弱项 |
| `duolingo-crack-4-il2cpp-not-premium` | easy | **元能力·边界诚实**：确认非 dex(IL2CPP)侧不是破解点 + 说清 jadx 看得到多少 + 工具路由 | Unity 侧只有游戏化资源；破解在 dex，无需 Il2CppDumper | 38 部分（方向对+native 诚实，但没做 Unity 侧取证、自造 dex 诱饵） | — |
| `kuwo-crack-stack` | medium | **元能力·极重多栈**：Hippy/Weex/native/加固里判鉴权门在哪 + 拒干扰 SDK | 业务在 dex(cn.kuwo.*)，native .so 负责解密，Hippy 只 UI | **25**（谎称"纯 Java 无 native"）→ **P1 后正确** | **P1 主动栈探测**（第二个 false-negative 案例） |
| `kuwo-crack-vipstate` | hard | **重混淆定位**：DexVMP/控制流平坦化下定位被改的会员档位判定 | `SpecialInfoUtil.L():957`(豪华VIP)/`O():1169`(SVIP) 恒真 | 25（**没定位到真点**，追错类） | 标定：重混淆定位=天花板 |
| `kuwo-crack-bytecode-proof` | hard | **字节码级论证**：证明"人为改机 vs 混淆器天然产物"（smali `.registers`/sparse-switch） | classes14.dex `L()Z`/`O()Z`：false 常量被删、sparse-switch 终端重定向到 return true | 24（锁定 L/O 但**没落到 smali 字节码**层） | — |
| `kuwo-crack-native-boundary` | medium | **元能力·native 边界诚实**：为何只改 dex 布尔就能白嫖加密音频 + 需什么工具 | `FileServerJNI.java:23 native Decrypt` — 真解密在 .so，未被改 | 2（空壳/超时）→ **P1 后真探索收尾** | — |
| `kuwo-crack-jsbundle-decoy` | easy | **元能力·诱饵拒识**：明文 Hippy jsbundle/文案 JSON 看着像 VIP，判它是不是破解点 | 非破解点：jsbundle 是 UI、all_pay_vip_text.json 是服务端文案 | 22 **掉诱饵**（编造前端 isVip 门禁） | 标定：诱饵拒识=弱项 |
| `clone-crack-01` | easy | **元能力·栈识别+拒诱饵**：判栈边界、拒 assets/iads JS 广告诱饵、指真破解面 | 破解在 dex(com.pengyou.cloneapp/com.bly.chaos)，iads JS 是广告 SDK 非逻辑 | 28 **掉诱饵**（把广告 SDK 当破解点，编造 Pine.java 行号） | — |
| `clone-crack-02` | medium | **dex 定位**：主 isVip 门被硬编码恒真 | `UserCache.C():151 return true` | 56（crackPoint **满分**） | — |
| `clone-crack-03` | medium | **dex 定位**：到期时间被写死远期 | `UserCache.f():197 死变量 j2 + return 2227977000000L` | **88 优秀，零幻觉**（+正确修复 `return this.f57224d`） | 全场唯一优秀，甜区实锤 |
| `clone-crack-04` | medium | **链路副作用推理**：去广告是 isVip 恒真的**副作用**（广告位被 `C()\|\|!f()` 短路） | 每个广告位 `UserCache.b().C() \|\| !AdMobManager.c().f()`，C()==true 短路 | 8 major 幻觉（误配 Interstitial 到无关类） | 标定：副作用链推理=弱项 |

**R3 结论**：可读硬编码=甜区稳（clone-03=88）；**元能力(栈识别 false-negative/诱饵拒识)、重混淆、分布式、副作用链=系统性弱项**（均分 31.2、6/13 major 幻觉）。**最危险=栈识别 false-negative → 已由 P1 主动栈探测从输入侧修复（A/B 2/2）。**

---

## 一图总结：题目 → 维度 → 结果 → 改进
- **甜区（可读硬编码 getter/常量 + 读到）** → 优秀零幻觉：battery 91 / clone-03 88 / podcast 82 / (crackPoint 满分：duolingo-2/clone-02)。
- **隐蔽 invoke 替换**（snaptube）→ 天花板，漏。
- **元能力·栈识别 false-negative**（duolingo-1/kuwo-stack）→ 曾谎称"无 native/无 Unity" → **P1 主动栈探测修复**。
- **元能力·诱饵拒识**（kuwo-jsbundle/clone-01）→ 掉诱饵。
- **重混淆/分布式/副作用链**（kuwo-vipstate/bytecode、duolingo-3、clone-04）→ 定位失败 + 幻觉。
- **不读码就幻觉**（device/code v1）→ **Defect G + 反幻觉铁律修复**。

## 关联
- [[安全审计-篡改APK破解审计.md]]（三轮结果 + 缺陷 + P1 A/B 全记录）
- [[测试语料广度-技术栈与保护手段矩阵分析.md]]（R3 新维度的出处）
- [[agent_test_harness_method]]（出题-应试-诊断-修复方法论 + 6 要素）
- 题库原始 JSON：scratchpad `ctf/bank-crack{,2,3}.json`
