---
name: android-reverse-mac
description: Mac 上做安卓逆向的完整工具链 + 端到端工作流。给本地 LLM（128k 上下文 / 慢推理）当工作手册用，强制"先 grep 后 read"的渐进探索协议。覆盖：jadx/apktool/smali/baksmali 静态、Frida/Objection 动态、mitmproxy/Reqable 抓包、ADB/scrcpy 设备桥、androguard/apkid/quark/MobSF 批量分析。Triggers on：分析 apk / 逆向 app / 抓 http / frida hook / 绕 ssl pinning / 提取接口 / smali 编辑 / 反编译 / 动态调试 android / 加固识别。
license: CC-BY-4.0
metadata:
  author: Jiacheng Li
  version: 2.0.0
  audience: "local LLM (gemma3 MoE class, 128k ctx, 45 t/s, easily stalls on large code)"
  scope: macOS (Apple Silicon)
  date: 2026-06-04
---

# Mac 安卓逆向工具与工作流指南（LLM 优化版 v2）

> **本文档面向：本地部署的 gemma3 类 MoE 模型**（128k 上下文，约 80k 有效；45 t/s；面对大量 jadx/java/kt 代码易卡住）。
> **设计原则**：每条信息都要"被读了之后能立刻执行"。命令优先于解释。决策树优先于命令清单。
> **如果你是人类用户**：跳过 §0 §1 §2 直接看 §3-§7。

---

## §0 LLM 自救协议（最重要，永远先读这一节）

### 0.1 七条铁律（违反任意一条 = 上下文爆炸）

| # | 铁律 | 反面教材 |
|---|---|---|
| 1 | **永远先 count / grep / outline，再 read 全文** | ❌ `cat out-jadx/sources/com/.../Big.java`（5000+ token）|
| 2 | **一次只 read 一个文件 ≤ 200 行**；超过先用 `head -200` 或 `sed -n '100,300p'` | ❌ 整目录全读 |
| 3 | **用 grep 找入口，用 jadx outline 看结构**，**不要把目录树倒进上下文** | ❌ `find out-jadx -name '*.java'`（输出几万行）|
| 4 | **任务超过 5 步就写中间笔记到磁盘**（`/tmp/work-notes.md`），下一轮直接读笔记 | ❌ 全靠记 |
| 5 | **每个 grep 加 head**：`grep -rln ... \| head -20`，从不裸跑 | ❌ 几千行匹配淹没 |
| 6 | **用 androguard / aapt2 / apkid 拿摘要，jadx 只用来精读单个类** | ❌ jadx 整包反编译再读 |
| 7 | **不确定就停下问用户**，不要瞎猜路径 / 类名 / 包名 | ❌ 编造类名 |

### 0.2 Token 预算速查（用 jadx 之前必看）

| 操作 | 估算 token | 推荐用法 |
|---|---|---|
| `aapt2 dump badging app.apk` | 200-500 | ✅ 总是先跑 |
| `androguard apkid app.apk` | 100 | ✅ 总是先跑 |
| `apkid app.apk` | 200 | ✅ 加固识别 |
| `apktool d --no-src` 后看 manifest | 500-2000 | ✅ 读 |
| `grep -rln 'keyword' out-jadx/sources/ \| head -20` | 200-1000 | ✅ 找入口 |
| 单个 jadx Java 文件（中等类） | 1000-5000 | ⚠️ 谨慎 |
| 整个 jadx outline（仅类名 + 方法签名） | 5000-20000 | ⚠️ 大 APK 别整读 |
| **`find out-jadx -name '*.java'`** | **30000+** | ❌ 禁止 |
| **裸 `cat` 任何 .java** | **不可控** | ❌ 禁止 |

**128k 上下文实际可用 ≈ 80k token**（留 50% 给思考/输出）。
**预算分配建议**：探索 20k + 精读 30k + 思考输出 30k。

### 0.3 不知从何做起时的兜底决策树

```
拿到 APK / app 包名 / 目标 → 不要慌
│
├─ 用户说"逆向这个 app"      → §3 工作流 A (拆 + 读 manifest)
├─ 用户说"抓接口/抓包"       → §3 工作流 B (mitmproxy)
├─ 用户说"绕过签名校验/ssl"  → §3 工作流 C (objection 一键)
├─ 用户说"找 X 函数怎么签名" → §3 工作流 E (静态 + 动态)
├─ 用户说"加固分析/壳分析"   → §3 工作流 F + apkid
├─ 用户说"批量扫一批 apk"    → §3 工作流 F (androguard 脚本)
└─ 完全不清楚要做啥          → 先跑 §3 工作流 A 的前 3 步出基础摘要，再问用户具体要看什么
```

### 0.4 卡住自救三件套

| 症状 | 自救动作 |
|---|---|
| 上下文快满（看到自己输出变短） | 立刻把现有理解写进 `/tmp/work-notes.md`，然后让用户重启会话从笔记继续 |
| 不知道下一步 grep 什么 | 回到 §3 对应工作流的"标准命令清单"，按顺序跑 |
| jadx 反编译失败 / 类名混淆乱 | 退回 `apktool d` 看 smali，或用 `androguard` 拿结构摘要 |
| 命令不知道怎么写 | 看 §4 命令速查 |

---

## §1 当前 Mac 已装工具清单（含 ✅ 状态）

### 1.1 命令行（PATH 直接可用）

| 工具 | 版本 | 路径 | 一句话用法 |
|---|---|---|---|
| ✅ `jadx` / `jadx-gui` | 1.5.5 | `/opt/homebrew/bin/` | DEX → Java |
| ✅ `apktool` | 3.0.2 | `/opt/homebrew/bin/` | APK 拆/重打包 |
| ✅ `smali` / `baksmali` | 3.0.9-dev | `~/.local/bin/` | Smali 汇编/反汇编（fatJar from google/smali） |
| ✅ `mitmproxy` / `mitmweb` | 12.2.3 | `/opt/homebrew/bin/` | HTTPS 抓包 |
| ✅ `frida` (+15 子命令) | 14.8.2 | `~/.local/bin/` | 动态 hook |
| ✅ `objection` | 1.12.4 | `~/.local/bin/` | Frida 上层封装 |
| ✅ `androguard` | 4.1.3 | pipx | Python APK 库 |
| ✅ `apkid` | 3.1.0 | `~/.local/bin/` | 加固/编译器指纹 |
| ✅ `quark` | 20.1 | `~/.local/bin/` | 行为级 APK 风险检测 |
| ✅ `scrcpy` | 4.0 | `/opt/homebrew/bin/` | 投屏 + 键盘控制 |
| ✅ `ghidraRun` | brew | `/opt/homebrew/bin/` | Native .so 分析 |
| ✅ `docker` | 29.4.0 | `/usr/local/bin/` | 跑 MobSF 等 |

### 1.2 Android SDK build-tools（在 `$ANDROID_HOME` 下）

```bash
# 已在 ~/.zshrc 加了 platform-tools/cmdline-tools/emulator
# ⚠️ 还差一行（待用户补到 ~/.zshrc）：
export PATH="$PATH:$ANDROID_HOME/build-tools/$(ls -1 $ANDROID_HOME/build-tools 2>/dev/null | sort -V | tail -1)"
```

补完后可用：`adb` / `fastboot` / `apksigner` / `aapt2` / `zipalign` / `emulator`。

### 1.3 GUI（启动即用）

- `/Applications/Android Studio.app` — IDE + AVD + Logcat
- `/Applications/Reqable.app` — 现代抓包 GUI（Charles 替代）
- `jadx-gui` — jadx 桌面 GUI
- `ghidraRun` — Ghidra GUI

### 1.4 Docker 镜像（已拉）

- `opensecurity/mobile-security-framework-mobsf:latest`（3.41 GB）
  启动：`docker run -it --rm -p 8000:8000 opensecurity/mobile-security-framework-mobsf` → http://localhost:8000

### 1.5 仍未装（按需，不重要）

`radare2 / cutter / binwalk / yara / dex2jar / apk-mitm`。日常逆向用上面 12 个工具足够。

---

## §2 给 LLM 的"渐进式探索协议"

**核心思路**：把 APK 分析拆成 4 个阶段，每阶段输出**结构化摘要**，下一阶段从摘要决策，**不依赖上一阶段的全文**。

```
阶段 1：摘要层（< 2k token）
        aapt2 dump badging + apkid + androguard apkid
        → 拿到包名/版本/权限/加固情况

阶段 2：地形层（< 5k token）
        apktool d --no-src（仅 manifest + 资源，不拆 smali）
        ls 各目录大小、列 dex 数量、列 .so 列表
        grep 几个关键字符串
        → 知道这个 app 是什么、用什么技术栈

阶段 3：定位层（< 10k token，按需）
        jadx --no-res 反编译到磁盘
        grep -rln 关键词找入口类
        每次只 read 一个 < 200 行的相关类
        → 找到关心的具体方法/字段

阶段 4：精读层（< 20k token，按需）
        逐方法 read，用 baksmali 验证关键点
        必要时配 frida 动态验证
        → 还原一个具体算法 / 漏洞 / 接口
```

**永远不在阶段 3/4 之前进 jadx 源码**。

---

## §3 七大工作流（按用户意图分支）

> 每个工作流给"最短路径命令"。每条命令旁的 `// LLM:` 注释告诉模型该期待什么输出。

### §3.A 工作流 — 拆开 APK 看基础信息

```bash
APK=target.apk    # 用户给的 APK 路径

# A1 摘要（永远先跑这 3 个，token 极省）
aapt2 dump badging "$APK" | head -20         # LLM: 包名/版本/SDK/launcher activity
apkid "$APK"                                  # LLM: 加固/打包工具识别
androguard apkid "$APK"                       # LLM: 签名 + 包基本信息

# A2 解包 manifest + 资源（不拆 smali）
apktool d -f --no-src -o out-apkt "$APK"     # LLM: 输出在 out-apkt/，不读这里的 smali
head -50 out-apkt/AndroidManifest.xml         # LLM: 只看头 50 行先

# A3 权限 + 入口（每个一行 grep + head）
grep -E "uses-permission" out-apkt/AndroidManifest.xml | head -30
grep -E "<activity android:exported=\"true\"" out-apkt/AndroidManifest.xml | head -20
grep -E "<service |<receiver |<provider " out-apkt/AndroidManifest.xml | head -20

# A4 看 dex 数 + native lib 列表（拓扑认知）
unzip -l "$APK" | grep -E "classes.*\.dex|\.so$" | head -30   # LLM: 几个 dex / 用哪些 .so

# 如果用户还要看 Java 源码 → 阶段 3，否则停在这里
```

**LLM 输出建议**：A1-A4 的全部结果**结构化为一张表**回给用户：包名/版本/权限数/加固/dex 数/native lib 数。不要复述命令输出。

### §3.B 工作流 — 抓 HTTPS API（接口逆向必经）

**三段式：起代理 → 让 app 信任 CA → 抓**。

```bash
# B1 起 mitmweb（默认 :8080 代理 + :8081 控制台）
mitmweb --listen-host 0.0.0.0 --listen-port 8080 &     # LLM: 后台跑

# B2 把 mitmproxy CA 装到手机（三选一）
# 路径 A：root 手机直接装系统 CA
HASH=$(openssl x509 -inform PEM -subject_hash_old -in ~/.mitmproxy/mitmproxy-ca-cert.cer | head -1)
cp ~/.mitmproxy/mitmproxy-ca-cert.cer /tmp/$HASH.0
adb root && adb remount
adb push /tmp/$HASH.0 /system/etc/security/cacerts/
adb shell chmod 644 /system/etc/security/cacerts/$HASH.0
adb reboot

# 路径 B：无 root，apk-mitm 自动改 networkSecurityConfig（需 npm i -g apk-mitm）
apk-mitm "$APK"                  # 输出 target-patched.apk
adb install target-patched.apk

# 路径 C：root + Magisk + LSPosed → 装 TrustMeAlready 模块

# B3 手机走代理
adb reverse tcp:8080 tcp:8080   # 让手机 127.0.0.1:8080 = Mac 的 mitmproxy
# 或：手机 WiFi 高级 → 代理 → 手动 → host=Mac IP, port=8080

# B4 抓到了但有 SSL pinning？→ 工作流 C
# 用 mitmweb 浏览：open http://127.0.0.1:8081
```

**LLM 处理 mitmproxy 输出的纪律**：

| 流量量 | 处理 |
|---|---|
| < 20 个请求 | 列表所有 URL + status |
| 20-100 个 | 按 host 聚合，每 host 给 3 个代表样本 |
| > 100 个 | **强制写脚本筛选**（见下方 `extract_api.py`），不要逐条读 |

```python
# /tmp/extract_api.py  —  mitmdump -s /tmp/extract_api.py
from mitmproxy import http
TARGET = "api.target.com"   # LLM: 让用户给出目标域名再填
def request(flow):
    if TARGET not in flow.request.host: return
    print(flow.request.method, flow.request.pretty_url)
    print("HDR", dict(flow.request.headers))
    if flow.request.content:
        print("BODY", flow.request.text[:300])
def response(flow):
    if TARGET not in flow.request.host: return
    print("<-", flow.response.status_code, flow.request.pretty_url)
    print("RES", flow.response.text[:300])
```

### §3.C 工作流 — 绕过 SSL Pinning + Root 检测（一键流）

**前提**：手机已 root + frida-server 已在手机 `/data/local/tmp/` 上跑。

```bash
# C1 准备 frida-server（仅首次）
FV=$(frida --version)
curl -sLo /tmp/fs.xz "https://github.com/frida/frida/releases/download/$FV/frida-server-$FV-android-arm64.xz"
unxz /tmp/fs.xz
adb push /tmp/fs /data/local/tmp/frida-server
adb shell "chmod 755 /data/local/tmp/frida-server && su -c '/data/local/tmp/frida-server &'"

# C2 验证连通
frida-ps -U | head            # LLM: 列出手机上跑的进程

# C3 objection 一键绕过
objection -g com.target.app explore
# 进入交互终端后：
#   android sslpinning disable       ← 一行干掉所有主流 SSL pinning 库
#   android root disable             ← 一行干掉 root 检测
#   exit
```

### §3.D 工作流 — Frida 自定义 Hook（精确控制）

```javascript
// /tmp/hook.js
Java.perform(function () {
    // 模板 1：hook 一个方法
    var Sign = Java.use("com.target.app.utils.SignUtil");   // LLM: 类名待替换
    Sign.gen.overload('java.lang.String').implementation = function (raw) {
        console.log("[+] gen(" + raw + ")");
        var r = this.gen(raw);
        console.log("[+] gen → " + r);
        return r;
    };
    // 模板 2：改返回值（强制 isVip = true）
    var V = Java.use("com.target.app.user.VipChecker");
    V.isVip.implementation = function () { return true; };
});
```

```bash
frida -U -l /tmp/hook.js -f com.target.app --no-pause
```

**Hook native 函数**：

```javascript
// /tmp/hook-native.js
var addr = Module.findExportByName("libSign.so", "sign");
Interceptor.attach(addr, {
    onEnter:  function (args)   { console.log("in: " + Memory.readUtf8String(args[0])); },
    onLeave:  function (retval) { console.log("out: " + Memory.readUtf8String(retval)); }
});
```

### §3.E 工作流 — 提取 native .so 的签名算法（最值钱的接口逆向）

```bash
# E1 抽 .so
unzip -j "$APK" 'lib/arm64-v8a/libSign.so' -d /tmp/

# E2 看导出函数（短输出，可放上下文）
nm -D /tmp/libSign.so | grep " T " | head -30      # LLM: T = 可调函数

# E3 看可读字符串（找 key/secret/算法名）
strings -n 6 /tmp/libSign.so | grep -iE "key|secret|aes|rsa|hmac|md5|sha|token|salt" | head -20

# E4 Ghidra 反编译（人工 GUI 操作，LLM 引导用户）
echo "ghidraRun &  → File→New Project → Import libSign.so → 找 Java_xxx_sign 双击"

# E5 frida hook 验证你逆出来的算法
# 见 §3.D hook-native.js

# E6 Python 复刻
python3 -c "
import hmac, hashlib
KEY = bytes.fromhex('xxxxx')   # 从 Ghidra 反编译里抠出来的常量
msg  = b'ts=1700000000&uid=42'
print(hmac.new(KEY, msg, hashlib.sha256).hexdigest())
"
```

### §3.F 工作流 — 批量自动化分析

```python
# /tmp/scan.py — python3 /tmp/scan.py *.apk
# LLM: 拿到一批 APK 想快速过一遍时用，每个 APK 输出一行 JSON
from androguard.core.apk import APK
import sys, json
for p in sys.argv[1:]:
    a = APK(p)
    print(json.dumps({
        "file": p, "pkg": a.get_package(), "ver": a.get_androidversion_name(),
        "minSdk": a.get_min_sdk_version(), "targetSdk": a.get_target_sdk_version(),
        "perms": len(a.get_permissions()),
        "acts": len(a.get_activities()), "svcs": len(a.get_services()),
        "native": bool([f for f in a.get_files() if f.endswith('.so')]),
        "sig_sha256": a.get_certificate_der(a.get_signature_name()).hex()[:16] if a.get_signature_name() else None,
    }, ensure_ascii=False))
```

加固识别：

```bash
apkid "$APK"             # LLM: 输出会指明 360/Bangcle/ApkProtect/ApkVmProtect 等壳
quark -a "$APK" -s       # LLM: 行为级风险打分（短输出）
```

MobSF 一键 Web 报告（人工浏览器看，LLM 引导）：

```bash
docker run -it --rm -p 8000:8000 opensecurity/mobile-security-framework-mobsf
# 浏览器 http://localhost:8000 拖入 APK
```

### §3.G 工作流 — 整套破解某 VIP（伦理灰区，仅自有 app）

```
1. §3.A 拿基础信息
2. jadx-gui 打开 APK, grep "VipChecker|isPremium|isVip"
3. 看那个类是不是调 PackageManager.getPackageInfo + GET_SIGNATURES
4. 看是不是远程 /api/check-vip 接口（去 §3.B 抓）
5. 选一个绕过路径：
   - 动态 = §3.D frida hook 改返回值
   - 永久 = apktool d → 改 smali return-boolean v0=0x1 → apktool b → apksigner sign → adb install
```

---

## §4 命令速查（按工具分组，剪贴友好）

### §4.1 adb

```bash
adb devices                           # 列设备
adb shell                             # 进 shell
adb install -r -g app.apk             # 安装 + 自动 grant 所有权限
adb shell pm list packages -f | grep KEYWORD       # 找包名 + apk 路径
adb shell pm path com.target.app                   # 拿已装 app 的 apk 路径
adb pull /data/app/.../base.apk ./pulled.apk       # 拉 apk
adb shell am start -n com.target.app/.MainActivity
adb shell am force-stop com.target.app
adb logcat -s '*:E' | grep com.target.app          # 只看错误 + 过滤包名
adb reverse tcp:8080 tcp:8080         # 手机的 8080 转发到 Mac 的 8080（mitmproxy）
adb forward tcp:27042 tcp:27042       # frida-server 默认端口
adb shell screencap -p /sdcard/s.png && adb pull /sdcard/s.png
```

### §4.2 完整重打包 apktool → zipalign → apksigner

```bash
apktool d -f -o app "$APK"
# ... 改 app/smali/ 或 app/AndroidManifest.xml ...
apktool b -o mod.apk app
zipalign -p 4 mod.apk mod-aligned.apk
apksigner sign --ks ~/.android/debug.keystore --ks-pass pass:android \
    --ks-key-alias androiddebugkey \
    --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
    mod-aligned.apk
apksigner verify --print-certs mod-aligned.apk
adb install -r mod-aligned.apk
```

### §4.3 frida 一行流

```bash
frida-ps -U                       # 列设备进程
frida-ps -Uai                     # 列所有已装 app + PID
frida -U -n com.target.app -l /tmp/hook.js                 # attach 已跑
frida -U -f com.target.app -l /tmp/hook.js --no-pause      # spawn + hook
frida-trace -U -j 'com.target.app.api.*!*' com.target.app  # 只 trace 该包
frida-trace -U -i 'open' -i 'read' com.target.app          # trace libc
```

### §4.4 mitmproxy

```bash
mitmweb -p 8080                          # GUI 启动
mitmdump -p 8080 -w out.flows            # 保流量到文件
mitmdump -r out.flows                    # 回放
mitmdump -s /tmp/extract_api.py          # 自定义脚本筛选
```

### §4.5 androguard (CLI)

```bash
androguard apkid "$APK"        # 包名 / 版本 / 签名
androguard sign "$APK"         # 签名指纹
androguard arsc "$APK"         # 资源表
androguard axml "$APK" AndroidManifest.xml
```

### §4.6 加固识别

```bash
apkid "$APK"
strings "$APK" | grep -iE "qihoo|bangcle|ijiami|tencent.legu|alibaba.security|ApkVmProtect|np\.|com\.wn\.np"
```

---

## §5 接口逆向方法论（精简版）

### 5.1 任何 HTTP 接口最终就是 4 件事

1. **URL pattern** — 路径模板 + 动态参数
2. **Headers** — 哪些是 const，哪些是 derived
3. **Body 签名** — `sign / token / signature` 怎么生成
4. **Response** — cleartext 还是要本地解密

### 5.2 从抓包到 Python 复刻的 6 步

```
[抓 N 个样本]            mitmproxy / Reqable，对比变化量
   ↓
[grep 关键词]            grep -rln '"x-sign"\|signParam\|generateSign' out-jadx/sources/ | head
   ↓
[读签名生成类]            一般是 utils.SignUtil.gen(...) 之类
   ↓ 如果调 native
[Ghidra 看 .so]          找 Java_xxx_sign，反编译伪 C
   ↓
[frida hook 验证]        见 §3.D
   ↓
[Python 复刻]            hmac/cryptography 库重新实现
```

### 5.3 常见签名套路

| 套路 | 特征 | 破解 |
|---|---|---|
| HMAC-SHA256(secret + body) | header `x-sign`, 64 hex | grep 找 secret 常量 |
| MD5(params + ts + secret) | 老 app 常见 | 同上 |
| RSA 签名 | base64, ~344 字符 | 找 PEM 字符串 |
| 白盒 AES | .so 里巨大查找表 | frida hook 拿明文 |
| VMP（如 NP ApkVmProtect） | sign 调 `vmInterpret(bytecode)` | hook vmInterpret 入口 |
| JNI + JS 混合（最难） | JNI 调 V8/JSC 跑混淆 JS | hook JS 引擎边界 |

### 5.4 反检测对抗

| 检测项 | 对策 |
|---|---|
| 代理 (`System.getProperty("http.proxyHost")`) | frida 返回 null |
| SSL Pinning | `objection android sslpinning disable` |
| Root | `objection android root disable` |
| Frida | hook `/proc/self/maps` 隐藏 frida-agent |
| Magisk | LSPosed + Shamiko 模块 |
| Emulator | hook `Build.MODEL` / sensors |

---

## §6 开源 MCP / Skill 现成可接入

> 给本地 LLM 接 MCP 用，把繁重的工具调用从对话上下文里挪出去。

### 6.1 推荐套装

| 套装 | 适用场景 | MCP 工具数 |
|---|---|---|
| **jadx-mcp + apktool-mcp** | 让 LLM 直接读类、改 manifest，不用每次 grep | 共 ~15 |
| **ghidra-mcp** | Native .so 分析 | 245（最完整但工具多易迷路） |
| **frida-mcp** | 远程发 hook 脚本到手机 | ~12 |
| **mobsf-mcp** | 一键报告 | ~5 |

### 6.2 Claude Desktop / LM Studio 接 MCP 模板

`~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "jadx":    { "command": "python3", "args": ["/path/to/jadx-mcp/server.py"] },
    "apktool": { "command": "node",    "args": ["/path/to/apktool-mcp/index.js"] },
    "frida":   { "command": "uv",      "args": ["run", "frida-mcp"] }
  }
}
```

### 6.3 给小模型的 MCP 使用纪律

| 纪律 | 原因 |
|---|---|
| 不要 `tools/list` 几百个工具 | 上下文一次性吃满 |
| 一次 task 只激活 1-2 个 MCP server | 别让 245 个 ghidra 工具淹没你 |
| 优先用 `*_search` / `*_outline` / `*_list` | 比 `*_read_full` 省 10-50x token |
| 工具返回数据 > 2k token → 先存盘再续读 | 防止上下文爆炸 |

---

## §7 仓库内相关文档（互相引用）

- `桌面端 APK Toolbox 架构蓝图.md` — 自研工具设计
- `MT 2.26.5 MCP 实现深度解析与 LSPatch v6 补漏分析.md` — MCP server 设计参考
- `MT管理器 2.14.5 MOD-v6 破解版逆向审核报告.md` — 完整破解链路实战案例
- `4 个破解 APK 横向对比 + 攻击工艺光谱.md` — 国内 mod 圈工艺
- `QA.md` — PC 端 vs 手机端工具链对比

---

## §8 资源链接（最少够用版）

- frida https://frida.re/
- objection https://github.com/sensepost/objection
- jadx https://github.com/skylot/jadx
- apktool https://apktool.org/
- google smali https://github.com/google/smali
- androguard https://github.com/androguard/androguard
- MobSF https://github.com/MobSF/Mobile-Security-Framework-MobSF
- frida-codeshare（现成 hook） https://codeshare.frida.re/
- TrustMeAlready https://github.com/ViRb3/TrustMeAlready
- MCP 协议官网 https://modelcontextprotocol.io/

---

## §9 历史变更

| 版本 | 日期 | 变更 |
|---|---|---|
| 1.0.0 | 2026-06-04 | 初版（人类参考书风格） |
| **2.0.0** | **2026-06-04** | **重写为 LLM 友好版**：新增 §0 自救协议 / §2 渐进探索协议 / 各工作流加 Token 预算和 `// LLM:` 注释 / 删除冗余解释 / 命令优先 |
