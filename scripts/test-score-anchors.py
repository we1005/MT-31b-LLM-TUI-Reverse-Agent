#!/usr/bin/env python3
"""score-anchors.py grouped-GT 回归单测（确定性、离线、零模型）。
锁 3 件事:①无 alt_crack_points 时与旧行为一致(向后兼容) ②alt 组能翻 recall(MAX 生效)
③平票归 main(确定性)。跑: python3 scripts/test-score-anchors.py"""
import json, os, subprocess, sys, tempfile

REV = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCORER = os.path.join(REV, 'scripts', 'score-anchors.py')
p = f = 0
def ok(n, c):
    global p, f
    if c: p += 1; print(f'  ✓ {n}')
    else: f += 1; print(f'  ✗ {n}')

def run(bank, outdir):
    outp = os.path.join(outdir, '_r.json')
    subprocess.run([sys.executable, SCORER, bank, outdir, outp], cwd=REV,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
    return {r['id']: r for r in json.load(open(outp, encoding='utf-8'))['rows']}

with tempfile.TemporaryDirectory() as d:
    # 一道题的 agent 输出:命中 alt 组的锚点(SecretGate.check() @ Secret.java:42),不含 main 锚点
    open(os.path.join(d, 'qX.out'), 'w', encoding='utf-8').write(
        '最终结论: 破解点是 SecretGate.check() @ Secret.java:42 恒真 return true。')

    # 1) 无 alt:main 锚点(MainGate.g @ Main.java:10)未命中 → recall 0
    b1 = os.path.join(d, 'b1.json')
    json.dump([{'id': 'qX', 'crack_point': 'MainGate.g() @ Main.java:10 return true',
                'chain': '', 'grade_keywords': ['MainGate', 'Main.java:10']}],
              open(b1, 'w', encoding='utf-8'), ensure_ascii=False)
    r1 = run(b1, d)
    ok('无 alt_crack_points → 只 main 组(向后兼容)', r1['qX']['winning_group'] == 'main')
    ok('无 alt 且 main 未命中 → recall 0', r1['qX']['anchor_recall'] == 0.0)

    # 2) 加 alt 组(命中的 SecretGate):recall 应翻到 >0 且 winning_group=alt1
    b2 = os.path.join(d, 'b2.json')
    json.dump([{'id': 'qX', 'crack_point': 'MainGate.g() @ Main.java:10 return true',
                'chain': '', 'grade_keywords': ['MainGate', 'Main.java:10'],
                'alt_crack_points': [{'crack_point': 'SecretGate.check() @ Secret.java:42 return true',
                                      'grade_keywords': ['SecretGate', 'Secret.java:42']}]}],
              open(b2, 'w', encoding='utf-8'), ensure_ascii=False)
    r2 = run(b2, d)
    ok('alt 组命中 → winning_group=alt1', r2['qX']['winning_group'] == 'alt1')
    ok('alt 组命中 → recall 翻到 >0 (MAX 生效)', (r2['qX']['anchor_recall'] or 0) > 0)
    ok('main 组不变(加 alt 不改 main 的存在)', r2['qX']['anchors_total'] > 0)

    # 3) 平票(main 与 alt 都命中):归 main(确定性、组序靠前)
    open(os.path.join(d, 'qY.out'), 'w', encoding='utf-8').write(
        'MainGate.g() @ Main.java:10 恒真; 也有 SecretGate.check() @ Secret.java:42。')
    b3 = os.path.join(d, 'b3.json')
    json.dump([{'id': 'qY', 'crack_point': 'MainGate.g() @ Main.java:10',
                'chain': '', 'grade_keywords': ['MainGate', 'Main.java:10'],
                'alt_crack_points': [{'crack_point': 'SecretGate.check() @ Secret.java:42',
                                      'grade_keywords': ['SecretGate', 'Secret.java:42']}]}],
              open(b3, 'w', encoding='utf-8'), ensure_ascii=False)
    r3 = run(b3, d)
    ok('平票(两组都命中) → 归 main(确定性)', r3['qY']['winning_group'] == 'main')

print(f"\n{'='*50}\nscore-anchors grouped-GT 单测：{p} 通过 / {f} 失败")
sys.exit(1 if f else 0)
