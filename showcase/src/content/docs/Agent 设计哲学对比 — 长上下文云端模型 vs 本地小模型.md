# Agent 设计哲学对比 — 长上下文云端模型 vs 本地小模型

> **背景**：rev-agent 在设计时反复跟 Cline / OpenCode / Roo Code / Cursor / Claude Code / Aider 等主流 agent 做对照。一句话总结：**这些主流 agent 都是为"上下文充足 + 推理快 + 工具调用准"的云端大模型设计的；rev-agent 是为"上下文紧 + 推理慢 + 工具调用易翻车"的本地小模型重写的。**
>
> **本文不是 benchmark 也不是营销稿。是把"为什么这套东西要重新写"讲清楚，并诚实标出 rev-agent 不擅长的事。**

---

## §0 TL;DR（一张图）

```
┌──────────────────────────────────────────────────────────────────────┐
│  云端大模型 Agent (Cline / OpenCode / Cursor / Claude Code / Aider)  │
│                                                                       │
│  设计假设：                                                            │
│    ✓ 上下文 200k+ 真实可用                                            │
│    ✓ 推理 50-200 tok/s 起步                                           │
│    ✓ Function Calling 准确率 95%+                                      │
│    ✓ Token 单价低 / API 钱包好用                                       │
│                                                                       │
│  结果：                                                                │
│    Agent loop 重型化、prompt 数千 token、信任模型自规划                │
└──────────────────────────────────────────────────────────────────────┘

                                  ┃ 同样的设计放到本地 27B-35B MoE 模型上
                                  ┃ 1. 上下文实际只有 ~80k 可用
                                  ┃ 2. 推理 45 tok/s，单轮要 30-60 秒
                                  ┃ 3. tool schema 经常 hallucinate 错参数
                                  ┃ 4. 长 prompt + agent loop 4-15x 放大消耗
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│  本地小模型 Agent (rev-agent)                                        │
│                                                                       │
│  设计反向：                                                            │
│    ✓ 协议层硬编 4 阶段渐进探索 + 7 铁律                                │
│    ✓ 工具 schema 编译期固化硬限（如 read_file ≤ 200 行）              │
│    ✓ Token 预算红线（70%/90% 触发主动 dump 到磁盘笔记）                │
│    ✓ 工具调用三档审批（auto/ask/deny），不信任模型自由发挥             │
│    ✓ "笔记机制" 作为 token 外置存储 + 跨会话续传                       │
└──────────────────────────────────────────────────────────────────────┘
```

---

## §1 设计哲学的根本差异

|  | Cline / OpenCode / Cursor / Claude Code | rev-agent |
|---|---|---|
| **目标模型** | Claude Opus/Sonnet, GPT-4o, Gemini 2.5 Pro | Gemma4-26B-A4B / Qwen3.6-35B-A3B / 任何本地 MoE |
| **核心假设** | 模型聪明且诚实，给目标，剩下交给模型 | 模型可能瞎写，**协议必须硬约束** |
| **上下文策略** | 滑动窗口压缩 + auto-condense，依赖模型自己消化 | **Token 预算红线** + 主动 dump 到磁盘 |
| **System prompt** | 数千 token，含大量工具描述 + 范例 + 任务模式 | **400-1100 token**（短/长两版），全是行为约束 |
| **Agent loop** | Plan-Act 双模式 / 复杂 task lifecycle / 自动重规划 | 单循环 `generateText → tool_call → 手动 dispatch`，无 Plan-Act 二元 |
| **工具硬度** | 工具描述写在 prompt 里，靠模型遵守 | **Zod schema 编译期固化**（read_file.lines.max(200) 写死），模型绕都绕不过 |
| **工具审批粒度** | 大多 auto-approve（除关键 write） | 三档：**auto / ask / deny**，编译期分类，read 自动 / write 必问 / 危险硬拒 |
| **State / 记忆** | App 内 checkpoint + history 截断 + condense 摘要 | **文件系统级笔记** `/tmp/work-notes.md`，模型主动 append |
| **跨会话续传** | 同会话内 history、跨会话基本作废 | 笔记机制 + `@/tmp/work-notes.md` 显式引用 |
| **代码规模** | Cline CLI ~70k 行 TS（apps/cli）+ 5 个内部 sdk 包 | **rev-agent 约 800 行**（核心 ~500，UI ~300） |
| **场景** | 通用 dev agent（写代码 / 改 bug / 读 spec） | **单一垂直域**（安卓 APK 逆向）+ 工具白名单 |
| **MCP 角色** | 主要作为 client 调用外部 MCP server | **既是 client 也是 server**（暴露 4 工具给 Claude Code 反向调） |

---

## §2 八个具体差异点逐项展开

### §2.1 协议层 vs Agent loop —— "把方法论硬编 vs 让模型自悟"

**Cline / OpenCode 路线**：

System prompt 主要告诉模型：
- 你有哪些工具（带 XML 风格描述 + 示例）
- 什么时候用 `attempt_completion`
- Plan 模式下不能改文件，Act 模式下每步审批
- 遇到错误怎么 self-correct

剩下的工作流程 **交给云端模型自己规划**——Claude/GPT 见多识广，会自己 figure out "先看 manifest 再读关键类"这种顺序。

**rev-agent 路线**：

System prompt **强制注入人脑沉淀的方法论**——`docs-resources/Mac 安卓逆向工具与工作流指南.md` §0 里的 "4 阶段渐进探索协议 + 7 铁律 + Token 预算表" 全文塞进 prompt：

```
铁律 1：永远先 count / grep / outline，再 read 全文
铁律 2：单次只 read 一个文件 ≤ 200 行
铁律 3：用 grep 找入口，用 jadx outline 看结构
铁律 4：任务 > 5 步立即写 /tmp/work-notes.md
铁律 5：每个 grep 加 | head -20
铁律 6：用 androguard / aapt2 / apkid 拿摘要，jadx 只用来精读单个类
铁律 7：不确定就停下问用户

4 阶段：摘要(<2k) → 地形(<5k) → 定位(<10k) → 精读(<20k)，永远不在阶段 3 之前进 jadx 源码
```

**为什么这样**：本地 35B MoE **没有 Claude 那种 "见多识广就自己规划"的能力**。你不告诉它 "先 grep 再 read"，它就会一上来 `cat 100 个 .java 文件`，5000 token 灌进上下文，剩下的会话直接报废。

**借鉴边界**：协议是项目特定的（安卓逆向场景）。如果你要做"用本地小模型写 React"，得换一套协议（"先看 package.json 再读 component"之类）。

---

### §2.2 Token 管理 —— "压缩 vs 红线 + 外置存储"

**Cline 路线**：

```
对话历史超过模型 ctx 上限 90% 时：
  1. 调用 LLM 自己总结前面 N 轮 → 压缩成 summary
  2. 把 summary 塞回 context 头
  3. 截断旧 messages
```

**问题**：
- 压缩本身要消耗 token（小模型 35B MoE 跑一次压缩慢且不准）
- 压缩后再压缩，信息损失累积
- 小模型在 80k 上下文下其实 30k 后就开始 "lost in the middle"

**rev-agent 路线**：

```
预算 80k token，分三段：
  ├─ 探索阶段（grep / outline / aapt2 dump） 占 ≤ 20k
  ├─ 精读阶段（jadx 单类 / smali 单方法） 占 ≤ 30k
  └─ 思考输出 占 ≤ 30k

70% 黄牌 → emit warn 事件，prompt 引导模型主动调 append_note
90% 红牌 → 强制提示 "立即 dump 笔记 + 重启会话"

笔记机制：
  /tmp/work-notes.md 是模型的"长期记忆"
  跨会话续传靠手动 @/tmp/work-notes.md 引用
```

**为什么这样**：
1. 让模型自己感知预算（在 prompt 里告诉它每个工具消耗多少 token），它会主动用 grep 而不是 read
2. 真要超 → "停下来重启" 比 "压缩历史" 信息保留更完整（笔记是 markdown 结构化的，比 LLM 自动 summary 准）

**实测 case**：Qwen3.6-35B 在 rev-agent 上找 MT 2.26.5 的 MCP 入口类，耗了 ~5000 token 完成；同样任务给 Cline + Claude Sonnet 4 会用 ~25000 token（多了 plan / re-plan / 摸索成本）。

---

### §2.3 工具硬度 —— "Prompt 描述 vs Schema 固化"

**Cline / OpenCode 路线**：

工具能力主要在 system prompt 里**描述**：

```xml
<read_file>
  Reads the contents of a file. Use this when you need to inspect code.
  Parameters:
    - path: the file path (required)
  Example: <read_file><path>src/foo.ts</path></read_file>
</read_file>
```

模型根据 prompt 决定 "我要 read 多少行"——通常模型会读全文。Cline 没有硬限制，read_file 默认读整文件。

**问题**：本地小模型可能要求 `read_file("src/big.java", lines=5000)`，结果 5000 行 Java 进上下文直接爆。

**rev-agent 路线**：

工具 schema **用 Zod 编译期固化硬限**：

```typescript
// src/tools/read-file.ts
export const readFileInputSchema = z.object({
  path: z.string(),
  start: z.number().int().min(1).default(1),
  lines: z.number().int().min(1).max(200).default(200),  // 硬限 ≤ 200
});
```

模型如果想 `lines=5000`：
1. Zod schema 校验失败 → 返回 `Too big: expected number to be <=200`
2. 这个错误被回喂给模型，模型必须改 `lines ≤ 200` 重试
3. **模型绕都绕不过**——schema 是它生成 args 之前由 ai SDK 强制的

shell 工具同理：白名单 + 黑名单是**正则编译期固化**：

```typescript
const ALLOW = /^(?:jadx|apktool|grep|adb|frida|...)\b/;
const DENY  = /\brm\s+-rf?\b|\bsudo\b|\bcurl\b|\bwget\b|\bssh\b/;
```

模型说 `rm -rf /` → runtime classify 返回 deny → 直接拒，连发都不发。

**为什么这样**：小模型 hallucinate 工具 args 的概率比 Claude 高 10x。**硬限是补丁，不是装饰**。

---

### §2.4 审批模型 —— "全量 ask vs 分级 auto/ask/deny"

**Cline 路线**：

默认所有工具调用都弹审批（用户在 IDE 里点 ✓ 或 ✗），除非用户开 `auto-approve all`。

**问题**：体验割裂——读个 manifest 也要点 ✓，10 个文件 = 10 次点击 → 用户烦了开 auto-approve → 然后 `rm -rf` 也自动放行了。

**rev-agent 路线**：

工具调用编译期就分类成三档，由 `Tool.classify(args)` 函数返回：

```typescript
shell:       classify(cmd) → 查询自动放行 / 写入弹审批 / 危险硬拒
read_file:   永远 auto       （读不会破坏什么）
grep:        永远 auto       （ripgrep 也是读）
append_note: 永远 ask        （唯一的 write 类工具，每次审批）
```

shell 工具内部再做二级分类（基于命令正则）：

```
auto: aapt2 dump badging / apkid / grep / ls / adb shell pm list / strings
ask:  cp / mv / mkdir / apktool b / apksigner sign / adb install / adb push
deny: rm -rf / sudo / curl / wget / ssh / scp / dd / mkfs / fork bomb
```

**收益**：日常 80% 操作是查询类 → 自动放行不打断思路；真到 write/install 才弹审批；危险命令永远不会跑。

---

### §2.5 Agent loop 形态 —— "Plan-Act vs 单循环"

**Cline / OpenCode 路线**：

```
Plan 模式: 只读探索，不改文件，输出"我打算这样做..."给用户审
       ↓ 用户批准
Act 模式: 逐步执行，每步审批，工具失败时 self-correct + re-plan
       ↓ 完成
attempt_completion: 显式声明 "我做完了"
```

这套设计假设 model 会**做完整 plan 再分步骤执行**，对 Claude Opus / Sonnet 4 适用，对小模型会卡在 plan 阶段反复 re-plan 不进入 act。

**rev-agent 路线**：

```
while (budget < max) {
  result = generateText({ model, system, messages, tools });
  if (no tool_calls) break;
  for (call of result.toolCalls) {
    approval = tools.classify(call.name, call.args);
    if (approval == 'deny') append tool result "denied"; continue;
    if (approval == 'ask') ok = await user_decide(call); if (!ok) ...;
    result = await tools.run(call.name, call.args);
    append to messages;
  }
}
```

**单循环，无 Plan-Act 二元**。协议本身就是 plan（"先 grep 再 read 再写笔记"已经写进 system prompt），模型不需要自己规划——它就**按协议一步步往前走**。

**为什么这样**：小模型自己写 plan 会跑偏；既然我们已经把 plan 沉淀到 prompt 里了，就让它直接 act。

---

### §2.6 State / 记忆 —— "App-level checkpoint vs 文件系统笔记"

**Cline 路线**：

State 在 VSCode extension 进程里：
- `ClineMessage[]` 当前 task 的对话历史
- `taskHistory[]` 跨 task 的 checkpoint
- `ApiConversationHistory` 跟 LLM 通信的完整 message 流

跨进程恢复：靠 VSCode extension storage（IndexedDB）。

**问题**：跨会话续传基本作废——开新 task 就是新 history，旧 task 的发现要靠用户记忆复制粘贴。

**rev-agent 路线**：

State 在两个地方：
1. **进程内 messages 数组**（当前 agent loop 用）
2. **`/tmp/work-notes.md` markdown 文件**（跨会话用）

笔记格式来自 `LLM工作笔记模板.md`（130 行模板），含：
- §0 任务元信息
- §1 APK 基础摘要
- §2 已完成步骤
- §3 关键发现（精确到类/方法/行号）
- §4 下一步（命令级，可直接执行）
- §5 上下文水位监控
- §6 避免重复 / 禁区
- §7 待问用户的问题
- §8 重启会话续传指引

跨会话续传：

```bash
# 旧会话结束前 LLM 主动 append_note 到 §4 "下一步"
# 新会话首轮 prompt：
cp LLM工作笔记模板.md /tmp/work-notes.md   # 模板已含 §8 续传指引
bun src/index.tsx --once "@/tmp/work-notes.md 继续完成第 N 步"
```

**为什么这样**：笔记是 markdown，**用户也能看得懂、改**。Cline 的 IndexedDB 用户改不了。

---

### §2.7 代码规模 —— "70k 行 monorepo vs 800 行单体"

| 项目 | 代码量 | 内部依赖 |
|---|---|---|
| **Cline CLI**（apps/cli） | ~70,602 行 TypeScript | + sdk/packages/{core,shared,llms,agents,sdk} 5 个包（再 ~100k 行）+ apps/cline-hub 业务 + 6 个 chat-adapter（slack/telegram/whatsapp/discord/gchat/linear，跟逆向无关） |
| **OpenCode** | ~50k 行 Go + TS | 跟 sst 团队的其他工具紧耦合 |
| **rev-agent** | ~800 行 TypeScript | 0 个内部包，14 个外部 npm 依赖（ai/zod/commander/opentui 等） |

**Cline 的代码量在哪里**：
- 完整 VSCode extension UI（webview / sidebar / chat history view）
- 6 个 chat adapter（让 Cline 也能通过 Slack/Telegram 触发）
- Kanban 集成
- Wizards（model selector, MCP wizard, schedule wizard, connect wizard）
- OAuth 流（cline-hub 账号体系）
- Telemetry / Crash report
- Auto-update 机制
- Skills marketplace 集成

**rev-agent 都没做**——因为目标场景就是"一个人在 macOS 上跑本地模型逆向 APK"，**所有商业产品逻辑都被剥离**。

**取舍**：rev-agent 没法做成给团队/公司用的成品，但作为个人工具就是 "fork → 改 → 跑" 三步搞定。

---

### §2.8 MCP 角色 —— "Client vs 双向"

**Cline 路线**：

Cline 是 **MCP client**，可以接入用户配置的外部 MCP server（GitHub MCP / Linear MCP / 自定义 MCP），让外部工具供给到 Cline 的工具栏。

**rev-agent 路线**：

rev-agent **既是 MCP client 也是 MCP server**：

- 作为 client：通过 Vercel AI SDK 跟 LLM 通信
- 作为 server (`--mcp-server` 模式)：把自家 4 工具暴露给 Claude Code / Cursor / Continue.dev 反向调用

```
┌─────────────────┐         stdio JSON-RPC          ┌─────────────────┐
│  Claude Code    │ ◄────────────────────────────►  │  rev-agent      │
│  (云端 Claude)  │                                  │  (本地工具集)    │
└─────────────────┘                                  └─────────────────┘
       │                                                      │
       │ 我想 read MT2.26.5/AndroidManifest.xml              │
       │                                                      ▼
       │                                              ┌──────────────┐
       │                                              │ shell/       │
       │                                              │ read_file/   │
       │                                              │ grep/        │
       │                                              │ append_note  │
       │                                              └──────────────┘
```

**实现"云端推理 + 本地工具执行" 混合架构**：
- Claude 强大的推理能力 + rev-agent 严格的协议约束 + 本地文件系统
- 敏感数据不出本地（APK 文件不上传），但 Claude 能驱动分析

`scripts/test-mcp.ts` 跑通了 5 个 roundtrip 验证：initialize 握手 / tools/list / tools/call 合法 / 黑名单拒 / write 类拒。

---

## §3 谁该用哪个 — 决策树

```
你的核心约束是什么？
│
├─ "我要跑本地模型，不想数据出局" + "我的硬件最多能跑 30B 模型"
│  └─ ✓ rev-agent
│        优势：协议硬约束让小模型稳定可控
│        代价：场景单一（垂直工具集），扩展性弱
│
├─ "我用 Claude/GPT 云端，想要 IDE 内最丝滑体验"
│  └─ ✓ Cline / OpenCode / Cursor / Claude Code
│        优势：UI 完善，生态成熟，多场景
│        代价：默认假设你有 $20-200/月预算
│
├─ "我用 Claude 云端但想要数据本地" + "可以用混合架构"
│  └─ ✓ Claude Code + rev-agent MCP server
│        在 ~/Library/Application Support/Claude/claude_desktop_config.json
│        加 rev-agent 作为 MCP server → Claude 调用本地 4 工具
│        敏感 APK 文件不出本地，但 Claude 强推理跑分析
│
├─ "我做安卓逆向，每月 100+ 个 APK，要工业化 pipeline"
│  └─ ⚠ rev-agent V0.3 工作流模板（规划中，未实现）
│      暂用：bash 脚本 wrap rev-agent --once + work-notes.md 续传
│
└─ "我做 React 开发 / 写后端 API / 普通 SWE 工作"
   └─ ✗ rev-agent 不适合
        协议是安卓逆向特化的，没有针对 SWE 的工作流模板
        用 Cline / Cursor / Claude Code 更合适
```

---

## §4 借鉴清单 — rev-agent 从 Cline / OpenCode 抄了什么

| 抄了什么 | 来源 | 我们的演绎 |
|---|---|---|
| **OpenTUI + commander 14 + zod + pino + @clack/prompts** | Cline `apps/cli/package.json` | 直接同栈，避免 Ink 生态 |
| **MCP server stdio transport** | MCP 官方规范 + Cline 是引领者 | 抄签名样式但 4 工具是自家的 |
| **白名单 shell + 危险命令拒** | Cline 也有（但默认更松） | 我们 deny 列表更严格 |
| **Plan-Act 思路** | Cline 创造的范式 | rev-agent 把 plan 沉淀到 prompt 不再 runtime 二元化 |
| **工具调用前的人类审批** | Cline 默认开启 | rev-agent 改成三档分类，read 自动放行减少打断 |
| **Tool registry + 编译期注册** | OpenCode 范式 | 同 |

**没抄的**：
- Cline 的 `attempt_completion` 显式收尾（rev-agent 用 finishReason）
- Cline 的 Plan-Act runtime 模式切换（rev-agent 单循环）
- Cline 的 context condensation（rev-agent 用笔记机制）
- Cline 的 MCP marketplace（rev-agent 只装 4 个自带工具）
- Cline 的 OAuth / 账号体系（rev-agent 纯本地）

---

## §5 rev-agent 不擅长 / 不打算做的事（诚实声明）

为避免误用 rev-agent，明确以下场景**不要用**：

| 场景 | 为什么不适合 |
|---|---|
| 通用 SWE 编码（写 React / Express） | 协议是安卓逆向特化的，没有 SWE 工作流模板 |
| 长上下文复杂 refactor | 80k 预算不够；用 Claude Code 200k 更适合 |
| 多文件协同改动 | 没有 file diff / merge / patch 工具 |
| 团队协作 / 跨人共享 task | 没有持久化 backend，笔记在 /tmp 一重启就丢 |
| Web UI / IDE 集成 | 只有 CLI / TUI / MCP server 三种入口 |
| 给非技术用户用 | 协议复杂度高，需要懂逆向才能读懂笔记 |
| 大批量自动化（>50 APK/天） | 当前没有任务队列 / 断点续传 / 并行调度 |

---

## §6 结论 — 设计哲学的根本分歧

主流 agent（Cline / OpenCode / Cursor / Claude Code）**信任模型 + 信任云端 + 信任预算**。

rev-agent **不信任模型 + 必须本地 + 死抠预算**。

| 维度 | 主流 agent | rev-agent |
|---|---|---|
| 看待模型的态度 | "Claude/GPT 很聪明，把目标给它，剩下交给它" | "本地 35B MoE 会瞎写，协议必须硬约束" |
| 看待数据的态度 | "数据发云端 OK，反正 Anthropic 不保留" | "敏感 APK 绝对不出局域网" |
| 看待 token 的态度 | "Claude Sonnet 一次 100k token 也就 $0.3" | "本地慢推理 + 上下文小，每个 token 都金贵" |
| 看待工具的态度 | "模型自己看 prompt 描述决定怎么用" | "schema 编译期固化，模型绕都绕不过" |
| 看待用户的态度 | "用户买我们的 Pro 订阅" | "用户是自己（开源 + 私自使用）" |

**这两种哲学没有谁对谁错**——只是适配的硬件/模型/场景不同。

如果你用的是 **Claude Sonnet 4 + 24GB Mac + 公有 SaaS 项目**，Cline / Claude Code 是最优解。

如果你用的是 **Qwen3.6-35B MoE 跑在局域网 AMD ROCm 上 + 合规敏感 APK 分析**，rev-agent 是被迫的最优解。

---

## §7 进一步阅读

本仓库内：
- `Mac 安卓逆向工具与工作流指南.md` — 4 阶段渐进探索协议全文
- `LLM首轮注入prompt.md` — 5 种 prompt 模板（§1 短版 / §2 长版 / §3 续传 / §4 极简 / §5 调试）
- `LLM工作笔记模板.md` — `/tmp/work-notes.md` 模板源
- `MT 2.26.5 MCP 实现深度解析与 LSPatch v6 补漏分析.md` — MCP server 设计参考

外部：
- [Cline GitHub](https://github.com/cline/cline)
- [OpenCode (sst)](https://github.com/sst/opencode)
- [OpenTUI](https://github.com/sst/opentui) — Cline / rev-agent 共用的 TUI 框架
- [Model Context Protocol 官方](https://modelcontextprotocol.io)
- [Vercel AI SDK](https://sdk.vercel.ai) — rev-agent 用，Cline 没用

---

<div align="center">

📝 **本文档反映 2026-06 时点的 rev-agent / Cline / OpenCode 状态。后续如有重大架构变更会更新版本号。**

</div>
