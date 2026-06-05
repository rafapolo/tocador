#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');
const { S3Client, HeadObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

const UNZIPS_DIR  = process.env.ARCHIVE_DIR || '/Volumes/EXTRA/hominiscanidae/unzips';
const ENDPOINT    = 'https://hel1.your-objectstorage.com';
const CONCURRENCY = 8;

function loadEnv() {
  const p = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv();

const BUCKET = process.env.S3_BUCKET;
const PREFIX = 'indie/';

const s3 = new S3Client({
  endpoint: ENDPOINT,
  region: 'hel1',
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

function findCovers(dir) {
  const covers = [];
  for (const album of fs.readdirSync(dir)) {
    const albumDir = path.join(dir, album);
    if (!fs.statSync(albumDir).isDirectory()) continue;
    const capa = path.join(albumDir, 'capa-min.jpg');
    if (fs.existsSync(capa)) covers.push({ local: capa, album });
  }
  return covers;
}

async function headExists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch { return false; }
}

async function upload(localPath, key) {
  const buf = fs.readFileSync(localPath);
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: buf, ContentType: 'image/jpeg',
  }));
}

async function runPool(tasks, concurrency, fn) {
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const t = tasks[i++];
      await fn(t);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

async function main() {
  console.log('\n  Homi cover sync\n  ───────────────\n');

  const covers = findCovers(UNZIPS_DIR);
  console.log(`  Found ${covers.length} capa-min.jpg files locally\n`);

  let checked = 0, uploaded = 0, existed = 0, errors = 0;
  const startMs = Date.now();

  await runPool(covers, CONCURRENCY, async ({ local, album }) => {
    const key = (PREFIX + album + '/capa-min.jpg').normalize('NFC');
    try {
      if (await headExists(key)) {
        existed++;
      } else {
        await upload(local, key);
        uploaded++;
      }
    } catch (e) {
      errors++;
      console.error(`\n  ERR ${album}: ${e.message}`);
    }
    checked++;
    if (checked % 100 === 0 || checked === covers.length) {
      const pct = ((checked / covers.length) * 100).toFixed(1);
      process.stdout.write(`\r  [${pct}%]  checked=${checked}  uploaded=${uploaded}  existed=${existed}  err=${errors}   `);
    }
  });

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  process.stdout.write('\n');
  console.log(`\n  Done in ${elapsed}s — uploaded=${uploaded}  existed=${existed}  errors=${errors}\n`);
}

main().catch(e => { console.error('\n  Fatal:', e.message); process.exit(1); });
