# MT 管理器 2.26.5 MCP 实现深度解析 + LSPatch v6 攻击补漏分析

> **审计方**：原开发者方聘请的 Malware 审核员
> **日期**：2026-06-03
> **作用范围**：
> 1. 解构 MT 2.26.5 全新内置的 **MCP (Model Context Protocol) Server**
> 2. 修正前一份《MT 2.26.4 与 2.26.5 是否修复 LSPatch v6 攻击的对照分析》在"付费插件"维度上的疏漏
> **核对样本**：
> - `MT2.26.5.apk` (versionCode 26052685, CN=bin 官方签名)
> - `MT_mtglq_174198.apk` (= MT 2.26.4, 26040391)
> - `MT管理器_2.14.5-clone-MOD-v6-xml-fix-final.apk` (versionCode 24011895, AOSP testkey 重签)

---

# Part 1 — MT 2.26.5 MCP Server 实现深度解析

## 0. 一句话先行

> MT 2.26.5 首次内置了一个**完整的 MCP Server**（前两版 2.14.5 / 2.26.4 都没有），用 NanoHTTPD 在本机 **`http://127.0.0.1:8787/mcp`** 监听 POST，暴露 **8 个 `mt_apk_*` read-only 工具** 给 AI Agent（Claude Desktop / Cursor / 任何 MCP 客户端）使用，让 AI 可以直接通过协议调用 MT 来逆向分析 APK。预留了 `mt_apk_modify` / `mt_apk_write` 两个写入工具的占位（当前 `available: false`）。**当前版本无任何 Bearer / Token / API Key 鉴权**，仅靠 Origin 白名单防 DNS rebinding。

## 1. 功能总览

| 维度 | 值 |
|---|---|
| MCP 协议版本 | **`2025-06-18`**（MCP 规范 2025 年 6 月 18 日版） |
| Server name / version | `MT APK MCP` / `0.1.0`（明显是首发版本） |
| 传输层 | **HTTP JSON-RPC**（不是 stdio，不是 SSE） |
| 端点 | `http://127.0.0.1:8787/mcp` + `http://<LAN-IP>:8787/mcp` |
| 默认端口 | **8787**（SharedPreferences key: `apk_mcp_port`，用户可改） |
| 默认 session 限制 | **10**（1~100 可配，key: `apk_mcp_session_limit`） |
| 默认操作目录 | `mcp/` 子目录（key: `apk_mcp_operation_path`） |
| 运行载体 | **前台 Service** (`ServiceC7545`)，常驻通知 ID 1008，channel "APK MCP" |
| HTTP 框架 | **NanoHTTPD** 改名版（线程名 "NanoHttpd Main Listener" 是标志） |
| 鉴权 | **无** Bearer/Token/API key |
| Origin 校验 | 白名单 = `127.0.0.1` / `localhost` / 本机所有 IPv4 网卡 IP，仅 `http://`，必须同端口；**空 Origin 直接放行** |
| 批处理 | 不支持（返回 `-32600 Batch requests are not supported`） |
| HTTP method | 仅 POST，GET 返回 405 |

## 2. 类结构图

```
ServiceC7545                              ← Android 前台 Service，启动/停止入口
   │ onStartCommand()
   ▼
new C19184(port = 8787)                   ← MCP Server 主类，注册 8 个 tools
   │ extends C7671                        ← MCP HTTP handler（Origin/Accept/Method 检查）
   │   │ extends AbstractC3962            ← NanoHTTPD 改名版（ServerSocket + 线程模型）
   │   │
   │   ├─ new C8897(toolList, capabilities)   ← ToolRegistry（去重 + tools/list 序列化）
   │   ├─ new C11960(serverInfo, registry)    ← JSON-RPC 路由器（initialize/ping/tools/list/tools/call）
   │   └─ new C13672(port)                    ← Origin 白名单校验器
   │
   └─ ToolRegistry 内含 8 个 AbstractC10122 子类（=8 个对外工具）
        + 2 个预留占位（capabilities 中 available=false）
```

## 3. 八个 MCP 工具清单

所有工具来自 jadx 反编译的 `l/AbstractC10122` 8 个子类（每个 = 一个 MCP tool）：

| Tool name | Title | 一句话说明 | readOnly |
|---|---|---|---|
| `mt_apk_open` | Open APK | **必先调用**。打开 APK 工作区，返回 workspaceId + 包名 + 版本 + 各类计数 + capabilities + nextActions | ✅ |
| `mt_apk_list` | List APK Structures | 分页列 ZIP 条目 / dex 类 / resource_table 条目 | ✅ |
| `mt_apk_search` | Search APK | 全局搜索（dex 名 / dex 字符串 / 资源等，支持 literal/regex/case-sensitive） | ✅ |
| `mt_apk_read_text` | Read APK Text | 读 zip_entry 文本、解码后的 axml、dex_class smali、dex_method smali、dex_field smali | ✅ |
| `mt_apk_read_zip_bytes` | Read APK ZIP Bytes | 读 ZIP 二进制字节（返回大写 hex），用在 `mt_apk_read_text` 返回 `NOT_TEXT_ENTRY` 之后 | ✅ |
| `mt_apk_read_resource_values` | Read APK Resource Values | 读单个 resource_table_entry / hit.valueOffset | ✅ |
| `mt_apk_outline_class` | Outline APK Dex Class | 读一个 dex 类的 outline（按 className=`Lcom/example/Foo;` 或 `com.example.Foo`） | ✅ |
| `mt_apk_continue` | Continue APK Cursor | 通用分页 cursor 继续接口 | ✅ |
| ~~`mt_apk_modify`~~ | — | **预留占位** (`available:false, readOnly:false`)，未来开放修改 APK 能力 | ❌ |
| ~~`mt_apk_write`~~ | — | **预留占位** (`available:false, readOnly:false`)，未来开放写入新文件能力 | ❌ |

## 4. 几个值得抄的设计亮点

### 4.1 `nextActions` —— 服务器主动告诉 AI 下一步该调用什么

每个 tool 的返回 JSON 里都带一个 `nextActions` 数组，每项是一个**可直接复制粘贴的 tool call**：

```json
"nextActions": [
  {"name": "mt_apk_list",       "intent": "inspect", 
   "description": "List APK ZIP entries", 
   "arguments": {"workspaceId": "...", "view": "zip_entries", "prefix": "", "limit": 200}},
  {"name": "mt_apk_read_text",  "intent": "inspect",
   "description": "Read decoded AndroidManifest.xml",
   "arguments": {"workspaceId":"...","locator":{"kind":"axml","path":"AndroidManifest.xml"}, ...}}
]
```

这是 MCP 规范本身**没有强制**的设计——MT 自己加的。**强烈推荐桌面端 toolbox 抄**：AI 不需要从 `tools/list` 反复查参数 schema，跟着 `nextActions` 一路点下去就能完成分析。

### 4.2 URI 协议族 + 严格的路径校验

MT 自定义了 3 种 URI 协议给 `mt_apk_open` 的 `path`：

| URI | 含义 |
|---|---|
| `mt://current-apk` | 当前在 MT UI 里打开的 APK |
| `mt://workspace/<workspaceId>` | 重新打开已存在的 workspace |
| `<relative path>` | 相对于 `apk_mcp_operation_path` 的相对路径 |

**明确拒绝**：绝对路径、其他 URI scheme、反斜杠、`.` 段、`..` 段、空段——**反路径穿越做得很到位**。

### 4.3 双层错误模型

每个 tool 错误返回的 JSON 标准化为 6 个字段（来自 `AbstractC10122.mo4919`）：

```json
{
  "errorCode": "...",          // 标准化错误码
  "message": "...",            
  "recoverable": true|false,   // AI 是否可以重试
  "retrySameArguments": false, // 是否能用同参数重试
  "errorSeverity": "...",      // 严重度分级
  "nextActions": [...]         // 错误恢复用的下一步建议（!!）
}
```

错误里也带 `nextActions`，让 AI 知道"如果失败了应该改成调用哪个工具"——这种**面向 Agent 的反馈循环**是当前主流 MCP 工具普遍缺失的设计。

### 4.4 `outputSchema` 完整声明

`mt_apk_open` 的 `outputSchema` 完整声明了 12 个字段类型 + 嵌套 capabilities 对象 + `nextActions` 数组结构。AI 客户端可以提前**类型校验 + UI 模板渲染**。这是 MCP 规范 2025-06-18 的新特性，MT 全套用上了，比同期很多 MCP server 更规范。

## 5. 鉴权脆弱面（必须正视）

`C7671.mo10786()` 的完整请求校验流程：

```
1. URL path == "/mcp"             否则 404
2. Method == POST                  否则 405
3. Accept header 含 json           否则 406
4. Origin 白名单 (C13672):
     - http:// (不允许 https)
     - 同端口
     - host ∈ { 127.0.0.1, localhost, 本机网卡 IP }
     - **Origin 为空 → 直接放行!**       ← 🚨 关键弱点
5. mcp-protocol-version == "2025-06-18"  (非 initialize 请求才检查)
6. JSON-RPC body 不能是 batch array
7. 路由到 initialize / ping / tools/list / tools/call
```

### 5.1 三个真实可利用风险

**风险 1：空 Origin 旁路**

```bash
# 任何同 WiFi 设备：
curl -X POST http://<手机 LAN IP>:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",...}'
# Origin 缺失 → 默认放行 → 接管 MCP 会话
```

C13672 在 `C7671` 中调用前的判断（line 76-77）：

```java
if (str4 == null || str4.isEmpty()) {
    zM30957 = true;     // ← Origin 为空 = 通过
}
```

虽然浏览器**永远不会发送空 Origin** 的 POST，但 **curl/Python/Postman/任意原生 HTTP 客户端** 都可以。也就是说：**只要在同 LAN，没浏览器的攻击者完全可以连上**。

**风险 2：LAN 内任意设备**

Origin 白名单接受了所有"本机 IP"，但 MT 本身的 ServerSocket 默认 bind 到 `0.0.0.0`（NanoHTTPD 默认行为），意味着 **同一 WiFi 下任意设备都能连**。咖啡厅、公司 WiFi、酒店开放 WiFi 下，旁人扫一下 8787 端口就能 enumerate 你打开过的 APK。

**风险 3：信息泄漏**

8 个 tools 全是 read-only，但泄漏面比想象的大：
- `mt_apk_open` 返回 packageName / versionName / minSdk / 全部 zip 条目计数
- `mt_apk_list` 列出所有 dex 类名（可推断 app 内部架构）
- `mt_apk_read_text` 直接吐 smali 全文
- `mt_apk_search` 全文检索 + 字符串提取
- 攻击者无需任何账户就能远程把你手机上**任何被 MT 打开过的 APK** 全部 dump 走

### 5.2 推荐 MT 团队加固（按 ROI）

| # | 措施 | 工作量 | 收益 |
|---|---|---|---|
| 1 | **`bind 127.0.0.1` 不绑 0.0.0.0**，要 LAN 用通过额外的 "Allow LAN" 配置项 + 第一次连接强制 6 位 PIN 配对 | 30 行代码 | 直接消除 LAN 内陌生设备风险 |
| 2 | **去掉"空 Origin 放行"分支** —— 强制每个请求带 Origin（除了 `initialize` 那次握手） | 5 行代码 | 阻止 curl 类客户端绕过 |
| 3 | **加 Bearer Token** —— `initialize` 时让用户在 MT UI 上看到/复制 token，后续每次请求必须带 `Authorization: Bearer <random64>` | 50 行代码 | 完整鉴权 |
| 4 | **会话 IP 锁定** —— `initialize` 返回的 sessionId 跟首次握手的 source IP 绑定，换 IP 即失效 | 20 行代码 | 防 sessionId 被中间人偷走 |
| 5 | **`tools/call` 操作日志 + UI 实时显示** —— 让用户能看到"谁正在用 MCP 看我手机上的什么 APK" | 100 行代码 | 行为可见性 |
| 6 | 等正式开放 `mt_apk_modify` / `mt_apk_write` 时，**每次写操作弹窗确认** | 50 行代码 | 防写入滥用 |

## 6. 启动流程（用户视角）

```
Settings → MCP → 配置端口/sessionLimit/operationPath
                ↓
            点"启动"
                ↓
    sendBroadcast → ServiceC7545.onStartCommand()
                ↓
    startForeground(1008, notification)         ← 常驻通知 "APK MCP"
                ↓
    new C19184(port)                            ← 注册 8 tools
                ↓
    c19184.m10784()                             ← bind ServerSocket，启动 NanoHttpd Main Listener 线程
                ↓
    sendBroadcast("bin.mt.mcp.apk.ACTION_STARTED")
                ↓
    通知上显示 URL：http://127.0.0.1:8787/mcp + http://<LAN IP>:8787/mcp
```

通知右侧有"停止"按钮，发 `bin.mt.mcp.apk.ACTION_STOP` Intent → `stopSelf()`。

---

# Part 2 — LSPatch v6 攻击补漏分析（修正前文）

## 7. 前文未充分讨论的盲点 — 付费插件清单时效性

前一份《对照分析》的结论 "**两个版本都没修复，相同路径可继续破解**" 在**协议层 / 重签层 / native 层** 100% 成立——这部分无需修正。

**但**在"**破解版的实际用户体验**"维度上，有两个事实需要补充：

### 7.1 v6 的 res.zip 是 2024-07-15 的快照

```
unzip -l res.zip | grep plugin.mtp
# 所有 27 个 .mtp 文件 mtime 均为 07-15-2024 21:03
# 目录创建时间 07-18-2024 03:09
# 索引文件 files/plugins mtime = 08-21-2024 18:03
```

也就是说：攻击者那台 VIP 设备的 dump 时间窗口是 **2024-07-15 ~ 2024-08-21**。今天距今约 **22 个月**。

### 7.2 v6 携带的 27 个插件清单

```
bin.plugin.translator.baidu          bin.plugin.translator.baiduapi
bin.plugin.translator.bing           bin.plugin.translator.fanjian
bin.plugin.translator.google         bin.plugin.translator.google_cn
bin.plugin.translator.yandex         bin.plugin.translator.youdao
com.frankwhite.translate_Mosquito    com.hand.mtplugin
com.losfer.terjimans                 com.vlrs.plugin.deepl_transl
com.whitesev.plugin.whitesev         com.wyxhy.smali_convert
Han.mt_plugin.strip_whitespace       Han.mt_plugin.text_sort
io.tooldroid.plugin.stringencoder    jiaxin149.mt.plugin
jiaxin149.mt.plugin_java_code        mb.plugin.translator.google.api
mt.base_converter                    mt.chatGPT.ai
mt.english.dictionary                mt.number_converter
mt.oxford_english.dictionary         tw.david082321
vlrs.plugin.translator.microsoft
```

> 上次报告写"28 个"是清点失误，实际是 **27 个**（`files/javac/` 还有 boot+ext 两个 jar 不算插件）。

### 7.3 缺什么？

**全部缺**——所有 2024-08-21 之后 MT 官方插件市场新上的付费插件 v6 都没有。具体包括但不限于：

| 缺失类型 | 推断（基于 MT 官方更新日志和插件生态规律） |
|---|---|
| AI 系插件 | **`mt.chatGPT.ai` 是 2024-07 的老版本**——2024-09 起 MT 官方推出/收录了 Claude、Gemini、本地 Ollama 等多个 AI 插件，全部不在 v6 |
| 翻译类增量 | 2024-08 后的多家翻译 API 新增（如 DeepL Pro 改版、有道 v2 API）插件 |
| Smali/dex 工具增量 | 1 年多里 MT 圈插件作者持续发布新工具，v6 全空 |
| 平台官方插件升级 | `mt.english.dictionary` 等若有大版本升级（2.0+），v6 仍是 1.x |
| **MCP 相关插件** | **2.26.5 新引入 MCP 后，必然会出 MCP 配套插件**（如自定义 tool plugin / Claude prompt 模板插件），v6 完全不知道 MCP 的存在 |

### 7.4 这对"攻击有效性"意味着什么？

**对 MT 官方而言**：好消息——v6 用户拿到的 VIP 资产**只是 2024-07 的快照**，不是"永久 VIP"。**MT 持续发布新插件本身就是一种"自然防御"**：v6 用户用得越久，"VIP 含金量"越淡。

**对攻击者而言**：要保持破解版的"卖点"，必须周期性地：

```
[1] 从一台已购 VIP 的 2.26.5 设备重新 dump /Android/data/bin.mt.plus.canary/files/
[2] 重新打包 res.zip
[3] 重新发 v7 / v8 / ...
```

——这就是为什么破解圈的 mod 总是**几个月发一版**，不是一锤子买卖。

**对修复优先级而言**：上一份报告中 P2 的两条措施需要**提到 P1**：

| 措施（重排优先级） | 理由 |
|---|---|
| **VIP 插件激活校验上云**（设备指纹 + 当前 APK 签名上报）| 让"dump 一台设备就能制作破解版"的成本变成"每个用户独立激活"，从根本上断攻击者的复制链 |
| **付费插件按设备绑定 + TTL 短期 token** | 让 res.zip 即使被 dump，搬到别的设备/超过 TTL 后立即失效 |

### 7.5 顺便一个被忽视的攻击面：MCP

**LSPatch 攻击 2.26.5 时，会把 MCP Service 一并继承**——这意味着：

- 破解版会照常启动 MCP 服务（端口 8787）
- 任何同 WiFi 下的设备都能连上**这个破解版 MT** 的 MCP，远程触发 `mt_apk_open` / `mt_apk_read_text` 等读取**目标设备上的任意 APK 内容**

LSPatch 没有"禁用 MCP"的功能，攻击者也不会主动关闭（关了用户体验降级）。结果是：**破解版用户多了一个隐私泄漏面**——MT 官方版的 MCP 至少有用户主动启动的步骤，破解版可能被人静默植入"开机即启动 MCP"的 mod，用户完全无感。

## 8. 综合结论

| 攻击面 | MT 2.26.4 | MT 2.26.5 | 是否修复 |
|---|---|---|---|
| LSPatch v6 嵌入式注入 | ❌ 可破 | ❌ 可破 | **未修复** |
| AOSP testkey 重签 | ❌ 可破 | ❌ 可破 | **未修复**（assets/testkey 仍在） |
| res.zip 整包植入 VIP 插件 | ❌ 可破 | ❌ 可破，但 **22 个月新插件全缺**，攻击者要重新 dump 才能保持新鲜 | **未修复**（但有时效衰减） |
| MCP Server 鉴权 | N/A (无 MCP) | ⚠️ Bearer 缺失 + 空 Origin 放行 + 默认 bind 0.0.0.0 | **2.26.5 的新风险面** |
| MCP 在破解版中被滥用 | N/A | ⚠️ 破解版会继承 MCP，攻击者可静默配置开机启动 | **新风险面** |

## 9. 修复建议二合一（合并 LSPatch + MCP 两条线）

按 ROI 重排优先级：

### P0（本周可完成）
1. **`assets/testkey.pk8/.x509.pem` 换成 MT 自家一次性调试密钥**
2. **`libmtprotect.so` 的 `JNI_OnLoad` 硬编码 AOSP testkey SHA256 黑名单**
3. **MCP Server 默认 bind `127.0.0.1`，不绑 0.0.0.0**
4. **MCP 去掉"空 Origin 放行"分支**

### P1（2-4 周）
5. **`JNI_OnLoad` 加 LSPatch 五件套自留特征探测**（`L00.PKG` / `copy_config.json` / `libloader.so` / `loader_log.txt` / `appComponentFactory` 非预期值）
6. **MCP 接 Bearer Token + 第一次连接 6 位 PIN 配对**
7. **MCP `tools/call` 操作日志 + UI 实时显示调用者 IP / 工具名 / 参数摘要**

### P2（1-3 月）
8. **VIP 插件激活校验上云**（设备指纹 + 当前 APK 签名上报，TTL 24 小时短期 token）
9. **签名校验整体下沉到 libmtprotect 的 OLLVM 混淆函数**
10. **借鉴 NP `libnpvmp.so` 把 VIP 校验编译成自家 VM 字节码**
11. 等开放 `mt_apk_modify` / `mt_apk_write` 时，**每次写操作 UI 弹窗确认 + 操作内容预览 diff**

---

## 附录 A — MCP 核心类速查

| 类 (jadx 重命名后) | 对应的混淆名 | 用途 |
|---|---|---|
| `ServiceC7545` | `l.ۡۛ֡` | 前台 Service，启动入口 |
| `C19184` | `l.᩹ۛ֡` | MCP Server 主类，注册 8 tools |
| `C7671` | `l.ۡۧ֡` | MCP HTTP handler，做请求校验 |
| `AbstractC3962` | `l.ۙۢۚ` | NanoHTTPD 改名版（HTTP server 基类） |
| `C11960` | `l.ܰۧ֡` | JSON-RPC 路由（initialize/ping/tools/list/tools/call） |
| `C8897` | `l.ۤۧ֡` | ToolRegistry |
| `C13672` | `l.ܺۛ֡` | Origin 白名单校验器 |
| `AbstractC10122` | `l.ۨۧ֡` | MCP Tool 基类（name/title/description/inputSchema/outputSchema/annotations/execute/error） |
| `C16122` | `l.ᩴۛ֡` | tool: `mt_apk_open` |
| `C12572` | — | tool: `mt_apk_list` |
| `C12662` | — | tool: `mt_apk_search` |
| `C3869` | — | tool: `mt_apk_read_text` |
| `C1637` | — | tool: `mt_apk_read_zip_bytes` |
| `C11221` | — | tool: `mt_apk_read_resource_values` |
| `C2645` | — | tool: `mt_apk_outline_class` |
| `C15636` | — | tool: `mt_apk_continue` |
| `C17959` | `l.᩷ۛ֡` | MCP 设置存储（端口/sessionLimit/operationPath） |
| `ActivityC16169` | — | MCP 设置/管理页 UI |
| `C2771` | `l.ۗۧ֡` | URL builder + 本机 IP 枚举 |

## 附录 B — 直接复制可测试的 MCP 客户端配置

如果你想在自己手机上跑 MT 2.26.5 然后从 Claude Desktop / Cursor 连接：

**Claude Desktop（claude_desktop_config.json）**：

```json
{
  "mcpServers": {
    "mt-apk": {
      "url": "http://192.168.1.<手机 IP>:8787/mcp",
      "transport": "http"
    }
  }
}
```

**curl 验证**：

```bash
curl -X POST http://127.0.0.1:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"initialize",
    "params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"test","version":"0.0.1"},"capabilities":{}}
  }'
```

(在 root 同 WiFi 设备上还可以用 `http://<手机 LAN IP>:8787/mcp`——这恰好是上述 5.1 节描述的"风险面"演示)

