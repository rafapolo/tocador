#!/usr/bin/env bun
/**
 * Enrich single-track slug-titled albums using AudD audio recognition.
 * Sends the CDN URL directly — no download needed.
 *
 * Progress saved to data/audd_extracted.json (resumes from where it left off).
 * On completion, patches data/homi-albums.json.gz in-place.
 *
 * Usage:
 *   AUDD_KEY=xxx bun script/enrich-singles-audd.js [--dry-run] [--limit N] [--apply-only]
 *
 *   --apply-only  skip recognition, just apply existing audd_extracted.json to the JSON
 */

import zlib from 'zlib';
import fs from 'fs';

const INPUT      = 'data/homi-albums.json.gz';
const CACHE_FILE = 'data/audd_extracted.json';
const AUDD_URL   = 'https://api.audd.io/';
const RATE_MS    = 1100;

const DRY_RUN    = process.argv.includes('--dry-run');
const APPLY_ONLY = process.argv.includes('--apply-only');
const LIMIT      = (() => { const i = process.argv.indexOf('--limit'); return i >= 0 ? +process.argv[i+1] : Infinity; })();
const AUDD_KEY   = process.env.AUDD_KEY || '';

if (!AUDD_KEY && !APPLY_ONLY) { console.error('Set AUDD_KEY env var'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isSlug(s) {
  return s.includes('-') && /^[a-z0-9][a-z0-9\-]+(\-\d{4})?$/.test(s);
}

function bestGenre(genreNames) {
  if (!genreNames?.length) return '';
  return genreNames.find(g => g !== 'Music' && g !== 'Música') || genreNames[0] || '';
}

function norm(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Returns true if the AudD artist plausibly matches the album artist.
// Requires at least one word overlap, or the album artist slug contains
// the first word of the AudD artist.
function artistMatches(albumArtist, auddArtist) {
  const a = norm(albumArtist).split(' ').filter(Boolean);
  const b = norm(auddArtist).split(' ').filter(Boolean);
  if (!a.length || !b.length) return false;
  // any word overlap
  if (a.some(w => b.includes(w) && w.length > 2)) return true;
  // album artist slug contains first word of audd artist (e.g. "naufragio" ↔ "Naufrágio")
  const slugA = norm(albumArtist).replace(/\s/g, '');
  if (slugA.includes(b[0]) && b[0].length > 3) return true;
  return false;
}

function gunzip(path) {
  return new Promise((ok, fail) => {
    zlib.gunzip(fs.readFileSync(path), (e, d) => e ? fail(e) : ok(JSON.parse(d)));
  });
}

function gzip(obj, path) {
  return new Promise((ok, fail) => {
    zlib.gzip(Buffer.from(JSON.stringify(obj)), { level: 9 }, (e, d) => {
      if (e) return fail(e);
      fs.writeFileSync(path, d);
      ok();
    });
  });
}

async function recognize(url) {
  const body = new URLSearchParams({
    api_token: AUDD_KEY,
    url,
    return: 'apple_music,spotify',
  });
  const res = await fetch(AUDD_URL, { method: 'POST', body });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function runRecognition(db, cache) {
  const base = db.meta.base_url;
  const targets = db.albums.filter(a =>
    a.tracks.length === 1 &&
    a.artist?.trim() &&
    isSlug(a.title)
  );

  const todo = targets.filter(a => !(a.path in cache)).slice(0, LIMIT);
  console.error(`Targets: ${targets.length} total, ${todo.length} not yet processed`);
  if (DRY_RUN) console.error('DRY RUN — no changes written\n');

  let recognized = 0, missed = 0, errors = 0;

  for (let i = 0; i < todo.length; i++) {
    const album = todo[i];
    const track = album.tracks[0];
    const url = `${base}/${encodeURI(album.path)}/${encodeURI(track.file)}`;
    const label = `${album.artist} | ${album.title}`;

    process.stderr.write(`\r[${i+1}/${todo.length}] ${label.slice(0,70).padEnd(70)}`);

    let data;
    try {
      data = await recognize(url);
    } catch (e) {
      process.stderr.write(`\n  ERROR: ${e.message}\n`);
      cache[album.path] = { status: 'error', error: e.message };
      errors++;
      await sleep(RATE_MS);
      continue;
    }

    if (data.status === 'error') {
      const code = data.error?.error_code;
      if (code === 900) {
        process.stderr.write('\n  QUOTA/AUTH error — stopping\n');
        break;
      }
      cache[album.path] = { status: 'api_error', error: data.error };
      errors++;
    } else if (!data.result) {
      cache[album.path] = { status: 'not_found' };
      missed++;
    } else {
      cache[album.path] = { status: 'found', result: data.result };
      recognized++;
      const r = data.result;
      const am = r.apple_music || {};
      process.stderr.write(`\n  ✓ ${r.artist} — ${r.title} (${r.release_date?.slice(0,4)}) [${bestGenre(am.genreNames)}]\n`);
    }

    if (!DRY_RUN) fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    await sleep(RATE_MS);
  }

  process.stderr.write('\n');
  console.error(`Recognition: ${recognized} found, ${missed} not found, ${errors} errors`);
}

function applyCache(db, cache) {
  let patched = 0;

  for (const album of db.albums) {
    const entry = cache[album.path];
    if (!entry || entry.status !== 'found') continue;

    const r = entry.result;
    const track = album.tracks[0];
    const am = r.apple_music || {};
    const changes = {};

    // Only apply title/track/year changes when the artist fingerprint confirms identity.
    // Genre is safe to apply even on partial matches.
    const artistOk = artistMatches(album.artist, r.artist);

    if (artistOk && isSlug(album.title) && r.title) changes.albumTitle = r.title;
    if (artistOk && isSlug(track.title) && r.title)  changes.trackTitle = r.title;
    if (artistOk && !track.num && am.trackNumber)     changes.trackNum = am.trackNumber;
    if (!album.genre) {
      const g = bestGenre(am.genreNames);
      if (g && artistOk) changes.genre = g;
    }
    if (artistOk && r.release_date) {
      const y = +r.release_date.slice(0, 4);
      if (y && Math.abs(y - album.year) > 2) changes.year = y;
    }

    if (!Object.keys(changes).length) continue;

    if (DRY_RUN) {
      console.log(`[DRY] ${album.artist} | ${album.title}`);
      console.log(`  → ${r.artist} — ${r.title} | changes: ${JSON.stringify(changes)}`);
    } else {
      if (changes.albumTitle) album.title = changes.albumTitle;
      if (changes.trackTitle) track.title = changes.trackTitle;
      if (changes.trackNum)   track.num   = changes.trackNum;
      if (changes.genre)      album.genre = changes.genre;
      if (changes.year)       album.year  = changes.year;
    }
    patched++;
  }

  console.error(`Applied: ${patched} albums patched`);
  return patched;
}

async function main() {
  const db = await gunzip(INPUT);
  const cache = fs.existsSync(CACHE_FILE)
    ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
    : {};

  if (!APPLY_ONLY) {
    await runRecognition(db, cache);
  } else {
    const found = Object.values(cache).filter(e => e.status === 'found').length;
    console.error(`Cache: ${Object.keys(cache).length} entries, ${found} found`);
  }

  const patched = applyCache(db, cache);

  if (!DRY_RUN && patched > 0) {
    await gzip(db, INPUT);
    console.error(`Saved → ${INPUT}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
