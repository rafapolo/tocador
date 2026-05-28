const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const CDN = 'https://cdn.tocador.cc';

// All domains that host the player — audio requests from these must not 403
const PLAYER_ORIGINS = [
  'https://rafapolo.github.io',
  'https://tocador.cc',
  'https://cdn.tocador.cc',
  'https://radio.tocador.cc',
];
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PLAYER_REFERER = 'https://rafapolo.github.io/';

const COVER = 'indie/2026 - Barulhista - música para dançar sentado/capa-min.jpg';

const TRACKS = [
  'indie/2026 - Barulhista - música para dançar sentado/Barulhista - debaixo de um corpo que caiu do rooftop.mp3',
  'indie/2026 - Barulhista - música para dançar sentado/Barulhista - debaixo do sol.mp3',
  'indie/2026 - Cobra de Coleira - Cárcere Cognitivo/02. Fobia Social.mp3',
];

// ── Hotlink origin allowlist ──────────────────────────────────────────────────

for (const origin of PLAYER_ORIGINS) {
  test(`CDN: audio allowed from ${origin}`, async ({ request }) => {
    const res = await request.head(`${CDN}/${encodeURI(TRACKS[0])}`, {
      headers: { 'User-Agent': BROWSER_UA, 'Referer': `${origin}/` },
    });
    expect(res.status()).toBe(200);
  });
}

// ── CDN HEAD checks ───────────────────────────────────────────────────────────

test('CDN: cover image returns 200 with image/jpeg', async ({ request }) => {
  const res = await request.head(`${CDN}/${encodeURI(COVER)}`, {
    headers: { 'User-Agent': BROWSER_UA },
  });
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('image/jpeg');
});

for (const track of TRACKS) {
  test(`CDN: audio ${track.split('/').pop()}`, async ({ request }) => {
    const res = await request.head(`${CDN}/${encodeURI(track)}`, {
      headers: { 'User-Agent': BROWSER_UA, 'Referer': PLAYER_REFERER },
    });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('audio/mpeg');
    expect(Number(res.headers()['content-length'])).toBeGreaterThan(0);
  });
}

// ── Browser play test ─────────────────────────────────────────────────────────

const fixtureGz = fs.readFileSync(path.join(__dirname, 'fixtures', 'albums.json.gz'));

test('CDN: player builds valid audio URL and CDN serves it', async ({ page, request }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.addInitScript(() => {
    localStorage.removeItem('uqt-shuffle');
    localStorage.removeItem('uqt-repeat');
  });
  await page.route('**/uqt-albums.json.gz', route => route.fulfill({
    status: 200,
    headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' },
    body: fixtureGz,
  }));
  await page.route('**/homi-albums.json.gz', route => route.fulfill({
    status: 200,
    headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' },
    body: fixtureGz,
  }));
  // Let audio requests pass through to the real CDN
  await page.route('**/capa-min.jpg', route => route.fulfill({ status: 404 }));

  await page.goto('/');
  await page.waitForSelector('.album-item', { timeout: 8000 });

  // Click first album, then first track
  await page.locator('.album-item').first().click();
  await page.locator('#track-list .track-item').first().click();

  // Verify player constructs audio URL pointing to the CDN
  const audioSrc = await page.evaluate(() => document.querySelector('#audio')?.src ?? '');
  expect(audioSrc).toContain(CDN);

  // Verify a known real CDN track actually serves (separate from fixture paths)
  const cdnRes = await request.head(`${CDN}/${encodeURI(TRACKS[0])}`, {
    headers: { 'User-Agent': BROWSER_UA, 'Referer': PLAYER_REFERER },
  });
  expect(cdnRes.status()).toBe(200);

  const relevantErrors = errors.filter(e => !e.includes('favicon') && !e.includes('umami'));
  expect(relevantErrors).toHaveLength(0);
});
