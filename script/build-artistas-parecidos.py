#!/usr/bin/env python3
"""build-artistas-parecidos.py — vizinhos de cada artista para o grafo do /atlas.

Dois grafos, nos mesmos espaços dos mapas (script/build-atlas-coords.py), mas sem o UMAP, que distorce
distâncias:
  som     — embedding de áudio EffNet (1280-d) de cada faixa
  rotulos — scores de gênero (Discogs-400, top-5) de cada faixa

Cada artista vira a média das suas faixas (L2 por faixa, depois L2 no artista). Subtrair a média global é o
que dá contraste: sem isso quase todo cosseno passa de 0,9. Ficam os artistas com MIN_FAIXAS ou mais e, para
cada um, os K mais próximos.

O UMAP só entra para desenhar: `pos` guarda onde cada artista fica na visão geral, com todos os artistas (x, y, z
em ±32767, por mapa). Os vizinhos continuam vindo do cosseno.

Lê data/features/{uqt,homi}.json.gz + .emb.f16 e os catálogos publicados (script/export-faixas-artistas.js)
e escreve data/atlas-artistas.json.gz (formato em js/atlas-data.js, decodeArtistas). ~2 min.

Uso: uv run -q --with umap-learn --with numpy python script/build-artistas-parecidos.py [--amostra "Nome" "Outro"]
"""
import argparse, base64, gzip, json, os, re, subprocess, sys, unicodedata
from collections import Counter, defaultdict
import numpy as np

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
FEAT = os.path.join(ROOT, 'data', 'features')
ACERVOS = ('uqt', 'homi')
K = 8
MIN_FAIXAS = 3
# Não são artistas: rótulos de coletânea ou de metadado ausente.
FORA = {'various', 'variousartists', 'varios', 'variosartistas', 'va', 'unknown', 'unknownartist',
        'desconhecido', 'artistadesconhecido', 'coletanea', 'compilation', 'soundtrack', 'hominiscanidae'}
COLETANEA = re.compile(r'\bvol\.?\s*\d+\s*$', re.I)
PARTICIPACAO = re.compile(r'(?:\s*\((?:part|feat|ft|com)\b|\s+(?:part|feat|ft)\.?\s).*$', re.I)


def limpar(nome):
    nome = PARTICIPACAO.sub('', nome).strip()
    return nome.rstrip(')').strip() if '(' not in nome else nome     # "Jurim Moreira)": sobra de crédito cortado


def chave(nome):
    """Mesma regra de chaveArtista() em js/atlas-data.js: une "alcione"/"Alcione" e "BK"/"BK'"."""
    s = unicodedata.normalize('NFD', limpar(nome))
    s = ''.join(c for c in s if not unicodedata.combining(c)).lower()
    return ''.join(c for c in s if c.isalnum())


def contraste(M):
    """Linhas de M já normalizadas, menos a média global e normalizadas de novo."""
    M = M - M.mean(0)
    return M / (np.linalg.norm(M, axis=1, keepdims=True) + 1e-8)


def layout(M):
    """Posição 3D de cada artista, cada eixo em ±32767 cortando as pontas: uma ilha distante espremeria o resto."""
    import umap
    P = umap.UMAP(n_components=3, n_neighbors=K * 2, min_dist=0.25, metric='cosine', random_state=42).fit_transform(M)
    lo, hi = np.percentile(P, [0.3, 99.7], axis=0)
    return np.round(np.clip((P - lo) / (hi - lo) * 2 - 1, -1, 1) * 32767).astype('<i2')


def vizinhos(M):
    """Linhas de M já contrastadas → (índices K-vizinhos, n × K)."""
    n = len(M)
    out = np.zeros((n, K), dtype=np.uint16)
    for i in range(0, n, 512):
        s = M[i:i + 512] @ M.T
        s[np.arange(len(s)), np.arange(i, i + len(s))] = -2       # nunca o próprio artista
        top = np.argpartition(-s, K, axis=1)[:, :K]
        ordem = np.argsort(-np.take_along_axis(s, top, 1), axis=1)
        out[i:i + len(s)] = np.take_along_axis(top, ordem, 1)
    return out


ap = argparse.ArgumentParser()
ap.add_argument('--amostra', nargs='*', default=[], help='imprime os vizinhos destes artistas e não grava nada')
args = ap.parse_args()

artistas = json.loads(subprocess.check_output(['bun', os.path.join(ROOT, 'script/export-faixas-artistas.js')], cwd=ROOT))

rotulos = {}
def ix(l):
    return rotulos.setdefault(l, len(rotulos))

soma_som = {}
soma_rot = defaultdict(Counter)
n_faixas = Counter()
genero = defaultdict(Counter)
acervo_de = defaultdict(Counter)
grafias = defaultdict(Counter)
sem_artista = 0
for a in ACERVOS:
    d = json.load(gzip.open(f'{FEAT}/{a}.json.gz'))
    E = np.memmap(f'{FEAT}/{a}.emb.f16', dtype=np.float16, mode='r').reshape(d['meta']['emb_rows'], d['meta']['emb_dim'])
    alias = json.load(open(f'{FEAT}/aliases-{a}.json'))
    cat = artistas[a]
    for k0, v in d['tracks'].items():
        if not v.get('genre') or v.get('emb') is None:
            continue
        k = unicodedata.normalize('NFC', k0)
        nomes_faixa = cat.get(k) or cat.get(alias.get(k))
        if not nomes_faixa:
            sem_artista += 1
            continue
        e = np.asarray(E[v['emb']], dtype=np.float32)
        e = e / (np.linalg.norm(e) + 1e-8)
        g = np.array([p for _, p in v['genre']], float)
        g /= np.linalg.norm(g) or 1
        for nome in dict.fromkeys(chave(x) for x in nomes_faixa):
            if not nome or nome in FORA:
                continue
            soma_som[nome] = soma_som[nome] + e if nome in soma_som else e.copy()
            for (l, _), p in zip(v['genre'], g):
                soma_rot[nome][ix(l)] += float(p)
            n_faixas[nome] += 1
            genero[nome][v['genre'][0][0]] += 1
            acervo_de[nome][a] += 1
        for x in nomes_faixa:
            grafias[chave(x)][limpar(x)] += 1

# Grafia exibida: a mais comum entre as que têm maiúscula ("Alcione", não "alcione").
exibir = {c: max(g, key=lambda x: (x != x.lower(), g[x])) for c, g in grafias.items()}
nomes = sorted((c for c, q in n_faixas.items() if q >= MIN_FAIXAS and not COLETANEA.search(exibir[c])),
               key=lambda c: (-n_faixas[c], c))
n = len(nomes)
print(f'artistas: {n} de {len(n_faixas)} (com {MIN_FAIXAS}+ faixas); faixas sem artista: {sem_artista}', file=sys.stderr)

S = np.stack([soma_som[x] for x in nomes])
S /= np.linalg.norm(S, axis=1, keepdims=True) + 1e-8
R = np.zeros((n, len(rotulos)), dtype=np.float32)
for i, x in enumerate(nomes):
    for j, p in soma_rot[x].items():
        R[i, j] = p
R /= np.linalg.norm(R, axis=1, keepdims=True) + 1e-8
S, R = contraste(S), contraste(R)
viz = {'som': vizinhos(S), 'rotulos': vizinhos(R)}

if args.amostra is not None and len(args.amostra):
    idx = {x: i for i, x in enumerate(nomes)}
    for q in args.amostra:
        c = chave(q)
        if c not in idx:
            print(f'{q}: fora do grafo ({n_faixas[c]} faixas)')
            continue
        i = idx[c]
        print(f'{exibir[c]} [{genero[c].most_common(1)[0][0]}, {n_faixas[c]} faixas]')
        for m in viz:
            print(f'  {m:8}', ', '.join(exibir[nomes[j]] for j in viz[m][i]))
    sys.exit()

generos = sorted({genero[x].most_common(1)[0][0] for x in nomes})
gi = {g: i for i, g in enumerate(generos)}
b64 = lambda a: base64.b64encode(a.tobytes()).decode()
print('layout: UMAP dos dois mapas…', file=sys.stderr)
payload = {
    'v': 1, 'k': K, 'nomes': [exibir[x] for x in nomes], 'generos': generos,
    'faixas': [n_faixas[x] for x in nomes],
    'genero': [gi[genero[x].most_common(1)[0][0]] for x in nomes],
    'acervo': [ACERVOS.index(acervo_de[x].most_common(1)[0][0]) for x in nomes],
    'acervos': list(ACERVOS),
    'viz': {m: b64(v.astype('<u2')) for m, v in viz.items()},
    'pos': {'som': b64(layout(S)), 'rotulos': b64(layout(R))},
}
dest = os.path.join(ROOT, 'data', 'atlas-artistas.json.gz')
with gzip.GzipFile(dest, 'wb', mtime=0, compresslevel=9) as f:
    f.write(json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode())
print(f'{dest}: {os.path.getsize(dest) / 1024:.0f} KB', file=sys.stderr)
