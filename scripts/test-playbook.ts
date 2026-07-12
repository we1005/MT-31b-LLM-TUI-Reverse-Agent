/**
 * MVP-3/4 playbook 离线单测（栈感知匹配 + 只作 context 渲染 + 自动生长 + 持久化往返）。零模型。
 * 跑：bun scripts/test-playbook.ts
 */
import { learnPlaybookFromLedger, loadLearned, matchPlaybooks, renderPlaybookBlock, saveLearned, type Playbook } from '../src/playbook.ts';
import type { StackReport } from '../src/stack-probe.ts';
import type { LedgerState } from '../src/memory/ledger.ts';
import { existsSync, rmSync } from 'node:fs';

let pass = 0;
let fail = 0;
const ok = (n: string, c: boolean, d = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${d}`); } };

const stack = (hits: string[], nativeSo = false): StackReport => ({
  hits: hits.map((s) => ({ stack: s, where: '', tool: '' })), hasNativeSo: nativeSo, dexCount: 1, dataGap: false, verdict: '',
});
const noStack: StackReport = { hits: [], hasNativeSo: false, dexCount: 1, dataGap: true, verdict: '' };

console.log('【MVP-3 栈感知匹配】');
{
  // 任务关键词命中 crack-audit(不依赖栈)
  const m1 = matchPlaybooks(undefined, '审计这个 mod 版怎么绕过 VIP 会员', []);
  ok('破解审计题(关键词)命中 crack-audit playbook', m1.some((p) => p.id === 'crack-audit'));
  // Unity 栈命中
  const m2 = matchPlaybooks(stack(['Unity (IL2CPP)']), '追 sign 算法', []);
  ok('Unity 栈命中 unity-il2cpp playbook', m2.some((p) => p.id === 'unity-il2cpp'));
  // 加固栈命中
  const m3 = matchPlaybooks(stack(['360 加固']), '定位登录逻辑', []);
  ok('360加固 栈命中 packer playbook', m3.some((p) => p.id === 'packer'));
  // dataGap(未判栈)不按栈命中,但关键词仍可命中
  const m4 = matchPlaybooks(noStack, '普通定点定位 MCP 入口', []);
  ok('无栈信号+无关键词 → 不乱注入(空)', m4.length === 0, `got ${m4.map((p) => p.id)}`);
}

console.log('\n【只作 context 渲染(可无视,非命令)】');
{
  const block = renderPlaybookBlock(matchPlaybooks(undefined, 'crack vip', []));
  ok('渲染块明确"可无视·不是命令"', /可无视/.test(block) && /不是命令/.test(block));
  ok('含破解三套路(恒真/短路/深一两跳)', /恒真/.test(block) && /深一两跳/.test(block));
  ok('空匹配渲染为空串', renderPlaybookBlock([]) === '');
}

console.log('\n【MVP-4 自动生长 + 持久化往返】');
{
  const led: LedgerState = {
    goal: '追 Unity sign', hops: [{ raw: 'A→B', from: 'A', to: 'B', evidence: 'x.java:1', corroborated: true }],
    reads: [{ path: 'a/B.java', ranges: [{ start: 1, end: 50 }] }, { path: 'a/C.java', ranges: [{ start: 1, end: 9 }] }],
    greps: [{ pattern: 'checkSign', path: '.', hitCount: 2 }, { pattern: 'RegisterNatives', path: '.', hitCount: 1 }],
  };
  const pb = learnPlaybookFromLedger(led, stack(['Unity (IL2CPP)']));
  ok('解出的 ledger 归纳出 learned playbook', !!pb && pb.source === 'learned', `pb=${pb?.id}`);
  ok('learned 绑定到栈(Unity)', !!pb?.triggerStacks?.some((s) => s.includes('Unity')));
  ok('learned 记住 grep 锚点', !!pb && pb.steps.some((s) => /checkSign|RegisterNatives/.test(s)));
  // 未解出(reads<3 且无 corroborated hop)→ 不学
  const noLearn = learnPlaybookFromLedger({ goal: '', hops: [], reads: [{ path: 'x', ranges: [] }], greps: [] }, noStack);
  ok('未解出 → 不学(返回 null)', noLearn === null);

  // 持久化往返(用临时路径,不碰真 ~/.config)
  const tmp = '/Volumes/zhitai-7100/reverse-agent/_scratch/pi-bench/test-learned.json';
  saveLearned([pb!], tmp);
  const back = loadLearned(tmp);
  ok('learned 落盘+载回', back.length === 1 && back[0].id === pb!.id);
  ok('载回的 triggerPatterns 是可用 RegExp', back[0].triggerPatterns?.[0] instanceof RegExp || (back[0].triggerPatterns ?? []).every((r) => typeof r.test === 'function'));
  // 载回后能被 matchPlaybooks 用上(同栈命中)
  const withLearned = matchPlaybooks(stack(['Unity (IL2CPP)']), '别的任务', back);
  ok('learned playbook 能被后续同栈任务命中注入', withLearned.some((p) => p.source === 'learned'));
  if (existsSync(tmp)) rmSync(tmp);
}

console.log(`\n${'='.repeat(50)}`);
console.log(`playbook 单测：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
