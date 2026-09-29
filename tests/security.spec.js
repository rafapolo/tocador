const { test, expect } = require('@playwright/test');
const zlib = require('zlib');

// Third-party catalogs (?acervo=<url>) are untrusted: markup in album, artist or
// track text must render as text, never execute.
const evil = '<img src=x onerror="window.__pwned=1">';
const catalog = {
  meta: { title: 'x', base_url: 'https://cdn.tocador.cc/x' },
  albums: [{
    title: `Album ${evil}`, artist: `Artist ${evil}`, year: 1999,
    path: '1999 - a - b', has_cover: false,
    tracks: [{ title: `Track ${evil}`, num: 1, file: '01.mp3', artists: `Guest ${evil}`, duration: 10 }],
  }],
};

async function openEvil(page, cat) {
  await page.route('**/evil.json.gz', route => route.fulfill({
    status: 200,
    headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' },
    body: zlib.gzipSync(JSON.stringify(cat)),
  }));
  await page.goto('/?acervo=' + encodeURIComponent('http://localhost:3456/evil.json.gz'));
}

test('S1: markup in catalog text is rendered as text, not executed', async ({ page }) => {
  await openEvil(page, catalog);
  await page.waitForSelector('.album-item');
  await page.locator('.album-item').first().click();
  await page.waitForSelector('#track-list .track-item');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  await expect(page.locator('#album-header img[src="x"], #track-list img[src="x"]')).toHaveCount(0);
  await expect(page.locator('#album-header h2')).toContainText('<img');
  await expect(page.locator('#track-list .track-title')).toContainText('<img');
});

test('S2: a catalog from a newer payload version says so instead of an empty grid', async ({ page }) => {
  // Marks the reload guard as spent so the test sees the final message, not the reload.
  await page.addInitScript(() => sessionStorage.setItem('tocador-stale-reload', '1'));
  await openEvil(page, { ...catalog, v: 3 });
  await expect(page.locator('.album-not-found')).toContainText('formato mais novo');
});
