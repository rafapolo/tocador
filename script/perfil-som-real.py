#!/usr/bin/env python3
"""
perfil-som-real.py — what each /atlas music family really sounds like, measured on the acervos' own tracks.

  python3 script/perfil-som-real.py --escolher <dir> --rotulos <render>/rotulos.json   # picks the tracks
  bun script/amostrar-som-real.js <dir>                                                # downloads 30 s of each
  python3 script/perfil-som-real.py --perfil <dir> --saida data/features/perfil-som.json

A profile has the mean spectrum (dB per band, level removed) and the mean onset curve folded onto the beat (48 bins),
from which the microtiming of the four sixteenths comes. medir() is also what scores renders, so both sides match.
"""
import argparse
import collections
import concurrent.futures as cf
import glob
import gzip
import hashlib
import json
import os
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SR = 44100
BANDAS = np.geomspace(45, 16000, 25)
POR_FAMILIA = 16


def medir(caminho):
    """(spectrum in dB per band, onset curve over one beat, bpm) of an audio file, or None."""
    import essentia
    import essentia.standard as es
    essentia.log.warningActive = False
    essentia.log.infoActive = False
    x = es.MonoLoader(filename=str(caminho), sampleRate=SR, resampleQuality=1)()
    if len(x) < SR * 8:
        return None
    x = x[:SR * 30]
    n, hop = 2048, 256
    jan = np.hanning(n)
    q = (len(x) - n) // hop
    idx = np.arange(n)[None, :] + hop * np.arange(0, q)[:, None]
    S = np.abs(np.fft.rfft(x[idx] * jan, axis=1)) ** 2
    f = np.fft.rfftfreq(n, 1 / SR)
    media = S.mean(axis=0)
    # a low band can be narrower than an FFT bin: it takes the nearest bin
    espectro = np.array([media[(f >= a) & (f < b)].mean() if ((f >= a) & (f < b)).any() else media[np.argmin(np.abs(f - (a + b) / 2))]
                         for a, b in zip(BANDAS[:-1], BANDAS[1:])])
    db = 10 * np.log10(espectro + 1e-12)
    db -= db.mean()
    fluxo = np.maximum(np.diff(np.log1p(S[:, f < 8000] * 100), axis=0), 0).sum(axis=1)
    fluxo = np.convolve(fluxo, np.hanning(5) / 2, 'same')
    bpm, ticks, conf, _e, _i = es.RhythmExtractor2013(method='multifeature')(x)
    curva, conta = np.zeros(48), 0
    t = np.arange(len(fluxo)) * hop / SR
    for a, b in zip(ticks[:-1], ticks[1:]):
        if not 0.2 < b - a < 1.5:
            continue
        curva += np.interp(np.linspace(a, b, 48, endpoint=False), t, fluxo)
        conta += 1
    if conta < 8:
        return None
    curva /= conta
    curva = (curva - curva.mean()) / (curva.std() + 1e-9)
    return db, curva, float(bpm)


def cel_de(curva):
    """Where the four sixteenths of a beat really fall, as a fraction of a sixteenth, relative to the beat."""
    fora = []
    for k in range(4):
        c = k * 12
        ids = [(c + d) % 48 for d in range(-4, 5)]
        v = np.maximum(curva[ids], 0) ** 2
        fora.append(float((v * np.arange(-4, 5)).sum() / (v.sum() + 1e-9)) / 12)
    return [round(x - fora[0], 3) for x in fora]


def escolher(a):
    rotulos = json.loads(Path(a.rotulos).read_text())
    fam_de = {c: f for f, l in rotulos.items() for c in l}
    por = collections.defaultdict(list)
    for acervo in ('uqt', 'homi'):
        with gzip.open(ROOT / 'data' / 'features' / f'{acervo}.json.gz', 'rt', encoding='utf-8') as f:
            for k, r in json.load(f)['tracks'].items():
                g = r.get('genre')
                if not g or not r.get('br') or r.get('dur', 0) < 60 or g[0][1] < 0.25:
                    continue
                fam = fam_de.get(g[0][0])
                if fam:
                    por[fam].append((hashlib.md5(k.encode()).hexdigest(), acervo, k, r))
    saida = []
    for fam, l in por.items():
        l.sort(key=lambda x: x[0])
        for i, (_h, acervo, k, r) in enumerate(l[:POR_FAMILIA]):
            saida.append({'nome': f'{fam}-{i}.mp3', 'fam': fam, 'acervo': acervo, 'chave': k, 'ini': int(r['clip'][0] * r['br'] * 125), 'bytes': int(32 * r['br'] * 125)})
    os.makedirs(a.escolher, exist_ok=True)
    Path(a.escolher, 'escolhas.json').write_text(json.dumps(saida, ensure_ascii=False))
    print(len(saida), 'trechos de', len(por), 'famílias')


def perfil(a):
    arqs = sorted(glob.glob(f'{a.perfil}/*.mp3'))
    with cf.ProcessPoolExecutor(9) as ex:
        res = list(ex.map(medir_seguro, arqs, chunksize=4))
    por = collections.defaultdict(list)
    for p, r in zip(arqs, res):
        if r:
            por[Path(p).stem.rsplit('-', 1)[0]].append(r)
    fim = {}
    for fam, l in por.items():
        curva = np.mean([x[1] for x in l], axis=0)
        fim[fam] = {'n': len(l), 'espectro': [round(float(v), 2) for v in np.mean([x[0] for x in l], axis=0)],
                    'curva': [round(float(v), 3) for v in curva], 'cel': cel_de(curva), 'bpm': round(float(np.median([x[2] for x in l])), 1)}
    Path(a.saida).write_text(json.dumps({'bandas': [round(float(b)) for b in BANDAS], 'familias': fim}, ensure_ascii=False))
    print(len(fim), 'famílias,', sum(x['n'] for x in fim.values()), 'trechos')


def medir_seguro(p):
    try:
        return medir(p)
    except Exception:
        return None


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--escolher')
    ap.add_argument('--rotulos')
    ap.add_argument('--perfil')
    ap.add_argument('--saida', default=str(ROOT / 'data' / 'features' / 'perfil-som.json'))
    arg = ap.parse_args()
    escolher(arg) if arg.escolher else perfil(arg)
