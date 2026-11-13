#!/usr/bin/env python3
"""build-artistas-parecidos.py — vizinhos de cada artista para o grafo do /atlas.

Dois grafos, nos mesmos espaços dos mapas (script/build-atlas-coords.py), mas sem o UMAP, que distorce
distâncias:
  som     — embedding de áudio EffNet (1280-d) de cada faixa
  rotulos — scores de gênero (Discogs-400, top-5) de cada faixa

Cada artista vira a média das suas faixas (L2 por faixa, depois L2 no artista). Subtrair a média global é o
que dá contraste: sem isso quase todo cosseno passa de 0,9. Ficam os artistas com MIN_FAIXAS ou mais e, para
cada um, os K mais próximos.

Um álbum em que nenhum artista (do álbum ou das faixas) virou nó — pouco material, ou sem artista — ganha os seus
próprios vizinhos: a média das suas faixas, no mesmo espaço de som, contra os artistas do grafo. Vão em `albuns`,
por acervo, com a id de albumShareId() (js/acervo-format.js); o grafo não os desenha, só o "Soa parecido com".

Cada faixa analisada ganha, em `por_faixa`, os 3 candidatos do "Soa parecido com" do seu álbum que mais soam como
ela (máscara de bits sobre o conjunto do álbum), para o player acender as tags conforme a faixa toca.

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

faixa_emb = {a: {} for a in ACERVOS}   # chave do catálogo -> embedding L2 da faixa, para os álbuns fora do grafo
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
        e = np.asarray(E[v['emb']], dtype=np.float32)
        e = e / (np.linalg.norm(e) + 1e-8)
        faixa_emb[a][k if k in cat else alias.get(k, k)] = e
        nomes_faixa = cat.get(k) or cat.get(alias.get(k))
        if not nomes_faixa:
            sem_artista += 1
            continue
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
media_S = S.mean(0)
R = np.zeros((n, len(rotulos)), dtype=np.float32)
for i, x in enumerate(nomes):
    for j, p in soma_rot[x].items():
        R[i, j] = p
R /= np.linalg.norm(R, axis=1, keepdims=True) + 1e-8
S, R = contraste(S), contraste(R)
viz = {'som': vizinhos(S), 'rotulos': vizinhos(R)}

no_grafo = set(nomes)
pos_no = {x: i for i, x in enumerate(nomes)}
albuns = {}
proprios_de = {}   # (acervo, sid) -> nós do grafo creditados no álbum
for a in ACERVOS:
    ids, vetores, sem_faixas = [], [], 0
    for sid, chaves in artistas['_albuns'][a]:
        proprios = list(dict.fromkeys(pos_no[c] for k in chaves for x in artistas[a].get(k, ()) if (c := chave(x)) in pos_no))
        if proprios:
            proprios_de[a, sid] = proprios
            continue
        es = [faixa_emb[a][k] for k in chaves if k in faixa_emb[a]]
        if not es:
            sem_faixas += 1
            continue
        v = np.mean(es, 0)
        v = v / (np.linalg.norm(v) + 1e-8) - media_S
        ids.append(sid)
        vetores.append(v / (np.linalg.norm(v) + 1e-8))
    if len(set(ids)) != len(ids):
        sys.exit(f'{a}: ids de álbum repetidas entre os álbuns fora do grafo')
    out = np.zeros((len(ids), K), dtype=np.uint16)
    for i in range(0, len(ids), 512):
        sim = np.stack(vetores[i:i + 512]) @ S.T
        top = np.argpartition(-sim, K, axis=1)[:, :K]
        out[i:i + len(sim)] = np.take_along_axis(top, np.argsort(-np.take_along_axis(sim, top, 1), axis=1), 1)
    albuns[a] = {'ids': ''.join(ids), 'som': out, 'linha': {sid: out[i] for i, sid in enumerate(ids)}}
    print(f'{a}: {len(ids)} álbuns fora do grafo com vizinhos próprios; {sem_faixas} sem faixa analisada', file=sys.stderr)

# Cada faixa: os FAIXA_K artistas do "Soa parecido com" do seu álbum que mais soam como ela, para o player acender
# as tags conforme a faixa toca. O conjunto do álbum é a união das linhas de vizinhos dos nós creditados nele (`p`, na
# ordem gravada, sem esses nós e sem repetir) ou, sem nó, a sua linha em `albuns`; o player refaz o conjunto com a mesma
# regra (vizFaixa() em js/atlas-data.js) e a luz casa pela id do nó, então a ordem de exibição não precisa ser repetida.
# Por faixa, uma máscara de ceil(len(conjunto)/8) bytes, alinhada às faixas do catálogo pela posição (`n` confere a
# contagem); máscara zerada = faixa sem análise. Álbuns de uma faixa só, ou com menos de duas analisadas, ficam de fora.
FAIXA_K = 3
def conjunto(proprios, linha_album):
    if not proprios:
        return [int(v) for v in linha_album]
    out, fora = [], set(proprios)
    for i in proprios:
        for v in viz['som'][i]:
            v = int(v)
            if v not in fora:
                fora.add(v); out.append(v)
    return out

faixas_viz = {}
for a in ACERVOS:
    ids, ns, ps, mascaras = [], [], [], []
    for sid, chaves in artistas['_albuns'][a]:
        if len(chaves) < 2:
            continue
        proprios = proprios_de.get((a, sid), [])
        linha = albuns[a]['linha'].get(sid)
        if not proprios and linha is None:
            continue
        pool = conjunto(proprios, linha)
        es = [faixa_emb[a].get(k) for k in chaves]
        if sum(e is not None for e in es) < 2 or len(pool) <= FAIXA_K:
            continue
        P = S[pool]
        largura = (len(pool) + 7) // 8
        bloco = np.zeros((len(chaves), largura), dtype=np.uint8)
        for j, e in enumerate(es):
            if e is None:
                continue
            v = e - media_S
            for t in np.argsort(-(P @ (v / (np.linalg.norm(v) + 1e-8))))[:FAIXA_K]:
                bloco[j, t >> 3] |= 1 << (t & 7)
        ids.append(sid); ns.append(len(chaves)); ps.append(proprios); mascaras.append(bloco.ravel())
    faixas_viz[a] = {'ids': ''.join(ids), 'n': ns, 'p': ps, 'm': np.concatenate(mascaras) if mascaras else np.zeros(0, np.uint8)}
    print(f'{a}: {len(ids)} álbuns com vizinhos por faixa', file=sys.stderr)

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
    'albuns': {a: {'ids': v['ids'], 'som': b64(v['som'].astype('<u2'))} for a, v in albuns.items()},
    'fk': FAIXA_K,
    'por_faixa': {a: {'ids': v['ids'], 'n': v['n'], 'p': v['p'], 'm': b64(v['m'])} for a, v in faixas_viz.items()},
}
dest = os.path.join(ROOT, 'data', 'atlas-artistas.json.gz')
with gzip.GzipFile(dest, 'wb', mtime=0, compresslevel=9) as f:
    f.write(json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode())
print(f'{dest}: {os.path.getsize(dest) / 1024:.0f} KB', file=sys.stderr)
