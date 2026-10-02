#!/usr/bin/env python3
"""Consolida features, gêneros, anos e metadados de cada acervo em data/resumo-acervo.json.

Lê data/features/<acervo>.jsonl (sem o embedding) e o catálogo ../<repo>/data/*.json.gz (v1 ou v2).
Uso: python3 script/build-resumo-acervo.py
"""
import gzip, json, re
from collections import Counter
from pathlib import Path
import polars as pl

RAIZ = Path(__file__).resolve().parent.parent
ACERVOS = {
    'uqt': RAIZ / '../uqt/data/uqt-albums.json.gz',
    'homi': RAIZ / '../hominiscanidae/data/homi-albums.json.gz',
}
NUM = ['bpm', 'bpm_conf', 'key_strength', 'loud_db', 'dyn', 'onset_rate', 'dur', 'br',
       'voice', 'dance', 'acoustic', 'electronic', 'happy', 'sad', 'relaxed',
       'aggressive', 'party', 'tonal']
QS = [0.05, 0.25, 0.5, 0.75, 0.95]


def catalogo(caminho):
    d = json.load(gzip.open(caminho))
    if d.get('v') == 2:
        a = d['a']
        return d['meta'], list(zip(a['r'], a['y'], a['n'])), len(d['t']['t'])
    albuns = d['albums']
    return d['meta'], [(x['artist'], x.get('year'), len(x['tracks'])) for x in albuns], sum(len(x['tracks']) for x in albuns)


def top(contador, n=None):
    return [{'nome': k, 'n': v} for k, v in contador.most_common(n)]


def estat(serie):
    s = serie.drop_nulls()
    if s.len() == 0:
        return None
    q = {f'p{int(p * 100):02d}': round(s.quantile(p), 3) for p in QS}
    return {'n': s.len(), 'min': round(s.min(), 3), **q, 'max': round(s.max(), 3),
            'media': round(s.mean(), 3), 'desvio': round(s.std() or 0, 3)}


def listas(linhas, campo):
    c = Counter()
    for l in linhas:
        for nome, _ in l.get(campo) or []:
            c[nome] += 1
    return c


def resumir(alias, caminho):
    meta, albuns, n_faixas_cat = catalogo(caminho)
    linhas = []
    with open(RAIZ / f'data/features/{alias}.jsonl') as f:
        for l in f:
            d = json.loads(l)
            d.pop('emb', None)
            linhas.append(d)
    ok = [d for d in linhas if 'error' not in d]
    df = pl.DataFrame([{c: d.get(c) for c in NUM + ['key', 'scale', 'k']} for d in ok])
    df = df.with_columns(
        pl.col('k').str.extract(r'^(\d{4}) - ', 1).cast(pl.Int32, strict=False).alias('ano'),
        pl.col('k').str.replace(r'/[^/]*$', '').alias('album'))

    anos = Counter(y for _, y, _ in albuns if y)
    decadas = Counter(y // 10 * 10 for y in anos.elements())
    g_top1 = Counter(d['genre'][0][0] for d in ok if d.get('genre'))
    g_top3 = listas(ok, 'genre')
    familias = Counter(g.split('---')[0] for g in g_top1.elements())
    bpm_bins = (df.filter(pl.col('bpm').is_not_null())
                .select((pl.col('bpm') // 10 * 10).cast(pl.Int32).alias('b')).group_by('b').len().sort('b'))
    tons = df.filter(pl.col('key').is_not_null()).group_by(['key', 'scale']).len().sort('len', descending=True)
    por_decada = (df.filter(pl.col('ano').is_not_null())
                  .with_columns((pl.col('ano') // 10 * 10).alias('decada'))
                  .group_by('decada').agg([pl.col(c).mean().round(3) for c in
                                           ['bpm', 'dance', 'happy', 'sad', 'relaxed', 'acoustic', 'electronic', 'voice', 'loud_db']]
                                          + [pl.len().alias('faixas')]).sort('decada'))
    return {
        'meta': meta,
        'catalogo': {
            'albuns': len(albuns), 'faixas': n_faixas_cat, 'artistas': len({a for a, _, _ in albuns}),
            'faixas_analisadas': len(ok), 'faixas_com_erro': len(linhas) - len(ok),
            'ano_min': min(anos), 'ano_max': max(anos), 'albuns_sem_ano': sum(1 for _, y, _ in albuns if not y),
            'albuns_por_ano': {str(k): anos[k] for k in sorted(anos)},
            'albuns_por_decada': {str(k): decadas[k] for k in sorted(decadas)},
            'artistas_mais_albuns': top(Counter(a for a, _, _ in albuns), 30),
        },
        'generos': {
            'familias_por_faixa': top(familias),
            'top1_por_faixa': top(g_top1),
            'top3_por_faixa': top(g_top3),
        },
        'instrumentos': top(listas(ok, 'inst')),
        'humores_essentia': top(listas(ok, 'mood')),
        'tom': {'por_tom': [{'tom': r['key'], 'modo': r['scale'], 'n': r['len']} for r in tons.to_dicts()]},
        'bpm_histograma_10': {str(r['b']): r['len'] for r in bpm_bins.to_dicts()},
        'features_numericas': {c: estat(df[c]) for c in NUM},
        'features_por_decada': {str(r['decada']): {k: v for k, v in r.items() if k != 'decada'} for r in por_decada.to_dicts()},
    }


if __name__ == '__main__':
    onto = json.load(open(RAIZ / 'data/ontologia-musical.json'))
    saida = {
        'versao': 1,
        'descricao': 'Resumo agregado das features de áudio, gêneros, anos e metadados dos acervos',
        'vocabulario': {k: onto[k] for k in ('generos', 'humores', 'instrumentos', 'formacoes', 'andamentos', 'voz') if k in onto},
        'acervos': {a: resumir(a, c) for a, c in ACERVOS.items()},
    }
    destino = RAIZ / 'data/resumo-acervo.json'
    destino.write_text(json.dumps(saida, ensure_ascii=False, indent=1))
    print(destino, destino.stat().st_size // 1024, 'KB')
