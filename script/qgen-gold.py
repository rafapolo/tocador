#!/usr/bin/env python3
"""
qgen-gold.py — draws the gold-set sample (300 questions, stratified by family) from data/qgen/questions.jsonl.
Writes data/qgen/gold/in.jsonl with ONLY {id, q}: whoever labels it must not see how the question was generated.
The sample is removed from training by `--exclude-list` consumers (ids go to data/qgen/gold/ids.txt).
"""
import json, random
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
rows = [json.loads(l) for l in open(ROOT / 'data/qgen/questions.jsonl', encoding='utf-8')]
rnd = random.Random(300)
by = {}
for r in rows: by.setdefault(r['family'], []).append(r)
QUOTA = {'A': 120, 'B': 80, 'C': 50, 'D': 50}
pick = []
for fam, n in QUOTA.items(): pick += rnd.sample(by[fam], n)
rnd.shuffle(pick)
(ROOT / 'data/qgen/gold').mkdir(parents=True, exist_ok=True)
with open(ROOT / 'data/qgen/gold/in.jsonl', 'w', encoding='utf-8') as f:
    for i, r in enumerate(pick, 1): f.write(json.dumps({'gid': f'G{i:03d}', 'q': r['q']}, ensure_ascii=False) + '\n')
with open(ROOT / 'data/qgen/gold/key.jsonl', 'w', encoding='utf-8') as f:     # gid -> source labels, for the comparison only
    for i, r in enumerate(pick, 1): f.write(json.dumps({'gid': f'G{i:03d}', **r}, ensure_ascii=False) + '\n')
(ROOT / 'data/qgen/gold/ids.txt').write_text('\n'.join(r['id'] for r in pick) + '\n')
print(len(pick), 'perguntas ->', ROOT / 'data/qgen/gold/in.jsonl')
