/**
 * 顺路发现缓存最小版离线单测（零模型）。锁：①空/空白→空串(flag 开但无笔记=零行为变化)
 * ②短笔记原样进块 ③超预算截断且对齐块边界(不出半截块) ④永远带"未核验/用前重读核对"防盲信措辞。
 * 跑：bun scripts/test-findings.ts
 */
import { renderFindingsBlock } from '../src/findings.ts';

let pass = 0;
let fail = 0;
const ok = (n: string, c: boolean, d = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${d}`); } };

// ① 空/空白 → 空串（关键：flag 开但笔记为空时，拼装与原逻辑逐字节一致 = 零行为变化）
ok('空串 → 空', renderFindingsBlock('') === '');
ok('纯空白 → 空', renderFindingsBlock('   \n\n  \t ') === '');
ok('null/undefined 安全 → 空', renderFindingsBlock(undefined as unknown as string) === '');

// ② 短笔记：原文进块 + 带防盲信措辞
const short = '## [09:30] 发现：sign\n\n硬编码 key "abc" @ Crypto.java:88；native 跳转 nativeSign()。';
const b = renderFindingsBlock(short);
ok('短笔记：原文内容在块里', b.includes('Crypto.java:88') && b.includes('nativeSign()'));
ok('块含"未核验"+低优先级标注', /未核验/.test(b) && /优先级最低|可无视/.test(b));
ok('块含"用前重读核对/绝不照抄"防盲信(防撞反幻觉红线)', /重读/.test(b) && /绝不照抄未核验/.test(b));
ok('块以说明头开头、原文在后(说明不被截断)', b.indexOf('顺路线索') < b.indexOf('Crypto.java:88'));

// ③ 超预算截断 + 对齐块边界（不出半截块）
const blocks = Array.from({ length: 60 }, (_, i) =>
  `## [10:${String(i).padStart(2, '0')}] 块${i}\n\n这是第 ${i} 条发现，包含标识符 ID${i} @ File${i}.java:${100 + i}。填充填充填充填充填充。`,
).join('\n\n');
const big = renderFindingsBlock(blocks, 800);
ok('超预算 → 长度受控(<=预算+说明头余量)', big.length <= 800 + 200);
ok('截断后保留最新块(尾部 ID59 在、最早 ID0 不在)', big.includes('ID59') && !big.includes('块0\n'));
// 对齐：正文部分(去掉说明头)应以 "## " 开头，不出现半截块
const bodyPart = big.slice(big.indexOf('\n') + 1).trim();
ok('截断对齐到块边界(正文以 ## 起,无半截块)', bodyPart.startsWith('## '));

// ④ 未超预算：不截断，全文保留
const full = renderFindingsBlock(short, 4000);
ok('未超预算 → 不截断(全文在)', full.includes('发现：sign') && full.includes('Crypto.java:88'));

console.log(`\n${'='.repeat(50)}\n顺路发现缓存单测：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
