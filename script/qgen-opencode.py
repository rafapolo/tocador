#!/usr/bin/env python3
"""
qgen-opencode.py — generate the family-A questions with the opencode CLI instead of Claude subagents.

  python3 script/qgen-opencode.py in/TA01 [--batch 40] [--parallel 4] [--limit N] [--model provider/model]

For each batch of slots it sends data/qgen/prompt-A.md (minus its file instructions) plus the slots inline, asks for
JSONL only, parses the reply, keeps the lines whose id was asked for, and appends them to out/<shard>.jsonl.
Re-running skips ids already in that file. Validation/dedup is left to qgen-check.py.
"""
import argparse, json, re, subprocess, sys, concurrent.futures as cf
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
Q = ROOT / 'data/qgen'
MODEL = 'opencode/space-bunny-free'   # 6/6 in 15 s; muse-spark 12-item batches never finished, mimo/nemotron-lightning timed out

def build_prompt(slots):
    base = (Q / 'prompt-A.md').read_text(encoding='utf-8')
    base = base.split('SAÍDA:')[0]
    base = re.sub(r'Substitua \{SHARD\}.*?\n', '', base)
    data = '\n'.join(json.dumps(s, ensure_ascii=False) for s in slots)
    return (base + '\nFAIXAS (uma por linha, JSON):\n' + data +
            '\n\nResponda SOMENTE com as linhas de saída, uma por faixa, na mesma ordem, no formato '
            '{"id":"<id>","qs":["...","...","..."]}. Nenhum texto antes ou depois, nenhum markdown, nenhum bloco de código. '
            'Não use ferramentas nem leia arquivos.')

def run_batch(slots, model, tries=3):
    ids = {s['id'] for s in slots}
    got, err = {}, ''
    for attempt in range(tries):
        try:
            p = subprocess.run(['opencode', 'run', '-m', model, build_prompt(slots)], cwd=ROOT,
                               capture_output=True, text=True, timeout=240)   # a hung call is retried, not waited for
        except subprocess.TimeoutExpired:
            err = f'timeout (try {attempt + 1})'; continue
        for line in p.stdout.splitlines():
            line = line.strip().strip('`')
            if not line.startswith('{'): continue
            try: r = json.loads(line)
            except ValueError: continue
            if r.get('id') in ids and isinstance(r.get('qs'), list) and len(r['qs']) == 3 and all(isinstance(q, str) for q in r['qs']):
                got[r['id']] = r
        if len(got) >= len(ids) * 0.8: break          # good enough; the rest is picked up by the next run
        err = p.stderr[-200:]
    return got, err

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('shard'); ap.add_argument('--batch', type=int, default=8); ap.add_argument('--parallel', type=int, default=6)
    ap.add_argument('--limit', type=int); ap.add_argument('--model', default=MODEL)
    a = ap.parse_args()
    name = Path(a.shard).stem
    slots = [json.loads(l) for l in open(Q / 'in' / f'{name}.jsonl', encoding='utf-8') if l.strip()]
    out = Q / 'out' / f'{name}.jsonl'
    done = {json.loads(l)['id'] for l in open(out, encoding='utf-8')} if out.exists() else set()
    todo = [s for s in slots if s['id'] not in done][:a.limit]
    batches = [todo[i:i + a.batch] for i in range(0, len(todo), a.batch)]
    print(f'{name}: {len(slots)} slots, {len(done)} done, {len(todo)} to do in {len(batches)} batches', file=sys.stderr)
    with cf.ThreadPoolExecutor(a.parallel) as ex, open(out, 'a', encoding='utf-8') as f:
        for n, (got, err) in enumerate(ex.map(lambda b: run_batch(b, a.model), batches), 1):
            for r in got.values(): f.write(json.dumps(r, ensure_ascii=False) + '\n')
            f.flush()
            print(f'  batch {n}/{len(batches)}: {len(got)}/{len(batches[n-1])} ok {err}', file=sys.stderr)

main()
