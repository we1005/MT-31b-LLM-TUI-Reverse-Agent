/**
 * 案卷协议纪律离线单测（MVP-2：确保 corpus 协议带"核对而非盲信 + 锚点自检"防错锚点传染的纪律文本）。
 * 纯字符串断言,零模型。跑：bun scripts/test-corpus.ts
 */
import { buildCorpusProtocol, type CorpusManifest } from '../src/corpus.ts';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
};

const mfWith: CorpusManifest = {
  root: '/x', entries: [], counts: {} as never, indexFiles: ['INDEX.md'],
} as unknown as CorpusManifest;
const mfNo: CorpusManifest = {
  root: '/x', entries: [], counts: {} as never, indexFiles: [],
} as unknown as CorpusManifest;

const p = buildCorpusProtocol(mfWith);
const pNo = buildCorpusProtocol(mfNo);

console.log('【案卷协议纪律】');
ok('含"续分析而非重新破案"定位', /接手|续分析|不是重新破案|不是从裸 APK/.test(p));
ok('出处分级(一手/二手/file:line)', /二手/.test(p) && /一手/.test(p) && /file:line/.test(p));
ok('★锚点自检(逐字核对,防错锚点传染)', /锚点自检/.test(p) && /逐字核对/.test(p));
ok('★绝不照抄未核对的锚点', /绝不照抄未.*核对的锚点|照抄一个错锚点/.test(p));
ok('★案卷=待核对线索,非免检事实', /待核对.*线索|不是.*免检/.test(p));
ok('发现案卷有误要明确标出', /案卷此处有误|前人称 X，实读为/.test(p));
ok('跨源三角验证', /三角验证/.test(p));
ok('收尾五类含"与前人矛盾"', /与前人矛盾/.test(p));
ok('无 INDEX 时要求产 INDEX 草稿', /INDEX 草稿/.test(pNo) && !/INDEX 草稿/.test(p));

console.log(`\n案卷协议纪律：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
