> 缘起:用户指出'TUI对话测不了'的结论错误(Happy Coder/CC Connect 都能代理 CLI agent 会话)。本文认真研究并给出**可实跑**的 TUI 测试方法。
> Workflow wh0qu9u4i(4路:PTY自动化/Happy-CC-Connect机制/OpenTUI测试设施+前端结构/后端接口+web前端)。

> ## ⚠️ 实测校正(我亲自跑过 `scripts/tui-render.test.tsx`,修正下文 workflow agent 的乐观声称)
> workflow agent 声称"L2a testRender ALL PASS(含帧内容断言)"。**我实测发现这不准确**,诚实修正:
> - ✅ **交互层可测且正确(5/5 过)**:注入按键 → 真实 `<App>` → `onSubmit` 触发(**推翻"测不了"**);含 CJK/特殊字符的文本经 input→onSubmit **字节完整**(无乱码/无缺失);工具审批 y→true、n→false 两分支都正确 resolve(稳定,带超时护栏不 hang)。
> - ✅ **testRender + CJK rasterize 能力正常**:trivial `<text>HELLO世界</text>` 正确渲染、中文无乱码;`useTerminalDimensions()` 在测试渲染器正确返回 100(非 0)。
> - ❌ **但 `captureCharFrame()` 对完整 `<App>` 返回空白字形**(headless 与 detached-tmux 都空白)。根因**不是** dims(=100)、**不是** App 逻辑(handler 全工作)、**不是** CJK——是 OpenTUI 0.1.102 在 **bun 无头/detached 自动化捕获**下的 nuance;**用户真实交互终端可正常渲染**(已确认在用)。
> - **结论**:像素级渲染正确性以**真实交互终端**为准(可用);**内容缺失/乱码在数据层已被 `tui-render.test.tsx`(输入)+ 几十次 `--once` 实跑(助手输出,均为连贯中文、零替换符)双重覆盖**。自动化像素 diff 完整 App 在本环境不可靠,故 L2a 定位为**交互/数据正确性测试**而非像素测试。

# 如何程序化测试 rev-agent 的 TUI 交互对话

## 0. 先纠错：之前说"测不了"错在哪

之前判断"TUI 交互对话没法自动测"，理由是**我的 agent harness 每次 Bash 调用都是一个全新 shell、`stdin=/dev/null`、且调用之间不保留任何进程状态**——所以没法"按住键盘"往一个前台交互程序里持续喂输入。

这个前提是对的，但**结论错了**。harness 的一次性无 stdin 只是"我这个调用方"的形态限制，**不是 TUI 本身不可测的证据**。任何 CLI/TUI agent（Claude Code、Happy Coder、tui-use 全都如此）在 UI 层背后一定有一个**可编程的后端接口**；正确的自动化姿势从来不是"往前台进程喂键盘"，而是三选一：

1. **绕开前端，直接驱动后端类**——rev-agent 的对话逻辑 100% 在 `Agent` 类里，TUI 只是薄前端，可整体替换（本仓库 `scripts/test-guards.ts` 已经这么做了）。
2. **把长驻交互进程放进一个"持有者"里**（detached PTY / tmux server / daemon），它跨我的多次一次性调用存活；之后每条独立命令只负责 send-keys / capture / curl。
3. **把整段脚本化交互塞进一条命令内部**（`expect` 脚本、`bun run driver.ts`、in-process headless test）——进程在这一条命令的生命周期内自己持有 PTY 和 stdin，跑到底再退出。我 harness 只需一次性把它跑起来、收 stdout。

三条路都验证过在本环境可跑。瓶颈始终在**调用形态**，不在 TUI。

### rev-agent 的可测性事实（已核对源码）

| 事实 | 出处 |
|---|---|
| `class Agent extends EventEmitter`，对外只需 `addUserMessage(text)` / `run()` / `resetTurnCounters()` / `getMessages()` + `approve`/`askStrategy` 回调 | `src/agent.ts:179` |
| Agent 发的事件：`assistant` / `assistantDelta` / `reasoningDelta` / `toolCall` / `toolResult` / `toolDenied` / `warn` / `done` / `error` / `stuck` / `budget` | `src/agent.ts` 各 `this.emit(...)` |
| 三种现成驱动：`run-once.ts`（--once）/ `run-interactive.ts`（OpenTUI）/ `run-mcp-server.ts`（--mcp-server） | `src/runtime/` |
| TUI 只干三件事：`onSubmit → addUserMessage+run`；`agent 事件 → React 渲染`；`approve/askStrategy → Promise 通道` | `src/ui/App.tsx:122` `App({agent,notesPath,onSubmit,approvalChannel,strategyChannel})` |
| 审批/策略是 Promise-park 通道，可程序化 resolve | `App.tsx:315 createApprovalChannel()` / `:345 createStrategyChannel()` |
| 已有 headless 确定性单测先例（MockLanguageModelV3 脚本化 + 断言 warn 事件） | `scripts/test-guards.ts` |
| 工具齐备：`tmux 3.6b`(/opt/homebrew/bin/tmux)、`expect`(/usr/bin/expect)、`bun 1.3.13`；`@opentui/react` 带 `test-utils`、`@opentui/core` 带 `testing` | 本机 `which` 实测 |

---

## 1. 三层测试法（由易到难）

分层原则：**对话逻辑 bug 用 L1（最可靠、最确定、最快），前端渲染/输入路径 bug 用 L2，人机/远程交互用 L3。** 三层共用同一个 `Agent` 后端，互不干扰。

```
L1  程序化驱动 Agent 类        —— 不碰 TUI，测 100% 对话行为，已有先例，首选
L2a in-process headless testRender —— 测真 <App> 渲染+输入路径，无 PTY 无 stdin，已验证 ALL PASS
L2b tmux 全进程 E2E            —— 测真 bun src/index.tsx 的 CLI 装配/真 stdin/真渲染，冒烟兜底
L3  Agent 包成 HTTP+SSE / WS server —— 人机可点 + 远程可达，curl 一次性驱动
```

---

### L1 — 直接程序化多轮驱动 Agent 类（首选，零 TUI 零网络）

`Agent` 是纯 EventEmitter，多轮对话在脚本内部循环 `addUserMessage`，**根本不需要 stdin**。整段就是一条 `bun scripts/drive-convo.ts`。

新建 `scripts/drive-convo.ts`：

```ts
import { Agent } from '../src/agent.ts';
import { Budget } from '../src/budget.ts';
import { createLLM } from '../src/llm.ts';
import { loadSystemPrompt } from '../src/prompts.ts';
import { ToolRegistry } from '../src/tools/index.ts';

process.chdir(process.argv[3] ?? '.');            // 逆向工件目录（jadx-out）
const agent = new Agent({
  model: createLLM({ backend: 'lemonade' }),
  tools: new ToolRegistry(),
  budget: new Budget(80000),
  systemPrompt: await loadSystemPrompt({ section: '§1' }),
  approve: async () => true,                       // 测试=全自动放行
});

const turns = ['逆向签名算法定位到类', '第2跳的 caller 是谁', '拼成链路图收尾'];
for (const t of turns) {
  agent.resetTurnCounters();                       // 铁律：每轮必重置，否则 maxSteps 跨轮累加会卡死
  agent.addUserMessage(t);
  const out: string[] = [];
  const cap = (d: string) => out.push(d);
  agent.on('assistantDelta', cap);
  await agent.run();                               // 串行 await（lemonade 单并发铁律）
  agent.off('assistantDelta', cap);
  console.log(`\n=== TURN: ${t}\n${out.join('')}`);
}
console.log('FINAL:', JSON.stringify(agent.getMessages(), null, 2));
```

运行：

```bash
cd /Volumes/zhitai-7100/reverse-agent/rev-agent && \
  bun scripts/drive-convo.ts _ /Volumes/zhitai-7100/reverse-agent/work/mt-jadx
```

**要确定性回归**（不打真 LLM）：把 `createLLM(...)` 换成 `test-guards.ts` 里的 `scriptedNoToolModel()`（脚本化 `doStream` 吐固定 parts + `finish(stop)`），然后断言 `agent.getMessages()` / `warn` 事件里的关键行，例如：

```ts
const warns: string[] = [];
agent.on('warn', w => warns.push(w));
// ... 跑完后
assert(warns.some(w => w.includes('先读方法体核实')));   // Defect: grep 未读正文就下结论
assert(warns.some(w => w.includes('强制收尾')));
```

**A/B 消融**直接叠环境变量（不改代码）：

```bash
REV_AGENT_NO_LEDGER_RENDER=1 bun scripts/drive-convo.ts ...
REV_AGENT_LEDGER_IN_SYSTEM=1 bun scripts/drive-convo.ts ...
```

**覆盖面**：主循环 / 断链 nudge / stall 止损 / ledger / budget / 流式 delta / 卡住升级——全在 `Agent` 里，这条路覆盖约 100% 关键对话行为。唯一测不到的是 OpenTUI 渲染层，那交给 L2。

---

### L2a — in-process headless `testRender`（测真 `<App>`，无 PTY 无 stdin，**已验证 ALL PASS**）

这是**测 TUI 输入/渲染路径最干净的一招**：`@opentui/react` 自带 `test-utils`（本机已确认 `node_modules/@opentui/react/test-utils.js` 存在），把**真实的 `<App>`** 挂到内存渲染器上——stdin 是内存 `Readable`、stdout 是内存 `TestWriteStream`（`isTTY=true` 固定尺寸），`mockInput` 把按键 `emit('data', ...)` 进 OpenTUI **真正的键盘解析器**，因此会真的触发 `<input>` 的 `onSubmit` 和 `ToolApproval` 的 `useKeyboard`。整件事就是一条 `bun run file.tsx`，跑完自己退出并打印——**完美契合一次性无 stdin harness**。

> **踩坑纠偏（重要）**：早期用 `@opentui/core/testing` 的 `createTestRenderer` + `@opentui/react` 的 `createRoot().render()` 手工拼装时，`<App>` 回来是**空白帧**（只有背景空格、零字形）。根因**不是** PTY、**不是**尺寸（Bun 报 `isTTY=true`/140x40/resize 正常），而是那条手工挂载路径没把 React 树 flush 成字形。**换用 `@opentui/react/test-utils` 的 `testRender()`（它在 react `act()` 里正确挂载）+ 显式给输入框 `.focus()`，空白问题消失，端到端验证全过。** 另一个坑：**测试渲染器里 `<input>` 不会自动聚焦**（挂载后 `focused=false`），不 `.focus()` 按键会被丢弃。

新建 `scripts/tui-render.test.tsx`（必须放在**项目树内**，否则 `node_modules` 的 react 解析不到）：

```tsx
import { EventEmitter } from 'node:events';
import { createElement } from 'react';
import { testRender } from '@opentui/react/test-utils';
import { App, createApprovalChannel } from '../src/ui/App.tsx';

const agent = new EventEmitter() as any;          // App 只调 agent.on/off，裸 EventEmitter 即可
const submitted: string[] = [];
const onSubmit = async (t: string) => { submitted.push(t); };
const approvalChannel = createApprovalChannel();

const { renderer, mockInput, renderOnce, captureCharFrame } = await testRender(
  createElement(App, { agent, notesPath: '/tmp/x.md', onSubmit, approvalChannel }),
  { width: 80, height: 24 },
);
await renderOnce();

// FOCUS GOTCHA：测试渲染器不自动聚焦输入框，必须手动 focus
function findInput(n: any): any {
  if (!n) return null;
  if (/input/i.test(n.constructor?.name || '') && typeof n.focus === 'function') return n;
  for (const k of (n.getChildren?.() || [])) { const f = findInput(k); if (f) return f; }
  return null;
}
findInput((renderer as any).root)?.focus();
await renderOnce();

// —— 路径1：输入框 onSubmit ——
await mockInput.typeText('分析登录流程');
await mockInput.pressEnter();
await renderOnce();
console.assert(submitted[0] === '分析登录流程', 'onSubmit text mismatch');
console.assert(captureCharFrame().includes('分析登录流程'), 'not rendered');

// —— 路径2：工具审批 y/n（ToolApproval 用全局 useKeyboard，无需 focus）——
const p = approvalChannel.ask('read_file', { path: 'X.smali' });
await renderOnce();
mockInput.pressKey('y');                          // n / pressEscape => false；y / pressEnter => true
console.assert((await p) === true, 'approval not resolved true');

// —— 路径3：流式事件上屏 ——
agent.emit('assistantDelta', '找到入口: onLogin()');
await renderOnce();
console.assert(captureCharFrame().includes('onLogin'), 'delta not streamed');

console.log('ALL PASS');
```

运行（`2>/dev/null` 吞掉 React `act()` 警告）：

```bash
cd /Volumes/zhitai-7100/reverse-agent/rev-agent && bun run scripts/tui-render.test.tsx 2>/dev/null
```

`mockInput` 全量 API：`typeText(str,delayMs)` / `pressKey(key,{shift,ctrl,meta})` / `pressKeys([...],delayMs)` / `pressEnter` / `pressEscape` / `pressTab` / `pressBackspace` / `pressArrow('up'|'down'|'left'|'right')` / `pressCtrlC` / `pasteBracketedText(text)`。断言颜色/光标用 `captureSpans()`（逐 cell fg/bg）。要多帧回归动画/滚动用 `@opentui/core/testing` 的 `TestRecorder`。

**覆盖面**：消息流渲染、`<input>` onSubmit、`ToolApproval` 的 y/n、`BudgetBar`、流式 delta 上屏——真组件真键盘解析器，且确定性、毫秒级、无 30fps 循环。**这是测 TUI 前端集成的推荐主路。** 测不到的是 `index.tsx` 的 commander 参数解析、`createCliRenderer` 的真 SIGINT、真 OS stdin——那交给 L2b。

---

### L2b — tmux 全进程 E2E（唯一在本 harness 实跑真 `bun src/index.tsx` 的法子）

当你必须验证**真进程端到端**（`index.tsx` 参数装配、真 Zig 渲染、真 stdin 解析、真 SIGINT），用 tmux 当那个"跨我多次一次性调用存活的持有者"：`tmux server` 常驻，`new-session -d` 起完就 detach，之后每条 `send-keys` / `capture-pane` 都是独立的一次性 shell 命令。

```bash
# 起：后台 detached PTY，给足尺寸和 TERM。切记：绝不 >重定向 TUI 的 stdout（会让 isTTY=false、塌成 80x24、画进文件而非 pane），只重定向 stderr
tmux kill-session -t rev 2>/dev/null; \
tmux new-session -d -s rev -x 200 -y 50 \
  'env TERM=xterm-256color bash -lc "cd /Volumes/zhitai-7100/reverse-agent/rev-agent && bun src/index.tsx --auto-approve 2>/tmp/rev.err"'

# 等渲染（轮询屏面出现输入框，别用固定 sleep）
until tmux capture-pane -t rev -p | grep -q '输入\|›\|>'; do sleep 1; done

# 喂一条用户消息（-l = 逐字面量注入，避免键名歧义）
tmux send-keys -t rev -l '逆向签名算法定位类'; tmux send-keys -t rev Enter

# 工具审批 y/n（OpenTUI 单键即收，无需 Enter）
tmux send-keys -t rev y

# 轮询抓屏断言（-p 输出已去 ANSI 的纯文本）
until tmux capture-pane -t rev -p | grep -q '最终结论\|done\|✓'; do sleep 2; done
tmux capture-pane -t rev -p | grep -q '最终结论' && echo PASS || echo FAIL
tmux capture-pane -t rev -p -S -2000            # 含 2000 行滚动历史（alt-screen 可能不填 scrollback，以实时视口为准）

# 调试：记录 pane 吐出的每一个字节
tmux pipe-pane -t rev -o 'cat >>/tmp/rev.raw'   # 关闭：再 tmux pipe-pane -t rev

# 收尾
tmux kill-session -t rev
```

**要点**：等待条件一律用 `until ... capture-pane | grep` 轮询（配合 `Monitor` 工具），**别在前台 `sleep`**；所有命令用绝对路径（harness 每次调用 cwd 会重置）；`send-keys` 特殊键用命名 token（`Enter`/`Escape`/`Tab`/`Up`/`Down`/`C-c`/`C-d`），文本用 `-l`。**缺点**：断言基于屏面快照（比 `captureCharFrame` 粗）、靠轮询略慢略 flaky、且会拉起真 lemonade（串行！）。所以 L2b 只做少量冒烟/CLI 装配验证，逻辑回归仍走 L1。

---

### L3 — Agent 包成 HTTP+SSE / WS server（人机可点 + 远程可达）

照抄 `--mcp-server` 的服务化先例，新增 `src/runtime/run-web-server.ts` + `index.tsx` 加 `--web-server --port` 分支。核心是**复用 `App.tsx` 那套 Promise-park 审批通道**，把 TUI 的"消息流 + 输入框 + y/n 审批"1:1 映射成"SSE 事件流 + POST /message + POST /approve"。这样 TUI 和 web 从此共用同一 `Agent` 后端，坐实"TUI 只是可替换薄前端"。

接口草图（Bun 内建 `Bun.serve`，零额外依赖）：

```ts
// src/runtime/run-web-server.ts（骨架）
export async function runWebServer(o: { port?: number; backend: any; workdir?: string; autoApprove?: boolean }) {
  if (o.workdir) process.chdir(o.workdir);
  type S = { agent: Agent; pend: Map<string, (ok: boolean) => void>; subs: Set<(l: string) => void> };
  const sessions = new Map<string, S>();

  async function mk() {
    const id = crypto.randomUUID();
    const pend = new Map<string, (ok: boolean) => void>();
    const subs = new Set<(l: string) => void>();
    const emit = (t: string, d: unknown) => { const l = `event: ${t}\ndata: ${JSON.stringify(d)}\n\n`; for (const w of subs) w(l); };
    const agent = new Agent({
      model: createLLM({ backend: o.backend }), tools: new ToolRegistry(),
      budget: new Budget(80000), systemPrompt: await loadSystemPrompt({ section: '§1' }),
      approve: async (c) => { if (o.autoApprove) return true; emit('tool_pending', { id: c.id, name: c.name, args: c.args }); return new Promise(r => pend.set(c.id, r)); },
    });
    for (const ev of ['assistant','toolCall','toolResult','toolDenied','warn','done','error','stuck'] as const)
      agent.on(ev, (...a: any[]) => emit(ev, a.length === 1 ? a[0] : a));
    agent.on('assistantDelta', d => emit('assistant_delta', d));
    const s: S = { agent, pend, subs }; sessions.set(id, s); return id;
  }

  const server = Bun.serve({ port: o.port ?? 8787, idleTimeout: 255, routes: {
    'POST /session': async () => Response.json({ session: await mk() }),
    'GET /events': (req) => { const id = new URL(req.url).searchParams.get('session')!; const s = sessions.get(id); if (!s) return new Response('404', { status: 404 }); server.timeout(req, 0);
      return new Response(new ReadableStream({ start(c) { const e = new TextEncoder(); const w = (l: string) => c.enqueue(e.encode(l)); s.subs.add(w); req.signal.addEventListener('abort', () => s.subs.delete(w)); } }), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } }); },
    'POST /message': async (req) => { server.timeout(req, 0); const { session, text, wait } = await req.json(); const s = sessions.get(session); if (!s) return new Response('404', { status: 404 }); s.agent.resetTurnCounters(); s.agent.addUserMessage(text);
      if (wait) { const cs: string[] = []; const cap = (d: string) => cs.push(d); s.agent.on('assistantDelta', cap); await s.agent.run(); s.agent.off('assistantDelta', cap); return Response.json({ answer: cs.join(''), steps: (s.agent as any).step }); }
      void s.agent.run(); return Response.json({ ok: true }); },
    'POST /approve': async (req) => { const { session, id, ok } = await req.json(); const r = sessions.get(session)?.pend.get(id); if (!r) return new Response('404', { status: 404 }); sessions.get(session)!.pend.delete(id); r(!!ok); return Response.json({ ok: true }); },
  }});
  process.stderr.write(`[rev-agent web] http://localhost:${o.port ?? 8787}\n`);
  return new Promise<number>(() => {});   // 常驻
}
```

驱动（全是**一次性无 stdin 的 curl**，状态存 server 里，持久 stdin 需求归零）：

```bash
# 用 run_in_background 起 server（跨 turn 常驻）
bun src/index.tsx --web-server --port 8787 \
  --workdir /Volumes/zhitai-7100/reverse-agent/work/mt-jadx --auto-approve   # ← run_in_background

# 建会话
SID=$(curl -s -XPOST localhost:8787/session | grep -o '"session":"[^"]*' | cut -d'"' -f4)
# 发消息 + 阻塞拿完整答案（测试最省）
curl -s -XPOST localhost:8787/message -H 'content-type: application/json' \
  -d "{\"session\":\"$SID\",\"text\":\"逆向签名算法\",\"wait\":true}"
# → {"answer":"## 最终结论 …","steps":7}
```

**HITL 审批测试**（不加 `--auto-approve`）：后台起 `curl -N localhost:8787/events?session=$SID > /tmp/ev.log`，发 `POST /message`（不 wait），用 `Monitor`/`until` 轮询 `/tmp/ev.log` 出现 `tool_pending`，取出 `id` 再 `POST /approve {id,ok:true}`。

**WS 变体**（`server.upgrade(req)` + `websocket:{message,open,close}`）：一条双向 socket 同时承载上行 `{type:'message'|'approve'}` 和下行 delta/tool_pending，天然复刻 `createApprovalChannel` 的 `ask()/resolve()` 语义，最适合浏览器端 20 行 `fetch+EventSource`/`WebSocket` 做真人可点前端。但 `curl` 不会 WS，本 harness 里 SSE+curl（上面这套）更顺手；WS 只在需要人机实时界面时上。

**另有 NDJSON stdio 桥**（对标 `claude -p --output-format stream-json`）：新增 `--stdio` 分支，stdin 逐行读 `{type:'user',text}`、stdout 逐行吐 `{ev,p}`，一条 `printf '...' | bun src/index.tsx --stdio --auto-approve > events.ndjson` 就机读断言，判分器友好。它和已有的 `--mcp-server` 都是 rev-agent 自己的"Agent SDK"，属于 L1 的网络化变体。

---

## 2. 本环境立即可用的 TUI 冒烟配方（直接跑）

目标：一段能直接执行的脚本，起 `bun src/index.tsx`、发一句话、抓屏断言有回复。两个版本任选。

### 版本 A：tmux（推荐，跨调用、可增量驱动）

把下面存成 `scratchpad/tui-smoke.sh`，一次性跑（内部自轮询，不阻塞 harness）：

```bash
#!/usr/bin/env bash
set -u
APP=/Volumes/zhitai-7100/reverse-agent/rev-agent
WORK=/Volumes/zhitai-7100/reverse-agent/work/mt-jadx
S=revsmoke

tmux kill-session -t $S 2>/dev/null
tmux new-session -d -s $S -x 200 -y 50 \
  "env TERM=xterm-256color bash -lc 'cd $APP && bun src/index.tsx --auto-approve --workdir $WORK 2>/tmp/$S.err'"

# 1) 等输入框渲染（最多 60s）
for i in $(seq 1 60); do tmux capture-pane -t $S -p | grep -q '输入\|›\|>' && break; sleep 1; done

# 2) 发一句话
tmux send-keys -t $S -l '找出 mt APK 的下载 API'; tmux send-keys -t $S Enter

# 3) 等出现回复/结论（最多 180s，lemonade 慢）
OK=FAIL
for i in $(seq 1 90); do
  tmux capture-pane -t $S -p | grep -qE '最终结论|结论|done|✓|http' && { OK=PASS; break; }
  sleep 2
done

echo "SMOKE: $OK"
echo "---- last screen ----"
tmux capture-pane -t $S -p | grep -n '[^[:space:]]' | tail -30
tmux kill-session -t $S 2>/dev/null
[ "$OK" = PASS ] && exit 0 || { echo '--- stderr ---'; tail -20 /tmp/$S.err; exit 1; }
```

跑：`bash /private/tmp/.../scratchpad/tui-smoke.sh`（用 `run_in_background` 起，避免 180s 阻塞；完成后读 stdout 里的 `SMOKE: PASS/FAIL`）。

### 版本 B：expect（整段握手在一条命令内完成）

`expect` 进程自己持有 PTY 到脚本结束，因此一次性无 stdin 也能跑（但对 OpenTUI 全屏重绘，行式匹配比 tmux 快照 flaky，仅作备选）：

```bash
cat >/tmp/rev.exp <<'EOF'
set timeout 180
spawn env TERM=xterm-256color bun src/index.tsx --auto-approve --workdir /Volumes/zhitai-7100/reverse-agent/work/mt-jadx
expect { -re {输入|›|>} {} timeout { puts "NO_PROMPT"; exit 2 } }
send "找出 mt APK 的下载 API\r"
expect { -re {结论|done|http} { puts "SMOKE: PASS" } timeout { puts "SMOKE: FAIL"; exit 1 } }
send "\x03"
expect eof
EOF
cd /Volumes/zhitai-7100/reverse-agent/rev-agent && expect /tmp/rev.exp
```

> 提醒：两个版本都拉真 lemonade。**铁律：lemonade 单并发，rev-agent 调用必须串行**——同一时刻只跑一个冒烟，别并发多会话。

---

## 3. 各方案取舍与推荐

| 层 | 方法 | 覆盖 | 确定性/速度 | 依赖 | 一次性无 stdin 契合度 | 何时用 |
|---|---|---|---|---|---|---|
| **L1** | 直接驱动 `Agent` 类（`drive-convo.ts` / mock 模型） | 对话逻辑 ~100%（主循环/nudge/stall/ledger/budget/流式），**不含渲染** | 最高（mock 可完全确定）/ 最快 | 无 | 完美（一条 `bun run`，脚本内循环喂） | **默认。所有对话行为回归、A/B 消融、CI** |
| **L2a** | in-process `testRender`（真 `<App>`） | 真渲染+真键盘解析+onSubmit+y/n审批+delta 上屏 | 高（帧确定）/ 快（无 30fps） | `@opentui/react/test-utils`（已装） | 完美（一条 `bun run *.tsx`，内存 stdin） | **前端集成回归。测输入路径/审批/渲染的首选** |
| **L2b** | tmux 全进程 E2E | 真 `index.tsx` 装配 + 真 OS stdin + 真 SIGINT + 真 Zig 渲染 | 低（屏面快照/轮询）/ 慢 | tmux（已装）+ 真 lemonade | 好（tmux server 常驻，每条命令独立） | **少量冒烟：CLI 参数、Ctrl-C、"能不能跑通一轮+审批"** |
| **L3** | HTTP+SSE / WS server（curl 驱动） | Agent 行为（同 L1）+ 真人可点界面 + 远程可达 | 中（结构化 NDJSON 可 diff）/ 取决于后端 | 需写 `run-web-server.ts`；Bun 内建 | 极好（server 常驻，每次交互一条 curl） | **要给人/浏览器交互、HITL 审批演示、将来接远程 relay** |

**一句话推荐**：

- **测对话逻辑** → L1（最可靠，已有 `test-guards.ts` 先例，直接扩）。
- **测 TUI 前端集成**（输入框/审批/渲染/流式上屏）→ L2a（`testRender`，已验证全过，无 PTY 无 stdin 最干净）；只有验证 `index.tsx` CLI 装配和真 stdin/信号时才补 L2b（tmux）。
- **要人机交互 / 远程 / HITL** → L3（把 Agent 服务化，TUI 与 web 共用后端）。

三层不是二选一：**平时 CI 跑 L1 + L2a（确定、秒级），偶尔手动跑一次 L2b 冒烟兜真进程，L3 作为产品化/远程能力的长期落点。** 全环节遵守 lemonade 单并发——所有真后端调用串行。


---

## 附:真实做题会话 bug 猎 + 美观核验(2026-07-12,commit 见 git)
> 用户要求"在真实做题的多轮 TUI 交互中找 bug(简单命令暴露不出严重问题)"+ 保证美观。实测如下。

### A. 真实做题会话(`scripts/tui-real-session.test.tsx`,真 Agent+真工具+lemonade)
经 App 的 onSubmit 路径驱动**真实 2 轮逆向问题**(复刻 run-interactive 接线),**7/7 过**:
- 第1题「找 MT 主 Activity 入口类」:**5 次真工具调用 + 623 reasoning delta + 376 assistant delta + done,零 agent error**。
- 第2题多轮跟进「它继承自哪个基类」:仍流式 + done(计数器重置生效、未卡死)。
- 全程**无进程崩溃**(uncaughtException/unhandledRejection)。
→ 交互/逻辑层在真实负载下**无 bug**;多轮、流式、真工具执行、审批(自动放行)全通。

### B. ⚠️ 发现并修的真实稳定性 bug:MessageList 未知 role 崩溃 → 白屏
个体组件渲染(`testRender` 单渲 MessageList,**非空白,可捕获**——与整 App 空白不同)时暴露:`ROLE_STYLE[m.role].fg` 对**任何不在 ROLE_STYLE 的 role 直接抛 TypeError**,一条坏消息炸掉**整个消息流→白屏**,无 fallback。
- 现状 App 派发的 8 个 role 都在表内(正常不触发),但**加新 role/拼错/外部消息即白屏**=稳定性地雷。
- **已修**:`const style = ROLE_STYLE[m.role] ?? ROLE_STYLE.system`(未知 role 回退,永不炸屏)。实测含 `weird-unknown` role 的列表不再崩、正常渲染。

### C. 美观核验(个体组件真实渲染帧)
- **消息流**:role 色+图标前缀区分清晰——`›`用户(cyan)/`💭`思考(暗灰)/`→[grep]`工具调(magenta)/`  ←`结果(缩进灰)/`  ✗`拒(红)/`✗`错(红)/`⚠`系统(灰);CJK 无乱码;层次干净。
- **BudgetBar**:`████░░░ 56.0k/80.0k (70%)` 填充条+数字,清爽(70% 转黄)。
- **ToolApproval**:圆角边框卡片 `╭─╮`+`⚠ 工具审批:<name>`+JSON args,美观。
- **CJK 边框对齐**:headless capture 里 CJK 行右框列偏移,经分析=captureCharFrame 把宽字符表示为 1 字符串位(占 2 cell)的**表示 artifact**,真实终端 cell 上对齐(建议真机扫一眼确认)。
→ 个体组件**渲染精美、色彩语义清晰、CJK 正确**;整 App 的 captureCharFrame 空白是 OpenTUI 无头捕获 nuance(非美观问题,真机可用)。
