// v2 (columnar) payload parity.
//
// The player must render byte-identical results from the v1 and v2 encodings of
// the same archive. These specs load the app twice — once per encoding — and
// compare what actually reached the DOM, which is the only thing that matters.
//
// albums-v2.json.gz is produced from albums.json.gz by script/convert-acervo-v2.js.

const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const v1Gz = fs.readFileSync(path.join(__dirname, 'fixtures', 'albums.json.gz'));
const v2Gz = fs.readFileSync(path.join(__dirname, 'fixtures', 'albums-v2.json.gz'));

async function gotoWith(page, body, url = '/') {
  await page.addInitScript(() => {
    localStorage.setItem('tocador-browse-collapsed', 'true');
  });
  for (const pattern of ['**/uqt-albums.json.gz', '**/homi-albums.json.gz']) {
    await page.route(pattern, route => route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' },
      body,
    }));
  }
  await page.route('**/*-genres.json.gz', route => route.fulfill({ status: 404 }));
  await page.route('**/*.mp3', route => route.fulfill({ status: 200, body: Buffer.alloc(0) }));
  await page.route('**/capa-min.jpg', route => route.fulfill({ status: 404 }));
  await page.route('**/report-error', route => route.fulfill({ status: 204 }));
  await page.goto(url);
  await page.waitForSelector('.album-item', { timeout: 8000 });
}

// The grid is virtualised, so read the model rather than the ~30 live nodes.
// Sorted because v2 stores albums artist-first; the player re-sorts by year and
// display order is asserted separately by the v1 suite.
async function snapshot(page) {
  // `albums` is a top-level `let` — a global lexical binding, not a window property.
  return page.evaluate(() => albums
    .map(a => [a.path, a.name, a.artists, a.year, a.tracks.length,
               a.tracks.map(t => `${t.num}|${t.title}|${t.file}|${t.artists}`).join('~')].join('§'))
    .sort());
}

test('V1: v2 payload yields the same album count as v1', async ({ page }) => {
  await gotoWith(page, v2Gz);
  await expect(page.locator('.album-item')).toHaveCount(13);
});

// Each encoding gets its own context: the service worker registered by the first
// load would otherwise serve the second one from its own cache, and the two
// payloads would never actually be compared.
test('V2: v2 decodes to exactly the same albums, tracks and file paths as v1', async ({ browser }) => {
  const load = async body => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await gotoWith(page, body);
    const snap = await snapshot(page);
    await context.close();
    return snap;
  };

  const fromV1 = await load(v1Gz);
  const fromV2 = await load(v2Gz);

  expect(fromV2).toEqual(fromV1);
  expect(fromV1.length).toBe(13);
});

// Derived paths are rebuilt as "<year> - <artist> - <title>"; a mistake here
// produces a 404 on every track of the affected album.
test('V3: album with a derived path still builds a working audio URL', async ({ page }) => {
  await gotoWith(page, v2Gz, '/?album=1971+-+Chico+Buarque+-+Constru%C3%A7%C3%A3o');
  await expect(page.locator('#track-list .track-item')).toHaveCount(3);

  const [request] = await Promise.all([
    page.waitForRequest(req => req.url().includes('.mp3'), { timeout: 5000 }),
    page.locator('#track-list .track-item').first().click(),
  ]);
  expect(decodeURIComponent(request.url())).toContain('1971 - Chico Buarque - Construção/');
});

// Paths that do not match the convention are stored verbatim; the '#' album also
// guards the encoding regression covered by K43.
test('V4: album with a non-derivable path round-trips through v2', async ({ page }) => {
  await gotoWith(page, v2Gz);
  await page.locator('.album-item', { hasText: 'Álbum com # no caminho' }).click();

  const [request] = await Promise.all([
    page.waitForRequest(req => req.url().includes('.mp3'), { timeout: 5000 }),
    page.locator('#track-list .track-item').first().click(),
  ]);
  const url = request.url();
  expect(url).toContain('%23');
  expect(url).not.toMatch(/#[^/]/);
});

test('V5: v1 payloads keep loading unchanged (no forced migration)', async ({ page }) => {
  await gotoWith(page, v1Gz);
  await expect(page.locator('.album-item')).toHaveCount(13);
});

// Regression. Tracks may arrive with no `num` at all, and the player then numbers
// them by their position *after* it drops duplicate titles. An encoder that
// resolves the missing number against the raw position bakes in the pre-dedup
// index, so every track after a duplicate ends up numbered one too high — it hit
// 22 of the 2306 real uqt albums. The shared fixture has no un-numbered tracks,
// so this case needs its own payload.
const zlib = require('zlib');

const dupAlbum = {
  title: 'Sem Num Com Duplicata',
  artist: 'Artista Num',
  year: 2020,
  path: '2020 - Artista Num - Sem Num Com Duplicata',
  has_cover: false,
  // No `num` on any track; the first two share a title and are deduped to one.
  tracks: [
    { title: 'Repetida', file: 'a.mp3', duration: 10 },
    { title: 'Repetida', file: 'b.mp3', duration: 10 },
    { title: 'Terceira', file: 'c.mp3', duration: 10 },
  ],
};

const dupV1 = zlib.gzipSync(Buffer.from(JSON.stringify({
  meta: { title: 'T', base_url: 'https://cdn.tocador.cc/uqt' },
  albums: [dupAlbum],
})));

// Same album, hand-encoded as v2. 0 in t.n marks "source had no track number".
const dupV2 = zlib.gzipSync(Buffer.from(JSON.stringify({
  meta: { title: 'T', base_url: 'https://cdn.tocador.cc/uqt' },
  v: 2,
  a: { t: ['Sem Num Com Duplicata'], r: ['Artista Num'], y: [2020], p: [''], c: [0], n: [3] },
  t: {
    t: ['Repetida', 'Repetida', 'Terceira'],
    f: ['a.mp3', 'b.mp3', 'c.mp3'],
    k: [0, 0, 0],
    d: [10, 10, 10],
    r: ['', '', ''],
    n: [0, 0, 0],
  },
})));

test('V6: un-numbered tracks are numbered after dedup, exactly as in v1', async ({ browser }) => {
  const nums = async body => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await gotoWith(page, body);
    await page.locator('.album-item').first().click();
    const out = await page.locator('#track-list .track-item .track-num').allTextContents();
    await context.close();
    return out.map(s => s.trim());
  };

  const fromV1 = await nums(dupV1);
  const fromV2 = await nums(dupV2);

  expect(fromV1).toEqual(['1', '2']); // duplicate dropped, then renumbered
  expect(fromV2).toEqual(fromV1);
});
