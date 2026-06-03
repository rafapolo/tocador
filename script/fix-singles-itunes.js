#!/usr/bin/env bun
/**
 * Enriches single-track albums in homi-albums.json.gz using the iTunes Search API.
 * Fills in: artist (if empty), genre, track title (if slug), track number (if missing).
 *
 * Usage:
 *   bun script/fix-singles-itunes.js [--dry-run] [--limit N] [--min-score 0.6]
 */

import zlib from 'zlib';
import fs from 'fs';

const INPUT = 'data/homi-albums.json.gz';
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i >= 0 ? +process.argv[i + 1] : Infinity; })();
const MIN_SCORE = (() => { const i = process.argv.indexOf('--min-score'); return i >= 0 ? +process.argv[i + 1] : 0.62; })();
const RATE_MS = 180;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function norm(s) {
  if (!s) return '';
  return s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function jaccard(a, b) {
  const sa = new Set(norm(a).split(' ').filter(Boolean));
  const sb = new Set(norm(b).split(' ').filter(Boolean));
  if (!sa.size || !sb.size) return 0;
  const inter = new Set([...sa].filter(x => sb.has(x)));
  return inter.size / (sa.size + sb.size - inter.size);
}

function isSlug(s) {
  // Must contain at least one dash (slugs are hyphenated), all lowercase alphanumeric
  return s.includes('-') && /^[a-z0-9][a-z0-9\-]+(\-\d{4})?$/.test(s);
}

function deSlug(slug, artist) {
  // Remove trailing -YYYY
  let s = slug.replace(/\-\d{4}$/, '');
  // Remove leading artist prefix (normalized dash-joined)
  if (artist) {
    const artistSlug = norm(artist).replace(/\s/g, '-');
    if (s.startsWith(artistSlug + '-')) s = s.slice(artistSlug.length + 1);
    else if (s.startsWith(norm(artist).replace(/\s/g, '') + '-')) {
      s = s.slice(norm(artist).replace(/\s/g, '').length + 1);
    }
  }
  return s.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
}

async function searchItunes(query, country = 'br') {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=musicTrack&country=${country}&limit=10`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return data.results || [];
}

function score(result, album) {
  const track = album.tracks[0];
  const albumTitle = album.title;
  const albumArtist = album.artist || '';
  const albumYear = album.year || 0;
  const trackTitle = track.title;
  const slug = isSlug(trackTitle);
  const slugTitle = slug ? deSlug(trackTitle, albumArtist || null) : trackTitle;

  const iArtist = result.artistName || '';
  const iTrack = result.trackName || '';
  const iYear = result.releaseDate ? +result.releaseDate.slice(0, 4) : 0;

  let titleScore, artistScore;

  if (albumArtist) {
    // We have an artist: match track title against iTunes trackName
    titleScore = Math.max(jaccard(albumTitle, iTrack), jaccard(slugTitle, iTrack));
    artistScore = jaccard(albumArtist, iArtist);
  } else {
    // No artist: album title = "Artist Track" or "Artist - Track"
    // Compare full album title against (itunesArtist + itunesTrack)
    const combined = `${iArtist} ${iTrack}`;
    titleScore = Math.max(
      jaccard(albumTitle, combined),
      jaccard(albumTitle, iTrack),
      jaccard(slugTitle, iTrack)
    );
    // Partial artist match from album title prefix
    artistScore = jaccard(albumTitle.split(' ')[0], iArtist) * 0.5;
  }

  const yearScore = (albumYear && iYear)
    ? [1, 0.8, 0.5, 0.2][Math.min(Math.abs(albumYear - iYear), 3)]
    : 0.4;

  const total = titleScore * 0.55 + artistScore * 0.30 + yearScore * 0.15;
  return { total, iArtist, iTrack, iYear, iGenre: result.primaryGenreName || '', iTrackNum: result.trackNumber || 0 };
}

async function bestMatch(album) {
  const track = album.tracks[0];
  const artist = album.artist || '';
  const slug = isSlug(track.title);
  const humanTitle = slug ? deSlug(track.title, artist || null) : track.title;
  const albumSlug = isSlug(album.title);
  const humanAlbum = albumSlug ? deSlug(album.title, artist || null) : album.title;

  const query = artist
    ? `${artist} ${humanAlbum !== humanTitle ? humanAlbum : humanTitle}`
    : humanAlbum;

  let results = await searchItunes(query, 'br');
  await sleep(RATE_MS);

  if (!results.length) {
    results = await searchItunes(query, 'us');
    await sleep(RATE_MS);
  }
  if (!results.length) return null;

  const scored = results.map(r => ({ r, ...score(r, album) })).sort((a, b) => b.total - a.total);
  const best = scored[0];
  return best.total >= MIN_SCORE ? best : null;
}

async function main() {
  const buf = fs.readFileSync(INPUT);
  const raw = await new Promise((ok, fail) => zlib.gunzip(buf, (e, d) => e ? fail(e) : ok(d)));
  const db = JSON.parse(raw);

  const singles = db.albums.filter(a => a.tracks.length === 1);
  const candidates = singles.filter(a => {
    const t = a.tracks[0];
    return !a.artist || !a.artist.trim() || isSlug(t.title) || isSlug(a.title) || !t.num;
  }).slice(0, LIMIT);

  console.error(`Singles: ${singles.length} total, ${candidates.length} candidates`);
  if (DRY_RUN) console.error('DRY RUN — no changes written\n');

  let enriched = 0, unchanged = 0, missed = 0;

  for (let i = 0; i < candidates.length; i++) {
    const album = candidates[i];
    const track = album.tracks[0];
    const label = `${album.artist || '?'} - ${album.title}`.slice(0, 60);
    process.stderr.write(`\r[${i + 1}/${candidates.length}] ${label.padEnd(60)}`);

    let match;
    try {
      match = await bestMatch(album);
    } catch (e) {
      process.stderr.write(`\n  ERROR: ${e.message}\n`);
      missed++;
      continue;
    }

    if (!match) { missed++; continue; }

    const changes = {};
    if ((!album.artist || !album.artist.trim()) && match.iArtist) {
      changes.artist = match.iArtist;
    }
    if (isSlug(album.title) && match.iTrack) {
      changes.albumTitle = match.iTrack;
    }
    if (isSlug(track.title) && match.iTrack) {
      changes.trackTitle = match.iTrack;
    }
    if (!track.num && match.iTrackNum) {
      changes.trackNum = match.iTrackNum;
    }
    if (match.iGenre && !album.genre) {
      changes.genre = match.iGenre;
    }

    if (!Object.keys(changes).length) { unchanged++; continue; }

    if (DRY_RUN) {
      process.stderr.write('\n');
      console.log(`[${(match.total).toFixed(2)}] ${label}`);
      console.log(`  iTunes: ${match.iArtist} | ${match.iTrack} | ${match.iYear} | ${match.iGenre}`);
      console.log(`  Changes: ${JSON.stringify(changes)}\n`);
    } else {
      if (changes.artist) album.artist = changes.artist;
      if (changes.albumTitle) album.title = changes.albumTitle;
      if (changes.trackTitle) track.title = changes.trackTitle;
      if (changes.trackNum) track.num = changes.trackNum;
      if (changes.genre) album.genre = changes.genre;
    }
    enriched++;
  }

  process.stderr.write('\n');
  console.error(`Done: ${enriched} enriched, ${unchanged} already complete, ${missed} not matched`);

  if (!DRY_RUN && enriched > 0) {
    const outBuf = await new Promise((ok, fail) =>
      zlib.gzip(Buffer.from(JSON.stringify(db)), { level: 9 }, (e, d) => e ? fail(e) : ok(d))
    );
    fs.writeFileSync(INPUT, outBuf);
    console.error(`Saved → ${INPUT}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
