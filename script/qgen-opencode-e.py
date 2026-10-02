#!/usr/bin/env python3
"""
qgen-opencode-e.py — family E (real-user register) with the opencode CLI instead of Claude subagents.

  python3 script/qgen-opencode-e.py --make 6000         # writes data/qgen/in/E01..E0N.jsonl (1000 slots each)
  python3 script/qgen-opencode-e.py E01 [--batch 8] [--parallel 6] [--limit N] [--model provider/model]

Slots carry a style category and a topic so the free model does not collapse into one template. The prompt is
data/qgen/prompt-E.md with data/qgen/real/semente.jsonl inlined. Output: out/<shard>.jsonl, one {"id","q"} per line,
resumable (ids already there are skipped). Validation/dedup is qgen-check.py's job.
"""
import argparse, json, random, re, subprocess, sys, concurrent.futures as cf
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
Q = ROOT / 'data/qgen'
MODEL = 'opencode/space-bunny-free'

# (weight, category)
CATS = [
    (14, 'busca elíptica de gênero/época, sem acento, sem pontuação (ex.: "samba lento anos 60")'),
    (12, 'busca com abreviações de internet (q, pf, vc, ta, ai, btn, tb, blz)'),
    (11, 'busca com erros de digitação (letras trocadas, faltando ou duplicadas, teclas vizinhas)'),
    (8,  'mistura de português e inglês numa busca de música'),
    (9,  'comando solto do player de uma ou duas palavras (pause, resume, proxima, volta, pula essa, toca)'),
    (8,  'pedido de status ou andamento de uma tarefa (eta?, rodando?, quanto falta, terminou) — nada a ver com música'),
    (8,  'pergunta sobre o próprio chat ou o acervo (quantos albuns tem, como funciona, o que vc faz)'),
    (8,  'pedido referencial elíptico (mais lento q essa, tipo cartola, outro assim, parecido com o anterior)'),
    (7,  'pergunta de gosto ou ocasião informal (algo pra dormir, q albuns seriam ritmo de sao joao??)'),
    (7,  'só uma ou duas palavras soltas: artista, gênero ou década'),
    (8,  'continuação ou refinamento de busca anterior (e nos anos 70?, tira o samba, so os mais calmos)'),
]
TOPICS = ['samba', 'choro', 'forró', 'bossa nova', 'MPB', 'pagode', 'indie rock', 'noise', 'eletrônica', 'hip hop', 'punk',
          'rock pesado', 'psicodelia', 'folk', 'jazz', 'experimental', 'instrumental', 'voz e violão', 'anos 60', 'anos 70',
          'anos 80', 'anos 90', 'anos 2000', 'recente', 'calmo', 'triste', 'animado', 'dançante', 'lento', 'rápido',
          'para dormir', 'para treinar', 'para estudar', 'para dirigir', 'festa junina', 'carnaval', 'um artista famoso',
          'um artista obscuro', 'violão', 'guitarra', 'piano', 'bateria', 'percussão', 'sem voz', 'só voz']

def make(total):
    rnd = random.Random(20261002)
    w = [c[0] for c in CATS]
    n = 0
    for shard in range(1, (total + 999) // 1000 + 1):
        with open(Q / 'in' / f'E{shard:02d}.jsonl', 'w', encoding='utf-8') as f:
            for i in range(1, min(1000, total - n) + 1):
                cat = rnd.choices(CATS, w)[0][1]
                f.write(json.dumps({'id': f'E{shard:02d}-{i:04d}', 'categoria': cat, 'tema': rnd.choice(TOPICS),
                                    'acervo': rnd.choice(['uqt', 'homi'])}, ensure_ascii=False) + '\n')
            n += i
    print(f'{n} slots')

def seeds():
    rows = [json.loads(l) for l in open(Q / 'real/semente.jsonl', encoding='utf-8') if l.strip()]
    return '\n'.join('- ' + r['q'] for r in rows if r.get('origem') == 'usuario')

def build_prompt(slots):
    base = (Q / 'prompt-E.md').read_text(encoding='utf-8').replace('{SEMENTES}', seeds())
    data = '\n'.join(json.dumps(s, ensure_ascii=False) for s in slots)
    return (base + '\nLINHAS (uma por linha, JSON):\n' + data +
            '\n\nResponda SOMENTE com as linhas de saída, uma por linha de entrada, no formato {"id":"<id>","q":"mensagem"}. '
            'Nenhum texto antes ou depois, nenhum markdown, nenhum bloco de código. Não use ferramentas nem leia arquivos.')

def run_batch(slots, model, tries=3):
    ids = {s['id'] for s in slots}
    got, err = {}, ''
    for attempt in range(tries):
        try:
            p = subprocess.run(['opencode', 'run', '-m', model, build_prompt(slots)], cwd=ROOT,
                               capture_output=True, text=True, timeout=240)
        except subprocess.TimeoutExpired:
            err = f'timeout (try {attempt + 1})'; continue
        for line in p.stdout.splitlines():
            line = line.strip().strip('`')
            if not line.startswith('{'): continue
            try: r = json.loads(line)
            except ValueError: continue
            if r.get('id') in ids and isinstance(r.get('q'), str) and r['q'].strip():
                got[r['id']] = {'id': r['id'], 'q': r['q'].strip()}
        if len(got) >= len(ids) * 0.8: break
        err = p.stderr[-200:]
    return got, err

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('shard', nargs='?'); ap.add_argument('--make', type=int)
    ap.add_argument('--batch', type=int, default=8); ap.add_argument('--parallel', type=int, default=6)
    ap.add_argument('--limit', type=int); ap.add_argument('--model', default=MODEL)
    a = ap.parse_args()
    if a.make: return make(a.make)
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
