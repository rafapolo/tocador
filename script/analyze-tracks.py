#!/usr/bin/env python3
"""
analyze-tracks.py — slim, resumable audio analysis for the acervos.

One JSON line per track in data/features/<acervo>.jsonl (append-only), holding only what
is useful to chat about and compare tracks: BPM, key, loudness, genre/instrument/mood
predictions, and the Discogs-EffNet embedding (for "more like this"). MusicExtractor's
600 descriptors are deliberately not computed.

Everything runs on a centre clip of each track (--clip seconds), decoded once.

Resume / pause / new albums are the same mechanism: the output file is the checkpoint.
A run analyzes every MP3 under --dir whose key is not in the file yet. Ctrl-C lets the
in-flight tracks finish, then exits; run the same command again to continue. After an ETL
run the same command again and only the new files are processed.

Key (`k`) = path of the MP3 relative to --dir, NFC-normalized, i.e. `<album path>/<file>`
exactly as the catalog builds audio URLs.

  python3 script/analyze-tracks.py --acervo homi            # everything not done yet
  python3 script/analyze-tracks.py --acervo uqt --limit 20  # benchmark on 20 tracks
  python3 script/analyze-tracks.py --acervo homi --dry-run  # just count what is pending
  python3 script/analyze-tracks.py --acervo homi --compact  # -> .json.gz + .emb.f16 for the MCP

Needs: pip install essentia-tensorflow numpy, models in ~/.essentia/models.
"""
import argparse
import base64
import collections
import concurrent.futures as cf
import gzip
import json
import multiprocessing as mp
import os
import shutil
import signal
import sys
import time
import unicodedata
from concurrent.futures.process import BrokenProcessPool
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS = Path(os.path.expanduser('~/.essentia/models'))
DEFAULT_DIRS = {
    'homi': '/Volumes/EXTRA/hominiscanidae/unzips',
    'uqt': '/Volumes/EXTRA/bkps/UQT/sambaderaiz',
}
SCHEMA = 1
EMB_DIM = 1280

# head file -> (output key, positive class). Positive-class probability is stored.
BINARY_HEADS = {
    'voice_instrumental': ('voice', 'voice'),
    'danceability': ('dance', 'danceable'),
    'mood_acoustic': ('acoustic', 'acoustic'),
    'mood_electronic': ('electronic', 'electronic'),
    'mood_happy': ('happy', 'happy'),
    'mood_sad': ('sad', 'sad'),
    'mood_relaxed': ('relaxed', 'relaxed'),
    'mood_aggressive': ('aggressive', 'aggressive'),
    'mood_party': ('party', 'party'),
    'tonal_atonal': ('tonal', 'tonal'),
}
# head file -> (output key, how many top classes to keep)
TOPK_HEADS = {
    'genre_discogs400': ('genre', 5),
    'mtg_jamendo_instrument': ('inst', 3),
    'mtg_jamendo_moodtheme': ('mood', 3),
}


# ── worker side ──────────────────────────────────────────────────────────

_M = None


class Models:
    def __init__(self, clip):
        import essentia
        import essentia.standard as es
        essentia.log.warningActive = False
        essentia.log.infoActive = False
        self.es = es
        self.clip = clip
        self.effnet = es.TensorflowPredictEffnetDiscogs(
            graphFilename=str(MODELS / 'discogs-effnet-bs64-1.pb'), output='PartitionedCall:1')
        self.heads = {}
        for name in list(BINARY_HEADS) + list(TOPK_HEADS):
            pb = MODELS / f'{name}-discogs-effnet-1.pb'
            meta = json.loads((MODELS / f'{name}-discogs-effnet-1.json').read_text())
            sch = meta['schema']
            self.heads[name] = (
                es.TensorflowPredict2D(graphFilename=str(pb), input=sch['inputs'][0]['name'],
                                       output=sch['outputs'][0]['name']),
                meta['classes'])
        # arousal/valence: regression head whose .json is missing from the model dir
        self.av = None
        av_pb = MODELS / 'arousal_valence_deam-discogs-effnet-1.pb'
        if av_pb.is_file() and av_pb.stat().st_size > 1000:
            try:
                self.av = es.TensorflowPredict2D(graphFilename=str(av_pb), output='model/Identity')
            except Exception:
                self.av = None


def _init(clip):
    global _M
    signal.signal(signal.SIGINT, signal.SIG_IGN)  # the parent decides when to stop
    for v in ('OMP_NUM_THREADS', 'TF_NUM_INTRAOP_THREADS', 'TF_NUM_INTEROP_THREADS'):
        os.environ.setdefault(v, '1')
    _M = Models(clip)


def _r(x, n=3):
    return round(float(x), n)


def analyze(args):
    """Returns the record for one track, or {'k','error'} — never raises."""
    key, path, keep_emb = args
    t0 = time.time()
    try:
        import numpy as np
        es, clip = _M.es, _M.clip
        dur, br = 0.0, 0
        try:
            md = es.MetadataReader(filename=path, filterMetadata=False)()
            dur, br = float(md[8]), int(md[9])
        except Exception:
            pass
        audio = es.MonoLoader(filename=path, sampleRate=44100, resampleQuality=1)()
        full = len(audio) / 44100.0
        start = max(0.0, (full - clip) / 2)  # centre clip; MonoLoader has no startTime here
        audio = audio[int(start * 44100):int((start + clip) * 44100)]
        got = len(audio) / 44100.0
        if got < 3.0:
            return {'k': key, 'error': f'too short ({got:.1f}s)'}
        if not dur:
            dur = got

        bpm, _ticks, bpm_conf, _e, _i = es.RhythmExtractor2013(method='multifeature')(audio)
        k, scale, kstr = es.KeyExtractor(profileType='temperley')(audio)
        dyn, loud = es.DynamicComplexity(sampleRate=44100)(audio)
        _on, onset_rate = es.OnsetRate()(audio)

        audio16 = es.Resample(inputSampleRate=44100, outputSampleRate=16000, quality=1)(audio)
        emb = _M.effnet(audio16)  # (frames, 1280)

        rec = {
            'v': SCHEMA, 'k': key, 'dur': _r(dur, 1), 'br': br // 1000 if br > 1000 else br,
            'clip': [_r(start, 1), _r(got, 1)],
            'bpm': _r(bpm, 1), 'bpm_conf': _r(bpm_conf, 2),
            'key': k, 'scale': scale, 'key_strength': _r(kstr, 2),
            'loud_db': _r(loud, 1), 'dyn': _r(dyn, 2), 'onset_rate': _r(onset_rate, 2),
        }
        for name, (model, classes) in _M.heads.items():
            avg = np.mean(model(emb), axis=0)
            if name in BINARY_HEADS:
                out, pos = BINARY_HEADS[name]
                rec[out] = _r(avg[classes.index(pos)])
            else:
                out, n = TOPK_HEADS[name]
                rec[out] = [[classes[i], _r(avg[i], 4)] for i in np.argsort(avg)[::-1][:n]]
        if _M.av is not None:
            try:
                av = np.mean(_M.av(emb), axis=0)  # DEAM scale 1..9
                rec['arousal'], rec['valence'] = _r(av[0], 2), _r(av[1], 2)
            except Exception:
                pass
        if keep_emb:
            mean = np.mean(emb, axis=0).astype(np.float16)
            rec['emb'] = base64.b64encode(mean.tobytes()).decode('ascii')
        rec['t'] = _r(time.time() - t0, 2)
        return rec
    except Exception as e:  # noqa: BLE001 — one bad file must not stop a 30k-track run
        return {'k': key, 'error': f'{type(e).__name__}: {e}'[:300]}


# ── driver side ──────────────────────────────────────────────────────────

def nfc(s):
    return unicodedata.normalize('NFC', s)


def discover(root):
    out = []
    for dp, dn, fn in os.walk(root):
        dn.sort()
        for f in sorted(fn):
            if f.lower().endswith('.mp3') and not f.startswith('._'):
                full = os.path.join(dp, f)
                out.append((nfc(os.path.relpath(full, root)), full))
    return out


def load_done(out_path, retry_errors):
    done, errors = set(), 0
    if not out_path.exists():
        return done, errors
    with open(out_path, 'rb') as f:
        for line in f:
            try:
                r = json.loads(line)
            except ValueError:
                continue  # truncated last line from a hard kill
            if 'error' in r:
                errors += 1
                if retry_errors:
                    continue
            done.add(r['k'])
    return done, errors


def fmt_dur(s):
    s = int(s)
    if s >= 86400:
        return f'{s // 86400}d{(s % 86400) // 3600:02d}h'
    if s >= 3600:
        return f'{s // 3600}h{(s % 3600) // 60:02d}m'
    return f'{s // 60}m{s % 60:02d}s'


class Progress:
    def __init__(self, total, already):
        self.total, self.base, self.n, self.errs = total, already, 0, 0
        self.stamps = collections.deque()
        self.tty = sys.stderr.isatty()
        self.last = 0.0

    def tick(self, err=False):
        now = time.time()
        self.n += 1
        self.errs += err
        self.stamps.append(now)
        while self.stamps and now - self.stamps[0] > 180:
            self.stamps.popleft()
        if now - self.last >= (0.5 if self.tty else 30):
            self.render(now)

    def render(self, now=None, end=False):
        now = now or time.time()
        self.last = now
        done = self.base + self.n
        rate = 0.0
        if len(self.stamps) > 1 and self.stamps[-1] > self.stamps[0]:
            rate = (len(self.stamps) - 1) / (self.stamps[-1] - self.stamps[0])
        eta = fmt_dur((self.total - done) / rate) if rate > 0 else '?'
        frac = done / self.total if self.total else 1
        fill = int(frac * 24)
        line = (f'[{"█" * fill}{"░" * (24 - fill)}] {done:,}/{self.total:,} {frac * 100:5.1f}%  '
                f'{rate:4.2f} tr/s  ETA {eta}  err {self.errs}')
        if self.tty:
            sys.stderr.write('\r' + line + '\x1b[K' + ('\n' if end else ''))
        else:
            sys.stderr.write(line + '\n')
        sys.stderr.flush()


def run(args):
    root = Path(args.dir or os.environ.get('ARCHIVE_DIR') or DEFAULT_DIRS[args.acervo])
    if not root.is_dir():
        sys.exit(f'audio dir not found: {root} (is the drive mounted? use --dir)')
    out_path = Path(args.out) if args.out else ROOT / 'data' / 'features' / f'{args.acervo}.jsonl'
    out_path.parent.mkdir(parents=True, exist_ok=True)

    import fcntl
    lock = open(str(out_path) + '.lock', 'w')  # one run per output file: a second one would write the same tracks twice
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        sys.exit(f'already running for {out_path.name} — exiting')

    print(f'scanning {root} …', file=sys.stderr)
    tracks = discover(root)
    done, prev_errors = load_done(out_path, args.retry_errors)
    pending = [t for t in tracks if t[0] not in done]
    print(f'{len(tracks):,} mp3 · {len(tracks) - len(pending):,} done '
          f'({prev_errors} earlier errors{" — retrying" if args.retry_errors else " — skipped"}) · '
          f'{len(pending):,} pending', file=sys.stderr)
    if args.limit:
        pending = pending[:args.limit]
    if args.dry_run or not pending:
        return

    stop = {'n': 0}

    def on_sigint(*_):
        stop['n'] += 1
        if stop['n'] >= 2:
            os._exit(130)
        print('\nstopping after the in-flight tracks (Ctrl-C again to abort now) …', file=sys.stderr)
    signal.signal(signal.SIGINT, on_sigint)

    workers = args.workers or max(1, (os.cpu_count() or 2) - 1)
    ctx = mp.get_context('spawn')  # never fork after TF has been imported
    keep_emb = not args.no_embedding
    prog = Progress(0, 0)
    n_all = len(pending)
    prog.base = len(tracks) - sum(1 for t in tracks if t[0] not in done)
    prog.total = prog.base + n_all

    fh = open(out_path, 'ab')
    if fh.tell() and out_path.read_bytes()[-1:] != b'\n':
        fh.write(b'\n')  # heal a truncated last line so the next record starts clean

    def new_pool():
        return cf.ProcessPoolExecutor(max_workers=workers, mp_context=ctx,
                                      initializer=_init, initargs=(args.clip,))

    queue = collections.deque(pending)
    solo = collections.deque()  # victims of a pool crash, re-run one at a time to find the culprit
    pool = new_pool()
    inflight = {}
    print(f'{workers} workers, {args.clip:.0f}s clip — loading models …', file=sys.stderr)

    def write(rec):
        fh.write((json.dumps(rec, ensure_ascii=False, separators=(',', ':')) + '\n').encode())
        fh.flush()
        prog.tick('error' in rec)

    try:
        while ((queue or solo) and not stop['n']) or inflight:
            if solo:
                if not inflight and not stop['n']:
                    key, full = solo.popleft()
                    inflight[pool.submit(analyze, (key, full, keep_emb))] = (key, full, True)
            else:
                while queue and not stop['n'] and len(inflight) < workers * 2:
                    key, full = queue.popleft()
                    inflight[pool.submit(analyze, (key, full, keep_emb))] = (key, full, False)
            finished, _ = cf.wait(inflight, timeout=1, return_when=cf.FIRST_COMPLETED)
            broken = False
            for fut in finished:
                key, full, was_solo = inflight.pop(fut)
                try:
                    write(fut.result())
                except BrokenProcessPool:
                    broken = True
                    if was_solo:
                        write({'k': key, 'error': 'worker crashed on this file'})
                    else:
                        solo.append((key, full))
                except Exception as e:  # noqa: BLE001
                    write({'k': key, 'error': f'{type(e).__name__}: {e}'[:300]})
            if broken:
                for fut, (key, full, was_solo) in list(inflight.items()):
                    del inflight[fut]
                    solo.append((key, full))
                pool.shutdown(wait=False, cancel_futures=True)
                pool = new_pool()
                print('\nworker pool crashed — re-running the in-flight tracks one by one', file=sys.stderr)
    finally:
        pool.shutdown(wait=True, cancel_futures=True)
        fh.close()
        prog.render(end=True)
    left = len(queue) + len(solo)
    if stop['n']:
        print(f'paused — {left:,} left in this run. Run the same command to resume.', file=sys.stderr)
        sys.exit(130)  # non-zero so a chained job (compact, genre index) does not run on partial data
    else:
        print('done.', file=sys.stderr)


def compact(args):
    """JSONL -> <name>.json.gz (no embeddings) + <name>.emb.f16 (N x 1280 float16, row = emb)."""
    src = Path(args.out) if args.out else ROOT / 'data' / 'features' / f'{args.acervo}.jsonl'
    latest = {}
    for line in open(src, 'rb'):
        try:
            r = json.loads(line)
        except ValueError:
            continue
        latest[r['k']] = r  # last record per key wins (a retried error becomes a result)
    rows, emb_path = {}, src.with_suffix('.emb.f16')
    n = 0
    with open(emb_path, 'wb') as ef:
        for k, r in latest.items():
            if 'error' in r:
                continue
            e = r.pop('emb', None)
            if e:
                ef.write(base64.b64decode(e))
                r['emb'] = n
                n += 1
            r.pop('k'), r.pop('v', None), r.pop('t', None)
            rows[k] = r
    out = src.with_suffix('.json.gz')
    payload = {'meta': {'acervo': args.acervo, 'schema': SCHEMA, 'tracks': len(rows),
                        'errors': sum('error' in r for r in latest.values()),
                        'emb_dim': EMB_DIM, 'emb_rows': n,
                        'generated': time.strftime('%Y-%m-%dT%H:%M:%S')},
               'tracks': rows}
    with gzip.open(out, 'wt', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
    print(f'{len(rows):,} tracks -> {out} ({out.stat().st_size / 1e6:.1f} MB), '
          f'{n:,} embeddings -> {emb_path} ({emb_path.stat().st_size / 1e6:.1f} MB)', file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--acervo', choices=sorted(DEFAULT_DIRS), required=True)
    ap.add_argument('--dir', help='music folder (default: $ARCHIVE_DIR or the acervo default)')
    ap.add_argument('--out', help='JSONL path (default data/features/<acervo>.jsonl)')
    ap.add_argument('--workers', type=int, help='parallel processes (default cpus-1)')
    ap.add_argument('--clip', type=float, default=45.0, help='seconds analysed per track, centred (default 45)')
    ap.add_argument('--limit', type=int, help='stop after N pending tracks (benchmarking)')
    ap.add_argument('--retry-errors', action='store_true', help='re-run tracks that failed before')
    ap.add_argument('--no-embedding', action='store_true', help='do not store the 1280-d embedding')
    ap.add_argument('--dry-run', action='store_true', help='only count pending tracks')
    ap.add_argument('--compact', action='store_true', help='write the .json.gz + .emb.f16 for the MCP and exit')
    a = ap.parse_args()
    compact(a) if a.compact else run(a)


if __name__ == '__main__':
    main()
