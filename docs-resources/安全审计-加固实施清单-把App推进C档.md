# 把你的 App 推进「C 档」— 开发者加固实施清单(代码层)

> 面向 App 开发者的防御清单。基于 99 个真实被 mod 的 APK 得出的残酷事实:**其中 86% 一台 root 手机 + 免费工具(MT/NP 管理器、LSPatch)就能破,破解者甚至不用自己做动态分析**。你的目标不是"不可破"(不存在),而是**把攻击成本从"一键"抬到"要真功夫"**——把攻击者从 A/B 档逼进 C 档(必须脱壳/抓包/源码重编译),让绝大多数作坊放弃。
>
> ⚠️ **本清单经对抗式复核**(对照 99 样本红队检验),已修正两处"看似有效实则一键可破"的常见误区(见 §1、§2 的【反例警告】)——**这正是加固最容易踩的坑:自以为挪到服务端/native 就安全了,其实留了个本地布尔分支或可被文件重定向的读取**。
>
> **合规**:纯防御视角,面向"保护你自己的 App"。配套见 [静态极限与三条路径](安全审计-静态分析的极限与三条逆向路径-新人指南.md) 与 [加固对策手册](安全审计-加固对策手册.md)。

---

## 0. 先记住四句话

1. **客户端没有秘密。** 任何跑在用户设备上的判定,最终都能被读到、改掉或 Hook 掉。
2. **加固是经济学,不是密码学。** 目标是把成本抬过"值得破"的线——把 86% 的作坊挡住就是巨大胜利。
3. **单点加固都会被绕。** 有效的是**服务端 + native + 反Hook + fail-closed 叠加**。
4. **两条铁律贯穿全文**(违反则前功尽弃):
   - **① 别留"可被恒真化的本地布尔分支"**——校验结果必须**参与解密/密钥派生**,而不是 `if (ok) unlock() else lock()`(那一行会被一键改真)。
   - **② 别信"设备本地可离线算出或可被重定向的输入"**——签名哈希是公开可预计算的;读自己 APK 文件会被 `open` Hook 重定向。真正逼到 C 档,靠的是**绑定服务端下发的新鲜值(nonce/挑战)**,让攻击者非抓包+破协议不可。

**攻击者三档(你要把他们往下推):** A 纯静态改(改 smali 恒真/删组件)· B 静态注入现成模块(LSPatch/Pine/签名过验证壳/Dex2C)· C 需真动态(脱壳/抓包/源码重编译)。

---

## 1. 【P0】权益裁决上移服务端 + 结果参与解密 —— 挡 A 档恒真化

**⚠️【反例警告】"挪到服务端"不等于安全——本批真实教训:**
```
本批 Solid Explorer 样本里有个函数就叫 SELicenseManager.checkLicenseOnBackend()
——名字就是"到后端查授权",内部真会请求官方服务器。
但攻击者【没碰网络、没伪造任何服务器响应】,只把它的收敛出口一键改成
const/4 p0,0x1; return p0 —— "服务端裁决"整条链路当场作废。
```
教训:**把"数据来源"挪到服务端,如果最后仍收敛到一个本地 `if/return boolean`,那还是 A 档一键靶子。**

**❌ 错误(仍是本地布尔分支):**
```kotlin
if (verifyEntitlement(token)?.features?.contains(f) == true) unlock(f) else lock()  // 一 NOP 就破
```

**✅ 正确:让权益结果参与"解密真实内容",而不是开关一个布尔。**
```kotlin
// 高级内容/模板/去广告配置本身,以【服务端下发的、与该用户+该次会话绑定的密钥】加密存放。
// 客户端就算把所有 if/else 全 NOP 掉,拿到的仍是密文——没有服务端给的 key 就用不了。
data class Entitlement(val payloadBytes: ByteArray, val sig: ByteArray)  // payloadBytes = 序列化后的 {uid,features,exp,nonce}

suspend fun openPremiumFeature(f: String): Content? {
    val challenge = api.newChallenge()                 // ① 服务端下发一次性 nonce(攻击者无法离线预计算)
    val e = api.fetchEntitlement(f, challenge)          // ② 请求带 nonce,服务端验订阅(Google Play Developer API 校 purchase token)后签发
    if (!Crypto.verifyEd25519(SERVER_PUBKEY, e.payloadBytes, e.sig)) return null
    val payload = parse(e.payloadBytes)
    if (payload.nonce != challenge || payload.exp < serverTimeNow()) return null
    // ③ 关键:用服务端随响应下发的 contentKey 解密真实内容;绕过上面判断也拿不到能解密的 key
    return Crypto.aesGcmDecrypt(key = api.contentKeyFor(f, e), cipher = encryptedAsset(f))
}
```
**为什么把攻击者推到 C**:客户端已无"改一行就解锁"的分支;真实内容是密文,key 只随合法请求(带服务端 nonce、通过订阅核验)下发。攻击者只能去**抓包 + 破服务端协议/伪造带有效签名的响应**(C 档),而服务端验 purchase token,伪造也拿不到真数据。

---

## 2. 【P1】签名完整性校验放 native + 参与解密 —— 挡 B 档签名过验证(但要防两个坑)

**❌ 错误(被 ApkSignatureKillerEx 一键绕):**
```java
// Java 层查签名 → PackageInfo.CREATOR / sPackageInfoCache 被反射 Hook,恒返"原厂证书"。本批 27 例的靶子。
if (!expected.equals(hash(pm.getPackageInfo(pkg, GET_SIGNATURES).signatures[0]))) killMyself();
```

**✅ 改进:JNI 直接解析 APK 的 v2/v3 签名块,且结果参与解密——但必须同时防下面两个坑,否则仍是 B 档可破:**
```c
// ⚠️ 坑A(内存破坏):APK 是攻击者可任意构造的不可信输入。手写解析器必须像处理不可信数据一样
//    做边界检查(size 字段上限、Signing Block 总长与 EOCD 记录一致性),否则畸形签名块(伪造超大/
//    负数长度)会触发越界读/整数溢出,把"加固点"变成你自己 App 里的内存破坏漏洞。对照 AOSP apksig 实现。
// ⚠️ 坑B(killOpen 文件重定向):本批至少 6 个样本(srpatchv3 / libsrpatch.so,与 MT"过签名校验"同源)
//    用 xhook 对 libc open/openat 做 PLT Hook,把"读自身 base.apk"重定向到内嵌的【原版未篡改 APK】。
//    于是你 native 读到的是"原始正确签名",派生出"正确 key",两道防线同时失效——且这是 B 档现成能力,不用逆向。
void derive_content_key(const uint8_t* sig_sha256, const uint8_t* server_nonce, uint8_t* out_key) {
    // HKDF 标准用法:ikm=sig_sha256, salt=固定 App 常量, info=server_nonce(绑定服务端新鲜值)
    // 关键:混入 server_nonce —— 光有(可离线预计算的)签名哈希不够,必须每次向服务端要新鲜值,
    //       才能派生出对的 key。这才真正把攻击者逼到"抓包+破协议"(C 档)。
    hkdf_sha256(/*ikm*/sig_sha256, /*salt*/APP_SALT, /*info*/server_nonce, out_key);
}
```
**要点三连**:① 校验结果**参与解密**(不是 `if(bad) exit()`,那能跳过);② 别只靠"读自己 APK 文件"这一路(会被 `open` Hook 重定向)——要**检测 open/openat 是否被 inline/PLT Hook**(见 §3),并多源交叉;③ **混入服务端新鲜 nonce**,因为签名哈希是任何人从正版包就能离线算出的公开常量,静态提取硬编码进破解版 .so 即可绕,单靠它**不足以**逼到 C 档。

**诚实边界**:做到以上把攻击者从"改 Java 布尔"抬到"要处理 native + 文件 Hook + 服务端协议",门槛大幅提升,**但仍非不可破**(§0 第 2 条)。

---

## 3. 【P1】运行时反 Hook / 反注入自检 —— 挡 B 档注入模块

**先认清局限(本批实测):** 用"固定 .so 名 / 类名正则"做特征库,面对本批真实产物(`libyrf.so`、`libcxapkmod.so`、`libsrpatch.so`、`libajeethk.so`、伪装成 `com.bytedance.shadowhook.*` 的类名)**几乎 0 命中**——攻击者一改名就失效,还容易误伤合法 SDK。所以**别依赖静态特征库,要靠"行为/完整性"信号**:
```kotlin
// 更可靠的信号(不靠 so 名黑名单):
fun injectionSignals(): List<String> = buildList {
    // ① open/openat 是否被 PLT/inline Hook(直接挡 §2 坑B 的 killOpen 文件重定向)——在 native 里查 GOT/首字节
    if (nativeIsSyscallHooked("openat")) add("open-hooked")
    // ② appComponentFactory / Application 父类被"移花接木"(清单外劫持):运行时实际父类 vs 预期
    if (application.javaClass.superclass?.name !in EXPECTED_SUPER) add("super-tampered")
    // ③ 自身 base.apk 的 v2/v3 签名块哈希(native 直读)≠ 预期
    if (!nativeSigMatches()) add("sig-mismatch")
    // ④ ClassLoader 链里有陌生 dex / 清单外注册的伪装系统包名 Provider
    // ⑤ Xposed/LSPosed 桥类可被加载(有则大概率被注入)
}
```
**两条纪律**:① **自检本身要放 native 且参与解密**——纯 Kotlin 写的自检会被同一批 Hook 引擎或 A 档常量 patch 反制(自指问题);② 检测到**不要当场崩**(会被一眼定位绕过),应**静默上报 + 概率性/延迟失效**,并**宁可漏报不可误报**(错杀合法用户比漏掉一个破解更糟)。

**为什么推到 C**:一键套的现成模块被行为信号识别 → 攻击者得改模块、隐藏特征、对抗 native 自检(C 档能力),作坊玩法失效。

---

## 4. 【P2】关键逻辑原生化 + 控制流保护 —— 挡 A 档改 smali

把**权益裁决收敛点、签名校验、密钥派生**用 C/C++ 写进 .so(NDK)+ OLLVM 控制流平坦化 + 字符串加密。Java/Kotlin 层不留可改的判定,只调 native 且**返回密钥而非 boolean**。
**注意**:native 仍可被 Hook(§3 去挡)或逆(C 档);**必须与 §1/§2/§3 叠加**,单独原生化会被内存 Hook 绕(本批多例)。

---

## 5. 【P2】加固壳 —— 有用但别单独指望

商业壳能把"直接读 dex 改"的攻击者逼到"必须脱壳"(C 档)。**但本批证明壳挡不住"不脱壳、纯内存 Hook"的 B 档**——壳必须配 §3 反 Hook 才有意义。别把上壳当终点。

---

## 6. 【P2】发行侧完整性 —— 注意国内生态 GMS 缺失

- **完整性校验放服务端**:非官方签名包 / 完整性失败 → 服务端拒绝下发会员内容与广告配置。
- ⚠️ **Play Integrity API 依赖 Google 服务(GMS)**——本清单场景高度指向**国内安卓生态**(华为/小米/OPPO/vivo/应用宝等大量设备无 GMS)。**别无脑照搬**:在这些渠道上 Play Integrity 要么拿不到结果、要么误伤合法用户。应替换/补充为**厂商完整性服务(如华为 Safety Detect)或自建"设备指纹 + 行为异常检测"**;**"拿不到 Play Integrity 结果" ≠ "完整性失败"**,别据此 fail-closed 锁死正常用户。

---

## 7. 【P0】所有校验 fail-closed(默认拒绝),但留运维告警路径

本批多起破解钻了"异常→默认放行"的空子。
```kotlin
fun gate(state: EntitlementState) = when (state) {
    EntitlementState.GRANTED -> unlock()
    else                     -> lock()   // 网络异常/解析失败/未知 → 锁,绝不 fall-through 到 unlock
}
```
**但**:对"签名块解析不到 / 完整性服务不可用"这类**非常规但可能是合法构建/环境**的情况,要有**独立运维监控告警**,别静默锁死后无从排查(例:某渠道构建漏签 v2/v3,会被 §2 永久锁死)。**前提:强制所有正式渠道构建启用 v2+v3 签名。**

---

## 8. 本批已见、清单必须额外覆盖的攻击面(红队补充)

| 攻击面 | 本批证据 | 对应防御 |
|---|---|---|
| **killOpen 文件重定向** | srpatchv3/libsrpatch.so 用 xhook 重定向 open→原版 APK | §2 坑B + §3① 检测 open/openat 被 Hook |
| **appComponentFactory / .super 移花接木** | 改 MultiDexApplication `.super` 指向注入类,manifest 不变 | §3② 运行时父类核对 |
| **跨端栈(Flutter/Dart AOT、RN)** | 一叶日记等 Flutter App,判定在 libapp.so | 判定逻辑别放 Dart 层可 dump 处;关键仍走 §1 服务端+参与解密 |
| **免 Root 注入(Pine/LSPatch)** | 多例,一台手机即生效 | §3 行为自检 + §4 原生化 |

---

## 9. 优先级 & 「推进 C 档」对照表

| 优先级 | 措施 | 主要挡住 |
|---|---|---|
| **P0** | 权益裁决上移服务端 **+ 结果参与解密 + 绑定 nonce**(§1) | A 档恒真化 + B 档大半 |
| **P0** | 全链路 fail-closed(§7) | "异常→放行" |
| **P1** | native 签名校验、参与解密、防 killOpen、混 nonce(§2) | B 档签名过验证 |
| **P1** | 行为式反 Hook + native 自检(§3) | B 档注入模块 |
| **P2** | 原生化+混淆(§4)/ 加固壳配反Hook(§5)/ 发行完整性(§6) | A 档改 smali / 直接读 dex / 分发 |

| 你实施了(且做对) | 攻击者从 → 被逼到 |
|---|---|
| §1 权益参与解密 + 服务端 nonce | A/B 恒真化拿到的是密文 → **必须抓包 + 破服务端协议**(C) |
| §2 native 校验参与解密 + 防 killOpen + nonce | B 签名过验证/文件重定向失效 → **必须逆 native + 破协议**(C) |
| §3 行为式反 Hook(native) | B 现成模块被识别 → **必须改模块隐藏 + 对抗自检**(C) |

---

## 10. 红线提醒

- **别追求"绝对不可破"**——不存在;追求"把 86% 作坊挡住、成本抬过收益线"。
- **两个致命误区(本批红队实证)**:① "挪到服务端"却仍留本地布尔分支(§1 反例);② native 读自己 APK 却被 open Hook 重定向、或只靠可离线预计算的签名哈希(§2 两坑)。**修法统一是:结果参与解密 + 绑定服务端新鲜值。**
- **服务端才是主战场**——客户端加固是拖延战术;真正拿不走的是"权益裁决 + 真实数据 + 解密密钥都在你服务端"。

> 本清单初稿经 multi-agent 对抗式复核(对照 99 样本),§1/§2 的 high 级技术漏洞已按复核意见修正。
