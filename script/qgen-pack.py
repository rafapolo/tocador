#!/usr/bin/env python3
"""qgen-pack.py — packs the per-shard retry files (in/<shard>r.jsonl) of each family into a few bigger R* shards."""
import json
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
IN = ROOT / 'data/qgen/in'
SIZE = {'A': 330, 'B': 1000, 'C': 1000, 'D': 1000}
for fam, size in SIZE.items():
    files = sorted(IN.glob(f'{fam}*r.jsonl'))
    rows = [l for f in files for l in open(f, encoding='utf-8') if l.strip()]
    if not rows: continue
    n = (len(rows) + size - 1) // size
    per = (len(rows) + n - 1) // n
    for i in range(n):
        name = f'R{fam}{i+1}'
        (IN / f'{name}.jsonl').write_text(''.join(rows[i * per:(i + 1) * per]), encoding='utf-8')
        print(name, len(rows[i * per:(i + 1) * per]))
    for f in files: f.unlink()
