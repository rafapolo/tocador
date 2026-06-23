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

const S3_REGION = 'hel1';
const TARGET_WIDTH = 200;
const CONCURRENCY = 20;

const ACERVOS = {
  uqt: {
    dataFile: path.resolve(__dirname, '../../uqt/data/uqt-albums.json.gz'),
    sourceDir: process.env.ARCHIVE_DIR || path.resolve(__dirname, '../unzips'),
    s3Prefix: 'uqt',
  },
  homi: {
    dataFile: path.resolve(__dirname, '../../hominiscanidae/data/homi-albums.json.gz'),
    sourceDir: process.env.ARCHIVE_DIR || '/Volumes/EXTRA/hominiscanidae/unzips',
    s3Prefix: 'indie',
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
  return JSON.parse(json).albums;
}

function findCover(albumDir) {
  const capaMin = path.join(albumDir, 'capa-min.jpg');
  if (fs.existsSync(capaMin)) return { path: capaMin, preresized: true };

  let best = null;
  if (!fs.existsSync(albumDir)) return null;
  for (const item of fs.readdirSync(albumDir)) {
    const full = path.join(albumDir, item);
    const stat = fs.statSync(full);
    if (stat.isFile() && ['.jpg', '.jpeg'].includes(path.extname(item).toLowerCase())) {
      if (!best || stat.size > best.size) best = { path: full, size: stat.size, preresized: false };
    }
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

async function s3Exists(s3, bucket, key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch { return false; }
}

async function processAlbum(s3, S3_BUCKET, config, album, force) {
  if (album.has_cover === false) return 'skipped';

  const s3Key = `${config.s3Prefix}/${album.path}/capa-min.jpg`;

  if (!force && await s3Exists(s3, S3_BUCKET, s3Key)) return 'existed';

  const albumDir = albumSourceDir(config.sourceDir, album.path);
  const cover = albumDir ? findCover(albumDir) : null;
  if (!cover) return 'skipped';

  const originalSize = fs.statSync(cover.path).size;

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

  const config = ACERVOS[acervoArg];
  if (!config) {
    console.error(`Unknown acervo: ${acervoArg}. Valid: ${Object.keys(ACERVOS).join(', ')}`);
    process.exit(1);
  }

  const S3_BUCKET = process.env.S3_BUCKET;
  const ak = process.env.AWS_ACCESS_KEY_ID;
  const sk = process.env.AWS_SECRET_ACCESS_KEY;
  if (!S3_BUCKET || !ak || !sk) throw new Error('S3_BUCKET / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set');

  const s3 = new S3Client({
    endpoint: `https://${S3_REGION}.your-objectstorage.com`,
    region: S3_REGION,
    credentials: { accessKeyId: ak, secretAccessKey: sk },
    forcePathStyle: true,
  });

  console.log(`Acervo: ${acervoArg}${force ? ' (--force, skipping exists check)' : ''}`);
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
      batch.map(album => processAlbum(s3, S3_BUCKET, config, album, force))
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
          if (uploaded <= 30)
            console.log(`  OK: ${v.path} (${(v.originalSize / 1024).toFixed(1)}KB → ${(v.finalSize / 1024).toFixed(1)}KB)`);
          else if (uploaded === 31)
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
