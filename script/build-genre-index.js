#!/usr/bin/env bun
import { mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { gzipSync } from 'zlib';

const INPUT  = resolve(import.meta.dir, '../data/genres/genres.json');
const OUTPUT = resolve(import.meta.dir, '../data/homi-genres.json.gz');

const FEATURES = resolve(import.meta.dir, '../data/features/homi.jsonl');

// album -> vote counts. Fresh analysis (analyze-tracks.py) wins; the old genres.json
// only fills albums that have not been analyzed yet.
const votesByAlbum = new Map();
const vote = (album, labels) => {
  const v = votesByAlbum.get(album) ?? {};
  for (const label of labels) v[label] = (v[label] || 0) + 1;
  votesByAlbum.set(album, v);
};

let fromFeatures = 0;
const featured = new Set();
if (await Bun.file(FEATURES).exists()) {
  console.log('reading', FEATURES);
  for (const line of (await Bun.file(FEATURES).text()).split('\n')) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }   // truncated last line
    if (r.error || !Array.isArray(r.genre)) continue;
    const slash = r.k.lastIndexOf('/');
    if (slash < 0) continue;
    const album = r.k.slice(0, slash).normalize('NFC');
    featured.add(album);
    vote(album, r.genre.slice(0, 3).map(g => g[0]));    // top 3 per track, as before
    fromFeatures++;
  }
}

let fromLegacy = 0;
if (await Bun.file(INPUT).exists()) {
  console.log('reading', INPUT);
  const genres = JSON.parse(await Bun.file(INPUT).text());
  for (const [albumKey, tracks] of Object.entries(genres)) {
    const album = albumKey.normalize('NFC');
    if (featured.has(album) || !tracks || typeof tracks !== 'object') continue;
    for (const trackData of Object.values(tracks)) {
      if (!Array.isArray(trackData.genres)) continue;
      const top3 = [...trackData.genres].sort((a, b) => b.score - a.score).slice(0, 3);
      vote(album, top3.map(g => g.label));
    }
    fromLegacy++;
  }
}
console.log(`${featured.size} albums from features (${fromFeatures} tracks), ${fromLegacy} from legacy genres.json`);

const index = {};
let missing = 0;
for (const [album, votes] of votesByAlbum) {
  let winner = null, best = 0;
  for (const [label, count] of Object.entries(votes)) {
    if (count > best) { winner = label; best = count; }
  }
  if (winner) index[album] = winner;
  else missing++;
}

mkdirSync(dirname(OUTPUT), { recursive: true });
await Bun.write(OUTPUT, gzipSync(Buffer.from(JSON.stringify(index))));

const size = (JSON.stringify(index).length / 1024).toFixed(1);
console.log(`wrote ${Object.keys(index).length} albums (${missing} skipped, ~${size} KB raw) → ${OUTPUT}`);
