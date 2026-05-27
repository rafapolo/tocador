'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TEST_PASS = 'Liga o Tocador!';
const TEST_PASS_HEX = Buffer.from(TEST_PASS).toString('hex');
const TEST_SALT = 'testsalt';
const TEST_TOKEN = crypto.createHash('md5').update(TEST_PASS + TEST_SALT).digest('hex');

const { buildIndex, createSubsonicHandler } = require('../subsonic');

// ── Fixture ───────────────────────────────────────────────────────────────────

const fixtureGz = fs.readFileSync(path.join(__dirname, 'fixtures', 'albums.json.gz'));
const fixtureDb = JSON.parse(zlib.gunzipSync(fixtureGz).toString('utf8'));

// Inject a base_url so s3Key logic is exercised
const testDb = {
  meta: { title: 'Acervo Teste', base_url: 'https://proxy.test/uqt' },
  albums: fixtureDb.albums,
};

const idx = buildIndex([{ id: 1, key: 'uqt', db: testDb }]);

// ── Mock req/res ──────────────────────────────────────────────────────────────

function mockReq(url, method = 'GET') {
  return { url, method, headers: {} };
}

function mockRes() {
  const res = { status: null, headers: {}, body: null };
  res.writeHead = (status, headers) => { res.status = status; res.headers = { ...res.headers, ...headers }; };
  res.end = (body) => { res.body = body ?? ''; };
  res.destroy = () => {};
  return res;
}

function makeHandler(handleObject) {
  return createSubsonicHandler(handleObject || (() => {}), {
    sources: [{ id: 1, key: 'uqt', db: testDb }],
  });
}

async function call(handler, path) {
  const req = mockReq(path);
  const res = mockRes();
  await handler(req, res, new URL(path, 'http://localhost'));
  return res;
}

const BASE = `/rest/%s.view?u=tocador&t=${TEST_TOKEN}&s=${TEST_SALT}&v=1.16.1&c=test`;
function url(method, extra = '') {
  return BASE.replace('%s', method) + extra;
}

// ── buildIndex ────────────────────────────────────────────────────────────────

describe('buildIndex', () => {
  test('creates folders, albums, songs, artists', () => {
    assert.equal(idx.folders.length, 1);
    assert.equal(idx.folders[0].name, 'Acervo Teste');
    assert.equal(idx.albumById.size, 10);
    assert.ok(idx.songById.size > 0);
    assert.ok(idx.artistById.size > 0);
  });

  test('album has correct fields', () => {
    const al = [...idx.albumById.values()][0];
    assert.equal(al.title, 'Construção');
    assert.equal(al.artist, 'Chico Buarque');
    assert.equal(al.year, 1971);
    assert.ok(al.songs.length > 0);
  });

  test('song s3Key is constructed from s3Prefix + path + file', () => {
    const song = [...idx.songById.values()][0];
    assert.ok(song.s3Key.startsWith('uqt/'), `s3Key should start with "uqt/": ${song.s3Key}`);
    assert.ok(song.s3Key.endsWith('.mp3'), `s3Key should end with .mp3: ${song.s3Key}`);
  });

  test('artist albumIds reference valid albums', () => {
    for (const ar of idx.artistById.values()) {
      for (const aid of ar.albumIds) {
        assert.ok(idx.albumById.has(aid), `Missing album ${aid} for artist ${ar.name}`);
      }
    }
  });

  test('handles missing meta gracefully', () => {
    const idx2 = buildIndex([{ id: 9, key: 'x', db: { albums: [] } }]);
    assert.equal(idx2.folders[0].name, 'x');
    assert.equal(idx2.folders[0].s3Prefix, '');
  });
});

// ── Auth ──────────────────────────────────────────────────────────────────────

describe('auth', () => {
  const handler = makeHandler();

  test('rejects wrong password (token)', async () => {
    const badToken = crypto.createHash('md5').update('wrongpassword' + TEST_SALT).digest('hex');
    const res = await call(handler, `/rest/ping.view?u=tocador&t=${badToken}&s=${TEST_SALT}&v=1.16.1&c=test`);
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('status="failed"'));
    assert.ok(res.body.includes('code="40"'));
  });

  test('rejects wrong enc: password', async () => {
    const wrongHex = Buffer.from('wrongpassword').toString('hex');
    const res = await call(handler, `/rest/ping.view?u=tocador&p=enc:${wrongHex}&v=1.16.1&c=test`);
    assert.ok(res.body.includes('status="failed"'));
    assert.ok(res.body.includes('code="40"'));
  });

  test('accepts token auth (md5)', async () => {
    const res = await call(handler, url('ping'));
    assert.ok(res.body.includes('status="ok"'), `Expected ok, got: ${res.body}`);
  });

  test('accepts enc: password', async () => {
    const res = await call(handler, `/rest/ping.view?u=qualquer&p=enc:${TEST_PASS_HEX}&v=1.16.1&c=test`);
    assert.ok(res.body.includes('status="ok"'));
  });

  test('accepts any username with correct password', async () => {
    const salt = 'saltsalt';
    const token = crypto.createHash('md5').update(TEST_PASS + salt).digest('hex');
    const res = await call(handler, `/rest/ping.view?u=anyusername&t=${token}&s=${salt}&v=1.16.1&c=test`);
    assert.ok(res.body.includes('status="ok"'));
  });
});

// ── ping ──────────────────────────────────────────────────────────────────────

describe('ping', () => {
  const handler = makeHandler();

  test('returns ok', async () => {
    const res = await call(handler, url('ping'));
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('status="ok"'));
    assert.ok(res.body.includes(`version="${'1.16.1'}"`));
  });

  test('returns json when f=json', async () => {
    const res = await call(handler, url('ping') + '&f=json');
    const data = JSON.parse(res.body);
    assert.equal(data['subsonic-response'].status, 'ok');
  });
});

// ── getMusicFolders ───────────────────────────────────────────────────────────

describe('getMusicFolders', () => {
  const handler = makeHandler();

  test('returns one folder', async () => {
    const res = await call(handler, url('getMusicFolders'));
    assert.ok(res.body.includes('<musicFolder'));
    assert.ok(res.body.includes('Acervo Teste'));
  });

  test('json format', async () => {
    const res = await call(handler, url('getMusicFolders') + '&f=json');
    const data = JSON.parse(res.body);
    const folders = data['subsonic-response'].musicFolders.musicFolder;
    assert.equal(folders[0].name, 'Acervo Teste');
  });
});

// ── getIndexes ────────────────────────────────────────────────────────────────

describe('getIndexes', () => {
  const handler = makeHandler();

  test('returns indexed artists', async () => {
    const res = await call(handler, url('getIndexes'));
    assert.ok(res.body.includes('<indexes'));
    assert.ok(res.body.includes('<index'));
    assert.ok(res.body.includes('<artist'));
  });

  test('filters by musicFolderId', async () => {
    const res = await call(handler, url('getIndexes') + '&musicFolderId=99');
    // folder 99 doesn't exist → empty indexes
    assert.ok(res.body.includes('<indexes'));
    assert.ok(!res.body.includes('<artist'));
  });
});

// ── getArtists ────────────────────────────────────────────────────────────────

describe('getArtists', () => {
  const handler = makeHandler();

  test('returns all artists grouped by letter', async () => {
    const res = await call(handler, url('getArtists'));
    assert.ok(res.body.includes('<artists'));
    assert.ok(res.body.includes('Chico Buarque'));
  });
});

// ── getArtist ─────────────────────────────────────────────────────────────────

describe('getArtist', () => {
  const handler = makeHandler();
  const ar = [...idx.artistById.values()][0];

  test('returns artist with albums', async () => {
    const res = await call(handler, url('getArtist') + `&id=${ar.id}`);
    assert.ok(res.body.includes(`name="${ar.name}"`));
    assert.ok(res.body.includes('<album'));
  });

  test('returns error for unknown id', async () => {
    const res = await call(handler, url('getArtist') + '&id=unknown');
    assert.ok(res.body.includes('status="failed"'));
    assert.ok(res.body.includes('code="70"'));
  });
});

// ── getAlbum ──────────────────────────────────────────────────────────────────

describe('getAlbum', () => {
  const handler = makeHandler();
  const al = [...idx.albumById.values()][0];

  test('returns album with songs', async () => {
    const res = await call(handler, url('getAlbum') + `&id=${al.id}`);
    assert.ok(res.body.includes('Construção'));
    assert.ok(res.body.includes('<song'));
  });

  test('song has required attributes', async () => {
    const res = await call(handler, url('getAlbum') + `&id=${al.id}`);
    assert.ok(res.body.includes('contentType="audio/mpeg"'));
    assert.ok(res.body.includes('suffix="mp3"'));
    assert.ok(res.body.includes('type="music"'));
  });

  test('returns error for unknown id', async () => {
    const res = await call(handler, url('getAlbum') + '&id=nope');
    assert.ok(res.body.includes('status="failed"'));
  });
});

// ── getSong ───────────────────────────────────────────────────────────────────

describe('getSong', () => {
  const handler = makeHandler();
  const song = [...idx.songById.values()][0];

  test('returns song info', async () => {
    const res = await call(handler, url('getSong') + `&id=${song.id}`);
    assert.ok(res.body.includes(`title="${song.title}"`));
  });

  test('returns error for unknown id', async () => {
    const res = await call(handler, url('getSong') + '&id=nope');
    assert.ok(res.body.includes('status="failed"'));
  });
});

// ── getAlbumList2 ─────────────────────────────────────────────────────────────

describe('getAlbumList2', () => {
  const handler = makeHandler();

  test('returns up to size albums', async () => {
    const res = await call(handler, url('getAlbumList2') + '&type=alphabeticalByName&size=3');
    const matches = res.body.match(/<album /g) || [];
    assert.equal(matches.length, 3);
  });

  test('offset paginates correctly', async () => {
    const r1 = await call(handler, url('getAlbumList2') + '&type=alphabeticalByName&size=2&offset=0');
    const r2 = await call(handler, url('getAlbumList2') + '&type=alphabeticalByName&size=2&offset=2');
    // Should be different albums
    assert.notEqual(r1.body, r2.body);
  });

  test('byYear filters and sorts', async () => {
    const res = await call(handler, url('getAlbumList2') + '&type=byYear&fromYear=1970&toYear=1975&size=20');
    assert.ok(res.body.includes('<albumList2'));
  });
});

// ── search3 ───────────────────────────────────────────────────────────────────

describe('search3', () => {
  const handler = makeHandler();

  test('finds albums and artists by query', async () => {
    const res = await call(handler, url('search3') + '&query=Chico');
    assert.ok(res.body.includes('<searchResult3'));
    assert.ok(res.body.includes('Chico Buarque'));
  });

  test('returns empty results for no match', async () => {
    const res = await call(handler, url('search3') + '&query=XYZNOTFOUND999');
    assert.ok(res.body.includes('<searchResult3'));
    assert.ok(!res.body.includes('<album '));
    assert.ok(!res.body.includes('<artist '));
  });

  test('json format', async () => {
    const res = await call(handler, url('search3') + '&query=Chico&f=json');
    const data = JSON.parse(res.body);
    assert.ok(data['subsonic-response'].searchResult3);
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
    assert.ok(res.body.includes('<directory'));
    assert.ok(res.body.includes('isDir="true"'));
  });

  test('artist id → lists albums', async () => {
    const res = await call(handler, url('getMusicDirectory') + `&id=${ar.id}`);
    assert.ok(res.body.includes('<directory'));
    assert.ok(res.body.includes('isDir="true"'));
  });

  test('album id → lists songs', async () => {
    const res = await call(handler, url('getMusicDirectory') + `&id=${al.id}`);
    assert.ok(res.body.includes('<directory'));
    assert.ok(res.body.includes('isDir="false"'));
  });

  test('unknown id → error 70', async () => {
    const res = await call(handler, url('getMusicDirectory') + '&id=nope');
    assert.ok(res.body.includes('code="70"'));
  });
});

// ── stream ────────────────────────────────────────────────────────────────────

describe('stream', () => {
  test('calls handleObject with correct s3Key', async () => {
    const song = [...idx.songById.values()][0];
    let calledKey = null;
    const mockHandleObject = async (_req, _res, key) => { calledKey = key; };
    const handler = makeHandler(mockHandleObject);

    const req = mockReq(url('stream') + `&id=${song.id}`);
    const res = mockRes();
    await handler(req, res, new URL(req.url, 'http://localhost'));

    assert.equal(calledKey, song.s3Key);
    assert.ok(calledKey.startsWith('uqt/'));
    assert.ok(calledKey.endsWith('.mp3'));
  });

  test('returns 404 for unknown song id', async () => {
    const handler = makeHandler();
    const req = mockReq(url('stream') + '&id=unknown');
    const res = mockRes();
    await handler(req, res, new URL(req.url, 'http://localhost'));
    assert.equal(res.status, 404);
  });
});

// ── getCoverArt ───────────────────────────────────────────────────────────────

describe('getCoverArt', () => {
  test('calls handleObject with capa-min.jpg key for album with cover', async () => {
    const al = [...idx.albumById.values()].find(a => a.hasCover);
    let calledKey = null;
    const handler = makeHandler(async (_req, _res, key) => { calledKey = key; });

    await call(handler, url('getCoverArt') + `&id=${al.id}`);
    assert.ok(calledKey?.endsWith('capa-min.jpg'), `Expected capa-min.jpg, got: ${calledKey}`);
  });

  test('returns 404 for album without cover', async () => {
    // Build an index with no covers
    const noCovers = buildIndex([{
      id: 9, key: 'nc', db: {
        meta: { title: 'NC', base_url: 'https://proxy.test/nc' },
        albums: [{ title: 'X', artist: 'Y', year: 2000, path: 'X', has_cover: false, tracks: [] }],
      },
    }]);
    const al = [...noCovers.albumById.values()][0];
    const handler = createSubsonicHandler(() => {}, { sources: [{ id: 9, key: 'nc', db: noCovers.folders[0] }] });

    // Re-build handler pointing at this index directly via buildIndex
    const h2 = createSubsonicHandler(() => {}, { sources: [{ id: 9, key: 'nc', db: {
      meta: { title: 'NC', base_url: 'https://proxy.test/nc' },
      albums: [{ title: 'X', artist: 'Y', year: 2000, path: 'X', has_cover: false, tracks: [] }],
    }}]});

    const req = mockReq(url('getCoverArt') + `&id=${al.id}`);
    const res = mockRes();
    await h2(req, res, new URL(req.url, 'http://localhost'));
    assert.equal(res.status, 404);
  });
});

// ── stubs ─────────────────────────────────────────────────────────────────────

describe('stub endpoints', () => {
  const handler = makeHandler();

  test('getPlaylists returns empty list', async () => {
    const res = await call(handler, url('getPlaylists'));
    assert.ok(res.body.includes('status="ok"'));
    assert.ok(res.body.includes('<playlists'));
  });

  test('getStarred2 returns empty', async () => {
    const res = await call(handler, url('getStarred2'));
    assert.ok(res.body.includes('status="ok"'));
  });

  test('getScanStatus returns scanning=false', async () => {
    const res = await call(handler, url('getScanStatus'));
    assert.ok(res.body.includes('scanning="false"'));
  });

  test('getLicense returns valid=true', async () => {
    const res = await call(handler, url('getLicense'));
    assert.ok(res.body.includes('valid="true"'));
  });

  test('unknown method returns error 30', async () => {
    const res = await call(handler, url('nonExistentMethod'));
    assert.ok(res.body.includes('code="30"'));
  });
});

// ── OpenSubsonic ──────────────────────────────────────────────────────────────

describe('openSubsonic', () => {
  const handler = makeHandler();

  test('ping XML declares openSubsonic="true"', async () => {
    const res = await call(handler, url('ping'));
    assert.ok(res.body.includes('openSubsonic="true"'), res.body);
  });

  test('ping XML declares type="tocador"', async () => {
    const res = await call(handler, url('ping'));
    assert.ok(res.body.includes('type="tocador"'), res.body);
  });

  test('ping XML declares serverVersion', async () => {
    const res = await call(handler, url('ping'));
    assert.ok(res.body.includes('serverVersion='), res.body);
  });

  test('ping XML includes openSubsonicExtensions element', async () => {
    const res = await call(handler, url('ping'));
    assert.ok(res.body.includes('<openSubsonicExtensions'), res.body);
  });

  test('ping JSON has openSubsonic=true', async () => {
    const res = await call(handler, url('ping') + '&f=json');
    const data = JSON.parse(res.body);
    assert.equal(data['subsonic-response'].openSubsonic, true);
  });

  test('ping JSON has type="tocador"', async () => {
    const res = await call(handler, url('ping') + '&f=json');
    const data = JSON.parse(res.body);
    assert.equal(data['subsonic-response'].type, 'tocador');
  });

  test('ping JSON has serverVersion', async () => {
    const res = await call(handler, url('ping') + '&f=json');
    const data = JSON.parse(res.body);
    assert.ok(data['subsonic-response'].serverVersion);
  });

  test('ping JSON has empty openSubsonicExtensions array', async () => {
    const res = await call(handler, url('ping') + '&f=json');
    const data = JSON.parse(res.body);
    assert.deepEqual(data['subsonic-response'].openSubsonicExtensions, []);
  });

  test('error responses also declare openSubsonic="true"', async () => {
    const badToken = crypto.createHash('md5').update('wrong' + TEST_SALT).digest('hex');
    const res = await call(handler, `/rest/ping.view?u=x&t=${badToken}&s=${TEST_SALT}&v=1.16.1&c=test`);
    assert.ok(res.body.includes('openSubsonic="true"'), res.body);
  });

  test('non-ping endpoints also carry openSubsonic="true"', async () => {
    const res = await call(handler, url('getMusicFolders'));
    assert.ok(res.body.includes('openSubsonic="true"'), res.body);
  });
});
