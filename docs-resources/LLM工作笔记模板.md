# LLM 工作笔记模板

> **使用方法**：
> 1. 任务开始时：`cp "LLM工作笔记模板.md" /tmp/work-notes.md`
> 2. 任务执行中：每完成一个阶段就 update（**不要重写**，只追加 / 改状态）
> 3. 上下文超过 70% 水位线时：写完笔记 → 让用户重启会话 → 新会话首轮读 `/tmp/work-notes.md` 接着干
> 4. 任务结束：把 `/tmp/work-notes.md` 归档到项目目录留底

---

## 0. 任务元信息

| 字段 | 值 |
|---|---|
| 用户原始诉求 | （一句话照抄用户的话，永远不要扩写） |
| 任务开始时间 | （年-月-日 时：分） |
| 目标 APK 路径 | `/path/to/target.apk` |
| 工作目录 | `/tmp/rev-XXX/` |
| 当前轮次 | 第 N 次会话（重启后 +1） |

## 1. APK 基础摘要（§3.A 阶段 1 输出）

| 字段 | 值 | 来源命令 |
|---|---|---|
| 包名 | com.target.app | `aapt2 dump badging` |
| versionName | 1.2.3 | `aapt2 dump badging` |
| versionCode | 12030 | `aapt2 dump badging` |
| minSdk / targetSdk | 24 / 34 | `aapt2 dump badging` |
| 签名指纹 (SHA256 前 16) | `aabb...` | `apksigner verify --print-certs` |
| 加固 / 打包工具 | （360 / Bangcle / 无 / VMP / ...） | `apkid` |
| dex 数量 | 4 | `unzip -l \| grep dex` |
| native lib 数量 | 5 个 .so | `unzip -l \| grep .so$` |
| 权限数 | 18 个（重点权限：READ_SMS / ACCESS_FINE_LOCATION / ...） | `grep uses-permission` |
| 是否已 jadx 反编 | ❌ / ✅ → `out-jadx/` | — |

## 2. 已完成步骤（按时间顺序追加，不删除）

- [x] `aapt2 dump badging` 完成 → 摘要见 §1
- [x] `apkid` 完成 → 加固类型： XXX
- [x] `apktool d --no-src` 完成 → 输出 `out-apkt/`
- [x] grep "VipChecker" 命中 5 个文件 → 见 §3
- [ ] 读 `out-jadx/sources/com/target/utils/Sign.java`
- [ ] frida hook Sign.gen() 验证算法
- [ ] Python 复刻签名

## 3. 关键发现（精确到类/方法/行号）

> 每条要有"事实 + 来源"。**禁止写主观判断**（"我觉得这是 ..."），只写**已验证的事实**。

| # | 发现 | 类型 | 来源 | 已验证 |
|---|---|---|---|---|
| 1 | 签名生成入口在 `com.target.utils.SignUtil.gen(String)` | 类/方法 | grep "x-sign" 命中 HttpInterceptor.java:42 | ✅ |
| 2 | `SignUtil.gen` 调到 native `libSign.so:Java_..._gen` | JNI | jadx 看到 native 声明 | ⚠️ 待 frida 验证 |
| 3 | libSign.so 中 KEY 常量在偏移 `0x12340`，16 bytes | 字节常量 | Ghidra 反编译看到 | ❌ 未验证 |

## 4. 下一步（必须可执行 = 命令级）

> **禁止写**"分析签名算法" → 这不可执行。
> **必须写**：`frida -U -l /tmp/hook.js -f com.target.app` + 在 `/tmp/hook.js` 写哪些 hook。

```
N1: 写 /tmp/hook.js（hook Sign.gen + Java_..._gen），见 §3 模板 D
N2: 跑 frida，触发 app 登录流程
N3: 拿 5 组（input, output）对 → 验证算法
N4: 如果是 HMAC，用 Python 复刻
```

## 5. 上下文水位监控

| 字段 | 值 |
|---|---|
| 累计读入 token 估算 | ~30k / 80k 可用 |
| 已读文件 (绝不重复读) | `out-apkt/AndroidManifest.xml`, `out-jadx/sources/com/target/api/HttpInterceptor.java` |
| 计划接下来 read | `out-jadx/sources/com/target/utils/SignUtil.java`（估 1500 token） |
| 红线 | 超过 60k 立刻 dump 笔记 → 让用户重启会话 |

## 6. 避免重复 / 禁区

> 上一轮试过失败的命令、不要重复触发的探索路径。

- ❌ `find out-jadx -name '*.java'`（输出 30k 行，已爆过）
- ❌ `grep -rln '' out-jadx`（无关键词的全文 grep）
- ❌ 反复 read 同一个 200+ 行的 Util 类（已读完，结论见 §3）
- ❌ `frida-trace -j '*!*'`（trace 所有方法，日志爆炸）

## 7. 待问用户的问题（不要瞎猜，攒一起问）

- [ ] 目标接口是哪个？（用户原始说"登录接口"还是"支付接口"？）
- [ ] 是否允许重打包 APK？（涉及 §3.G 灰区流程）
- [ ] 手机是否已 root？（决定走 §3.B 哪条 CA 安装路径）
- [ ] 是否有合法授权（自有 APP / 渗透授权书）？

## 8. 重启会话续传指引（给下一轮的自己）

> 上下文重启后，新一轮 LLM 看到这里要做什么。

**新会话首轮 prompt 必读**：

```
@/tmp/work-notes.md
继续完成第 N 步：<具体一句话>。
按 SKILL.md 的渐进探索协议执行，每步追加笔记到本文件。
当前预算：阶段 3-4，剩余约 50k token。
```

**新会话 LLM 应做的事**：
1. 读完 §0-§7
2. 跳到 §4 "下一步"，按 N1 N2 ... 顺序执行
3. **不要**重新 §3.A 摘要，§1 已经有
4. **不要**重新跑 §6 禁区里列出的命令
5. 完成一步就把 §2 的对应 checkbox 改成 [x]
6. 新发现追加到 §3
7. 上下文又满了？再循环到 §8

---

## 附 A — 笔记长度自检（每次结束前）

- [ ] §3 发现是否每条都有"来源"和"已验证"？
- [ ] §4 下一步是否每条都是可执行命令？
- [ ] §5 已读文件清单是否最新？
- [ ] §6 是否更新了本轮新发现的禁区？
- [ ] 笔记本身是否超过 100 行？（超了说明笔记太啰嗦，精简）
