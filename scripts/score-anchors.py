#!/usr/bin/env python3
"""
机械锚点判分器（确定性、离线、不需强模型）—— 记忆系统消融实验的可量化指标基石。

思路（红队 topFix #1）：rubric 主观分需要强模型、单并发离线跑不了；改用确定性判分——
从每题的 ground-truth 里抽出「证据锚点」(file:line + 关键类/方法标识符)，数它们在 agent
实际输出(.out)里的命中率(recall)。绝对值有噪声，但**相对 Δ 可复现、可比**——这正是
消融实验(开/关某机制看 Δ)需要的性质。

用法:
  python3 score-anchors.py <bank.json> <results_dir> [out_summary.json]
  # bank 支持 bank-crack*.json(crack_point/chain/grade_keywords) 与 bank-multi.json(problems[].ground_truth/evidence/grading_regex)
"""
import json, os, re, sys

# file:line 锚点：如 Inventory$PowerUp.java:415 / SpecialInfoUtil.java:957 / UserCache.java:151 / op4.java:71
RE_FILELINE = re.compile(r'[\w$./-]+\.(?:java|kt|smali|so|dat|dex|json|bundle)(?::\d+(?:-\d+)?)?', re.I)
# 关键标识符：驼峰/含$的类名、方法名(带括号)、defpackage 短名
RE_METHOD = re.compile(r'\b[a-zA-Z_]\w*\(\)')
RE_CLASSISH = re.compile(r'\b[A-Za-z]\w*\$[A-Za-z]\w*\b|\b[A-Z]\w{2,}[A-Z]\w+\b')  # Inventory$PowerUp / SpecialInfoUtil

def norm(s: str) -> str:
    return re.sub(r'\s+', '', s or '').lower()

def extract_anchors(*texts: str) -> set:
    """从 GT 文本抽证据锚点集合(去重、归一化)。"""
    anchors = set()
    blob = '\n'.join(t for t in texts if t)
    for m in RE_FILELINE.findall(blob):
        anchors.add(norm(m))
    for m in RE_METHOD.findall(blob):
        anchors.add(norm(m))
    for m in RE_CLASSISH.findall(blob):
        if len(m) >= 5:
            anchors.add(norm(m))
    # 过滤太泛的(纯扩展名/过短)
    return {a for a in anchors if len(a) >= 5}

def load_bank(path: str):
    d = json.load(open(path, encoding='utf-8'))
    if isinstance(d, dict) and 'problems' in d:  # bank-multi
        for q in d['problems']:
            yield {
                'id': q['id'],
                'gt_texts': [q.get('ground_truth', ''), q.get('evidence', '') if isinstance(q.get('evidence'), str) else json.dumps(q.get('evidence', ''), ensure_ascii=False)],
                'regex': q.get('grading_regex'),
            }
    else:  # bank-crack*
        arr = d if isinstance(d, list) else d.get('questions', [])
        for q in arr:
            yield {
                'id': q['id'],
                'gt_texts': [q.get('crack_point', ''), q.get('chain', ''), ' '.join(q.get('grade_keywords', []))],
                'regex': None,
            }

def main():
    bank_path, results_dir = sys.argv[1], sys.argv[2]
    out_path = sys.argv[3] if len(sys.argv) > 3 else os.path.join(results_dir, '_anchors.json')
    rows = []
    for q in load_bank(bank_path):
        qid = q['id']
        outp = os.path.join(results_dir, f'{qid}.out')
        ans = open(outp, encoding='utf-8', errors='replace').read() if os.path.exists(outp) else ''
        ans_n = norm(ans)
        anchors = extract_anchors(*q['gt_texts'])
        hits = [a for a in anchors if a in ans_n]
        recall = round(len(hits) / len(anchors), 3) if anchors else None
        regex_hit = bool(re.search(q['regex'], ans)) if q['regex'] else None
        rows.append({
            'id': qid,
            'anchors_total': len(anchors),
            'anchors_hit': len(hits),
            'anchor_recall': recall,
            'regex_hit': regex_hit,
            'has_output': bool(ans),
            'missed': sorted(anchors - set(hits))[:8],
        })
    scored = [r for r in rows if r['anchor_recall'] is not None and r['anchors_total'] > 0]
    mean_recall = round(sum(r['anchor_recall'] for r in scored) / len(scored), 3) if scored else 0.0
    summary = {'bank': os.path.basename(bank_path), 'results': os.path.basename(results_dir.rstrip('/')),
               'n': len(rows), 'n_scored': len(scored), 'mean_anchor_recall': mean_recall, 'rows': rows}
    json.dump(summary, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    print(f"bank={summary['bank']} results={summary['results']}  n={len(rows)} scored={len(scored)}  平均锚点召回={mean_recall}")
    for r in rows:
        rc = f"{r['anchor_recall']:.2f}" if r['anchor_recall'] is not None else '  - '
        print(f"  [{r['id']:38}] recall={rc} ({r['anchors_hit']}/{r['anchors_total']}) {'out✓' if r['has_output'] else 'NO-OUT'}")
    print(f"\n写入 {out_path}")

if __name__ == '__main__':
    main()
