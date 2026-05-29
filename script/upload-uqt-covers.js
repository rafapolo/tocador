#!/usr/bin/env node
'use strict';

const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const sharp = require('sharp');

function loadEnv() {
  const p = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return;
  for (const l of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = l.match(/^\s*(\w+)\s*=\s*["']?([^"']*)["']?\s*$/);
    if (m) process.env[m[1]] = m[2];
  }
}
loadEnv();

const BUCKET = process.env.S3_BUCKET;
const UNZIPS = '/Users/polux/Projetos/uqt/unzips';
const CONCURRENCY = 16;

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT, region: 'hel1', forcePathStyle: true,
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY },
});

async function s3Exists(key) {
  try { await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })); return true; }
  catch { return false; }
}

async function runPool(items, concurrency, fn) {
  let i = 0;
  async function worker() { while (i < items.length) { const idx = i++; await fn(items[idx]).catch(() => {}); } }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

async function main() {
  const db = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.resolve(__dirname, '..', 'js', 'uqt-albums.json.gz'))));
  const albums = db.albums;
  let done = 0, skip = 0, fail = 0, missing = 0;

  await runPool(albums, CONCURRENCY, async (album) => {
    const coverPath = path.join(UNZIPS, album.path, 'capa-min.jpg');
    if (!fs.existsSync(coverPath)) { missing++; return; }

    const key = `uqt/${album.path}/capa-min.jpg`;
    if (await s3Exists(key)) { skip++; return; }

    try {
      const buf = await sharp(coverPath)
        .resize(400, 400, { fit: 'cover' })
        .jpeg({ quality: 85 })
        .toBuffer();
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET, Key: key, Body: buf,
        ContentType: 'image/jpeg', CacheControl: 'public, max-age=31536000',
      }));
      done++;
      if (done % 100 === 0) process.stdout.write(`  ${done} uploaded\n`);
    } catch { fail++; }
  });

  console.log(`done=${done} skipped=${skip} missing=${missing} failed=${fail}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
