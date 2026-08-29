#!/usr/bin/env python3
"""Flat treemap of subgenre (full Discogs label) distribution across homi's tracks."""

import json
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle, Patch
import squarify

SRC = "../hominiscanidae/data/genres.json"
OUT = "treemap-subgenres.png"

with open(SRC) as f:
    data = json.load(f)

counts = {}
total = 0
for album in data.values():
    for track in album.values():
        top = track.get("top")
        if not top:
            continue
        counts[top] = counts.get(top, 0) + 1
        total += 1

items = sorted(counts.items(), key=lambda kv: -kv[1])
print(f"{total} tracks, {len(items)} subgenres")

TOP_N = 40
main = items[:TOP_N]
rest = items[TOP_N:]
if rest:
    main.append((f"Outros ({len(rest)} subgêneros)", sum(v for _, v in rest)))

labels = [k for k, _ in main]
sizes = [v for _, v in main]

cmap = plt.get_cmap("turbo")
norm = matplotlib.colors.Normalize(vmin=0, vmax=len(sizes) - 1)
colors = [cmap(norm(i)) for i in range(len(sizes))]

def lum(rgba):
    return 0.299 * rgba[0] + 0.587 * rgba[1] + 0.114 * rgba[2]

W, H = 1920, 1080
fig, ax = plt.subplots(figsize=(W / 100, H / 100), dpi=100)
ax.set_xlim(0, W)
ax.set_ylim(0, H)
ax.axis("off")

rects = squarify.squarify(squarify.normalize_sizes(sizes, W, H), 0, 0, W, H)

tiny = []
for rect, label, size, color in zip(rects, labels, sizes, colors):
    x, y, dx, dy = rect["x"], rect["y"], rect["dx"], rect["dy"]
    pct = 100 * size / total
    ax.add_patch(Rectangle((x, y), dx, dy, facecolor=color, edgecolor="white", linewidth=2))
    genre, _, sub = label.partition("---")
    name = sub or genre
    if len(name) > 22:
        name = name[:21] + "…"
    if min(dx, dy) < 42 or len(name) * 9 > dx or dy < 58:
        tiny.append((label, size, pct, color))
        continue
    fg = "black" if lum(color) > 0.55 else "white"
    fs = max(8, min(15, int(min(dx, dy) / 6)))
    ax.text(x + dx / 2, y + dy / 2,
            f"{name}\n{size:,} ({pct:.1f}%)".replace(",", "."),
            ha="center", va="center", fontsize=fs, color=fg)

if tiny:
    tiny.sort(key=lambda t: -t[1])
    handles = [Patch(facecolor=c, edgecolor="white",
                     label=f"{l} — {v:,} ({p:.1f}%)".replace(",", "."))
               for l, v, p, c in tiny]
    ax.legend(handles=handles, loc="upper left", bbox_to_anchor=(0, -0.01),
              fontsize=9, frameon=False, ncol=3,
              title="blocos pequenos demais para rotular", title_fontsize=10,
              alignment="left")

ax.set_title(f"hominiscanidae — subgêneros por faixa (top do classificador)\n{total:,} faixas, {len(items)} subgêneros".replace(",", "."),
             fontsize=18, pad=12)
fig.tight_layout()
fig.savefig(OUT, bbox_inches="tight", facecolor="white")
print(f"wrote {OUT}")
