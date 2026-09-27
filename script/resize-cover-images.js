#!/usr/bin/env node
/**
 * Resize and upload album covers to S3.
 * Usage:
 *   bun script/resize-cover-images.js --acervo homi
 *   bun script/resize-cover-images.js --acervo uqt
 *   bun script/resize-cover-images.js --acervo homi --force   # skip exists check
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const sharp = require('sharp');
const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
require('../js/acervo-format.js');

const S3_REGION = 'hel1';
const TARGET_WIDTH = 200;
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];
const COVER_NAMES = ['cover', 'capa', 'folder', 'front', 'artwork', 'albumart'];
const CONCURRENCY = 20;

const ACERVOS = {
  // bucket must match S3_BUCKET_MAP in haloy.yaml ("uqt/:sambaraiz,indie/:indie"), which
  // is where the proxy reads each prefix from. Writing uqt covers to S3_BUCKET (indie)
  // put them where the CDN never looks.
  uqt: {
    dataFile: path.resolve(__dirname, '../../uqt/data/uqt-albums.json.gz'),
    sourceDir: process.env.ARCHIVE_DIR || '/Volumes/EXTRA/bkps/UQT/sambaderaiz',
    s3Prefix: 'uqt',
    bucket: 'sambaraiz',
  },
  homi: {
    dataFile: path.resolve(__dirname, '../../hominiscanidae/data/homi-albums.json.gz'),
    sourceDir: process.env.ARCHIVE_DIR || '/Volumes/EXTRA/hominiscanidae/unzips',
    s3Prefix: 'indie',
    bucket: 'indie',
  },
};

function loadEnv(file = '.env') {
  const envPath = path.resolve(__dirname, '..', file);
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w]+)\s*=\s*"?([^"]*)"?\s*$/);
      if (m) process.env[m[1]] = m[2];
    }
  }
}

function loadAlbums(dataFile) {
  const buf = fs.readFileSync(dataFile);
  const json = zlib.gunzipSync(buf).toString('utf8');
  return decodeAcervo(JSON.parse(json)).albums;
}

function findCover(albumDir) {
  const capaMin = path.join(albumDir, 'capa-min.jpg');
  if (fs.existsSync(capaMin)) return { path: capaMin, preresized: true };

  // Same rule as has_cover() in generate-albums: a cover-named image wins, else the
  // largest image. PNG and WebP count too (sharp re-encodes to JPEG below) — "Capa.png"
  // and "cover.png" used to be skipped, leaving covers the catalog promised as 404s.
  let best = null;
  if (!fs.existsSync(albumDir)) return null;
  for (const item of fs.readdirSync(albumDir)) {
    if (item.startsWith('._')) continue;
    const full = path.join(albumDir, item);
    const stat = fs.statSync(full);
    if (!stat.isFile() || !IMAGE_EXTS.includes(path.extname(item).toLowerCase())) continue;
    const named = COVER_NAMES.some(n => path.parse(item).name.toLowerCase().includes(n));
    const cand = { path: full, size: stat.size, named, preresized: false };
    if (!best || (named && !best.named) || (named === best.named && stat.size > best.size)) best = cand;
  }
  return best;
}

function albumSourceDir(sourceDir, albumPath) {
  for (const form of ['NFC', 'NFD']) {
    const p = path.join(sourceDir, albumPath.normalize(form));
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Keys are stored NFD or NFC depending on who uploaded them (uqt is mostly NFD), and the
// proxy serves either. Checking only the catalog's NFC form re-uploaded covers that were
// already there under their NFD name.
async function s3Exists(s3, bucket, key) {
  for (const k of new Set([key, key.normalize('NFC'), key.normalize('NFD')])) {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: k }));
      return true;
    } catch {}
  }
  return false;
}

async function processAlbum(s3, S3_BUCKET, config, album, force, dryRun) {
  if (album.has_cover === false) return 'skipped';

  const s3Key = `${config.s3Prefix}/${album.path}/capa-min.jpg`;

  if (!force && await s3Exists(s3, S3_BUCKET, s3Key)) return 'existed';

  const albumDir = albumSourceDir(config.sourceDir, album.path);
  // A part folder ("Extras", a disc, uqt's UQT2011_… wrappers) usually has no art of
  // its own; generate-albums marks it has_cover from the parent's, so look there too.
  const cover = albumDir ? (findCover(albumDir) || (album.path.includes('/') ? findCover(path.dirname(albumDir)) : null)) : null;
  if (!cover) return 'skipped';

  const originalSize = fs.statSync(cover.path).size;
  if (dryRun) return { status: 'uploaded', originalSize, finalSize: 0, path: album.path, from: cover.path };

  let buffer;
  if (cover.preresized) {
    buffer = fs.readFileSync(cover.path);
  } else {
    buffer = await sharp(cover.path)
      .resize(TARGET_WIDTH, null, { withoutEnlargement: true, fit: 'inside' })
      .jpeg({ quality: 80 })
      .toBuffer();
  }

  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: s3Key,
    Body: buffer,
    ContentType: 'image/jpeg',
  }));

  return { status: 'uploaded', originalSize, finalSize: buffer.length, path: album.path };
}

async function main() {
  loadEnv();

  const args = process.argv.slice(2);
  const acervoArg = args[args.indexOf('--acervo') + 1] || 'uqt';
  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run'); // list what would be uploaded, write nothing

  const config = ACERVOS[acervoArg];
  if (!config) {
    console.error(`Unknown acervo: ${acervoArg}. Valid: ${Object.keys(ACERVOS).join(', ')}`);
    process.exit(1);
  }

  const S3_BUCKET = config.bucket;
  const ak = process.env.AWS_ACCESS_KEY_ID;
  const sk = process.env.AWS_SECRET_ACCESS_KEY;
  if (!ak || !sk) throw new Error('AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set');

  const s3 = new S3Client({
    endpoint: `https://${S3_REGION}.your-objectstorage.com`,
    region: S3_REGION,
    credentials: { accessKeyId: ak, secretAccessKey: sk },
    forcePathStyle: true,
  });

  console.log(`Acervo: ${acervoArg}${force ? ' (--force, skipping exists check)' : ''}${dryRun ? ' (--dry-run, nothing written)' : ''}`);
  console.log(`Bucket: ${S3_BUCKET}`);
  console.log(`Data:   ${config.dataFile}`);
  console.log(`Source: ${config.sourceDir}`);
  console.log(`Prefix: ${config.s3Prefix}/\n`);

  const albums = loadAlbums(config.dataFile);
  console.log(`Albums: ${albums.length} | Concurrency: ${CONCURRENCY}\n`);

  let uploaded = 0, skipped = 0, existed = 0, errors = 0;
  let totalOriginal = 0, totalFinal = 0;

  // Process in parallel batches
  for (let i = 0; i < albums.length; i += CONCURRENCY) {
    const batch = albums.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(album => processAlbum(s3, S3_BUCKET, config, album, force, dryRun))
    );

    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === 'rejected') {
        console.error(`  ERROR: ${batch[j].path}: ${r.reason?.message}`);
        errors++;
      } else {
        const v = r.value;
        if (v === 'skipped') { skipped++; }
        else if (v === 'existed') { existed++; }
        else {
          totalOriginal += v.originalSize;
          totalFinal += v.finalSize;
          uploaded++;
          if (dryRun || uploaded <= 30)
            console.log(`  OK: ${v.path} (${(v.originalSize / 1024).toFixed(1)}KB → ${(v.finalSize / 1024).toFixed(1)}KB)`);
          else if (!dryRun && uploaded === 31)
            console.log('  ... (showing first 30)');
        }
      }
    }

    if ((i + CONCURRENCY) % 500 === 0 || i + CONCURRENCY >= albums.length) {
      process.stdout.write(`\r  Progress: ${Math.min(i + CONCURRENCY, albums.length)}/${albums.length} (↑${uploaded} ✓${existed} -${skipped} ✗${errors})`);
    }
  }

  console.log('\n\n=== Summary ===');
  console.log(`Uploaded:      ${uploaded}`);
  console.log(`Already exist: ${existed}`);
  console.log(`Skipped:       ${skipped}`);
  console.log(`Errors:        ${errors}`);
  if (uploaded > 0) {
    console.log(`Source total:  ${(totalOriginal / 1024 / 1024).toFixed(1)} MB`);
    console.log(`Uploaded:      ${(totalFinal / 1024 / 1024).toFixed(1)} MB`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
