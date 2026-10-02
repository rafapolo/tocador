#!/usr/bin/env python3
"""qgen-pending.py — recompute what is still unanswered from scratch and repack it into Q* retry shards.
Answered = any id present in data/qgen/out/*.jsonl (merged shards or their .pN parts). Old R*/Q* inputs are
dropped and rebuilt, so the result does not depend on which agent died where."""
import json, re
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
IN, OUT = ROOT / 'data/qgen/in', ROOT / 'data/qgen/out'
answered = set()
for f in OUT.glob('*.jsonl'):
    for l in open(f, encoding='utf-8'):
        try: r = json.loads(l)
        except ValueError: continue
        if 'q' in r or 'qs' in r: answered.add(r['id'])
for f in list(IN.glob('R*.jsonl')) + list(IN.glob('Q*.jsonl')) + list(IN.glob('S*.jsonl')) + list(IN.glob('T*.jsonl')): f.unlink()
pend = {'A': [], 'B': [], 'C': [], 'D': []}
seen = set()
for f in sorted(IN.glob('*.jsonl')):
    if re.fullmatch(r'[ABCD]\d+r', f.stem): f.unlink(); continue      # leftovers of qgen-salvage/pack
    for l in open(f, encoding='utf-8'):
        if not l.strip(): continue
        s = json.loads(l)
        if s['id'] in seen: continue
        seen.add(s['id'])
        if s['id'] not in answered: pend[s['id'][0]].append(l if l.endswith('\n') else l + '\n')
SIZE = {'A': 330, 'B': 1000, 'C': 1000, 'D': 1000}
for fam, rows in pend.items():
    if not rows: continue
    n = (len(rows) + SIZE[fam] - 1) // SIZE[fam]; per = (len(rows) + n - 1) // n
    for i in range(n):
        (IN / f'T{fam}{i+1:02d}.jsonl').write_text(''.join(rows[i*per:(i+1)*per]), encoding='utf-8')
    print(fam, 'pendentes', len(rows), '->', n, 'shards Q', fam)
