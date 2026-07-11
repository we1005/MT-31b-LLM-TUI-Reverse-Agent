// 确定性守卫单测：用 MockLanguageModelV3 脚本化失败行为，断言守卫触发（不依赖真 LLM 非确定性）。
import { z } from 'zod';
import { Agent } from '../src/agent.ts';
import { Budget } from '../src/budget.ts';

// 极简 mock ToolRegistry（Defect F 场景模型不发 tool call，run/classify 不会被调）
const mockTools: any = {
  asAiSdkTools: () => ({}),
  classify: () => 'auto',
  run: async () => ({ result: {}, error: undefined }),
};

// 手搓最小 LanguageModelV3：每次 doStream 吐一段"结论"文本 + finish(stop)，**不发任何 tool-call**（绕开 ai/test 依赖坑）
function scriptedNoToolModel(): any {
  return {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-no-tool',
    supportedUrls: {},
    async doStream() {
      const parts = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '0' },
        { type: 'text-delta', id: '0', delta: '## 最终结论\n有道翻译用 MD5 + AES/CBC/PKCS5Padding。' },
        { type: 'text-end', id: '0' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
      ];
      return {
        stream: new ReadableStream({
          start(c) {
            for (const p of parts) c.enqueue(p);
            c.close();
          },
        }),
      };
    },
  };
}

let pass = 0,
  fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`);
  }
}

// ---- 测 Defect F：0 工具就下结论 → "先读方法体核实" 提醒必触发 ----
const warns: string[] = [];
const agent = new Agent({
  model: scriptedNoToolModel(),
  tools: mockTools,
  budget: new Budget(80000),
  systemPrompt: 'test',
  approve: async () => true,
  maxSteps: 6,
});
agent.on('warn', (m: string) => warns.push(m));
agent.addUserMessage('在 /some/workdir 里逆向有道翻译的签名算法');
await agent.run();

ok('Defect F: 触发"先读方法体核实"提醒(0工具下结论被拦)', warns.some((w) => w.includes('先读方法体核实')));
ok('Defect F: 提醒只触发一次(noInvestigateNudged 一次性)', warns.filter((w) => w.includes('先读方法体核实')).length === 1);
ok('Defect F: 最终仍能收尾(有界,不死循环)', warns.some((w) => w.includes('SCORECARD')));

// ---- 测 R7 grep 空转 + R6 forcedFinish 强制终止：模型每步只发不同 grep、从不 read ----
// mock 工具：grep 返回命中(工具"成功"但 ledger 记 greps 不记 reads → reads 冻结)
const grepTools: any = {
  asAiSdkTools: () => ({
    grep: { description: 'grep', inputSchema: z.object({ pattern: z.string(), path: z.string() }) },
  }),
  classify: () => 'auto',
  run: async () => ({ result: { ok: true, hits: ['a.java:1', 'b.java:2'] }, error: undefined }),
};
let gi = 0;
function scriptedGrepSpinModel(): any {
  return {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-grep-spin',
    supportedUrls: {},
    async doStream() {
      gi++;
      const parts = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: `让我再 grep 一次 pattern${gi}。` },
        { type: 'text-end', id: 't' },
        { type: 'tool-input-start', id: `c${gi}`, toolName: 'grep' },
        { type: 'tool-input-delta', id: `c${gi}`, delta: `{"pattern":"p${gi}","path":"/x"}` },
        { type: 'tool-input-end', id: `c${gi}` },
        { type: 'tool-call', toolCallId: `c${gi}`, toolName: 'grep', input: `{"pattern":"p${gi}","path":"/x"}` },
        { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } },
      ];
      return {
        stream: new ReadableStream({
          start(c) {
            for (const p of parts) c.enqueue(p);
            c.close();
          },
        }),
      };
    },
  };
}
const warns2: string[] = [];
const agent2 = new Agent({
  model: scriptedGrepSpinModel(),
  tools: grepTools,
  budget: new Budget(80000),
  systemPrompt: 'test',
  approve: async () => true,
  maxSteps: 25,
});
agent2.on('warn', (m: string) => warns2.push(m));
agent2.on('toolDenied', (_id: string, _n: string, reason: string) => warns2.push(`DENIED:${reason}`));
agent2.addUserMessage('追一条链路');
await agent2.run();
const lastStep = Number((warns2.join(' ').match(/step=(\d+)/g) ?? ['step=0']).pop()!.split('=')[1]);
ok('R7: grep 空转止损触发', warns2.some((w) => w.includes('只 grep 未读新代码')));
ok('R6: forcedFinish 后工具被硬禁', warns2.some((w) => w.includes('DENIED:forced_finish_tools_disabled')));
ok('R6: 有界终止(远早于 maxSteps=25，未跑飞)', lastStep < 15);
ok('R6/R7: 最终收尾出 SCORECARD', warns2.some((w) => w.includes('SCORECARD')));

// ---- 测卡住求助（--ask-when-stuck）：grep 空转 + escalateWhenStuck + askStrategy 返回思路 ----
const warns3: string[] = [];
const reports: string[] = [];
let askCalls = 0;
const agent3 = new Agent({
  model: scriptedGrepSpinModel(),
  tools: grepTools,
  budget: new Budget(80000),
  systemPrompt: 'test',
  approve: async () => true,
  maxSteps: 40,
  escalateWhenStuck: true,
  askStrategy: async (report: string) => {
    askCalls++;
    reports.push(report);
    return '改用反向追踪：先 grep 终点锚点再回溯'; // 每次都给思路 → 测 maxEscalations 上限是否兜底
  },
});
agent3.on('warn', (m: string) => warns3.push(m));
agent3.on('stuck', (r: string) => warns3.push('STUCK_EVENT'));
agent3.addUserMessage('追一条链路');
await agent3.run();
ok('求助: 卡住时触发 stuck 事件+困境报告', warns3.some((w) => w === 'STUCK_EVENT') && reports.some((r) => r.includes('求助·困境报告')));
ok('求助: 注入用户思路后重置续跑', warns3.some((w) => w.includes('已收到用户思路')));
ok('求助: 报告含调查足迹(目标/已搜)', reports[0]?.includes('调查足迹') && reports[0]?.includes('目标'));
ok('求助: maxEscalations=3 上限兜底(askStrategy 调用 ≤3 次)', askCalls <= 3 && askCalls >= 1);
ok('求助: 上限后回退 forcedFinish 有界终止', warns3.some((w) => w.includes('SCORECARD')));

// ---- 测 --once 卡住停机(haltWhenStuck, 无 askStrategy 回调) → stuckHalted + 'stuck_halt' done ----
const warns4: string[] = [];
let doneReason4 = '';
const agent4 = new Agent({
  model: scriptedGrepSpinModel(),
  tools: grepTools,
  budget: new Budget(80000),
  systemPrompt: 'test',
  approve: async () => true,
  maxSteps: 40,
  escalateWhenStuck: true,
  haltWhenStuck: true, // --once：无 askStrategy → 卡住停机等外部 --strategy
});
agent4.on('warn', (m: string) => warns4.push(m));
agent4.on('stuck', () => warns4.push('STUCK_EVENT'));
agent4.on('done', (r: string) => { doneReason4 = r; });
agent4.addUserMessage('追一条链路');
await agent4.run();
ok('--once卡住: 停机 stuckHalted=true', (agent4 as any).stuckHalted === true);
ok('--once卡住: 有困境报告 stuckReport', typeof (agent4 as any).stuckReport === 'string' && (agent4 as any).stuckReport.includes('困境报告'));
ok('--once卡住: done reason = stuck_halt', doneReason4 === 'stuck_halt');
ok('--once卡住: 触发 stuck 事件', warns4.some((w) => w === 'STUCK_EVENT'));

// ---- 测 SWA 稳定前缀铁律（硬约束 a+b 的离线守卫，不依赖在线后端）----
// 捕获每步传给模型的 system + 尾消息，断言：
//   (a) system 在所有步逐字节相同（静态前缀，前缀缓存可复用的前提）
//   (b) 台账标记只出现在 messages 末尾 ephemeral，绝不在 system，也绝不写回持久 messages
const LEDGER_MARK = '【系统进度台账';
const STATIC_SYS = 'STATIC-PREFIX-SYSTEM-PROMPT-逐字节不变';
const seenSystems: string[] = [];
const seenTails: string[] = [];
let capStep = 0;
function capturingGrepModel(): any {
  return {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: 'mock-capture',
    supportedUrls: {},
    async doStream(options: any) {
      capStep++;
      // AI SDK 把 system 折进 prompt 数组(role:'system')；尾消息=最后一条
      const prompt: any[] = options?.prompt ?? [];
      const sysMsg = prompt.find((m) => m.role === 'system');
      const sysText = typeof sysMsg?.content === 'string' ? sysMsg.content : JSON.stringify(sysMsg?.content ?? '');
      const last = prompt[prompt.length - 1];
      seenSystems.push(sysText);
      seenTails.push(JSON.stringify(last?.content ?? ''));
      const parts = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: `grep 第 ${capStep} 次。` },
        { type: 'text-end', id: 't' },
        { type: 'tool-input-start', id: `cap${capStep}`, toolName: 'grep' },
        { type: 'tool-input-delta', id: `cap${capStep}`, delta: `{"pattern":"pat${capStep}","path":"/x"}` },
        { type: 'tool-input-end', id: `cap${capStep}` },
        { type: 'tool-call', toolCallId: `cap${capStep}`, toolName: 'grep', input: `{"pattern":"pat${capStep}","path":"/x"}` },
        { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } },
      ];
      return {
        stream: new ReadableStream({
          start(c) {
            for (const p of parts) c.enqueue(p);
            c.close();
          },
        }),
      };
    },
  };
}
const agent5 = new Agent({
  model: capturingGrepModel(),
  tools: grepTools,
  budget: new Budget(80000),
  systemPrompt: STATIC_SYS,
  approve: async () => true,
  maxSteps: 25,
});
agent5.addUserMessage('追一条链路验证前缀不变');
await agent5.run();

// (a) system 逐字节不变
const uniqSys = [...new Set(seenSystems)];
ok(`SWA前缀: system 在所有步逐字节相同(采样${seenSystems.length}步, 唯一值${uniqSys.length})`, seenSystems.length >= 3 && uniqSys.length === 1);
// system 恰好=静态 systemPrompt，且从不含台账标记
ok('SWA前缀: system 恒等于静态 systemPrompt，不含台账', uniqSys.length === 1 && uniqSys[0] === STATIC_SYS && !uniqSys[0].includes(LEDGER_MARK));
// (b) 台账只在尾消息出现（一旦 ledger 非空）；至少有一步的尾消息带台账
ok('SWA前缀: 台账只出现在 messages 末尾(尾消息含台账标记)', seenTails.some((t) => t.includes(LEDGER_MARK)));
// (b) 台账绝不写回持久 messages（run 结束后 agent.messages 不含台账标记）
const persisted = JSON.stringify((agent5 as any).messages ?? []);
ok('SWA前缀: 台账不写回持久 messages(ephemeral)', !persisted.includes(LEDGER_MARK));

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
