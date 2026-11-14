#!/usr/bin/env python3
"""Recover tracks the old extraction dropped (accented file names) — runs on the beelink.

For each job (one album with a numbering gap, see build-jobs.js): download the original post
archive, extract it with charset-aware tools, find the audio files that are not in the catalog,
upload them to S3 next to the album's other tracks, record their metadata and delete everything
local at once. Nothing touches the catalog here; apply-results.js does that on the Mac.

    .venv/bin/python worker.py jobs.jsonl results.jsonl [--workers 6] [--limit N] [--dry-run]

Resumable: results.jsonl is the state. Jobs with a terminal status are skipped on a rerun;
`quota`/`erro_rede` ones are retried. Needs megatools, 7zz, ffmpeg/ffprobe, curl, and
AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / S3_ENDPOINT in the environment.
"""
import argparse, json, os, re, shutil, subprocess, sys, threading, time, unicodedata, zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlparse, quote

HERE = Path(__file__).resolve().parent
WORK = Path(os.environ.get('FMT_WORK', HERE / 'work'))
MEGATOOLS = os.environ.get('MEGATOOLS', str(HERE / 'bin/megatools'))
SEVENZ = os.environ.get('SEVENZ', os.path.expanduser('~/.local/bin/7zz'))
VENV_BIN = Path(sys.executable).parent
AUDIO = {'.mp3', '.flac', '.ogg', '.m4a', '.aac', '.wav', '.opus', '.wma', '.aiff', '.aif'}
ARCHIVES = {'.rar', '.zip', '.7z'}
BUCKET, PREFIX = 'indie', 'indie/'
RETRY = {'quota', 'erro_rede', 'bandcamp', 'erro'}  # 'bandcamp' = skipped by an older worker
ACEITAR_STREAM = '--aceitar-stream' in sys.argv
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

_lock = threading.Lock()
def log(*a):
    with _lock:
        print(*a, flush=True)

NFC = lambda s: unicodedata.normalize('NFC', s)
def skel(name):
    """Name skeleton that survives mojibake: ascii letters/digits only."""
    s = unicodedata.normalize('NFKD', Path(name).stem).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9]', '', s)
def skel2(name):
    """Skeleton that drops accented letters entirely ("Otário" and the mojibake "Ot rio" agree)."""
    return re.sub(r'[^a-z0-9]', '', NFC(Path(name).stem).lower())
def core(name):
    """Title only: the part after the last " - ", minus a leading track number ("02 Dunas - Dunas - O universo
    contido" and "Dunas - Quarenta e cinco minutos - 02 O universo contido" agree)."""
    t = re.sub(r'^\s*\d{1,3}[.\-_\s]+', '', NFC(Path(name).stem).split(' - ')[-1])
    k = skel('x' + t)[1:]
    return 'c:' + k if len(k) >= 4 else '-'
def same(name, cat_set, cat_skel):
    return (NFC(name) in cat_set or (skel(name) or '-') in cat_skel or (skel2(name) or '-') in cat_skel
            or core(name) in cat_skel)
def lead_num(name):
    m = re.match(r'^\s*(?:\d{1,2}[-.])?(\d{1,3})(?!\d)', name)
    return int(m.group(1)) if m else None

# ── S3 ────────────────────────────────────────────────────────────────────────
_s3 = None
def s3():
    global _s3
    with _lock:
        if _s3 is None:
            import boto3
            from botocore.config import Config
            _s3 = boto3.client('s3', endpoint_url=os.environ['S3_ENDPOINT'], region_name='hel1',
                               aws_access_key_id=os.environ['AWS_ACCESS_KEY_ID'],
                               aws_secret_access_key=os.environ['AWS_SECRET_ACCESS_KEY'],
                               config=Config(retries={'max_attempts': 5}))
    return _s3
def s3_size(key):
    for k in dict.fromkeys([NFC(key), unicodedata.normalize('NFD', key), key]):
        try:
            return s3().head_object(Bucket=BUCKET, Key=k)['ContentLength'], k
        except Exception as e:
            if '404' not in str(e) and 'Not Found' not in str(e):
                raise
    return None, None

# ── download ──────────────────────────────────────────────────────────────────
def run(cmd, timeout):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)

def curl(url, out, timeout=1200, referer=None):
    cmd = ['curl', '-sSL', '--fail', '-A', UA, '--retry', '2', '--connect-timeout', '30', '-o', str(out)]
    if referer: cmd += ['-e', referer]
    r = run(cmd + [url], timeout)
    if out.exists() and out.stat().st_size > 0:
        return out, None
    return None, f'curl: {r.stderr.strip()[-200:] or "vazio"}'

def dl_mega(url, d):
    url = url.replace('mega.co.nz', 'mega.nz')
    r = run([MEGATOOLS, 'dl', '--no-progress', '--path', str(d), url], 1800)
    files = [f for f in d.iterdir() if f.is_file() and f.stat().st_size > 0]
    if len(files) == 1: return files[0], None
    if files: return d, None
    err = (r.stderr + r.stdout).strip()
    if re.search(r'509|quota|EOVERQUOTA|ETOOMANY|ERATELIMIT|EAGAIN|bandwidth', err, re.I): return None, 'quota:' + err[-150:]
    if re.search(r'ENOENT|EBLOCKED|not found|-9\b|ETEMPUNAVAIL|EKEY|takedown|-16\b', err, re.I): return None, 'morto:' + err[-150:]
    return None, 'mega:' + err[-200:]

def dl_mediafire(url, d, slug):
    import requests
    r = requests.get(url, headers={'User-Agent': UA}, timeout=30)
    if r.status_code == 404 or 'error.php' in r.url: return None, 'morto:mediafire 404'
    m = re.search(r'href="(https?://download\d*\.mediafire\.com/[^"]+)"', r.text) or \
        re.search(r'"(https?://download\d*\.mediafire\.com[^"]+)"', r.text)
    if not m:
        m2 = re.search(r'data-scrambled-url="([^"]+)"', r.text)
        if m2:
            import base64
            return curl(base64.b64decode(m2.group(1)).decode(), d / (slug + ext_of(base64.b64decode(m2.group(1)).decode())))
        return None, 'morto:mediafire sem link'
    direct = m.group(1).replace('\\/', '/')
    return curl(direct, d / (slug + ext_of(direct)))

def ext_of(url, default='.rar'):
    m = re.search(r'\.(rar|zip|7z|mp3|flac|m4a)(?:\?|$|/)', url.split('#')[0], re.I)
    return ('.' + m.group(1).lower()) if m else default

def dl_gdrive(url, d, slug):
    m = re.search(r'/d/([\w-]+)', url) or re.search(r'[?&]id=([\w-]+)', url)
    if not m: return None, 'gdrive: sem id'
    fid = m.group(1)
    if '/folders/' in url:
        r = run([str(VENV_BIN / 'gdown'), '--folder', url, '-O', str(d / 'pasta')], 1800)
        return (d / 'pasta', None) if (d / 'pasta').exists() and any((d / 'pasta').rglob('*')) else (None, 'morto:gdrive pasta ' + r.stderr[-150:])
    r = run([str(VENV_BIN / 'gdown'), f'https://drive.google.com/uc?id={fid}', '-O', str(d) + '/'], 1800)
    files = [f for f in d.iterdir() if f.is_file() and f.stat().st_size > 0]
    if files: return files[0], None
    err = (r.stderr + r.stdout)
    if re.search(r'Too many users|quota', err, re.I): return None, 'quota:gdrive'
    return None, 'morto:gdrive ' + err.strip()[-150:]

def dl_dropbox(url, d, slug):
    direct = re.sub(r'([?&])dl=0', r'\1dl=1', url)
    if 'dl=1' not in direct: direct += ('&' if '?' in direct else '?') + 'dl=1'
    return curl(direct, d / (slug + ext_of(url, '.zip')))

def bc_get(url):
    import requests
    r = requests.get(url, headers={'User-Agent': UA}, timeout=30)
    return r

def bc_json_attr(html_text, attr):
    import html as H
    m = re.search(attr + r'="([^"]+)"', html_text)
    return json.loads(H.unescape(m.group(1))) if m else None

def dl_bandcamp(url, d, slug):
    """Full-quality free download when the album offers one (MP3 320), else the 128 kbps preview stream
    through yt-dlp. Old posts link a signed bandcamp.com/download?id=… page that expired years ago; its id
    is the album (or track) id, which the embedded player resolves to the album page."""
    q = dict(re.findall(r'[?&](\w+)=([^&#]+)', url))
    album_url = url
    if '/download' in urlparse(url).path and q.get('id'):
        kind = 'track' if q.get('type') == 't' or q.get('type') == 'track' else 'album'
        emb = bc_get(f'https://bandcamp.com/EmbeddedPlayer/{kind}={q["id"]}')
        pd = bc_json_attr(emb.text, 'data-player-data') if emb.ok else None
        if not pd or not pd.get('linkback'):
            return None, 'morto:bandcamp id sem álbum'
        album_url = pd['linkback']
    page = bc_get(album_url)
    if page.status_code == 404:
        return None, 'morto:bandcamp 404'
    tr = bc_json_attr(page.text, 'data-tralbum') or {}
    free = tr.get('freeDownloadPage')
    if free:
        try:
            blob = bc_json_attr(bc_get(free).text, 'data-blob') or {}
            items = blob.get('download_items') or []
            fmt = (items[0].get('downloads') or {}) if items else {}
            u = (fmt.get('mp3-320') or fmt.get('mp3-v0') or {}).get('url')
            if u:
                st = bc_get(u.replace('/download/', '/statdownload/') + '&.vrs=1').text
                m = re.search(r'"(?:download_url|retry_url)":"([^"]+)"', st)
                if m:
                    got, err = curl(m.group(1).replace('\\/', '/'), d / (slug + '.zip'), timeout=1800)
                    if got:
                        (d / '.qualidade').write_text('bandcamp-mp3-320')
                        return got, None
        except Exception as e:
            log('bandcamp free falhou', album_url, repr(e)[:120])
    yt = d / 'yt'; yt.mkdir(exist_ok=True)
    r = run([str(VENV_BIN / 'yt-dlp'), '-q', '--no-progress', '-x', '--audio-format', 'mp3', '--audio-quality', '0',
             '--embed-metadata', '-o', str(yt / '%(track_number)02d - %(track)s.%(ext)s'), album_url], 1800)
    files = [f for f in yt.iterdir() if f.is_file() and f.stat().st_size > 0]
    if files:
        (d / '.qualidade').write_text('stream-128')
        return yt, None
    return None, 'morto:bandcamp sem download nem stream ' + r.stderr.strip()[-120:]

def download(url, d, slug):
    host = urlparse(url).netloc.lower().replace('www.', '')
    if host in ('bit.ly', 'mir.cr', 'ow.ly', 'tinyurl.com', 'goo.gl', 'migre.me'):
        r = run(['curl', '-sIL', '-A', UA, '-o', '/dev/null', '-w', '%{url_effective}', url], 30)
        if r.stdout.startswith('http'): url = r.stdout.strip(); host = urlparse(url).netloc.lower().replace('www.', '')
    if 'mega' in host: return dl_mega(url, d)
    if 'mediafire' in host: return dl_mediafire(url, d, slug)
    if 'drive.google' in host or 'docs.google' in host: return dl_gdrive(url, d, slug)
    if 'dropbox' in host: return dl_dropbox(url, d, slug)
    if 'bandcamp' in host: return dl_bandcamp(url, d, slug)
    if any(h in host for h in ('4shared', 'rapidshare', 'hotfile', 'megaupload', 'uploaded', 'depositfiles',
                               'fileserve', 'filesonic', 'sendspace', 'zshare', 'easy-share', 'ziddu', 'badongo')):
        return None, 'morto:host extinto'
    return curl(quote(url, safe=":/?&=%#+@!$'()*,;~"), d / (slug + ext_of(url)), timeout=1200)

# ── extract ───────────────────────────────────────────────────────────────────
def fix_zip_name(info):
    if info.flag_bits & 0x800: return info.filename
    raw = info.filename.encode('cp437', errors='replace')
    for enc in ('utf-8', 'cp850'):
        try: return raw.decode(enc)
        except UnicodeDecodeError: pass
    return info.filename

def extract_zip(arc, out):
    with zipfile.ZipFile(arc) as z:
        for info in z.infolist():
            name = fix_zip_name(info)
            if info.is_dir() or '__MACOSX' in name or Path(name).name.startswith('._'): continue
            dest = out / Path(*[p for p in Path(name).parts if p not in ('..', '/')])
            dest.parent.mkdir(parents=True, exist_ok=True)
            with z.open(info) as src, open(dest, 'wb') as dst: shutil.copyfileobj(src, dst)

def extract(arc, out):
    out.mkdir(parents=True, exist_ok=True)
    if arc.is_dir():
        for f in arc.rglob('*'):
            if f.is_file() and f.suffix.lower() in AUDIO | ARCHIVES:
                dst = out / f.relative_to(arc); dst.parent.mkdir(parents=True, exist_ok=True); shutil.move(str(f), dst)
    else:
        kind = arc.suffix.lower()
        head = open(arc, 'rb').read(8)
        if head.startswith(b'PK'): kind = '.zip'
        elif head.startswith(b'Rar!'): kind = '.rar'
        elif head.startswith(b"7z\xbc\xaf"): kind = '.7z'
        elif head[:3] == b'ID3' or head[:2] in (b'\xff\xfb', b'\xff\xf3', b'\xff\xfa') or kind in AUDIO:
            shutil.move(str(arc), out / (arc.name if arc.suffix.lower() in AUDIO else arc.stem + '.mp3')); return None
        elif head.lstrip().lower().startswith((b'<!doc', b'<html', b'<?xml', b'{')):
            return 'morto:html em vez de arquivo'
        if kind == '.zip':
            try: extract_zip(arc, out)
            except (zipfile.BadZipFile, NotImplementedError, OSError):
                r = run([SEVENZ, 'x', '-y', '-mcp=850', f'-o{out}', str(arc)], 900)
                if r.returncode not in (0, 1): return 'extracao:7zz zip ' + r.stderr[-150:]
        else:
            r = run([SEVENZ, 'x', '-y', f'-o{out}', str(arc)], 900)
            if r.returncode not in (0, 1): return 'extracao:7zz ' + (r.stderr or r.stdout)[-150:]
        arc.unlink(missing_ok=True)
    # one level of nested archives
    for inner in [f for f in out.rglob('*') if f.is_file() and f.suffix.lower() in ARCHIVES]:
        sub = inner.parent / (inner.stem + '_x')
        if inner.suffix.lower() == '.zip':
            try: extract_zip(inner, sub)
            except Exception: pass
        else:
            run([SEVENZ, 'x', '-y', f'-o{sub}', str(inner)], 900)
        inner.unlink(missing_ok=True)
    fix_byte_names(out)
    return None

def fix_byte_names(out):
    """7zz writes a RAR's legacy (OEM) names as raw bytes; Python sees them as surrogates
    ("\\udce9ltimo"), which can't become an S3 key. Rename them: UTF-8, else cp850 (0xE9 = Ú)."""
    for f in sorted(out.rglob('*'), key=lambda x: -len(x.parts)):
        try: f.name.encode('utf-8')
        except UnicodeEncodeError:
            raw = os.fsencode(f.name)
            for enc in ('utf-8', 'cp850'):
                try: f.rename(f.with_name(raw.decode(enc))); break
                except UnicodeDecodeError: pass

RE_BC_NAME = re.compile(r'^.+ - .+ - (\d{1,3}) (.+)$')
def bandcamp_names(audios, cat):
    """Bandcamp zips name files "Artist - Album - 01 Title.mp3"; the catalog has "01. Title.mp3" (or "01 - "…).
    Rename to the catalog's own convention so matching and the uploaded key follow the album's style."""
    hits = [f for f in audios if RE_BC_NAME.match(f.stem)]
    if len(hits) < max(1, len(audios) // 2): return audios
    m = next((re.match(r'^(\d{1,3})(\.\s|\s-\s|\s|-|_|\.)', c) for c in cat if re.match(r'^\d', c)), None)
    sep, width = (m.group(2), len(m.group(1))) if m else (' ', 2)
    out = []
    for f in audios:
        mm = RE_BC_NAME.match(f.stem)
        if not mm: out.append(f); continue
        dst = f.with_name(f'{int(mm.group(1)):0{width}d}{sep}{mm.group(2)}{f.suffix}')
        if not dst.exists(): f.rename(dst); f = dst
        out.append(f)
    return out

# ── metadata ──────────────────────────────────────────────────────────────────
def meta(path):
    from mutagen import File as MF
    title = artist = album_artist = ''
    track = 0
    try:
        f = MF(path, easy=True)
        if f is not None and f.tags:
            g = lambda k: (f.tags.get(k) or [''])[0].strip()
            title, artist, album_artist = g('title'), g('artist'), g('albumartist')
            m = re.match(r'\s*(\d+)', g('tracknumber'))
            track = int(m.group(1)) if m else 0
    except Exception:
        pass
    r = run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)], 60)
    try: dur = round(float(r.stdout.strip()))
    except ValueError: dur = 0
    return {'id3_title': title, 'id3_artist': artist, 'id3_album_artist': album_artist, 'id3_track': track, 'duration': dur}

def to_mp3(src):
    dst = src.with_suffix('.mp3')
    r = run(['ffmpeg', '-y', '-v', 'error', '-i', str(src), '-q:a', '2', '-map', 'a', '-map_metadata', '0',
             '-id3v2_version', '3', str(dst)], 900)
    if r.returncode or not dst.exists(): return None
    src.unlink(); return dst

# ── one album ─────────────────────────────────────────────────────────────────
NEXT = {'post_errado', 'link_morto', 'erro_download', 'fonte_sem_audio', 'erro_extracao'}
def process(job, dry):
    """Try the job's link, then its alternatives (e.g. the post's own link behind an HC bandcamp guess)."""
    urls = [u for u in [job.get('download'), *job.get('alternativas', [])] if u]
    if not urls:
        return {'id': job['id'], 'path': job['path'], 'post': job.get('post'), 'download': None,
                't': int(time.time()), 'status': 'sem_post'}
    first = None
    for i, u in enumerate(urls):
        # an alternative link behind an HC guess hits folders that mix an edition with an artist's own album:
        # report what it would add, upload nothing (status 'revisar')
        r = process_one(job, u, dry, revisar=i > 0)
        if i > 0 and r['status'] == 'ok': r['status'] = 'revisar'
        r['download'], r['usado'] = job.get('download'), u
        last = u == urls[-1]
        # a 128 kbps stream is a last resort: another link may still have the real files
        if r['status'] == 'ok' and r.get('qualidade') == 'stream-128' and not last:
            first = first or r; continue
        if r['status'] not in NEXT: return r
        first = first or r
        if len(urls) > 1: first.setdefault('tentativas', []).append({'url': u, 'status': r['status'], 'erro': r.get('erro')})
    return first

def process_one(job, url, dry, revisar=False):
    d = WORK / job['id']
    shutil.rmtree(d, ignore_errors=True); (d / 'dl').mkdir(parents=True)
    res = {'id': job['id'], 'path': job['path'], 'post': job.get('post'), 't': int(time.time())}
    try:
        arc, err = download(url, d / 'dl', job['id'])
        if not arc:
            kind = err.split(':')[0]
            st = {'quota': 'quota', 'morto': 'link_morto', 'bandcamp': 'bandcamp'}.get(kind, 'erro_download')
            return {**res, 'status': st, 'erro': err}
        e = extract(arc, d / 'x')
        if e:
            return {**res, 'status': 'link_morto' if e.startswith('morto') else 'erro_extracao', 'erro': e}
        audios = [f for f in (d / 'x').rglob('*') if f.is_file() and f.suffix.lower() in AUDIO
                  and not f.name.startswith('._') and '__MACOSX' not in f.parts]
        res['fonte_n'] = len(audios)
        qf = d / 'dl' / '.qualidade'
        if qf.exists(): res['qualidade'] = qf.read_text()
        if not audios:
            return {**res, 'status': 'fonte_sem_audio'}
        cat = [NFC(Path(f).name) for f in job['arquivos']]
        audios = bandcamp_names(audios, cat)
        cat_set, cat_skel = set(cat), ({skel(f) for f in cat} | {skel2(f) for f in cat} | {core(f) for f in cat}) - {'', '-'}
        # the folder holding most of the catalog's files is the album
        by_dir = {}
        for f in audios: by_dir.setdefault(f.parent, []).append(f)
        def score(fs): return sum(same(f.name, cat_set, cat_skel) for f in fs)
        best = max(by_dir, key=lambda p: score(by_dir[p]))
        hit = score(by_dir[best])
        res['casadas'] = hit
        if hit < max(1, round(0.6 * len(cat))):
            res['fonte_amostra'] = sorted(NFC(f.name) for f in audios)[:12]
            return {**res, 'status': 'post_errado'}
        cat_nums = {lead_num(f) for f in cat} - {None}
        novos, dups = [], []
        for f in sorted(by_dir[best]):
            n = NFC(f.name)
            if same(n, cat_set, cat_skel): continue
            if n in job.get('ignorar', ()): continue  # hand-reviewed: e.g. an unnumbered duplicate
            stem_mp3 = NFC(f.with_suffix('.mp3').name)
            if stem_mp3 in cat_set: continue
            ln = lead_num(n)
            if ln is not None and ln in cat_nums:
                dups.append(n); continue
            novos.append(f)
        res['duplicadas_por_numero'] = dups
        if not novos:
            return {**res, 'status': 'sem_faltantes'}
        faixas = []
        for f in novos:
            if f.suffix.lower() != '.mp3':
                f2 = to_mp3(f)
                if not f2: faixas.append({'file': NFC(f.name), 'erro': 'conversao'}); continue
                f = f2
            name = NFC(f.name)
            key = PREFIX + job['path'] + '/' + name
            size = f.stat().st_size
            existing, ek = s3_size(key)
            if existing is not None:
                up = 'ja_existia' if existing == size else 'existe_tamanho_diferente'
                name = NFC(ek[len(PREFIX) + len(job['path']) + 1:]) if ek else name
            elif dry:
                up = 'dry_run'
            elif revisar:
                up = 'revisar'
            elif res.get('qualidade') == 'stream-128' and not ACEITAR_STREAM:
                up = 'stream128_nao_enviado'  # 128 kbps preview: needs a human yes (--aceitar-stream)
            else:
                s3().upload_file(str(f), BUCKET, NFC(key), ExtraArgs={'ContentType': 'audio/mpeg'})
                got, _ = s3_size(key)
                if got != size: return {**res, 'status': 'erro_upload', 'erro': f'{name}: {got} != {size}'}
                up = 'enviado'
            faixas.append({'file': name, 'size': size, 'upload': up, **meta(f), **({'qualidade': res['qualidade']} if res.get('qualidade') else {})})
        res['faixas'] = faixas
        return {**res, 'status': 'ok'}
    except subprocess.TimeoutExpired as e:
        return {**res, 'status': 'erro_rede', 'erro': 'timeout ' + str(e.cmd[:2])}
    except Exception as e:
        msg = repr(e)
        st = 'erro_rede' if re.search(r'Connection|Timeout|reset|Temporary', msg) else 'erro'
        return {**res, 'status': st, 'erro': msg[-300:]}
    finally:
        shutil.rmtree(d, ignore_errors=True)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('jobs'); ap.add_argument('results')
    ap.add_argument('--workers', type=int, default=6); ap.add_argument('--limit', type=int)
    ap.add_argument('--dry-run', action='store_true'); ap.add_argument('--only')
    ap.add_argument('--aceitar-stream', action='store_true')
    a = ap.parse_args()
    jobs = [json.loads(l) for l in open(a.jobs) if l.strip()]
    done = {}
    if os.path.exists(a.results):
        for l in open(a.results):
            try:
                r = json.loads(l)
                stream = any(f.get('upload') == 'stream128_nao_enviado' for f in r.get('faixas', []))
                done[r['id']] = ('stream_pendente' if stream else r['status'], r.get('download'))
            except Exception: pass
    def pending(j):
        st, dl = done.get(j['id'], (None, None))
        return (st is None or st in RETRY or dl != j.get('download')  # a new link reopens the album
                or (st == 'stream_pendente' and a.aceitar_stream))
    todo = [j for j in jobs if pending(j) and (not a.only or a.only in j['path'])]
    n_pend = len(todo)
    if a.limit: todo = todo[:a.limit]
    log(f'{len(jobs)} jobs, {len(jobs) - n_pend} já resolvidos, {len(todo)} a fazer agora')
    WORK.mkdir(parents=True, exist_ok=True)
    # one MEGA download at a time per host is gentler on the anonymous quota
    quota_hits = 0
    with ThreadPoolExecutor(a.workers) as ex, open(a.results, 'a') as out:
        futs = {ex.submit(process, j, a.dry_run): j for j in todo}
        for i, fu in enumerate(as_completed(futs), 1):
            r = fu.result()
            with _lock:
                out.write(json.dumps(r, ensure_ascii=False) + '\n'); out.flush()
            nf = len([f for f in r.get('faixas', []) if f.get('upload') in ('enviado', 'ja_existia', 'dry_run')])
            log(f'[{i}/{len(todo)}] {r["status"]:16} +{nf} {r["path"][:70]}  {r.get("erro", "")[:80]}')
            if r['status'] == 'quota':
                quota_hits += 1

if __name__ == '__main__':
    main()
