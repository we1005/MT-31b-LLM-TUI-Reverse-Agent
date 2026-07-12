/**
 * 云端顾问·真实端到端集成测试（把顾问后端指向本地 lemonade：串行、零外部出网，安全自测全链路）。
 * 验证：困境报告 → redact(脱敏) → onEgress(出境预览) → 真实 LLM generateText → restore(占位符还原) → 思路。
 * 铁律：只发一次 LLM 调用，串行，不与主 agent 并发（lemonade 单并发）。
 * 跑：bun scripts/test-advisor-local.ts
 */
import { createCloudAdvisor, type AdvisorEvent } from '../src/advisor.ts';
import type { LedgerSnapshot } from '../src/redact.ts';

const LEDGER: LedgerSnapshot = {
  goal: '分析 com.snaptube.premium 的 VIP 校验逻辑，定位 checkVip 短路点',
  hops: [
    { from: 'C7671.onCreate', to: 'C11960.checkVip', evidence: 'C7671.java:142' },
    { from: 'C11960.checkVip', to: 'AbstractC3962.isPremium', evidence: 'C11960.java:88' },
  ],
  reads: [
    { path: 'work/mt-jadx/sources/com/snaptube/premium/C7671.java' },
    { path: 'work/mt-jadx/sources/com/snaptube/premium/C11960.java' },
  ],
  greps: [
    { pattern: 'checkVip', path: '.' },
    { pattern: 'isPremium', path: '.' },
  ],
};

const REPORT = `## 🆘 rev-agent 卡住了 — 求助·困境报告
**卡住原因**：连续 3 步无新进展(原地打转)
**目标**：分析 com.snaptube.premium 的 VIP 校验逻辑，定位 checkVip 短路点
**已确认链路跳（2 跳）**：
C7671.onCreate → C11960.checkVip | 证据 /Volumes/zhitai-7100/reverse-agent/work/mt-jadx/sources/com/snaptube/premium/C7671.java:142
C11960.checkVip → AbstractC3962.isPremium | 证据 C11960.java:88
**我卡在哪**：追到 AbstractC3962.isPremium 后，isPremium 的实现看不出布尔来源，继续 grep isPremium 只是原地打转。
配置里还有回调 https://api.snaptube.app/v1/verify 和服务器 192.168.9.101:13305。
**需要的帮助**：下一步该怎么查？`;

let capturedClean = '';
const events: AdvisorEvent[] = [];

// 后端可用环境变量覆盖：默认本地 lemonade(串行零外泄)；ADVISOR_BACKEND=volcengine 则真打外部云端。
const backend = (process.env['ADVISOR_BACKEND'] ?? 'lemonade') as never;
const advisorModel = process.env['ADVISOR_MODEL'] || undefined;
const isCloud = backend !== 'lemonade' && backend !== 'local';

const advisor = createCloudAdvisor({
  backend,
  model: advisorModel,
  level: 2,
  getLedger: () => LEDGER,
  timeoutMs: 180_000,
  onEgress: ({ clean }) => {
    capturedClean = clean;
    return true;
  },
  onEvent: (ev) => {
    events.push(ev);
    console.error(`  [event] ${JSON.stringify(ev)}`);
  },
});

console.log(
  `=== 云端顾问真实端到端(顾问=${backend}${advisorModel ? '/' + advisorModel : ''}${isCloud ? ' ☁️真实外部云端' : ' 本地串行零外泄'}) ===`,
);
console.log('调用顾问中(困境报告 → 脱敏 → 真实 LLM → 还原思路)…\n');

const t0 = Date.now();
const advice = await advisor(REPORT);
const dt = ((Date.now() - t0) / 1000).toFixed(1);

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

console.log(`\n【出境防火墙检查(clean payload——真正发给 LLM 的内容)】`);
console.log('  clean 预览:', capturedClean.replace(/\s+/g, ' ').slice(0, 240), '…\n');
ok('onEgress 捕获到 clean payload', capturedClean.length > 0);
ok('clean 无明文包名 com.snaptube.premium', !capturedClean.includes('com.snaptube.premium'));
ok('clean 无明文 URL', !capturedClean.includes('api.snaptube.app'));
ok('clean 无明文 IP', !capturedClean.includes('192.168.9.101'));
ok('clean 无明文绝对路径', !capturedClean.includes('/Volumes/zhitai-7100'));
ok(
  'clean 无明文混淆类名 C7671/C11960',
  !capturedClean.includes('C7671') && !capturedClean.includes('C11960'),
);
ok('clean 保留占位符结构(云端仍能引用)', /<(CLS|PKG|PATH|SYM|URL|IP)_\d+>/.test(capturedClean));

console.log(`\n【全链路结果(耗时 ${dt}s)】`);
ok(
  '拿到非空思路(端到端通)',
  !!advice && advice.trim().length > 0,
  `advice=${advice === null ? 'null' : `"${(advice ?? '').slice(0, 60)}"`}`,
);
ok(
  '触发了 redacted 事件',
  events.some((e) => e.type === 'redacted'),
);
ok(
  '触发了 consulting 事件',
  events.some((e) => e.type === 'consulting'),
);
if (advice) {
  // restore 应把占位符还原成真值（若云端引用了某占位符）——检查思路里是否出现被还原的真实标识符，
  // 或至少不残留任何未还原占位符。
  const hasLeftoverToken = /<(CLS|PKG|PATH|SYM|KEY|URL|IP|EMAIL|RES)_\d+>/.test(advice);
  ok('思路里无残留未还原占位符', !hasLeftoverToken, hasLeftoverToken ? '(还原不全)' : '');
  const restoredReal = ['C7671', 'C11960', 'checkVip', 'isPremium', 'com.snaptube.premium'].filter((s) =>
    advice.includes(s),
  );
  console.log(
    `  (还原回思路里的真实标识符: ${restoredReal.length ? restoredReal.join(', ') : '无——云端可能未引用具体占位符,属正常'})`,
  );
  console.log(`\n【云端还原后的完整思路】\n${advice}\n`);
}

console.log(`${'='.repeat(60)}`);
console.log(`顾问端到端：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
