#!/usr/bin/env python3
"""Nested treemap of genre → subgenre distribution across homi's acervo tracks."""

import json
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle, Patch
import matplotlib.colors as mcolors
import squarify

SRC = "../hominiscanidae/data/genres.json"
OUT = "treemap.png"

with open(SRC) as f:
    data = json.load(f)

genre_counts = {}
sub_counts = {}
total = 0
for album in data.values():
    for track in album.values():
        top = track.get("top")
        if not top:
            continue
        parts = top.split("---")
        genre = parts[0].strip() or "Unknown"
        sub = parts[1].strip() if len(parts) > 1 and parts[1].strip() else "(sem subgênero)"
        genre_counts[genre] = genre_counts.get(genre, 0) + 1
        key = (genre, sub)
        sub_counts[key] = sub_counts.get(key, 0) + 1
        total += 1

print(f"{total} tracks, {len(genre_counts)} genres, {len(sub_counts)} subgenres")

W, H = 2000, 1200          # treemap area
LEG_H = 1000               # legend area below
fig = plt.figure(figsize=(W / 100, (H + LEG_H) / 100), dpi=100)
gs = fig.add_gridspec(2, 1, height_ratios=[H, LEG_H], hspace=0.05)
ax = fig.add_subplot(gs[0])
axl = fig.add_subplot(gs[1])
ax.set_xlim(0, W)
ax.set_ylim(0, H)
ax.axis("off")
axl.axis("off")

cmap = plt.get_cmap("turbo")

def lum(rgba):
    return 0.299 * rgba[0] + 0.587 * rgba[1] + 0.114 * rgba[2]

genres_sorted = sorted(genre_counts.items(), key=lambda kv: -kv[1])
grects = squarify.squarify(
    squarify.normalize_sizes([v for _, v in genres_sorted], W, H), 0, 0, W, H
)

tiny_subs = []
for gi, ((genre, gcount), gr) in enumerate(zip(genres_sorted, grects)):
    gx, gy, gw, gh = gr["x"], gr["y"], gr["dx"], gr["dy"]
    base = cmap(gi / max(1, len(genres_sorted) - 1))
    ax.add_patch(Rectangle((gx, gy), gw, gh, facecolor=base, edgecolor="white", linewidth=3))

    subs = sorted(
        [(s, n) for (g, s), n in sub_counts.items() if g == genre],
        key=lambda kv: -kv[1],
    )
    pad = 4
    header = 30 if gw * gh > 25000 else 0
    inner_w, inner_h = gw - 2 * pad, gh - 2 * pad - header
    ix, iy = gx + pad, gy + pad + header
    if inner_w <= 0 or inner_h <= 0:
        continue

    srects = squarify.squarify(
        squarify.normalize_sizes([n for _, n in subs], inner_w, inner_h), ix, iy, inner_w, inner_h
    )
    n_shades = 4
    for si, ((sub, scount), sr) in enumerate(zip(subs, srects)):
        x, y, dx, dy = sr["x"], sr["y"], sr["dx"], sr["dy"]
        factor = 1.0 - 0.45 * (si % n_shades) / (n_shades - 1)
        color = (*[c * factor for c in mcolors.to_rgb(base[:3])], 1.0)
        ax.add_patch(Rectangle((x, y), dx, dy, facecolor=color, edgecolor="white", linewidth=1.2))
        pct = 100 * scount / total
        if min(dx, dy) < 34 or len(sub) * 6.5 > dx or dy < 40:
            tiny_subs.append((f"{genre}---{sub}", scount, pct, color))
            continue
        fg = "black" if lum(color) > 0.55 else "white"
        name = sub if len(sub) <= 24 else sub[:23] + "…"
        fs = max(7, min(14, int(min(dx, dy) / 5.5)))
        ax.text(x + dx / 2, y + dy / 2,
                f"{name}\n{scount:,} ({pct:.1f}%)".replace(",", "."),
                ha="center", va="center", fontsize=fs, color=fg, linespacing=1.1)

    fg = "black" if lum(base) > 0.55 else "white"
    gpct = 100 * gcount / total
    fs = max(9, min(22, int(gw / 24)))
    label = f"{genre} — {gcount:,} ({gpct:.1f}%)".replace(",", ".")
    if len(label) * fs * 0.58 > gw:
        label = f"{genre} {gpct:.1f}%"
    ax.text(gx + 6, gy + gh - 5, label, ha="left", va="top",
            fontsize=fs, color=fg, fontweight="bold")

tiny_subs.sort(key=lambda t: -t[1])
handles = [Patch(facecolor=c, edgecolor="white",
                 label=f"{l} — {v:,} ({p:.1f}%)".replace(",", "."))
           for l, v, p, c in tiny_subs]
leg = axl.legend(handles=handles, loc="upper left", bbox_to_anchor=(0, 1.02),
                 fontsize=7.2, frameon=False, ncol=5,
                 title=f"subgêneros pequenos demais para rotular ({len(tiny_subs)})",
                 title_fontsize=9, alignment="left", handlelength=1.2,
                 handleheight=0.8, columnspacing=1.2, labelspacing=0.35)

fig.suptitle(f"hominiscanidae — gêneros e subgêneros por faixa (top do classificador) — {total:,} faixas".replace(",", "."),
             fontsize=17, y=0.985)
fig.savefig(OUT, bbox_inches="tight", facecolor="white")
print(f"wrote {OUT}")
