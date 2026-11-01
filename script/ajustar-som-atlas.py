#!/usr/bin/env python3
"""
ajustar-som-atlas.py — tunes every /atlas music family against its own real tracks, and writes the result into the
AJUSTES block of js/atlas-receitas.js.

  python3 script/ajustar-som-atlas.py <work dir> [--so samba,forro] [--voltas 1] [--sem-escrever]

Needs data/features/perfil-som.json (script/perfil-som-real.py). Tempo and microtiming come straight from the profile
and the EQ is fitted to its spectrum; the rest is a coordinate search on the embedding cosine (see avaliar-som-atlas.py),
one parameter at a time. It tunes on take 0 and reports take 1, which it never saw, so overfitting shows. Limits keep it
honest: the model likes pads and dislikes synthetic leads, so the bed is capped and the melody can't be switched off.
"""
import argparse
import concurrent.futures as cf
import copy
import importlib.util
import json
import re
import shutil
import subprocess
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent


def modulo(nome):
    """The sibling scripts have hyphens in their names."""
    e = importlib.util.spec_from_file_location(nome.replace('-', '_'), ROOT / 'script' / f'{nome}.py')
    m = importlib.util.module_from_spec(e)
    e.loader.exec_module(m)
    return m


EQ_HZ = [80, 200, 500, 1200, 3000, 8000]
LOTES = 8
BUSCA = [
    ('mel', [0.6, 0.8, 1.3]),
    ('melT', ['voz', 'coro', 'flauta', 'sopro', 'bandolim', 'piano', 'guitarra']),
    ('perc', [0.7, 1.4]),
    ('acorde', [0.7, 1.4]),
    ('baixo', [0.7, 1.4]),
    ('camaPerto', [0.1, 0.5]),
    ('curta', [0.0, 0.35, 1.0]),
]


def aplicar(a, p, v):
    n = copy.deepcopy(a)
    if p in ('mel', 'perc', 'acorde', 'baixo'):
        n.setdefault('mix', {})[p] = v
    else:
        n[p] = v
    return n


def renderizar(trab, pasta):
    """Renders [{arq, nome, tomada, a}] in parallel Chromiums."""
    pasta.mkdir(parents=True, exist_ok=True)
    pasta_js = []
    for i in range(LOTES):
        lote = trab[i::LOTES]
        if lote:
            f = pasta / f'lote{i}.json'
            f.write_text(json.dumps(lote, ensure_ascii=False))
            pasta_js.append(subprocess.Popen(['node', str(ROOT / 'script' / 'render-som-atlas.js'), str(pasta), '--seg', '24', '--trabalhos', str(f)], stdout=subprocess.DEVNULL))
    if any(p.wait() for p in pasta_js):
        raise SystemExit('render falhou')


class Nota:
    def __init__(self, rotulos):
        import essentia
        import essentia.standard as es
        av = modulo('avaliar-som-atlas')
        essentia.log.warningActive = False
        essentia.log.infoActive = False
        self.es = es
        fam_de = {c: f for f, l in rotulos.items() for c in l}
        self.cent, self.media, _n = av.centroides(fam_de)
        self.effnet = es.TensorflowPredictEffnetDiscogs(graphFilename=str(av.MODELS / 'discogs-effnet-bs64-1.pb'), output='PartitionedCall:1')

    def cos(self, wav, fam):
        emb = self.effnet(self.es.MonoLoader(filename=str(wav), sampleRate=16000, resampleQuality=1)())
        v = np.mean(emb, axis=0) - self.media
        c = self.cent[fam]
        return float(v @ c / (np.linalg.norm(v) * np.linalg.norm(c) + 1e-9))


def ajustar_eq(fams, aj, perfil, pasta, bandas):
    trab = [{'arq': f'{f}.wav', 'nome': f, 'tomada': 0, 'a': aj[f]} for f in fams]
    renderizar(trab, pasta)
    centros = np.sqrt(np.array(bandas[:-1]) * np.array(bandas[1:]))
    with cf.ProcessPoolExecutor(9) as ex:
        res = list(ex.map(medir_seguro, [pasta / t['arq'] for t in trab]))
    for f, r in zip(fams, res):
        if not r:
            continue
        erro = np.array(perfil[f]['espectro']) - r[0]
        ganho = [float(np.mean(erro[(centros >= hz / 1.6) & (centros < hz * 1.6)])) for hz in EQ_HZ]
        eq = np.array(aj[f].get('eq', [0] * 6)) + 0.7 * np.array(ganho)
        aj[f]['eq'] = [round(float(x), 1) for x in np.clip(eq, -12, 12)]


def medir_seguro(p):
    try:
        return modulo('perfil-som-real').medir(p)
    except Exception:
        return None


def escrever(aj):
    f = ROOT / 'js' / 'atlas-receitas.js'
    linhas = ',\n'.join(f"    {k}: {json.dumps(v, ensure_ascii=False, separators=(', ', ': '))}" for k, v in sorted(aj.items()))
    corpo = '  const AJUSTES = {\n' + re.sub(r'"(\w+)":', r'\1:', linhas).replace('"', "'") + ',\n  };\n'
    s = f.read_text()
    s = re.sub(r'(// AJUSTES:INICIO\n).*?(  // AJUSTES:FIM)', lambda m: m.group(1) + corpo + m.group(2), s, flags=re.S)
    f.write_text(s)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dir')
    ap.add_argument('--so', default='')
    ap.add_argument('--voltas', type=int, default=1)
    ap.add_argument('--sem-escrever', action='store_true')
    a = ap.parse_args()
    base = Path(a.dir)
    p = json.loads((ROOT / 'data' / 'features' / 'perfil-som.json').read_text())
    perfil, bandas = p['familias'], p['bandas']
    rotulos = json.loads((base / 'rotulos.json').read_text())
    nota = Nota(rotulos)
    fams = [f for f in perfil if f in nota.cent and f in rotulos and (not a.so or f in a.so.split(','))]
    bpm0 = json.loads(subprocess.check_output(['node', '-e', '''
      const vm=require("vm"),fs=require("fs"),w={};vm.runInNewContext(fs.readFileSync("js/atlas-receitas.js","utf8"),{window:w});
      const R=w.RECEITAS_ATLAS,o={};for(const f of R.familias){const r=R.receita(f);o[f]={bpm:r.bpm,groove:!!r.groove,passos:r.passos}}console.log(JSON.stringify(o))'''], cwd=ROOT))
    aj = {}
    for f in fams:
        aj[f] = {}
        real, meu = perfil[f]['bpm'], bpm0[f]['bpm']
        if 0.75 <= real / meu <= 1.33:          # half or double is the beat tracker's octave, not the genre's tempo
            aj[f]['bpm'] = round(real)
        c = perfil[f]['cel']
        if bpm0[f]['groove'] and bpm0[f]['passos'] == 16 and max(abs(x) for x in c) <= 0.25:     # beyond that the sixteenths were too weak to read
            aj[f]['cel'] = c

    for volta in range(a.voltas):
        for i in range(2):
            ajustar_eq(fams, aj, perfil, base / 'eq', bandas)
            print(f'eq {i + 1} pronto', flush=True)
        for p_nome, valores in BUSCA:
            trab, cand = [], {}
            for f in fams:
                cand[f] = [(None, aj[f])] + [(v, aplicar(aj[f], p_nome, v)) for v in valores]
                for k, (_v, c) in enumerate(cand[f]):
                    trab.append({'arq': f'{f}-{k}.wav', 'nome': f, 'tomada': 0, 'a': c})
            pasta = base / 'busca'
            shutil.rmtree(pasta, ignore_errors=True)
            renderizar(trab, pasta)
            mudou = 0
            for f in fams:
                n = [nota.cos(pasta / f'{f}-{k}.wav', f) for k in range(len(cand[f]))]
                k = int(np.argmax(n))
                if k and n[k] > n[0] + 0.004:
                    aj[f] = cand[f][k][1]
                    mudou += 1
            print(f'{p_nome}: {mudou} famílias mudaram', flush=True)
            (base / 'ajustes.json').write_text(json.dumps(aj, ensure_ascii=False))
        ajustar_eq(fams, aj, perfil, base / 'eq', bandas)
    (base / 'ajustes.json').write_text(json.dumps(aj, ensure_ascii=False))
    # validation on a take the search never heard
    trab = [{'arq': f'{f}-{v}.wav', 'nome': f, 'tomada': 1, 'a': x} for f in fams for v, x in (('a', {}), ('b', aj[f]))]
    pasta = base / 'validacao'
    shutil.rmtree(pasta, ignore_errors=True)
    renderizar(trab, pasta)
    antes = np.array([nota.cos(pasta / f'{f}-a.wav', f) for f in fams])
    depois = np.array([nota.cos(pasta / f'{f}-b.wav', f) for f in fams])
    print(f'validação, tomada nunca ouvida: {antes.mean():.3f} -> {depois.mean():.3f}; subiram {(depois > antes).sum()} de {len(fams)}')
    if not a.sem_escrever:
        escrever(aj)


if __name__ == '__main__':
    main()
