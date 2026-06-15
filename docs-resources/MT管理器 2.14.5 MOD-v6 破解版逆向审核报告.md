# MT 管理器 2.14.5-clone-MOD-v6-xml-fix-final 破解版逆向审核报告

> **审计方**：原开发者方聘请的 Malware 审核员
> **审计日期**：2026-05-31
> **样本**：`MT管理器_2.14.5-clone-MOD-v6-xml-fix-final.apk`
> **样本 SHA256**：`2837f2a5d8b57778e0d513b51c96701866522ca883d13e972cbb181dec3ef6b0`
> **样本大小**：26.05 MB (27,318,961 字节)
> **官方对照**：MT 管理器 2.26.5 + 2.26.4（CN=bin 签名）
> **作用范围**：仅授权安全研究 — 还原攻击者修改路径、给出防御建议
> **结论先行**：本案是一起**自我反噬**类型的破解 —— 攻击者用 **MT 管理器自带的 AOSP testkey + LSPatch 嵌入式模式** 重新签了 MT 管理器自身，并把另一台**已购 VIP 设备的全套 plugin/javac 数据**整包植入 APK，配合内嵌了 **MT 官方证书副本** 的 `libloader.so` 在 native 层伪造签名校验。技术含量 ⭐⭐⭐ / 5（成熟工具链 + 一些自研 native 拼接）。

---

## 0. 执行摘要

| 维度 | 结论 |
|---|---|
| 是否为破解版 | **是**。签名密钥从 `CN=bin`（MT 官方）替换为 `CN=Android, O=Android` (AOSP testkey, SHA256 `A4:0D:A8:0A:59:D1:70:CA:A9:50:CF:15:C1:8C:45:4D:47:A3:9B:26:98:9D:8B:64:0E:CD:74:5B:A7:1B:F5:DC`) |
| 选定的攻击基线 | **MT 管理器 2.14.5**（versionCode 24011895, 构建于 2024-01-18 22:29） |
| 为什么选 2.14.5 | 该版本**尚未集成** `libmtprotect.so` / `liblsplant.so` / `libhook.so`，**无任何 native 自我保护层**，破解几乎零成本 |
| 包名变更 | `bin.mt.plus` → `bin.mt.plus.canary`（允许与官方版双开共存） |
| 攻击工具链 | **LSPatch (嵌入式模式) + apktool 3.0.2 + MT 自带 testkey + mt-modder-hub axml 工具库** |
| 攻击者自留指纹 | `META-INF/MT���.RSA`（中文乱码文件名）、`assets/L00.PKG` (LDPK 魔数)、`assets/libloader.so`、`copy_config.json` |
| 增量植入内容 | **28 个 MT 付费插件 + javac 内置编译器**（来源：某已购 VIP 用户设备的 `/Android/data/bin.mt.plus/files/` 目录被整包导出） |
| VIP 绕过手段 | `libloader.so` 内嵌 MT 官方证书的 ASN.1 副本（`130620115319Z` / `30121021115319Z`），hook PMS 后返回伪签名让 MT 自检通过 |
| 版本号自报 | `2.14.5-clone-MOD-v6-xml-fix-final` —— "v6" 表示作者第 6 版迭代，"xml-fix-final" 表示最后修了某个 AndroidManifest 解析 bug |
| 重打包时间 | 2025-01-21 14:10-14:16（攻击者落地时间） |
| 法律性质 | **侵权 + 破坏技术保护措施**，违反《计算机软件保护条例》《著作权法》第 53 条、《刑法》第 217 条 |

---

## 1. 攻击路径 — 手把手十二步还原

> 全部步骤可由一台 root 手机 + MT 管理器自身完成，**无需 PC 端 IDA / 编译器**。技术门槛 = 会用 LSPatch CLI + 会装 ADB。

### 第 1 步：选定攻击基线 —— MT 2.14.5（2024-01-18）

攻击者选择 2.14.5 而不是更新版本，是经过算计的：

| MT 版本 | 自带 native 保护 | 是否易破 |
|---|---|---|
| 2.14.5（2024-01） | ❌ 无 `libmtprotect.so`、❌ 无 `liblsplant.so`、❌ 无 `libhook.so` | ⭐ 非常容易 |
| 2.26.4（2026-04） | ✅ libmtprotect 1.99MB + lsplant ART hook + xhook | ⭐⭐⭐⭐ 困难 |
| 2.26.5（2026-05） | ✅ 上述 + 新增 seccomp BPF (`installSeccomp`) | ⭐⭐⭐⭐⭐ 非常困难 |

> **MT 官方在 2024-08 后才陆续加入 libmtprotect 系列保护**，2.14.5 是"前防护时代"的最后一批裸版本，恰好是 LSPatch 一击即破的最佳靶子。

### 第 2 步：获取真品 + 拆解

```bash
# 从官方渠道下载 MT 2.14.5
apktool d MT2.14.5.apk -o orig/
```

确认原 application = `l.ۛۙ۫`（jadx 规范化后 = `ApplicationC4439`，继承自 `ApplicationC3105`，含 short[] 加密的核心字段）。

### 第 3 步：从已购 VIP 设备导出全套 plugin/javac

攻击者在自己（或同伙）的设备上：
1. 用合法账户购买了 MT VIP
2. 进入 `/storage/emulated/0/Android/data/bin.mt.plus/files/`，导出整个 `plugin/` 和 `javac/` 目录
3. 打包成 `res.zip`：

```
res.zip
├─ files/javac/boot/classes.jar          (1,752,707 字节，含 javac 编译器内核)
├─ files/javac/ext/classes.jar           (178,424 字节)
├─ files/javac/version                   ("===" 一行)
└─ files/plugin/                         (28 个插件)
   ├─ bin.plugin.translator.baidu        (百度翻译)
   ├─ bin.plugin.translator.baiduapi
   ├─ bin.plugin.translator.bing
   ├─ bin.plugin.translator.google
   ├─ bin.plugin.translator.google_cn
   ├─ bin.plugin.translator.yandex
   ├─ bin.plugin.translator.youdao
   ├─ bin.plugin.translator.fanjian
   ├─ vlrs.plugin.translator.microsoft
   ├─ mb.plugin.translator.google.api
   ├─ com.frankwhite.translate_Mosquito
   ├─ com.vlrs.plugin.deepl_transl
   ├─ com.losfer.terjimans
   ├─ Han.mt_plugin.strip_whitespace
   ├─ Han.mt_plugin.text_sort
   ├─ com.hand.mtplugin
   ├─ com.whitesev.plugin.whitesev
   ├─ com.wyxhy.smali_convert
   ├─ io.tooldroid.plugin.stringencoder
   ├─ jiaxin149.mt.plugin
   ├─ jiaxin149.mt.plugin_java_code
   ├─ mt.base_converter
   ├─ mt.chatGPT.ai                       ← ChatGPT 插件
   ├─ mt.english.dictionary
   ├─ mt.number_converter
   ├─ mt.oxford_english.dictionary
   └─ tw.david082321
```

> 每个插件目录下 `plugin.mtp` (元信息) + `code` (插件代码) 都被原样打包。这部分是**最严重的侵权**：不仅破解 MT 主程序，还把第三方插件作者（Han、vlrs、frankwhite 等）的付费/收费插件未经授权再分发。

### 第 4 步：用 LSPatch (嵌入式模式) 织入

LSPatch 是开源的 LSPosed Sandbox Patcher（GitHub: `JingMatrix/LSPatch`，原作自 LSPosed 团队），它的"嵌入式模式" (`-m embed`) 会做这些事：

```bash
java -jar lspatch.jar MT2.14.5.apk \
    -m embed \                          # 嵌入式（与之相对的是 manager 模式）
    -k testkey.pk8 -K testkey.x509.pem  # 用 AOSP testkey 签名
    -l 2 \                              # sigBypassLevel = 2（PMS+Provider hook）
    --override-component-factory \      # 覆盖 manifest 的 appComponentFactory
    -o MT_patched.apk
```

LSPatch 在 APK 内做的修改：

| 修改项 | 文件 | 大小 | 时间戳 |
|---|---|---|---|
| 注入 native loader | `lib/{arm64-v8a,armeabi-v7a,x86,x86_64}/libloader.so` | 各 35-60 KB | 2024-08-10 19:22 |
| 注入 patch payload | `assets/L00.PKG` (LDPK 魔数 `4C 44 50 4B`) | 8.86 MB | 2025-01-21 14:11 |
| 注入 mode 配置 | `assets/copy_config.json` = `{"mode":"1"}` | 12 字节 | 2025-01-21 14:11 |
| 重写 application/factory | `AndroidManifest.xml` 的 `appComponentFactory` 指向新注入的 stub 类 | 20.7 KB | 2025-01-21 14:10 |
| 注入 Java stub | `classes3.dex` 中新增 `l.ۖۨۛ` (= `AppComponentFactoryC0825`) | — | 2024-12-29 |
| 注入工具库 | `classes4.dex` 中新增 `mt.modder.hub.*`（axml/arsc/smali 处理工具，来自 GitHub `mt-modder-hub` 团队的开源库） | — | 2025-01-21 14:12 |

### 第 5 步：植入 res.zip + 自写"启动时复制"逻辑

LSPatch 原版不支持"启动时把 zip 解到 data 目录"功能。攻击者**额外定制**了这一段：

1. 把第 3 步制作的 `res.zip`（3 MB）直接放进 `assets/`
2. 在 `copy_config.json` 里写 `{"mode":"1"}` 作为开关
3. 修改 `libloader.so`，让它在 `JNI_OnLoad` 中除了做 LSPatch 标准逻辑外，**还** 读 `assets/copy_config.json` → 若 mode==1，则把 `assets/res.zip` 解压到 `getFilesDir()` 上一级（即 `/Android/data/bin.mt.plus.canary/files/`），让 MT 启动时检测到 plugin 和 javac 数据"已存在"。

`libloader.so` 内的字符串证据：

```
"Super called!"                          ← AppComponentFactory.super 调用完毕
"%s/loader_log.txt"                      ← 调试日志路径
"Files dir path: %s"                     ← 拼接 res.zip 解压目标路径
"Files dir global path: %s"
"Cannot reposition pointer to file end"  ← 文件 IO 出错处理
"Writing log file at %s"
"native_process_arsc() called"           ← ARSC 资源表加载
"Initializing ArscByteStream"            ← 内嵌 ARSC parser（绕过 MT 自己的 ARSC 校验）
"apm_class:%p apm_ctor:%p"               ← 反射定位原 Application 类 + 构造器
"Called native onCreate()!"              ← Hook Application.onCreate
"loading mtprotect..."                   ← 伪装成 MT 的 mtprotect 加载（实际为 cover-up）
"Unlocking vip..."                       ← 决定性证据
"Calling findViewById()!"                ← 直接操纵 view tree
"Views init called!"
"is_leaked: one of the parents is invisible!"  ← 反 hook 自检（检测自身是否被反 hook）
```

### 第 6 步：内嵌 MT 官方证书副本（核心绕过手段）

`libloader.so` 内含两个 ASN.1 GeneralizedTime 字符串：

```
"130620115319Z"   = 2013-06-20 11:53:19 UTC
"30121021115319Z" = 3012-10-21 11:53:19 UTC
```

这两个值**与 MT 官方 `CN=bin` 证书的 `Not Before / Not After` 完全一致**（我们从 MT 2.26.5 抓到的原始证书：`Serial Number: 615380958 (0x24adf7de), Issuer: CN=bin, Not Before: Jun 20 11:53:19 2013 GMT, Not After: Oct 21 11:53:19 3012 GMT`）。

证书的 modulus / publicKey 部分被 strings 误读成下面的乱码块：

```
9hBF9i, *\kh8J, RtBF9v., QtJF9z, *wjh8^, *yjh8Q, ... (近百条)
```

它们是 X.509 RSA modulus 的二进制 binary blob 段。

**绕过原理**：
1. MT 主程序中所有 VIP 校验逻辑（在 `ApplicationC4439` 的加密 short[] 字段里）会调用 `PackageManager.getPackageInfo(BuildConfig.APPLICATION_ID, GET_SIGNATURES)`
2. LSPatch 通过 Xposed 框架 hook 了这个 `getPackageInfo` 调用
3. Hook 函数返回**伪造的 Signature[]**，其内容由 libloader.so 内嵌的 CN=bin 证书副本反序列化得到
4. MT 主程序拿到"看起来是官方签名"的返回值，VIP 校验通过

### 第 7 步：重打包 — apktool 3.0.2

工艺指纹完全坐实：

| 项 | 值 | 含义 |
|---|---|---|
| apktool 版本 | `version: 3.0.2`（写在 `apktool.yml`） | MT 内置 apktool 当前默认版本 |
| `doNotCompress` 列表 | 含 `arsc, png, assets/filetransfer.apk, assets/res.zip` | 攻击者**手动追加了 `res.zip`** 进 doNotCompress —— 否则 apktool 会压缩它，导致 libloader.so 直接 mmap 读取失败 |
| `versionInfo.versionName` | `2.14.5-clone-MOD-v6-xml-fix-final` | 攻击者炫耀式自留版本号 |
| 包名 | `bin.mt.plus.canary` | "canary" 是为了双开 |

### 第 8 步：用 MT 自带 testkey 签名（最讽刺的一步）

MT 管理器**自己的 `assets/` 目录里**就包含 AOSP testkey 全套：

```
mt-apkt/assets/testkey.pk8          (AOSP 标准测试私钥)
mt-apkt/assets/testkey.x509.pem     (对应公钥证书)
```

这本是 MT 提供的"默认测试签名"，方便用户调试自己的 APK。攻击者直接拿来给修改过的 MT 自身签名：

```bash
apksigner sign --ks-pass pass:android \
    --key testkey.pk8 \
    --cert testkey.x509.pem \
    --v1-signing-enabled true \
    --v2-signing-enabled true \
    --v3-signing-enabled true \
    MT_patched.apk
```

签名产物：
- `META-INF/MT���.RSA`（中文乱码文件名 — MT 工具流的"自留指纹"）
- v1+v2+v3 全签

验证：
```
Subject:    C=US, ST=California, L=Mountain View, O=Android, OU=Android, CN=Android
SHA-256:    A4:0D:A8:0A:59:D1:70:CA:A9:50:CF:15:C1:8C:45:4D:47:A3:9B:26:98:9D:8B:64:0E:CD:74:5B:A7:1B:F5:DC
```

这个 SHA256 是 **AOSP testkey 在全球安全社区的固定指纹**，任何 APK 商店、企业 MDM 都应该把它列入永久黑名单。

### 第 9 步："xml-fix-final" 的来历推断

versionName 里的 `xml-fix-final` 暗示某次 patch 后 manifest 解析出错。最可能原因：
- LSPatch 默认的 `--override-component-factory` 在 manifest 里写了 `appComponentFactory="org.lsposed.lspatch.loader.LSPApplicationProxy"` 这种**长字符串**
- MT 2.14.5 的 `ApplicationC3105` static init 里有 `Landroid/` → `Lcom/android/` 的字符串重命名钩子，会破坏 LSPatch 标准类名
- 攻击者最终把工厂类名也改成阿拉伯 unicode 混淆名 `l.ۖۨۛ`，并把对应实现塞进 `classes3.dex`，避开了字符串重命名

这就是为什么 jadx 反编出来的 `AppComponentFactoryC0825` 看起来是个**无操作的 stub**（所有方法只是 `m2668(super.xxx())`，而 `InterfaceC2479` 在整个 dex 里没有任何实现）—— 真实逻辑全部下沉到 `libloader.so`。

### 第 10 步：用户安装

用户拿到这个 APK 直接装：
1. 因为包名是 `bin.mt.plus.canary`，与官方 MT 不冲突，可双开
2. 安装时 Android Framework 校验 v2/v3 签名（AOSP testkey 通过）
3. 启动时 `appComponentFactory="l.ۖۨۛ"` 优先创建 → 触发 ART 加载 classes3.dex 中的 stub 工厂
4. stub 工厂的 `instantiateApplication` 调用 super 返回原 MT Application，并通过 `m2668` 包一层（实际无替换）
5. **真正的劫持发生在 Application.onCreate 之前** —— `libloader.so` 已经通过 `System.loadLibrary("loader")` 完成 JNI_OnLoad 中的 Xposed 框架初始化（这部分在 `L00.PKG` 解密后的 dex 中）
6. Application.onCreate 调用时，PMS 已被 hook，签名返回 `CN=bin`
7. `libloader.so` 同时把 `assets/res.zip` 解压到 files 目录
8. MT 主程序启动，检测到所有插件 + javac 都"已激活"，全套 VIP 功能可用

### 第 11 步：运行时副作用

`libloader.so` 在跑的时候会写：
```
/data/data/bin.mt.plus.canary/files/loader_log.txt
```
日志内容包括 ARSC 加载状态、view init 状态、apm_class 反射指针等。**这是一个隐私泄漏点 + 一个可被检测特征**（任何安全工具扫描该路径即可识别"被 LSPatch 嵌入式 patch 过的 APK"）。

### 第 12 步：传播链路

依据 versionName `v6`，攻击者很可能在 Telegram / 草榴 / 各类 yxssp.com / iCrack 类圈子内多次发布迭代版本，每个版本对应一次 patch 修正。最终版"v6-xml-fix-final" 是定稿。

---

## 2. 攻击者画像

| 维度 | 推断 |
|---|---|
| 技术水平 | 中等。**没有自研逆向能力**（不修改 smali 字节码、不动 MT 原 Application），全靠现成工具拼装 |
| 工具链熟练度 | 高。能定制 LSPatch loader、能处理 manifest 混淆冲突、能自写 native 复制逻辑 |
| 资源 | 至少一台已购 MT VIP 的设备 + AOSP testkey + LSPatch + 一定的 C/JNI 编程能力 |
| 选择 2.14.5 而非更新版 | **明智决策**：2.14.5 是 MT 最后一个"前防护时代"版本，破解收益 / 投入比最高 |
| 自留指纹 | `bin.mt.plus.canary`、`META-INF/MT���.RSA`、`assets/L00.PKG`、`assets/libloader.so`、`assets/copy_config.json`、versionName `clone-MOD-v6-xml-fix-final` |

---

## 3. 受损评估（对 MT 官方 / 插件作者）

| 受损方 | 损失类型 | 估算量级 |
|---|---|---|
| **MT 官方（彬哥）** | VIP 订阅收入损失 + 品牌损害 | 每个分发该 APK 的渠道每月数千-数万次安装 |
| **28 位插件作者** | 付费/收费插件被未授权再分发 | 累计影响每个插件作者收入 |
| **某 VIP 账户用户**（受害者） | 账户数据被导出再分发 | 如果该账户的 plugin/code 中含个性化配置（如 ChatGPT API key），还存在**凭据外泄** |
| **下载用户**（受害者） | 安装来源不可信 + `libloader.so` 拥有完整进程权限 | 攻击者可在后续 patch 中加入任意恶意行为（间谍 / 挖矿 / 锁机），用户无法察觉 |

---

## 4. 修复建议（按优先级）

### P0（立即可做，0-1 周）

1. **客户端硬编码签名校验下沉到 native + OLLVM**
   - MT 2.14.5 的所有签名校验都在 Java 层（`ApplicationC4439` 的 short[] 解密后字符串调用反射），LSPatch 的 PMS hook 可一击即破
   - 把 `getPackageInfo + GET_SIGNATURES` 的调用 + 比对放进 `libmtprotect.so`，用 OLLVM 全混淆（MT 2.26.5 已经这么做了，回移到所有维护中的版本）

2. **在 native 层主动检测 LSPatch 自留特征**
   - 检查 `assets/L00.PKG` 是否存在（LDPK 魔数）
   - 检查 `assets/copy_config.json` 是否存在
   - 检查 `assets/libloader.so` (用 `dlsym + dlclose` 探测)
   - 检查 `getFilesDir()/loader_log.txt` 是否存在
   - 检查 `appComponentFactory` 是否非预期值
   - 任何一条命中 → 立即 `_exit(0)` 退出，不弹窗（不给攻击者调试反馈）

3. **黑名单 AOSP testkey 签名**
   - 在 native 层硬编码 AOSP testkey 的 SHA256 (`A4:0D:A8:0A:59:D1:70:CA:A9:50:CF:15:C1:8C:45:4D:47:A3:9B:26:98:9D:8B:64:0E:CD:74:5B:A7:1B:F5:DC`)
   - 在 `Application.attachBaseContext` 之前（用 `JNI_OnLoad` 自动触发）就检查自身签名
   - 同时建议把 MT 工具内置的 testkey **改成 MT 单独生成的"调试密钥"**（不再用 AOSP 标准 testkey），避免攻击者继续利用同一把密钥重签 MT 自身

### P1（中期，2-4 周）

4. **VIP 数据上云校验**
   - 当前 MT 把 plugin 数据放在本地 `/Android/data/bin.mt.plus/files/plugin/` 完全离线运行
   - 改成：每次插件首次加载时，把插件的 `plugin.mtp` 元信息 + 设备指纹 + 当前 MT 安装签名 一并上报到服务端，由服务端验证"该用户是否购买过该插件 / 当前 APK 签名是否官方"
   - 这样**就算 res.zip 整包被偷**，新设备上也激活不了

5. **AndroidManifest `appComponentFactory` 反操纵**
   - MT 在 `JNI_OnLoad` 中读取自身 APK 的 manifest，比对 `appComponentFactory` 是否等于预期的 MT 官方值
   - 若被改写（如本案的 `l.ۖۨۛ`），立即退出

6. **Application 类完整性校验**
   - 通过 native 调用 ART runtime，遍历 `ApplicationC4439`（或其继承链）所有方法的 codeItem 的 CRC32
   - 若与官方烧入的预期 CRC 不符，退出

### P2（长期，1-3 月）

7. **关键 VIP 检查逻辑迁移到 APK-VM**
   - 借鉴 NP 管理器的 `libnpvmp.so` 思路：把签名校验、插件激活校验、版本时间戳校验等核心算法编译成自家 VM 字节码，运行时由 native interpreter 解释执行
   - 攻击者即便 hook 了 PMS，也无法绕过 VM 内部逻辑（VM 字节码 dispatch 数组 + 解释器在 OLLVM 混淆 native 里）

8. **接 Google Play Integrity API（仅对国际版本）**
   - 后端验证 `verdict` 必须为 `MEETS_DEVICE_INTEGRITY + MEETS_BASIC_INTEGRITY`
   - LSPatch 这种修改会导致 verdict 降级为 `UNRECOGNIZED_VERSION`
   - 国内版本可用腾讯 / 阿里 / 网易易盾等同类后端 attestation 服务

9. **VIP 插件下发改"服务端编译/加密分发"**
   - 当前 plugin `.mtp` 是明文 zip，破解者一旦获得即可任意再分发
   - 改成：服务端按设备 ID + 时间戳生成动态加密的 `.mtp`（仅对应设备能解密 + 24 小时 TTL）
   - 即使整包被偷，第二天就失效

---

## 5. 取证清单（如需法律行动）

| 证物 | 路径 | 价值 |
|---|---|---|
| 被改写的签名 | `META-INF/MT���.RSA` (AOSP testkey, SHA256 `A4:0D:...`) | 直接证明非官方签名 |
| 攻击者注入的工厂类 | `classes3.dex` → `l/ۖۨۛ` = `AppComponentFactoryC0825` | 注入手法证据 |
| LSPatch payload | `assets/L00.PKG` (8.86 MB, 魔数 `4C 44 50 4B`) | 工具链证据 |
| LSPatch loader | `lib/{abi}/libloader.so` (含 `"Unlocking vip..."` 字符串) | 主观恶意证据 |
| 被盗 VIP 数据 | `assets/res.zip` → `files/plugin/*` 28 个插件 + `files/javac/{boot,ext}/classes.jar` | 侵权直接证据 |
| 重打包时间戳 | apktool.yml + AndroidManifest.xml mtime = 2025-01-21 14:10-14:16 | 时间证据 |
| 攻击者自留版本号 | `2.14.5-clone-MOD-v6-xml-fix-final` | 同一攻击者多版本传播证据 |
| 内嵌的伪 CN=bin 证书 | `libloader.so` 中 `130620115319Z` + `30121021115319Z` ASN.1 时间戳 | 故意伪造官方签名证据 |

> **建议**：可委托司法鉴定所对 `libloader.so` 做反汇编报告，并对比 LSPatch 开源版（GitHub `JingMatrix/LSPatch`）的 commit 历史，找出攻击者具体 fork / 改动 commit，进一步追溯身份。

---

## 6. 一句话总结

> **本案 100% 是"用 MT 破解 MT"** —— 攻击者用 MT 管理器自带的 testkey + LSPatch 嵌入式 patch + 一台已购 VIP 设备的 files 目录，三步就把 MT 自身洗了。本质问题是 **MT 2.14.5 的所有 VIP 校验逻辑都在 Java 层**且 **MT 把 AOSP testkey 直接打包在 assets 里供用户使用**，攻击者顺手就拿来反噬 MT 自己。MT 2.26.5 已经补上了 native 保护层 + seccomp 沙箱，**优先策略应该是：所有还在维护的旧版本立即下线 2.14.x 系列分发，并通过 MT 自更新通道强制升级**。

---

## 附录 A：完整文件级修改对照表

```
              MT 2.14.5 官方                MT 2.14.5-MOD-v6
─────────────────────────────────────────────────────────────────
包名         bin.mt.plus                   bin.mt.plus.canary           [+canary]
versionName  2.14.5                        2.14.5-clone-MOD-v6-xml-fix-final  [+suffix]
签名         CN=bin (SHA256 8501DD29...)   CN=Android (testkey, A40DA80A...)  [REPLACE]
META-INF     BIN.RSA / BIN.SF              MT���.RSA / MT���.SF        [RENAME, 中文乱码]
appComp.     (none)                        l.ۖۨۛ (= AppComponentFactoryC0825)  [INJECT]
classes3.dex (原版)                        +l.ۖۨۛ (LSPatch stub factory)      [PATCH]
classes4.dex (原版)                        +mt.modder.hub.*               [INJECT 4986 类]
assets/      (无)                          +L00.PKG (8.86 MB, LDPK)       [INJECT]
assets/      (无)                          +copy_config.json              [INJECT]
assets/      (无)                          +res.zip (3 MB, VIP 数据)      [INJECT]
lib/{abi}/   (无 libloader.so)             +libloader.so (35-60 KB)       [INJECT]
apktool.yml  doNotCompress: arsc,png       doNotCompress: arsc,png,res.zip  [APPEND]
```

## 附录 B：用到的逆向工具链

| 工具 | 用途 |
|---|---|
| `unzip -l` / `unzip -p` | 列出/提取 zip 条目 |
| `openssl pkcs7 -inform DER -print_certs -text` | 解析 META-INF/*.RSA 签名证书 |
| `openssl x509 -fingerprint -sha256` | 公钥指纹比对 |
| `apktool d -f --no-src` | 资源/manifest 解包 |
| `jadx -j 4 --no-res` | dex → Java 反编译 |
| `nm -D libloader.so` | 查看 dynsym 导出 |
| `strings -a -n 6 libloader.so` | 字符串特征提取 |
| `xxd L00.PKG | head` | 二进制魔数确认（`4C 44 50 4B` = LDPK） |
| `file` | 文件类型识别 |

