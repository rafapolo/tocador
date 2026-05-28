#!/usr/bin/env node
'use strict';

// One-time migration: copy S3 keys that are NFD → NFC, then delete originals.
// Safe to re-run: skips keys already in NFC.

const fs   = require('fs');
const path = require('path');
const { S3Client, ListObjectsV2Command, CopyObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

function loadEnv(file = '.env') {
  const p = path.resolve(__dirname, '..', file);
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) process.env[m[1]] = m[2];
  }
}
loadEnv();

const BUCKET     = process.env.S3_BUCKET;
const ENDPOINT   = process.env.S3_ENDPOINT || 'https://hel1.your-objectstorage.com';
const PREFIXES   = (process.argv[2] || 'indie/,uqt/').split(',');
const CONCURRENCY = 20;

if (!process.env.AWS_ACCESS_KEY_ID) throw new Error('Missing AWS credentials in .env');

const s3 = new S3Client({
  endpoint: ENDPOINT, region: 'hel1', forcePathStyle: true,
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY },
});

async function listAll(prefix) {
  const keys = [];
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents ?? []) keys.push(o.Key);
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function renameKey(src) {
  const dst = src.normalize('NFC');
  if (dst === src) return false;
  const encodedSrc = src.split('/').map(encodeURIComponent).join('/');
  await s3.send(new CopyObjectCommand({
    Bucket: BUCKET, Key: dst,
    CopySource: `${BUCKET}/${encodedSrc}`,
  }));
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: src }));
  return true;
}

async function runPool(tasks, concurrency, fn) {
  let i = 0, active = 0, done = 0;
  return new Promise((resolve, reject) => {
    function next() {
      while (active < concurrency && i < tasks.length) {
        const task = tasks[i++];
        active++;
        fn(task).then(changed => {
          active--;
          done++;
          if (changed) process.stdout.write('.');
          if (done % 500 === 0) process.stdout.write(` ${done}\n`);
          if (i < tasks.length) next();
          else if (active === 0) resolve();
        }).catch(reject);
      }
    }
    next();
  });
}

(async () => {
  for (const prefix of PREFIXES) {
    console.log(`\nScanning ${prefix}...`);
    const keys = await listAll(prefix);
    const nfdKeys = keys.filter(k => k !== k.normalize('NFC'));
    console.log(`  ${keys.length} total, ${nfdKeys.length} NFD keys to normalize`);
    if (nfdKeys.length === 0) continue;
    process.stdout.write('  Normalizing ');
    await runPool(nfdKeys, CONCURRENCY, renameKey);
    console.log(`\n  Done.`);
  }
  console.log('\nAll done.');
})();
