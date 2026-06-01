#!/usr/bin/env bun
import { mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { gzipSync } from 'zlib';

const INPUT  = resolve(import.meta.dir, '../../hominiscanidae/data/genres.json');
const OUTPUT = resolve(import.meta.dir, '../../hominiscanidae/data/homi-genres.json.gz');

console.log('reading', INPUT);
const genres = JSON.parse(await Bun.file(INPUT).text());

const index = {};
let missing = 0;

for (const [albumKey, tracks] of Object.entries(genres)) {
  if (!tracks || typeof tracks !== 'object') { missing++; continue; }

  const votes = {};
  for (const trackData of Object.values(tracks)) {
    if (!Array.isArray(trackData.genres)) continue;
    // top 3 by score
    const top3 = [...trackData.genres].sort((a, b) => b.score - a.score).slice(0, 3);
    for (const { label } of top3) {
      votes[label] = (votes[label] || 0) + 1;
    }
  }

  let winner = null, best = 0;
  for (const [label, count] of Object.entries(votes)) {
    if (count > best) { winner = label; best = count; }
  }

  if (winner) index[albumKey.normalize('NFC')] = winner;
  else missing++;
}

mkdirSync(dirname(OUTPUT), { recursive: true });
await Bun.write(OUTPUT, gzipSync(Buffer.from(JSON.stringify(index))));

const size = (JSON.stringify(index).length / 1024).toFixed(1);
console.log(`wrote ${Object.keys(index).length} albums (${missing} skipped, ~${size} KB raw) → ${OUTPUT}`);
