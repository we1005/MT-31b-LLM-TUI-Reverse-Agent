# 桌面端 APK Toolbox 架构蓝图

> **来源**：MT 管理器 2.26.5 + NP 管理器 3.1.40 + MT 2.26.4 演进 diff 的逆向分析综合
> **日期**：2026-05-29
> **目标读者**：决定从零起一套桌面端 APK 工具箱的开发者
> **结论先行**：MT/NP 把 PC 端碎片化工具链（apktool + jadx + apksigner + smali + ADB + Frida...）整合到了**手机端**。桌面端反向工程要做的是把这条整合链路**搬到桌面**，并利用桌面优势（多核、大内存、网络畅通、IDE 级 UI）超越 MT/NP。

---

## 0. 两套生态对照速查表

| 维度 | MT 2.26.5（彬哥 / CN=bin） | NP 3.1.40（刘均 / CN=liujun） |
|---|---|---|
| 顶层包 | `bin.mt.plus` + `bin.mt.plugin` | `player.normal.np` + `np.signer/autoSign/obscuring/apkzlib/dcc/lsp/guard` |
| Java 类数（jadx） | 15124 | 12796 |
| 风格 | **整合派**：自研 ZIP + 编辑器 + 语法引擎 + 插件 API | **保护派**：把"商业 APK 加固服务"塞进 APK 编辑器 |
| Hook 框架 | LSPlant + xhook | SandHook + Pine + LSPlant（assets 备份） |
| 沙箱 | seccomp BPF（2.26.5 新增） + xhook 拦截 libc IO | 无 seccomp，靠 VMP 自保 |
| 代码保护 | libmtprotect 2MB（itanium demangle + 反射缓存 + DEX 处理） | 自研 **APK-VM**（libnpvmp + np.dcc 编译器）+ 控制流混淆 8.0 + libnpprotect 3MB |
| 符号策略 | 明文 `Java_bin_mt_plus_*` | 1147 个导出函数全部 10 位随机名 + JNI 动态注册 |
| 反调试 | libmtprotect 内嵌 | **独立** `libantitrace.so`（专职轮询 `/proc/<pid>/status` TracerPid） |
| 默认签名 | **AOSP testkey**（`assets/testkey.pk8/.x509.pem`，蓝鲨签名源头） | 加密 JKS（`assets/a/s`，密码藏 libnp.so） |
| 注入模板 | `assets/killer_{dex,arm,x64,a64,x86}` = ApkSignatureKillerEx 全 ABI 预编译 | `np.lsp.PatchConfig.sigBypassLevel` = LSPatch 集成（粒度更细：0/1/2/3） |
| 压缩 | zstd-jni | 7z + RAR + zstd |
| 终端 | libterm | libpty + libaterm（PTY） |
| 编辑器 | 自研 + `assets/syntax/*.mtsx`（13+ 种语言 DSL） | 套 sora-editor 二次开发 |
| 免 root | Shizuku + Dhizuku | 仅 Shizuku |

**一句话总结**：**MT 是"工具人"思维，NP 是"军火商"思维**。MT 把工具链做到极致工程化；NP 把代码保护做到极致黑产化（自家加固成品 = libnpvmp + 控制流混淆 8.0，售卖给第三方）。

---

## 1. 桌面端可直接抄的"链路模板"

### 1.1 APK 解析/重打包（核心管道，必抄）

```
源 APK
  │
  ▼ [Unzip 层]
  ├─ ZIP 自研库（MT 的 l.C11030）  ← 桌面版用 zip4j / apache-commons-compress 都行
  │   特点：流式 + 符号链接 + 乱码文件名 + zstd
  │
  ▼ [拆解层]
  ├─ AndroidManifest 二进制 XML  → AxmlParser（MT l.C12543）+ 编辑器（l.C16248）
  ├─ resources.arsc              → arsc parser（自研 / aapt2）
  ├─ classes*.dex                → dexlib2 (jf 系) — NP 也是这套（np.obscuring.NPDexEditor 包装层）
  ├─ lib/                        → 仅复制
  └─ assets/                     → 仅复制
  │
  ▼ [编辑层]
  │   ├─ Manifest 节点编辑       Inspector 风格 GUI
  │   ├─ Smali 编辑              语法高亮 + 跳转 + 重命名
  │   ├─ Arsc 字符串/ID 编辑     ResValueEditor
  │   ├─ Hex 编辑                Hex.class（MT assets 已有 Java 实现，可参考）
  │   └─ Java 反编译查看         套 jadx-core lib（推荐）
  │
  ▼ [回打包层]
  ├─ 重建 ZIP（保持 STORED/DEFLATE 与原 APK 一致 — apktool 的 doNotCompress 列表）
  ├─ zipalign 4 字节对齐
  └─ 签名层
      ├─ v1 (JAR signature)     → bouncycastle 自实现
      ├─ v2/v3 (APK Sig Block)  → 内嵌 Google apksigner（NP 抄了 com.android2.apksigner）
      └─ keystore 管理           → JKS / PKCS#12 / OpenSSL pk8+x509
```

**借鉴要点**：
1. **doNotCompress 列表必须保留** —— MT/NP 都在 apktool.yml 里维护，桌面版要做同样的列表，否则 APK 体积膨胀、且容易被识别"重打包"
2. **MTIO 协议** —— MT 用 `libmt3.so` 的 `Features3.read/write/seek/tell/truncate/startMTIO` 做了一层文件 IO 抽象，桌面版可以用 NIO + 内存映射做对等
3. **自研 ZIP** vs **三方库** —— MT 自研是为了在手机沙箱里规避 SAF 限制（`listGarbledFileNames`），桌面端没这个约束，**直接用 zip4j 或 java.util.zip 即可**

---

### 1.2 "一键去签名校验"链路（最值得抄 + 法律红线）

**MT 路线** —— 注入预编译 `killer_dex`：
```
1. 从 assets/killer_{abi} 选目标 ABI 的二进制
2. 从 assets/killer_dex 取 dex 模板
3. 解析目标 APK 的 application 标签 → 找 onCreate
4. 把 ApkSignatureKillerEx 的 Application 类前置（替换或继承）
5. 注入完成 → 重打包 → 重签名
```

**NP 路线** —— LSPatch 集成：
```
np.lsp.PatchConfig {
    int sigBypassLevel = 0..3;  
    // 0=不绕过 / 1=PMS hook / 2=PMS+Provider hook / 3=深度（含动态加载校验）
}
+ Landroid/n/PmsHookApplication（PMS hook 模板，比 ApkSignatureKillerEx 更现代）
```

**桌面版借鉴**：
- 把 NP 的 `sigBypassLevel 0-3` 做成 UI 上的滑杆
- 提供 **两个引擎**：传统 ApkSignatureKillerEx（适配老 app）+ LSPatch 嵌入式（适配新 app）
- ⚠️ **法律红线**：这功能用在自有 APP / 安全研究 OK，用在第三方破解就是侵权 + 违反《计算机软件保护条例》。桌面版默认应**关闭这一项**，加 EULA 二次确认。

---

### 1.3 代码编辑器引擎（MT 的最大亮点）

**MT 自研路线**（强烈推荐桌面版抄）：
```
assets/syntax/*.mtsx  ← MT 自定义的语法高亮 DSL，类似 TextMate .tmLanguage 但更轻
├─ cpp.mtsx / go.mtsx / lua.mtsx / js.mtsx / ts.mtsx / zig.mtsx
├─ jasm.mtsx          ← Java/Smali 汇编（Java assembly）
├─ mtd.mtsx           ← MT 自定义脚本格式
├─ markdown.mtsx / xml.mtsx / toml.mtsx
└─ init/{builtins,styles}.mtsx  ← 主题/内建关键字
```

**桌面版方案对照**：
| 桌面方案 | 优势 | 劣势 |
|---|---|---|
| Monaco Editor（VSCode 同款） | 生态成熟、TextMate 语法直接用 | 跑在浏览器/WebView，桌面感弱 |
| RSyntaxTextArea（Swing） | 纯 Java，桌面原生 | 主题/性能一般 |
| **Sora-Editor**（NP 用的） | 安卓友好，Compose 支持好 | 桌面端要包装 |
| **Tree-sitter + 自研渲染** | 增量解析、语法树可用于跳转/重构 | 工作量大 |

**强烈推荐组合**：**Tree-sitter（解析）+ Monaco（渲染）+ DAP/LSP（语义）**。MT 没用 Tree-sitter（自研 tokenizer），桌面版可以直接超越。

---

### 1.4 终端集成（小而美的功能）

- MT：`libterm.so` 简单 PTY
- NP：`libpty.so + libaterm.so + com.github.maoabc.aterm.ATermActivity`（基于 maoabc/aterm 开源）

**桌面版**：直接用 **xterm.js + node-pty**（Electron 路线）或 **JediTerm**（IntelliJ 同款，Swing 路线）。这块没有惊喜，照抄。

---

### 1.5 插件系统（MT 独有，NP 没做）

MT 的 `bin.mt.plugin.api` 包是**完整的插件 SDK**：
```
bin.mt.plugin.api/
├─ editor/      TextEditor, TextEditorFunction, TextEditorBaseMenu
├─ ui/          PluginUI, PluginButton, PluginEditText, PluginDialog (20+ 控件)
├─ preference/  配置持久化
├─ regex/       正则引擎封装
├─ translation/ 文本翻译
└─ util/        通用工具
```

**桌面版借鉴**：**直接抄 VSCode Extension API 的设计哲学，但 MT 的"小而完整"是一个绝佳的中间形态参考**。建议：
- **插件运行时**：Quickjs / GraalJS（嵌入 JVM 跑 JS 插件） 或 sandboxed Kotlin Script
- **API 表面**：editor / ui / fs / regex / cmd / packager（APK 操作）/ signer
- **权限模型**：声明式 manifest.json（VSCode 风格）+ 用户确认弹窗（NP 没做这层）

---

## 2. 桌面版必抄的 5 个 "工艺指纹"

这些不是功能模块，而是 MT/NP 多年迭代沉淀下来的**工艺细节**，照抄能节省你几个月的踩坑：

| # | 工艺 | 来源 | 桌面版怎么用 |
|---|---|---|---|
| 1 | **doNotCompress 列表** | apktool.yml | 重打包时严格保留 STORED 项（避免破坏 resources.arsc 内 mmap） |
| 2 | **AOSP testkey 作为"默认签名"** | MT `assets/testkey.pk8/.x509.pem` | 用户首次签名时弹"是否使用默认测试密钥"（即蓝鲨签名），方便快速验证 |
| 3 | **APK 解析失败时回退 7z 模式** | MT `assets/sevenzipjbinding-platforms` + NP `lib7-Zip-JBinding.so` | 用 4j 库 fallback to 7z，对付损坏的 APK |
| 4 | **乱码文件名容错** | MT `Features3.listGarbledFileNames` | 桌面版按 GBK/UTF-8/CP437 三种解码尝试，让 中文文件名 APK 也能拆 |
| 5 | **多 dex 合并 / 拆分** | NP `np.obscuring.NPDexEditor` 多 dex 支持 | 桌面版默认显示 classes/2/3/4 合并视图，按"原始 dex"分组可切换 |

---

## 3. 桌面版**应该比 MT/NP 强**的地方

这些是手机端做不到、桌面端独享的能力，是你产品差异化的护城河：

### 3.1 用桌面优势重新定义体验

| 维度 | MT/NP（移动端约束） | 桌面版（应该做到） |
|---|---|---|
| 编辑器 | 小屏 + 触屏 | 多窗口 + 分屏 + 多光标 + Vim/Emacs 模式 + LSP |
| 反编译查看 | 嵌入式 jadx，慢 | 直接 `jadx-gui` lib 嵌入，配 IDA Pro / Ghidra / JEB Decompiler 外联 |
| 跳转 | 没有真正的跨文件跳转 | Tree-sitter 全工程索引 → 类/方法/字段 F12 跳转 |
| diff | 没有 | 内建 diff viewer，支持 APK vs APK 全量 diff（manifest / smali / resources / native lib） |
| 调试 | 没法上 Frida | **内建 Frida**：APK 选中类 → 右键"Frida hook this method" → 一键生成脚本 → ADB 部署 |
| 网络抓包 | 没有 | 集成 mitmproxy / Charles 代理，APK 启动时自动注入 CA |
| AI | 没有 | 选中 smali → "AI 解释这段代码" / "AI 还原成 Java" / "AI 找出 VIP 检查点" |

### 3.2 内置黑科技模块

1. **APK 横向 diff 引擎**：
   - 用户拖入 N 个 APK（同一 app 不同版本，或官方 vs 修改版）
   - 自动 jadx + apktool，分类显示 diff：manifest 权限/组件、smali 方法增删、native lib 大小、资源差异
   - 这正是我们前面 audit Snaptube/Spotify/Kuwo 时手工干的活，**应当工具化**

2. **签名指纹库**：
   - 内置常见破解圈签名指纹库（蓝鲨 = AOSP testkey、yxssp.com、xiyou、cracker.io 等）
   - 拖入 APK 自动识别"这个签名属于哪个圈子"

3. **加固识别器**：
   - 检测：360 加固、爱加密、腾讯乐固、阿里聚安全、Bangcle、NP 自家的 ApkVmProtect、ApkControlFlowConfusion
   - 对应 dump 工具的链接（如 FRIDA-DEXDump、frida-fart）

4. **Smali → 高阶 IR**：
   - 把 smali 翻译成更友好的伪代码（类似 IDA 的 hex-rays）
   - 用 Tree-sitter 写 smali grammar，配 AI 做语义还原

5. **MT/NP 兼容性**：
   - 直接导入 MT 的 `.mtsx` 语法文件（生态借力）
   - 直接读 NP 的 keystore（破解 `assets/a/s`）作为兼容选项
   - 接受 MT/NP 导出的"未完成工程"作为输入格式

---

## 4. 桌面版**不要抄**的坑

| # | 坑 | 原因 |
|---|---|---|
| 1 | NP 的 APK-VM (libnpvmp.so) 自保 | 桌面端不需要"在用户手机上躲调试"，抄了反而拖慢开发 |
| 2 | 符号混淆全量化（NP 1147 个随机名） | 桌面端是用户侧的工具，应该 **越透明越好**（开源最佳） |
| 3 | LSPlant + SandHook 双 hook 框架 | 这是 hook 安卓应用的功能，桌面端如果要 hook，直接 Frida 即可，原生 LSPlant 没意义 |
| 4 | MT 的"在私有目录里拆包"沙箱 | 桌面端有完整 FS，直接用临时目录 |
| 5 | umeng-spy 之类的第三方 SDK 反追踪 | 这是手机端隐私需求，桌面端用户不在乎 |
| 6 | 一键签名 = AOSP testkey 默认 | 默认值应该让用户**先生成自己的 keystore**，testkey 只作为可选项 |
| 7 | NP 的 `assets/a/s` 加密 JKS | 桌面用户期望 keystore 是明文文件 + 密码弹窗 |

---

## 5. 建议的桌面版模块拆分（实施层）

按"自下而上"的依赖顺序：

```
[L0] 基础层
├─ apk-core           ZIP 读写 + AXML 解析 + ARSC 解析（zip4j + axml-printer + arsc4j）
├─ dex-core           DEX 读写 + smali 汇编/反汇编（dexlib2 + baksmali/smali）
├─ sign-core          v1/v2/v3 签名（嵌入 apksigner.jar 源码） + keystore 管理
└─ native-core        ELF 解析（adriancable/jelf 或自实现）+ strings + objdump 封装

[L1] 工程层
├─ project            一个 APK 项目的元信息：原始 APK、拆出来的 manifest/smali/resources、修改历史
├─ diff-engine        manifest / smali / resources / native 多维 diff
├─ patcher            ApkSignatureKillerEx 注入引擎 + LSPatch 引擎（**EULA 后台开关**）
├─ fingerprint        签名指纹库 + 加固识别器 + 圈子追踪
└─ search             全工程 grep + 跨文件 ref 跳转（tree-sitter index）

[L2] 集成层
├─ jadx-bridge        内嵌 jadx 反编译 + 缓存
├─ frida-bridge       Frida 脚本编辑 / 部署 / 输出查看
├─ adb-bridge         ADB 设备列表 / 安装 / logcat / pull
├─ mitm-bridge        集成 mitmproxy 抓包（启动 APK 前自动配 CA）
└─ ai-bridge          LLM API（自带 prompt 模板：smali→java、找 vip 校验点、解释代码）

[L3] UI 层
├─ editor             Monaco/Tree-sitter，集成 jasm/smali grammar
├─ inspector          manifest / arsc / hex / dex 树形视图
├─ terminal           xterm.js + node-pty（或 JediTerm）
├─ packages-tree      APK 内文件树（含语法高亮预览）
├─ diff-viewer        分屏 diff + 三栏 merge
└─ plugin-host        插件运行时（Quickjs/GraalJS 沙箱）+ 插件市场

[L4] 插件生态层
└─ plugin-sdk         发布给第三方的 SDK + 文档 + 示例（**抄 MT bin.mt.plugin.api 的设计**）
```

---

## 6. 推荐技术栈

| 层 | 备选 | 推荐 |
|---|---|---|
| 桌面框架 | Electron / Tauri / Compose Desktop / JavaFX / Qt | **Compose Multiplatform Desktop**（Kotlin，能复用安卓生态库如 dexlib2） |
| 反编译 | jadx-core / Procyon / CFR / Fernflower | **jadx-core**（与 MT/NP 一致，反编译结果用户预期一致） |
| smali | smali/baksmali (jf) / dexlib2 | **dexlib2 直接读写**，smali/baksmali 仅做导入导出 |
| 签名 | apksigner / bouncycastle / 自研 | **嵌入 apksigner.jar**（NP 已经验证可行）+ 桌面端 keystore CRUD |
| 语法 | TextMate / Tree-sitter / Antlr / 自研 | **Tree-sitter**（增量 + 多语言 + grammar 写 java/smali/jasm） |
| Frida | frida-tools (Python) / frida-node | **frida-node**（Compose Desktop 也能通过 JNA 调） |
| AI | OpenAI / Anthropic / 本地 ollama | API 抽象层，本地优先 + 云端兜底 |

---

## 7. MVP 路线图（建议优先级）

**M0（先跑起来）**：
- L0 全套 + L1 project + 简单 editor + L2 jadx-bridge
- 用户能：拖入 APK → 看文件树 → 编辑 smali → 重打包 → 一键签名

**M1（差异化）**：
- diff-engine + fingerprint
- 让用户能：拖 N 个 APK → 看出"哪个是改的，改了啥"

**M2（专业化）**：
- frida-bridge + adb-bridge + mitm-bridge
- 动态分析能力

**M3（生态化）**：
- plugin-host + 兼容 MT 的 .mtsx 语法文件
- ai-bridge

---

## 8. 一句话战略

> **MT 把 PC 工具链整合到了手机；你要把这条整合链路搬回桌面，并叠加桌面独有的三件套（jadx-嵌入 / Frida-内建 / AI-加持），让用户从此不再需要在 jadx-gui / apktool / Android Studio / Frida CLI 之间来回切换。**

MT 的 **`bin.mt.plugin.api`** 插件系统、NP 的 **`np.dcc + libnpvmp`** APK-VM、以及两者共同的 **"一键签名校验绕过"** 是三个最值得吃透的子系统。除此之外的功能都是"工程问题"，不是"想法问题"。

