#!/usr/bin/env python3
"""Find albums truncated without a numbering gap (the dropped tracks were the last ones), from the
ID3 TRCK "n/total" tag. Reads only the ID3 header of each track with authenticated S3 Range GETs
(never through cdn.tocador.cc, which rate-limits). Runs on the beelink.

    .venv/bin/python scan-totals.py albums.jsonl totals.jsonl [--workers 32]

albums.jsonl: {"id","path","arquivos"} per album (build-jobs.py --all). Output, one line per album:
{"id","path","n","totais":[...],"max_num"} — an album is suspect when the most common total > n.
Resumable by id.
"""
import argparse, io, json, os, re, struct, sys, threading
from concurrent.futures import ThreadPoolExecutor, as_completed
import boto3
from botocore.config import Config
from mutagen.id3 import ID3

s3 = boto3.client('s3', endpoint_url=os.environ['S3_ENDPOINT'], region_name='hel1',
                  aws_access_key_id=os.environ['AWS_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['AWS_SECRET_ACCESS_KEY'],
                  config=Config(retries={'max_attempts': 5}, max_pool_connections=64))
import unicodedata
def get(key, rng):
    for k in dict.fromkeys([key, unicodedata.normalize('NFC', key), unicodedata.normalize('NFD', key)]):
        try: return s3.get_object(Bucket='indie', Key=k, Range=rng)['Body'].read()
        except s3.exceptions.NoSuchKey: continue
        except Exception as e:
            if 'NoSuchKey' in str(e) or '404' in str(e): continue
            raise
    return None

def trck(key):
    head = get(key, 'bytes=0-9')
    if not head or head[:3] != b'ID3': return None
    size = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9]
    size = min(size + 10, 2_000_000)
    # TRCK sits before the picture in almost every tagger; 64 KB is enough, else read it all
    for n in (65536, size):
        data = get(key, f'bytes=0-{min(n, size) - 1}')
        try:
            t = ID3(io.BytesIO(data + b'\0' * 16)).get('TRCK')
            if t: return str(t.text[0])
        except Exception:
            pass
        if n >= size: break
    return None

def album(a):
    tot, nums = [], []
    for f in a['arquivos'][:3] + a['arquivos'][-1:]:
        v = trck('indie/' + a['path'] + '/' + f)
        if not v: continue
        m = re.match(r'\s*(\d+)\s*/\s*(\d+)', v)
        if m: nums.append(int(m.group(1))); tot.append(int(m.group(2)))
        else:
            m = re.match(r'\s*(\d+)', v)
            if m: nums.append(int(m.group(1)))
    return {'id': a['id'], 'path': a['path'], 'n': len(a['arquivos']), 'totais': tot, 'max_num': max(nums, default=0)}

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('albums'); ap.add_argument('out'); ap.add_argument('--workers', type=int, default=32)
    a = ap.parse_args()
    al = [json.loads(l) for l in open(a.albums) if l.strip()]
    done = set()
    if os.path.exists(a.out):
        done = {json.loads(l)['id'] for l in open(a.out) if l.strip()}
    todo = [x for x in al if x['id'] not in done]
    print(f'{len(al)} álbuns, {len(todo)} a ler', flush=True)
    lock = threading.Lock()
    with ThreadPoolExecutor(a.workers) as ex, open(a.out, 'a') as out:
        futs = [ex.submit(album, x) for x in todo]
        for i, f in enumerate(as_completed(futs), 1):
            try: r = f.result()
            except Exception as e: print('erro', repr(e)[:200], flush=True); continue
            with lock: out.write(json.dumps(r, ensure_ascii=False) + '\n')
            if i % 500 == 0: print(i, flush=True); out.flush()

if __name__ == '__main__':
    main()
