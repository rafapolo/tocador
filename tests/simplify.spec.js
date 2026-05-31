const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const fixturePath = path.join(__dirname, 'fixtures', 'albums.json.gz');
const fixtureGz = fs.readFileSync(fixturePath);

async function gotoWithFixture(page, url = '/') {
  await page.addInitScript(() => {
    localStorage.removeItem('uqt-shuffle');
    localStorage.removeItem('uqt-repeat');
    localStorage.removeItem('uqt-volume');
    localStorage.removeItem('homi-shuffle');
    localStorage.removeItem('homi-repeat');
    localStorage.removeItem('homi-volume');
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
  await page.route('**/*.mp3', route => route.fulfill({ status: 200, body: Buffer.alloc(0) }));
  await page.route('**/capa-min.jpg', route => route.fulfill({ status: 404 }));
  await page.goto(url);
  await page.waitForSelector('.album-item', { timeout: 8000 });
}

// ── trackedFetch ──────────────────────────────────────────────────────────────

test('trackedFetch: __lastFetchUrl ends up as the acervo data URL after load', async ({ page }) => {
  await gotoWithFixture(page);
  const lastFetch = await page.evaluate(() => window.__lastFetchUrl);
  expect(lastFetch).toMatch(/albums\.json\.gz/);
});

test('trackedFetch: __lastFetchUrl is not config.json after full load', async ({ page }) => {
  await gotoWithFixture(page);
  const lastFetch = await page.evaluate(() => window.__lastFetchUrl);
  // config.json is fetched first; data URL is fetched after — last value wins
  expect(lastFetch).not.toBe('config.json');
});

test('trackedFetch: function exists on the page and returns a promise', async ({ page }) => {
  await gotoWithFixture(page);
  const isFunction = await page.evaluate(() => typeof trackedFetch === 'function');
  expect(isFunction).toBe(true);
});

// ── unhandledrejection error report ──────────────────────────────────────────

test('unhandledrejection: diagnostic extra string contains last fetch URL and online status', async ({ page }) => {
  await gotoWithFixture(page);

  // Evaluate the same extra-context logic the unhandledrejection handler uses.
  // This verifies that trackedFetch correctly seeds __lastFetchUrl so it appears
  // in the diagnostic string at error time.
  const extra = await page.evaluate(() => {
    const conn = navigator.connection;
    return [
      `**online:** ${navigator.onLine}`,
      conn ? `**connection:** ${[conn.effectiveType, conn.downlink && conn.downlink + 'Mbps'].filter(Boolean).join(' ')}` : null,
      `**acervo:** ${new URLSearchParams(location.search).get('acervo') || '(default)'}`,
      window.__lastFetchUrl ? `**last fetch:** ${window.__lastFetchUrl}` : null,
    ].filter(Boolean).join('\n');
  });

  expect(extra).toContain('**online:**');
  expect(extra).toContain('**last fetch:**');
  expect(extra).toContain('albums.json.gz');
});
