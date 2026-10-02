#!/usr/bin/env python3
"""
qgen-salvage.py — after agents die half-way: merge whatever valid parts a shard has (data/qgen/out/<shard>.p*.jsonl)
into <shard>.jsonl, and write the slots still without an answer to data/qgen/in/<shard>r.jsonl (retry shard).
Idempotent: a shard that already has <shard>.jsonl complete is left alone.
"""
import json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
IN, OUT = ROOT / 'data/qgen/in', ROOT / 'data/qgen/out'
made = []
# slots already handed to a packed retry shard (R*) must not be re-queued
covered = set()
for rp in IN.glob('R*.jsonl'):
    covered |= {json.loads(l)['id'] for l in open(rp, encoding='utf-8') if l.strip()}
for inp in sorted(IN.glob('*.jsonl')):
    shard = inp.stem
    if shard.endswith('r') or shard.startswith('R'): continue          # retry shards are handled as their own
    slots = [json.loads(l) for l in open(inp, encoding='utf-8') if l.strip()]
    ids = {s['id'] for s in slots}
    parts = sorted(OUT.glob(f'{shard}.p?.jsonl'))
    have, lines = set(), []
    for src in ([OUT / f'{shard}.jsonl'] if (OUT / f'{shard}.jsonl').exists() else parts):
        for l in open(src, encoding='utf-8'):
            try: r = json.loads(l)
            except ValueError: continue
            if r.get('id') in ids and r['id'] not in have and ('q' in r or 'qs' in r):
                have.add(r['id']); lines.append(l if l.endswith('\n') else l + '\n')
    if not lines: continue
    (OUT / f'{shard}.jsonl').write_text(''.join(lines), encoding='utf-8')
    missing = [s for s in slots if s['id'] not in have and s['id'] not in covered]
    if missing:
        with open(IN / f'{shard}r.jsonl', 'w', encoding='utf-8') as f:
            for s in missing: f.write(json.dumps(s, ensure_ascii=False) + '\n')
        made.append((shard, len(have), len(missing)))
    else:
        (IN / f'{shard}r.jsonl').unlink(missing_ok=True)
        made.append((shard, len(have), 0))
for s, h, m in made: print(f'{s:4} salvos {h:4}  faltam {m:4}' + (f'  -> in/{s}r.jsonl' if m else ''))
