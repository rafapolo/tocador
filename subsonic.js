// Subsonic REST API handler — maps acervo .json.gz data to the Subsonic protocol.
// Spec: https://www.subsonic.org/pages/api.jsp (v1.16.1)
'use strict';

const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');

const API_VERSION = '1.16.1';
const RELOAD_MS = 3_600_000; // refresh index every hour

// Mirrors KNOWN_ACERVOS in ui.js
const DEFAULT_SOURCES = [
  {
    id: 1,
    key: 'uqt',
    url: 'https://raw.githubusercontent.com/rafapolo/uqt/refs/heads/master/js/uqt-albums.json.gz',
  },
  {
    id: 2,
    key: 'homi',
    url: 'https://raw.githubusercontent.com/rafapolo/hominiscanidae/refs/heads/main/js/homi-albums.json.gz',
  },
];

// ── Auth ──────────────────────────────────────────────────────────────────────

function checkAuth(params) {
  const user = process.env.SUBSONIC_USER || 'admin';
  const pass = process.env.SUBSONIC_PASS || 'admin';
  if (params.get('u') !== user) return false;

  const t = params.get('t');
  const s = params.get('s');
  if (t && s) {
    return crypto.createHash('md5').update(pass + s).digest('hex') === t;
  }

  const p = params.get('p') || '';
  const raw = p.startsWith('enc:') ? Buffer.from(p.slice(4), 'hex').toString('utf8') : p;
  return raw === pass;
}

// ── Data loading ──────────────────────────────────────────────────────────────

function fetchGz(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        zlib.gunzip(Buffer.concat(chunks), (err, buf) => {
          if (err) reject(err); else resolve(JSON.parse(buf.toString('utf8')));
        });
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Load remote sources. Each source may supply a pre-loaded `db` to skip fetching.
async function loadSources(sources) {
  const out = [];
  for (const src of sources) {
    if (src.db) { out.push(src); continue; }
    try {
      const db = await fetchGz(src.url);
      out.push({ ...src, db });
    } catch (err) {
      console.error(`[subsonic] load ${src.key}: ${err.message}`);
    }
  }
  return out;
}

// ── Index builder ─────────────────────────────────────────────────────────────

// Builds flat lookup maps from loaded acervo data.
// sources: [{id, key, db}]
function buildIndex(sources) {
  const folders = [];
  const albumById = new Map();
  const songById = new Map();
  const artistById = new Map();

  for (const src of sources) {
    const db = src.db || {};
    const baseUrl = db.meta?.base_url || '';
    let s3Prefix = '';
    try { s3Prefix = new URL(baseUrl).pathname.replace(/^\/+|\/+$/g, ''); } catch {}

    const folder = {
      id: `f${src.id}`,
      numId: src.id,
      name: db.meta?.title || src.key,
      baseUrl,
      s3Prefix,
    };
    folders.push(folder);

    // First pass: collect unique artists for this folder
    const artistsByName = new Map();
    for (const album of (db.albums || [])) {
      const name = album.artist || 'Unknown Artist';
      if (!artistsByName.has(name)) {
        const ar = { id: `ar${src.id}_${artistsByName.size + 1}`, name, folderId: folder.id, albumIds: [] };
        artistsByName.set(name, ar);
        artistById.set(ar.id, ar);
      }
    }

    // Second pass: build albums + songs
    const albumList = db.albums || [];
    for (let ai = 0; ai < albumList.length; ai++) {
      const album = albumList[ai];
      const artistName = album.artist || 'Unknown Artist';
      const artist = artistsByName.get(artistName);
      const albumId = `al${src.id}_${ai}`;

      const songs = [];
      let albumDuration = 0;

      const trackList = album.tracks || [];
      for (let ti = 0; ti < trackList.length; ti++) {
        const track = trackList[ti];
        const songId = `so${src.id}_${ai}_${ti}`;
        const song = {
          id: songId,
          title: track.title || 'Unknown',
          artist: track.artists || artistName,
          albumArtist: artistName,
          album: album.title,
          albumId,
          artistId: artist.id,
          track: track.num || ti + 1,
          year: album.year || 0,
          duration: track.duration || 0,
          file: track.file || '',
          s3Key: `${s3Prefix}/${album.path}/${track.file}`,
          hasCover: album.has_cover || false,
          coverArt: albumId,
          folderId: folder.id,
          contentType: 'audio/mpeg',
          suffix: 'mp3',
          type: 'music',
          path: `${album.path}/${track.file}`,
        };
        albumDuration += track.duration || 0;
        songs.push(song);
        songById.set(songId, song);
      }

      const albumRecord = {
        id: albumId,
        title: album.title || 'Unknown Album',
        artist: artistName,
        artistId: artist.id,
        year: album.year || 0,
        hasCover: album.has_cover || false,
        coverArt: albumId,
        folderId: folder.id,
        s3Prefix,
        path: album.path || '',
        duration: albumDuration,
        songCount: songs.length,
        songs,
      };

      artist.albumIds.push(albumId);
      albumById.set(albumId, albumRecord);
    }
  }

  return { folders, albumById, songById, artistById };
}

// ── XML / response helpers ────────────────────────────────────────────────────

function xe(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function attrsStr(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v != null && v !== '' && v !== undefined)
    .map(([k, v]) => `${k}="${xe(v)}"`)
    .join(' ');
}

const CORS = { 'Access-Control-Allow-Origin': '*' };

function okXml(res, inner) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<subsonic-response xmlns="http://subsonic.org/restapi" status="ok" version="${API_VERSION}">\n${inner}\n</subsonic-response>\n`;
  res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8', ...CORS });
  res.end(xml);
}

function errXml(res, code, message) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<subsonic-response xmlns="http://subsonic.org/restapi" status="failed" version="${API_VERSION}">\n<error code="${code}" message="${xe(message)}"/>\n</subsonic-response>\n`;
  res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8', ...CORS });
  res.end(xml);
}

function okJson(res, data) {
  const body = JSON.stringify({ 'subsonic-response': { xmlns: 'http://subsonic.org/restapi', status: 'ok', version: API_VERSION, ...data } });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
  res.end(body);
}

function errJson(res, code, message) {
  const body = JSON.stringify({ 'subsonic-response': { xmlns: 'http://subsonic.org/restapi', status: 'failed', version: API_VERSION, error: { code, message } } });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
  res.end(body);
}

function ok(res, fmt, xml, jsonData) {
  fmt === 'json' ? okJson(res, jsonData) : okXml(res, xml);
}

function err(res, fmt, code, message) {
  fmt === 'json' ? errJson(res, code, message) : errXml(res, code, message);
}

// ── Serialization helpers ─────────────────────────────────────────────────────

function songAttrs(s) {
  return attrsStr({
    id: s.id, parent: s.albumId, isDir: 'false', title: s.title,
    album: s.album, artist: s.artist, albumArtist: s.albumArtist,
    track: s.track || undefined, year: s.year || undefined,
    coverArt: s.hasCover ? s.coverArt : undefined,
    duration: s.duration || undefined,
    contentType: s.contentType, suffix: s.suffix, type: s.type,
    albumId: s.albumId, artistId: s.artistId, path: s.path,
  });
}

function albumAttrs(al) {
  return attrsStr({
    id: al.id, name: al.title, title: al.title, artist: al.artist, artistId: al.artistId,
    coverArt: al.hasCover ? al.coverArt : undefined,
    songCount: al.songCount, duration: al.duration,
    year: al.year || undefined,
  });
}

function songJson(s) {
  return {
    id: s.id, parent: s.albumId, isDir: false, title: s.title,
    album: s.album, artist: s.artist, albumArtist: s.albumArtist,
    ...(s.track ? { track: s.track } : {}),
    ...(s.year ? { year: s.year } : {}),
    ...(s.hasCover ? { coverArt: s.coverArt } : {}),
    ...(s.duration ? { duration: s.duration } : {}),
    contentType: s.contentType, suffix: s.suffix, type: s.type,
    albumId: s.albumId, artistId: s.artistId, path: s.path,
  };
}

function albumJson(al) {
  return {
    id: al.id, name: al.title, artist: al.artist, artistId: al.artistId,
    ...(al.hasCover ? { coverArt: al.coverArt } : {}),
    songCount: al.songCount, duration: al.duration,
    ...(al.year ? { year: al.year } : {}),
  };
}

// ── Artists grouping ──────────────────────────────────────────────────────────

function groupByLetter(artists) {
  const byLetter = new Map();
  for (const ar of artists) {
    const ch = ar.name[0]?.toUpperCase() || '#';
    const letter = /[A-Z]/.test(ch) ? ch : '#';
    if (!byLetter.has(letter)) byLetter.set(letter, []);
    byLetter.get(letter).push(ar);
  }
  return [...byLetter.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

// ── Method handlers ───────────────────────────────────────────────────────────

function handlePing(res, fmt) {
  ok(res, fmt, '', {});
}

function handleGetLicense(res, fmt) {
  ok(res, fmt,
    `<license valid="true" email="admin@tocador" licenseExpires="2099-12-31T00:00:00"/>`,
    { license: { valid: true, email: 'admin@tocador' } });
}

function handleGetMusicFolders(res, fmt, idx) {
  const xml = `<musicFolders>\n${idx.folders.map(f => `  <musicFolder id="${f.numId}" name="${xe(f.name)}"/>`).join('\n')}\n</musicFolders>`;
  ok(res, fmt, xml, { musicFolders: { musicFolder: idx.folders.map(f => ({ id: f.numId, name: f.name })) } });
}

function scopedArtists(idx, musicFolderId) {
  if (!musicFolderId) return [...idx.artistById.values()];
  const folder = idx.folders.find(f => String(f.numId) === musicFolderId);
  if (!folder) return [];
  return [...idx.artistById.values()].filter(a => a.folderId === folder.id);
}

function handleGetIndexes(res, fmt, params, idx) {
  const artists = scopedArtists(idx, params.get('musicFolderId'));
  const groups = groupByLetter(artists);

  const xml = `<indexes lastModified="${Date.now()}" ignoredArticles="The An A Die Das Ein Os As">\n` +
    groups.map(([letter, ars]) =>
      `  <index name="${xe(letter)}">\n` +
      ars.map(a => `    <artist id="${xe(a.id)}" name="${xe(a.name)}" albumCount="${a.albumIds.length}"/>`).join('\n') +
      `\n  </index>`
    ).join('\n') +
    `\n</indexes>`;

  ok(res, fmt, xml, {
    indexes: {
      lastModified: Date.now(), ignoredArticles: 'The An A Die Das Ein Os As',
      index: groups.map(([letter, ars]) => ({
        name: letter,
        artist: ars.map(a => ({ id: a.id, name: a.name, albumCount: a.albumIds.length })),
      })),
    },
  });
}

function handleGetArtists(res, fmt, params, idx) {
  const artists = scopedArtists(idx, params.get('musicFolderId'));
  const groups = groupByLetter(artists);

  const xml = `<artists ignoredArticles="The An A Die Das Ein Os As" lastModified="${Date.now()}">\n` +
    groups.map(([letter, ars]) =>
      `  <index name="${xe(letter)}">\n` +
      ars.map(a => `    <artist id="${xe(a.id)}" name="${xe(a.name)}" albumCount="${a.albumIds.length}"/>`).join('\n') +
      `\n  </index>`
    ).join('\n') +
    `\n</artists>`;

  ok(res, fmt, xml, {
    artists: {
      ignoredArticles: 'The An A Die Das Ein Os As',
      index: groups.map(([l, ars]) => ({ name: l, artist: ars.map(a => ({ id: a.id, name: a.name, albumCount: a.albumIds.length })) })),
    },
  });
}

function handleGetArtist(res, fmt, params, idx) {
  const ar = idx.artistById.get(params.get('id'));
  if (!ar) { err(res, fmt, 70, 'Artist not found'); return; }

  const albums = ar.albumIds.map(id => idx.albumById.get(id)).filter(Boolean);
  const xml = `<artist id="${xe(ar.id)}" name="${xe(ar.name)}" albumCount="${albums.length}">\n` +
    albums.map(al => `  <album ${albumAttrs(al)}/>`).join('\n') +
    `\n</artist>`;

  ok(res, fmt, xml, { artist: { id: ar.id, name: ar.name, albumCount: albums.length, album: albums.map(albumJson) } });
}

function handleGetAlbum(res, fmt, params, idx) {
  const al = idx.albumById.get(params.get('id'));
  if (!al) { err(res, fmt, 70, 'Album not found'); return; }

  const xml = `<album ${albumAttrs(al)}>\n` +
    al.songs.map(s => `  <song ${songAttrs(s)}/>`).join('\n') +
    `\n</album>`;

  ok(res, fmt, xml, { album: { ...albumJson(al), song: al.songs.map(songJson) } });
}

function handleGetSong(res, fmt, params, idx) {
  const s = idx.songById.get(params.get('id'));
  if (!s) { err(res, fmt, 70, 'Song not found'); return; }
  ok(res, fmt, `<song ${songAttrs(s)}/>`, { song: songJson(s) });
}

function handleGetAlbumList2(res, fmt, params, idx) {
  const type = params.get('type') || 'alphabeticalByName';
  const size = Math.min(parseInt(params.get('size') || '20', 10), 500);
  const offset = parseInt(params.get('offset') || '0', 10);

  let albums = [...idx.albumById.values()];

  const musicFolderId = params.get('musicFolderId');
  if (musicFolderId) {
    const folder = idx.folders.find(f => String(f.numId) === musicFolderId);
    if (folder) albums = albums.filter(a => a.folderId === folder.id);
  }

  switch (type) {
    case 'alphabeticalByName':
      albums.sort((a, b) => a.title.localeCompare(b.title)); break;
    case 'alphabeticalByArtist':
      albums.sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title)); break;
    case 'newest':
    case 'recent':
      albums.sort((a, b) => (b.year || 0) - (a.year || 0)); break;
    case 'byYear': {
      const fromYear = parseInt(params.get('fromYear') || '0', 10);
      const toYear = parseInt(params.get('toYear') || '9999', 10);
      albums = albums.filter(a => a.year >= fromYear && a.year <= toYear);
      albums.sort((a, b) => (a.year || 0) - (b.year || 0)); break;
    }
    default:
      albums.sort((a, b) => a.title.localeCompare(b.title));
  }

  const page = albums.slice(offset, offset + size);
  const xml = `<albumList2>\n${page.map(al => `  <album ${albumAttrs(al)}/>`).join('\n')}\n</albumList2>`;
  ok(res, fmt, xml, { albumList2: { album: page.map(albumJson) } });
}

// getAlbumList (non-ID3 folder-browse mode) — returns same as getAlbumList2
// with a child-style wrapper so legacy clients work too.
function handleGetAlbumList(res, fmt, params, idx) {
  // reuse same sort/page logic, just wrap in <albumList>
  const type = params.get('type') || 'alphabeticalByName';
  const size = Math.min(parseInt(params.get('size') || '20', 10), 500);
  const offset = parseInt(params.get('offset') || '0', 10);

  let albums = [...idx.albumById.values()];
  switch (type) {
    case 'alphabeticalByName': albums.sort((a, b) => a.title.localeCompare(b.title)); break;
    case 'alphabeticalByArtist': albums.sort((a, b) => a.artist.localeCompare(b.artist)); break;
    case 'newest': case 'recent': albums.sort((a, b) => (b.year || 0) - (a.year || 0)); break;
    default: albums.sort((a, b) => a.title.localeCompare(b.title));
  }

  const page = albums.slice(offset, offset + size);
  const xml = `<albumList>\n${page.map(al =>
    `  <album id="${xe(al.id)}" parent="${xe(al.artistId)}" isDir="true" title="${xe(al.title)}" artist="${xe(al.artist)}" year="${al.year || ''}" coverArt="${al.hasCover ? xe(al.coverArt) : ''}"/>`
  ).join('\n')}\n</albumList>`;
  ok(res, fmt, xml, { albumList: { album: page.map(al => ({ id: al.id, parent: al.artistId, isDir: true, title: al.title, artist: al.artist })) } });
}

function handleSearch3(res, fmt, params, idx) {
  const query = (params.get('query') || '').toLowerCase().trim();
  const artistCount = Math.min(parseInt(params.get('artistCount') || '20', 10), 500);
  const albumCount = Math.min(parseInt(params.get('albumCount') || '20', 10), 500);
  const songCount = Math.min(parseInt(params.get('songCount') || '20', 10), 500);
  const artistOffset = parseInt(params.get('artistOffset') || '0', 10);
  const albumOffset = parseInt(params.get('albumOffset') || '0', 10);
  const songOffset = parseInt(params.get('songOffset') || '0', 10);

  const match = (s) => !query || s.toLowerCase().includes(query);

  const artists = [...idx.artistById.values()].filter(a => match(a.name)).slice(artistOffset, artistOffset + artistCount);
  const albums = [...idx.albumById.values()].filter(a => match(a.title) || match(a.artist)).slice(albumOffset, albumOffset + albumCount);
  const songs = [...idx.songById.values()].filter(s => match(s.title) || match(s.artist)).slice(songOffset, songOffset + songCount);

  const xml = `<searchResult3>\n` +
    artists.map(a => `  <artist id="${xe(a.id)}" name="${xe(a.name)}" albumCount="${a.albumIds.length}"/>`).join('\n') +
    (artists.length ? '\n' : '') +
    albums.map(al => `  <album ${albumAttrs(al)}/>`).join('\n') +
    (albums.length ? '\n' : '') +
    songs.map(s => `  <song ${songAttrs(s)}/>`).join('\n') +
    `\n</searchResult3>`;

  ok(res, fmt, xml, {
    searchResult3: {
      artist: artists.map(a => ({ id: a.id, name: a.name, albumCount: a.albumIds.length })),
      album: albums.map(albumJson),
      song: songs.map(songJson),
    },
  });
}

function handleSearch2(res, fmt, params, idx) {
  // search2 returns same shape but wrapped in <searchResult2> with child-style nodes
  const query = (params.get('query') || '').toLowerCase().trim();
  const artistCount = Math.min(parseInt(params.get('artistCount') || '20', 10), 500);
  const albumCount = Math.min(parseInt(params.get('albumCount') || '20', 10), 500);
  const songCount = Math.min(parseInt(params.get('songCount') || '20', 10), 500);

  const match = (s) => !query || s.toLowerCase().includes(query);
  const artists = [...idx.artistById.values()].filter(a => match(a.name)).slice(0, artistCount);
  const albums = [...idx.albumById.values()].filter(a => match(a.title) || match(a.artist)).slice(0, albumCount);
  const songs = [...idx.songById.values()].filter(s => match(s.title)).slice(0, songCount);

  const xml = `<searchResult2>\n` +
    artists.map(a => `  <artist id="${xe(a.id)}" name="${xe(a.name)}"/>`).join('\n') +
    (artists.length ? '\n' : '') +
    albums.map(al => `  <album id="${xe(al.id)}" parent="${xe(al.artistId)}" isDir="true" title="${xe(al.title)}" artist="${xe(al.artist)}"/>`).join('\n') +
    (albums.length ? '\n' : '') +
    songs.map(s => `  <song ${songAttrs(s)}/>`).join('\n') +
    `\n</searchResult2>`;

  ok(res, fmt, xml, {
    searchResult2: {
      artist: artists.map(a => ({ id: a.id, name: a.name })),
      album: albums.map(al => ({ id: al.id, parent: al.artistId, isDir: true, title: al.title, artist: al.artist })),
      song: songs.map(songJson),
    },
  });
}

function handleGetMusicDirectory(res, fmt, params, idx) {
  const id = params.get('id');

  // Folder level → list artists
  const folder = idx.folders.find(f => String(f.numId) === id || f.id === id);
  if (folder) {
    const artists = [...idx.artistById.values()].filter(a => a.folderId === folder.id);
    const xml = `<directory id="${xe(folder.id)}" name="${xe(folder.name)}">\n` +
      artists.map(a => `  <child id="${xe(a.id)}" parent="${xe(folder.id)}" isDir="true" title="${xe(a.name)}" artist="${xe(a.name)}"/>`).join('\n') +
      `\n</directory>`;
    ok(res, fmt, xml, {
      directory: {
        id: folder.id, name: folder.name,
        child: artists.map(a => ({ id: a.id, parent: folder.id, isDir: true, title: a.name })),
      },
    });
    return;
  }

  // Artist level → list albums
  const ar = idx.artistById.get(id);
  if (ar) {
    const albums = ar.albumIds.map(aid => idx.albumById.get(aid)).filter(Boolean);
    const xml = `<directory id="${xe(ar.id)}" name="${xe(ar.name)}">\n` +
      albums.map(al =>
        `  <child id="${xe(al.id)}" parent="${xe(ar.id)}" isDir="true" title="${xe(al.title)}" artist="${xe(al.artist)}"${al.year ? ` year="${al.year}"` : ''}${al.hasCover ? ` coverArt="${xe(al.coverArt)}"` : ''}/>`
      ).join('\n') +
      `\n</directory>`;
    ok(res, fmt, xml, {
      directory: {
        id: ar.id, name: ar.name,
        child: albums.map(al => ({ id: al.id, parent: ar.id, isDir: true, title: al.title, artist: al.artist })),
      },
    });
    return;
  }

  // Album level → list songs
  const al = idx.albumById.get(id);
  if (al) {
    const xml = `<directory id="${xe(al.id)}" name="${xe(al.title)}">\n` +
      al.songs.map(s => `  <child ${songAttrs(s)}/>`).join('\n') +
      `\n</directory>`;
    ok(res, fmt, xml, {
      directory: {
        id: al.id, name: al.title,
        child: al.songs.map(songJson),
      },
    });
    return;
  }

  err(res, fmt, 70, 'Directory not found');
}

async function handleGetCoverArt(req, res, params, idx, handleObject) {
  const id = params.get('id');
  const al = idx.albumById.get(id) ?? idx.albumById.get(idx.songById.get(id)?.albumId);
  if (!al || !al.hasCover) {
    res.writeHead(404, { 'Content-Type': 'text/plain', ...CORS });
    res.end('Not found');
    return;
  }
  await handleObject(req, res, `${al.s3Prefix}/${al.path}/capa-min.jpg`, null);
}

async function handleStream(req, res, params, idx, handleObject) {
  const s = idx.songById.get(params.get('id'));
  if (!s) { res.writeHead(404, { 'Content-Type': 'text/plain', ...CORS }); res.end('Not found'); return; }
  await handleObject(req, res, s.s3Key, null);
}

function handleGetPlaylists(res, fmt) {
  ok(res, fmt, '<playlists/>', { playlists: {} });
}

function handleGetStarred2(res, fmt) {
  ok(res, fmt, '<starred2/>', { starred2: {} });
}

function handleGetScanStatus(res, fmt) {
  ok(res, fmt, '<scanStatus scanning="false"/>', { scanStatus: { scanning: false } });
}

function handleGetArtistInfo2(res, fmt) {
  ok(res, fmt, '<artistInfo2/>', { artistInfo2: {} });
}

function handleGetAlbumInfo2(res, fmt) {
  ok(res, fmt, '<albumInfo/>', { albumInfo: {} });
}

// ── Module export ─────────────────────────────────────────────────────────────

// Exported for testing — build an index directly from pre-loaded data.
module.exports.buildIndex = buildIndex;

// Main factory. handleObject(req, res, s3Key, ip) is the proxy's S3 streamer.
// opts.sources can override DEFAULT_SOURCES for testing.
module.exports.createSubsonicHandler = function createSubsonicHandler(handleObject, opts = {}) {
  const sources = opts.sources || DEFAULT_SOURCES;
  let _index = null;
  let _loadedAt = 0;

  async function getIndex() {
    if (!_index || Date.now() - _loadedAt > RELOAD_MS) {
      console.log('[subsonic] refreshing index...');
      const loaded = await loadSources(sources);
      _index = buildIndex(loaded);
      _loadedAt = Date.now();
      console.log(`[subsonic] ${_index.albumById.size} albums, ${_index.songById.size} songs, ${_index.artistById.size} artists`);
    }
    return _index;
  }

  // Kick off initial load without blocking startup
  getIndex().catch(e => console.error('[subsonic] initial load failed:', e.message));

  return async function handleSubsonic(req, res, urlObj) {
    const method = urlObj.pathname.replace(/.*\/rest\//, '').replace(/\.view$/, '');
    const params = urlObj.searchParams;
    const fmt = params.get('f') === 'json' ? 'json' : 'xml';

    if (!checkAuth(params)) { err(res, fmt, 40, 'Wrong username or password'); return; }

    let idx;
    try { idx = await getIndex(); } catch (e) { err(res, fmt, 0, `Server error: ${e.message}`); return; }

    switch (method) {
      case 'ping':             return handlePing(res, fmt);
      case 'getLicense':       return handleGetLicense(res, fmt);
      case 'getMusicFolders':  return handleGetMusicFolders(res, fmt, idx);
      case 'getIndexes':       return handleGetIndexes(res, fmt, params, idx);
      case 'getArtists':       return handleGetArtists(res, fmt, params, idx);
      case 'getArtist':        return handleGetArtist(res, fmt, params, idx);
      case 'getAlbum':         return handleGetAlbum(res, fmt, params, idx);
      case 'getSong':          return handleGetSong(res, fmt, params, idx);
      case 'getAlbumList2':    return handleGetAlbumList2(res, fmt, params, idx);
      case 'getAlbumList':     return handleGetAlbumList(res, fmt, params, idx);
      case 'search3':          return handleSearch3(res, fmt, params, idx);
      case 'search2':          return handleSearch2(res, fmt, params, idx);
      case 'getMusicDirectory':return handleGetMusicDirectory(res, fmt, params, idx);
      case 'getCoverArt':      return handleGetCoverArt(req, res, params, idx, handleObject);
      case 'stream':
      case 'download':         return handleStream(req, res, params, idx, handleObject);
      case 'getPlaylists':     return handleGetPlaylists(res, fmt);
      case 'getStarred':
      case 'getStarred2':      return handleGetStarred2(res, fmt);
      case 'getScanStatus':    return handleGetScanStatus(res, fmt);
      case 'getArtistInfo':
      case 'getArtistInfo2':   return handleGetArtistInfo2(res, fmt);
      case 'getAlbumInfo':
      case 'getAlbumInfo2':    return handleGetAlbumInfo2(res, fmt);
      default:
        err(res, fmt, 30, `Method not supported: ${method}`);
    }
  };
};
