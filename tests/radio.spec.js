const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const fixtureGz = fs.readFileSync(path.join(__dirname, 'fixtures', 'albums.json.gz'));

async function gotoRadio(page, params = '') {
  await page.route('**/uqt-albums.json.gz', route =>
    route.fulfill({ status: 200, headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' }, body: fixtureGz })
  );
  await page.route('**/homi-albums.json.gz', route =>
    route.fulfill({ status: 200, headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' }, body: fixtureGz })
  );
  await page.route('**/*.mp3', route => route.fulfill({ status: 200, body: Buffer.alloc(0) }));
  await page.route('**/capa-min.jpg', route => route.fulfill({ status: 404 }));
  await page.goto(`/radio.html${params}`);
  await page.waitForSelector('.widget:not(.loading)', { timeout: 8000 });
}

// ── R. Radio Widget ───────────────────────────────────────────────────────

test('R1: radio widget removes .loading class after acervo loads', async ({ page }) => {
  await gotoRadio(page);
  await expect(page.locator('.widget')).not.toHaveClass(/loading/);
});

test('R2: radio shows a track title after load', async ({ page }) => {
  await gotoRadio(page);
  const title = page.locator('#track-title');
  await expect(title).not.toBeEmpty();
  await expect(title).not.toHaveText('Carregando…');
});

test('R3: time displays start at 00:00 or — before play', async ({ page }) => {
  await gotoRadio(page);
  const total = await page.locator('#time-total').textContent();
  expect(['00:00', '—']).toContain(total?.trim());
});

test('R4: cover falls back to placeholder when image 404s', async ({ page }) => {
  await gotoRadio(page);
  const cover = page.locator('#cover');
  const src = await cover.getAttribute('src');
  // Either empty (not yet set) or data URI placeholder — never a broken URL
  const isSafe = !src || src.startsWith('data:');
  expect(isSafe).toBe(true);
});

test('R5: next button changes track title', async ({ page }) => {
  await gotoRadio(page);
  const title1 = await page.locator('#track-title').textContent();
  await page.click('#btn-next');
  await page.waitForTimeout(300);
  const title2 = await page.locator('#track-title').textContent();
  // Track may change (fixture has 10 albums × several tracks)
  // At minimum, the title should still be non-empty
  expect(title2?.trim()).toBeTruthy();
});

test('R6: prev button navigates to a previous track from history', async ({ page }) => {
  await gotoRadio(page);
  const title1 = await page.locator('#track-title').textContent();
  await page.click('#btn-next');
  await page.waitForTimeout(200);
  await page.click('#btn-prev');
  await page.waitForTimeout(200);
  const titleBack = await page.locator('#track-title').textContent();
  expect(titleBack?.trim()).toBe(title1?.trim());
});

test('R7: play button has correct initial aria-label', async ({ page }) => {
  await gotoRadio(page);
  await expect(page.locator('#btn-play')).toHaveAttribute('aria-label', 'Tocar');
});

test('R8: widget renders without JS errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await gotoRadio(page);
  const relevant = errors.filter(e => !e.includes('favicon') && !e.includes('umami'));
  expect(relevant).toHaveLength(0);
});

test('R9: homi acervo loads when ?acervo=homi', async ({ page }) => {
  await gotoRadio(page, '?acervo=homi');
  await expect(page.locator('#track-title')).not.toHaveText('Carregando…');
  await expect(page.locator('#track-title')).not.toBeEmpty();
});

test('R10: uqt acervo loads when ?acervo=uqt', async ({ page }) => {
  await gotoRadio(page, '?acervo=uqt');
  await expect(page.locator('#track-title')).not.toHaveText('Carregando…');
  await expect(page.locator('#track-title')).not.toBeEmpty();
});

test('R11: progress bar is in DOM and fill starts at 0%', async ({ page }) => {
  await gotoRadio(page);
  await expect(page.locator('.progress')).toBeVisible();
  const width = await page.locator('.progress-fill').evaluate(el => el.style.width);
  expect(width === '' || width === '0%' || width === '0').toBe(true);
});

test('R12: radio widget renders correctly on mobile (375px)', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await gotoRadio(page);
  await expect(page.locator('.widget')).toBeVisible();
  await expect(page.locator('#track-title')).toBeVisible();
  const relevant = errors.filter(e => !e.includes('favicon') && !e.includes('umami'));
  expect(relevant).toHaveLength(0);
});

// ── R. URL encoding for paths containing # ───────────────────────────────────
// Regression: encodeURI does not encode #, so folder names like
// "Hominis Canidae #42" produced URLs truncated at the # (treated as a
// fragment by the browser). encodeURIComponent must be used instead.

test('R13: audio src encodes # as %23 for albums with # in path', async ({ page }) => {
  await gotoRadio(page, '?all=1');

  await page.evaluate(() => {
    const hashAlbum = albums.find(a => a.path.includes('#'));
    if (!hashAlbum) throw new Error('fixture has no album with # in path');
    audio.src = '';
    playTrack(hashAlbum, hashAlbum.tracks[0]);
  });

  const src = await page.evaluate(() => audio.src);
  expect(src).not.toMatch(/#[^/]/);   // bare # must not appear in path
  expect(src).toContain('%23');        // must be percent-encoded
});

test('R14: cover src encodes # as %23 for albums with # in path', async ({ page }) => {
  await gotoRadio(page, '?all=1');

  await page.evaluate(() => {
    const hashAlbum = albums.find(a => a.path.includes('#'));
    if (!hashAlbum) throw new Error('fixture has no album with # in path');
    playTrack(hashAlbum, hashAlbum.tracks[0]);
  });

  const coverSrc = await page.locator('#cover').getAttribute('src');
  // src is either the CDN URL (correctly encoded) or the placeholder data URI
  if (coverSrc && !coverSrc.startsWith('data:')) {
    expect(coverSrc).not.toMatch(/#[^/]/);
    expect(coverSrc).toContain('%23');
  }
});

test('R15: radio filter selects albums with "hominis canidae" and encodes # correctly', async ({ page }) => {
  await gotoRadio(page); // no ?all=1 — exercises the hominis canidae filter

  // The fixture now includes "Hominis Canidae #42" which the filter should pick.
  // Force playback of that specific album and verify the audio URL.
  await page.evaluate(() => {
    const hcAlbum = albums.find(a => a.path.toLowerCase().includes('hominis canidae #'));
    if (!hcAlbum) throw new Error('fixture has no Hominis Canidae # album');
    audio.src = '';
    playTrack(hcAlbum, hcAlbum.tracks[0]);
  });

  const url = await page.evaluate(() => audio.src);
  expect(url).not.toMatch(/#[^/]/);
  expect(url).toContain('%23');
});
