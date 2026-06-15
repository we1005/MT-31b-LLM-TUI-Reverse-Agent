# rev-agent

本地 LLM agent CLI，专为安卓 APK 逆向场景设计。

强制把"4 阶段渐进探索协议 + 7 铁律 + token 预算"作为 system prompt 注入，让本地小模型（gemma4-26B / qwen3.6-35B-MoE 等）在 128k 上下文限制下做可控的逆向分析。

参考栈对齐 [Cline CLI](https://github.com/cline/cline/tree/main/apps/cli)（OpenTUI + Vercel AI SDK），但**agent loop 自己写**避免 Cline monorepo 的复杂依赖。

## 装好的依赖

- 运行时：`bun >= 1.2`
- LLM 抽象：`ai@6.0.196` + `@ai-sdk/openai@3.0.67` + `@ai-sdk/anthropic@3.0.81`
- Schema：`zod@4.4.3`
- CLI：`commander@14.0.3`
- TUI（待 task #21 接）：`@opentui/core@0.1.102` + `@opentui/react@0.1.102`
- MCP：`@modelcontextprotocol/sdk@1.29.0`

## 配置

默认走本地 LAN 上的 lemonade（gemma4 26B MoE）：

```toml
# ~/.config/rev-agent/config.toml （可选，纯 CLI 参数也行）
backend = "lemonade"
model   = "gemma-4-26B-A4B-it-uncensored"
baseURL = "http://192.168.9.101:13305/api/v1"   # 你 lemonade 服务地址
tokenBudget = 80000
notesPath   = "/tmp/work-notes.md"
```

支持的 backend：
| backend | 默认 baseURL | 默认 model |
|---|---|---|
| `lemonade`  | `http://192.168.9.101:13305/api/v1` | `Huihui-Qwen3.6-35B-A3B-abliterated-ggml` |
| `lm-studio` | `http://localhost:1234/v1` | `gemma-3-27b-it` |
| `ollama`    | `http://localhost:11434/v1` | `gemma3:27b` |
| `local`     | 必须 `--base-url` 显式 | 必须 `--model` 显式 |
| `claude`    | 走 Anthropic 云 | `claude-opus-4-7` |
| `openai`    | 走 OpenAI 云 | `gpt-4o` |

切换 lemonade 已加载的其他模型：

```bash
# 注意：lemonade 10.x 有 #2014 bug —— extra_models_dir 本地 GGUF 通过 OpenAI API
# 自动加载时会误判为 HF model 触发 "Failed to fetch model info from HF API (404)"。
# 切其他模型前必须先在服务器侧 `lemonade load <id> [--ctx-size N]` 手动预加载。
rev-agent --model Qwen3.5-35B-A3B-unsloth --once "..."
```

## 用法

### 一次性任务（`--once`，最常用）

```bash
# 默认 §1 短 system prompt（约 400 token）
bun src/index.tsx --once "在 ../work/mt-jadx/sources 里找 MT 2.26.5 的 MCP 入口类"

# 复杂任务用 §2 长 prompt（约 1100 token，含 7 铁律全文）
bun src/index.tsx --once "分析这个 APK 的签名算法" --verbose

# 切 backend
bun src/index.tsx --once "..." --backend claude  # ANTHROPIC_API_KEY 须设
```

### 交互模式（默认，OpenTUI 待 task #21）

```bash
bun src/index.tsx
# 当前回落到 readline 单任务输入，待 task #21 接 OpenTUI
```

### 跑 MVP 验收 5 项

```bash
bun run demo
```

## 工具白名单

agent 只能调下面 4 个工具：

| 工具 | 类别 | 审批 | 说明 |
|---|---|---|---|
| `shell` | mixed | 查询自动 / 写入弹审批 / 危险拒 | 仅白名单内的逆向工具（jadx/apktool/apkid/adb/frida/grep/strings/...），`rm -rf / sudo / curl / wget` 等硬拒 |
| `read_file` | read | auto | 硬限单次 ≤ 200 行（铁律 2 编进 Zod schema） |
| `grep` | read | auto | 优先 ripgrep，硬限单次 ≤ 50 命中 |
| `append_note` | write | **always ask** | 追加 `/tmp/work-notes.md`，首次自动 cp 模板 |

shell 审批分级：

- `auto`：`aapt2 dump`/`apkid`/`jadx -d`/`grep`/`strings` 等查询命令
- `ask`：`cp`/`mv`/`apktool b`/`apksigner sign`/`adb install`/`adb push` 等写入或副作用
- `deny`：`rm -rf`/`sudo`/`curl`/`wget`/`ssh`/`dd` 等危险或外泄

## 协议层（system prompt 来源）

agent 启动时从同级目录的 `../LLM首轮注入prompt.md` 抽取 prompt：

- 默认 `§1`（短，~847 字符 / 约 400 token）—— 含 7 铁律 + Token 预算 + 4 阶段渐进协议三件套
- `--verbose` 切 `§2`（长，~2714 字符 / 约 1100 token）—— 加用户意图映射 / 卡住自救 / 笔记同步纪律

通过 `REV_AGENT_PROMPT_PATH` env 或 `config.toml` 的 `promptPath` 覆盖 prompt 文件路径。

## 工作笔记

`/tmp/work-notes.md` 是 agent 的"长期记忆"：

- 任务超过 5 步、token 用 > 70% 时会被 prompt 引导调 `append_note`
- 首次写入自动 `cp ../LLM工作笔记模板.md /tmp/work-notes.md`
- 跨会话续传：新会话首轮注入 `@/tmp/work-notes.md` 即可继续

## 已知边界（V0.1 范围）

- ❌ 不暴露 MCP server（`@modelcontextprotocol/sdk` 装了但只 import 不 expose；V0.2 实现）
- ❌ 不做 sub-agent / 多 agent 协作
- ❌ 不做 GUI / Web UI
- ❌ 不做 RAG / 向量检索（grep + 笔记够用）
- ❌ 不做 chroot/docker 沙箱（白名单+timeout+截断三层兜底）
- ❌ 不做对话持久化 DB（笔记落 /tmp 即可）
- ❌ 不做插件系统（ToolRegistry 编译期静态注册）
- ❌ 不内置任何破解 / 绕过类预设（合规边界，见 plan §0）

## 项目结构

```
rev-agent/
├── src/
│   ├── index.tsx           # CLI 入口（commander）
│   ├── agent.ts            # Plan-Act 主循环
│   ├── llm.ts              # 后端切换 lemonade/lm-studio/ollama/local/claude/openai
│   ├── budget.ts           # Token 预算 + 70%/90% 告警
│   ├── prompts.ts          # 从 ../LLM首轮注入prompt.md 抽 §1 / §2
│   ├── config.ts           # ~/.config/rev-agent/config.toml
│   ├── runtime/
│   │   ├── run-once.ts     # --once 模式实现
│   │   └── run-interactive.ts  # OpenTUI 入口（待 task #21）
│   └── tools/
│       ├── index.ts        # ToolRegistry + classify 审批路由
│       ├── shell.ts        # 白/黑名单 + timeout + 输出截断
│       ├── read-file.ts    # Zod 强制 ≤200 行
│       ├── grep.ts         # ripgrep 优先 + head -N 硬限
│       └── note.ts         # append-only /tmp/work-notes.md
└── scripts/
    └── demo.sh             # MVP 验收 5 项
```

## 关联协议文档（项目根目录）

- `Mac 安卓逆向工具与工作流指南.md` — 主指南（4 阶段渐进 + 7 工作流）
- `LLM工作笔记模板.md` — `/tmp/work-notes.md` 模板源
- `LLM首轮注入prompt.md` — system prompt 数据源（§1 ~ §5）
- `SKILL.md.draft` — skill 化版本（未安装）

## 开发

```bash
bun install
bun typecheck       # tsc --noEmit
bun lint            # biome check
bun format          # biome format --write
bun start           # 跑 src/index.tsx
bun run demo        # MVP 验收
bun run compile     # bun build --compile → dist/rev-agent 单二进制
```

## License

私自使用。基于 Cline (Apache 2.0) 的设计思路，不分发。
