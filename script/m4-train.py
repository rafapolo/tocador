#!/usr/bin/env python3
"""M4 — codificador de texto estático (tabela + média) para o chat do tocador.

Parte de cnmoro/static-retrieval-distilbert-ptbr (29.794 tokens × 512 → PCA 256), treina com
data/qgen/train.jsonl (+ família E, se existir), avalia no gold contra duas linhas de base
(parser+léxico e o estático sem ajuste) e exporta para JS puro:

  data/modelo-texto/modelo-texto.bin    tabela fp16 + cabeças (atributos, tipo, confiança, projeção da consulta)
  data/modelo-texto/tokenizer.json      WordPiece enxuto (vocabulário em ordem de id)
  data/modelo-texto/faixas-idx.bin      índice int8 das faixas no espaço da consulta (128 dim)
  data/modelo-texto/faixas-keys.json.gz [acervo, chave] por linha do índice
  data/modelo-texto/relatorio.json      números do portão
  data/modelo-texto/paridade.json       casos para tests/codificador.test.js

Retreinar depois que a família E crescer: `python3 script/m4-train.py` (relê tudo).
Os pesos ficam fora do git (data/modelo-texto/ está no .gitignore).
"""
import argparse, glob, gzip, hashlib, json, math, os, random, re, struct, sys, time, unicodedata
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'data'
OUT = DATA / 'modelo-texto'
DQ = 'duvidoso'
LIFT_MIN = float(os.environ.get('M4_LIFT', 0.25))  # ganho mínimo sobre a probabilidade média da coluna para a busca impor o atributo
PRIOR = None     # probabilidade média de cada coluna sobre perguntas de treino; calculada depois do treino
NEG0 = float(os.environ.get('M4_NEG0', 0.0))        # peso do alvo "não pedido" nas colunas que o rótulo não cobre
HYB_THR = float(os.environ.get('M4_THR', 0.5))    # confiança mínima para o modelo impor um atributo na busca
FORA_W = 4.0     # peso da classe "fora do domínio" no tipo: recusar errado custa menos que chutar
A_WEIGHT = 0.4   # as etiquetas derivadas do áudio são ruidosas: pesam menos que as palavras do pedido
TIPOS = ['busca', 'referencial', 'fora']
GOLD_TIPO = {'busca': 0, 'referencial': 1, 'fora_do_dominio': 2}
DIM, RDIM = 256, 128          # tabela e espaço de recuperação
SCAL = ['voice', 'dance', 'acoustic', 'electronic', 'happy', 'sad', 'relaxed', 'aggressive', 'party']

# ── utilidades ───────────────────────────────────────────────────────────

def fold(s):
    s = unicodedata.normalize('NFD', s.lower())
    return ''.join(c for c in s if unicodedata.category(c) != 'Mn')

def strip_acc(s):
    s = unicodedata.normalize('NFD', s)
    return unicodedata.normalize('NFC', ''.join(c for c in s if unicodedata.category(c) != 'Mn'))

def norm_text(s):
    return re.sub(r'\s+', ' ', s.lower()).strip()

def find_ontology():
    if os.environ.get('M4_ONT'):
        return json.load(open(os.environ['M4_ONT']))
    for p in [DATA / 'ontologia-musical.json', *(ROOT.parents[i] / 'data' / 'ontologia-musical.json' for i in range(min(3, len(ROOT.parents))))]:
        if p.exists():
            return json.load(open(p))
    sys.exit('ontologia-musical.json não encontrada')

ONT = find_ontology()
GR = {  # grupo -> ids
    'genero': [g['id'] for g in ONT['generos']],
    'humor': [h['id'] for h in ONT['humores']],
    'instrumento': [h['id'] for h in ONT['instrumentos']],
    'andamento': [a['id'] for a in ONT['andamentos']],
    'voz': [v['id'] for v in ONT['voz']],
}
COL, GSLICE = {}, {}
GR_NAME = []
n = 0
for g, ids in GR.items():
    GSLICE[g] = (n, n + len(ids))
    for i in ids:
        COL[(g, i)] = n
        GR_NAME.append(f'{g}:{i}')
        n += 1
NC = n
PARENT = {g['id']: g['pai'] for g in ONT['generos']}
ID_BY_FOLD = {g: {fold(i): i for i in ids} for g, ids in GR.items()}

def ancestors(g):
    out = []
    while PARENT.get(g):
        g = PARENT[g]
        out.append(g)
    return out

def gmatch(a, b):  # leniente: igual ou um descende do outro
    return a == b or a in ancestors(b) or b in ancestors(a)

def canon(group, v):
    return ID_BY_FOLD[group].get(fold(v)) if isinstance(v, str) else None

# ── faixas: atributos derivados das features + vetor de alvo ─────────────

def load_tracks(log):
    tracks = []  # dicts: acervo, key, year, attr(bool NC), valid(bool NC), feat(float)
    emb_parts = []
    gmap = ONT['discogs']['mapa']
    humors = {h['id']: h for h in ONT['humores']}
    inst_map = {}
    for i in ONT['instrumentos']:
        for e in i.get('essentia', []):
            inst_map.setdefault(e, []).append(i['id'])
    ranges = [(a['id'], a['bpm'][0], a['bpm'][1]) for a in ONT['andamentos']]
    for acervo in ['homi', 'uqt']:
        d = json.load(gzip.open(DATA / 'features' / f'{acervo}.json.gz'))
        emb = np.memmap(DATA / 'features' / f'{acervo}.emb.f16', dtype=np.float16, mode='r').reshape(-1, d['meta']['emb_dim'])
        rows = []
        for key, r in d['tracks'].items():
            if r.get('emb') is None or r.get('error'):
                continue
            attr = np.zeros(NC, bool)
            valid = np.zeros(NC, bool)
            gs = defaultdict(float)
            for c, p in r.get('genre', [])[:5]:
                for m in gmap.get(c, []):
                    gs[m['genero']] += p * m['peso']
            if gs:
                top = max(gs, key=gs.get)
                for g in [top, *ancestors(top)]:
                    attr[COL[('genero', g)]] = True
                a, b = GSLICE['genero']
                valid[a:b] = True
            bpm = r.get('bpm') or 0
            if 30 <= bpm <= 300 and not r.get('bpm_suspeito'):
                for i, lo, hi in ranges:
                    if lo <= bpm < hi or (i == ranges[-1][0] and bpm >= lo):
                        attr[COL[('andamento', i)]] = True
                a, b = GSLICE['andamento']
                valid[a:b] = True
            vc = r.get('voice')
            if vc is not None:
                attr[COL[('voz', 'cantada' if vc >= 0.5 else 'instrumental')]] = True
                a, b = GSLICE['voz']
                valid[a:b] = True
            for hid, h in humors.items():
                sig = h.get('sinais') or {}
                if not h.get('medido') or not sig:
                    continue
                ok = True
                for f, lvl in sig.items():
                    x = r.get(f)
                    if x is None or (lvl == 'alto' and x < 0.6) or (lvl == 'baixo' and x > 0.4):
                        ok = False
                valid[COL[('humor', hid)]] = True
                attr[COL[('humor', hid)]] = ok
            for i in ONT['instrumentos']:
                if i.get('medido') and i.get('essentia'):
                    valid[COL[('instrumento', i['id'])]] = True
            for nm, p in r.get('inst', []):
                if p >= 0.3:
                    for iid in inst_map.get(nm, []):
                        attr[COL[('instrumento', iid)]] = True
            m = re.match(r'(\d{4}) - ', key)
            year = int(m.group(1)) if m else 0
            sc = [r.get(s) if r.get(s) is not None else np.nan for s in SCAL]
            tracks.append(dict(acervo=acervo, key=key, year=year, attr=attr, valid=valid,
                               scal=[(bpm if 30 <= bpm <= 300 and not r.get('bpm_suspeito') else np.nan)] + sc))
            rows.append(r['emb'])
        emb_parts.append((emb, np.array(rows)))
        log(f'  {acervo}: {len(rows)} faixas com embedding')
    return tracks, emb_parts

def track_matrix(tracks, emb_parts, log):
    from sklearn.decomposition import PCA
    rng = np.random.default_rng(0)
    sample = []
    for e, idx in emb_parts:
        pick = rng.choice(idx, size=min(len(idx), 20000), replace=False)
        sample.append(e[np.sort(pick)].astype(np.float32))
    pca = PCA(128, svd_solver='randomized', random_state=0).fit(np.concatenate(sample))
    scale = float(np.sqrt(pca.explained_variance_[0]))
    parts = []
    for e, idx in emb_parts:
        for s in range(0, len(idx), 20000):
            parts.append(pca.transform(e[idx[s:s + 20000]].astype(np.float32)) / scale)
    pcs = np.concatenate(parts).astype(np.float32)
    sc = np.array([t['scal'] for t in tracks], np.float64)
    mu, sd = np.nanmean(sc, 0), np.nanstd(sc, 0) + 1e-6
    z = np.nan_to_num((sc - mu) / sd, nan=0.0).astype(np.float32)
    yr = np.array([t['year'] for t in tracks], np.float64)
    ok = yr > 0
    ymu, ysd = yr[ok].mean(), yr[ok].std()
    zy = np.where(ok, (yr - ymu) / ysd, 0.0).astype(np.float32)[:, None]
    feats = np.concatenate([pcs, z, zy], 1)
    log(f'  vetor de faixa: {feats.shape} (PCA-128 + {z.shape[1]} escalares + ano)')
    return feats

# ── perguntas ────────────────────────────────────────────────────────────

HELD = {norm_text(json.loads(l)['q']) for l in open(DATA / 'qgen' / 'gold' / 'gold-real.jsonl')} if (DATA / 'qgen' / 'gold' / 'gold-real.jsonl').exists() else set()   # a avaliação de registro real nunca entra no treino
E_TIPO = [('pedido referencial', 1), ('comando solto', 2), ('pergunta sobre o próprio', 2), ('pedido de status', 2)]

def load_rows(tracks, log):
    index = {(t['acervo'], t['key']): i for i, t in enumerate(tracks)}
    attr = np.stack([t['attr'] for t in tracks])
    years = np.array([t['year'] for t in tracks])
    rng = np.random.default_rng(1)
    rows, skipped = [], defaultdict(int)

    def blank(text, fam, tipo, conf, rid, folder=None):
        return dict(text=norm_text(text), fam=fam, tipo=tipo, conf=conf, id=rid, folder=folder or rid,
                    y=np.zeros(NC, np.float32), m=np.zeros(NC, np.float32), pos=None, cands=None)

    def set_group(r, group, pos_ids, weight_neg=0.5):
        a, b = GSLICE[group]
        r['m'][a:b] = weight_neg
        for i in pos_ids:
            r['y'][COL[(group, i)]] = 1.0
            r['m'][COL[(group, i)]] = 1.0

    for line in open(DATA / 'qgen' / 'train.jsonl'):
        q = json.loads(line)
        fam = q['family']
        if q.get('quality') == DQ and fam == 'D':
            skipped['duvidoso'] += 1
            continue
        if fam == 'A':
            ti = index.get((q['acervo'], q['key']))
            if ti is None:
                skipped['A sem faixa'] += 1
                continue
            r = blank(q['q'], 'A', 0, 1.0, q['id'], q['key'].split('/')[0])
            r['pos'] = ti
            t = tracks[ti]
            r['y'] = t['attr'].astype(np.float32)
            r['m'] = (np.where(t['valid'], np.where(t['attr'], 1.0, 0.5), 0.0) * A_WEIGHT).astype(np.float32)
            # humor, instrumento e andamento vindos do áudio (BPM em oitava errada, "sinais" frouxos) contradizem o texto:
            # só gênero e voz da faixa supervisionam o texto; o resto vem do filtro (B) e das palavras do pedido
            for g_ in ('humor', 'instrumento', 'andamento'):
                r['m'][GSLICE[g_][0]:GSLICE[g_][1]] = 0.0
            rows.append(r)
        elif fam == 'B':
            f = q['filtro']
            r = blank(q['q'], 'B', 0, 1.0, q['id'])
            cond = np.ones(len(tracks), bool)
            specified = False
            g = canon('genero', f.get('genero'))
            if g:
                set_group(r, 'genero', [g, *ancestors(g)])
                cond &= attr[:, COL[('genero', g)]]
                specified = True
            for key, group in [('humor', 'humor'), ('instrumento', 'instrumento'), ('andamento', 'andamento'), ('voz', 'voz')]:
                v = canon(group, f.get(key))
                if v:
                    set_group(r, group, [v], 0.3 if group in ('humor', 'instrumento') else 0.5)
                    cond &= attr[:, COL[(group, v)]]
                    specified = True
            s = canon('instrumento', f.get('sem'))
            if s:
                r['y'][COL[('instrumento', s)]] = 0.0
                r['m'][COL[('instrumento', s)]] = 1.0
                cond &= ~attr[:, COL[('instrumento', s)]]
            if f.get('decada'):
                cond &= (years >= f['decada']) & (years < f['decada'] + 10)
            if f.get('intervalo'):
                cond &= (years >= f['intervalo'][0]) & (years <= f['intervalo'][1])
            if not specified and not r['m'].any():
                skipped['B sem atributo'] += 1
            c = np.flatnonzero(cond)
            if len(c):
                r['cands'] = rng.choice(c, size=min(len(c), 64), replace=False)
            rows.append(r)
        elif fam == 'C':
            rows.append(blank(q['q'], 'C', 1, 1.0, q['id']))
        elif fam == 'D':
            r = blank(q['q'], 'D', 2, 0.0, q['id'])
            r['m'][:] = 0.3          # nada musical a extrair: todas as colunas ~0
            rows.append(r)
    # família E (estilo real) — o que já existir
    ne = 0
    for f in sorted(glob.glob(str(DATA / 'qgen' / 'in' / 'E0*.jsonl'))):
        cats = {}
        for l in open(f):
            j = json.loads(l)
            cats[j['id']] = j['categoria']
        of = DATA / 'qgen' / 'out' / os.path.basename(f)
        if not of.exists():
            continue
        for l in open(of):
            try:
                j = json.loads(l)
            except ValueError:
                continue
            cat = cats.get(j.get('id'))
            if not cat or not isinstance(j.get('q'), str) or not j['q'].strip():
                continue
            if norm_text(j['q']) in HELD:
                continue
            tipo = next((t for k, t in E_TIPO if cat.startswith(k)), 0)
            r = blank(j['q'], 'E', tipo, 0.0 if tipo == 2 else 1.0, j['id'])
            if tipo == 2:
                r['m'][:] = 0.3
            rows.append(r)
            ne += 1
    # mundo fechado fraco: o que o pedido não menciona provavelmente não é pedido (sem isso o modelo inventa humores)
    for r in rows:
        if r['tipo'] != 2:
            r['m'][r['m'] == 0] = NEG0
    # rótulos fracos pelo léxico: palavra explícita do pedido vira alvo positivo (o aumento de texto
    # — sem acento, sem pontuação — ensina o modelo a reconhecê-la também quando digitada de outro jeito)
    for r in rows:
        if r['tipo'] == 2:
            continue
        for group, ids in lex_predict(r['text'])[0].items():
            for i in ids:
                for j in ([i, *ancestors(i)] if group == 'genero' else [i]):
                    r['y'][COL[(group, j)]] = 1.0
                    r['m'][COL[(group, j)]] = 1.0
    log(f'  perguntas: {len(rows)} (E: {ne}); descartadas: {dict(skipped)}')
    return rows

# ── tokenização / modelo ─────────────────────────────────────────────────

class Tok:
    def __init__(self, path):
        from tokenizers import Tokenizer
        self.t = Tokenizer.from_file(str(path))
        self.t.no_padding()
        self.vocab = self.t.get_vocab()
    def ids(self, texts):
        return [e.ids or [] for e in self.t.encode_batch(texts, add_special_tokens=False)]

def augment(text, rng):
    if rng.random() < 0.35:
        text = strip_acc(text)
    if rng.random() < 0.25:
        text = re.sub(r'[^\w\s]', ' ', text)
    return norm_text(text)

class Enc(nn.Module):
    def __init__(self, table):
        super().__init__()
        self.emb = nn.EmbeddingBag(table.shape[0], DIM, mode='mean')
        self.emb.weight.data.copy_(torch.from_numpy(table))
        self.mlp1 = nn.Linear(DIM, 512)
        self.mlp2 = nn.Linear(512, DIM)
        nn.init.zeros_(self.mlp2.weight)
        nn.init.zeros_(self.mlp2.bias)
        self.attr = nn.Linear(DIM, NC)
        self.tipo = nn.Linear(DIM, len(TIPOS))
        self.conf = nn.Linear(DIM, 1)
        self.q = nn.Linear(DIM, RDIM)
        self.t = nn.Linear(139, RDIM, bias=False)
        self.logit_temp = nn.Parameter(torch.tensor(math.log(1 / 0.07)))
    def encode(self, flat, offs):
        return F.normalize(self.emb(flat, offs), dim=-1)
    def heads(self, h):
        h = h + self.mlp2(F.gelu(self.mlp1(h)))
        return self.attr(h), self.tipo(h), self.conf(h).squeeze(-1), F.normalize(self.q(h), dim=-1)

def proto_init(model, tok, table):
    """cabeça de atributos começa como o estático sem ajuste: cosseno com o protótipo (nome + apelidos) de cada classe."""
    items = {'genero': ONT['generos'], 'humor': ONT['humores'], 'instrumento': ONT['instrumentos'],
             'andamento': ONT['andamentos'], 'voz': ONT['voz']}
    W = np.zeros((NC, DIM), np.float32)
    for g, its in items.items():
        for it in its:
            ids = tok.ids([norm_text(' '.join([it['id'], *it.get('apelidos', [])]))])[0]
            if ids:
                v = table[ids].mean(0)
                W[COL[(g, it['id'])]] = v / (np.linalg.norm(v) + 1e-9)
    model.attr.weight.data.copy_(torch.from_numpy(W * 8.0))
    model.attr.bias.data.fill_(-4.0)

def batchify(idlists, rng=None, drop=0.0):
    flat, offs, k = [], [], 0
    for ids in idlists:
        if drop and rng is not None and len(ids) > 1:
            kept = [i for i in ids if rng.random() > drop] or [ids[rng.randrange(len(ids))]]
            ids = kept
        offs.append(k)
        flat.extend(ids)
        k += len(ids)
    return torch.tensor(flat, dtype=torch.long), torch.tensor(offs, dtype=torch.long)

def init_table(src):
    from safetensors.numpy import load_file
    E = load_file(str(src / 'model.safetensors'))['embedding.weight'].astype(np.float32)
    mu = E.mean(0)
    _, _, vt = np.linalg.svd(E - mu, full_matrices=False)
    return ((E - mu) @ vt[:DIM].T).astype(np.float32), E

# ── treino ───────────────────────────────────────────────────────────────

def train(rows, tok, table, feats, epochs, bs, log, seed=0):
    torch.manual_seed(seed)
    rng = random.Random(seed)
    model = Enc(table)
    proto_init(model, tok, table)
    ft = torch.from_numpy(feats)
    val = [i for i, r in enumerate(rows) if int(hashlib.md5(r['folder'].encode()).hexdigest(), 16) % 33 == 0]
    vset = set(val)
    tr = [i for i in range(len(rows)) if i not in vset]
    log(f'  treino {len(tr)} · validação {len(val)} (por álbum/id)')
    opt = torch.optim.AdamW([
        {'params': model.emb.parameters(), 'lr': 2e-3, 'weight_decay': 0.0},
        {'params': [p for n_, p in model.named_parameters() if not n_.startswith('emb.')], 'lr': 2e-3, 'weight_decay': 1e-4}])
    steps = epochs * ((len(tr) + bs - 1) // bs)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=[2e-3, 2e-3], total_steps=steps, pct_start=0.1)
    Y = torch.from_numpy(np.stack([r['y'] for r in rows]))
    M = torch.from_numpy(np.stack([r['m'] for r in rows]))
    TP = torch.tensor([r['tipo'] for r in rows])
    CF = torch.tensor([r['conf'] for r in rows], dtype=torch.float32)

    def loss_on(idx, train_mode):
        texts = [augment(rows[i]['text'], rng) if train_mode else rows[i]['text'] for i in idx]
        flat, offs = batchify(tok.ids(texts), rng, 0.1 if train_mode else 0.0)
        h = model.encode(flat, offs)
        la, lt, lc, q = model.heads(h)
        ix = torch.tensor(idx)
        m = M[ix]
        l_attr = (F.binary_cross_entropy_with_logits(la, Y[ix], reduction='none') * m).sum() / m.sum().clamp(min=1)
        l_tipo = F.cross_entropy(lt, TP[ix], weight=torch.tensor([1.0, 1.0, FORA_W]), label_smoothing=0.05)
        l_conf = F.binary_cross_entropy_with_logits(lc, CF[ix])
        # InfoNCE: positivo = faixa de origem (A) ou uma faixa que cumpre o filtro (B)
        pos = []
        for i in idx:
            r = rows[i]
            if r['pos'] is not None:
                pos.append(r['pos'])
            elif r['cands'] is not None:
                pos.append(int(r['cands'][rng.randrange(len(r['cands']))]))
            else:
                pos.append(-1)
        pos_t = torch.tensor(pos)
        has = pos_t >= 0
        if has.sum() > 1:
            neg = torch.randint(0, ft.shape[0], (2048,))
            tv = F.normalize(model.t(ft[torch.cat([pos_t[has], neg])]), dim=-1)
            logits = q[has] @ tv.T * model.logit_temp.exp().clamp(max=100)
            pp = pos_t[has]
            same = pp[:, None] == torch.cat([pp, neg])[None, :]
            eye = torch.zeros_like(same)
            eye[torch.arange(len(pp)), torch.arange(len(pp))] = True
            logits = logits.masked_fill(same & ~eye, -1e9)
            l_nce = F.cross_entropy(logits, torch.arange(len(pp)))
        else:
            l_nce = torch.zeros(())
        return 2 * l_attr + l_tipo + 0.5 * l_conf + l_nce, (l_attr.item(), l_tipo.item(), l_conf.item(), l_nce.item())

    best, best_state = 1e9, None
    for ep in range(epochs):
        model.train()
        order = tr[:]
        rng.shuffle(order)
        t0, acc = time.time(), np.zeros(4)
        for s in range(0, len(order), bs):
            loss, parts = loss_on(order[s:s + bs], True)
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            acc += parts
        model.eval()
        with torch.no_grad():
            vl = np.zeros(4)
            nb = 0
            for s in range(0, len(val), 512):
                _, parts = loss_on(val[s:s + 512], False)
                vl += parts
                nb += 1
            vl /= max(nb, 1)
        nbat = (len(order) + bs - 1) // bs
        log(f'  época {ep + 1}/{epochs}  treino attr/tipo/conf/nce {np.round(acc / nbat, 3).tolist()}  val {np.round(vl, 3).tolist()}  ({time.time() - t0:.0f}s)')
        vtot = 2 * vl[0] + vl[1] + 0.5 * vl[2] + vl[3]
        if vtot < best:
            best, best_state = vtot, {k: v.clone() for k, v in model.state_dict().items()}
    model.load_state_dict(best_state)
    log(f'  melhor validação: {best:.3f}')
    return model

# ── avaliação (gold) e linhas de base ────────────────────────────────────

def lexicon():
    terms = []  # (group, id, folded term)
    for g, items in [('genero', ONT['generos']), ('humor', ONT['humores']), ('instrumento', ONT['instrumentos']),
                     ('andamento', ONT['andamentos']), ('voz', ONT['voz'])]:
        for it in items:
            for t in {it['id'], it.get('nome', it['id']), *it.get('apelidos', [])}:
                terms.append((g, it['id'], fold(t)))
    return terms

LEX = lexicon()
REF_RE = re.compile(r'\b(mais|menos)\b.*\bque\b|parecid|\btipo\b|\bcomo (o|a|os|as)\b|igual|oposto|contrario|semelhante|\bmesmo\b')
PERIOD_RE = re.compile(r'\b(19[3-9]\d|20[0-3]\d|anos? \d0|decada|\d0s)\b')

def parse_period(text):
    """período dito no pedido -> (ano_ini, ano_fim) ou None; é o que o parser do chat já faz (décadas, anos, intervalos)."""
    f = fold(text)
    m = re.search(r'\bentre (19[3-9]\d|20[0-3]\d) e (19[3-9]\d|20[0-3]\d)\b', f)
    if m:
        return int(m.group(1)), int(m.group(2))
    m = re.search(r'\bantes de (19[3-9]\d|20[0-3]\d)\b', f)
    if m:
        return 1900, int(m.group(1)) - 1
    m = re.search(r'\b(?:depois|apos) de (19[3-9]\d|20[0-3]\d)\b', f)
    if m:
        return int(m.group(1)) + 1, 2030
    m = re.search(r'\b(?:anos?|decada de|decada)\s*(?:de\s*)?(19\d0|20\d0|\d0)s?\b', f) or re.search(r'\b(\d0)s\b', f)
    if m:
        d = m.group(1)
        d = int(d) if len(d) == 4 else (1900 + int(d) if int(d) >= 30 else 2000 + int(d))
        return d, d + 9
    m = re.search(r'\b(19[3-9]\d|20[0-3]\d)\b', f)
    return (int(m.group(1)),) * 2 if m else None

def lex_predict(text):
    f = ' ' + re.sub(r'[^\w\s]', ' ', fold(text)) + ' '
    hits = []
    for g, i, t in LEX:
        m = re.search(r'(?<!\w)' + re.escape(t) + r'(?!\w)', f)
        if m:
            hits.append((m.start(), -len(t), g, i))
    hits.sort()
    out = defaultdict(list)
    for _, _, g, i in hits:
        if i not in out[g]:
            out[g].append(i)
    tipo = 1 if REF_RE.search(fold(text)) else (0 if (out or PERIOD_RE.search(fold(text))) else 2)
    return out, tipo

def gold_rows(name='gold.jsonl'):
    out = []
    for l in open(DATA / 'qgen' / 'gold' / name):
        j = json.loads(l)
        lb = j['label']
        out.append(dict(q=j['q'], tipo=GOLD_TIPO[lb['tipo']], res=bool(lb.get('resolvivel')),
                        genero=[c for c in (canon('genero', x) for x in lb.get('generos', [])) if c],
                        humor=[c for c in (canon('humor', x) for x in lb.get('humor', [])) if c],
                        instrumento=[c for c in (canon('instrumento', x) for x in lb.get('instrumentos', [])) if c],
                        andamento=canon('andamento', lb.get('andamento')), voz=canon('voz', lb.get('voz')),
                        periodo=lb.get('periodo'), excluir=lb.get('excluir') or []))
    return out

def hit(group, preds, gold, k):
    if group == 'genero':
        return any(gmatch(p, g) for p in preds[:k] for g in gold)
    return any(p in gold for p in preds[:k])

def attr_metrics(gold, preds_by_item):
    res = {}
    for group in ['genero', 'humor', 'andamento', 'instrumento', 'voz']:
        h1 = h3 = n_ = 0
        for g, p in zip(gold, preds_by_item):
            gv = g[group] if isinstance(g[group], list) else ([g[group]] if g[group] else [])
            if not gv or g['tipo'] != 0 or not g['res']:
                continue
            n_ += 1
            pl = p.get(group, [])
            h1 += hit(group, pl, gv, 1)
            h3 += hit(group, pl, gv, 3)
        res[group] = dict(n=n_, top1=round(h1 / max(n_, 1), 3), top3=round(h3 / max(n_, 1), 3))
    return res

def item_mask(g, attr, years):
    """quais faixas cumprem todos os atributos do item do gold (gênero e humor: qualquer um dos citados)."""
    conds = []
    if g['genero']:
        conds.append(np.logical_or.reduce([attr[:, COL[('genero', x)]] for x in g['genero']]))
    for grp in ['humor', 'instrumento']:
        if g[grp]:
            conds.append(np.logical_or.reduce([attr[:, COL[(grp, x)]] for x in g[grp]]))
    for grp in ['andamento', 'voz']:
        if g[grp]:
            conds.append(attr[:, COL[(grp, g[grp])]])
    p = g.get('periodo')
    if p and p.get('ano'):
        conds.append(years == p['ano'])
    elif p and p.get('decada'):
        conds.append((years >= p['decada']) & (years < p['decada'] + 10))
    return np.logical_and.reduce(conds) if conds else None

def acerto_k(items, retrieved, attr, years):
    """fração das faixas devolvidas que cumprem todos os atributos do item."""
    tot = n_ = 0
    for g, idx in zip(items, retrieved):
        m = item_mask(g, attr, years)
        if m is None:
            continue
        n_ += 1
        tot += m[idx].mean()
    return round(tot / max(n_, 1), 3), n_

def teto_k(items, attr, years, k=10):
    """melhor acerto possível: o catálogo não tem k faixas que cumpram tudo em alguns itens."""
    v = [min(k, int(m.sum())) / k for m in (item_mask(g, attr, years) for g in items) if m is not None]
    return round(float(np.mean(v)), 3)

def model_outputs(model, tok, texts, sg=False):
    model.eval()
    with torch.no_grad():
        if sg:
            texts = [strip_acc(t) for t in texts]
        flat, offs = batchify(tok.ids([norm_text(t) for t in texts]))
        h = model.encode(flat, offs)
        la, lt, lc, q = model.heads(h)
    return la.numpy(), torch.softmax(lt, -1).numpy(), torch.sigmoid(lc).numpy(), q.numpy()

def top_ids(logits_row, group, k=3):
    a, b = GSLICE[group]
    o = np.argsort(-logits_row[a:b])[:k]
    return [GR[group][i] for i in o]

def hybrid_search(logits, qvec, text, tvec, attr, years, k=10, thr=HYB_THR):
    """filtro por atributos que o modelo leu com confiança (um por grupo) + período do parser; ordena pelo vetor.
    Se sobrar menos de k faixas, larga a condição menos confiante e tenta de novo."""
    p = 1 / (1 + np.exp(-logits))
    conds = []
    for grp in GR:
        a, b = GSLICE[grp]
        j = int(np.argmax(p[a:b]))
        lift = float(p[a + j] - PRIOR[a + j])      # só conta o que a frase acrescentou ao que já se espera de qualquer pedido
        if p[a + j] >= thr and lift >= LIFT_MIN:
            conds.append((lift, a + j))
    conds.sort()
    per = parse_period(text)
    pmask = np.ones(len(years), bool) if not per else (years >= per[0]) & (years <= per[1])
    while True:
        cond = pmask.copy()
        for _, c in conds:
            cond &= attr[:, c]
        cand = np.flatnonzero(cond)
        if len(cand) >= k or (not conds and not per):
            break
        if conds:
            conds.pop(0)
        else:
            pmask = np.ones(len(years), bool)
            per = None
    if len(cand) < k:
        cand = np.arange(len(years))
    return cand[np.argsort(-(tvec[cand] @ qvec))[:k]]

def evaluate(model, tok, gold, tvec, attr, years, E512, tok_orig, log, sg=False):
    texts = [g['q'] for g in gold]
    la, pt, pc, q = model_outputs(model, tok, texts, sg)
    preds = [{grp: top_ids(la[i], grp) for grp in GR} for i in range(len(gold))]
    am = attr_metrics(gold, preds)
    tipo_pred = pt.argmax(1)
    gt = np.array([g['tipo'] for g in gold])
    tipo = dict(acc=round(float((tipo_pred == gt).mean()), 3),
                recusa_correta=round(float((tipo_pred[gt == 2] == 2).mean()), 3),
                falsa_recusa=round(float((tipo_pred[gt != 2] == 2).mean()), 3))
    # recuperação
    r_items, r_idx, h_idx = [], [], []
    for i, g in enumerate(gold):
        if g['tipo'] == 0 and g['res'] and (g['genero'] or g['humor'] or g['andamento'] or g['voz'] or g['instrumento'] or g['periodo']):
            r_items.append(g)
            r_idx.append(np.argsort(-(tvec @ q[i]))[:10])
            h_idx.append(hybrid_search(la[i], q[i], g['q'], tvec, attr, years))
    rec_v, nrec = acerto_k(r_items, r_idx, attr, years)
    rec, _ = acerto_k(r_items, h_idx, attr, years)
    if os.environ.get('M4_DIAG'):
        for g, idx, i in zip(r_items, h_idx, [i for i, g in enumerate(gold) if g['tipo'] == 0 and g['res'] and (g['genero'] or g['humor'] or g['andamento'] or g['voz'] or g['instrumento'] or g['periodo'])]):
            m = item_mask(g, attr, years)
            if m is None:
                continue
            ms = m[idx].mean()
            lp = lex_predict(g['q'])[0]
            lc = np.ones(len(years), bool)
            for grp in GR:
                if lp.get(grp):
                    lc &= attr[:, COL[(grp, lp[grp][0])]]
            per = parse_period(g['q'])
            if per:
                lc &= (years >= per[0]) & (years <= per[1])
            lm = m[lc].mean() if lc.any() else m.mean()
            if abs(ms - lm) > 0.3:
                pp = 1 / (1 + np.exp(-la[i]))
                imposed = [(GR_NAME[c], round(float(pp[c]), 2)) for c in range(NC) if pp[c] >= HYB_THR and pp[c] - PRIOR[c] >= LIFT_MIN]
                log(f'  {"+" if ms > lm else "-"} modelo {ms:.2f} léxico {lm:.2f} {g["q"][:70]!r} gold={ {k: g[k] for k in ("genero","humor","andamento","voz","instrumento","periodo") if g[k]} } modelo={imposed} lex={dict(lp)} pool={int(m.sum())}')

    rng = np.random.default_rng(0)
    chance, _ = acerto_k(r_items, [rng.integers(0, len(years), 10) for _ in r_items], attr, years)
    return dict(tipo=tipo, atributos=am, recall10=rec, recall10_vetor=rec_v, recall10_teto=teto_k(r_items, attr, years), recall10_n=nrec, recall10_acaso=chance), (la, pt, pc, q)

def baseline_lex(gold, attr, years):
    preds, tp = [], []
    rng = np.random.default_rng(0)
    for g in gold:
        p, t = lex_predict(g['q'])
        preds.append(dict(p))
        tp.append(t)
    am = attr_metrics(gold, preds)
    gt = np.array([g['tipo'] for g in gold])
    tp = np.array(tp)
    tipo = dict(acc=round(float((tp == gt).mean()), 3), recusa_correta=round(float((tp[gt == 2] == 2).mean()), 3),
                falsa_recusa=round(float((tp[gt != 2] == 2).mean()), 3))
    r_items, r_idx = [], []
    for g, p in zip(gold, preds):
        if g['tipo'] == 0 and g['res'] and (g['genero'] or g['humor'] or g['andamento'] or g['voz'] or g['instrumento'] or g['periodo']):
            cond = np.ones(len(years), bool)
            if p.get('genero'):
                cond &= attr[:, COL[('genero', p['genero'][0])]]
            if p.get('humor'):
                cond &= attr[:, COL[('humor', p['humor'][0])]]
            if p.get('andamento'):
                cond &= attr[:, COL[('andamento', p['andamento'][0])]]
            if p.get('voz'):
                cond &= attr[:, COL[('voz', p['voz'][0])]]
            if p.get('instrumento'):
                cond &= attr[:, COL[('instrumento', p['instrumento'][0])]]
            per = parse_period(g['q'])
            if per:
                cond &= (years >= per[0]) & (years <= per[1])
            c = np.flatnonzero(cond)
            if not len(c):
                c = np.arange(len(years))
            r_items.append(g)
            r_idx.append(c)          # sorteio entre todas as que passam no filtro: o acerto esperado é a média sobre elas
    rec, nrec = acerto_k(r_items, r_idx, attr, years)
    return dict(tipo=tipo, atributos=am, recall10=rec, recall10_n=nrec)

def baseline_static(gold, tok_orig, E512):
    """estático sem ajuste: cosseno entre a média dos vetores da frase e a média dos vetores do nome+apelidos da classe."""
    def emb(texts):
        ids = tok_orig.ids([norm_text(t) for t in texts])
        out = np.zeros((len(ids), E512.shape[1]), np.float32)
        for i, l in enumerate(ids):
            if l:
                out[i] = E512[l].mean(0)
        n_ = np.linalg.norm(out, axis=1, keepdims=True)
        return out / np.maximum(n_, 1e-9)
    protos = {}
    for g, items in [('genero', ONT['generos']), ('humor', ONT['humores']), ('instrumento', ONT['instrumentos']),
                     ('andamento', ONT['andamentos']), ('voz', ONT['voz'])]:
        protos[g] = emb([' '.join([it['id'], *it.get('apelidos', [])]) for it in items])
    Q = emb([g['q'] for g in gold])
    preds = [{g: [GR[g][j] for j in np.argsort(-(protos[g] @ Q[i]))[:3]] for g in GR} for i in range(len(gold))]
    return dict(atributos=attr_metrics(gold, preds))

# ── exportação ───────────────────────────────────────────────────────────

def f16(a):
    return np.ascontiguousarray(a.astype(np.float16)).tobytes()

def export(model, tok_path, tracks, feats, log, int8_table=False):
    OUT.mkdir(parents=True, exist_ok=True)
    sd = {k: v.detach().numpy() for k, v in model.state_dict().items()}
    table = sd['emb.weight'].astype(np.float16)
    sections, blobs, off = [], [], 0

    def add(name, arr, dtype):
        nonlocal off
        b = f16(arr) if dtype == 'f16' else np.ascontiguousarray(arr.astype(np.float32)).tobytes()
        sections.append(dict(name=name, dtype=dtype, shape=list(arr.shape), offset=off))
        blobs.append(b)
        off += len(b)
        pad = (-off) % 4
        if pad:
            blobs.append(b'\0' * pad)
            off += pad
    add('table', table, 'f16')
    for nm in ['mlp1', 'mlp2', 'attr', 'tipo', 'conf', 'q']:
        add(f'{nm}.w', sd[f'{nm}.weight'], 'f32')
        add(f'{nm}.b', sd[f'{nm}.bias'], 'f32')
    header = dict(version=1, vocab=int(table.shape[0]), dim=DIM, rdim=RDIM, tipos=TIPOS, groups=GR, prior=[round(float(x), 4) for x in PRIOR],
                  busca=dict(limiar=HYB_THR, ganho_minimo=LIFT_MIN),
                  columns={g: list(GSLICE[g]) for g in GR}, sections=sections,
                  normalizacao='minúsculas; sem acentos só se o usuário digitou assim; sem [CLS]/[SEP]')
    hb = json.dumps(header, ensure_ascii=False).encode()
    pad = (-(12 + len(hb))) % 4
    with open(OUT / 'modelo-texto.bin', 'wb') as f:
        f.write(b'TXT1' + struct.pack('<II', 1, len(hb) + pad) + hb + b' ' * pad)
        for b in blobs:
            f.write(b)
    # tokenizador enxuto
    tj = json.load(open(tok_path))
    vocab = tj['model']['vocab']
    inv = [None] * len(vocab)
    for t, i in vocab.items():
        inv[i] = t
    json.dump(dict(vocab=inv, unk=vocab[tj['model']['unk_token']], prefix=tj['model']['continuing_subword_prefix'],
                   max_chars=tj['model']['max_input_chars_per_word'], lower=True),
              open(OUT / 'tokenizer.json', 'w'), ensure_ascii=False, separators=(',', ':'))
    # índice das faixas no espaço da consulta
    with torch.no_grad():
        tv = F.normalize(model.t(torch.from_numpy(feats)), dim=-1).numpy()
    q8 = np.clip(np.round(tv * 127), -127, 127).astype(np.int8)
    ib = json.dumps(dict(version=1, n=int(q8.shape[0]), dim=RDIM, escala=1 / 127)).encode()
    pad = (-(12 + len(ib))) % 4
    with open(OUT / 'faixas-idx.bin', 'wb') as f:
        f.write(b'IDX1' + struct.pack('<II', 1, len(ib) + pad) + ib + b' ' * pad)
        f.write(q8.tobytes())
    with gzip.open(OUT / 'faixas-keys.json.gz', 'wt') as f:
        json.dump([[t['acervo'], t['key']] for t in tracks], f, ensure_ascii=False)
    sizes = {p.name: p.stat().st_size for p in OUT.iterdir() if p.is_file()}
    return q8.astype(np.float32) / 127, sizes

def export_table_to_model(model):
    """o que o JS vê: tabela em fp16, resto em fp32 — avalia o modelo exportado, não o de treino."""
    with torch.no_grad():
        model.emb.weight.copy_(model.emb.weight.half().float())

# ── principal ────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--epochs', type=int, default=12)
    ap.add_argument('--bs', type=int, default=256)
    ap.add_argument('--seed', type=int, default=0)
    ap.add_argument('--aw', type=float, default=A_WEIGHT)
    ap.add_argument('--fw', type=float, default=FORA_W)
    a = ap.parse_args()
    ap2 = None
    globals()['A_WEIGHT'] = a.aw
    globals()['FORA_W'] = a.fw
    t_start = time.time()
    log = lambda s: print(s, flush=True)
    torch.set_num_threads(os.cpu_count() or 4)
    from huggingface_hub import snapshot_download
    src = Path(snapshot_download('cnmoro/static-retrieval-distilbert-ptbr')) / '0_StaticEmbedding'
    log('1/5 faixas e features')
    tracks, emb_parts = load_tracks(log)
    feats = track_matrix(tracks, emb_parts, log)
    attr = np.stack([t['attr'] for t in tracks])
    years = np.array([t['year'] for t in tracks])
    log('2/5 perguntas')
    rows = load_rows(tracks, log)
    log('3/5 treino')
    table, E512 = init_table(src)
    tok = Tok(src / 'tokenizer.json')
    model = train(rows, tok, table, feats, a.epochs, a.bs, log, a.seed)
    log('4/5 exportação e avaliação no gold')
    sample_rows = random.Random(3).sample(rows, 3000)
    globals()['PRIOR'] = (1 / (1 + np.exp(-model_outputs(model, tok, [r['text'] for r in sample_rows])[0]))).mean(0)
    export_table_to_model(model)
    tvec, sizes = export(model, src / 'tokenizer.json', tracks, feats, log)
    gold = gold_rows()
    ev, outs = evaluate(model, tok, gold, tvec, attr, years, E512, tok, log)
    ev_sa, _ = evaluate(model, tok, gold, tvec, attr, years, E512, tok, log, sg=True)
    base_lex = baseline_lex(gold, attr, years)
    base_st = baseline_static(gold, tok, E512)
    # latência do passe de consulta em Python (a do JS sai do teste bun)
    t0 = time.time()
    for g in gold[:200]:
        model_outputs(model, tok, [g['q']])
    py_ms = (time.time() - t0) / 200 * 1000
    # paridade para o teste JS
    sample = [g['q'] for g in gold[:40]] + ['pause', 'samba lento anos 60', 'q albuns seriam "ritmo de São João"??', 'forro dançante, anos 90!', '']
    la, pt, pc, q = model_outputs(model, tok, sample)
    json.dump([dict(q=s, ids=tok.ids([norm_text(s)])[0], attr=la[i].tolist(), tipo=pt[i].tolist(), conf=float(pc[i]), qvec=q[i].tolist())
               for i, s in enumerate(sample)], open(OUT / 'paridade.json', 'w'))
    if os.environ.get('M4_DIAG'):
        for grp in ['humor', 'andamento']:
            log(f'  --- falhas de {grp} (modelo vs léxico)')
            for i, g in enumerate(gold):
                gv = g[grp] if isinstance(g[grp], list) else ([g[grp]] if g[grp] else [])
                if not gv or g['tipo'] != 0 or not g['res']:
                    continue
                mp = top_ids(outs[0][i], grp)
                lp = lex_predict(g['q'])[0].get(grp, [])
                if mp[0] not in gv:
                    log(f'  {g["q"]!r} gold={gv} modelo={mp} léxico={lp[:3]}')
    fora = [(g['q'], outs[1][i].round(2).tolist()) for i, g in enumerate(gold) if g['tipo'] == 2]
    log('  gold fora (amostra): ' + json.dumps(fora[:8], ensure_ascii=False))
    # portão
    def beats(m_, b):
        ok = True
        for grp in ['genero', 'andamento', 'humor']:
            for k in ['top1', 'top3']:
                ok &= m_['atributos'][grp][k] >= b['atributos'][grp][k]
        return ok
    total_mb = sum(sizes[k] for k in ['modelo-texto.bin', 'tokenizer.json', 'faixas-idx.bin', 'faixas-keys.json.gz']) / 1e6
    gate = dict(
        vence_lexico=beats(ev, base_lex), vence_estatico=beats(ev, base_st),
        tipo_acc=ev['tipo']['acc'], tipo_acc_lexico=base_lex['tipo']['acc'],
        recusa_correta=ev['tipo']['recusa_correta'],
        recall10=ev['recall10'], recall10_vetor=ev['recall10_vetor'], recall10_lexico=base_lex['recall10'], recall10_acaso=ev['recall10_acaso'],
        pacote_mb=round(total_mb, 1), pacote_ok=total_mb < 50, latencia_python_ms=round(py_ms, 2))
    # gold de registro real (mensagens do usuário + família E separada do treino): mesma régua, mesmas linhas de base
    greal = gold_rows('gold-real.jsonl')
    ev_r, outs_r = evaluate(model, tok, greal, tvec, attr, years, E512, tok, log)
    base_lex_r, base_st_r = baseline_lex(greal, attr, years), baseline_static(greal, tok, E512)
    gate_r = dict(vence_lexico=beats(ev_r, base_lex_r), vence_estatico=beats(ev_r, base_st_r),
                  tipo_acc=ev_r['tipo']['acc'], tipo_acc_lexico=base_lex_r['tipo']['acc'], recusa_correta=ev_r['tipo']['recusa_correta'],
                  falsa_recusa=ev_r['tipo']['falsa_recusa'], falsa_recusa_lexico=base_lex_r['tipo']['falsa_recusa'],
                  recall10=ev_r['recall10'], recall10_lexico=base_lex_r['recall10'])
    gate['passa'] = bool(gate['vence_lexico'] and gate['vence_estatico'] and gate['pacote_ok'] and gate['recall10'] >= gate['recall10_lexico'] - 0.02
                         and gate_r['vence_lexico'] and gate_r['vence_estatico'] and gate_r['recall10'] >= gate_r['recall10_lexico'] - 0.02)
    rel = dict(gerado_em=time.strftime('%Y-%m-%d %H:%M'), epocas=a.epochs, perguntas=len(rows),
               modelo=ev, modelo_sem_acento=ev_sa, linha_base_lexico=base_lex, linha_base_estatico=base_st,
               portao=gate, gold_real=dict(modelo=ev_r, linha_base_lexico=base_lex_r, linha_base_estatico=base_st_r, portao=gate_r), arquivos=sizes)
    json.dump(rel, open(OUT / 'relatorio.json', 'w'), ensure_ascii=False, indent=1)
    log('5/5 resultado')
    log(json.dumps(rel, ensure_ascii=False, indent=1))
    log(f'  total {time.time() - t_start:.0f}s')

if __name__ == '__main__':
    main()
