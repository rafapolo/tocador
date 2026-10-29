#!/usr/bin/env python3
"""Gera assets/atlas-og.jpg (1200x630), a imagem Open Graph da página /atlas.

Lê data/atlas-faixas.json.gz (mapa "som": UMAP do embedding de áudio) e desenha
cada faixa como um ponto colorido pelo macro-gênero.

  uv run -q --with matplotlib --with numpy python script/build-atlas-og.py
"""
import base64, gzip, json, os
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager as fm

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENTRADA = os.path.join(RAIZ, "data", "atlas-faixas.json.gz")
SAIDA = os.path.join(RAIZ, "assets", "atlas-og.jpg")

W, H = 1200, 630
FUNDO = "#0f0e0c"
TEXTO, TEXTO2 = "#f5f1ed", "#b8b0a8"
OUTROS = "#4d4c48"
PALETA = {
    "Rock": "#3987e5", "Latin": "#d95926", "Electronic": "#199e70",
    "Folk, World, & Country": "#c98500", "Hip Hop": "#d55181", "Jazz": "#008300",
    "Pop": "#9085e9", "Funk / Soul": "#e66767",
}
ORDEM = list(PALETA)


def u16(s):
    return np.frombuffer(base64.b64decode(s), dtype="<u2")


p = json.load(gzip.open(ENTRADA))
n = p["n"]
xy = u16(p["c"]["som"]).reshape(-1, 2).astype(float)
x, y = xy[:, 0], xy[:, 1]
g = u16(p["c"]["g"])
macro = np.array([r.split("---")[0] for r in p["generos"]])[g]
cor_idx = np.array([ORDEM.index(m) if m in PALETA else len(ORDEM) for m in macro])
cores = np.array([PALETA[m] for m in ORDEM] + [OUTROS])[cor_idx]

# recorte pelos percentis 0,3-99,7
x0, x1 = np.percentile(x, [0.3, 99.7])
y0, y1 = np.percentile(y, [0.3, 99.7])
ok = (x >= x0) & (x <= x1) & (y >= y0) & (y <= y1)
x, y, cores, cor_idx = x[ok], y[ok], cores[ok], cor_idx[ok]

# mapa deslocado para a direita: área [0.30, 1.0] da largura
ax_ = plt.figure(figsize=(W / 100, H / 100), dpi=100)
fig = ax_
fig.patch.set_facecolor(FUNDO)
ax = fig.add_axes([0.30, 0.0, 0.70, 1.0])
ax.set_facecolor(FUNDO)
ax.axis("off")
xn = (x - x0) / (x1 - x0)
yn = (y - y0) / (y1 - y0)
# outros por baixo, gêneros nomeados por cima; ordem embaralhada com semente fixa
rng = np.random.default_rng(7)
ordem = rng.permutation(len(xn))
ordem = ordem[np.argsort(-cor_idx[ordem], kind="stable")]
ax.scatter(xn[ordem], yn[ordem], s=2.4, c=cores[ordem], alpha=0.7, linewidths=0, marker="o")
ax.set_xlim(-0.03, 1.03)
ax.set_ylim(-0.04, 1.04)

# degradê à esquerda para o texto
grad = np.linspace(0, 1, 256)[None, :]
from matplotlib.colors import LinearSegmentedColormap
cm = LinearSegmentedColormap.from_list("v", [(15/255, 14/255, 12/255, 1), (15/255, 14/255, 12/255, 0)])
gax = fig.add_axes([0.0, 0.0, 0.58, 1.0])
gax.axis("off")
gax.imshow(grad ** 0.7, cmap=cm, aspect="auto", extent=[0, 1, 0, 1])
gax.patch.set_alpha(0)

# fontes
def achar(*nomes):
    for nome in nomes:
        try:
            return fm.findfont(nome, fallback_to_default=False)
        except Exception:
            pass
    return None

serif = achar("Playfair Display", "Baskerville", "Georgia")
prop_t = fm.FontProperties(fname=serif, size=112) if serif else fm.FontProperties(family="serif", size=112)
prop_s = fm.FontProperties(fname=serif, size=25) if serif else fm.FontProperties(family="serif", size=25)
sans = fm.FontProperties(family="sans-serif", size=15)

milhar = round(n / 1000)
milhar_s = f"{milhar:,}".replace(",", ".")
fig.text(0.062, 0.54, "Atlas", color=TEXTO, fontproperties=prop_t, va="bottom")
fig.text(0.066, 0.50, f"{milhar_s} mil faixas do Tocador,", color=TEXTO2, fontproperties=prop_s, va="top")
fig.text(0.066, 0.435, "espalhadas pelo som", color=TEXTO2, fontproperties=prop_s, va="top")
fig.text(0.066, 0.075, "tocador.cc/atlas", color=TEXTO2, fontproperties=sans, va="bottom")

fig.savefig(SAIDA, dpi=100, facecolor=FUNDO, pil_kwargs={"quality": 85, "optimize": True})
print(SAIDA, os.path.getsize(SAIDA) // 1024, "KB")
