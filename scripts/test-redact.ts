/**
 * 脱敏防火墙验收题库（≥5 道，确定性、离线、不依赖 lemonade/云端）。
 * 验证「遇到解决不了的问题→隐藏敏感信息→问云端」这条链里**最关键的安全收口**。
 * 跑：bun scripts/test-redact.ts   （全绿 exit 0，任一 fail exit 1）
 *
 * 题目设计对齐 实现方案.md §10「测不足」：泄露门 / 还原门 / 一致性 / 分级 / 正则兜底 / fail-closed / 台账汇出。
 */
import { knownIdentifiersFromLedger, leakScan, redact, restore, type LedgerSnapshot } from '../src/redact.ts';

let passed = 0;
let failed = 0;
const fails: string[] = [];
function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    fails.push(name);
    console.log(`  ✗ ${name}  ${detail}`);
  }
}
function section(t: string) {
  console.log(`\n【${t}】`);
}

// 一份贴近 buildStuckReport 真实形状的困境报告样本（含各类敏感）
const SAMPLE_REPORT = `## 🆘 rev-agent 卡住了 — 求助·困境报告
**卡住原因**：连续 3 步无新进展(原地打转)
**目标**：分析 com.snaptube.premium 的 VIP 校验逻辑，定位 checkVip 短路点
**已走**：7 步，工具调用 12 次，真实上下文 ~8000 tok
**已确认链路跳（2 跳，交叉核验 1）**：
C7671.onCreate → C11960.checkVip
C11960.checkVip → AbstractC3962.isPremium
**调查足迹（已读类 / 已搜 pattern）**：
目标: 分析 com.snaptube.premium 的 VIP 校验逻辑
已确认链路跳(2):
  C7671.onCreate → C11960.checkVip | 证据 /Volumes/zhitai-7100/reverse-agent/work/mt-jadx/sources/com/snaptube/premium/C7671.java:142 ✓
已读类(3): work/mt-jadx/sources/com/snaptube/premium/C7671.java(1段), work/mt-jadx/sources/com/snaptube/premium/C11960.java(2段)
已搜(4): "checkVip"→3, "loadUrl"→1
配置里有个 license key: aGVsbG9Xb3JsZFNlY3JldEtleTEyMzQ1Njc4OTA= 和回调 https://api.snaptube.app/v1/verify?token=abc
联系人 dev@snaptube.example 服务器 192.168.9.101:13305`;

// ————————————————————— 题 1：泄露门（level 2 最严，fail-closed 必过）—————————————————————
section('题1 泄露门：level 2 脱敏后不得残留真实敏感（URL/IP/email/key/绝对路径/包名）');
{
  const ledger: LedgerSnapshot = {
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
      { pattern: 'loadUrl', path: '.' },
    ],
  };
  const known = knownIdentifiersFromLedger(ledger);
  const { clean, map, leaks } = redact(SAMPLE_REPORT, { level: 2, knownIdentifiers: known });
  ok('fail-closed leaks 为空', leaks.length === 0, `leaks=${JSON.stringify(leaks)}`);
  ok('无明文包名 com.snaptube.premium', !clean.includes('com.snaptube.premium'));
  ok('无明文 URL', !clean.includes('https://api.snaptube.app'));
  ok('无明文 email', !clean.includes('dev@snaptube.example'));
  ok('无明文 IP', !clean.includes('192.168.9.101'));
  ok('无明文 license key', !clean.includes('aGVsbG9Xb3JsZFNlY3JldEtleTEyMzQ1Njc4OTA='));
  ok('无明文绝对路径', !clean.includes('/Volumes/zhitai-7100'));
  ok('无明文混淆类名 C7671', !clean.includes('C7671'));
  ok('无明文类名 AbstractC3962', !clean.includes('AbstractC3962'));
  // 抽象结构应保留（占位符存在 = 云端仍能看到"有几个类几跳"）
  ok('保留了占位符结构(<CLS_/<PKG_/<PATH_/<KEY_ 等)', /<(CLS|PKG|PATH|KEY|URL|IP|EMAIL)_\d+>/.test(clean));
  console.log('    clean 预览:', clean.replace(/\n/g, ' ').slice(0, 200), '…');
}

// ————————————————————— 题 2：还原门 —————————————————————
section('题2 还原门：restore 把云端回复里的占位符 100% 还原、不误伤普通文本');
{
  const ledger: LedgerSnapshot = {
    goal: '定位 checkVip',
    hops: [{ from: 'C7671.onCreate', to: 'C11960.checkVip', evidence: 'C7671.java:142' }],
    reads: [{ path: 'work/mt-jadx/sources/com/snaptube/premium/C7671.java' }],
    greps: [{ pattern: 'checkVip', path: '.' }],
  };
  const known = knownIdentifiersFromLedger(ledger);
  const { clean, map } = redact(SAMPLE_REPORT, { level: 1, knownIdentifiers: known });
  // 找出 clean 里出现的一个 CLS 占位符，模拟云端引用它给思路
  const tok = clean.match(/<CLS_\d+>/)?.[0] ?? clean.match(/<PKG_\d+>/)?.[0] ?? '<CLS_1>';
  const cloudReply = `建议：读 ${tok} 的方法体，确认它是否恒返回 true；这是常见的短路套路。与普通文字无关的 token 不要动。`;
  const restored = restore(cloudReply, map);
  const real = map.toReal.get(tok)!;
  ok('占位符被还原成真值', restored.includes(real), `real=${real}`);
  ok('还原后无残留占位符', !/<(CLS|PKG|PATH|SYM|KEY|URL|IP)_\d+>/.test(restored));
  ok('普通文本未被误改', restored.includes('这是常见的短路套路'));
}

// ————————————————————— 题 3：一致性（同真值→同占位符）—————————————————————
section('题3 一致性：同一真值在报告里多处出现 → 映射到同一占位符（云端能连贯引用）');
{
  const text = 'C11960.checkVip 调用了 isPremium；再看 C11960.checkVip 的返回；C11960 是关键类。';
  const known = ['C11960.checkVip', 'C11960', 'isPremium'];
  const { clean, map } = redact(text, { level: 1, knownIdentifiers: known });
  const tokFor = map.toToken.get('C11960.checkVip');
  ok('C11960.checkVip 有占位符', !!tokFor);
  const count = tokFor ? clean.split(tokFor).length - 1 : 0;
  ok('两处 C11960.checkVip 用了同一占位符(出现2次)', count === 2, `count=${count} clean="${clean}"`);
  ok(
    'C11960.checkVip 与裸 C11960 是不同占位符',
    map.toToken.get('C11960.checkVip') !== map.toToken.get('C11960'),
  );
}

// ————————————————————— 题 4：分级差异（level 0 留类名 / level 1 脱类名）—————————————————————
section('题4 分级：level 0 保留裸类名/包名(利思路可落地)，level 1 连它们一起脱');
{
  const text = '在 com.snaptube.premium.C7671 的 checkVip 里，访问了 https://x.example/a';
  const known = knownIdentifiersFromLedger({
    goal: '',
    hops: [{ from: 'C7671', to: 'checkVip' }],
    reads: [{ path: 'work/mt-jadx/sources/com/snaptube/premium/C7671.java' }],
    greps: [{ pattern: 'checkVip', path: '.' }],
  });
  const r0 = redact(text, { level: 0, knownIdentifiers: known });
  const r1 = redact(text, { level: 1, knownIdentifiers: known });
  ok('level0 脱掉了 URL', !r0.clean.includes('https://x.example'));
  ok(
    'level0 保留了包名 com.snaptube.premium',
    r0.clean.includes('com.snaptube.premium'),
    `clean="${r0.clean}"`,
  );
  ok('level1 脱掉了包名', !r1.clean.includes('com.snaptube.premium'), `clean="${r1.clean}"`);
  ok('level0 与 level1 结果不同', r0.clean !== r1.clean);
}

// ————————————————————— 题 5：正则兜底（台账清单之外的内嵌 key/URL 也要脱）—————————————————————
section('题5 正则兜底：ledger 里没有的内嵌 URL/IP/email/key/绝对路径也必须脱掉');
{
  // knownIdentifiers 故意为空 → 只能靠正则兜底
  const text =
    'token=sk-AbC123XyZ987QwErTyUiOpAsDf 端点 http://10.0.0.5:8080/api 邮箱 a@b.co 路径 /Users/foo/secret/App.java';
  const { clean, leaks } = redact(text, { level: 2, knownIdentifiers: [] });
  ok('无明文高熵 key', !clean.includes('sk-AbC123XyZ987QwErTyUiOpAsDf'), `clean="${clean}"`);
  ok('无明文 URL/IP', !clean.includes('10.0.0.5') && !clean.includes('http://'));
  ok('无明文 email', !clean.includes('a@b.co'));
  ok('无明文绝对路径', !clean.includes('/Users/foo/secret'));
  ok('fail-closed leaks 为空', leaks.length === 0, `leaks=${JSON.stringify(leaks)}`);
}

// ————————————————————— 题 6：fail-closed 探测本身有效（漏网时 leaks 非空）—————————————————————
section('题6 fail-closed 有效性：若 clean 里真残留敏感，leakScan 必须报出来（否则收口失灵）');
{
  const dirty = '这里漏了一个 https://leak.example/x 和 IP 8.8.8.8 还有包名 com.evil.pkg';
  const l2 = leakScan(dirty, 2);
  const l0 = leakScan(dirty, 0);
  ok('level2 扫描报出 URL/IP/包名泄露', l2.length >= 2 && l2.some((x) => x.includes('leak.example')));
  ok(
    'level0 扫描报出 URL/IP（但不报包名——level0 允许留包名）',
    l0.some((x) => x.includes('leak.example')) && !l0.includes('com.evil.pkg'),
  );
}

// ————————————————————— 题 7：restore 容错（云端把占位符加了空格/HTML 转义）—————————————————————
section('题7 restore 容错：云端把 <CLS_1> 写成 "< CLS_1 >" 或 "&lt;CLS_1&gt;" 也能还原');
{
  const { map } = redact('C7671.onCreate 调用 checkVip', {
    level: 1,
    knownIdentifiers: ['C7671.onCreate', 'checkVip'],
  });
  const tok = map.toToken.get('C7671.onCreate')!;
  const inner = tok.slice(1, -1);
  const reply = `读 < ${inner} > 和 &lt;${inner}&gt; 两处。`;
  const restored = restore(reply, map);
  const occ = restored.split('C7671.onCreate').length - 1;
  ok('带空格/HTML转义的占位符都被还原', occ === 2, `occ=${occ} restored="${restored}"`);
  // 兜底：云端把尖括号丢了(裸 id) / 揉进相邻括号(<inner:...>) 也要还原（真实端到端里 Qwen 就这么干过）
  const reply2 = `以 ${inner} 为锚点，另见 <${inner}:xxx> 处。`;
  const restored2 = restore(reply2, map);
  ok(
    '裸 id + 被揉坏的占位符也被还原',
    !restored2.includes(inner) && restored2.includes('C7671.onCreate'),
    `restored2="${restored2}"`,
  );
}

// ————————————————————— 题 9：CLS_1 不吃 CLS_10（长 token 先还原）—————————————————————
section('题9 还原不串号：CLS_1 的裸兜底不能吃掉 CLS_10');
{
  const map = { toReal: new Map<string, string>(), toToken: new Map<string, string>() };
  map.toReal.set('<CLS_1>', 'Alpha');
  map.toReal.set('<CLS_10>', 'Beta');
  const restored = restore('先 CLS_10 再 CLS_1', map as never);
  ok('CLS_10→Beta 正确', restored.includes('Beta'));
  ok(
    'CLS_1→Alpha 正确且未把 CLS_10 拆坏',
    restored.includes('Alpha') && !restored.includes('Alpha0'),
    `restored="${restored}"`,
  );
}

// ————————————————————— 题 8：台账汇出不产生"通用词垃圾"（过度脱敏防线）—————————————————————
section('题8 台账汇出质量：不把 java/com/get 等通用短词纳入清单（否则过度脱敏毁可读性）');
{
  const known = knownIdentifiersFromLedger({
    goal: '',
    hops: [{ from: 'C7671.get', to: 'Bar.set' }],
    reads: [{ path: 'work/x/sources/com/foo/Bar.java' }],
    greps: [{ pattern: 'get', path: '.' }],
  });
  ok('不含裸 "java"', !known.includes('java'));
  ok('不含裸 "com"', !known.includes('com'));
  ok('不含裸 "get"（<4且小写）', !known.includes('get'));
  ok('含 FQCN com.foo.Bar', known.includes('com.foo.Bar'), `known=${JSON.stringify(known)}`);
  ok('含类名 Bar', known.includes('Bar'));
  ok('含点分名 C7671.get', known.includes('C7671.get'));
}

// ————————————————————— 汇总 —————————————————————
console.log(`\n${'='.repeat(60)}`);
console.log(`脱敏防火墙题库：${passed} 通过 / ${failed} 失败`);
if (failed) {
  console.log('失败项：', fails.join(', '));
  process.exit(1);
}
console.log('✅ 全部通过');
