#!/usr/bin/env bun
import { mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { gzipSync } from 'zlib';

// --acervo homi (default) | uqt. Only homi has the legacy genres.json; uqt comes from the audio analysis alone.
const ai = process.argv.indexOf('--acervo');
const ACERVO = ai > 0 ? process.argv[ai + 1] : 'homi';
if (!['homi', 'uqt'].includes(ACERVO)) { console.error('--acervo homi|uqt'); process.exit(1); }

const INPUT  = ACERVO === 'homi' ? resolve(import.meta.dir, '../data/genres/genres.json') : null;
const OUTPUT = resolve(import.meta.dir, `../data/${ACERVO}-genres.json.gz`);
// Every genre any track of the album has in its top 3, most voted first: what the player filters the grid by,
// the same rule as its per-track filter. The winner-only file above stays for players that cached the old ui.js
// (an array where they expect a string would break them).
const OUTPUT_ALL = resolve(import.meta.dir, `../data/${ACERVO}-album-genres.json.gz`);

const FEATURES = resolve(import.meta.dir, `../data/features/${ACERVO}.jsonl`);

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
if (INPUT && await Bun.file(INPUT).exists()) {
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

// { v: 2, g: [genre names], a: { "<album path>": [genre index, …] } }, each album's list most voted first.
const names = [], nameIdx = new Map();
const all = {};
for (const [album, votes] of votesByAlbum) {
  const sorted = Object.entries(votes).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
  if (!sorted.length) continue;
  all[album] = sorted.map(([label]) => {
    if (!nameIdx.has(label)) { nameIdx.set(label, names.length); names.push(label); }
    return nameIdx.get(label);
  });
}

mkdirSync(dirname(OUTPUT), { recursive: true });
await Bun.write(OUTPUT, gzipSync(Buffer.from(JSON.stringify(index))));
const allGz = gzipSync(Buffer.from(JSON.stringify({ v: 2, g: names, a: all })));
await Bun.write(OUTPUT_ALL, allGz);
console.log(`wrote ${Object.keys(all).length} albums, ${names.length} genres (${(allGz.length / 1024).toFixed(1)} KB gz) → ${OUTPUT_ALL}`);

const size = (JSON.stringify(index).length / 1024).toFixed(1);
console.log(`wrote ${Object.keys(index).length} albums (${missing} skipped, ~${size} KB raw) → ${OUTPUT}`);
