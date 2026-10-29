#!/usr/bin/env python3
"""build-atlas-coords.py — posição 2D de cada faixa para o /atlas.

Dois mapas, ambos UMAP:
  som     — embedding de áudio EffNet (1280-d): L2 → PCA 64 → UMAP cosseno, em 3D. Faixas que soam parecido
            ficam perto. O 3D parte do UMAP 2D (x, y) com z ~ 0, então visto de frente fica parecido com o 2D;
            o /atlas gira esse volume com o botão direito do mouse.
  rotulos — só os scores de gênero (Discogs-400, top-5): matriz esparsa L2 → SVD 50 → UMAP cosseno,
            também em 3D a partir do 2D.

Lê data/features/{uqt,homi}.json.gz + .emb.f16 (saída de analyze-tracks.py --compact) e escreve
data/features/atlas-coords.json.gz (gitignored): por acervo, as chaves "<álbum>/<arquivo>" (NFC),
o gênero top-1 e o xy de cada mapa. script/build-atlas-web.js transforma isso no payload servido.

O UMAP não é incremental: rodar de novo depois de um ETL redesenha o mapa inteiro.
~5 min nos dois acervos (83 mil faixas).

Uso: uv run --with umap-learn --with scikit-learn --with scipy --with numpy \\
       python script/build-atlas-coords.py [--reuse-som X.npz] [--reuse-rotulos Y.npz]
--reuse-* aceita um .npz com `xy` calculado antes na mesma ordem (uqt, depois homi; faixas com
genre e emb), só se a contagem bater.
"""
import argparse, gzip, json, os, sys, unicodedata
import numpy as np

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
FEAT = os.path.join(ROOT, 'data', 'features')
ACERVOS = ('uqt', 'homi')

ap = argparse.ArgumentParser()
ap.add_argument('--reuse-som'); ap.add_argument('--reuse-som3')
ap.add_argument('--reuse-rotulos'); ap.add_argument('--reuse-rotulos3')
args = ap.parse_args()

keys, acervo, genres, embs = [], [], [], []
for a in ACERVOS:
    d = json.load(gzip.open(f'{FEAT}/{a}.json.gz'))
    n = d['meta']['emb_rows']
    E = np.memmap(f'{FEAT}/{a}.emb.f16', dtype=np.float16, mode='r').reshape(n, d['meta']['emb_dim'])
    rows = []
    for k, v in d['tracks'].items():
        if not v.get('genre') or v.get('emb') is None:
            continue
        keys.append(unicodedata.normalize('NFC', k)); acervo.append(a)
        genres.append(v['genre']); rows.append(v['emb'])
    embs.append(np.asarray(E[rows], dtype=np.float32))
N = len(keys)
print(f'faixas: {N}', file=sys.stderr)


def reuse(path, dims=2):
    if not path:
        return None
    xy = np.load(path)['xy']
    if xy.shape != (N, dims):
        sys.exit(f'{path}: {xy.shape[0]} linhas, esperava {N} — rode sem --reuse')
    return xy


def umap2d(X, dims=2, init='spectral'):
    import umap
    return umap.UMAP(n_components=dims, n_neighbors=30, min_dist=0.08, metric='cosine', random_state=42,
                     init=init, low_memory=True, verbose=dims == 3).fit_transform(X)


P = None
def pca():
    global P
    if P is None:
        from sklearn.decomposition import PCA
        X = np.vstack(embs)
        X /= np.linalg.norm(X, axis=1, keepdims=True) + 1e-8
        P = PCA(64, random_state=0).fit_transform(X)
    return P


som = reuse(args.reuse_som)
if som is None:
    som = umap2d(pca())

def em3d(X, flat, cache):
    # Start from the 2D layout (scaled to UMAP's usual ~10-unit range) with a thin random z,
    # so the front view of the volume stays close to the flat map.
    xy = (flat - flat.mean(0)) / flat.std(0) * 3
    z = np.random.default_rng(0).normal(0, 0.3, (N, 1))
    out = umap2d(X, 3, np.hstack([xy, z]).astype(np.float32))
    np.savez(os.path.join(FEAT, cache), xy=out)
    return out


som3 = reuse(args.reuse_som3, 3)
if som3 is None:
    som3 = em3d(pca(), som, 'atlas-som3.npz')

S = None
def svd_rotulos():
    global S
    if S is None:
        import scipy.sparse as sp
        from sklearn.decomposition import TruncatedSVD
        labels = sorted({l for g in genres for l, _ in g}); ix = {l: i for i, l in enumerate(labels)}
        r, c, x = [], [], []
        for i, g in enumerate(genres):
            s = np.array([p for _, p in g], float); s /= np.linalg.norm(s) or 1
            for (l, _), p in zip(g, s):
                r.append(i); c.append(ix[l]); x.append(p)
        M = sp.csr_matrix((x, (r, c)), shape=(N, len(labels)))
        S = TruncatedSVD(50, random_state=42).fit_transform(M)
    return S


rot = reuse(args.reuse_rotulos)
if rot is None:
    rot = umap2d(svd_rotulos())

rot3 = reuse(args.reuse_rotulos3, 3)
if rot3 is None:
    rot3 = em3d(svd_rotulos(), rot, 'atlas-rotulos3.npz')

out = {'v': 1, 'mapas': ['som', 'rotulos'], 'acervos': {}}
for a in ACERVOS:
    m = [i for i in range(N) if acervo[i] == a]
    out['acervos'][a] = {
        'keys': [keys[i] for i in m],
        'genre': [genres[i][0][0] for i in m],
        'som': np.round(som3[m], 4).tolist(),       # x, y, z
        'rotulos': np.round(rot3[m], 4).tolist(),   # x, y, z
    }
dest = f'{FEAT}/atlas-coords.json.gz'
with gzip.open(dest, 'wt') as f:
    json.dump(out, f, ensure_ascii=False)
print(f'{dest}: {N} faixas', file=sys.stderr)
