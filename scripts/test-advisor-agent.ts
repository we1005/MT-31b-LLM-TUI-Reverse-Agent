/**
 * Agent 主循环 × 云端顾问 的接线集成测试（确定性、离线、不依赖真实 LLM）。
 * 用手搓的 fake LanguageModelV3 把 agent 逼到「原地打转」硬止损，验证 THE SEAM：
 *   卡住 → stuckIntervene → 调用 askStrategy(=顾问) → 注入思路 → 重置计数 → 续跑 → 干净收尾。
 * 顾问用 spy（记录被调用 + 收到的 raw 报告），单独的 test-advisor-local.ts 已验证顾问内部(redact→LLM→restore)。
 * 另测 wireAdvisor 的配置产物（enabled/escalate/maxEscalations）。
 * 跑：bun scripts/test-advisor-agent.ts
 */
import { Agent } from '../src/agent.ts';
import { wireAdvisor } from '../src/advisor.ts';
import { Budget } from '../src/budget.ts';
import { builtinTools, ToolRegistry } from '../src/tools/index.ts';
import type { LanguageModel } from 'ai';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}  ${detail}`);
  }
};

// —— 手搓 fake 模型：前几次要 grep 同一 pattern（触发 dedup→进度停滞→stall），之后回结论 —— //
function arrToStream(parts: unknown[]): ReadableStream<unknown> {
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
}
function fakeModel(): { model: LanguageModel; calls: () => number } {
  let call = 0;
  const grepParts = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: '让我再 grep 一下 doSecretCheck。' },
    { type: 'text-end', id: 't' },
    {
      type: 'tool-call',
      toolCallId: 'c',
      toolName: 'grep',
      input: JSON.stringify({ pattern: 'doSecretCheck', path: 'src/redact.ts' }),
    },
    {
      type: 'finish',
      finishReason: 'tool-calls',
      usage: { inputTokens: 10, outputTokens: 6, totalTokens: 16 },
    },
  ];
  const concludeParts = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    {
      type: 'text-delta',
      id: 't',
      delta: '## 最终结论\n按新思路反向追踪后，确认入口在 onCreate。已定位，无需再查。',
    },
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } },
  ];
  const model = {
    specificationVersion: 'v3',
    provider: 'fake',
    modelId: 'fake',
    supportedUrls: {},
    async doStream() {
      const parts = call < 3 ? grepParts : concludeParts; // 前3次 grep(触发 stall)，之后结论
      call++;
      return { stream: arrToStream(parts) };
    },
    async doGenerate() {
      throw new Error('unused');
    },
  } as unknown as LanguageModel;
  return { model, calls: () => call };
}

// ————————————————————— 题A：wireAdvisor 配置产物 —————————————————————
console.log('【题A wireAdvisor 配置：默认关 / 开启后 escalate+askStrategy 就位】');
{
  const logs: string[] = [];
  const off = wireAdvisor(
    { consultCloud: false },
    () => ({ goal: '', hops: [], reads: [], greps: [] }),
    (m) => logs.push(m),
  );
  ok('未开 --consult-cloud → enabled=false', off.enabled === false);
  ok('未开时 escalateWhenStuck=false', off.escalateWhenStuck === false);
  ok('未开时 askStrategy 不提供', off.askStrategy === undefined);

  const on = wireAdvisor(
    { consultCloud: true, advisorBackend: 'lemonade', redactLevel: 2, maxConsults: 2 },
    () => ({ goal: '', hops: [], reads: [], greps: [] }),
    (m) => logs.push(m),
  );
  ok('开启 --consult-cloud → enabled=true', on.enabled === true);
  ok('开启后 escalateWhenStuck=true', on.escalateWhenStuck === true);
  ok('开启后 askStrategy 就位', typeof on.askStrategy === 'function');
  ok('maxEscalations 取 --max-consults=2', on.maxEscalations === 2);
  ok(
    'redactLevel 非法值被夹到 0..2',
    wireAdvisor(
      { consultCloud: true, redactLevel: 9 },
      () => ({ goal: '', hops: [], reads: [], greps: [] }),
      () => {},
    ).enabled === true,
  );
}

// ————————————————————— 题B：真实 agent 循环里 stuck→consult→inject→续跑 —————————————————————
console.log('\n【题B agent 循环 seam：原地打转 → 调顾问 → 注入思路 → 续跑收尾】');
{
  const { model, calls } = fakeModel();
  const tools = new ToolRegistry(builtinTools());
  const budget = new Budget(80_000);

  // spy 顾问：记录被调用 + 收到的 raw 报告，返回一条思路
  let spyCalls = 0;
  let spyReport = '';
  const askStrategy = async (report: string): Promise<string | null> => {
    spyCalls++;
    spyReport = report;
    return '【新思路】停止正向盲搜，改反向追踪：先 grep loadUrl 定位终点，再逐层回溯 caller 到入口。';
  };

  const warns: string[] = [];
  const agent = new Agent({
    model,
    tools,
    budget,
    systemPrompt: 'test',
    approve: async () => true,
    escalateWhenStuck: true,
    askStrategy,
    maxEscalations: 1,
    stallCap: 2, // 收紧，尽快触发 stall（省 fake 调用）
    exploreCap: 99, // 关掉探索路径，专测 stall 路径
    maxSteps: 12,
  });
  agent.on('warn', (m) => warns.push(m));
  let stuckReport = '';
  agent.on('stuck', (r) => {
    stuckReport = r;
  });

  agent.addUserMessage('追踪 doSecretCheck 的完整调用链，定位到入口 Activity。');
  await agent.run();

  ok('顾问被调用了恰好 1 次(stuck 触发→consult)', spyCalls === 1, `spyCalls=${spyCalls}`);
  ok(
    '顾问收到的是 raw 困境报告(含"困境报告"标题)',
    /困境报告/.test(spyReport),
    `report head="${spyReport.slice(0, 40)}"`,
  );
  ok('raw 报告里含真实目标(未脱敏——脱敏在顾问内部做)', spyReport.includes('doSecretCheck'));
  ok('emit 了 stuck 事件', stuckReport.length > 0);
  const injected = agent
    .getMessages()
    .some((m) => typeof m.content === 'string' && m.content.includes('反向追踪'));
  ok('思路被注入进 agent 消息历史', injected);
  ok(
    '续跑后干净收尾(消息里有 ## 最终结论)',
    agent.getMessages().some((m) => typeof m.content === 'string' && /##\s*最终结论/.test(m.content)),
  );
  const scorecard = warns.find((w) => w.includes('[SCORECARD]')) ?? '';
  ok('计分卡记录 escalations=1', /escalations=1\b/.test(scorecard), `scorecard="${scorecard.slice(0, 160)}"`);
  console.log(
    `    (fake 模型被调用 ${calls()} 次；SCORECARD: ${scorecard.replace('[SCORECARD] ', '').slice(0, 140)})`,
  );
}

console.log(`\n${'='.repeat(60)}`);
console.log(`顾问×agent 接线集成：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
