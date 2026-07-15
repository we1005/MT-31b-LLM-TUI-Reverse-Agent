# MT 管理器"一键过签名校验" · 机制逆向与正向实现路径

> 从 `work/` 下已反编译的 **MT 管理器本体**(`mt-jadx`/`mt-apkt`)+ **真实注入产物**(`_scratch/apk-2-decomp/Lite-Writer轻羽写作/`,即被 MT 一键处理过的样本)逐字节逆向,印证并修正此前"MT 是轻量静态去校验"的说法。
>
> **合规立场**:防御/取证向。讲清"这套机制由哪些部件构成、每步在做什么、怎么在样本里认出它、防御方怎么检测和加固"。**不提供针对任意目标 APK 的可复用一键破解脚本/patch**;下文"正向实现路径"是**逆向还原出的工程构成**(理解+检测+加固用),非操作教程。

---

## 0. 一句话结论(已被真实字节证实)
**MT 的"一键去签名校验" = 纯静态改包**:把一份**预置的模板 dex**(`bin.mt.signature.KillerApplication`,源自开源 `L-JINBIN/ApkSignatureKillerEx`)注入目标,用**改一个类的 `.super`(移花接木)**让它在进程启动时自动执行,靠**Java 反射伪造 PackageManager 返回的签名** + **(可选)native 层 hook `open/openat` 把"读自身 APK"重定向到内嵌原版**两层达成绕过。全程 apktool 式解包→塞文件→改 `.super`→重打包重签,**产物落地即成品,无需任何运行时框架**——这正是它和 LSPatch(运行时注入 Xposed)的本质区别。

---

## 1. MT 本体侧证据(`mt-apkt` / `mt-jadx`)

### 1.1 预置的加密模板资产
`mt-apkt/assets/` 里有成套 killer 载荷,按 ABI 分开 + 一份 dex:
```
killer_dex   (12,828 B)   ← bin.mt.signature.KillerApplication 模板(编译好的 dex)
killer_arm / killer_a64 / killer_x86 / killer_x64   ← 各架构的 native 载荷(libSignatureKiller)
```
它们都以统一头 `fb 61 62 b8` 打包加密(`strings` 无明文;padding 区出现 `5b5b5b5a`/`d9d9d8d8` running-key 残影 → MT 自有的位置相关 XOR 封装)。**含义:MT 不是现场写代码,而是"注入一份编译好的成品模板"** —— 这就是"一键"之所以快的原因。

### 1.2 注入时的 `.super` 描述符重写(移花接木的执行者)
`mt-jadx/sources/l/C9734.java`(混淆合成类)的 `mo3388`:
```java
if (!str2.startsWith("Lbin/mt/signature/KillerApplication")) return str2;   // 只处理这个描述符
StringBuilder sb = new StringBuilder();
sb.append(str.substring(0, str.length() - 1));
return C12851.m29260(35, str2, sb);   // 35 = "Lbin/mt/signature/KillerApplication".length();剥掉前缀,拼到新宿主包
```
`C12851.m29260(i,str,sb) = sb.append(str.substring(i))`。合起来:**在改写某个类的父类描述符时,识别到 `Lbin/mt/signature/KillerApplication` 就把它嫁接进目标自己的类继承链**。这就是下文注入产物里 `.super` 被改的那一步的代码来源。

---

## 2. 注入产物解剖(实证:Lite Writer 被 MT 处理后的 smali)

### 2.1 模板类 `smali_classes6/bin/mt/signature/KillerApplication.smali`(逐字段实锤)
注入到**最后一个 dex(classes6)**,原样保留 ApkSignatureKillerEx 的结构:
- 静态常量 `URL = "https://github.com/L-JINBIN/ApkSignatureKillerEx"` —— **直接坐实模板出处**。
- `<clinit>`(类初始化即执行)干两件事:
  ```
  const v0, "core.writer"                 # ← 目标包名,注入时写死
  const v1, "MIIDdz...(base64)..."         # ← 目标"原厂"签名证书(DN: O=DrkCore),注入时写死
  killPM(v0, v1)                           # 第一层:Java 反射
  killOpen(v0)                             # 第二层:native 文件重定向
  ```

### 2.2 接线方式:改 `.super`,不改 manifest(关键)
- manifest 里 `android:name` **仍是目标自己的** `core.writer.App`(没动)。
- `core.writer.App` `.super = androidx/multidex/MultiDexApplication`(目标原本就用 MultiDex)。
- **`androidx/multidex/MultiDexApplication.smali` 的 `.super` 被改成了 `Lbin/mt/signature/KillerApplication;`** ← 移花接木点。
- `KillerApplication.super = android/app/Application`。

于是继承链变成:
```
core.writer.App ─▶ MultiDexApplication ─▶ [bin.mt.signature.KillerApplication] ─▶ android.app.Application
                                          └ 注入者插进来的一环
```
进程启动加载 `App` → 逐级初始化父类 → **`KillerApplication.<clinit>` 自动触发**。选 `MultiDexApplication` 当嫁接点很聪明:几乎所有 App 都在用它当基类,改它的 `.super` 比改 manifest 更隐蔽(manifest diff 为 0)。

### 2.3 第一层 `killPM`:Java 反射伪造签名(本例实际生效的一层)
1. 用写死的 base64 原厂证书 `new Signature(...)`,包成自定义 `KillerApplication$1`(一个假的 `PackageInfo.CREATOR`)。
2. 反射把 `android.content.pm.PackageInfo.CREATOR` 替换成这个假 CREATOR → 之后任何 `getPackageInfo(..., GET_SIGNATURES)` 反序列化出来的都是原厂签名。
3. `SDK_INT >= 28`:调 `org.lsposed.hiddenapibypass.HiddenApiBypass.addHiddenApiExemptions({"Landroid/os/Parcel;","Landroid/content/pm","Landroid/app"})` 绕开隐藏 API 限制。
4. 反射清三处缓存强制重走:`PackageManager.sPackageInfoCache.clear()`、`Parcel.mCreators.clear()`、`Parcel.sPairedCreators.clear()`。

### 2.4 第二层 `killOpen`:native 文件重定向(模板在,本例载荷缺 → inert)
模板逻辑:`System.loadLibrary("SignatureKiller")` → `getApkPath()` 读 `/proc/self/maps` 定位运行中的 `base.apk` → 从自身 `assets/SignatureKiller/origin.apk` 抽出**内嵌的干净原版**写到 `/data/data/<pkg>/origin.apk` → 调 native `hookApkPath(当前apk, origin)` PLT-hook `open/openat` **把对自身 APK 的读透明重定向到原版**,专治"不走 PackageManager、自己读 APK 字节/签名块校验"。
**但本样本实测**:`lib/` 里 12 个 .so 无一名 SignatureKiller,`assets/SignatureKiller/` 空、无 `origin.apk` → `loadLibrary` 落到 `catchall_6` 打印 "Load SignatureKiller library failed" 后 `return`。**即 Lite Writer 这例只有 killPM(Java 反射)真正生效,killOpen 是模板自带但空转**。含义:MT 一键可**按需**只上 Java 层(目标只做 PackageManager 校验时),要打 native 自校验时才附带 `killer_<abi>` + 内嵌 origin.apk。

---

## 3. 为什么这是"静态去校验"(对比 LSPatch)
| | MT 一键 | LSPatch |
|---|---|---|
| 改动形态 | 静态改包:+1 模板 dex、改 1 处 `.super`、(可选)+1 so + 内嵌 origin.apk | 注入整套 Xposed 运行时(liblspatch.so+loader dex+metaloader) |
| 触发 | 继承链 `<clinit>` 自然触发,无框架 | 运行时 hook 框架加载 |
| manifest | `application` name **不改**(只改中间类 `.super`) | `appComponentFactory` 被换成 `LSPAppComponentFactoryStub` |
| footprint / 隐蔽性 | 小、干净、静态特征集中在一个模板类 | 大、`assets/lspatch/` 目录明显、易检测 |
| 载体 | 手机端 MT app 一键(PC 需手动套模板) | PC jar 一条命令 |

→ **"MT 是轻量静态去校验"成立**;区别不在"是否一键",而在"静态改包 vs 运行时注入框架"。

---

## 4. 等效正向实现路径(逆向还原出的工程构成)
把上面拆出来的部件按顺序串起来,就是 MT 一键背后的五步流水线(**理解/检测/加固视角**,非操作指南):
1. **解包**:apktool 式 decode 目标 APK(拿到 smali + manifest + 原签名证书)。
2. **注入模板 dex**:把预置的 `KillerApplication` 模板作为新 dex 加入;把**目标原厂证书 base64 + 目标包名**填进模板的 `<clinit>` 两个常量。
3. **(可选)native 层**:目标若有自读 APK 的 native/完整性校验,再放 `libSignatureKiller.so` 到各 `lib/<abi>/`、并把**原版 APK 内嵌**为 `assets/SignatureKiller/origin.apk`。
4. **移花接木**:在目标 Application 的继承链上挑一个稳定中间类(常见 `MultiDexApplication`),把它的 `.super` 改写指向 `KillerApplication`(= §1.2 那段重写逻辑)。**不动 manifest 的 application name**。
5. **重打包重签**:rebuild + 用**任意新 key** v1/v2 重签(签名本身变了没关系——绕过的正是"校验签名变没变")。

**难点全在"预置好的模板 + 那份原厂证书"**:模板是通用的,证书是每个目标各自的(注入时从原包 META-INF 提取)。这也解释了为什么 PC 端"没有好用的一键"——你得先有干净原版取证书 + 一份维护良好的模板,而现代 v2/v3/native 自校验让老模板批量失效(见《签名校验绕过·开源工具全景》)。

---

## 5. 取证检测指纹(看到即高度可疑)
- 类 `bin.mt.signature.KillerApplication` + 常量 `URL="https://github.com/L-JINBIN/ApkSignatureKillerEx"`;内嵌一段 base64 X.509 证书 + 方法 `killPM`/`killOpen`/`hookApkPath`/`getApkPath`/`isApkPath`。
- **继承链异常**:某个系统/androidx 基类(如 `MultiDexApplication`)的 `.super` 指向 `bin/mt/signature/*`(而非 `android/app/Application`)——**manifest 却看不出问题**,必须查 `.super` 链。
- `org.lsposed.hiddenapibypass` 出现;native 侧 `libSignatureKiller.so`(或改名 `libyrf.so`/`bin.ghost` 变体)、导出符号 `hookApkPath`、内嵌 `assets/SignatureKiller/origin.apk`(包体里有第二个完整 APK)。
- MT 本体特征(判定"这是 MT 干的"):`assets/killer_dex` + `killer_arm/a64/x86/x64`,统一头 `fb 61 62 b8`。

## 6. 加固(治本,呼应《加固实施清单》)
1. **别只信进程内 `PackageManager`**:killPM 就是伪造它。要多源交叉——同时 native 直读自身 APK 的 v2/v3 签名块字节 + PackageManager 结果,不一致即异常。
2. **native 直读这一路会被 killOpen 重定向**:检测 `open/openat` 是否被 hook(读 `/proc/self/maps`、校验 libc 首字节);且别只做"读文件比对"(本地任意执行下终可被 IO 重定向绕过——本质限制)。
3. **让校验结果参与业务解密 + 绑定服务端 nonce**:把"绕过校验"变成"解不出内容/服务端不认",而不是跳过一个布尔。这是同时对抗 killPM + killOpen 的唯一根。
4. 加运行时反 Hook/反注入自检(上述注入指纹固定);发行侧 Play Integrity + 服务端交叉。

## 7. NP 管理器(诚实说明 + 何时需要动态分析)
NP(`np-jadx`/`np-apkt`)**没有**像 MT 那样把 ApkSignatureKillerEx 模板作为明文/可辨识资产 bundle:其代码/资产高度混淆(`main.jar` 6704 项单字母类名、`assets/` 下 `a/o/p/...` 混淆目录),静态未暴露 `KillerApplication`/`sPackageInfoCache` 等指纹,故**无法从静态证据断言其内部实现**。功能上 NP 同样提供"去签名校验",且属同一 ApkSignatureKillerEx 生态,上述两大机制族与检测/加固同样适用。**要坐实 NP 内部,正确做法不是 hook NP 本体,而是"用 NP 的一键处理一个已知原版 → 抓产物 → 和原版 diff"**(黑盒差分),即可看出它注入了什么、怎么接线——这是纯静态(对产物)就能完成的,不必动态 hook。

## 8. 映射到 99 样本 & 结论
本批已确证的 `KillerApplication`/`srpatchv3`/`bin.ghost`/`libyrf.so`/lsposed hiddenapibypass 指纹,全部对应上述**killPM(Java)+killOpen(native)**两族;Lite Writer 是"killPM-only"的典型(native 空转)。**结论**:MT 一键 = 预置模板 + 移花接木 `.super` + 反射/文件重定向的**静态改包**,footprint 小、静态可检测、对"服务端参与解密"型加固无效——这既印证了此前判断,也说明 §加固清单那套(native 多源校验 + 参与解密 + 服务端 nonce + 反 Hook)是治本方向。

> 证据文件:`work/mt-apkt/assets/killer_*`、`work/mt-jadx/sources/l/C9734.java`+`C12851.java`、`_scratch/apk-2-decomp/Lite-Writer轻羽写作/smali_classes6/bin/mt/signature/KillerApplication.smali`、同目录 `smali/androidx/multidex/MultiDexApplication.smali`(`.super` 被改)。
