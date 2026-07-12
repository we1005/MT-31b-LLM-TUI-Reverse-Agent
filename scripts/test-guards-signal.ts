/**
 * MVP-0 离线单测：signal-gated 止损守卫决策（纯函数，零模型、零 lemonade）。
 * 断言核心：signal 模式下"有活跃线索/未读码"时**不强制收尾**、改注入 CHECKPOINT；
 *   只有资源硬上限或宽限用尽才 finish；count 模式=旧的即时收尾。
 * 跑：bun scripts/test-guards-signal.ts
 */
import { decideGuard, MAX_CHECKPOINTS, type GuardSignals } from '../src/guards.ts';

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

const base = (o: Partial<GuardSignals> = {}): GuardSignals => ({
  trigger: 'readHopStall',
  reads: 0,
  greps: 6,
  hops: 0,
  checkpointsIssued: 0,
  hardCeilingHit: false,
  productiveRecently: false,
  ...o,
});

console.log('【题1 EasyNotes 复现场景：grep 多、reads=0、首次触发 → 应 CHECKPOINT 逼读码，绝不强制收尾】');
{
  const d = decideGuard(base({ trigger: 'readHopStall', reads: 0, greps: 6, checkpointsIssued: 0 }), 'signal');
  ok('kind=checkpoint（不是 finish）', d.kind === 'checkpoint', `实际 ${d.kind}`);
  ok('消息在逼"去 read_file 读方法体"', !!d.message && /read_file|读.*方法体/.test(d.message));
  ok('消息明确"不是让你收尾"', !!d.message && /不是让你收尾/.test(d.message));
}

console.log('\n【题2 count 模式（旧行为）：同场景立即强制收尾——证明是 signal 模式带来的改变】');
{
  const d = decideGuard(base({ reads: 0, greps: 6, checkpointsIssued: 0 }), 'count');
  ok('count 模式 kind=finish', d.kind === 'finish', `实际 ${d.kind}`);
  ok('count 模式非资源标注（旧强制收尾）', d.resourceLimited === false);
  ok('signal 与 count 同信号下决策不同', decideGuard(base(), 'signal').kind !== decideGuard(base(), 'count').kind);
}

console.log('\n【题3 有活跃进展（刚读到新文件）→ continue，绝不打断深调查】');
{
  const d = decideGuard(base({ productiveRecently: true }), 'signal');
  ok('kind=continue', d.kind === 'continue', `实际 ${d.kind}`);
}

console.log('\n【题4 已读过码但停滞 → CHECKPOINT 给"二选一"（再读一个/收尾），不强制收尾】');
{
  const d = decideGuard(base({ trigger: 'stall', reads: 3, checkpointsIssued: 0 }), 'signal');
  ok('kind=checkpoint', d.kind === 'checkpoint', `实际 ${d.kind}`);
  ok('消息给"二选一"', !!d.message && /二选一/.test(d.message));
  ok('reads>0 用 decide 文案（非逼读码文案）', !!d.message && !/一个方法体都还没/.test(d.message));
}

console.log('\n【题5 CHECKPOINT 宽限用尽仍打转 → finish（资源标注），有始有终不无限打转】');
{
  const d = decideGuard(base({ checkpointsIssued: MAX_CHECKPOINTS }), 'signal');
  ok('kind=finish', d.kind === 'finish', `实际 ${d.kind}`);
  ok('resourceLimited=true（标注资源上限而非任务完成）', d.resourceLimited === true);
  ok('消息含"资源上限"且要求区分已证实/未证实', !!d.message && /资源上限/.test(d.message) && /未能证实|未证实/.test(d.message));
}

console.log('\n【题6 资源硬上限（ctx/步数逼顶）→ 立即 finish 且标注资源上限（即使还没到宽限次数）】');
{
  const d = decideGuard(base({ hardCeilingHit: true, checkpointsIssued: 0 }), 'signal');
  ok('kind=finish', d.kind === 'finish', `实际 ${d.kind}`);
  ok('resourceLimited=true', d.resourceLimited === true);
}

console.log('\n【题7 宽限次数演进：0→checkpoint,1→checkpoint,2→finish（单调收敛，不会卡死）】');
{
  const seq = [0, 1, 2].map((n) => decideGuard(base({ checkpointsIssued: n }), 'signal').kind);
  ok('序列 = checkpoint,checkpoint,finish', JSON.stringify(seq) === JSON.stringify(['checkpoint', 'checkpoint', 'finish']), JSON.stringify(seq));
}

console.log(`\n${'='.repeat(56)}`);
console.log(`signal 守卫决策单测：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
