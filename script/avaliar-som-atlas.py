#!/usr/bin/env python3
"""
avaliar-som-atlas.py — a realism score for the /atlas music, from the same model that placed the tracks on the map.

Takes the WAVs from script/render-som-atlas.js and, for each family:
  gênero  the discogs400 head's rank of the family among all families (a family scores its best label);
  som     the rank of the family's centroid among all centroids, by cosine on the 1280-d EffNet embedding,
          centroids being the real tracks of data/features/{uqt,homi} (minus the global mean);
  cos     that cosine, i.e. how close the render lands to the real tracks of its own family.

  python3 script/avaliar-som-atlas.py <dir> [--antes <dir>/nota.json] [--piores 12]

Writes <dir>/nota.json. It says whether a synth reads as a genre to this model, not whether it sounds good:
use it to find the worst families and to compare before and after, and judge the rest by ear.
"""
import argparse
import gzip
import json
import os
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MODELS = Path(os.path.expanduser('~/.essentia/models'))
EMB_DIM = 1280


def centroides(fam_de):
    """family -> mean embedding of the real tracks whose top label is one of its labels, plus the global mean."""
    soma, n = {}, {}
    total, conta = np.zeros(EMB_DIM), 0
    for acervo in ('uqt', 'homi'):
        base = ROOT / 'data' / 'features' / acervo
        with gzip.open(base.with_suffix('.json.gz'), 'rt', encoding='utf-8') as f:
            faixas = json.load(f)['tracks']
        emb = np.memmap(base.with_suffix('.emb.f16'), dtype=np.float16, mode='r').reshape(-1, EMB_DIM)
        for r in faixas.values():
            if 'emb' not in r or not r.get('genre'):
                continue
            v = np.nan_to_num(np.asarray(emb[r['emb']], dtype=np.float64))
            total += v
            conta += 1
            fam = fam_de.get(r['genre'][0][0])
            if fam:
                soma[fam] = soma.get(fam, 0) + v
                n[fam] = n.get(fam, 0) + 1
    media = total / conta
    return {f: soma[f] / n[f] - media for f in soma if n[f] >= 5}, media, n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dir')
    ap.add_argument('--antes', help='nota.json of an earlier run, to compare')
    ap.add_argument('--piores', type=int, default=12)
    a = ap.parse_args()

    import essentia
    import essentia.standard as es
    essentia.log.warningActive = False
    essentia.log.infoActive = False

    pasta = Path(a.dir)
    rotulos = json.loads((pasta / 'rotulos.json').read_text())
    fam_de = {c: f for f, l in rotulos.items() for c in l}
    cent, media, n_faixas = centroides(fam_de)
    nomes_cent = sorted(cent)
    M = np.stack([cent[f] / np.linalg.norm(cent[f]) for f in nomes_cent])

    meta = json.loads((MODELS / 'genre_discogs400-discogs-effnet-1.json').read_text())
    classes = meta['classes']
    effnet = es.TensorflowPredictEffnetDiscogs(graphFilename=str(MODELS / 'discogs-effnet-bs64-1.pb'), output='PartitionedCall:1')
    cabeca = es.TensorflowPredict2D(graphFilename=str(MODELS / 'genre_discogs400-discogs-effnet-1.pb'),
                                    input=meta['schema']['inputs'][0]['name'], output=meta['schema']['outputs'][0]['name'])
    ids = {f: [classes.index(c) for c in l] for f, l in rotulos.items()}

    por_fam = {}
    for wav in sorted(pasta.glob('*.wav')):
        fam = wav.stem.rsplit('-', 1)[0]
        if fam not in ids:
            continue            # plays no label of the model: nothing to compare it with
        audio = es.MonoLoader(filename=str(wav), sampleRate=16000, resampleQuality=1)()
        emb = effnet(audio)
        p = np.mean(cabeca(emb), axis=0)
        fams = sorted(ids)
        notas = np.array([p[ids[f]].max() for f in fams])
        rank_g = int((notas > notas[fams.index(fam)]).sum()) + 1
        v = np.mean(emb, axis=0) - media
        v = v / (np.linalg.norm(v) or 1)
        cos = M @ v
        r = {'genero': rank_g, 'p': float(p[ids[fam]].max()), 'top': classes[int(np.argmax(p))]}
        if fam in cent:
            i = nomes_cent.index(fam)
            r['som'] = int((cos > cos[i]).sum()) + 1
            r['cos'] = float(cos[i])
            r['perto'] = nomes_cent[int(np.argmax(cos))]
        por_fam.setdefault(fam, []).append(r)

    final = {}
    for f, l in por_fam.items():
        final[f] = {
            'genero': float(np.mean([x['genero'] for x in l])), 'p': float(np.mean([x['p'] for x in l])), 'top': l[0]['top'],
            'som': float(np.mean([x['som'] for x in l])) if 'som' in l[0] else None,
            'cos': float(np.mean([x['cos'] for x in l])) if 'cos' in l[0] else None,
            'perto': l[0].get('perto'), 'faixas': n_faixas.get(f, 0),
        }

    def resumo(d):
        g = [x['genero'] for x in d.values()]
        s = [x['som'] for x in d.values() if x['som'] is not None]
        c = [x['cos'] for x in d.values() if x['cos'] is not None]
        return {'familias': len(d), 'genero_top1': sum(x <= 1 for x in g), 'genero_top5': sum(x <= 5 for x in g), 'genero_rank': float(np.mean(g)),
                'som_top1': sum(x <= 1 for x in s), 'som_top5': sum(x <= 5 for x in s), 'som_rank': float(np.mean(s)), 'cos': float(np.mean(c))}

    res = resumo(final)
    (pasta / 'nota.json').write_text(json.dumps({'resumo': res, 'familias': final}, ensure_ascii=False, indent=1))
    antes = json.loads(Path(a.antes).read_text()) if a.antes else None
    print(f"\n{'família':20} {'gên':>5} {'som':>5} {'cos':>6}  mais perto de / rótulo do topo")
    for f, x in sorted(final.items(), key=lambda kv: -(kv[1]['cos'] if kv[1]['cos'] is None else -kv[1]['cos']))[:a.piores]:
        cos = '' if x['cos'] is None else f"{x['cos']:.3f}"
        extra = ''
        if antes and f in antes['familias'] and antes['familias'][f]['cos'] is not None and x['cos'] is not None:
            extra = f" (antes {antes['familias'][f]['cos']:.3f})"
        print(f"{f:20} {x['genero']:5.1f} {x['som'] or 0:5.1f} {cos:>6}{extra}  {x['perto']} / {x['top']}")
    print('\nresumo', json.dumps(res, ensure_ascii=False))
    if antes:
        print('antes ', json.dumps(antes['resumo'], ensure_ascii=False))


if __name__ == '__main__':
    main()
