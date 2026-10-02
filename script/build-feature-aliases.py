#!/usr/bin/env python3
"""
build-feature-aliases.py — link "orphan" audio features to the catalog track they stand for.

  bun script/features-integrity-dump.js        # catalog-<acervo>.json (once, or after an ETL)
  python3 script/build-feature-aliases.py      # -> data/features/aliases-<acervo>.json  (--acervo homi|uqt for one)

An orphan is a feature whose key ("<album folder>/<file>", NFC) is not a catalog track: the folder was
collapsed as a duplicate by the catalog generator (or the file was renamed). Each one is matched, in order, by

  1. normalized title + duration within 1 s, then
  2. folder + position: when a folder with the same normalized artist/title (year ignored) is in the catalog,
     the orphan takes the catalog track of that folder with the same duration (±1 s) that no other orphan claimed.

A step that finds several candidates breaks the tie on the folder (same year, same artist, closest folder name);
if that still leaves several, the orphan is "ambiguous" (all candidates listed); with none, "unmatched".

Output: {"acervo", "counts", "aliases": {orphan_key: catalog_key}, "ambiguous": {orphan_key: [catalog_key...]},
"unmatched": [orphan_key...]}. Nothing here is a hard link: the integrity check only reports these counts.
"""
import argparse, collections, difflib, json, re, sys, unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
F = ROOT / 'data/features'
nfc = lambda s: unicodedata.normalize('NFC', s)


def fold(s):
    s = unicodedata.normalize('NFD', s.lower())
    return ''.join(c for c in s if not unicodedata.combining(c))


def norm(s):
    return re.sub(r'[^a-z0-9]+', ' ', fold(s)).strip()


def file_title(path):
    """Title from a file name: no extension, no leading track number ("07 - ", "07. ", "07 ")."""
    name = path.rsplit('/', 1)[-1]
    name = re.sub(r'\.[A-Za-z0-9]{2,4}$', '', name)
    name = re.sub(r'^\s*\d{1,3}\s*[-.)_]*\s+', '', name)
    return norm(name)


def folder_parts(folder):
    """(year, normalized "artist title") from "YYYY - Artist - Title" or a slug; year 0 when absent."""
    m = re.match(r'^\s*((?:19|20)\d\d)\s*[-–]\s*(.*)$', folder)
    year, rest = (int(m.group(1)), m.group(2)) if m else (0, folder)
    if not m:
        m2 = re.search(r'-((?:19|20)\d\d)$', folder)          # slug "artist-title-2002"
        if m2:
            year = int(m2.group(1))
    return year, norm(rest)


def build(ac):
    cat = json.load(open(F / f'catalog-{ac}.json', encoding='utf-8'))
    cat_keys = {nfc(r['k']) for r in cat}
    by_title = collections.defaultdict(list)       # normalized title -> catalog rows
    by_folder = collections.defaultdict(list)      # normalized folder (no year) -> catalog rows
    for r in cat:
        k = nfc(r['k'])
        row = {'k': k, 'dur': r.get('dur'), 'album': nfc(r['album']), 'artist': r.get('artist') or '', 'year': r.get('year') or 0}
        by_title[norm(r['title'])].append(row)
        if file_title(k) != norm(r['title']):
            by_title[file_title(k)].append(row)
        by_folder[folder_parts(row['album'])[1]].append(row)

    orphans = []
    for line in open(F / f'{ac}.jsonl', encoding='utf-8'):
        try: r = json.loads(line)
        except ValueError: continue
        k = nfc(r['k'])
        if 'error' in r or k in cat_keys: continue
        orphans.append({'k': k, 'dur': r.get('dur'), 'folder': k.rsplit('/', 1)[0]})

    close = lambda a, b: a is not None and b is not None and abs(a - b) <= 1.0

    def tiebreak(o, cands):
        y, fname = folder_parts(o['folder'])
        scored = []
        for c in cands:
            cy, cname = folder_parts(c['album'])
            score = (1 if y and cy == y else 0, 1 if c['artist'] and norm(c['artist']) in fname else 0,
                     difflib.SequenceMatcher(None, fname, cname).ratio())
            scored.append((score, c))
        scored.sort(key=lambda x: x[0], reverse=True)
        if len(scored) == 1 or scored[0][0] > scored[1][0]:
            return [scored[0][1]]
        top = scored[0][0]
        return [c for s, c in scored if s == top]

    aliases, ambiguous, left = {}, {}, []
    for o in orphans:
        cands = [c for c in by_title.get(file_title(o['k']), []) if close(o['dur'], c['dur'])]
        cands = list({c['k']: c for c in cands}.values())
        if not cands:
            left.append(o); continue
        best = tiebreak(o, cands)
        if len(best) == 1: aliases[o['k']] = best[0]['k']
        else: ambiguous[o['k']] = sorted(c['k'] for c in best)

    # step 2: same folder (year ignored), same duration, one catalog track each
    taken = set()
    unmatched = []
    for o in sorted(left, key=lambda o: o['k']):
        rows = by_folder.get(folder_parts(o['folder'])[1], [])
        cands = [c for c in rows if close(o['dur'], c['dur']) and c['k'] not in taken]
        if len(cands) == 1:
            aliases[o['k']] = cands[0]['k']; taken.add(cands[0]['k'])
        elif cands:
            ambiguous[o['k']] = sorted(c['k'] for c in cands)
        else:
            unmatched.append(o['k'])

    out = {'acervo': ac, 'counts': {'orphans': len(orphans), 'aliased': len(aliases), 'ambiguous': len(ambiguous), 'unmatched': len(unmatched)},
           'aliases': dict(sorted(aliases.items())), 'ambiguous': dict(sorted(ambiguous.items())), 'unmatched': sorted(unmatched)}
    path = F / f'aliases-{ac}.json'
    json.dump(out, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    c = out['counts']
    print(f'{ac}: {c["orphans"]:,} órfãs → {c["aliased"]:,} ligadas, {c["ambiguous"]} ambíguas, {c["unmatched"]} sem par → {path}')
    return out


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--acervo', choices=['homi', 'uqt'])
    a = ap.parse_args()
    for ac in ([a.acervo] if a.acervo else ['homi', 'uqt']):
        build(ac)
