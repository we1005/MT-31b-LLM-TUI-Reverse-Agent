# moded APK 破解审计 · 方法论与套路总纲

> 面向**小参数本地大模型**(rev-agent / Qwen 32B 级)做安卓 mod-APK 只读取证审计时的**操作主脑**。从 99 个真实被 mod 的 APK 审计中蒸馏。深挖细节见同目录 5 份专题(文末「延伸阅读」)。
>
> **合规铁律**：纯只读、防御/取证视角。本文只教「**如何认出被攻破的手法 + 如何加固**」，**不含**可照做的再破解步骤 / patch 脚本 / 绕过配方。定位到破解点=为了重建攻击面与加固，不是给复制配方。

---

## 0. 一句话心法

> **先用文件名和证书"猜"，再用 grep"验"，遇到原生化/加固/注入就"诚实止损"——绝不据"没搜到"断言"没有"。**

小模型最容易犯的两个错：① 只试 `isVip` 一个锚点就放弃；② grep 不到就幻觉"无破解"。本总纲的一半篇幅在治这两点。

---

## 1. 整体流程(七步)

```
① 元数据      aapt dump badging → 包名/版本/大小；读文件名解码线索
② 签名证据    apksigner verify --print-certs → 证书 DN(→猜作者)、v1/v2/v3、原签名是否被破坏
③ 反编译      apktool d（超时/失败→ unzip + baksmali/strings 兜底）
④ 分流        按"破解类型"(文件名标签)选 grep 方向，别盲搜
⑤ 定位 or 止损 命中→读方法体确证；干净得反常→怀疑原生化/注入→查 .so/manifest→承认静态上限
⑥ 推断工具    从指纹推 apktool/MT/NP/LSPatch/Dex2C/云镜…，诚实区分[确证]/[推断]
⑦ 产出        四段式：破解点 / 手法 / 调用链 / 加固；末尾列证据与不确定性
```

---

## 2. 开局速判(最省工作量的三张表)

### 2.1 文件名解码 — 动手前先定目标
文件名几乎总编码了 `应用名 版本 破解类型-作者`：

| 标签 | 破解目标 | 先查方向 |
|---|---|---|
| 会员版 / VIP版 | 会员解锁 | isVip/isMember/getMember/会员缓存字段 |
| 专业版 / 高级版 / Pro | Pro 解锁 | isPro/isPremium/产品类型枚举默认分支 |
| 去广告版 / 免广告版 / 无广告 | 去广告 | 广告 SDK 入口(见 §4-⑦)或注入 Hook |
| 解锁版 / 解锁完整版 | License 绕过 | checkLicense/licensing 服务端网关方法 |
| 纯净版 | 去推广/更新弹窗 | 多为注入模块或资源开关 |
| 内置X模块 / 漫游 / 猪手 | 注入 Xposed/LSPatch 模块 | manifest 注入痕迹 + Hook 引擎 so |

作者在末尾 `-作者` / `_作者` / `_@作者`；无作者尾缀(如"…-无广告")多为渠道随手重打包。

### 2.2 证书 DN → 作者/手法 速查(看签名就先猜到一半)
`apksigner verify --print-certs` 的证书主体常直接暴露作者与惯用手法：

| 证书 DN / 别名 | 作者 | 惯用手法(先入为主再验证) |
|---|---|---|
| CN=lushu | 鹿蜀 | apktool + 云镜/爱加密 **Dex2C 原生化**隐藏 patch |
| CN=zhou (v1+v2+v3) | zhou45 | **NP管理器 Apk-Dex2C** 把改动方法原生化(libstub.so) |
| CN=editor / AOSP 测试证书 | NURIK | apktool 中心判定方法**恒真化** |
| CN=rockz5555 / Droid Freedom / C=LK | Balatan | isPremium 恒真 / 产品类型 NONE→PRO 单常量 |
| 伪 O=Google / CN=youarefinished | youarefinished | **ApkSignatureKillerEx + libyrf.so** 绕签名自校验 |
| CN=笙 | 黯笙 | MT管理器 KillerApplication + 会员 getter 恒真 |
| CN=Cxapk | 辰夕(Cxapk 工具链) | Epic 壳 + libcxapkmod.so **ART Hook** 运行时改判定 |
| 占位证书跨多 App 复用 | Kunkka | **LSPatch 集成 Xposed 模块**(微博猪手 / B站漫游) |
| @𝑷𝑱𝑨𝑷𝑲 / @PJAPK | (渠道水印,非个人) | 混合，多为注入或纯净重打包 |

> 速查表完整版 + 更多作者见 [攻击者画像专题](安全审计-攻击者画像-模组作者与工具链.md)。

### 2.3 一眼止损信号
见到以下任一 → 具体 patch 大概率在 native，**静态到界**，别死磕 smali：
`libstub.so` / `.source "YJ-Dex2C"` / `yjaq.xyz`(云镜) / `libcxapkmod.so` / `assets` 里 `.Epic` 或非标准头 dex 分片 / 爱加密 `ijiami` / 360 `com.stub.StubApp`。

---

## 3. 核心机制速查(认出它 → 知道静态能走多远)

| 机制 | 静态指纹(grep 锚点) | 静态上限 |
|---|---|---|
| **重签重打包** | 原签名 META-INF 缺失/被换；证书 DN=作者；zip 时间戳被统一 | 无(签名信息完全可读) |
| **签名校验绕过** | `ApkSignatureKillerEx` / `bin.mt.signature.KillerApplication` / `com.srpatchv3` / `libyrf.so`；Application `.super` 指向 Killer 类 | 可确证"注入了绕过模块"；说明 App 本有自校验 |
| **判定恒真化** | 方法体 `const/4 v0,0x1; return`；三元 `?true:true`；读了 `getBoolean` 却弃用返回值(弃读孤儿) | 可确证(纯 smali 可读) |
| **方法原生化(Dex2C)** | smali 方法标 `native` + 对应 .so；libstub/云镜/Cxapk 指纹 | ⚠️ **到界**：native 内逻辑读不出 |
| **免 Root 注入模块** | manifest `appComponentFactory` 被改；`*InitProvider`(高 initOrder)；LSPatch 元数据；`liblshook/libpine/liblsplant/libEpic` | 能定位"注入了什么、从哪引导"；Hook 目标常需动态 |
| **加固壳** | 爱加密/360/云镜；真 dex 运行时才释放 | ⚠️ 到界：需脱壳 dump |
| **去广告** | 见 §4-⑦ 两条路 | 静态删=可读；运行时 Hook=部分到界 |

> 每种机制的原理、确证判据、样本见 [攻击机制图谱专题](安全审计-攻击机制图谱-签名绕过与注入与原生化.md)。

---

## 4. 按破解类型的排查方向(命中率排序 + grep 锚点)

**通用铁律：判定方法名随 App 变，别只试一个词，一次多试一组。**

- **① 会员/VIP**：`isVip|isMember|isVjp|getMember|getVipInfo|USER_IS_VIP|会员|isSvip` → 命中读方法体，看四套路(恒真/三元/弃读孤儿/深一两跳)。也常改 `SharedPreferences` 缓存字段。
- **② 高级/Pro**：`isPro|isPremium|isPlus|isGold|hasPremium|isPurchased|productType|entitlement` → 注意"产品类型枚举默认分支 NONE→PRO"这种单常量改法。
- **③ 解锁完整/License**：`checkLicense|checkLicenseOnBackend|verifyLicense|licensing|isLicensed` → 攻击者爱挑**最底层服务端校验网关**或**旧版遗留链路**入口恒真；注意"异常/未授权→默认放行"的 fail-open 收敛出口。
- **④ 去广告**：见 §4-⑦。
- **⑤ 注入模块**：先看 manifest `appComponentFactory`/`*InitProvider`，再看 `lib/*` Hook 引擎 so；原广告/付费组件仍在却失效 = 运行时 Hook。
- **⑥ 纯净版**：找推广 WebView / 公众号引导 / 强更弹窗被 Hook 或删；多与注入模块同源。

**§4-⑦ 去广告两条路**(37/99 是去广告,必须会分)：
- 路 A 静态摘除：grep 广告 SDK 包名 `pangle|bytedance|gdt|qq.e.ads|admob|gms.ads|gromore|topon|mintegral|Splash|Interstitial` → 看是否被 no-op/删组件/改开关。
- 路 B 运行时 Hook：广告组件仍在但被注入框架 Hook 空跑 → 走 §4-⑤。
- **先判走哪条**：manifest 广告组件在不在 + 有无注入框架指纹。

> 完整决策树 + 每类锚点清单见 [破解类型与排查方向专题](安全审计-破解类型与排查方向.md)。

---

## 5. 攻击者通用流水线(重建攻击面用)

```
反编译(apktool/jadx/MT管理器/NP管理器)
  → patch 授权(恒真/删校验/产品类型改写) 或 去广告(SDK no-op / native 化)
  → [可选] 注入 LSPatch/Xposed 模块 + Pine/LSPlant/Epic ART Hook
  → [可选] Dex2C 原生化 / 加固壳(云镜·爱加密·360) 隐藏改动、规避静态
  → 重打包 → 破坏原签名、换作者自签证书、补 v2/v3(部分配 ApkSignatureKillerEx 绕自校验)
  → 分发
```

---

## 6. 静态上限与止损铁律(治幻觉)

1. **"grep 不到" ≠ "不存在"**：先自问是不是被原生化/加固/注入了(§2.3 指纹)。
2. 命中原生化/加固/VMP/运行时 Hook → **如实写"改动已原生化/在壳内/运行时 Hook，纯静态不可还原"**，给出你**确证**到的边界(注入了什么、从哪引导),把"具体逻辑"标为需动态。
3. 宁可交回一个诚实的"静态到此为界 + 已确证的机制",也不要编一个看似完整的调用链。**审计的可信度来自诚实标注 [确证]/[推断],不是来自"看起来查全了"。**
4. 栈识别别自负：见到 `libil2cpp/libapp.so/index.android.bundle` 分别是 Unity/Flutter/RN,业务不在 dex(见 rev-agent 内置 playbook)。

---

## 7. 产出模板(四段式 + 证据)

```
## 破解点复现   定位到 类.方法 或 资源 + 手法 + 调用链(分点)
## 攻击者工具与流程   从指纹推断,逐条标 [确证]/[推断]
## 加固建议   客户端 / 服务端 / 发行 三类
## 证据与不确定性   哪些确证、哪些没看实、静态上限在哪
```

---

## 8. 加固主线(防御方,五条)

1. **权益判定上移服务端**：会员/订阅/Pro/广告开关最终裁决在服务端,客户端仅凭**短时效签名令牌**展示 → 杀死"单点恒真化/改缓存即全解锁"。
2. **签名完整性多源校验且参与业务解密**：别只信 `getPackageInfo(GET_SIGNATURES)`(已被 KillerApplication 式 Hook 绕过);native 直接解析 v2/v3 签名块,**校验结果参与解密而非仅 if**。
3. **运行时反 Hook/反注入自检**：扫 `/proc/self/maps` 找 `liblshook/libpine/liblsplant/libEpic`;查 `appComponentFactory` 被劫持、`.super` 异常、Xposed/LSPatch 类可 `Class.forName`、伪装系统包名 Provider。
4. **加固壳 ≠ 防篡改**：本批大量样本证明壳挡不住"不碰加密 dex、纯内存 Hook"的绕过;须与签名校验 + 反 Hook + 服务端裁决协同。
5. **默认分支 fail-closed** + 发行侧 Play Integrity/拒绝非原签名包下发内容。

> 按弱点分类的完整对策 + 优先级见 [加固对策手册](安全审计-加固对策手册.md)。

---

## 9. 独到经验 / 常见误判(教训)

- **看证书就动手**：DN 一出，作者、惯用工具、大概率手法(恒真化 vs 原生化 vs 注入)基本定了,省一半盲搜。
- **同应用多版本 / vN 后缀是不同样本**：`去广告版` vs `去广告版v2`、`5.3.0` vs `5.6.0` 别混。
- **"专业版/绿化版"未必真改了业务**：有的只是重签瘦身;若本体计费/广告代码没动、又发现注入框架,结论要**审慎**(可能运行时解锁),别下"未破解"死结论。
- **强 App 越依赖 native 化/注入**：静态能全读的多是中小 App;头部 App(微博/B站/喜马拉雅/墨迹)几乎都靠 Dex2C/加固/Hook,静态只能到机制层。
- **签名绕过与会员恒真常成对**：见到 KillerApplication,多半同包还有权益恒真;反之亦然。

---

## 延伸阅读(同目录专题)
- [攻击者画像 — 模组作者与工具链](安全审计-攻击者画像-模组作者与工具链.md)
- [攻击机制图谱 — 签名绕过/注入/原生化](安全审计-攻击机制图谱-签名绕过与注入与原生化.md)
- [破解类型与排查方向(决策树)](安全审计-破解类型与排查方向.md)
- [加固对策手册](安全审计-加固对策手册.md)
- [apk-2 99 样本聚合分析](安全审计-apk-2-99样本聚合分析.md)

> 运行时:rev-agent 已把本总纲的核心套路作为 `crack-audit / mod-sig-bypass / mod-native-hidden / mod-inject-module / mod-adfree` 等 **seed playbook**(硬信号触发、只作参考 context)内置注入,见 `src/playbook.ts`。
