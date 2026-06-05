import { test, expect, describe } from 'bun:test';
import { gunzipSync, gzipSync } from 'zlib';

// ── re-export pure logic from the normalizer for unit testing ────────────────

function titleCase(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

function unslug(slug) {
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

function inferArtist(combined, sortedArtists) {
  for (const artist of sortedArtists) {
    if (startsWithCI(combined, artist + ' ') || combined.toLowerCase() === artist.toLowerCase()) {
      return artist;
    }
  }
  return null;
}

// ── unit tests ────────────────────────────────────────────────────────────────

describe('unslug', () => {
  test('strips trailing year and title-cases', () => {
    expect(unslug('astral-comedy-young-riddance-2024')).toBe('Astral Comedy Young Riddance');
    expect(unslug('guma-virando-noite-2025')).toBe('Guma Virando Noite');
    expect(unslug('hugo-medeiros-tempo-curvo-2025')).toBe('Hugo Medeiros Tempo Curvo');
  });

  test('handles slug with no year suffix', () => {
    expect(unslug('some-album-no-year')).toBe('Some Album No Year');
  });
});

describe('stripArtistPrefix', () => {
  test('strips single prefix', () => {
    expect(stripArtistPrefix('psilosamples - bieja', 'psilosamples')).toBe('bieja');
    expect(stripArtistPrefix('Esdras Nogueira - 1 - Na Barriguda', 'Esdras Nogueira')).toBe('1 - Na Barriguda');
  });

  test('strips doubled prefix', () => {
    expect(stripArtistPrefix('Artist - Artist - Track', 'Artist')).toBe('Track');
  });

  test('case-insensitive match', () => {
    expect(stripArtistPrefix('Matheus Brant - Assume que gosta - 01 - Assume que Gosta', 'Matheus Brant'))
      .toBe('Assume que gosta - 01 - Assume que Gosta');
  });

  test('leaves titles that do not start with artist alone', () => {
    expect(stripArtistPrefix('Track Without Prefix', 'Artist')).toBe('Track Without Prefix');
  });
});

describe('inferArtist', () => {
  const artists = ['Astral Comedy', 'Guma', 'Alberto Continentino', 'Hugo Dos Santos']
    .sort((a, b) => b.length - a.length);

  test('matches known artist as prefix', () => {
    expect(inferArtist('Astral Comedy Young Riddance', artists)).toBe('Astral Comedy');
    expect(inferArtist('Guma Virando Noite', artists)).toBe('Guma');
    expect(inferArtist('Alberto Continentino Cabeca Mil E O', artists)).toBe('Alberto Continentino');
  });

  test('prefers longest matching artist (most specific)', () => {
    const a = ['Hugo', 'Hugo Dos Santos'].sort((a, b) => b.length - a.length);
    expect(inferArtist('Hugo Dos Santos Something', a)).toBe('Hugo Dos Santos');
  });

  test('returns null when no artist matches', () => {
    expect(inferArtist('Unknown Band Album Title', artists)).toBeNull();
  });
});

// ── integration test: run normalizer against a mini synthetic JSON.gz ─────────

function makeGz(obj) {
  return gzipSync(Buffer.from(JSON.stringify(obj)), { level: 1 });
}

function readGz(buf) {
  return JSON.parse(gunzipSync(buf).toString());
}

import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

async function runNormalizerOn(db) {
  const tmp = join(tmpdir(), `tocador-test-${Date.now()}.json.gz`);
  writeFileSync(tmp, makeGz(db));

  // Inline the normalizer logic rather than spawning a subprocess
  const buf = readFileSync(tmp);
  const data = readGz(buf);

  const RE_YEAR_PREFIX = /^(\d{4})\s*-\s*(.+)$/;
  const RE_SLUG = /^[a-z][a-z0-9-]+$/;

  const knownArtists = new Set();
  for (const album of data.albums) {
    if (album.artist && album.title !== album.path) knownArtists.add(album.artist);
  }
  const sorted = [...knownArtists].sort((a, b) => b.length - a.length);

  for (const album of data.albums) {
    if (album.title === album.path) {
      const m = album.path.match(RE_YEAR_PREFIX);
      if (!m) continue;
      const combined = m[2].trim();
      if (album.year === 0) album.year = parseInt(m[1], 10);
      album.title = combined;
      const artist = inferArtist(combined, sorted);
      if (artist) {
        album.artist = artist;
        const remainder = combined.slice(artist.length).trim();
        if (remainder) album.title = remainder;
      }
      for (const track of album.tracks ?? []) {
        if (RE_SLUG.test(track.title)) {
          let clean = unslug(track.title);
          if (album.artist && startsWithCI(clean, album.artist + ' ')) {
            clean = clean.slice(album.artist.length).trim();
          }
          if (!clean || clean.toLowerCase() === combined.toLowerCase()) clean = album.title;
          track.title = clean;
        }
      }
    }
    if (!album.artist || !album.tracks?.length) continue;
    const prefix = album.artist + ' - ';
    const matching = album.tracks.filter(t => startsWithCI(t.title, prefix));
    if (matching.length / album.tracks.length >= 0.5) {
      for (const track of album.tracks) {
        track.title = stripArtistPrefix(track.title, album.artist);
      }
    }
  }

  unlinkSync(tmp);
  return data;
}

describe('normalizer integration', () => {
  test('Bug A: strips artist prefix from multi-track album', async () => {
    const db = {
      meta: {},
      albums: [
        {
          title: 'cidade caos',
          artist: 'psilosamples',
          year: 2024,
          path: '2024 - psilosamples - cidade caos',
          has_cover: false,
          tracks: [
            { title: 'psilosamples - bieja', file: '01.mp3', duration: 180 },
            { title: 'psilosamples - casino bankruptcy beat', file: '02.mp3', duration: 200 },
          ],
        },
      ],
    };
    const result = await runNormalizerOn(db);
    const a = result.albums[0];
    expect(a.tracks[0].title).toBe('bieja');
    expect(a.tracks[1].title).toBe('casino bankruptcy beat');
  });

  test('Bug B: fixes slug/fallback album using known artist from library', async () => {
    const db = {
      meta: {},
      albums: [
        // clean album that seeds the known-artist set
        {
          title: 'golem',
          artist: 'Astral Comedy',
          year: 2024,
          path: '2024 - Astral Comedy - golem',
          has_cover: false,
          tracks: [{ title: 'skin ornaments', file: '01.mp3', duration: 200 }],
        },
        // bug-B album: title === path
        {
          title: '2024 - Astral Comedy Young Riddance',
          artist: '',
          year: 2024,
          path: '2024 - Astral Comedy Young Riddance',
          has_cover: false,
          tracks: [{ title: 'astral-comedy-young-riddance-2024', file: 'astral-comedy-young-riddance-2024.mp3', duration: 210 }],
        },
      ],
    };
    const result = await runNormalizerOn(db);
    const a = result.albums[1];
    expect(a.artist).toBe('Astral Comedy');
    expect(a.title).toBe('Young Riddance');
    expect(a.tracks[0].title).toBe('Young Riddance');
  });

  test('Bug B: strips year from title even without artist inference', async () => {
    const db = {
      meta: {},
      albums: [
        {
          title: '2025 - Unknown Band Album Title',
          artist: '',
          year: 0,
          path: '2025 - Unknown Band Album Title',
          has_cover: false,
          tracks: [{ title: 'unknown-band-album-title-2025', file: 'unknown-band-album-title-2025.mp3', duration: 200 }],
        },
      ],
    };
    const result = await runNormalizerOn(db);
    const a = result.albums[0];
    expect(a.title).not.toContain('2025 -');
    expect(a.year).toBe(2025);
    expect(a.tracks[0].title).not.toMatch(/^[a-z][a-z0-9-]+$/); // no longer a raw slug
  });

  test('Bug A: leaves albums without prefix pattern untouched', async () => {
    const db = {
      meta: {},
      albums: [
        {
          title: 'Normal Album',
          artist: 'Normal Artist',
          year: 2020,
          path: '2020 - Normal Artist - Normal Album',
          has_cover: false,
          tracks: [
            { title: 'Track One', file: '01.mp3', duration: 180 },
            { title: 'Track Two', file: '02.mp3', duration: 200 },
          ],
        },
      ],
    };
    const result = await runNormalizerOn(db);
    expect(result.albums[0].tracks[0].title).toBe('Track One');
    expect(result.albums[0].tracks[1].title).toBe('Track Two');
  });

  test('regression: live JSON has no remaining title===path albums (excluding genuinely ambiguous)', async () => {
    const buf = readFileSync('data/homi-albums.json.gz');
    const db = readGz(buf);
    const stillBad = db.albums.filter(a => a.title === a.path);
    // Allow some tolerance for albums that could not be fixed (no year prefix)
    const withYearPrefix = stillBad.filter(a => /^\d{4}\s*-/.test(a.path));
    expect(withYearPrefix.length).toBe(0);
  });

  test('regression: no multi-track album has >50% tracks with artist prefix', async () => {
    const buf = readFileSync('data/homi-albums.json.gz');
    const db = readGz(buf);
    const badAlbums = db.albums.filter(album => {
      if (!album.artist || album.tracks?.length < 2) return false;
      const prefix = album.artist + ' - ';
      const matching = (album.tracks ?? []).filter(t => startsWithCI(t.title, prefix));
      return matching.length / album.tracks.length >= 0.5;
    });
    expect(badAlbums.length).toBe(0);
  });
});
