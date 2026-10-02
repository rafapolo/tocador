#!/usr/bin/env python3
"""
qgen-prepare.py — builds the input shards that Opus subagents turn into pt-BR user questions
(tasks/modelo-proprio.md). Writes data/qgen/in/<shard>.jsonl, one slot per line; the agent answers with
data/qgen/out/<shard>.jsonl lines {"id", "q"}. Labels never go to the agent: they stay in data/qgen/labels.jsonl
so the generated question can not leak them.

Families: A track-grounded (30k), B compositional (10k), C referential (5k), D negative/off-domain (5k).
"""
import json, random, re, sys, unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IN, OUT = ROOT / 'data/qgen/in', ROOT / 'data/qgen/out'
IN.mkdir(parents=True, exist_ok=True); OUT.mkdir(parents=True, exist_ok=True)
rnd = random.Random(20261001)

FOLDER = re.compile(r'^(\d{4}) - (.+?) - (.+)$')

def parse_key(k):
    parts = k.split('/')
    folder, fname = parts[0], parts[-1]
    m = FOLDER.match(folder)
    year, artist, album = (int(m.group(1)), m.group(2), m.group(3)) if m else (None, None, folder)
    title = re.sub(r'\.mp3$', '', fname, flags=re.I)
    title = re.sub(r'^\s*\d{1,3}\s*[-._)]*\s*', '', title).strip() or title
    return year, artist, album, title

def load(acervo):
    rows = []
    for line in open(ROOT / f'data/features/{acervo}.jsonl', encoding='utf-8'):
        try: r = json.loads(line)
        except ValueError: continue
        if 'error' in r: continue
        r['acervo'] = acervo
        rows.append(r)
    return rows

def pct(x): return int(round(x * 100))

def describe(r):
    year, artist, album, title = parse_key(r['k'])
    feats = {
        'bpm': round(r['bpm']), 'tom': f"{r['key']} {'maior' if r['scale']=='major' else 'menor'}",
        'voz_%': pct(r['voice']), 'dancavel_%': pct(r['dance']), 'acustico_%': pct(r['acoustic']),
        'feliz_%': pct(r['happy']), 'triste_%': pct(r['sad']), 'relaxado_%': pct(r['relaxed']),
        'agressivo_%': pct(r['aggressive']), 'festa_%': pct(r['party']),
        'generos_discogs': [g[0].replace('---', ' / ') for g in r['genre'][:3]],
        'instrumentos': [i[0] for i in r['inst'][:3]],
    }
    return {'acervo': r['acervo'], 'ano': year, 'artista': artist, 'album': album, 'faixa': title, 'features': feats}

def write_shard(name, rows):
    with open(IN / f'{name}.jsonl', 'w', encoding='utf-8') as f:
        for r in rows: f.write(json.dumps(r, ensure_ascii=False) + '\n')

labels = open(ROOT / 'data/qgen/labels.jsonl', 'w', encoding='utf-8')
def label(id_, **kw): labels.write(json.dumps({'id': id_, **kw}, ensure_ascii=False) + '\n')

# ── A: track-grounded ────────────────────────────────────────────────────
homi, uqt = load('homi'), load('uqt')
def sample(rows, n):
    per_album, out = {}, []
    rnd.shuffle(rows)
    for r in rows:
        if r['dur'] < 40: continue
        album = r['k'].split('/')[0]
        if per_album.get(album, 0) >= 2: continue
        per_album[album] = per_album.get(album, 0) + 1
        out.append(r)
        if len(out) >= n: break
    return out
A_SHARDS, A_PER = 30, 330
picked = sample(homi, A_SHARDS * A_PER * 6 // 10) + sample(uqt, A_SHARDS * A_PER * 4 // 10)
rnd.shuffle(picked)
for s in range(A_SHARDS):
    rows = []
    for i, r in enumerate(picked[s * A_PER:(s + 1) * A_PER], 1):
        id_ = f'A{s+1:02d}-{i:03d}'
        d = describe(r); label(id_, family='A', key=r['k'], acervo=r['acervo'])
        rows.append({'id': id_, **d})
    write_shard(f'A{s+1:02d}', rows)

# ── B: compositional ────────────────────────────────────────────────────
GENEROS = ['samba','samba de raiz','pagode','samba-canção','choro','bossa nova','MPB','tropicália','forró','baião','xote','xaxado','axé','frevo','maracatu','manguebeat','carimbó','sertanejo raiz','música caipira','rock brasileiro','punk','hardcore','indie','psicodelia','rock experimental','pós-punk','shoegaze','metal','jazz','blues','folk','reggae','funk carioca','rap','música eletrônica','ambient','noise','pop','vanguarda','música instrumental','canção de protesto','jovem guarda','brega','lundu','modinha']
ANDAMENTO = ['lento','moderado','animado','acelerado']
HUMOR = ['melancólico','festivo','calmo','agressivo','dançante','nostálgico','romântico','alegre','sombrio','intimista','contemplativo','irônico','sensual','épico']
INSTR = ['violão','violão de sete cordas','cavaquinho','pandeiro','sanfona','piano','guitarra elétrica','bateria','percussão','flauta','bandolim','violino','sopros','baixo','sintetizador','órgão','viola caipira','cordas','coro']
FORMACAO = ['voz e violão','banda completa','orquestra','só instrumental','conjunto regional','duo','coletânea','ao vivo']
DECADAS = [1930,1940,1950,1960,1970,1980,1990,2000,2010,2020]
# genre -> (typical decades, typical instruments); 85% of combos stay inside this, the rest is random on purpose
INFO = {
 'samba': (range(1930, 2030, 10), ['cavaquinho','pandeiro','violão de sete cordas','percussão']),
 'samba de raiz': (range(1930, 1990, 10), ['cavaquinho','pandeiro','violão de sete cordas','percussão']),
 'pagode': (range(1980, 2030, 10), ['cavaquinho','pandeiro','percussão']),
 'samba-canção': (range(1940, 1970, 10), ['piano','violão','cordas']),
 'choro': (range(1930, 2030, 10), ['bandolim','flauta','violão de sete cordas','cavaquinho','pandeiro']),
 'bossa nova': ([1950, 1960, 1970, 2000], ['violão','piano','flauta','baixo','bateria']),
 'MPB': (range(1960, 2030, 10), ['violão','piano','bateria','baixo','cordas']),
 'tropicália': ([1960, 1970], ['guitarra elétrica','órgão','violão','sopros','cordas']),
 'forró': (range(1940, 2030, 10), ['sanfona','percussão']), 'baião': (range(1940, 1980, 10), ['sanfona','percussão']),
 'xote': (range(1950, 2020, 10), ['sanfona']), 'xaxado': (range(1950, 1990, 10), ['sanfona']),
 'axé': (range(1980, 2020, 10), ['percussão','guitarra elétrica','bateria','sopros']),
 'frevo': (range(1930, 2030, 10), ['sopros','percussão']), 'maracatu': (range(1990, 2030, 10), ['percussão']),
 'manguebeat': (range(1990, 2020, 10), ['guitarra elétrica','percussão','baixo','bateria']),
 'carimbó': (range(1970, 2020, 10), ['percussão','guitarra elétrica']),
 'sertanejo raiz': (range(1950, 1990, 10), ['viola caipira','violão']), 'música caipira': (range(1930, 1990, 10), ['viola caipira','violão']),
 'rock brasileiro': (range(1960, 2030, 10), ['guitarra elétrica','bateria','baixo']),
 'punk': (range(1980, 2030, 10), ['guitarra elétrica','bateria','baixo']), 'hardcore': (range(1980, 2030, 10), ['guitarra elétrica','bateria','baixo']),
 'indie': (range(1990, 2030, 10), ['guitarra elétrica','bateria','baixo','sintetizador']),
 'psicodelia': ([1960, 1970, 2010], ['guitarra elétrica','órgão','sintetizador']),
 'rock experimental': (range(1990, 2030, 10), ['guitarra elétrica','sintetizador','percussão']),
 'pós-punk': ([1980, 2000, 2010, 2020], ['baixo','guitarra elétrica','sintetizador']),
 'shoegaze': (range(1990, 2030, 10), ['guitarra elétrica','sintetizador']),
 'metal': (range(1980, 2030, 10), ['guitarra elétrica','bateria','baixo']),
 'jazz': (range(1950, 2030, 10), ['piano','sopros','baixo','bateria']),
 'blues': (range(1960, 2030, 10), ['guitarra elétrica','violão']), 'folk': (range(1970, 2030, 10), ['violão','violino']),
 'reggae': (range(1980, 2020, 10), ['baixo','guitarra elétrica','bateria','percussão']),
 'funk carioca': (range(1990, 2030, 10), ['sintetizador','percussão']), 'rap': (range(1990, 2030, 10), ['sintetizador','bateria']),
 'música eletrônica': (range(1990, 2030, 10), ['sintetizador']), 'ambient': (range(1990, 2030, 10), ['sintetizador','piano']),
 'noise': (range(1990, 2030, 10), ['sintetizador','guitarra elétrica']), 'pop': (range(1980, 2030, 10), ['sintetizador','guitarra elétrica','bateria']),
 'vanguarda': (range(1970, 2030, 10), ['piano','cordas','sopros']), 'música instrumental': (range(1950, 2030, 10), ['piano','violão','sopros','cordas']),
 'canção de protesto': (range(1960, 1990, 10), ['violão']), 'jovem guarda': ([1960], ['guitarra elétrica','órgão','bateria']),
 'brega': (range(1970, 2030, 10), ['sintetizador','cordas']), 'lundu': (range(1930, 1980, 10), ['violão','percussão']),
 'modinha': (range(1930, 1970, 10), ['violão','piano']),
}
def combo():
    g = rnd.choice(GENEROS)
    decs, ins = INFO[g]; typical = rnd.random() < .85
    c = {'genero': g}
    for key, pool, p in [('andamento', ANDAMENTO, .5), ('humor', HUMOR, .55), ('formacao', FORMACAO, .2)]:
        if rnd.random() < p: c[key] = rnd.choice(pool)
    if rnd.random() < .3: c['instrumento'] = rnd.choice(ins if typical else INSTR)
    r = rnd.random()
    if r < .45: c['decada'] = rnd.choice(list(decs) if typical else DECADAS)
    elif r < .55:
        a = rnd.choice(list(decs)); c['intervalo'] = [a, min(2025, a + rnd.choice([10, 15, 20, 30]))]
    if rnd.random() < .12: c['sem'] = rnd.choice(['voz','bateria','guitarra elétrica','sintetizador'])
    if rnd.random() < .08: c['genero'] = None; c['humor'] = c.get('humor') or rnd.choice(HUMOR)   # mood-only requests
    return c
B_SHARDS, B_PER = 10, 1000
for s in range(B_SHARDS):
    rows = []
    for i in range(1, B_PER + 1):
        id_ = f'B{s+1:02d}-{i:04d}'; c = combo(); label(id_, family='B', filtro=c)
        rows.append({'id': id_, 'pedido_estruturado': {k: v for k, v in c.items() if v is not None}})
    write_shard(f'B{s+1:02d}', rows)

# ── C: referential ("mais como X") ──────────────────────────────────────
RELACOES = ['parecido com','mais lento que','mais animado que','do mesmo clima de','versão instrumental de','da mesma época de','mais acústico que','mais pesado que','mais dançante que','com a mesma pegada de','o contrário de','mais calmo que','que lembre','mesma região/estilo de']
refs = []
for r in homi + uqt:
    y, artist, album, title = parse_key(r['k'])
    if artist and r['dur'] > 60: refs.append((r['acervo'], y, artist, album, title))
rnd.shuffle(refs)
C_SHARDS, C_PER = 5, 1000
for s in range(C_SHARDS):
    rows = []
    for i in range(1, C_PER + 1):
        ac, y, artist, album, title = refs[(s * C_PER + i) % len(refs)]
        kind = rnd.choice(['artista','album','faixa'])
        ref = {'artista': {'artista': artist}, 'album': {'artista': artist, 'album': album}, 'faixa': {'artista': artist, 'faixa': title}}[kind]
        rel = rnd.choice(RELACOES); id_ = f'C{s+1}-{i:04d}'
        label(id_, family='C', acervo=ac, referencia=ref, relacao=rel)
        rows.append({'id': id_, 'referencia': ref, 'relacao': rel})
    write_shard(f'C{s+1}', rows)

# ── D: negative / off-domain / vague ────────────────────────────────────
CATS = [
 ('fora do domínio (clima, futebol, culinária, política, trabalho)', 14), ('pedido impossível ou inexistente (música que ainda não foi feita, som de cor)', 8),
 ('vago de uma palavra ou pouco mais ("algo", "legal", "novo")', 12), ('pedido por trecho ou tema de LETRA (o acervo não indexa letras)', 10),
 ('pergunta biográfica ou sobre a pessoa do artista (idade, casamento, morte)', 8), ('pergunta técnica de música (como afinar, tocar, ler partitura)', 8),
 ('pedido de plataforma ou serviço (Spotify, baixar, comprar ingresso, rádio FM)', 7), ('mistura de línguas ou inglês puro pedindo música brasileira', 8),
 ('gíria pesada, abreviações e erros de digitação em pedido musical comum', 12), ('pedido de outra mídia (filme, série, podcast, livro)', 5),
 ('pedido com condição contraditória (lento e acelerado, instrumental com letra)', 4), ('conversa social sem pedido (oi, obrigado, quem é você)', 4),
]
pool = [c for c, w in CATS for _ in range(w)]
D_SHARDS, D_PER = 5, 1000
for s in range(D_SHARDS):
    rows = []
    for i in range(1, D_PER + 1):
        cat = rnd.choice(pool); id_ = f'D{s+1}-{i:04d}'
        label(id_, family='D', categoria=cat)
        rows.append({'id': id_, 'categoria': cat})
    write_shard(f'D{s+1}', rows)
labels.close()
print('shards:', len(list(IN.glob('*.jsonl'))), '| slots:', sum(1 for f in IN.glob('*.jsonl') for _ in open(f)))
