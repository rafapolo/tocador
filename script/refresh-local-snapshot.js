#!/usr/bin/env bun
// Refreshes the local working copy of the homi catalogue from the published one.
//
// data/homi-albums.json.gz is gitignored — it is a scratch artifact that the
// v1-era maintenance scripts (dedup-homi.js, fix-singles-itunes.js,
// enrich-singles-audd.js, normalize-track-prefixes.js) read and rewrite in
// place, and that two regression tests in normalize-track-prefixes.test.js
// assert against. Nothing refreshes it automatically, so it drifts: on
// 2026-08-22 it was an Aug 11 snapshot with 6844 albums while the published
// catalogue had moved to 6683, and it was failing a data-quality test over two
// albums that no longer exist upstream.
//
// Deliberately writes **v1**, not a byte copy. The published catalogue is v2
// (columnar) and every script above indexes `db.albums`, which v2 does not
// have — a plain `cp` would leave them throwing TypeErrors on a shape they
// never expected. decodeAcervo() is the same decoder the player uses, so the
// v1 this produces is exactly what those scripts were written against.

import { gunzipSync, gzipSync } from 'zlib';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import '../js/acervo-format.js';

const SRC = process.argv[2] ?? '../hominiscanidae/data/homi-albums.json.gz';
const DEST = process.argv[3] ?? 'data/homi-albums.json.gz';

if (!existsSync(SRC)) {
  console.error(`Source not found: ${SRC}`);
  console.error('Pass the published catalogue explicitly, e.g.:');
  console.error('  bun script/refresh-local-snapshot.js ../hominiscanidae/data/homi-albums.json.gz');
  process.exit(1);
}

const raw = JSON.parse(gunzipSync(readFileSync(SRC)).toString());
const db = decodeAcervo(raw);

if (!Array.isArray(db.albums)) {
  console.error(`Decoded payload has no albums array — is ${SRC} a valid acervo?`);
  process.exit(1);
}

const before = existsSync(DEST)
  ? JSON.parse(gunzipSync(readFileSync(DEST)).toString()).albums?.length ?? 0
  : 0;

const tracks = db.albums.reduce((n, a) => n + (a.tracks?.length ?? 0), 0);
const gz = gzipSync(Buffer.from(JSON.stringify(db)), { level: 6 });
writeFileSync(DEST, gz);

console.log(`Source:  ${SRC} (v${raw.v ?? 1})`);
console.log(`Dest:    ${DEST} (v1, ${(gz.length / 1024).toFixed(1)} KB)`);
console.log(`Albums:  ${before} -> ${db.albums.length}`);
console.log(`Tracks:  ${tracks}`);
