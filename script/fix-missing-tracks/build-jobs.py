#!/usr/bin/env python3
"""List homi albums with a track-numbering gap and the blog post each one came from → jobs.jsonl.

    python3 script/fix-missing-tracks/build-jobs.py > data/fix-missing-tracks/jobs.jsonl
    python3 script/fix-missing-tracks/build-jobs.py --all > data/fix-missing-tracks/albums.jsonl   # for scan-totals.py
    python3 script/fix-missing-tracks/build-jobs.py --totais data/fix-missing-tracks/suspeitos-totais.json > data/fix-missing-tracks/jobs-totais.jsonl

A gap = a number missing between 1 and the highest track number of the album (per disc), the
number taken from the file name ("03 …", "1-03 …"), else the catalog's `num`. Most gaps are the
tracks with accented names the old unrar/Archive Utility extraction dropped (tasks/fix-missing-tracks.md).
Posts are matched with refix_charset.find_post (fuzzy); the worker rejects a wrong match by
requiring the source to contain the catalog's own files.
"""
import hashlib, json, re, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HOMI = ROOT.parent / 'hominiscanidae'
sys.path.insert(0, str(HOMI / 'scripts/download'))
_argv, sys.argv = sys.argv, [sys.argv[0]]
import refix_charset as R  # noqa: E402  (loads posts.json at import)
sys.argv = _argv

DECODE = """
const fs=require('fs'); const dec=new Function(fs.readFileSync(process.argv[1],'utf8')+'\\nreturn decodeAcervo')();
process.stdout.write(JSON.stringify(dec(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(fs.readFileSync(process.argv[2])))))));
"""
cat = json.loads(subprocess.run(['bun', '-e', DECODE, str(ROOT / 'js/acervo-format.js'),
                                 str(HOMI / 'data/homi-albums.json.gz')], capture_output=True, check=True).stdout)
album_id = lambda a: hashlib.sha1(a['path'].encode()).hexdigest()[:12]

if '--all' in sys.argv:  # every album, for scan-totals.py
    for a in cat['albums']:
        print(json.dumps({'id': album_id(a), 'path': a['path'], 'arquivos': [t['file'] for t in a['tracks']]},
                         ensure_ascii=False))
    sys.exit(0)

def numbers(a):
    out = []
    for t in a['tracks']:
        f = t['file'].rsplit('/', 1)[-1]
        m = re.match(r'^(\d)[-.](\d{2,3})\b', f)
        if m: out.append((int(m.group(1)), int(m.group(2)))); continue
        m = re.match(r'^\s*(\d{1,3})(?!\d)', f)
        n = int(m.group(1)) if m else t.get('num')
        if not n or n > 99: return None
        out.append((1, n))
    return out

def hc_albums():
    """Hominis Canidae #N compilations: their folder is named after the first track's artist, so the fuzzy
    post match lands on that artist's own album. The source is the HC bandcamp page of edition N."""
    import html as H, urllib.request
    req = urllib.request.Request('https://hominiscanidae.bandcamp.com/music', headers={'User-Agent': 'Mozilla/5.0'})
    s = urllib.request.urlopen(req, timeout=30).read().decode()
    links = set(re.findall(r'href="(/album/[^"?]+)"', s))
    m = re.search(r'data-client-items="([^"]+)"', s)
    if m: links |= {it.get('page_url') for it in json.loads(H.unescape(m.group(1))) if it.get('page_url')}
    out = {}
    for l in links:
        m = re.search(r'hominis-?canidae-?(\d+)', l)
        if m: out[int(m.group(1))] = 'https://hominiscanidae.bandcamp.com' + l
    return out
HC = hc_albums()
RE_HC = re.compile(r'Hominis ?Canidae #?(\d+)\b', re.I)

def find(a):
    m = re.match(r'^(\d{4}) - (.*)$', a['path'])
    if not m: return None
    rest, year = m.group(2), m.group(1)
    # slug folder ("nao-onda-no-meio-da-berada-2013"): the folder *is* the post slug
    post = R.slug_to_post.get(rest) or R.slug_to_post.get(R.slugify(rest))
    if not post:
        post = R.find_post(rest, year) or R.find_post(rest.replace('_', ' - ', 1), year)
    if not post:
        # last resort: post slug equal to the slugified folder, with or without the year
        s = R.slugify(rest)
        post = next((p for k, p in R.slug_to_post.items() if k in (s, f'{s}-{year}') or k.startswith(s + '-')), None)
    return post

# --totais <suspeitos-totais.json>: albums whose ID3 "n/total" says tracks are missing at the end (scan-totals.py)
totais = {}
if '--totais' in sys.argv:
    totais = {x['path']: x['total'] for x in json.load(open(sys.argv[sys.argv.index('--totais') + 1]))}

n_gap = 0
for a in cat['albums']:
    if totais:
        if a['path'] not in totais: continue
        faltam = list(range(len(a['tracks']) + 1, totais[a['path']] + 1))
    else:
        nums = numbers(a)
        if not nums: continue
        discs = {}
        for d, n in nums: discs.setdefault(d, set()).add(n)
        faltam = [(f'{d}-{i}' if len(discs) > 1 else i) for d, s in discs.items() for i in range(1, max(s) + 1) if i not in s]
    if not faltam: continue
    n_gap += 1
    post = find(a)
    alternativas = []
    hc = RE_HC.search(a['path'])
    if hc and int(hc.group(1)) in HC:
        # the folder may really be edition N, or an artist's own album mislabelled by its ID3 album tag:
        # try the HC edition first, then the post the fuzzy match found
        if post and post.get('download'): alternativas.append(post['download'])
        post = {'url': (post or {}).get('url') or 'hc-bandcamp', 'download': HC[int(hc.group(1))]}
    print(json.dumps({
        'id': album_id(a), 'path': a['path'], 'faltam': faltam, 'arquivos': [t['file'] for t in a['tracks']],
        'post': post and post['url'], 'download': post and post.get('download'),
        **({'alternativas': alternativas} if alternativas else {}),
    }, ensure_ascii=False))
print(f'{n_gap} álbuns com lacuna', file=sys.stderr)
