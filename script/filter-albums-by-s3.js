#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const MC_ALIAS = process.env.MC_ALIAS || 'hel1';

function loadEnv(file = '.env') {
  const p = path.resolve(__dirname, '..', file);
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) process.env[m[1]] = m[2];
  }
}

loadEnv();

const BUCKET = process.env.S3_BUCKET;

const jsonGzPath = process.env.ACERVO_JSON || path.resolve(__dirname, '../js/uqt-albums.json.gz');
const db = JSON.parse(zlib.gunzipSync(fs.readFileSync(jsonGzPath)));
console.log(`DB loaded: ${db.albums.length} albums`);

const PREFIX = (db.meta?.s3_prefix || process.env.S3_PREFIX || 'uqt').replace(/\/$/, '');
const MC_BASE = `${MC_ALIAS}/${BUCKET}/${PREFIX}`;

console.log(`Listing S3 paths at ${MC_BASE}/…`);
const mcOut = execSync(`mc ls "${MC_BASE}/"`, { encoding: 'utf8' });
const s3Paths = new Set(
  mcOut.split('\n')
    .map(l => { const m = l.match(/^\[.*?\]\s+\S+\s+(.*)\/$$/); return m ? m[1] : null; })
    .filter(Boolean)
);
console.log(`S3 has ${s3Paths.size} album directories`);

const filtered = db.albums.filter(a => s3Paths.has(a.path));
const removed  = db.albums.length - filtered.length;
console.log(`Keeping ${filtered.length} albums, removing ${removed} with no S3 path`);

const out = { meta: db.meta, albums: filtered };
fs.writeFileSync(jsonGzPath, zlib.gzipSync(Buffer.from(JSON.stringify(out))));
console.log(`Written: ${jsonGzPath}  (${Math.round(fs.statSync(jsonGzPath).size / 1024)} KB)`);
