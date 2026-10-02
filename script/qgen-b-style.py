#!/usr/bin/env python3
"""
One-off patch after the B01 pilot: (1) mark B01's three self-contradicting combos invalid, (2) for B02..B10 drop
contradictions (a "sem X" that the same filter asks for) and give every slot a mandatory `estilo`, because B01 came
back as mostly short "genre + mood + decade" searches. Touches only B shards' inputs and their labels.
"""
import json, random
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
rnd = random.Random(777)
ESTILOS = [('busca curta de 2 a 6 palavras', 20), ('frase completa na primeira pessoa', 20), ('coloquial, como mensagem de WhatsApp', 20),
           ('pergunta direta ("tem …?", "você conhece …?")', 12), ('regional (nordestino, carioca, paulista, mineiro ou gaúcho)', 10),
           ('formal e educado', 6), ('com gíria', 6), ('descritiva e longa, 15 a 25 palavras, com contexto ou situação', 6)]
pool = [e for e, w in ESTILOS for _ in range(w)]

labels = {}
for line in open(ROOT / 'data/qgen/labels.jsonl', encoding='utf-8'):
    r = json.loads(line); labels[r['id']] = r

def contradiction(c):
    sem = c.get('sem')
    if not sem: return False
    ins, form = (c.get('instrumento') or ''), (c.get('formacao') or '')
    return sem in ins or ins in sem and ins or (sem == 'voz' and form in ('voz e violão',)) or (sem == 'bateria' and 'bateria' in ins)

for i in ['B01']:
    for id_ in [f'B01-{n:04d}' for n in range(1, 1001)]:
        if contradiction(labels[id_]['filtro']): labels[id_]['invalid'] = True; print('invalid', id_)

for s in range(2, 11):
    name = f'B{s:02d}'; path = ROOT / f'data/qgen/in/{name}.jsonl'
    rows = [json.loads(l) for l in open(path, encoding='utf-8')]
    for r in rows:
        c = labels[r['id']]['filtro']
        if contradiction(c): c.pop('sem'); r['pedido_estruturado'].pop('sem', None)
        r['estilo'] = rnd.choice(pool)
    with open(path, 'w', encoding='utf-8') as f:
        for r in rows: f.write(json.dumps(r, ensure_ascii=False) + '\n')
with open(ROOT / 'data/qgen/labels.jsonl', 'w', encoding='utf-8') as f:
    for r in labels.values(): f.write(json.dumps(r, ensure_ascii=False) + '\n')
print('ok')
