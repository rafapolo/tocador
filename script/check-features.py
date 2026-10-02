#!/usr/bin/env python3
"""
check-features.py — referential integrity of everything extracted from the audio.

  bun script/features-integrity-dump.js      # catalog tracks, via the player's own decoder (once, or after an ETL)
  python3 script/check-features.py           # report; exit 1 if a hard link is broken

Links checked, per acervo:
  features.jsonl  <->  catalog tracks      (key = "<album path>/<file>", NFC; NFD / case fallbacks reported)
  features.jsonl  ->   compact .json.gz + .emb.f16   (one embedding row per track, rows in range, same count)
  homi-genres.json.gz -> catalog album paths
  data/qgen labels -> feature keys (track-grounded questions must point at a real analysed track)
"""
import gzip, json, sys, unicodedata, collections
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
F = ROOT / 'data/features'
nfc = lambda s: unicodedata.normalize('NFC', s)
nfd = lambda s: unicodedata.normalize('NFD', s)
hard = []

def section(t): print(f'\n== {t}')
def hardfail(msg): hard.append(msg); print('  ✗', msg)

for ac in ['homi', 'uqt']:
    section(ac)
    cat = json.load(open(F / f'catalog-{ac}.json', encoding='utf-8'))
    cat_keys = {nfc(r['k']): r for r in cat}
    cat_albums = {nfc(r['album']) for r in cat}
    feats, errors, dup = {}, {}, 0
    for line in open(F / f'{ac}.jsonl', encoding='utf-8'):
        try: r = json.loads(line)
        except ValueError: continue
        k = nfc(r['k'])
        if k in feats or k in errors: dup += 1
        (errors if 'error' in r else feats)[k] = r
    print(f'  catálogo: {len(cat_keys):,} faixas em {len(cat_albums):,} álbuns | features: {len(feats):,} válidas, {len(errors)} com erro, {dup} chaves repetidas')
    if dup: hardfail(f'{ac}: {dup} chaves repetidas no jsonl')

    inter = set(feats) & set(cat_keys)
    only_f = set(feats) - set(cat_keys)
    only_c = set(cat_keys) - set(feats)
    print(f'  ligadas por chave exata (NFC): {len(inter):,}  = {100 * len(inter) / len(cat_keys):.2f}% do catálogo')
    # why do features have no catalog track?
    alb_f = collections.Counter(k.rsplit('/', 1)[0] for k in only_f)
    in_cat_album = sum(n for a, n in alb_f.items() if a in cat_albums)
    print(f'  features sem faixa no catálogo: {len(only_f):,} — em {len(alb_f):,} pastas; {in_cat_album} delas em álbuns que EXISTEM no catálogo (arquivo diferente), '
          f'{len(only_f) - in_cat_album:,} em pastas ausentes do catálogo (duplicadas colapsadas / excluídas pelo gerador)')
    # catalog tracks without a feature: errors vs never analysed
    err_keys = set(errors)
    e_cat = only_c & err_keys
    low = {nfd(k): k for k in only_f}
    nfd_hit = sum(1 for k in only_c if nfd(k) in low)
    ci = {k.lower(): k for k in only_f}
    ci_hit = sum(1 for k in only_c if k.lower() in ci)
    print(f'  faixas do catálogo sem feature: {len(only_c):,} — {len(e_cat)} por erro de análise; {nfd_hit} casariam por NFD, {ci_hit} por caixa; '
          f'{len(only_c) - len(e_cat) - nfd_hit - ci_hit} sem nenhum arquivo analisado')
    if len(only_c) - len(e_cat) - nfd_hit - ci_hit > 0.02 * len(cat_keys):
        hardfail(f'{ac}: mais de 2% do catálogo sem feature ({len(only_c) - len(e_cat)})')
    # album-level coverage
    cov = collections.Counter()
    for r in cat: cov[nfc(r['album'])] += (nfc(r['k']) in feats)
    full = sum(1 for a in cat_albums if cov[a] == sum(1 for r in cat if nfc(r['album']) == a)) if len(cat) < 0 else None
    tot = collections.Counter(nfc(r['album']) for r in cat)
    albums0 = [a for a in cat_albums if cov[a] == 0]
    albums_full = sum(1 for a in cat_albums if cov[a] == tot[a])
    print(f'  álbuns: {albums_full:,} completos, {len(cat_albums) - albums_full - len(albums0):,} parciais, {len(albums0)} sem nenhuma faixa analisada')

    # fields present and sane
    bad = collections.Counter()
    for r in feats.values():
        for f in ['bpm', 'key', 'scale', 'voice', 'dance', 'acoustic', 'happy', 'sad', 'relaxed', 'aggressive', 'party', 'tonal', 'genre', 'inst', 'mood', 'dur', 'loud_db']:
            if f not in r or r[f] is None: bad['campo ausente: ' + f] += 1
        for f in ['voice', 'dance', 'acoustic', 'happy', 'sad', 'relaxed', 'aggressive', 'party', 'tonal']:
            if f in r and not (0 <= r[f] <= 1): bad['fora de [0,1]: ' + f] += 1
        if 'bpm' in r and not (30 <= r['bpm'] <= 300): bad['bpm fora de 30–300'] += 1
        if 'emb' not in r: bad['sem embedding'] += 1
    print('  campos:', dict(bad) if bad else 'todos presentes e dentro das faixas esperadas')
    if any(k.startswith(('campo ausente', 'sem embedding', 'fora de')) for k in bad): hardfail(f'{ac}: campos ausentes ou inválidos {dict(bad)}')

    # compact files
    cj = F / f'{ac}.json.gz'; ce = F / f'{ac}.emb.f16'
    if cj.exists() and ce.exists():
        d = json.load(gzip.open(cj, 'rt', encoding='utf-8'))
        rows = d['tracks']; n_emb = ce.stat().st_size // (2 * d['meta']['emb_dim'])
        idx = [r['emb'] for r in rows.values() if 'emb' in r]
        ok = len(rows) == len(feats) and len(idx) == len(set(idx)) == n_emb and (not idx or (min(idx) == 0 and max(idx) == n_emb - 1))
        print(f'  compacto: {len(rows):,} faixas, {n_emb:,} embeddings ({d["meta"]["emb_dim"]} dim), índices {"contíguos e únicos" if ok else "INCONSISTENTES"}; '
              f'chaves iguais às do jsonl: {set(map(nfc, rows)) == set(feats)}')
        if not ok or set(map(nfc, rows)) != set(feats): hardfail(f'{ac}: compacto inconsistente com o jsonl (rode --compact de novo)')
    else:
        print('  compacto: ausente')

# genre index
section('índice de gêneros (homi-genres.json.gz -> álbuns do catálogo)')
gi = json.load(gzip.open(ROOT / 'data/homi-genres.json.gz', 'rt', encoding='utf-8'))
cat = json.load(open(F / 'catalog-homi.json', encoding='utf-8'))
albums = {nfc(r['album']) for r in cat}
orph = [a for a in gi if nfc(a) not in albums]
no_gen = [a for a in albums if a not in {nfc(g) for g in gi}]
print(f'  {len(gi):,} álbuns no índice; {len(orph)} sem álbum no catálogo; {len(no_gen)} álbuns do catálogo sem gênero')
if len(orph) > 0.03 * len(gi): hardfail(f'índice de gêneros: {len(orph)} chaves sem álbum no catálogo')

# questions
section('perguntas (data/qgen) -> features')
qp = ROOT / 'data/qgen/train.jsonl'
if qp.exists():
    allk = {nfc(k) for ac in ['homi', 'uqt'] for k in [json.loads(l)['k'] for l in open(F / f'{ac}.jsonl', encoding='utf-8') if '"error"' not in l]}
    n = miss = 0
    for l in open(qp, encoding='utf-8'):
        r = json.loads(l)
        if r.get('family') == 'A':
            n += 1; miss += nfc(r['key']) not in allk
    print(f'  {n:,} perguntas ancoradas em faixa; {miss} apontam para uma faixa sem feature')
    if miss: hardfail(f'{miss} perguntas A apontam para faixa inexistente')
print('\n' + ('OK: todos os elos obrigatórios íntegros' if not hard else f'FALHAS: {len(hard)}'))
sys.exit(1 if hard else 0)
