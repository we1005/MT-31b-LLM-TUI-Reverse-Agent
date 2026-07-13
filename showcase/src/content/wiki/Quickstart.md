# Quickstart

## 环境
- Bun 1.3 / node 24；仓库 `rev-agent/`。
- 本地后端 lemonade：`http://192.168.9.101:13305/api/v1`，模型 `Huihui-Qwen3.6-35B-A3B-abliterated-ggml`（**单并发——任何调用必须串行**）。
- 逆向产物：`../work/{mt-jadx,...}`（CTF 题）、`../apk-moded/<name>-jadx/`（9 个被破解 App，只读审计目标）。

## 装 + 自检
```bash
cd rev-agent
bun install
bun run typecheck        # 应输出 3（已知 baseline，SDK 类型不匹配，非新增）
bun run test             # 离线套件：guards33 + guards-signal16 + redact40 + advisor15
```

## 四种前端
```bash
# 1) 单任务（脚本/评分用，正文走 stdout）
bun src/index.tsx --once "<任务>" --workdir <jadx目录> --backend lemonade --auto-approve --budget 80000

# 2) 交互 TUI（默认，OpenTUI 富界面）
bun src/index.tsx

# 3) Web 前端（浏览器，Bun.serve + WebSocket，零外部依赖）
bun src/index.tsx --web            # 默认 :5178

# 4) MCP server（stdio，给 Claude Code / Cursor 反向调用）
bun src/index.tsx --mcp-server
```

## 常用增强 flag
```bash
--resume --notes <path>              # 从工作笔记续传（§3 续传 prompt + 预注入笔记）
--corpus <案卷目录>                   # 案卷续分析：接手强 agent 的前置产物续分析
--consult-cloud --advisor-backend claude   # 卡住时脱敏问云端顾问拿思路（默认关，需 key）
--ask-when-stuck                     # 卡住时输出困境报告求人工思路（与 --consult-cloud 互斥）
--verbose                            # 用 §2 长版 system prompt（默认 §1 短版）
```

## 跑一次真实任务（示例）
```bash
# 中难度：在 mt-jadx（13 万 java）里定位 MCP server 入口类
bun src/index.tsx --once "找出 MT 管理器 2.26.5 的 MCP server 入口类，给相对路径+类名+与路由/Service 的关系" \
  --workdir /Volumes/zhitai-7100/reverse-agent/work/mt-jadx --backend lemonade --auto-approve --budget 80000
# 收尾 stderr 会有一行 [SCORECARD] steps=.. reads=.. hops=.. ...（组件级指标）
```

判分：`python3 scripts/score-anchors.py <bank.json> <results_dir>`（确定性锚点召回）。
完整可复现实验（含 pi-agent 接入 + 所有 verbatim 提示词）：见仓库 `docs-resources/pi-agent实验复现手册.md`。
