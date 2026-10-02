#!/usr/bin/env python3
"""
qgen-finalize.py — final split of the question set.
  data/qgen/train.jsonl   questions minus the gold sample; D rows from categories the blind check found unreliable
                          ("mistura de línguas", "gíria pesada") get quality="duvidoso" (usually valid requests, not negatives)
  data/qgen/gold/gold.jsonl   gold questions with the blind Opus label (the reference for evaluation)
"""
import json
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
Q = ROOT / 'data/qgen'
gold_ids = set((Q / 'gold/ids.txt').read_text().split())
DOUBT = ('mistura de línguas', 'gíria pesada')
n = {'train': 0, 'duvidoso': 0}
with open(Q / 'train.jsonl', 'w', encoding='utf-8') as f:
    for line in open(Q / 'questions.jsonl', encoding='utf-8'):
        r = json.loads(line)
        if r['id'] in gold_ids: continue
        if r.get('family') == 'D' and any(d in r.get('categoria', '') for d in DOUBT):
            r['quality'] = 'duvidoso'; n['duvidoso'] += 1
        n['train'] += 1
        f.write(json.dumps(r, ensure_ascii=False) + '\n')
gold = {r['gid']: r for r in map(json.loads, open(Q / 'gold/out.jsonl', encoding='utf-8'))}
with open(Q / 'gold/gold.jsonl', 'w', encoding='utf-8') as f:
    for line in open(Q / 'gold/in.jsonl', encoding='utf-8'):
        r = json.loads(line); f.write(json.dumps({**r, 'label': gold[r['gid']]}, ensure_ascii=False) + '\n')
print(n, '| gold:', len(gold))
