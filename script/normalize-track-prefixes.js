#!/usr/bin/env bun
// Fixes two normalization bugs in the homi acervo JSON:
//
// Bug A — multi-track albums where all track titles embed the artist as a prefix
//   e.g. "psilosamples - bieja" → "bieja"  (artist already set on album)
//
// Bug B — single-track Bandcamp slug albums where title === path (generator fallback)
//   e.g. path/title "2024 - Astral Comedy Young Riddance", track "astral-comedy-young-riddance-2024"
//   → title "Young Riddance", artist "Astral Comedy", track title "Young Riddance"

import { gunzipSync, gzipSync } from 'zlib';
import { readFileSync, writeFileSync } from 'fs';

const DATA = 'data/homi-albums.json.gz';
const buf = readFileSync(DATA);
const db = JSON.parse(gunzipSync(buf).toString());

// ── helpers ──────────────────────────────────────────────────────────────────

function titleCase(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

function unslug(slug) {
  // Remove trailing -YYYY and un-hyphenate
  return titleCase(slug.replace(/-\d{4}$/, '').replace(/-/g, ' '));
}

function startsWithCI(str, prefix) {
  return str.toLowerCase().startsWith(prefix.toLowerCase());
}

function stripArtistPrefix(title, artist) {
  const prefix = artist + ' - ';
  let t = title;
  while (startsWithCI(t, prefix)) {
    t = t.slice(prefix.length).trim();
  }
  return t;
}

// ── Step 1: build artist lookup from clean albums ─────────────────────────────
// "clean" = artist is non-empty AND title !== path (properly parsed)

const knownArtists = new Set();
for (const album of db.albums) {
  if (album.artist && album.title !== album.path) {
    knownArtists.add(album.artist);
  }
}

// Sort by length descending so the longest (most specific) match wins
const sortedArtists = [...knownArtists].sort((a, b) => b.length - a.length);

function inferArtist(combined) {
  for (const artist of sortedArtists) {
    if (startsWithCI(combined, artist + ' ') || combined.toLowerCase() === artist.toLowerCase()) {
      return artist;
    }
  }
  return null;
}

// ── Step 2: fix Bug B — slug/fallback albums ──────────────────────────────────

const RE_YEAR_PREFIX = /^(\d{4})\s*-\s*(.+)$/;
const RE_SLUG = /^[a-z][a-z0-9-]+$/;

let fixedB = 0;

for (const album of db.albums) {
  if (album.title !== album.path) continue; // already clean

  const m = album.path.match(RE_YEAR_PREFIX);
  if (!m) continue;

  const year = parseInt(m[1], 10);
  let combined = m[2].trim(); // e.g. "Astral Comedy Young Riddance"

  if (album.year === 0) album.year = year;
  album.title = combined; // at minimum strip the year prefix

  // Try to split into artist + album title using known artists
  const artist = inferArtist(combined);
  if (artist) {
    album.artist = artist;
    const remainder = combined.slice(artist.length).trim();
    if (remainder) album.title = remainder;
  }

  // Fix slug track titles
  for (const track of album.tracks ?? []) {
    if (RE_SLUG.test(track.title)) {
      let clean = unslug(track.title);
      // If artist was inferred and the un-slugged title starts with it, strip it
      if (album.artist && startsWithCI(clean, album.artist + ' ')) {
        clean = clean.slice(album.artist.length).trim();
      }
      // Fall back to album title if we get an empty string or the full combined name
      if (!clean || clean.toLowerCase() === combined.toLowerCase()) {
        clean = album.title;
      }
      track.title = clean;
    }
  }

  fixedB++;
}

// ── Step 3: fix Bug A — multi-track artist-prefix track titles ────────────────

let fixedA = 0;

for (const album of db.albums) {
  if (!album.artist || !album.tracks?.length) continue;

  const prefix = album.artist + ' - ';
  const matching = album.tracks.filter(t => startsWithCI(t.title, prefix));
  if (matching.length / album.tracks.length < 0.5) continue;

  for (const track of album.tracks) {
    const stripped = stripArtistPrefix(track.title, album.artist);
    if (stripped !== track.title) track.title = stripped;
  }

  fixedA++;
}

// ── Step 4: write back ────────────────────────────────────────────────────────

const json = JSON.stringify(db);
const gz = gzipSync(Buffer.from(json), { level: 6 });
writeFileSync(DATA, gz);

console.log(`Fixed ${fixedA} albums (Bug A: multi-track artist prefix)`);
console.log(`Fixed ${fixedB} albums (Bug B: slug/fallback title)`);
console.log(`Output: ${DATA} (${(gz.length / 1024).toFixed(1)} KB)`);
