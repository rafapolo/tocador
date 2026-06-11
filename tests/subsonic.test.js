'use strict';

const { test, describe, expect } = require('bun:test');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const TEST_PASS = 'Liga o Tocador!';
const TEST_PASS_HEX = Buffer.from(TEST_PASS).toString('hex');
const TEST_SALT = 'testsalt';
const TEST_TOKEN = createHash('md5').update(TEST_PASS + TEST_SALT).digest('hex');

const { buildIndex, createSubsonicHandler } = require('../subsonic');

// ── Fixture ───────────────────────────────────────────────────────────────────

const fixtureGz = fs.readFileSync(path.join(__dirname, 'fixtures', 'albums.json.gz'));
const fixtureDb = JSON.parse(zlib.gunzipSync(fixtureGz).toString('utf8'));

const testDb = {
  meta: { title: 'Acervo Teste', base_url: 'https://proxy.test/uqt' },
  albums: fixtureDb.albums,
};

const idx = buildIndex([{ id: 1, key: 'uqt', db: testDb }]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeHandler(serveS3) {
  return createSubsonicHandler(
    serveS3 ?? (() => new Response('', { status: 200 })),
    { sources: [{ id: 1, key: 'uqt', db: testDb }] }
  );
}

async function call(handler, urlPath) {
  const response = await handler(
    new Request('http://localhost' + urlPath),
    new URL(urlPath, 'http://localhost')
  );
  const body = await response.text();
  return { status: response.status, body };
}

const BASE = `/rest/%s.view?u=tocador&t=${TEST_TOKEN}&s=${TEST_SALT}&v=1.16.1&c=test`;
function url(method, extra = '') {
  return BASE.replace('%s', method) + extra;
}

// ── buildIndex ────────────────────────────────────────────────────────────────

describe('buildIndex', () => {
  test('creates folders, albums, songs, artists', () => {
    expect(idx.folders.length).toBe(1);
    expect(idx.folders[0].name).toBe('Acervo Teste');
    expect(idx.albumById.size).toBe(fixtureDb.albums.length);
    expect(idx.songById.size).toBeGreaterThan(0);
    expect(idx.artistById.size).toBeGreaterThan(0);
  });

  test('album has correct fields', () => {
    const al = [...idx.albumById.values()][0];
    expect(al.title).toBe('Construção');
    expect(al.artist).toBe('Chico Buarque');
    expect(al.year).toBe(1971);
    expect(al.songs.length).toBeGreaterThan(0);
  });

  test('song s3Key is constructed from s3Prefix + path + file', () => {
    const song = [...idx.songById.values()][0];
    expect(song.s3Key).toMatch(/^uqt\//);
    expect(song.s3Key).toMatch(/\.mp3$/);
  });

  test('artist albumIds reference valid albums', () => {
    for (const ar of idx.artistById.values()) {
      for (const aid of ar.albumIds) {
        expect(idx.albumById.has(aid)).toBe(true);
      }
    }
  });

  test('handles missing meta gracefully', () => {
    const idx2 = buildIndex([{ id: 9, key: 'x', db: { albums: [] } }]);
    expect(idx2.folders[0].name).toBe('x');
    expect(idx2.folders[0].s3Prefix).toBe('');
  });
});

// ── Auth ──────────────────────────────────────────────────────────────────────

describe('auth', () => {
  const handler = makeHandler();

  test('rejects wrong password (token)', async () => {
    const badToken = createHash('md5').update('wrongpassword' + TEST_SALT).digest('hex');
    const res = await call(handler, `/rest/ping.view?u=tocador&t=${badToken}&s=${TEST_SALT}&v=1.16.1&c=test`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('status="failed"');
    expect(res.body).toContain('code="40"');
  });

  test('rejects wrong enc: password', async () => {
    const wrongHex = Buffer.from('wrongpassword').toString('hex');
    const res = await call(handler, `/rest/ping.view?u=tocador&p=enc:${wrongHex}&v=1.16.1&c=test`);
    expect(res.body).toContain('status="failed"');
    expect(res.body).toContain('code="40"');
  });

  test('accepts token auth (md5)', async () => {
    const res = await call(handler, url('ping'));
    expect(res.body).toContain('status="ok"');
  });

  test('accepts enc: password', async () => {
    const res = await call(handler, `/rest/ping.view?u=qualquer&p=enc:${TEST_PASS_HEX}&v=1.16.1&c=test`);
    expect(res.body).toContain('status="ok"');
  });

  test('accepts any username with correct password', async () => {
    const salt = 'saltsalt';
    const token = createHash('md5').update(TEST_PASS + salt).digest('hex');
    const res = await call(handler, `/rest/ping.view?u=anyusername&t=${token}&s=${salt}&v=1.16.1&c=test`);
    expect(res.body).toContain('status="ok"');
  });
});

// ── ping ──────────────────────────────────────────────────────────────────────

describe('ping', () => {
  const handler = makeHandler();

  test('returns ok', async () => {
    const res = await call(handler, url('ping'));
    expect(res.status).toBe(200);
    expect(res.body).toContain('status="ok"');
    expect(res.body).toContain(`version="${API_VERSION()}"` );
  });

  test('returns json when f=json', async () => {
    const res = await call(handler, url('ping') + '&f=json');
    const data = JSON.parse(res.body);
    expect(data['subsonic-response'].status).toBe('ok');
  });

  function API_VERSION() { return '1.16.1'; }
});

// ── getMusicFolders ───────────────────────────────────────────────────────────

describe('getMusicFolders', () => {
  const handler = makeHandler();

  test('returns one folder', async () => {
    const res = await call(handler, url('getMusicFolders'));
    expect(res.body).toContain('<musicFolder');
    expect(res.body).toContain('Acervo Teste');
  });

  test('json format', async () => {
    const res = await call(handler, url('getMusicFolders') + '&f=json');
    const data = JSON.parse(res.body);
    expect(data['subsonic-response'].musicFolders.musicFolder[0].name).toBe('Acervo Teste');
  });
});

// ── getIndexes ────────────────────────────────────────────────────────────────

describe('getIndexes', () => {
  const handler = makeHandler();

  test('returns indexed artists', async () => {
    const res = await call(handler, url('getIndexes'));
    expect(res.body).toContain('<indexes');
    expect(res.body).toContain('<index');
    expect(res.body).toContain('<artist');
  });

  test('filters by musicFolderId', async () => {
    const res = await call(handler, url('getIndexes') + '&musicFolderId=99');
    expect(res.body).toContain('<indexes');
    expect(res.body).not.toContain('<artist');
  });
});

// ── getArtists ────────────────────────────────────────────────────────────────

describe('getArtists', () => {
  const handler = makeHandler();

  test('returns all artists grouped by letter', async () => {
    const res = await call(handler, url('getArtists'));
    expect(res.body).toContain('<artists');
    expect(res.body).toContain('Chico Buarque');
  });
});

// ── getArtist ─────────────────────────────────────────────────────────────────

describe('getArtist', () => {
  const handler = makeHandler();
  const ar = [...idx.artistById.values()][0];

  test('returns artist with albums', async () => {
    const res = await call(handler, url('getArtist') + `&id=${ar.id}`);
    expect(res.body).toContain(`name="${ar.name}"`);
    expect(res.body).toContain('<album');
  });

  test('returns error for unknown id', async () => {
    const res = await call(handler, url('getArtist') + '&id=unknown');
    expect(res.body).toContain('status="failed"');
    expect(res.body).toContain('code="70"');
  });
});

// ── getAlbum ──────────────────────────────────────────────────────────────────

describe('getAlbum', () => {
  const handler = makeHandler();
  const al = [...idx.albumById.values()][0];

  test('returns album with songs', async () => {
    const res = await call(handler, url('getAlbum') + `&id=${al.id}`);
    expect(res.body).toContain('Construção');
    expect(res.body).toContain('<song');
  });

  test('song has required attributes', async () => {
    const res = await call(handler, url('getAlbum') + `&id=${al.id}`);
    expect(res.body).toContain('contentType="audio/mpeg"');
    expect(res.body).toContain('suffix="mp3"');
    expect(res.body).toContain('type="music"');
  });

  test('returns error for unknown id', async () => {
    const res = await call(handler, url('getAlbum') + '&id=nope');
    expect(res.body).toContain('status="failed"');
  });
});

// ── getSong ───────────────────────────────────────────────────────────────────

describe('getSong', () => {
  const handler = makeHandler();
  const song = [...idx.songById.values()][0];

  test('returns song info', async () => {
    const res = await call(handler, url('getSong') + `&id=${song.id}`);
    expect(res.body).toContain(`title="${song.title}"`);
  });

  test('returns error for unknown id', async () => {
    const res = await call(handler, url('getSong') + '&id=nope');
    expect(res.body).toContain('status="failed"');
  });
});

// ── getAlbumList2 ─────────────────────────────────────────────────────────────

describe('getAlbumList2', () => {
  const handler = makeHandler();

  test('returns up to size albums', async () => {
    const res = await call(handler, url('getAlbumList2') + '&type=alphabeticalByName&size=3');
    const matches = res.body.match(/<album /g) || [];
    expect(matches.length).toBe(3);
  });

  test('offset paginates correctly', async () => {
    const r1 = await call(handler, url('getAlbumList2') + '&type=alphabeticalByName&size=2&offset=0');
    const r2 = await call(handler, url('getAlbumList2') + '&type=alphabeticalByName&size=2&offset=2');
    expect(r1.body).not.toBe(r2.body);
  });

  test('byYear filters and sorts', async () => {
    const res = await call(handler, url('getAlbumList2') + '&type=byYear&fromYear=1970&toYear=1975&size=20');
    expect(res.body).toContain('<albumList2');
  });
});

// ── search3 ───────────────────────────────────────────────────────────────────

describe('search3', () => {
  const handler = makeHandler();

  test('finds albums and artists by query', async () => {
    const res = await call(handler, url('search3') + '&query=Chico');
    expect(res.body).toContain('<searchResult3');
    expect(res.body).toContain('Chico Buarque');
  });

  test('returns empty results for no match', async () => {
    const res = await call(handler, url('search3') + '&query=XYZNOTFOUND999');
    expect(res.body).toContain('<searchResult3');
    expect(res.body).not.toContain('<album ');
    expect(res.body).not.toContain('<artist ');
  });

  test('json format', async () => {
    const res = await call(handler, url('search3') + '&query=Chico&f=json');
    const data = JSON.parse(res.body);
    expect(data['subsonic-response'].searchResult3).toBeTruthy();
  });
});

// ── getMusicDirectory ─────────────────────────────────────────────────────────

describe('getMusicDirectory', () => {
  const handler = makeHandler();
  const folder = idx.folders[0];
  const ar = [...idx.artistById.values()][0];
  const al = [...idx.albumById.values()][0];

  test('folder id → lists artists', async () => {
    const res = await call(handler, url('getMusicDirectory') + `&id=${folder.numId}`);
    expect(res.body).toContain('<directory');
    expect(res.body).toContain('isDir="true"');
  });

  test('artist id → lists albums', async () => {
    const res = await call(handler, url('getMusicDirectory') + `&id=${ar.id}`);
    expect(res.body).toContain('<directory');
    expect(res.body).toContain('isDir="true"');
  });

  test('album id → lists songs', async () => {
    const res = await call(handler, url('getMusicDirectory') + `&id=${al.id}`);
    expect(res.body).toContain('<directory');
    expect(res.body).toContain('isDir="false"');
  });

  test('unknown id → error 70', async () => {
    const res = await call(handler, url('getMusicDirectory') + '&id=nope');
    expect(res.body).toContain('code="70"');
  });
});

// ── stream ────────────────────────────────────────────────────────────────────

describe('stream', () => {
  test('calls serveS3 with correct s3Key', async () => {
    const song = [...idx.songById.values()][0];
    let calledKey = null;
    const mockServeS3 = async (_req, key) => { calledKey = key; return new Response(''); };
    const handler = makeHandler(mockServeS3);

    await call(handler, url('stream') + `&id=${song.id}`);

    expect(calledKey).toBe(song.s3Key);
    expect(calledKey).toMatch(/^uqt\//);
    expect(calledKey).toMatch(/\.mp3$/);
  });

  test('returns 404 for unknown song id', async () => {
    const handler = makeHandler();
    const res = await call(handler, url('stream') + '&id=unknown');
    expect(res.status).toBe(404);
  });
});

// ── getCoverArt ───────────────────────────────────────────────────────────────

describe('getCoverArt', () => {
  test('calls serveS3 with capa-min.jpg key for album with cover', async () => {
    const al = [...idx.albumById.values()].find(a => a.hasCover);
    let calledKey = null;
    const handler = makeHandler(async (_req, key) => { calledKey = key; return new Response(''); });

    await call(handler, url('getCoverArt') + `&id=${al.id}`);
    expect(calledKey).toMatch(/capa-min\.jpg$/);
  });

  test('returns 404 for album without cover', async () => {
    const noCoverDb = {
      meta: { title: 'NC', base_url: 'https://proxy.test/nc' },
      albums: [{ title: 'X', artist: 'Y', year: 2000, path: 'X', has_cover: false, tracks: [] }],
    };
    const h = createSubsonicHandler(() => new Response(''), { sources: [{ id: 9, key: 'nc', db: noCoverDb }] });
    const noCoverIdx = buildIndex([{ id: 9, key: 'nc', db: noCoverDb }]);
    const al = [...noCoverIdx.albumById.values()][0];

    const res = await call(h, url('getCoverArt') + `&id=${al.id}`);
    expect(res.status).toBe(404);
  });
});

// ── stubs ─────────────────────────────────────────────────────────────────────

describe('stub endpoints', () => {
  const handler = makeHandler();

  test('getPlaylists returns empty list', async () => {
    const res = await call(handler, url('getPlaylists'));
    expect(res.body).toContain('status="ok"');
    expect(res.body).toContain('<playlists');
  });

  test('getStarred2 returns empty', async () => {
    const res = await call(handler, url('getStarred2'));
    expect(res.body).toContain('status="ok"');
  });

  test('getScanStatus returns scanning=false', async () => {
    const res = await call(handler, url('getScanStatus'));
    expect(res.body).toContain('scanning="false"');
  });

  test('getLicense returns valid=true', async () => {
    const res = await call(handler, url('getLicense'));
    expect(res.body).toContain('valid="true"');
  });

  test('unknown method returns error 30', async () => {
    const res = await call(handler, url('nonExistentMethod'));
    expect(res.body).toContain('code="30"');
  });
});

// ── OpenSubsonic ──────────────────────────────────────────────────────────────

describe('openSubsonic', () => {
  const handler = makeHandler();

  test('ping XML declares openSubsonic="true"', async () => {
    const res = await call(handler, url('ping'));
    expect(res.body).toContain('openSubsonic="true"');
  });

  test('ping XML declares type="tocador"', async () => {
    const res = await call(handler, url('ping'));
    expect(res.body).toContain('type="tocador"');
  });

  test('ping XML declares serverVersion', async () => {
    const res = await call(handler, url('ping'));
    expect(res.body).toContain('serverVersion=');
  });

  test('ping XML includes openSubsonicExtensions element', async () => {
    const res = await call(handler, url('ping'));
    expect(res.body).toContain('<openSubsonicExtensions');
  });

  test('ping JSON has openSubsonic=true', async () => {
    const res = await call(handler, url('ping') + '&f=json');
    expect(JSON.parse(res.body)['subsonic-response'].openSubsonic).toBe(true);
  });

  test('ping JSON has type="tocador"', async () => {
    const res = await call(handler, url('ping') + '&f=json');
    expect(JSON.parse(res.body)['subsonic-response'].type).toBe('tocador');
  });

  test('ping JSON has serverVersion', async () => {
    const res = await call(handler, url('ping') + '&f=json');
    expect(JSON.parse(res.body)['subsonic-response'].serverVersion).toBeTruthy();
  });

  test('ping JSON has empty openSubsonicExtensions array', async () => {
    const res = await call(handler, url('ping') + '&f=json');
    expect(JSON.parse(res.body)['subsonic-response'].openSubsonicExtensions).toEqual([]);
  });

  test('error responses also declare openSubsonic="true"', async () => {
    const badToken = createHash('md5').update('wrong' + TEST_SALT).digest('hex');
    const res = await call(handler, `/rest/ping.view?u=x&t=${badToken}&s=${TEST_SALT}&v=1.16.1&c=test`);
    expect(res.body).toContain('openSubsonic="true"');
  });

  test('non-ping endpoints also carry openSubsonic="true"', async () => {
    const res = await call(handler, url('getMusicFolders'));
    expect(res.body).toContain('openSubsonic="true"');
  });
});
