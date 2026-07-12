# TUI 输出代理与测试（其他 agent 复现指南）

> 回答两个问题：**① agent 的输出/交互是怎么被"代理/捕获"出来的**（供评分、日志、前端）；**② TUI 交互怎么做到可程序化测试**（曾以为"测不了"，实则可测）。含可直接跑的代码。
> 关键结论：**agent 是事件源（EventEmitter），前端只是订阅者**。所以"代理输出"= 订阅事件；"测 TUI"= 用无头 renderer 注入按键 + 断言事件/回调，不需要真终端。

---

## 1. 输出是怎么代理出来的：agent 事件 → 各前端订阅

`Agent extends EventEmitter`，跑循环时 emit 这些事件（`src/agent.ts` `AgentEvents`）：

| 事件 | 含义 |
|---|---|
| `assistantDelta(text)` | 正文流式增量（逐 token） |
| `reasoningDelta(text)` | 思考链流式增量（Qwen reasoning_content 救回后） |
| `assistant(text)` | 一轮完整正文 |
| `toolCall({id,name,args})` / `toolResult(id,name,result)` / `toolDenied` | 工具调用/结果/被拒 |
| `budget(used,max,level)` / `warn(msg)` / `error(e)` / `done(reason)` | 预算/告警(含 SCORECARD)/错误/结束 |
| `stuck(report)` | 卡住求助（--ask-when-stuck / --consult-cloud） |

**四个前端 = 同一套事件的不同订阅方**（`src/runtime/`）：
- **`--once`**（`run-once.ts`）：`assistantDelta → process.stdout.write`（正文进 **stdout**，评分脚本读它）；`reasoningDelta → stderr`（暗灰，不污染 stdout）；`warn/toolCall → stderr`。**这就是"代理标准输出"**：把事件流直接落到 stdout/stderr。
- **TUI**（`run-interactive.ts` + `ui/App.tsx`）：React 组件 `agent.on(...)` 订阅，setState 上屏。
- **`--web`**（`run-web-server.ts`）：事件 `→ JSON → WebSocket 广播`给浏览器。
- **`--mcp-server`**：事件包成 MCP 响应。

> 含义：**要拿 agent 的任何输出/中间态，订阅事件即可**，不依赖某个前端。评分/基准用 `--once`（stdout）或 `--web`(--mode) 或直接 EventEmitter（测试里）。

### pi-agent 侧的输出代理（对照，供跨 harness 复现）
用 pi 驱动时，输出捕获走 pi 自己的通道：`--mode text` → 最终答案进 **stdout**；`--mode json` → 全事件流(含 thinking/toolCall/usage)进 **stdout**；会话自动存 `~/.pi/agent/sessions/<enc-cwd>/*.jsonl`（逐行 `message` 事件，含 `usage.totalTokens/reasoning/cacheRead` 与 `content[].type=="toolCall"`）。解析脚本见 `pi/run-pi.sh`。

---

## 2. TUI 为什么可测：headless testRender + mockInput

用 `@opentui/react/test-utils` 的 `testRender()` 无头渲染真实 `<App>`，拿到 `{ renderer, mockInput, renderOnce, captureCharFrame }`：
- **`mockInput.typeText/pressEnter/pressKey`**：注入按键。
- **真实 `<App>`**：注入 → 组件 → `onSubmit` 回调 / `approvalChannel` resolve 真的被触发。
- **`act()` 包裹 + `renderOnce()`**：flush React 状态。
- **输入组件要先 `.focus()`** 才收键。

**能测到什么**（数据层，够抓"缺失/乱码/串轮/审批 hang"这些真 bug）：
1. 交互可测性：注入按键 → onSubmit 触发。
2. **输入无乱码/无缺失**：CJK/特殊字符经 input→onSubmit **字节完整**往返。
3. 空白输入被忽略（防空提交刷屏）；多轮按序不串不丢。
4. 审批稳定性：y→true / n/Esc→false 两分支（带超时护栏，绝不 hang）。
5. 渲染回归：整 App 非空白（防白屏）+ 笔记框不重叠。

**已知限制（诚实）**：`captureCharFrame` 对**完整 `<App>`** 在 bun 无头/detached 下返回空白字形（OpenTUI 0.1.102 的 nuance，非 App bug——`useTerminalDimensions` 正确、handler 全工作、trivial+CJK 渲染正常、真实终端可用）。像素级渲染以真实交互终端为准；本测试在**数据层**已能捕获"内容缺失/乱码"的源头。

跑：`cd rev-agent && bun run scripts/tui-render.test.tsx 2>/dev/null`（离线，不碰 lemonade）。
另有 `scripts/tui-real-session.test.tsx`：真 Agent+工具+lemonade 2 轮会话，插桩 uncaughtException/agent-error/事件流（需 lemonade）。

---

## 3. 最小可复现代码（拷贝即用；完整版见 `scripts/tui-render.test.tsx`）

```tsx
import { EventEmitter } from 'node:events';
import { act, createElement } from 'react';
import { testRender } from '@opentui/react/test-utils';           // 无类型声明,用 any
import { App, createApprovalChannel } from '../src/ui/App.tsx';

// 1) 能力基线:testRender 能渲染 <text> 且 CJK 无乱码
const r = await testRender(createElement('box', {}, createElement('text', {}, 'HELLO世界')), { width: 40, height: 6 });
await act(async () => { await r.renderOnce(); });
console.assert(r.captureCharFrame().includes('HELLO世界'));
r.renderer.destroy?.();

// 2) 真实 <App> 交互:注入按键 → onSubmit 触发 + CJK 字节完整
const agent = new EventEmitter() as any;              // App 只用 agent.on/off,mock EventEmitter 即可
const submitted: string[] = [];
const approvalChannel = createApprovalChannel();
const { renderer, mockInput, renderOnce } = await testRender(
  createElement(App, { agent, notesPath: '/tmp/t.md', onSubmit: async (t: string) => { submitted.push(t); }, approvalChannel }),
  { width: 100, height: 30 },
);
const flush = async (fn?: () => unknown) => { await act(async () => { if (fn) await fn(); await renderOnce(); }); };
await flush();

// 找到 input 组件并 focus(否则不收键)
function findInput(n: any): any {
  if (!n) return null;
  if (/input/i.test(n.constructor?.name || '') && typeof n.focus === 'function') return n;
  for (const k of n.getChildren?.() || []) { const f = findInput(k); if (f) return f; }
  return null;
}
await flush(() => findInput(renderer.root)?.focus());

const CJK = '逆向 sign 算法：追 native 边界→libmsaoaidsec.so（VIP 会员）';
await flush(() => mockInput.typeText(CJK));
await flush(() => mockInput.pressEnter());
console.assert(submitted.length === 1 && submitted[0] === CJK);   // 触发 + 字节完整

// 空白忽略 + 多轮不串
await flush(() => mockInput.typeText('   ')); await flush(() => mockInput.pressEnter());
console.assert(submitted.length === 1);                            // 空白不触发

// 3) 审批两分支:y→true / n→false(带超时护栏,绝不 hang)
const withTimeout = <T,>(p: Promise<T>, ms: number, fb: T) => Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fb), ms))]);
let yv: boolean | null = null;
const py = withTimeout(approvalChannel.ask('shell', { cmd: 'jadx -d out a.apk' }) as Promise<boolean>, 4000, null as any).then((v) => { yv = v; });
await flush(); await flush(() => mockInput.pressKey('y')); await py;
console.assert(yv === true);
```

要点回顾：`act()` 包 flush、input 先 `focus()`、mock 用纯 `EventEmitter`、审批用 `withTimeout` 护栏防 hang、断言放在**数据层**（onSubmit/resolve 值 + captureCharFrame 的 CJK 命中/非空白）。

---

## 4. 曾经的坑（其他 agent 别重犯）

- **"TUI 测不了"是错的**：headless testRender 完全能程序化注入+断言。之前误判是 harness 局限。
- **白屏根因**（真 bug，已修）：外层 box 缺 `height` → scrollbox 吃满屏挤出输入/预算/笔记 → 整屏白；笔记区被压扁 → 行重叠。修法：`App.tsx` 外层 box 用 `height={height}`（来自 `useTerminalDimensions`），兄弟 box 加 `flexShrink={0}`。`tui-render.test.tsx` 末尾的"渲染回归"断言锁住了这两个修复，别改回去。
- **空提交前缀污染**（已修）：空白 submit 要清空输入，否则下条消息被拼上前导空白。
