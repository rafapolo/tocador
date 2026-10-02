#!/usr/bin/env python3
"""
flag-suspect-bpm.py — mark tracks whose BPM is outside 30–300 with "bpm_suspeito": true, without re-analysing.

  python3 script/flag-suspect-bpm.py [--acervo homi|uqt] [--dry-run]

Essentia's RhythmExtractor2013 sometimes returns a degenerate tempo (738.3 for near-silent or very long clips).
analyze-tracks.py now sets the flag on new tracks; this backfills the ones already in data/features/<acervo>.jsonl.
Idempotent; only the lines that change are re-serialised, the rest are copied byte for byte. Rewrites the file
through a temp file + rename, and refuses while analyze-tracks.py holds the lock. Run `analyze-tracks.py --compact`
afterwards so the .json.gz carries the flag.
"""
import argparse, fcntl, json, os, sys
from pathlib import Path

F = Path(__file__).resolve().parent.parent / 'data/features'
LO, HI = 30, 300


def flag(ac, dry):
    src = F / f'{ac}.jsonl'
    lock = open(str(src) + '.lock', 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        sys.exit(f'{ac}: analyze-tracks.py está rodando neste arquivo; tente depois')
    tmp = src.with_suffix('.jsonl.tmp')
    changed = []
    with open(src, 'rb') as fin, open(tmp, 'wb') as fout:
        for line in fin:
            try:
                r = json.loads(line)
            except ValueError:
                fout.write(line); continue                      # truncated last line: leave it alone
            bpm = r.get('bpm')
            if 'error' not in r and isinstance(bpm, (int, float)) and not LO <= bpm <= HI and not r.get('bpm_suspeito'):
                r['bpm_suspeito'] = True
                changed.append((r['k'], bpm))
                line = (json.dumps(r, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
            fout.write(line)
    if dry or not changed:
        tmp.unlink()
    else:
        os.replace(tmp, src)
    print(f'{ac}: {len(changed)} faixas {"a marcar" if dry else "marcadas"} com bpm_suspeito')
    for k, bpm in changed:
        print(f'  bpm {bpm}  {k}')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--acervo', choices=['homi', 'uqt'])
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    for ac in ([a.acervo] if a.acervo else ['homi', 'uqt']):
        flag(ac, a.dry_run)
