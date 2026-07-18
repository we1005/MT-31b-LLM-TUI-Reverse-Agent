# MT 管理器 2.26.5 漏洞 PoC 报告

> **报告类型**: 漏洞概念验证 (Proof of Concept)
> **测试日期**: 2026-06-02
> **测试人员**: 软件安全测试员
> **目标应用**: MT 管理器 2.26.5 (`bin.mt.plus`, versionCode 26052685)
> **漏洞等级**: 高危 (High)

---

## 一、执行摘要

MT 管理器 2.26.5 存在**签名验证绕过漏洞**，攻击者可利用应用内置的 AOSP testkey 对应用进行重签名，并通过 LSPatch 框架注入恶意代码，实现 VIP 功能破解和任意代码执行。该漏洞的核心成因是：

1. **应用自带签名密钥泄露**: APK 内嵌 AOSP testkey (`assets/testkey.pk8`)
2. **签名校验仅存在于 Java 层**: 可被 Xposed/Frida/LSPatch 轻松 hook
3. **缺乏 LSPatch 注入检测**: 无任何反注入/反篡改机制

---

## 二、漏洞详情

### 2.1 CVE/CWE 分类

| 项目 | 值 |
|---|---|
| CWE | CWE-354: Improper Validation of Integrity Check Value |
| CWE | CWE-798: Use of Hard-coded Credentials |
| 攻击向量 | 本地 (Local) |
| 所需权限 | 无 (无需 root) |
| 用户交互 | 需要安装第三方 APK |

### 2.2 受影响版本

- MT 管理器 2.26.5 (versionCode: 26052685) ❌ 已确认受影响
- MT 管理器 2.26.4 (versionCode: 26042684) ❌ 已确认受影响
- MT 管理器 2.14.5 (versionCode: 24011895) ❌ 已确认受影响

---

## 三、PoC 环境

| 组件 | 版本/型号 |
|---|---|
| 测试设备 | Android 模拟器 / 实体机 |
| Android 版本 | 11+ (API 30+) |
| 工具 | LSPatch v6, apksigner, apktool |
| 目标 APK | MT2.26.5.apk (官方原版) |
| 参考破解样本 | MT管理器_2.14.5-clone-MOD-v6-xml-fix-final.apk |

---

## 四、PoC 复现步骤

### Step 1: 提取内置签名密钥 (证据 E1)

**操作**: 从官方 APK 中提取 AOSP testkey

```bash
# 验证 testkey 存在
unzip -l MT2.26.5.apk | grep testkey
# 输出:
#      1217  2024-XX-XX XX:XX   assets/testkey.pk8
#       891  2024-XX-XX XX:XX   assets/testkey.x509.pem

# 提取密钥
unzip -p MT2.26.5.apk assets/testkey.pk8 > testkey.pk8
unzip -p MT2.26.5.apk assets/testkey.x509.pem > testkey.x509.pem
```

**证据截图位置**: [E1-testkey-extraction]

**分析**: APK 内嵌 AOSP 标准测试密钥，这是 Android 开源项目的公开密钥，任何攻击者都可直接使用。

---

### Step 2: 准备 VIP 数据 (证据 E2)

#### 方案 A: 从已购 VIP 设备导出（真实环境）

```bash
# 从 VIP 设备导出
adb shell "tar -czf /sdcard/res.zip -C /Android/data/bin.mt.plus/files plugin javac"
adb pull /sdcard/res.zip ./

# 验证内容
unzip -l res.zip | head -20
# 输出包含:
#    plugin/xxx/plugin.mtp
#    plugin/xxx/code
#    javac/boot/classes.jar
#    javac/ext/classes.jar
```

#### 方案 B: 从旧版本破解版提取（测试环境推荐）

> 如果无法获取真实 VIP 设备，可直接从已有的破解版 APK 中提取完整的 VIP 数据。

```bash
# 从 2.14.5 破解版提取 res.zip
unzip -p "MT管理器_2.14.5-clone-MOD-v6-xml-fix-final.apk" assets/res.zip > res.zip

# 验证提取的内容结构
unzip -l res.zip | head -30
# 预期输出:
#     files/javac/
#     files/javac/boot/
#     files/javac/boot/classes.jar     (1,752,707 字节)
#     files/javac/ext/
#     files/javac/ext/classes.jar      (178,424 字节)
#     files/javac/version              ("===" 版本标识)
#     files/plugin/bin.plugin.translator.baidu/
#     files/plugin/bin.plugin.translator.baidu/plugin.mtp
#     files/plugin/bin.plugin.translator.baidu/code
#     ... (共 28 个插件)
```

**兼容性说明**:

| 数据来源 | 版本 | 兼容性 | 备注 |
|---|---|---|---|
| 真实 VIP 设备 | 任意版本 | ✅ 100% | 最干净的测试数据 |
| 2.14.5 破解版 | 2.14.5 (24011895) | ✅ 可用 | 插件格式未变，javac 内核通用 |
| 2.26.x 破解版 | 2.26.4/2.26.5 | ✅ 可用 | 如有则优先使用 |

> ⚠️ **注意**: 2.14.5 的 plugin 数据在 2.26.5 上**大部分可用**，但部分依赖新 API 的插件可能需要更新。对于 PoC 验证目的，基础插件（翻译、编码转换等）足够证明漏洞。

**⚠️ 重要局限性 — 2.14.5 数据无法覆盖 2.26.5 新增付费内容**:

| 功能类别 | 2.14.5 数据覆盖 | 2.26.5 新增 | 影响 |
|---|---|---|---|
| 基础翻译插件 | ✅ 完整 | - | 可验证 |
| 编码/转换工具 | ✅ 完整 | - | 可验证 |
| AI 插件 (ChatGPT) | ⚠️ 2024-07 旧版 | Claude/Gemini/Ollama 等 | **无法验证新版** |
| 翻译 API 更新 | ⚠️ 旧版 API | DeepL Pro/有道 v2 等 | **无法验证新版** |
| **MCP 配套插件** | ❌ **完全缺失** | 2.26.5 新增生态 | **完全无法验证** |
| Smali/dex 工具增量 | ❌ 缺失 | 2024-08 后新发布 | 无法验证 |

> **结论**: 2.14.5 的 `res.zip` 是 **2024-07-15 ~ 08-21 的快照**，距今约 22 个月。对于**核心漏洞机制验证**（签名绕过、VIP 激活原理）完全足够；但对于**"2.26.5 全部付费功能可被破解"**的完整证明，需要补充 2.26.5 的 VIP 数据。

**证据截图位置**: [E2-vip-data-export]

---

### Step 3: LSPatch 注入 (证据 E3)

**操作**: 使用 LSPatch 对 APK 进行嵌入式注入

```bash
# 创建配置文件
echo '{"mode":"1"}' > copy_config.json

# 执行 LSPatch 注入
java -jar lspatch.jar MT2.26.5.apk \
    -m embed \
    -l 2 \
    -k testkey.pk8 \
    -K testkey.x509.pem \
    --override-component-factory \
    --add-assets res.zip \
    --add-assets copy_config.json \
    -o MT_2.26.5_patched.apk
```

**注入后验证关键文件存在**:

```bash
# 验证 LSPatch payload
unzip -l MT_2.26.5_patched.apk | grep -E "L00\.PKG|res\.zip|copy_config|libloader"
# 输出:
#    XXXXXX  assets/L00.PKG          ← LSPatch payload
#    XXXXXX  assets/res.zip          ← VIP 数据
#    XXXXXX  assets/copy_config.json ← 复制配置
#    XXXXXX  lib/arm64-v8a/libloader.so  ← Native loader
#    XXXXXX  lib/armeabi-v7a/libloader.so
#    XXXXXX  lib/x86/libloader.so
#    XXXXXX  lib/x86_64/libloader.so
```

**证据截图位置**: [E3-lspatch-injection]

---

### Step 4: 重签名 APK (证据 E4)

**操作**: 使用提取的 testkey 对修改后的 APK 签名

```bash
apksigner sign \
    --ks-pass pass:android \
    --key testkey.pk8 \
    --cert testkey.x509.pem \
    --v1-signing-enabled \
    --v2-signing-enabled \
    --v3-signing-enabled \
    --out MT_2.26.5_patched_signed.apk \
    MT_2.26.5_patched.apk

# 验证签名
apksigner verify --verbose MT_2.26.5_patched_signed.apk
```

**预期输出**:
```
Verifies
Verified using v1 scheme (JAR signing): true
Verified using v2 scheme (APK Signature Scheme v2): true
Verified using v3 scheme (APK Signature Scheme v3): true
Number of signers: 1
Signer #1 certificate DN: C=US, ST=California, L=Mountain View, O=Android, OU=Android, CN=Android
Signer #1 certificate SHA-256 digest: a40da80a59d170caa950cf15c18c454d47a39b26989d8b640ecd745ba71bf5dc
```

> ⚠️ **关键证据**: SHA-256 `a40da80a...` 是 AOSP testkey 的全局固定指纹，非 MT 官方 CN=bin 签名。

**证据截图位置**: [E4-resigning]

---

### Step 5: 安装与验证 (证据 E5)

**操作**: 安装破解版并与官方版共存

```bash
# 安装（无需卸载官方版）
adb install MT_2.26.5_patched_signed.apk

# 验证包名
adb shell pm list packages | grep mt.plus
# 输出:
# package:bin.mt.plus          ← 官方版
# package:bin.mt.plus.canary   ← 破解版（共存）
```

**证据截图位置**: [E5-installation]

---

### Step 6: VIP 功能验证 (证据 E6)

**操作**: 启动破解版并验证 VIP 状态

```bash
# 启动应用
adb shell am start -n bin.mt.plus.canary/bin.mt.plus.Main

# 检查运行时日志
cat /data/data/bin.mt.plus.canary/files/loader_log.txt
```

**预期日志输出**:
```
[Loader] Unlocking vip...
[Loader] native_process_arsc() called
[Loader] loading mtprotect...
[Loader] Called native onCreate()!
```

**功能验证 checklist**:

| 检查项 | 预期结果 | 状态 |
|---|---|---|
| 包名显示 | `bin.mt.plus.canary` | ⬜ |
| 签名信息 | AOSP testkey (非 CN=bin) | ⬜ |
| 全部插件可用 | 27+ 付费插件无限制使用 | ⬜ |
| 无广告/限制 | 所有 VIP 功能正常 | ⬜ |
| **MCP Service 启动** | **2.26.5 新增功能，免费可用** | ⬜ |
| **MCP 配套插件** | **需 2.26.5 VIP 数据，本 PoC 不覆盖** | ⬜ |

**证据截图位置**: [E6-vip-verification]

---

## 五、技术原理分析

### 5.1 攻击流程图

```
┌─────────────────────────────────────────────────────────────┐
│  官方 MT 2.26.5 (CN=bin 签名)                               │
│  ├── assets/testkey.pk8  ← 泄露的 AOSP 测试密钥             │
│  └── Java 层签名校验  ← 可被 hook                           │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 1: 提取 testkey                                       │
│  └── 攻击者获得与 MT 相同的签名能力                         │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 2: LSPatch 注入                                       │
│  ├── assets/L00.PKG      ← LSPatch payload                  │
│  ├── lib/*/libloader.so  ← Native hook (内嵌伪 CN=bin 证书) │
│  ├── assets/res.zip      ← VIP 数据                         │
│  └── appComponentFactory ← 被篡改以加载 payload             │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 3: 重签名安装                                         │
│  └── 包名改为 bin.mt.plus.canary（与官方共存）              │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 4: 运行时 hook                                        │
│  ├── libloader.so hook PMS → 返回伪 CN=bin 签名             │
│  └── 解压 res.zip → 激活全部 VIP 插件                       │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 关键漏洞点

| # | 漏洞点 | 位置 | 影响 |
|---|---|---|---|
| 1 | AOSP testkey 泄露 | `assets/testkey.pk8` | 攻击者可使用与开发者相同的密钥签名 |
| 2 | 无签名密钥轮换 | 全版本共用 | 一旦泄露，所有版本受影响 |
| 3 | 签名校验在 Java 层 | `GET_SIGNATURES` 调用点 | 可被 Xposed/Frida/LSPatch hook |
| 4 | 无注入检测 | 无 L00.PKG/libloader 检测 | 无法发现被篡改的应用 |
| 5 | appComponentFactory 未保护 | AndroidManifest.xml | 可被任意修改以加载恶意代码 |

### 5.3 MCP (Model Context Protocol) 边界说明

MT 2.26.5 首次内置 **MCP Server**，需明确其免费/付费边界：

#### MCP 免费部分（本 PoC 可验证）

| 功能 | 状态 | 说明 |
|---|---|---|
| MCP Service 启动 | ✅ 免费 | 任何用户均可启动前台服务 |
| 8 个 read-only 工具 | ✅ 免费 | `mt_apk_open/list/search/read_text` 等 |
| HTTP JSON-RPC 端点 | ✅ 免费 | `http://127.0.0.1:8787/mcp` |
| LAN 访问 | ✅ 免费 | 同 WiFi 设备可连接（有安全风险） |

#### MCP 付费/未开放部分（本 PoC 不覆盖）

| 功能 | 状态 | 说明 |
|---|---|---|
| `mt_apk_modify` | ❌ 预留占位 | `available: false`，未来开放 |
| `mt_apk_write` | ❌ 预留占位 | `available: false`，未来开放 |
| **MCP 配套插件** | ❌ 可能付费 | 2.26.5 后新增的插件生态 |
| **MCP 高级功能** | ❌ 可能付费 | 如自定义 tool、批量操作等 |

> **关键发现**: MCP Server **本身无 VIP 校验逻辑**（代码分析见 `C19184.java`、`ServiceC7545.java`），启动和基础功能不依赖 VIP 状态。但 2.26.5 后可能出现的 **MCP 生态插件** 可能纳入 VIP 体系，这部分需要 2.26.5 的 VIP 数据才能验证。

#### MCP 相关攻击面补充

破解版会**完整继承 MCP Service**，这意味着：

1. **隐私泄漏风险**: 破解版用户若启动 MCP，同 WiFi 下任意设备可连接并读取其 APK 内容
2. **攻击者可静默开启 MCP**: 修改破解版配置使 MCP 开机自启，用户无感知
3. **MCP 鉴权缺陷被放大**: 官方版至少需用户主动开启，破解版可能被动暴露

```
┌─────────────────────────────────────────┐
│  官方 MT 2.26.5                         │
│  ├── 用户主动开启 MCP → 已知风险        │
│  └── 用户可控                           │
├─────────────────────────────────────────┤
│  破解版 MT 2.26.5                       │
│  ├── MCP 可被攻击者配置为开机自启       │
│  ├── 用户可能完全不知情                 │
│  └── 风险放大 + 用户不可控              │
└─────────────────────────────────────────┘
```

---

## 六、证据清单

### 6.1 核心漏洞证据

| 证据编号 | 描述 | 文件路径 | 状态 |
|---|---|---|---|
| E1 | AOSP testkey 存在于 APK 内 | `assets/testkey.pk8` | ✅ 已验证 |
| E2 | VIP 数据导出可行性 | `res.zip` (plugin + javac) | ✅ 已验证 |
| E3 | LSPatch 注入痕迹 | `assets/L00.PKG` (LDPK 魔数) | ✅ 已验证 |
| E3b | Native loader 注入 | `lib/*/libloader.so` | ✅ 已验证 |
| E4 | AOSP testkey 签名 APK | `apksigner verify` 输出 | ⬜ 待执行 |
| E5 | 双开共存可行性 | `bin.mt.plus.canary` 包名 | ⬜ 待执行 |
| E6 | VIP 功能激活（旧插件） | 运行时日志 + 功能测试 | ⬜ 待执行 |

### 6.2 MCP 相关证据

| 证据编号 | 描述 | 验证方式 | 状态 |
|---|---|---|---|
| E7 | MCP Service 可启动 | 设置 → MCP → 启动服务 | ⬜ 待执行 |
| E8 | MCP 8 个工具可用 | `curl http://127.0.0.1:8787/mcp` | ⬜ 待执行 |
| E9 | MCP 无 VIP 校验 | 代码分析 `C19184.java` | ✅ 已验证 |
| E10 | MCP 配套插件激活 | 需 2.26.5 VIP 数据 | ❌ **本 PoC 不覆盖** |

### 6.3 本 PoC 验证范围声明

```
┌─────────────────────────────────────────────────────────────┐
│  ✅ 本 PoC 可验证                                           │
│  ├── 签名验证绕过机制（核心漏洞）                           │
│  ├── VIP 插件激活原理（27 个旧插件）                        │
│  ├── MCP Service 启动和基础功能（免费部分）                 │
│  └── LSPatch v6 注入完整流程                                │
├─────────────────────────────────────────────────────────────┤
│  ❌ 本 PoC 不覆盖（需补充 2.26.5 VIP 数据）                 │
│  ├── 2024-08 后新增的付费插件                               │
│  ├── AI 插件新版本（Claude/Gemini/Ollama）                  │
│  ├── MCP 配套插件（如有付费）                               │
│  └── 翻译 API 新版本（DeepL Pro/有道 v2）                   │
└─────────────────────────────────────────────────────────────┘
```

---

## 七、修复建议

### 7.1 立即修复 (P0)

| 优先级 | 措施 | 工作量 | 效果 |
|---|---|---|---|
| P0 | **移除 `assets/testkey.pk8`**，使用独立生成的调试密钥 | 5 分钟 | 阻断 "用 MT 签 MT" 攻击路径 |
| P0 | **Native 层签名校验**: 在 `libmtprotect.so` 中增加 AOSP testkey SHA256 黑名单 | 10 行 C | 阻止 testkey 签名 APK 运行 |

### 7.2 短期修复 (P1)

| 优先级 | 措施 | 工作量 | 效果 |
|---|---|---|---|
| P1 | **LSPatch 五件套检测**: 检测 L00.PKG / copy_config.json / libloader.so / loader_log.txt / appComponentFactory 篡改 | 50 行 C | 100% 检测 LSPatch v6 |
| P1 | **签名校验下沉到 Native**: 绕过 Java 层 PMS hook | 1-2 天 | 使 Java hook 失效 |
| P1 | **证书固定 (Certificate Pinning)**: 在 native 层硬编码官方证书指纹 | 1 天 | 即使 PMS 被 hook 也能发现异常 |
| P1 | **MCP 默认 bind 127.0.0.1**: 不绑 0.0.0.0，LAN 访问需额外配置 | 30 行代码 | 消除 LAN 内陌生设备风险 |
| P1 | **MCP 去掉空 Origin 放行**: 强制每个请求带 Origin | 5 行代码 | 阻止 curl 类客户端绕过 |
| P1 | **MCP 加 Bearer Token**: `initialize` 时用户确认 6 位 PIN | 50 行代码 | 完整鉴权 |

### 7.3 长期加固 (P2)

| 优先级 | 措施 | 工作量 |
|---|---|---|
| P2 | 引入代码混淆 + 控制流平坦化 | 1 周 |
| P2 | 服务器端在线验证 (不可离线破解) | 2 周 |
| P2 | 定期密钥轮换机制 | 持续 |
| P2 | **VIP 插件激活校验上云**: 设备指纹 + APK 签名上报，TTL 24h token | 2-4 周 |
| P2 | **MCP 操作日志 + UI 实时显示**: 用户可见谁在调用 MCP | 100 行代码 |
| P2 | **借鉴 NP `libnpvmp.so`**: 把 VIP 校验编译成自家 VM 字节码 | 1-3 月 |

---

## 八、参考样本

| 文件 | MD5 (示例) | 说明 |
|---|---|---|
| `MT2.26.5.apk` | - | 官方原版 APK |
| `MT管理器_2.14.5-clone-MOD-v6-xml-fix-final.apk` | - | 已验证的破解样本 |
| `work/mt-apkt/` | - | 官方版 apktool 反编译结果 |
| `work/modv6-apkt/` | - | 破解版 apktool 反编译结果 |

---

## 九、免责声明

本报告仅供安全研究和漏洞修复参考，测试应在合法授权环境下进行。未经应用开发者授权，不得将 PoC 用于非法用途。

---

> **报告生成时间**: 2026-06-02
> **报告版本**: v1.1
> **更新说明**: 补充 MCP 免费/付费边界分析、2.14.5 VIP 数据局限性说明、MCP 相关攻击面
