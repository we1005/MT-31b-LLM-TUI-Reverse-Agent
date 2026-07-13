# Architecture

rev-agent = 自研轻量 TS/Bun agent CLI，把用户手写的**「4 阶段渐进探索协议 + 7 铁律 + Token 预算」**强制作为 system prompt 注入，驱动本地 lemonade 后端（Qwen3.6-35B-A3B MoE）专做安卓 APK **只读**逆向。一个 `Agent`（EventEmitter）核心，4 个前端共享；决策/记忆/守卫/安全都在框架里，模型只管「读码+推理」。

> 详细机制逐条见 **[[Mechanisms]]**；实测对比见 **[[Comparisons]]**；题库示例见 **[[Showcase Benchmark Questions]]**。

## 端到端数据流（上下游）

```mermaid
flowchart TD
    classDef entry fill:#1f6feb,color:#fff,stroke:#0b3d91;
    classDef front fill:#238636,color:#fff,stroke:#0f5323;
    classDef core fill:#8957e5,color:#fff,stroke:#4c2889;
    classDef inject fill:#bf8700,color:#fff,stroke:#7a5600;
    classDef mem fill:#1b7c83,color:#fff,stroke:#0d3e42;
    classDef backend fill:#cf222e,color:#fff,stroke:#82161e;
    classDef safe fill:#6e7681,color:#fff,stroke:#3d4148;

    CLI["CLI 入口 · index.tsx<br/>commander 解析 flags + 懒加载分发"]:::entry

    subgraph FE["前端（4 个，共享 Agent 核心）"]
        ONCE["--once · run-once<br/>非交互/CI/评分,流式进 stdout"]:::front
        TUI["TUI · run-interactive<br/>OpenTUI,默认交互"]:::front
        WEB["--web · run-web-server<br/>Bun.serve WS,busy 闸门守单并发"]:::front
        MCP["--mcp-server · run-mcp-server<br/>stdio,把 4 工具反向暴露"]:::front
    end

    subgraph PRE["前置注入（开局一次，只作 context）"]
        PROMPT["prompts · §1-§9 协议注入<br/>源: LLM首轮注入prompt.md"]:::inject
        PREFLIGHT["preflight · 缺源码树秒退 exit=2"]:::inject
        STACK["stack-probe · unzip 看 lib 主动探栈<br/>防谎称无 native"]:::inject
        CORPUS["corpus · --corpus 案卷续分析"]:::inject
        RESUME["resume · --resume 笔记续传"]:::inject
        PLAYBOOK["playbook · 栈感知套路注入<br/>默认关 REV_PLAYBOOK=1"]:::inject
    end

    AGENT["Agent 主循环 · agent.ts<br/>单步 Plan-Act + 手动 dispatch + 守卫 + emit 事件"]:::core

    subgraph MEM["记忆 / 守卫"]
        LEDGER["Ledger 结构化台账<br/>自动抽 reads/greps/hops · SWA 拼 messages 末尾"]:::mem
        GUARDS["decideGuard 止损<br/>signal/count · CHECKPOINT 注入"]:::mem
        BUDGET["Budget 线性计量<br/>只加 outputTokens · 70/90% 告警"]:::mem
    end

    subgraph TOOLS["工具层（4 白名单,classify auto/ask/deny）"]
        SHELL["shell 白名单+超时+4KB截断"]
        READ["read_file ≤200 行"]
        GREP["grep rg优先,≤50 命中"]
        NOTE["append_note 恒 ask"]
    end

    subgraph BE["LLM 后端"]
        LLM["createLLM · llm.ts<br/>reasoning_content 改写 fetch + 中间件"]:::backend
        BACKENDS["7 后端: lemonade默认/lm-studio/ollama/local/claude/openai/volcengine"]:::backend
    end

    subgraph SEC["卡住求助 / 安全（默认关）"]
        ADVISOR["云端顾问 · advisor.ts<br/>--consult-cloud 拿方法论"]:::safe
        REDACT["脱敏防火墙 · redact.ts<br/>台账精确替换+正则兜底+fail-closed"]:::safe
    end

    CLI --> ONCE & TUI & WEB & MCP
    ONCE & TUI & WEB --> PRE
    PRE --> AGENT
    MCP -->|"绕 Agent 直暴露"| TOOLS
    AGENT <-->|"每步 streamText"| LLM
    LLM --> BACKENDS
    AGENT -->|"classify→审批→run"| TOOLS
    AGENT <-->|"observeToolResult / render 末尾"| LEDGER
    AGENT --> GUARDS & BUDGET
    AGENT -.->|"卡住 askStrategy"| ADVISOR
    ADVISOR --> REDACT
    REDACT -.->|"脱敏后出网"| BACKENDS
    AGENT -.->|"emit assistantDelta/toolCall/done"| FE
```

## Agent 单步循环（Plan-Act）

```mermaid
flowchart TD
    S(["每轮 stepCount++"]) --> FOLD["compactHistory：仅 ctx 逼近 160k 才折叠旧结果<br/>SWA 平时不折,保稳定前缀"]
    FOLD --> STALL{"进度停滞检测<br/>stall / grep空转 / 迷路 hops=0 ?"}
    STALL -->|"卡住"| INTV["stuckIntervene：求思路续跑<br/>或 decideGuard 注入 CHECKPOINT / 资源上限收尾"]
    STALL -->|"正常"| ENOUGH{"hops≥enoughHops 或定点 reads 足量<br/>且没写结论?"}
    INTV --> ENOUGH
    ENOUGH -->|"是"| SOFT["一次性收尾软提示（不硬砍）"]
    ENOUGH -->|"否"| LLM
    SOFT --> LLM["callLLM：system=静态协议 · messages=历史+末尾拼 ledger<br/>SWA 稳定前缀 · 两段超时 · 流式 emit"]
    LLM --> BUD["累加 budget 仅 outputTokens + promoteFromProse 捞跳"]
    BUD --> CEIL{"ctx>ctxCeiling 或 budget 红区超 maxRedSteps?"}
    CEIL -->|"是"| FORCE["forcedFinish 强制收尾<br/>用 ledger 草稿,不裸 done"]
    CEIL -->|"否"| HASTOOL{"本轮有 tool_calls?"}
    HASTOOL -->|"无"| NUDGE{"断链检测：reads=0 / 宣布下一步没做 / 无 ## 最终结论?"}
    NUDGE -->|"命中"| N["nudge 续跑 or 收尾"] --> S
    NUDGE -->|"通过"| DONE(["emitScorecard + done ✅"])
    HASTOOL -->|"有"| DISP["逐个 classify→ask审批/deny拒→dedup 守卫→run→observeToolResult 写台账"]
    DISP --> S
    FORCE --> S
```

## 组件速查（按层）

| 层 | 组件 | 文件 | 职责 |
|---|---|---|---|
| 入口 | CLI | `src/index.tsx` | commander 解析全部 flags，短路分发到 4 前端，懒加载重模块保冷启动 |
| 前端 | run-once | `src/runtime/run-once.ts` | 非交互单任务，流式进 stdout 供评分；卡住可 exit=3 |
| 前端 | run-interactive + App | `src/runtime/run-interactive.ts` + `src/ui/App.tsx` | 默认 OpenTUI 交互，审批弹窗 + 卡住粘贴思路通道 |
| 前端 | run-web-server | `src/runtime/run-web-server.ts` | Bun.serve HTTP+WS，busy 闸门守 lemonade 单并发 |
| 前端 | run-mcp-server | `src/runtime/run-mcp-server.ts` | stdio 把 4 工具暴露给 Claude Code/Cursor 反向调用（绕 Agent） |
| Agent 核心 | Agent | `src/agent.ts` | 单步 Plan-Act 循环 + 手动 dispatch + 断链/止损/折叠/求助 + emit 事件 |
| 记忆 | Ledger | `src/memory/ledger.ts` | 带外结构化台账，自动抽 reads/greps、派生调用边、交叉核验；render 拼 messages 末尾 |
| 守卫 | decideGuard | `src/guards.ts` | 纯函数止损（signal/count），CHECKPOINT 注入，仅资源硬上限 finish |
| 守卫 | Budget | `src/budget.ts` | Token 线性计量（只加 outputTokens），70/90% 告警 |
| 工具 | ToolRegistry | `src/tools/index.ts` + `tools/*` | 4 白名单工具，Zod 校验 + classify(auto/ask/deny) + 手动 dispatch |
| 后端 | createLLM | `src/llm.ts` | AI SDK v6 LanguageModel，reasoning_content 改写 fetch + extractReasoning 中间件 |
| 协议 | prompts / preflight / stack-probe / corpus / resume / playbook | `src/prompts.ts` 等 | 开局前置注入（协议 §1-§9 / 源码树校验 / 主动探栈 / 案卷 / 续传 / 套路） |
| 安全 | advisor + redact | `src/advisor.ts` + `src/redact.ts` | 卡住→脱敏困境报告→云端拿方法论→还原续跑；唯一出网收口，fail-closed |

**一条设计铁律贯穿全图**：框架只做两件事——① 按**硬可观测事实**注入 context，② 按**资源硬上限**收 budget；**永不替 agent 决定「下一步动作」或「任务是否完成」**。越线即退化成反编译流水线。
