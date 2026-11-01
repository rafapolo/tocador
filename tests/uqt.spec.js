const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const fixturePath = path.join(__dirname, 'fixtures', 'albums.json.gz');
const fixtureGz = fs.readFileSync(fixturePath);
// A real, decodable 10s silence. An empty body made audio.play() reject with
// NotSupportedError, so the 'pause' event stripped the .playing class that
// playTrack() sets optimistically — a race the button-state tests lost about
// one run in three. Long enough that no test outlives it and hits 'ended'.
const fixtureMp3 = fs.readFileSync(path.join(__dirname, 'fixtures', 'silence.mp3'));

// The real CDN answers Range with 206; Chromium can't seek a plain 200 body (empty `seekable`).
function rangedMp3(route) {
  const m = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '');
  if (!m) return route.fulfill({ status: 200, headers: { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes' }, body: fixtureMp3 });
  const ini = +m[1], fim = m[2] ? Math.min(+m[2], fixtureMp3.length - 1) : fixtureMp3.length - 1;
  return route.fulfill({ status: 206, body: fixtureMp3.subarray(ini, fim + 1), headers: {
    'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${ini}-${fim}/${fixtureMp3.length}` } });
}

async function gotoWithFixture(page, url = '/', { blockAudio = false, ranges = false } = {}) {
  // Clear persisted player state so shuffle/repeat start at defaults
  await page.addInitScript(() => {
    localStorage.removeItem('uqt-shuffle');
    localStorage.removeItem('uqt-repeat');
    localStorage.removeItem('uqt-volume');
    localStorage.removeItem('homi-shuffle');
    localStorage.removeItem('homi-repeat');
    localStorage.removeItem('homi-volume');
    localStorage.setItem('tocador-browse-collapsed', 'true');
  });
  await page.route('**/uqt-albums.json.gz', route => {
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' },
      body: fixtureGz,
    });
  });
  await page.route('**/homi-albums.json.gz', route => {
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' },
      body: fixtureGz,
    });
  });
  await page.route('**/*-genres.json.gz', route => route.fulfill({ status: 404 }));
  // Block audio and image network requests to keep tests fast
  await page.route('**/*.mp3', route => blockAudio
    ? route.abort()
    : ranges ? rangedMp3(route)
    : route.fulfill({ status: 200, headers: { 'Content-Type': 'audio/mpeg' }, body: fixtureMp3 }));
  await page.route('**/capa-m*.jpg', route => route.fulfill({ status: 404 }));
  await page.route('**/report-error', route => route.fulfill({ status: 204 }));
  await page.goto(url);
  // Wait for albums grid to be populated
  await page.waitForSelector('.album-item', { timeout: 8000 });
}

// ── A. Initial Load & URL State ───────────────────────────────────────────

test('A1: albums render in grid after gzip fetch and decompress', async ({ page }) => {
  await gotoWithFixture(page);
  const items = page.locator('.album-item');
  // fixture has 13 albums (10 originals + 2 with # in path + 1 with duplicate tracks)
  await expect(items).toHaveCount(13);
});

// Googlebot renders ?t= track URLs but can't fetch audio. The primed track's load
// error used to auto-skip to the next one and rewrite ?t=2 to ?t=3, which Search
// Console reported as "Page with redirect" on every track URL it crawled.
test('A1b: a primed track that fails to load leaves the URL untouched', async ({ page }) => {
  const url = '/?album=1971+-+Chico+Buarque+-+Constru%C3%A7%C3%A3o&t=2';
  await gotoWithFixture(page, url, { blockAudio: true });
  await page.waitForTimeout(2500); // past the 1.5s auto-skip delay
  expect(new URL(page.url()).search).toBe(url.slice(1));
});

test('A2: ?album= pre-selects album and shows track list', async ({ page }) => {
  await gotoWithFixture(page, '/?album=1971+-+Chico+Buarque+-+Constru%C3%A7%C3%A3o');
  await expect(page.locator('#track-list .track-item')).toHaveCount(3);
  await expect(page.locator('#album-header h2')).toContainText('Construção');
});

test('A3: ?q= pre-fills search and filters grid', async ({ page }) => {
  await gotoWithFixture(page, '/?q=Elis');
  await expect(page.locator('#search-input')).toHaveValue('Elis');
  const count = await page.locator('.album-item').count();
  expect(count).toBeGreaterThanOrEqual(2);
  expect(count).toBeLessThan(10);
});

test('A4: ?t= pre-selects a specific track and primes audio.src', async ({ page }) => {
  await gotoWithFixture(page, '/?album=1971+-+Chico+Buarque+-+Constru%C3%A7%C3%A3o&t=2');
  const audioSrc = await page.evaluate(() => document.querySelector('#audio')?.src ?? '');
  expect(audioSrc).toContain('Deus');
});

test('A5: ?play=1 with album and track triggers audio load', async ({ page }) => {
  await gotoWithFixture(page, '/?album=1971+-+Chico+Buarque+-+Constru%C3%A7%C3%A3o&t=1&play=1');
  const audioSrc = await page.evaluate(() => document.querySelector('#audio')?.src ?? '');
  expect(audioSrc).toContain('Constru');
});

test('A5b: ?seg= (the /atlas preview handover) starts the track that many seconds in, and leaves the URL', async ({ page }) => {
  await gotoWithFixture(page, '/?album=1971+-+Chico+Buarque+-+Constru%C3%A7%C3%A3o&t=1&play=1&seg=4', { ranges: true });
  await expect.poll(() => page.evaluate(() => document.querySelector('#audio').currentTime)).toBeGreaterThanOrEqual(4);
  expect(new URL(page.url()).searchParams.get('seg')).toBeNull();
});

test('A6: ?ano= filters to that exact year only', async ({ page }) => {
  await gotoWithFixture(page, '/?ano=1972');
  const count = await page.locator('.album-item').count();
  expect(count).toBe(1);
  await expect(page.locator('.album-item').first()).toContainText('Clube da Esquina');
});

// ── B. Search & Filtering ─────────────────────────────────────────────────

test('B7: search by album title (case-insensitive)', async ({ page }) => {
  await gotoWithFixture(page);
  await page.fill('#search-input', 'construção');
  await expect(page.locator('.album-item')).toHaveCount(1);
  await expect(page.locator('.album-item').first()).toContainText('Construção');
});

test('B8: search by artist name', async ({ page }) => {
  await gotoWithFixture(page);
  await page.fill('#search-input', 'Caetano');
  const count = await page.locator('.album-item').count();
  expect(count).toBeGreaterThanOrEqual(1);
});

test('B9: search matches track titles within albums', async ({ page }) => {
  await gotoWithFixture(page);
  await page.fill('#search-input', 'Águas de Março');
  await expect(page.locator('.album-item')).toHaveCount(1);
  await expect(page.locator('.album-item').first()).toContainText('Elis');
});

test('B10: clearing search (✕ button) resets to full list', async ({ page }) => {
  await gotoWithFixture(page);
  await page.fill('#search-input', 'Caetano');
  await expect(page.locator('.album-item')).not.toHaveCount(13);
  await page.click('#search-clear');
  await expect(page.locator('.album-item')).toHaveCount(13);
  await expect(page.locator('#search-input')).toHaveValue('');
});

test('B11: decade button filters to correct decade and clears search', async ({ page }) => {
  await gotoWithFixture(page);
  await page.fill('#search-input', 'Elis');
  await page.click('.decade-btn[data-decade="1970"]');
  await expect(page.locator('#search-input')).toHaveValue('');
  const count = await page.locator('.album-item').count();
  // 1971 Construção, 1972 Clube, 1974 Elis & Tom, 1976 Falso Brilhante
  expect(count).toBe(4);
});

test('B12: <1940 button shows albums with year < 1950', async ({ page }) => {
  await gotoWithFixture(page);
  await page.click('.decade-btn[data-decade="pre1940"]');
  await expect(page.locator('.album-item')).toHaveCount(1);
  await expect(page.locator('.album-item').first()).toContainText('Pixinguinha');
});

test('B13: ∞ button shows albums with no year', async ({ page }) => {
  await gotoWithFixture(page);
  await page.click('.decade-btn[data-decade="noyear"]');
  await expect(page.locator('.album-item')).toHaveCount(1);
  await expect(page.locator('.album-item').first()).toContainText('Sem Data');
});

// ── C. Album Selection & Track Priming ───────────────────────────────────

test('C14: clicking album card sets .active class on that card', async ({ page }) => {
  await gotoWithFixture(page);
  const items = page.locator('.album-item');
  const second = items.nth(1);
  await second.click();
  await expect(second).toHaveClass(/active/);
});

test('C15: clicking album renders correct track list', async ({ page }) => {
  await gotoWithFixture(page);
  await page.locator('.album-item', { hasText: 'Construção' }).click();
  const tracks = page.locator('#track-list .track-item');
  await expect(tracks).toHaveCount(3);
  await expect(tracks.nth(0)).toContainText('Construção');
  await expect(tracks.nth(1)).toContainText('Deus lhe Pague');
});

test('C16: clicking album shows album header with name, artist, year', async ({ page }) => {
  await gotoWithFixture(page);
  await page.locator('.album-item', { hasText: 'Elis & Tom' }).click();
  await expect(page.locator('#album-header h2')).toContainText('Elis & Tom');
  await expect(page.locator('#album-header')).toContainText('1974');
  await expect(page.locator('#album-header')).toContainText('Elis Regina');
});

test('C17: clicking album primes audio.src but does NOT auto-play', async ({ page }) => {
  await gotoWithFixture(page);
  const items = page.locator('.album-item');
  await items.nth(3).click();
  const isPaused = await page.evaluate(() => {
    const audio = document.querySelector('#audio');
    return audio ? audio.paused : true;
  });
  expect(isPaused).toBe(true);
});

test('C18: clicking same album twice does not re-render track list', async ({ page }) => {
  await gotoWithFixture(page);
  const item = page.locator('.album-item', { hasText: 'Clube da Esquina' });
  await item.click();
  await page.evaluate(() => {
    const el = document.querySelector('#track-list .track-item');
    if (el) el.dataset.renderMarker = 'first-render';
  });
  await item.click();
  const marker = await page.evaluate(() =>
    document.querySelector('#track-list .track-item')?.dataset.renderMarker
  );
  expect(marker).toBe('first-render');
});

// ── D. Playback Controls ──────────────────────────────────────────────────

test('D19: clicking a track item sets audio.src and marks track as playing in list', async ({ page }) => {
  await gotoWithFixture(page);
  await page.locator('.album-item', { hasText: 'Construção' }).click();
  await page.locator('#track-list .track-item').nth(1).click();
  // audio.src is set to the new track
  const audioSrc = await page.evaluate(() => document.querySelector('#audio')?.src ?? '');
  expect(audioSrc).toContain('Deus');
  // The clicked track-item gets .playing class (synchronously set in renderTrackList)
  await expect(page.locator('#track-list .track-item').nth(1)).toHaveClass(/playing/);
  // Player title is updated synchronously in updateNowPlaying()
  await expect(page.locator('#player-title')).toContainText('Deus lhe Pague');
});

test('D20: play button toggles pause/resume', async ({ page }) => {
  await gotoWithFixture(page);
  await page.locator('.album-item', { hasText: 'Construção' }).click();
  await page.locator('#track-list .track-item').first().click();
  await expect(page.locator('#btn-play')).toHaveClass(/playing/);
  await page.click('#btn-play');
  await expect(page.locator('#btn-play')).not.toHaveClass(/playing/);
  await page.click('#btn-play');
  await expect(page.locator('#btn-play')).toHaveClass(/playing/);
});

test('D21: next button advances to next track in same album', async ({ page }) => {
  await gotoWithFixture(page);
  await page.locator('.album-item', { hasText: 'Construção' }).click();
  await page.locator('#track-list .track-item').first().click();
  const src1 = await page.evaluate(() => document.querySelector('#audio')?.src ?? '');
  await page.click('#btn-next');
  const src2 = await page.evaluate(() => document.querySelector('#audio')?.src ?? '');
  expect(src2).not.toBe(src1);
  expect(src2).toContain('Deus');
});

test('D22: prev button goes to previous track', async ({ page }) => {
  await gotoWithFixture(page);
  await page.locator('.album-item', { hasText: 'Construção' }).click();
  await page.locator('#track-list .track-item').nth(1).click();
  const src1 = await page.evaluate(() => document.querySelector('#audio')?.src ?? '');
  await page.click('#btn-prev');
  const src2 = await page.evaluate(() => document.querySelector('#audio')?.src ?? '');
  expect(src2).not.toBe(src1);
  expect(src2).toContain('Constru');
});

test('D23: last track + next does nothing without repeat', async ({ page }) => {
  await gotoWithFixture(page);
  await page.locator('.album-item', { hasText: 'Getz' }).click();
  await page.locator('#track-list .track-item').nth(1).click();
  const src1 = await page.evaluate(() => document.querySelector('#audio')?.src ?? '');
  const repeatMode = await page.evaluate(() => window.repeatMode ?? 'off');
  expect(repeatMode).toBe('off');
  await page.click('#btn-next');
  const src2 = await page.evaluate(() => document.querySelector('#audio')?.src ?? '');
  expect(src2).toBe(src1);
});

// ── E. Shuffle & Repeat ───────────────────────────────────────────────────

test('E24: shuffle button toggles .active class on #btn-shuffle', async ({ page }) => {
  await gotoWithFixture(page);
  // Default: shuffle off — button has no .active class
  await expect(page.locator('#btn-shuffle')).not.toHaveClass(/active/);
  await page.click('#btn-shuffle');
  await expect(page.locator('#btn-shuffle')).toHaveClass(/active/);
  await page.click('#btn-shuffle');
  await expect(page.locator('#btn-shuffle')).not.toHaveClass(/active/);
});

test('E25: with shuffle on, playNext picks varied tracks', async ({ page }) => {
  await gotoWithFixture(page);
  await page.locator('.album-item', { hasText: 'Construção' }).click();
  await page.locator('#track-list .track-item').first().click();
  await page.click('#btn-shuffle');
  const srcs = new Set();
  for (let i = 0; i < 10; i++) {
    await page.click('#btn-next');
    const src = await page.evaluate(() => document.querySelector('#audio')?.src ?? '');
    srcs.add(src);
  }
  expect(srcs.size).toBeGreaterThan(1);
});

test('E26: repeat-one sets audio.loop; repeat-all activates button without loop', async ({ page }) => {
  await gotoWithFixture(page);
  // Default: repeat off — button inactive
  await expect(page.locator('#btn-repeat')).not.toHaveClass(/active/);
  const loopOff = await page.evaluate(() => document.querySelector('#audio')?.loop);
  expect(loopOff).toBe(false);
  // First click: repeat-one — audio.loop true, button active, title = 'Repetir faixa'
  await page.click('#btn-repeat');
  const loopOne = await page.evaluate(() => document.querySelector('#audio')?.loop);
  expect(loopOne).toBe(true);
  await expect(page.locator('#btn-repeat')).toHaveClass(/active/);
  await expect(page.locator('#btn-repeat')).toHaveAttribute('title', 'Repetir faixa');
  // Second click: repeat-all — audio.loop false, button still active, title = 'Repetir álbum'
  await page.click('#btn-repeat');
  const loopAll = await page.evaluate(() => document.querySelector('#audio')?.loop);
  expect(loopAll).toBe(false);
  await expect(page.locator('#btn-repeat')).toHaveClass(/active/);
  await expect(page.locator('#btn-repeat')).toHaveAttribute('title', 'Repetir álbum');
});

// ── F. URL Updates ────────────────────────────────────────────────────────

test('F27: selecting album updates URL ?album= param', async ({ page }) => {
  await gotoWithFixture(page);
  await page.locator('.album-item', { hasText: 'Clube da Esquina' }).click();
  await expect(page).toHaveURL(/album=/);
  const url = new URL(page.url());
  expect(url.searchParams.get('album')).toContain('Clube');
});

test('F28: playing a track updates URL ?t= param', async ({ page }) => {
  await gotoWithFixture(page);
  await page.locator('.album-item', { hasText: 'Construção' }).click();
  await page.locator('#track-list .track-item').nth(1).click();
  await expect(page).toHaveURL(/t=2/);
});

test('F29: browser back navigates to previous album selection', async ({ page }) => {
  await gotoWithFixture(page);
  await page.locator('.album-item', { hasText: 'Construção' }).click();
  await page.locator('.album-item', { hasText: 'Clube da Esquina' }).click();
  await page.goBack();
  const url = new URL(page.url());
  expect(url.searchParams.get('album')).toContain('Constru');
});

// ── G. Artist Link Clicks ─────────────────────────────────────────────────

test('G30: clicking artist name in album header filters by that artist', async ({ page }) => {
  await gotoWithFixture(page);
  await page.locator('.album-item', { hasText: 'Elis & Tom' }).click();
  await page.locator('#album-header .artist-link').filter({ hasText: 'Elis Regina' }).first().click();
  await expect(page.locator('#search-input')).toHaveValue('Elis Regina');
  const count = await page.locator('.album-item').count();
  expect(count).toBeGreaterThanOrEqual(1);
  expect(count).toBeLessThan(10);
});

test('G30b: cmd/ctrl + click on an artist opens the search in a new tab and leaves this one alone', async ({ page, context }) => {
  await gotoWithFixture(page, '/?acervo=uqt');
  await page.locator('.album-item', { hasText: 'Elis & Tom' }).click();
  const link = page.locator('#album-header .artist-link').filter({ hasText: 'Elis Regina' }).first();
  await expect(link).toHaveAttribute('href', /[?&]q=Elis\+Regina/);
  const [aba] = await Promise.all([context.waitForEvent('page'), link.click({ modifiers: ['ControlOrMeta'] })]);
  expect(new URL(aba.url()).searchParams.get('q')).toBe('Elis Regina');
  await aba.close();
  await expect(page.locator('#search-input')).toHaveValue('');
});

test('G31: clicking track-level artist in track list filters by that artist', async ({ page }) => {
  await gotoWithFixture(page);
  await page.locator('.album-item', { hasText: 'Getz' }).click();
  await page.locator('#track-list .track-artist .artist-link').first().click();
  await expect(page.locator('#search-input')).not.toHaveValue('');
});

// ── H. VirtualGrid Edge Cases ─────────────────────────────────────────────

test('H32: narrow viewport (320px) renders grid without JS errors', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await gotoWithFixture(page);
  await expect(page.locator('.album-item').first()).toBeVisible();
  const relevantErrors = errors.filter(e => !e.includes('favicon') && !e.includes('umami'));
  expect(relevantErrors).toHaveLength(0);
});

test('H33: DOM node count stays bounded while scrolling', async ({ page }) => {
  await gotoWithFixture(page);
  const countBefore = await page.locator('.album-item').count();
  await page.locator('#albums-list').evaluate(el => el.scrollTop = 1000);
  await page.waitForTimeout(100);
  const countMid = await page.locator('.album-item').count();
  expect(countMid).toBeLessThanOrEqual(20);
  expect(countBefore).toBeGreaterThan(0);
});

test('H34: filtering to zero results shows empty-state element', async ({ page }) => {
  await gotoWithFixture(page);
  await page.fill('#search-input', 'XXXXXXXXXNOTAREAL');
  await expect(page.locator('#empty-state')).toBeVisible();
  await expect(page.locator('.album-item')).toHaveCount(0);
});

// ── I. Mobile Drawer ──────────────────────────────────────────────────────

test('I35: on mobile viewport, clicking album opens mobile drawer', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await gotoWithFixture(page);
  const items = page.locator('.album-item');
  await items.nth(1).click();
  await expect(page.locator('#mobile-track-drawer')).toHaveClass(/open/);
});

test('I36: mobile drawer close button hides the drawer', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await gotoWithFixture(page);
  await page.locator('.album-item').nth(1).click();
  await expect(page.locator('#mobile-track-drawer')).toHaveClass(/open/);
  // Try various possible close button selectors
  const closeBtn = page.locator('.drawer-close, [id*="drawer-close"], #mobile-track-drawer button').first();
  await closeBtn.click();
  await expect(page.locator('#mobile-track-drawer')).not.toHaveClass(/open/);
});

test('I37: tapping the artist in the mobile drawer header searches for that artist', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await gotoWithFixture(page);
  await page.locator('.album-item').nth(1).click();
  await expect(page.locator('#mobile-track-drawer')).toHaveClass(/open/);
  const link = page.locator('#drawer-album-meta .artist-link').first();
  const artist = await link.getAttribute('data-artist');
  await link.click();
  await expect(page.locator('#search-input')).toHaveValue(artist);
  await expect(page.locator('#mobile-track-drawer')).not.toHaveClass(/open/);
});

// ── J. Bonus Edge Cases ───────────────────────────────────────────────────

test('J37: album with no cover shows placeholder on album header', async ({ page }) => {
  await gotoWithFixture(page);
  await page.locator('.album-item', { hasText: 'Acervo Raro' }).click();
  const coverImg = page.locator('#album-header .album-cover-large');
  await expect(coverImg).toHaveClass(/placeholder/);
});

test('J38: track-level artist shown when it differs from album artist', async ({ page }) => {
  await gotoWithFixture(page);
  await page.locator('.album-item', { hasText: 'Songbook' }).click();
  const trackArtists = page.locator('#track-list .track-artist');
  await expect(trackArtists.first()).toBeVisible();
});

test('J39: search-count pill shows filtered count when searching', async ({ page }) => {
  await gotoWithFixture(page);
  await page.fill('#search-input', 'Elis');
  await expect(page.locator('#search-count')).toHaveClass(/visible/);
  const text = await page.locator('#search-count').textContent();
  expect(text).toMatch(/álbun/);
});

test('J40: Todos button resets decade filter and shows all albums', async ({ page }) => {
  await gotoWithFixture(page);
  await page.click('.decade-btn[data-decade="1970"]');
  const filtered = await page.locator('.album-item').count();
  expect(filtered).toBeLessThan(13);
  await page.click('.decade-btn[data-decade="all"]');
  await expect(page.locator('.album-item')).toHaveCount(13);
});

test('J41: year link in album header filters by that year', async ({ page }) => {
  await gotoWithFixture(page);
  await page.locator('.album-item', { hasText: 'Elis & Tom' }).click();
  await page.locator('#album-header .year-link').click();
  const count = await page.locator('.album-item').count();
  expect(count).toBe(1);
});

test('J42: header stats show album and artist counts', async ({ page }) => {
  await gotoWithFixture(page);
  await expect(page.locator('#mobile-stat-albums')).not.toBeEmpty();
  await expect(page.locator('#mobile-stat-artists')).not.toBeEmpty();
});

// ── K. URL encoding & data integrity regressions ──────────────────────────
// Each test here corresponds to a real bug that shipped before being caught.

// Regression: encodeURI was used in buildAlbums, which doesn't encode #.
// Albums like "Álbum #99" produced audio src truncated at # (b74c8b0).
test('K43: audio src uses %23 for album with # in path, never bare #', async ({ page }) => {
  await gotoWithFixture(page);
  // This fixture album has exactly one track, so clicking it (below) primes
  // audio.src/load() as part of *album* selection (CLAUDE.md's data flow) —
  // the track click that follows is then a no-op for playTrack()'s own
  // src-unchanged guard and fires no second request. Wait on the album click.
  const [request] = await Promise.all([
    page.waitForRequest(req => req.url().includes('.mp3'), { timeout: 5000 }),
    page.locator('.album-item', { hasText: 'Álbum com # no caminho' }).click(),
  ]);
  await page.locator('#track-list .track-item').first().click();

  const url = request.url();
  expect(url).not.toMatch(/#[^/]/);
  expect(url).toContain('%23');
});

// Regression: updateMetaTags also used encodeURI, breaking og:image for # albums (b74c8b0).
test('K44: og:image URL uses %23 for album with # in path, never bare #', async ({ page }) => {
  await gotoWithFixture(page);
  await page.locator('.album-item', { hasText: 'Álbum com # no caminho' }).click();

  const ogImage = await page.locator('meta[property="og:image"]').getAttribute('content');
  expect(ogImage).toBeTruthy();
  expect(ogImage).not.toMatch(/#[^/]/);
  expect(ogImage).toContain('%23');
});

// Regression: buildAlbums did not dedup tracks that appeared both as a direct
// file and inside a subfolder (same title). Both variants ended up in the track
// list, duplicating entries (f50e704). The direct-path variant must win.
test('K45: duplicate track title from subfolder deduped — only one entry in track list', async ({ page }) => {
  await gotoWithFixture(page);
  await page.locator('.album-item', { hasText: 'Álbum com Faixa Duplicada' }).click();

  const tracks = page.locator('#track-list .track-item');
  await expect(tracks).toHaveCount(1);

  // The direct-path variant (no subdir/) must be the one kept
  const audioSrc = await page.evaluate(() => {
    const audio = document.querySelector('#audio');
    return audio?.src ?? '';
  });
  // audio is primed with first track; its path must NOT include subdir/
  expect(audioSrc).not.toContain('subdir');
});

// Regression: when meta.hours is absent from the JSON, hours should be computed
// from track durations rather than left blank.
test('K46: stat-hours computed from track durations when meta.hours absent', async ({ page }) => {
  await gotoWithFixture(page);
  // The fixture has no meta.hours field — hours must be computed from duration sums.
  const hours = await page.locator('#stat-hours').textContent();
  expect(hours?.trim()).toMatch(/^\d+ (min|horas?|dias?) de ♪$/);
});

test.describe('header stats and album neighbours', () => {
  test.use({ serviceWorkers: 'block' });   // page.route can't see what the worker serves
test('K46b: the header stats follow the active filter, and show the whole acervo without one', async ({ page }) => {
  await gotoWithFixture(page);
  const albumsStat = page.locator('#mobile-stat-albums'), hoursStat = page.locator('#stat-hours');
  const total = await albumsStat.textContent();
  await expect(albumsStat).toHaveAttribute('title', 'No acervo inteiro');
  await page.goto('/?ano=1972');                                  // Clube da Esquina only, 475 s
  await page.waitForSelector('.album-item');
  await expect(albumsStat).toHaveText('1 álbum');
  await expect(page.locator('#mobile-stat-artists')).toHaveText('1 artista');
  await expect(hoursStat).toHaveText('8 min de ♪');
  await expect(albumsStat).toHaveAttribute('title', 'No filtro atual');
  await page.goto('/');
  await page.waitForSelector('.album-item');
  await expect(albumsStat).toHaveText(total);
});

test('K46c: "Soa parecido com" lists the artist\'s sound neighbours; one here filters, one elsewhere opens its acervo', async ({ page }) => {
  // nomes 0..2, k = 2: Chico → [Caetano, Fulano], Caetano → [Chico, Fulano], Fulano (homi) → [Chico, Caetano]
  const viz = Buffer.from(new Uint16Array([1, 2, 0, 2, 0, 1]).buffer).toString('base64');
  const payload = { v: 1, k: 2, nomes: ['Chico Buarque', 'Caetano Veloso', 'Fulano Externo'], acervo: [0, 0, 1],
    acervos: ['uqt', 'homi'], viz: { som: viz, rotulos: viz } };
  let pedidos = 0;
  await page.route('**/data/atlas-artistas.json.gz', r => { pedidos++;
    r.fulfill({ status: 200, headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' },
      body: require('zlib').gzipSync(JSON.stringify(payload)) }); });
  await gotoWithFixture(page);
  await page.locator('.album-item', { hasText: 'Construção' }).click();
  const box = page.locator('#tracks-panel .album-parecidos');
  await expect(box).toBeVisible();
  expect(pedidos).toBe(0);                                        // only fetched when opened
  await box.locator('summary').click();
  const tags = box.locator('.album-genero');
  await expect(tags).toHaveCount(2);
  await expect(tags.nth(0)).toHaveText('Caetano Veloso');
  const fora = tags.nth(1);
  await expect(fora).toContainText('Fulano Externo');
  await expect(fora).toContainText('homi');
  await expect(fora).toHaveAttribute('target', '_blank');
  expect(new URL(await fora.getAttribute('href'), page.url()).searchParams.get('acervo')).toBe('homi');
  await tags.nth(0).click();
  await expect(page).toHaveURL(/artista=Caetano/);
  await expect(page.locator('.album-item', { hasText: 'Caetano Veloso' }).first()).toBeVisible();
  await expect(page.locator('.album-item', { hasText: 'Construção' })).toHaveCount(0);
});

  test('K46d: only one of "Gêneros detectados" and "Soa parecido com" is open at a time', async ({ page }) => {
    await page.route('**/data/atlas-artistas.json.gz', r => r.fulfill({ status: 404 }));
    await gotoWithFixture(page);
    await page.locator('.album-item', { hasText: 'Construção' }).click();
    const generos = page.locator('#tracks-panel .album-generos'), parecidos = page.locator('#tracks-panel .album-parecidos');
    await parecidos.locator('summary').click();
    await expect(parecidos).toHaveAttribute('open', '');
    await generos.locator('summary').click();
    await expect(generos).toHaveAttribute('open', '');
    await expect(parecidos).not.toHaveAttribute('open', '');
    await parecidos.locator('summary').click();
    await expect(generos).not.toHaveAttribute('open', '');
  });
});

// Regression: ?album= pre-selection must work when the album path contains #.
// The URL-decoded path has a literal #; album lookup must normalize correctly.
test('K47: ?album= with # in value pre-selects the correct album', async ({ page }) => {
  // encodeURIComponent('2024 - Artista Teste - Álbum #99') → %2324...
  await gotoWithFixture(page, '/?album=2024%20-%20Artista%20Teste%20-%20%C3%81lbum%20%2399');
  // The album title is "Álbum com # no caminho"; h2 must be non-empty and correct album selected
  await expect(page.locator('#album-header h2')).toContainText('Álbum com # no caminho');
  // track list for this album has 1 track
  await expect(page.locator('#track-list .track-item')).toHaveCount(1);
});

// Related: all albums in the fixture must produce audio URLs without a bare # fragment.
test('K48: no album in fixture produces an audio URL with a bare # in the path', async ({ page }) => {
  await gotoWithFixture(page);

  const badPaths = await page.evaluate(() => {
    return albums
      .map(a => {
        const base = window.BASE_URL || '';
        const t = a.tracks[0];
        return t ? `${base}/${t.file}` : null;
      })
      .filter(Boolean)
      .filter(url => /#[^/]/.test(url));   // bare # in path segment
  });

  expect(badPaths).toHaveLength(0);
});

// ── L. Accessibility / CLS / LCP regressions (chrome-devtools-mcp audit) ───
// L49-L54 pin the fixes from tasks/perf-audit-chrome-devtools-mcp.md so they
// can't silently regress. L55-L58 add coverage for adjacent checks from the
// audit tool's own a11y-debugging and debug-optimize-lcp skills that weren't
// previously exercised.

// Fix #2 (superseded): role="listitem" on the .album-item <a> satisfied
// aria-required-children (the container was role="list"), but it also
// replaces the anchor's implicit link role in the accessibility tree —
// which a later chrome-devtools-mcp audit (agent-accessibility-tree) flagged
// as inappropriate. #albums-list is role="group" instead (no required-owned-
// elements constraint), and the cards stay plain, unadorned links.
test('L49: album cards keep their native link role — no role override', async ({ page }) => {
  await gotoWithFixture(page);
  const container = page.locator('#albums-list');
  await expect(container).toHaveAttribute('role', 'group');
  const items = page.locator('.album-item');
  const count = await items.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    await expect(items.nth(i)).not.toHaveAttribute('role');
  }
});

// Fix #5: updateMetaTags() used to write a path-relative URL into og:url and
// <link rel=canonical> (generateAlbumUrl() is relative by design, for
// pushState/anchor hrefs — right there, wrong here).
test('L50: og:url is an absolute URL once an album is selected', async ({ page }) => {
  await gotoWithFixture(page);
  await page.locator('.album-item', { hasText: 'Construção' }).click();
  const content = await page.locator('meta[property="og:url"]').getAttribute('content');
  expect(content).toMatch(/^https?:\/\//);
});

test('L51: <link rel=canonical> is an absolute URL once an album is selected', async ({ page }) => {
  await gotoWithFixture(page);
  await page.locator('.album-item', { hasText: 'Construção' }).click();
  const href = await page.locator('link[rel="canonical"]').getAttribute('href');
  expect(href).toMatch(/^https?:\/\//);
});

// Album pages: script/build-album-pages.js publishes /<acervo>/<slug>/ for every
// album, and the player must name that page as canonical (and share it) so crawlers
// and link previews land on the version with real content and a cover og:image.
test('L60: canonical points at the static album page for a known acervo', async ({ page }) => {
  await gotoWithFixture(page, '/?acervo=uqt');
  await page.locator('.album-item', { hasText: 'Construção' }).click();
  await expect(page.locator('link[rel="canonical"]'))
    .toHaveAttribute('href', 'https://tocador.cc/uqt/1971-chico-buarque-construcao/');
  await expect(page.locator('meta[property="og:url"]'))
    .toHaveAttribute('content', 'https://tocador.cc/uqt/1971-chico-buarque-construcao/');
});

// Records what the page copies instead of granting clipboard permissions, which
// WebKit doesn't offer. navigator.share is removed so the player takes its copy path.
async function stubClipboard(page) {
  await page.addInitScript(() => {
    delete Navigator.prototype.share;
    window.__copied = null;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async t => { window.__copied = t; } },
    });
  });
}

test('L61: share button copies the static album page URL', async ({ page }) => {
  await stubClipboard(page);
  await gotoWithFixture(page, '/?acervo=uqt');
  await page.locator('.album-item', { hasText: 'Construção' }).click();
  await page.locator('#album-header .album-share').click();
  await expect(page.locator('#toast')).toContainText('copiado');
  expect(await page.evaluate(() => window.__copied))
    .toBe('https://tocador.cc/uqt/1971-chico-buarque-construcao/');
});

test('L63: share button names the loaded track with a #tN anchor', async ({ page }) => {
  await stubClipboard(page);
  await gotoWithFixture(page, '/?acervo=uqt');
  await page.locator('.album-item', { hasText: 'Construção' }).click();
  const second = page.locator('#track-list .track-item').nth(1);
  await second.click();
  const num = (await second.locator('.track-num').textContent()).trim();
  await page.locator('#album-header .album-share').click();
  await expect(page.locator('#toast')).toContainText('copiado');
  expect(await page.evaluate(() => window.__copied))
    .toBe(`https://tocador.cc/uqt/1971-chico-buarque-construcao/#t${num}`);
});

// Album pages are the player: /<alias>/<slug>/ is index.html with the album's meta
// and markup baked in (script/build-album-pages.js), and the player keeps that URL
// in the address bar so a copied link unfurls with the cover. They only exist on
// tocador.cc, so these serve one built from the fixture in place of a deployed page.
const { playerTemplate, albumPage } = require('../script/build-album-pages.js');
const fixtureCatalog = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'albums.json'), 'utf8'));
const playerShell = playerTemplate(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'));
async function gotoAlbumPage(page, slug, hash = '') {
  const slugs = globalThis.albumSlugs(fixtureCatalog.albums);
  await page.route(/\/uqt\/[a-z0-9-]+\/(\?.*)?$/, route => {
    const s = new URL(route.request().url()).pathname.split('/')[2];
    const i = slugs.indexOf(s);
    if (i < 0) return route.fulfill({ status: 404, body: 'not found' });
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: albumPage({ template: playerShell, alias: 'uqt', meta: fixtureCatalog.meta || {}, album: fixtureCatalog.albums[i], slug: s }),
    });
  });
  await gotoWithFixture(page, `/uqt/${slug}/${hash}`);
}

test('L64: an album page opens its album and track from the path and #tN', async ({ page }) => {
  await gotoAlbumPage(page, '1971-chico-buarque-construcao', '#t2');
  await expect(page.locator('#album-header h2')).toHaveText('Construção');
  await expect(page.locator('#track-list .track-item.playing .track-num')).toHaveText('2');
  expect(new URL(page.url()).pathname + new URL(page.url()).hash).toBe('/uqt/1971-chico-buarque-construcao/#t2');
  await expect(page.locator('link[rel="canonical"]'))
    .toHaveAttribute('href', 'https://tocador.cc/uqt/1971-chico-buarque-construcao/');
});

test('L65: from an album page, other albums and tracks keep path URLs', async ({ page }) => {
  await gotoAlbumPage(page, '1971-chico-buarque-construcao');
  await page.locator('.album-item', { hasText: 'Clube da Esquina' }).click();
  await expect(page).toHaveURL(/\/uqt\/1972-milton-nascimento-clube-da-esquina\/(#t1)?$/);
  await page.locator('#track-list .track-item').nth(1).click();
  await expect(page).toHaveURL(/\/uqt\/1972-milton-nascimento-clube-da-esquina\/#t2$/);
  await page.goBack();
  await expect(page.locator('#album-header h2')).toHaveText('Construção');
});

test('L66: searching on an album page keeps the album path and track', async ({ page }) => {
  await gotoAlbumPage(page, '1971-chico-buarque-construcao', '#t2');
  await page.fill('#search-input', 'elis');
  await expect(page).toHaveURL(/\/uqt\/1971-chico-buarque-construcao\/\?q=elis#t2$/);
});

test('L67: an unknown album slug says so instead of opening another album', async ({ page }) => {
  await page.route(/\/uqt\/gone\/$/, route => route.fulfill({
    status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: albumPage({ template: playerShell, alias: 'uqt', meta: {}, album: fixtureCatalog.albums[0], slug: 'gone' }),
  }));
  await gotoWithFixture(page, '/uqt/gone/');
  await expect(page.locator('.album-not-found')).toBeVisible();
  await expect(page.locator('#track-list .track-item')).toHaveCount(0);
  expect(new URL(page.url()).search).toBe('?acervo=uqt');
});

test('L62: browse panel links to the loaded acervo album index', async ({ page }) => {
  await gotoWithFixture(page, '/?acervo=homi');
  const link = page.locator('#acervo-index-link');
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', 'https://tocador.cc/homi/');
  await expect(link).toHaveText('Índice de álbuns ↗');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveCSS('text-align', 'right');
});

// Fix #3: --color-text-muted (#7a7268 → #958d83) needed to clear WCAG AA's
// 4.5:1 for small text against both the page background and the lightest
// surface it appears on (per the audit's Lighthouse color-contrast finding).
test('L52: --color-text-muted meets WCAG AA contrast (>=4.5:1) against page background and surfaces', async ({ page }) => {
  await gotoWithFixture(page);
  const ratios = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const hexToRgb = (hex) => {
      const n = parseInt(hex.replace('#', ''), 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    };
    const relLuminance = ([r, g, b]) => {
      const c = [r, g, b].map(v => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const contrast = (hexA, hexB) => {
      const lA = relLuminance(hexToRgb(hexA));
      const lB = relLuminance(hexToRgb(hexB));
      const [lighter, darker] = lA > lB ? [lA, lB] : [lB, lA];
      return (lighter + 0.05) / (darker + 0.05);
    };
    const muted = style.getPropertyValue('--color-text-muted').trim();
    const bg = style.getPropertyValue('--color-bg').trim();
    const surfaceLight = style.getPropertyValue('--color-surface-light').trim();
    return {
      vsBg: contrast(muted, bg),
      vsSurfaceLight: contrast(muted, surfaceLight),
    };
  });
  expect(ratios.vsBg).toBeGreaterThanOrEqual(4.5);
  expect(ratios.vsSurfaceLight).toBeGreaterThanOrEqual(4.5);
});

// Fix #1: font-display swap → optional. `swap` reflows the header stats line
// when the webfont lands (the CLS cluster the audit's trace flagged);
// `optional` commits to the fallback for that page view instead.
test('L53: Google Fonts stylesheet uses display=optional, never display=swap', async ({ page }) => {
  await gotoWithFixture(page);
  const href = await page.locator('link[href*="fonts.googleapis.com/css2"]').first().getAttribute('href');
  expect(href).toContain('display=optional');
  expect(href).not.toContain('display=swap');
});

// Unrelated fix made in passing during the same audit session.
test('L54: uqt acervo option reads "UmQueTenha", not "UQT"', async ({ page }) => {
  await gotoWithFixture(page);
  const label = await page.locator('#acervo-select option[value="uqt"]').textContent();
  expect(label).toBe('UmQueTenha');
});

// debug-optimize-lcp skill: "never lazy-load LCP" — the first paint's album
// covers are exactly the kind of above-the-fold content that principle
// targets, so the virtual grid must not opt them into loading="lazy".
test('L55: album grid cover thumbnails are not lazy-loaded', async ({ page }) => {
  await gotoWithFixture(page);
  const loadingAttr = await page.locator('.album-cover-thumb').first().getAttribute('loading');
  expect(loadingAttr).not.toBe('lazy');
});

// a11y-debugging skill: "images have alt text" — grid thumbs are aria-hidden
// (the parent <a> carries the real accessible name) but must still carry alt
// so the same markup is safe if that aria-hidden is ever dropped.
test('L56: every rendered album cover thumbnail has non-empty alt text', async ({ page }) => {
  await gotoWithFixture(page);
  const alts = await page.locator('.album-cover-thumb').evaluateAll(
    imgs => imgs.map(img => img.getAttribute('alt'))
  );
  expect(alts.length).toBeGreaterThan(0);
  for (const alt of alts) expect(alt).toBeTruthy();
});

// a11y-debugging skill: "form inputs have associated labels" — search-input
// carries both a visible-to-AT <label for> and an aria-label; keep them from
// drifting apart silently.
test('L57: search input has an associated <label> matching its aria-label', async ({ page }) => {
  await gotoWithFixture(page);
  const input = page.locator('#search-input');
  const ariaLabel = await input.getAttribute('aria-label');
  const label = page.locator('label[for="search-input"]');
  await expect(label).toHaveCount(1);
  expect((await label.textContent())?.trim()).toBe(ariaLabel);
});

// a11y-debugging skill: "test Tab/keyboard navigation" — grid cards bind a
// keydown handler that synthesizes a click on Enter/Space; confirm Enter
// alone (no mouse) actually selects the album.
test('L58: Enter key on a focused album-item selects that album', async ({ page }) => {
  await gotoWithFixture(page);
  await page.locator('.album-item', { hasText: 'Clube da Esquina' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#album-header h2')).toContainText('Clube da Esquina');
});

// memory-leak-debugging skill: "repeat interactions ~10 times to amplify leak
// visibility" — the recycled-node pool is exactly the kind of cache that
// skill flags; assert its own advertised cap actually holds under repeated
// scrolling, not just that on-screen DOM count looks fine once (H33).
test('L59: recycled node pool stays within its cap after repeated scroll cycles', async ({ page }) => {
  await gotoWithFixture(page);
  const result = await page.evaluate(async () => {
    const el = document.getElementById('albums-list');
    const maxHeight = el.scrollHeight;
    for (let i = 0; i < 10; i++) {
      el.scrollTop = i % 2 === 0 ? maxHeight : 0;
      virtualGrid._render();
    }
    return {
      poolLength: virtualGrid._pool.length,
      poolCap: virtualGrid._poolCap,
      nodeCount: virtualGrid._nodes.size,
      domCount: document.querySelectorAll('.album-item').length,
    };
  });
  expect(result.poolLength).toBeLessThanOrEqual(result.poolCap);
  expect(result.nodeCount).toBe(result.domCount);
});

// O atlas abre em outra aba para não interromper o áudio do player.
test('L69: the atlas link opens in a new tab', async ({ page }) => {
  await gotoWithFixture(page, '/?acervo=uqt');
  const link = page.locator('#btn-atlas');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener');
});

// À direita do coração: leva ao ponto do álbum no atlas, em outra aba para o áudio seguir.
test('L70: the album atlas button sits right of the heart and targets the album dot', async ({ page }) => {
  await gotoWithFixture(page, '/?acervo=uqt');
  await page.locator('.album-item', { hasText: 'Construção' }).click();
  const botoes = page.locator('#album-header .album-actions > *');
  await expect(botoes).toHaveCount(3);
  await expect(botoes.nth(1)).toHaveClass(/album-like/);
  const link = botoes.nth(2);
  await expect(link).toHaveClass(/album-atlas/);
  await expect(link).toHaveAttribute('target', '_blank');
  const url = new URL(await link.getAttribute('href'), page.url());
  expect(url.pathname).toMatch(/atlas\.html$/);
  expect(url.searchParams.get('de')).toBe('uqt');
  expect(url.searchParams.get('album')).toContain('Construção');
});

// Coração com play: toca os salvos deste acervo, um álbum depois do outro.
test('L72: the heart-play button plays the saved albums in a row and stops at the end', async ({ page }) => {
  await gotoWithFixture(page, '/?acervo=uqt');
  const btn = page.locator('#btn-play-saved');
  await btn.click();
  await expect(page.locator('#toast')).toContainText('Nenhum álbum salvo');
  await expect(btn).toHaveAttribute('aria-pressed', 'false');

  for (const nome of ['Construção', 'Pixinguinha']) {
    await page.locator('.album-item', { hasText: nome }).click();
    await page.locator('#album-header .album-like').click();
  }
  await page.locator('.album-item', { hasText: 'Luiz Gonzaga' }).click();
  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  // O mais recente primeiro: Pixinguinha tem uma faixa só, então a próxima já é de Construção.
  await expect(page.locator('#album-header h2')).toHaveText('Acervo Raro');
  await page.evaluate(() => playNext());
  await expect(page.locator('#album-header h2')).toHaveText('Construção');
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => { playNext(); playNext(); playNext(); });
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
});

test('L73: opening an album outside the saved queue leaves the mode', async ({ page }) => {
  await gotoWithFixture(page, '/?acervo=uqt');
  await page.locator('.album-item', { hasText: 'Pixinguinha' }).click();
  await page.locator('#album-header .album-like').click();
  await page.locator('#btn-play-saved').click();
  await page.locator('.album-item', { hasText: 'Luiz Gonzaga' }).click();
  await page.evaluate(() => playNext());
  await expect(page.locator('#btn-play-saved')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#album-header h2')).toHaveText('Saudade do Nordeste');
});

test('L74: the artist filter offers a link to the artist page', async ({ page }) => {
  await stubClipboard(page);
  await gotoWithFixture(page, '/?acervo=uqt&artista=Elis%20Regina');
  await page.locator('#share-artist').click();
  await expect(page.locator('#toast')).toContainText('copiado');
  expect(await page.evaluate(() => window.__copied)).toBe('https://tocador.cc/uqt/artista/elis-regina/');
  await page.locator('#clear-all-filters').click();
  await expect(page.locator('#share-artist')).toBeHidden();
});

test('L75: artist pages carry the preview and send people to the filter', () => {
  const { artistPage, catalogArtists } = require('../script/build-album-pages.js');
  const albums = JSON.parse(require('zlib').gunzipSync(fixtureGz)).albums;
  const artists = catalogArtists(albums);
  const elis = artists.find(a => a.name === 'Elis Regina');
  expect([...elis.albums].map(a => a.title).sort()).toEqual(['Elis & Tom', 'Falso Brilhante']);
  expect(new Set(artists.map(a => a.slug)).size).toBe(artists.length);
  const html = artistPage({ alias: 'uqt', meta: { base_url: 'https://cdn.tocador.cc/uqt' }, artist: elis });
  expect(html).toContain('<link rel="canonical" href="https://tocador.cc/uqt/artista/elis-regina/">');
  expect(html).toContain('og:image');
  expect(html).toContain('noindex');
  expect(html).toContain('location.replace("https://tocador.cc/?acervo=uqt&artista=Elis+Regina")');
});

// O acervo ativo depende da aba: salvos do outro não podem parecer perdidos.
test('L71: the saved tab also lists albums saved in the other acervo and opens them in a new tab', async ({ page, context }) => {
  await gotoWithFixture(page, '/?acervo=uqt');
  await page.evaluate(() => localStorage.setItem('tocador-salvos', JSON.stringify({
    homi: [{ path: '2019 - Banda - Disco', name: 'Disco', artists: 'Banda', year: 2019, em: 1 }],
  })));
  await page.reload();
  await expect(page.locator('.album-item').first()).toBeVisible();
  await page.locator('.browse-tab[data-tab="saved"]').click();
  const item = page.locator('#browse-list .browse-item');
  await expect(item).toHaveCount(1);
  await expect(item.locator('.browse-name')).toHaveText('Disco');
  await expect(item.locator('.browse-sub')).toHaveText('Banda');
  await expect(item).toContainText('homi');
  const [aba] = await Promise.all([context.waitForEvent('page'), item.click()]);
  const url = new URL(aba.url());
  expect(url.searchParams.get('acervo')).toBe('homi');
  expect(url.searchParams.get('album')).toBe('2019 - Banda - Disco');
  await aba.close();
  await expect(page.locator('.browse-tab[data-tab="saved"]')).toHaveAttribute('title', 'Álbuns salvos (1)');
});

// Coração: salva o álbum no localStorage (por acervo) e a aba de salvos o lista;
// clicar num salvo reabre o álbum mesmo com o grid filtrado em outra coisa.
test.describe(() => {
  // A segunda navegação passaria pelo service worker, que ignora page.route.
  test.use({ serviceWorkers: 'block' });
  test('L68: heart saves the album and the saved tab lists and reopens it', async ({ page }) => {
    await gotoWithFixture(page, '/?acervo=uqt');
    await page.evaluate(() => localStorage.removeItem('tocador-salvos'));
    await page.locator('.album-item', { hasText: 'Construção' }).click();
    const like = page.locator('#album-header .album-like');
    await expect(like).toHaveAttribute('aria-pressed', 'false');
    await like.click();
    await expect(like).toHaveAttribute('aria-pressed', 'true');
    // Confirmação em amarelo; um toast de erro depois dela volta ao vermelho.
    const toast = page.locator('#toast');
    await expect(toast).toHaveText('Álbum salvo');
    await expect(toast).toHaveCSS('color', 'rgb(255, 216, 77)');
    await page.evaluate(() => showToast('erro'));
    await expect(toast).toHaveCSS('color', 'rgb(255, 112, 112)');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('tocador-salvos')));
    expect(saved.uqt.map(s => s.path)).toEqual([expect.stringContaining('Construção')]);

    await page.locator('.browse-tab[data-tab="saved"]').click();
    const item = page.locator('#browse-list .browse-item');
    await expect(item).toHaveCount(1);
    await expect(item).toContainText('Construção');

    await page.locator('.album-item').filter({ hasNotText: 'Construção' }).first().click();
    await expect(page.locator('#album-header h2')).not.toContainText('Construção');
    await item.click();
    await expect(page.locator('#album-header h2')).toContainText('Construção');

    // Persiste ao recarregar; desmarcar esvazia a lista.
    await page.goto('/?acervo=uqt');
    await expect(page.locator('.album-item').first()).toBeVisible();
    await page.locator('.browse-tab[data-tab="saved"]').click();
    await expect(page.locator('#browse-list .browse-item')).toHaveCount(1);
    await page.locator('#browse-list .browse-item').click();
    await page.locator('#album-header .album-like').click();
    await expect(page.locator('#browse-list .browse-item')).toHaveCount(0);
    await expect(page.locator('#browse-empty')).toBeVisible();
  });
});

// Mini-capa nas linhas do painel de navegação (artistas e salvos): tamanho fixo, placeholder sem request extra.
test.describe('mini-capa na lista de navegação', () => {
  test.use({ serviceWorkers: 'block' });
  test('artistas: cada linha tem mini-capa de tamanho fixo e a lista segue virtualizada', async ({ page }) => {
    await gotoWithFixture(page, '/?acervo=uqt');
    await page.evaluate(() => localStorage.removeItem('tocador-browse-collapsed'));
    await page.reload();
    await page.waitForSelector('#browse-list .browse-item');
    const thumbs = page.locator('#browse-list .browse-item .browse-thumb');
    expect(await thumbs.count()).toBeGreaterThan(0);
    expect(await page.locator('#browse-list .browse-item').count()).toBeLessThan(40);
    const box = await thumbs.first().boundingBox();
    expect(box.width).toBe(32); expect(box.height).toBe(32);
    // Capa 404: cai no placeholder SVG embutido (data-URI, sem novo request).
    await expect(thumbs.first()).toHaveClass(/placeholder/);
    await expect(thumbs.first()).toHaveAttribute('src', /^data:image\/svg\+xml/);
    // Teclado/ARIA continuam: botão com role option, sem o ícone no nome acessível.
    const item = page.locator('#browse-list .browse-item').first();
    await expect(item).toHaveAttribute('role', 'option');
    await expect(item.locator('.browse-thumb')).toHaveAttribute('aria-hidden', 'true');
  });

  test('pede a capa de 96 px e, se ela faltar, usa a capa-min', async ({ page }) => {
    const pedidas = [];
    page.on('request', r => { if (/capa-m\w+\.jpg/.test(r.url()) && r.resourceType() === 'image') pedidas.push(r.url()); });
    await gotoWithFixture(page, '/?acervo=uqt');
    await page.waitForSelector('#browse-list .browse-item');
    await expect.poll(() => pedidas.some(u => u.endsWith('capa-micro.jpg'))).toBe(true);
    const micro = pedidas.find(u => u.endsWith('capa-micro.jpg'));
    await expect.poll(() => pedidas.includes(micro.replace('capa-micro', 'capa-min'))).toBe(true);
  });

  test('salvos: título e artista em duas linhas, capa vinda do catálogo e placeholder para quem não tem', async ({ page }) => {
    await gotoWithFixture(page, '/?acervo=uqt');
    await page.evaluate(() => localStorage.setItem('tocador-salvos', JSON.stringify({
      homi: [{ path: '2019 - Banda - Disco', name: 'Disco', artists: 'Banda', year: 2019, em: 1 }],
    })));
    await page.reload();
    await page.locator('.browse-tab[data-tab="saved"]').click();
    const item = page.locator('#browse-list .browse-item');
    await expect(item).toHaveCount(1);
    await expect(item.locator('.browse-name')).toHaveText('Disco');
    await expect(item.locator('.browse-sub')).toHaveText('Banda');
    await expect(item.locator('.browse-thumb')).toHaveAttribute('src', /^data:image\/svg\+xml/);
  });

  test('salvos de outro acervo já aberto aqui mostram a mini capa, pela base lembrada daquele acervo', async ({ page }) => {
    await gotoWithFixture(page, '/?acervo=uqt');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('tocador-acervo-bases')).uqt)).toMatch(/^https:\/\//);
    await page.evaluate(() => {
      localStorage.setItem('tocador-acervo-bases', JSON.stringify({ homi: 'https://cdn.tocador.cc/indie' }));
      localStorage.setItem('tocador-salvos', JSON.stringify({
        homi: [{ path: '2019 - Banda - Disco Ç', name: 'Disco Ç', artists: 'Banda', year: 2019, em: 1 },
               { path: '2020 - Banda - Sem Capa', name: 'Sem Capa', artists: 'Banda', year: 2020, capa: 0, em: 2 }],
      }));
    });
    await page.route(/capa-m(in|icro)\.jpg$/, r => r.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64') }));
    await page.reload();
    await page.locator('.browse-tab[data-tab="saved"]').click();
    const item = page.locator('#browse-list .browse-item');
    await expect(item).toHaveCount(2);
    await expect(item.filter({ hasText: 'Disco Ç' }).locator('.browse-thumb'))
      .toHaveAttribute('src', `https://cdn.tocador.cc/indie/${encodeURIComponent('2019 - Banda - Disco Ç')}/capa-micro.jpg`);
    await expect(item.filter({ hasText: 'Sem Capa' }).locator('.browse-thumb')).toHaveAttribute('src', /^data:image\/svg\+xml/);
  });
});

// Playlist compartilhada: o link mostra os álbuns de quem enviou sem mexer nos salvos de quem abre.
test.describe('shared playlist link', () => {
  test.use({ serviceWorkers: 'block' });

  const ORDEM = ['Pixinguinha', 'Construção', 'Luiz Gonzaga'];   // de propósito fora da ordem do grid (ano)
  const idsDe = (page, nomes) => page.evaluate(ns =>
    ns.map(n => albumShareId(albums.find(a => a.path.includes(n) || a.artists.includes(n)).path)), nomes);
  const grid = page => page.locator('.album-item').evaluateAll(els => els
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top
      || a.getBoundingClientRect().left - b.getBoundingClientRect().left)
    .map(e => e.textContent));
  const listaUrl = async (page, nomes) => `/?acervo=uqt&lista=${(await idsDe(page, nomes)).join('')}`;

  test('the button copies a /share-playlist link with five characters per album', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'share', { value: undefined });
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: t => { window.__copiado = t; return Promise.resolve(); } } });
      localStorage.removeItem('tocador-salvos');
    });
    await gotoWithFixture(page, '/?acervo=uqt');
    const btn = page.locator('#share-saved');
    await expect(btn).toBeHidden();
    await page.locator('.browse-tab[data-tab="saved"]').click();
    await expect(btn).toBeHidden();   // aba de salvos vazia
    await page.locator('.browse-tab[data-tab="artists"]').click();

    for (const nome of ['Construção', 'Pixinguinha']) {
      await page.locator('.album-item', { hasText: nome }).click();
      await page.locator('#album-header .album-like').click();
    }
    await page.locator('.browse-tab[data-tab="saved"]').click();
    await expect(btn).toBeVisible();
    await expect(btn).toHaveText('Compartilhar 2 álbuns');
    await btn.click();
    await expect(page.locator('#toast')).toHaveText('Link da playlist copiado');
    const url = new URL(await page.evaluate(() => window.__copiado));
    expect(url.origin + url.pathname).toBe('https://tocador.cc/share-playlist');
    expect(url.searchParams.get('acervo')).toBe('uqt');
    // O mais recente primeiro, a ordem da lista de salvos.
    expect(url.searchParams.get('lista')).toBe((await idsDe(page, ['Pixinguinha', 'Construção'])).join(''));

    // Fora da aba de salvos, inclusive na de gêneros, o botão some.
    await page.locator('.browse-tab[data-tab="artists"]').click();
    await expect(btn).toBeHidden();
  });

  test('the share button leaves saved albums of another acervo out and says so', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'share', { value: undefined });
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.resolve() } });
    });
    await gotoWithFixture(page, '/?acervo=uqt');
    await page.evaluate(() => localStorage.setItem('tocador-salvos', JSON.stringify({
      uqt: [{ path: albums[0].path, name: 'A', artists: 'B', year: 2000, em: 1 }],
      homi: [{ path: '2019 - Banda - Disco', name: 'Disco', artists: 'Banda', year: 2019, em: 1 }],
    })));
    await page.reload();
    await expect(page.locator('.album-item').first()).toBeVisible();
    await page.locator('.browse-tab[data-tab="saved"]').click();
    const btn = page.locator('#share-saved');
    await expect(btn).toHaveText('Compartilhar 1 álbum');
    await expect(btn).toHaveAttribute('title', /de outro acervo ficam de fora/);
    await btn.click();
    await expect(page.locator('#toast')).toHaveText('Link copiado, sem o salvo de outro acervo');
  });

  test('/share-playlist has a preview for bots and forwards to the player in link order', async ({ page }) => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'share-playlist.html'), 'utf8');
    expect(html).toContain('property="og:title"');
    expect(html).toContain('property="og:description"');
    expect(html).toMatch(/property="og:image" content="[^"]+\.jpg"/);
    expect(html).toContain('name="robots" content="noindex"');
    expect(html).not.toContain('property="og:url"');   // levaria a rede para uma URL sem a lista

    await gotoWithFixture(page, '/?acervo=uqt');
    const url = await listaUrl(page, ORDEM);
    await page.goto(url.replace('/?', '/share-playlist?'));
    await expect(page).toHaveURL(/\/\?acervo=uqt&lista=/);
    await expect(page.locator('.album-item')).toHaveCount(3);
    const textos = await grid(page);
    ORDEM.forEach((nome, i) => expect(textos[i]).toContain(nome));
    await expect(page.locator('#clear-all-label')).toHaveText('Playlist (3)');
    await expect(page.locator('#album-header')).toContainText('Acervo Raro');   // o primeiro do link abre
  });

  test('opening a link leaves the receiver saved albums byte-identical', async ({ page }) => {
    await gotoWithFixture(page, '/?acervo=uqt');
    const salvos = JSON.stringify({ uqt: [{ path: await page.evaluate(() => albums.at(-1).path), name: 'Meu', artists: 'Eu', year: 1, em: 1 }] });
    await page.evaluate(s => localStorage.setItem('tocador-salvos', s), salvos);
    await page.goto(await listaUrl(page, ORDEM));
    await expect(page.locator('.album-item')).toHaveCount(3);
    await page.locator('.album-item', { hasText: 'Construção' }).click();
    await page.locator('#clear-all-filters').click();
    await page.reload();
    await expect(page.locator('.album-item').first()).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('tocador-salvos'))).toBe(salvos);
  });

  test('the chip and the other facets end the list and drop it from the URL', async ({ page }) => {
    await gotoWithFixture(page, '/?acervo=uqt');
    const url = await listaUrl(page, ORDEM);
    await page.goto(url);
    await expect(page.locator('.album-item')).toHaveCount(3);
    await page.locator('#clear-all-filters').click();
    await expect(page.locator('.album-item').nth(3)).toBeVisible();
    expect(page.url()).not.toContain('lista=');

    await page.goto(url);
    await expect(page.locator('.album-item')).toHaveCount(3);
    await page.evaluate(() => { resetFacets('artist'); activeArtist = 'Elis Regina'; updateBrowseFilterInUrl(); filterAlbums(); });
    await expect(page.locator('#clear-all-label')).toHaveText('Elis Regina');
    expect(page.url()).not.toContain('lista=');
    await expect(page.locator('.album-item')).toHaveCount(2);
  });

  test('unknown ids are reported and a useless list leaves the grid alone', async ({ page }) => {
    await gotoWithFixture(page, '/?acervo=uqt');
    const [id] = await idsDe(page, ['Construção']);
    await page.goto(`/?acervo=uqt&lista=${id}00000`);
    await expect(page.locator('.album-item')).toHaveCount(1);
    await expect(page.locator('#toast')).toHaveText('1 álbum não está mais no acervo');

    for (const lista of ['00000', 'abc', '<img src=x onerror=alert(1)>']) {
      await page.goto(`/?acervo=uqt&lista=${encodeURIComponent(lista)}`);
      await expect(page.locator('.album-item').nth(3)).toBeVisible();
      await expect(page.locator('#toast')).toHaveText('Nenhum álbum deste link está neste acervo');
      expect(page.url()).not.toContain('lista=');
    }
  });

  test('opening an album and reloading keeps the list', async ({ page }) => {
    await gotoWithFixture(page, '/?acervo=uqt');
    await page.goto(await listaUrl(page, ORDEM));
    await expect(page.locator('.album-item')).toHaveCount(3);
    await page.locator('.album-item', { hasText: 'Construção' }).click();
    expect(page.url()).toContain('lista=');
    await page.reload();
    await expect(page.locator('.album-item')).toHaveCount(3);
    await expect(page.locator('#album-header')).toContainText('Construção');
  });

  test('going back to a link restores the list', async ({ page }) => {
    await gotoWithFixture(page, '/?acervo=uqt');
    await page.goto(await listaUrl(page, ORDEM));
    await expect(page.locator('.album-item')).toHaveCount(3);
    await page.locator('.album-item', { hasText: 'Construção' }).click();
    await page.locator('#clear-all-filters').click();
    await expect(page.locator('.album-item').nth(3)).toBeVisible();
    await page.goBack();
    await expect(page.locator('.album-item')).toHaveCount(3);
  });
});
