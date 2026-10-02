#!/usr/bin/env python3
"""
qgen-check.py — validates what the subagents wrote (data/qgen/out/<shard>.jsonl) against the slots they were
given (data/qgen/in/<shard>.jsonl), and with --merge writes data/qgen/questions.jsonl joined to labels.jsonl.

  python3 script/qgen-check.py             # report per shard + totals
  python3 script/qgen-check.py --merge     # also write the merged dataset (only valid, deduplicated questions)
"""
import json, re, sys, unicodedata, collections
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IN, OUT = ROOT / 'data/qgen/in', ROOT / 'data/qgen/out'
LEAK = re.compile(r'\b(bpm|pedido_estruturado|discogs|percentual|%|json|features?)\b', re.I)

def fold(s): return re.sub(r'\s+', ' ', unicodedata.normalize('NFD', s.lower()).encode('ascii', 'ignore').decode()).strip()

def read(path):
    rows = []
    for line in open(path, encoding='utf-8'):
        if line.strip():
            try: rows.append(json.loads(line))
            except ValueError: rows.append(None)
    return rows

labels = {}
lp = ROOT / 'data/qgen/labels.jsonl'
if lp.exists():
    for line in open(lp, encoding='utf-8'):
        r = json.loads(line); labels[r['id']] = r

SLOTS = {}
for _f in sorted(IN.glob('*.jsonl')):
    for _r in read(_f):
        if _r: SLOTS.setdefault(_r['id'], _r)

def check(shard):
    slots = {r['id']: SLOTS[r['id']] for r in (read(OUT / f'{shard}.jsonl') if (OUT / f'{shard}.jsonl').exists() else []) if r and r.get('id') in SLOTS}
    out_path = OUT / f'{shard}.jsonl'
    if not out_path.exists(): return None
    rows = read(out_path)
    issues = collections.Counter(); good = []
    seen = set()
    for r in rows:
        if r is None: issues['json inválido'] += 1; continue
        id_ = r.get('id')
        if id_ not in slots: issues['id desconhecido'] += 1; continue
        if id_ in seen: issues['id repetido'] += 1; continue
        seen.add(id_)
        qs = r.get('qs') if 'qs' in r else [r.get('q')]
        if not isinstance(qs, list) or ('qs' in r and len(qs) != 3) or not all(isinstance(q, str) for q in qs):
            issues['formato'] += 1; continue
        ok = []
        for q in qs:
            q = q.strip()
            if not (2 <= len(q) <= 320): issues['tamanho'] += 1; continue
            if LEAK.search(q): issues['vazamento de rótulo/jargão'] += 1; continue
            if 'qs' in r:
                title = fold(slots[id_]['faixa'])
                if len(title) >= 8 and title in fold(q): issues['título exato citado'] += 1; continue
            ok.append(q)
        if labels.get(id_, {}).get('invalid'): issues['rótulo inválido (descartado)'] += 1; continue
        if ok: good.append((id_, ok))
    return {'slots': len(slots), 'rows': len(rows), 'good': good, 'issues': issues}

def main():
    merge = '--merge' in sys.argv
    shards = sorted(p.stem for p in OUT.glob('*.jsonl') if not re.search(r'\.p\d$', p.stem))
    total, fam, dup = 0, collections.Counter(), 0
    seen_q, merged = set(), []
    for sh in shards:
        r = check(sh)
        if r is None: print(f'{sh:5} —  (sem saída)'); continue
        n = sum(len(q) for _, q in r['good'])
        print(f"{sh:5} slots {r['slots']:5}  perguntas válidas {n:5}  {dict(r['issues']) or ''}")
        for id_, qs in r['good']:
            for q in qs:
                k = fold(q)
                if k in seen_q: dup += 1; continue
                seen_q.add(k); total += 1; fam[sh[0]] += 1
                merged.append({'id': id_, 'q': q, **{k2: v for k2, v in labels.get(id_, {}).items() if k2 != 'id'}})
    print(f'\ntotal único: {total}  por família: {dict(fam)}  duplicadas descartadas: {dup}')
    if merge:
        with open(ROOT / 'data/qgen/questions.jsonl', 'w', encoding='utf-8') as f:
            for m in merged: f.write(json.dumps(m, ensure_ascii=False) + '\n')
        print('escrito data/qgen/questions.jsonl')

main()
