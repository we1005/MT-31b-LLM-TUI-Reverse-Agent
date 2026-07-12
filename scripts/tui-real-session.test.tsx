/**
 * 真实做题会话 TUI bug 猎手（L2a headless testRender + 真 Agent + 真工具 + lemonade）。
 * 复刻 run-interactive 的真实接线(onSubmit=resetTurnCounters+addUserMessage+run+catch)，
 * 经 App 的 onSubmit 路径驱动**真实多轮逆向问题**，重装监测:
 *   进程 uncaughtException/unhandledRejection · agent 'error' · 事件流完整性 · 多轮隔离 · 卡死。
 * 目的:简单命令交互暴露不出的严重 bug，在真实做题时才现形。
 * 跑: cd rev-agent && bun run scripts/tui-real-session.test.tsx <jadx-workdir> 2>/dev/null
 * ⚠️ 打真 lemonade,串行,耗时数分钟。
 */
import { createElement } from 'react';
import { act } from 'react';
// biome-ignore lint/suspicious/noExplicitAny: test-utils 无类型
import { testRender } from '@opentui/react/test-utils';
import { Agent } from '../src/agent.ts';
import { Budget } from '../src/budget.ts';
import { createLLM } from '../src/llm.ts';
import { loadSystemPrompt } from '../src/prompts.ts';
import { ToolRegistry } from '../src/tools/index.ts';
import { App, createApprovalChannel } from '../src/ui/App.tsx';

const WORKDIR = process.argv[2] ?? '/Volumes/zhitai-7100/reverse-agent/work/mt-jadx';
process.chdir(WORKDIR);

const bugs: string[] = [];
process.on('uncaughtException', (e) => bugs.push(`uncaughtException: ${e?.stack || e}`));
process.on('unhandledRejection', (e) => bugs.push(`unhandledRejection: ${e}`));

const events: Record<string, number> = {};
const errors: string[] = [];
const agent = new Agent({
  model: createLLM({ backend: 'lemonade' }),
  tools: new ToolRegistry(),
  budget: new Budget(30000),
  systemPrompt: await loadSystemPrompt({ section: '§1' }),
  approve: async () => true, // 真会话:自动放行(审批 y/n 正确性已在 tui-render.test 覆盖)
});
for (const ev of ['assistant', 'assistantDelta', 'reasoningDelta', 'toolCall', 'toolResult', 'toolDenied', 'warn', 'done', 'stuck', 'budget']) {
  agent.on(ev, (...a: unknown[]) => {
    events[ev] = (events[ev] ?? 0) + 1;
    if (ev === 'error') errors.push(String(a[0]));
  });
}
agent.on('error', (e: unknown) => errors.push(String((e as Error)?.message ?? e)));

// 复刻 run-interactive 的 onSubmit
const onSubmit = async (text: string) => {
  agent.resetTurnCounters();
  agent.addUserMessage(text);
  try {
    await agent.run();
  } catch (e) {
    agent.emit('error', e instanceof Error ? e : new Error(String(e)));
  }
};

const { renderer, mockInput, renderOnce } = (await testRender(
  createElement(App, { agent, notesPath: '/tmp/real-session-notes.md', onSubmit, approvalChannel: createApprovalChannel() }),
  { width: 100, height: 34 },
)) as any;
async function flush(fn?: () => unknown) {
  await act(async () => {
    if (fn) await fn();
    await renderOnce();
  });
}
await flush();
// biome-ignore lint/suspicious/noExplicitAny: 找 input
function findInput(n: any): any {
  if (!n) return null;
  if (/input/i.test(n.constructor?.name || '') && typeof n.focus === 'function') return n;
  for (const k of n.getChildren?.() || []) {
    const f = findInput(k);
    if (f) return f;
  }
  return null;
}
await flush(() => findInput(renderer.root)?.focus());

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}  [${extra}]`);
  }
}

// 经 App 输入框提交一题，等 done（或超时），返回本轮事件快照
async function askTurn(q: string, timeoutMs: number): Promise<Record<string, number>> {
  const before = { ...events };
  const donePromise = new Promise<void>((resolve) => {
    const h = () => {
      agent.off('done', h);
      resolve();
    };
    agent.on('done', h);
  });
  await flush(() => mockInput.typeText(q));
  await flush(() => mockInput.pressEnter());
  await Promise.race([donePromise, new Promise((r) => setTimeout(r, timeoutMs))]);
  await flush();
  const delta: Record<string, number> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(events)])) delta[k] = (events[k] ?? 0) - (before[k] ?? 0);
  return delta;
}

console.log(`\n=== 真实做题会话(workdir=${WORKDIR}) ===`);
// 第 1 题(触发工具调用的真问题)
console.log('第1题: 找 MT 主 Activity 入口类');
const t1 = await askTurn('在当前 jadx 源码树里找 MT 管理器的主 Activity 入口类,给出类名和 file:line', 240000);
console.log('  事件Δ:', JSON.stringify(t1));
ok('第1题: 有流式输出(assistantDelta>0)', (t1.assistantDelta ?? 0) > 0, `delta=${t1.assistantDelta}`);
ok('第1题: 真调用了工具(toolCall>0)', (t1.toolCall ?? 0) > 0, `tc=${t1.toolCall}`);
ok('第1题: 收到 done', (t1.done ?? 0) >= 1);
ok('第1题: 无 agent error', errors.length === 0, errors.join('|'));

// 第 2 题(多轮:跟进问题,测 turn 隔离 + 上下文延续 + 计数器重置)
console.log('第2题(多轮跟进): 它继承自哪个基类');
const t2 = await askTurn('上面那个入口类继承自哪个基类?只答基类名 + file:line', 240000);
console.log('  事件Δ:', JSON.stringify(t2));
ok('第2题: 多轮仍有流式输出(计数器重置生效,未卡死)', (t2.assistantDelta ?? 0) > 0, `delta=${t2.assistantDelta}`);
ok('第2题: 多轮收到 done', (t2.done ?? 0) >= 1);
ok('全程: 无进程崩溃(uncaughtException/unhandledRejection)', bugs.length === 0, bugs.slice(0, 2).join(' || '));

console.log(`\n结果: ${pass} passed, ${fail} failed`);
if (bugs.length) console.log('⚠️ 崩溃类 bug:\n' + bugs.join('\n'));
if (errors.length) console.log('⚠️ agent error:\n' + errors.join('\n'));
try {
  renderer.destroy?.();
} catch {
  /* ignore */
}
process.exit(fail || bugs.length ? 1 : 0);
