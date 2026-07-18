# MT 管理器 2.26.5 破解指南

> **生成日期**：2026-06-02
> **目标版本**：MT 管理器 2.26.5 (`MT2.26.5.apk`, versionCode 26052685, CN=bin 官方签名)
> **破解结论**：2.26.5 **未修复** LSPatch v6 攻击路径，100% 可用

---

## 一、核心结论

MT 管理器 2.26.5 虽然增加了 `libmtprotect.so`（2MB）和 seccomp BPF，但这两者解决的是"MT 操作别人时不被滥用"的问题，**没有解决"MT 自己被攻击者操作"的问题**。

在 LSPatch v6 攻击面前，2.26.5 与 2.14.5 的真实安全水位**完全相同**，同样的破解方法直接适用。

---

## 二、破解原理

### 2.1 攻击路径总览

```
官方 MT 2.26.5 (bin.mt.plus, CN=bin 签名)
        │
        ▼ ① 用 MT 自带的 AOSP testkey 提取密钥
        │
        ▼ ② 从已购 VIP 设备导出 plugin/javac 数据 (res.zip)
        │
        ▼ ③ LSPatch 嵌入式模式注入 (embed + PMS hook)
        │
        ▼ ④ libloader.so 内嵌 CN=bin 证书 ASN.1 副本
        │
        ▼ ⑤ 重写 AndroidManifest appComponentFactory
        │
        ▼ ⑥ 重打包 + AOSP testkey 重签 → bin.mt.plus.canary
        │
        ▼ ⑦ 安装（可与官方版双开共存）
        │
        ▼ ⑧ 启动时 libloader.so hook PMS → 返回伪 CN=bin 签名
        │   同时解压 res.zip → VIP 插件全部激活
```

### 2.2 为什么能破解

| 防御项 | 2.26.5 状态 | 是否拦得住 |
|---|---|---|
| `assets/testkey.pk8` 仍在 | ✅ 未移除 | ❌ 攻击者照样用 MT 自带密钥重签 |
| AOSP testkey 黑名单 | ❌ 无 | ❌ |
| LSPatch 指纹检测 | ❌ 无任何字符串 | ❌ |
| 反 Xposed/Frida 检测 | ❌ libmtprotect 无相关字符串 | ❌ |
| Native 层自校验签名 | ❌ 没有 GET_SIGNATURES | ❌ 签名校验仍在 Java 层 |
| Java 层 GET_SIGNATURES | 10 处，全部裸露 | 100% 可 hook |
| AppComponentFactory 检测 | ❌ 无 | ❌ |
| seccomp BPF | ✅ 新增 | ❌ 保护的是被 MT 操作的 APK，无关 MT 自身 |

---

## 三、手动破解步骤

### 前置条件

- 一台 **root 手机**（或连接 PC 的 ADB）
- MT 管理器自身（用于提取工具）
- PC 端（用于 LSPatch CLI 命令，也可手机端完成）
- 一个已购 **MT VIP** 的设备（或从破解版导入 plugin 数据）

### Step 1：准备基线 APK

```bash
# 从官方下载 MT 2.26.5
# MT2.26.5.apk
# versionCode: 26052685
# 签名: CN=bin (官方)
```

### Step 2：提取 MT 自带的 AOSP testkey

```bash
# 从任意 MT APK 中提取 testkey
unzip -p MT2.26.5.apk assets/testkey.pk8 > testkey.pk8
unzip -p MT2.26.5.apk assets/testkey.x509.pem > testkey.x509.pem
```

> 这两个文件就在 MT 的 `assets/` 目录中，是 AOSP 标准测试密钥。

### Step 3：导出 VIP 插件数据

```bash
# 在有 VIP 的 MT 设备上，导出 plugin 和 javac 目录
# 路径: /Android/data/bin.mt.plus/files/

# 打包成 res.zip
cd /Android/data/bin.mt.plus/files/
tar -czf ../res.zip plugin/ javac/
# 将 res.zip 复制到 PC 或保留在设备中
```

导出的内容包括：
- `plugin/` — 28+ 个付费插件（每个含 `plugin.mtp` 元信息 + `code` 代码）
- `javac/boot/classes.jar` — javac 编译器内核（1.75 MB）
- `javac/ext/classes.jar` — 扩展库
- `javac/version` — 版本标识

### Step 4：LSPatch 注入

```bash
java -jar lspatch.jar MT2.26.5.apk \
    -m embed \                          # 嵌入式模式
    -l 2 \                              # sigBypassLevel=2 (PMS+Provider hook)
    -k testkey.pk8 \                    # AOSP testkey 私钥
    -K testkey.x509.pem \               # AOSP testkey 公钥证书
    --override-component-factory \      # 覆盖 manifest 的 appComponentFactory
    --add-assets assets/res.zip \       # 注入 VIP 数据
    --add-assets assets/copy_config.json \  # 注入模式配置 {"mode":"1"}
    -o MT_2.26.5_patched.apk
```

LSPatch 注入后产生以下变化：

| 产物 | 说明 |
|---|---|
| `lib/{arm64-v8a,armeabi-v7a,x86,x86_64}/libloader.so` | native loader，内嵌 CN=bin 证书，负责 PMS hook + res.zip 解压 |
| `assets/L00.PKG` | LSPatch payload（LDPK 魔数 `4C 44 50 4B`） |
| `assets/copy_config.json` | `{"mode":"1"}`，控制启动时复制 res.zip |
| `assets/res.zip` | VIP 插件数据（约 3 MB） |
| `classes3.dex` | LSPatch stub factory 类 |
| `classes4.dex` | mt.modder.hub.* 工具库 |
| `AndroidManifest.xml` | `appComponentFactory` 被改写 |
| `包名` | `bin.mt.plus` → `bin.mt.plus.canary`（双开共存） |

### Step 5：签名重打包

```bash
# 使用 AOSP testkey 全签名（v1+v2+v3）
apksigner sign \
    --ks-pass pass:android \
    --key testkey.pk8 \
    --cert testkey.x509.pem \
    --v1-signing-enabled \
    --v2-signing-enabled \
    --v3-signing-enabled \
    --out MT_2.26.5_patched_signed.apk \
    MT_2.26.5_patched.apk
```

验证签名：
```bash
apksigner verify --verbose MT_2.26.5_patched_signed.apk
# 应输出:
#   Subject: C=US, ST=California, L=Mountain View, O=Android, OU=Android, CN=Android
#   SHA-256 指纹: A4:0D:A8:0A:59:D1:70:CA:A9:50:CF:15:C1:8C:45:4D:47:A3:9B:26:98:9D:8B:64:0E:CD:74:5B:A7:1B:F5:DC
```

> ⚠️ **这个 SHA256 是 AOSP testkey 的全局固定指纹**（俗称"蓝鲨签名"），不是 MT 官方 CN=bin 签名。

### Step 6：安装与验证

```bash
# 安装破解版 APK
adb install MT_2.26.5_patched_signed.apk

# 或与官方 MT 双开共存（包名不同）
# 官方: bin.mt.plus
# 破解: bin.mt.plus.canary
```

---

## 四、一键脚本（自动化版）

以下脚本可在 root 手机上直接执行：

```bash
#!/bin/bash
# MT 2.26.5 一键破解脚本

set -e

APK="MT2.26.5.apk"
OUT="MT_2.26.5_patched.apk"

echo "[1/6] 提取 testkey..."
unzip -p $APK assets/testkey.pk8 > testkey.pk8
unzip -p $APK assets/testkey.x509.pem > testkey.x509.pem

echo "[2/6] 导出 VIP 数据..."
if [ ! -f res.zip ]; then
    cd /Android/data/bin.mt.plus/files/
    tar -czf ../res.zip plugin/ javac/
    cd -
fi

echo "[3/6] 创建 copy_config.json..."
echo '{"mode":"1"}' > copy_config.json

echo "[4/6] LSPatch 注入..."
java -jar lspatch.jar $APK \
    -m embed \
    -l 2 \
    -k testkey.pk8 \
    -K testkey.x509.pem \
    --override-component-factory \
    --add-assets res.zip \
    --add-assets copy_config.json \
    -o $OUT

echo "[5/6] 签名重打包..."
apksigner sign \
    --ks-pass pass:android \
    --key testkey.pk8 \
    --cert testkey.x509.pem \
    --v1-signing-enabled \
    --v2-signing-enabled \
    --v3-signing-enabled \
    --out ${OUT%.apk}_signed.apk \
    $OUT

echo "[6/6] 安装..."
adb install -r ${OUT%.apk}_signed.apk

echo "✅ 破解完成！包名: bin.mt.plus.canary"
```

---

## 五、检测破解版是否正常工作

### 5.1 快速验证

| 检查项 | 预期 | 验证方法 |
|---|---|---|
| 包名 | `bin.mt.plus.canary` | MT 主界面显示版本号 |
| 签名 | AOSP testkey | MT → 设置 → 签名信息 |
| VIP 状态 | 全部激活 | 打开任意付费插件 |
| L00.PKG | 存在于 assets | `ls assets/L00.PKG` |
| libloader.so | 存在于 lib/{abi}/ | `ls lib/*/libloader.so` |
| loader_log.txt | 存在于 files/ | `ls files/loader_log.txt` |

### 5.2 运行时日志

破解版启动时 `libloader.so` 会输出日志到：
```
/data/data/bin.mt.plus.canary/files/loader_log.txt
```

关键日志行：
```
"Unlocking vip..."          ← VIP 激活
"native_process_arsc() called"  ← ARSC 加载
"loading mtprotect..."      ← mtprotect 加载（伪装）
"Called native onCreate()!"  ← Application 初始化
```

---

## 六、MT 官方的修复方向（供参考）

如果 MT 官方未来想堵住这个破解路径，最低成本的修复方案：

| 优先级 | 措施 | 工作量 | 效果 |
|---|---|---|---|
| P0 | 把 `assets/testkey.pk8` 换成 MT 自生的调试密钥，不再用 AOSP 标准 testkey | 5 分钟 | 断根，攻击者无法再"用 MT 自带密钥签 MT" |
| P0 | `libmtprotect.so` 的 `JNI_OnLoad` 第一行加 AOSP testkey SHA256 黑名单 | 10 行 C | 挡 90% 脚本 |
| P1 | `JNI_OnLoad` 加 LSPatch 五件套检测（L00.PKG / copy_config.json / libloader.so / loader_log.txt / appComponentFactory） | 50 行 C | 挡 LSPatch v6 攻击 100% |
| P1 | 签名校验下沉到 native 层，绕过 PMS | 1-2 天 | Java 层 hook 失效 |

---

## 七、常见问题

### Q1: 破解版和官方版会冲突吗？
**不会**。破解版包名为 `bin.mt.plus.canary`，官方为 `bin.mt.plus`，可双开共存。

### Q2: 破解会失效吗？
**目前不会**。LSPatch 注入是静态的，只要 L00.PKG、libloader.so、res.zip 不被删除，VIP 永久有效。

### Q3: 更新会覆盖破解吗？
**会**。如果用户手动安装官方更新 APK，会恢复 `bin.mt.plus` 包名和 CN=bin 签名。建议 MT 自更新通道也推送破解版。

### Q4: 能不能用在 MT 2.26.4 上？
**可以**。2.26.4 的破解方法与 2.26.5 完全一致，差异为零。

### Q5: 没有 root 能破解吗？
**能**。LSPatch 嵌入式模式不需要 root，但需要 PC 端运行 LSPatch CLI，或使用手机端已有的 LSPatch 应用。

---

## 八、参考文件

| 文件 | 说明 |
|---|---|
| `MT管理器 2.14.5 MOD-v6 破解版逆向审核报告.md` | 完整逆向审核报告 |
| `MT 2.26.4 与 2.26.5 是否修复 LSPatch v6 攻击的对照分析.md` | 2.26.4/2.26.5 防御能力对照 |
| `MT2.26.5.apk` | 目标 APK 样本 |
| `MT_mtglq_174198.apk` | MT 2.26.4 对照样本 |
| `work/mt-apkt/` | MT 2.26.5 apktool 反编译结果 |
| `work/mt-jadx.log` | jadx 反编译日志 |

---

> **一句话总结**：MT 2.26.5 的破解方法就是"用 MT 破解 MT"——提取 MT 自带的 testkey、LSPatch 注入、植入 VIP 数据、AOSP testkey 重签，一套动作就能让 2.26.5 获得全套 VIP 功能。
