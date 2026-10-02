#!/usr/bin/env python3
"""qgen-gold-compare.py — blind gold labels (Opus, gold/out.jsonl) vs the labels each question was generated from (gold/key.jsonl)."""
import json, re, collections
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
G = ROOT / 'data/qgen/gold'
gold = {r['gid']: r for r in map(json.loads, open(G / 'out.jsonl', encoding='utf-8'))}
key = {r['gid']: r for r in map(json.loads, open(G / 'key.jsonl', encoding='utf-8'))}
def fold(s): return re.sub(r'\s+', ' ', (s or '').lower()).strip()
stats = collections.defaultdict(lambda: collections.Counter())
bad = collections.defaultdict(list)
def note(fam, field, ok, g=None):
    stats[fam][field + ('+' if ok else '-')] += 1
    if not ok and g: bad[(fam, field)].append(g)
for gid, k in key.items():
    g, fam = gold[gid], k['family']
    if fam == 'D':
        note('D', 'fora_do_dominio', g['tipo'] == 'fora_do_dominio', gid)
    elif fam == 'B':
        f = k['filtro']
        note('B', 'tipo=busca', g['tipo'] == 'busca', gid)
        if f.get('genero'): note('B', 'genero', any(fold(f['genero']) == fold(x) or fold(f['genero']) in fold(x) for x in g['generos']), gid)
        if f.get('andamento'): note('B', 'andamento', g['andamento'] == f['andamento'], gid)
        if f.get('humor'): note('B', 'humor', any(fold(f['humor']) == fold(x) for x in g['humor']), gid)
        if f.get('instrumento'): note('B', 'instrumento', any(fold(f['instrumento']) == fold(x) for x in g['instrumentos']), gid)
        p = g.get('periodo') or {}
        if f.get('decada'): note('B', 'periodo', p.get('decada') == f['decada'] or (p.get('de') is not None and p['de'] <= f['decada'] and p.get('ate', 0) >= f['decada'] + 9), gid)
        if f.get('intervalo'): note('B', 'intervalo', p.get('de') == f['intervalo'][0] and p.get('ate') == f['intervalo'][1], gid)
        if f.get('sem'): note('B', 'excluir', any(fold(f['sem']) in fold(x) or fold(x) in fold(f['sem']) for x in g['excluir']), gid)
    elif fam == 'C':
        ref = k['referencia']; gr = g.get('referencia') or {}
        note('C', 'tipo=referencial', g['tipo'] == 'referencial', gid)
        note('C', 'artista', bool(gr.get('artista')) and (fold(gr['artista']) in fold(ref['artista']) or fold(ref['artista']) in fold(gr['artista']) or fold(ref['artista']).split(',')[0][:8] in fold(gr['artista'])), gid)
        REL = {'parecido com': 'parecido', 'mais lento que': 'mais_lento', 'mais animado que': 'mais_animado', 'do mesmo clima de': 'parecido', 'versão instrumental de': 'instrumental',
               'da mesma época de': 'mesma_epoca', 'mais acústico que': 'mais_acustico', 'mais pesado que': 'mais_pesado', 'mais dançante que': 'mais_dancante',
               'com a mesma pegada de': 'parecido', 'o contrário de': 'contrario', 'mais calmo que': 'mais_calmo', 'que lembre': 'parecido', 'mesma região/estilo de': 'mesma_regiao'}
        note('C', 'relacao', gr.get('relacao') == REL.get(k['relacao']), gid)
    elif fam == 'A':
        note('A', 'tipo=busca', g['tipo'] == 'busca', gid)
        m = re.match(r'^(\d{4}) - ', k['key'])
        p = g.get('periodo') or {}
        if m and p:
            y = int(m.group(1))
            ok = p.get('decada') == y // 10 * 10 or p.get('ano') == y or (p.get('de') is not None and p['de'] <= y <= p.get('ate', 9999))
            note('A', 'periodo coerente com a faixa', ok, gid)
print('concordância por família e campo (rótulo cego do Opus vs rótulo de origem):')
for fam in 'ABCD':
    fields = sorted({f[:-1] for f in stats[fam]})
    for f in fields:
        a, b = stats[fam][f + '+'], stats[fam][f + '-']
        print(f'  {fam} {f:32} {a:3}/{a + b:<3} = {100 * a / (a + b):5.1f}%')
conf = collections.Counter(g['confianca'] for g in gold.values())
print('confiança do rotulador:', dict(sorted(conf.items())), '| resolvivel=false:', sum(1 for g in gold.values() if not g['resolvivel']))
json.dump({f'{a}/{b}': v for (a, b), v in bad.items()}, open(G / 'disagreements.json', 'w'), ensure_ascii=False)
