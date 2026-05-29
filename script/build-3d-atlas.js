#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const http  = require('http');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');

// ── Config ────────────────────────────────────────────────────────────────────

const TILE_SIZE    = 64;
const ATLAS_SIZE   = 4096;
const TILES_PER_ROW = ATLAS_SIZE / TILE_SIZE; // 64
const CONCURRENCY  = 24;

function loadEnv() {
  const p = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) process.env[m[1]] = m[2];
  }
}
loadEnv();

const KNOWN_ACERVOS = {
  uqt: {
    dataUrl: 'https://raw.githubusercontent.com/rafapolo/uqt/refs/heads/master/js/uqt-albums.json.gz',
    baseUrl: 'https://cdn.tocador.cc/uqt',
  },
  homi: {
    dataUrl: 'https://raw.githubusercontent.com/rafapolo/hominiscanidae/refs/heads/main/js/homi-albums.json.gz',
    baseUrl: 'https://cdn.tocador.cc/indie',
  },
};

const acervoArg = process.argv.find(a => a.startsWith('--acervo='))?.split('=')[1]
  || (() => { const i = process.argv.indexOf('--acervo'); return i >= 0 ? process.argv[i+1] : null; })()
  || 'uqt';

if (!KNOWN_ACERVOS[acervoArg]) {
  console.error(`Unknown acervo: ${acervoArg}. Use: uqt | homi`);
  process.exit(1);
}

const { dataUrl, baseUrl } = KNOWN_ACERVOS[acervoArg];
const s3Prefix = new URL(baseUrl).pathname.replace(/^\//, ''); // e.g. "indie" or "uqt"
const OUT_DIR  = path.resolve(__dirname, '..', `tmp-atlas-${acervoArg}`);

const BUCKET   = process.env.S3_BUCKET;
const ENDPOINT = process.env.S3_ENDPOINT || 'https://hel1.your-objectstorage.com';

const s3 = new S3Client({
  endpoint: ENDPOINT,
  region: 'hel1',
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

// ── HTTP fetch ────────────────────────────────────────────────────────────────

function fetchBuffer(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, { timeout: 20000 }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchBuffer(res.headers.location, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

async function fetchGzJson(url) {
  const buf = await fetchBuffer(url);
  return JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
}

// ── Concurrency pool ──────────────────────────────────────────────────────────

async function runPool(items, concurrency, fn) {
  let i = 0;
  const results = new Array(items.length).fill(null);
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx).catch(e => ({ error: e }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ── Edge color extraction (server-side, from raw RGB buffer) ──────────────────

function stripAvg(d, S, x0, y0, x1, y1) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * S + x) * 3;
      r += d[i]; g += d[i+1]; b += d[i+2]; n++;
    }
  }
  return (Math.round(r/n) << 16) | (Math.round(g/n) << 8) | Math.round(b/n);
}

function computeEdgeColors(rgb, S) {
  const t = 2;
  const right  = stripAvg(rgb, S, S-t, 0,   S-1, S-1);
  const left   = stripAvg(rgb, S, 0,   0,   t-1, S-1);
  const top    = stripAvg(rgb, S, 0,   0,   S-1, t-1);
  const bottom = stripAvg(rgb, S, 0,   S-t, S-1, S-1);
  const avg    = stripAvg(rgb, S, 0,   0,   S-1, S-1);
  const dk = h => ((((h>>16)&0xff)>>1)<<16) | ((((h>>8)&0xff)>>1)<<8) | ((h&0xff)>>1);
  return [right, left, top, bottom, dk(avg)]; // cr, cl, ct, cb, ck
}

// ── iTunes artwork fallback ───────────────────────────────────────────────────

const ITUNES_CONCURRENCY = 8;
let _itunesRunning = 0;
const _itunesWaiting = [];

function _itunesNext() {
  while (_itunesRunning < ITUNES_CONCURRENCY && _itunesWaiting.length > 0) {
    const { album, resolve } = _itunesWaiting.shift();
    _itunesRunning++;
    (async () => {
      await new Promise(r => setTimeout(r, 60)); // ~13 req/s per slot
      try {
        const q = encodeURIComponent(`${album.artist || ''} ${album.title || ''}`.trim().slice(0, 100));
        const buf = await fetchBuffer(`https://itunes.apple.com/search?term=${q}&country=br&media=music&entity=album&limit=1`);
        const { results } = JSON.parse(buf.toString('utf8'));
        resolve(results?.[0]?.artworkUrl100?.replace('100x100bb', '600x600bb') || null);
      } catch { resolve(null); }
      finally { _itunesRunning--; _itunesNext(); }
    })();
  }
}

function itunesArtwork(album) {
  return new Promise(resolve => { _itunesWaiting.push({ album, resolve }); _itunesNext(); });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`acervo: ${acervoArg}  base: ${baseUrl}`);
  console.log('Loading album data...');
  const db = await fetchGzJson(dataUrl);
  const albums = db.albums.filter(a => a.has_cover !== false);
  console.log(`Albums with covers: ${albums.length}`);

  const totalAtlases  = Math.ceil(albums.length / (TILES_PER_ROW * TILES_PER_ROW));
  const tilesPerAtlas = TILES_PER_ROW * TILES_PER_ROW;
  // allocate atlas RGB buffers (3 channels)
  const bufs = Array.from({ length: totalAtlases }, () =>
    Buffer.alloc(ATLAS_SIZE * ATLAS_SIZE * 3, 0)
  );

  const atlasMap = {};
  let done = 0, failed = 0;

  console.log(`Packing ${albums.length} covers into ${totalAtlases} atlas(es) (${ATLAS_SIZE}×${ATLAS_SIZE}, tile=${TILE_SIZE})...`);

  await runPool(albums, CONCURRENCY, async (album, idx) => {
    const atlasIdx = Math.floor(idx / tilesPerAtlas);
    const local    = idx % tilesPerAtlas;
    const col      = local % TILES_PER_ROW;
    const row      = Math.floor(local / TILES_PER_ROW);

    const encodedPath = album.path.split('/').map(encodeURIComponent).join('/');
    const url = `${baseUrl}/${encodedPath}/capa-min.jpg`;

    async function packImage(imgBuf) {
      const rgb = await sharp(imgBuf)
        .resize(TILE_SIZE, TILE_SIZE, { fit: 'cover' })
        .flatten({ background: '#000' })
        .raw()
        .toBuffer();
      for (let ty = 0; ty < TILE_SIZE; ty++) {
        const src = ty * TILE_SIZE * 3;
        const dst = ((row * TILE_SIZE + ty) * ATLAS_SIZE + col * TILE_SIZE) * 3;
        rgb.copy(bufs[atlasIdx], dst, src, src + TILE_SIZE * 3);
      }
      const [cr, cl, ct, cb, ck] = computeEdgeColors(rgb, TILE_SIZE);
      atlasMap[album.path] = [atlasIdx, col, row, cr, cl, ct, cb, ck];
      done++;
      if (done % 500 === 0) process.stdout.write(`  ${done}/${albums.length}\n`);
    }

    try {
      await packImage(await fetchBuffer(url));
    } catch {
      // primary CDN failed — try iTunes
      try {
        const artUrl = await itunesArtwork(album);
        if (artUrl) { await packImage(await fetchBuffer(artUrl)); return; }
      } catch {}
      failed++;
      atlasMap[album.path] = null;
    }
  });

  console.log(`Done: ${done} ok, ${failed} failed`);

  // write atlas WebP files
  for (let i = 0; i < totalAtlases; i++) {
    const outPath = path.join(OUT_DIR, `atlas-${i}.webp`);
    await sharp(bufs[i], { raw: { width: ATLAS_SIZE, height: ATLAS_SIZE, channels: 3 } })
      .webp({ quality: 85, effort: 4 })
      .toFile(outPath);
    const mb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
    console.log(`Saved ${path.basename(outPath)} (${mb} MB)`);
  }

  // write atlas-map.json.gz
  const atlasNames = Array.from({ length: totalAtlases }, (_, i) => `3d-atlas/atlas-${i}.webp`);
  const mapData = { tile: TILE_SIZE, size: ATLAS_SIZE, atlases: atlasNames, map: atlasMap };
  const mapPath = path.join(OUT_DIR, 'atlas-map.json.gz');
  fs.writeFileSync(mapPath, zlib.gzipSync(JSON.stringify(mapData), { level: 9 }));
  console.log(`Saved atlas-map.json.gz (${(fs.statSync(mapPath).size / 1024).toFixed(0)} KB)`);

  if (!BUCKET) {
    console.log('S3_BUCKET not set — skipping upload. Files in:', OUT_DIR);
    return;
  }

  console.log(`Uploading to s3://${BUCKET}/${s3Prefix}/3d-atlas/ ...`);
  for (let i = 0; i < totalAtlases; i++) {
    const key = `${s3Prefix}/3d-atlas/atlas-${i}.webp`;
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: key,
      Body: fs.readFileSync(path.join(OUT_DIR, `atlas-${i}.webp`)),
      ContentType: 'image/webp',
      CacheControl: 'public, max-age=31536000',
    }));
    console.log(`  uploaded ${key}`);
  }

  const mapKey = `${s3Prefix}/3d-atlas/atlas-map.json.gz`;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: mapKey,
    Body: fs.readFileSync(mapPath),
    ContentType: 'application/gzip',
    CacheControl: 'public, max-age=3600',
  }));
  console.log(`  uploaded ${mapKey}`);
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
