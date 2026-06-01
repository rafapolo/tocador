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
    localStorage.setItem('tocador-browse-collapsed', 'true');
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
  await page.route('**/*-genres.json.gz', route => route.fulfill({ status: 404 }));
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

// ── Per-acervo bucket routing ─────────────────────────────────────────────────
// Regression: S3_BUCKET_MAP in haloy.yaml was changed from "uqt/:sambaraiz,indie/:indie"
// to "uqt/:indie" on 2026-05-28, silently breaking all UQT audio (09ca9d5).
// These two tests catch any future misconfiguration of the bucket map.

test('CDN: UQT audio served from sambaraiz bucket', async ({ request }) => {
  const track = 'uqt/2010 - Adoniram 100 anos/1. Um samba no Bixiga.mp3';
  const res = await request.head(`${CDN}/${encodeURI(track)}`, {
    headers: { 'User-Agent': BROWSER_UA, 'Referer': PLAYER_REFERER },
  });
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('audio/mpeg');
});

test('CDN: HOMI audio served from indie bucket', async ({ request }) => {
  const track = 'indie/2026 - Barulhista - música para dançar sentado/Barulhista - debaixo do sol.mp3';
  const res = await request.head(`${CDN}/${encodeURI(track)}`, {
    headers: { 'User-Agent': BROWSER_UA, 'Referer': PLAYER_REFERER },
  });
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('audio/mpeg');
});

// ── Proxy regression tests ────────────────────────────────────────────────────

// Regression: X-Content-Type-Options: nosniff on error bodies triggered CORB
// for cross-origin <audio>/<img> elements, silently blocking playback (2cba18a).
// Error responses must carry CORS headers but must NOT have nosniff.
test('CDN: 404 response has CORS headers but no X-Content-Type-Options nosniff', async ({ request }) => {
  const res = await request.get(`${CDN}/indie/nonexistent-album-xxxxxx/track.mp3`, {
    headers: { 'User-Agent': BROWSER_UA, 'Referer': PLAYER_REFERER },
  });
  expect(res.status()).toBe(404);
  // CORS must be present so the browser gets the response (not an opaque error)
  expect(res.headers()['access-control-allow-origin']).toBe('*');
  // nosniff on a text/plain 404 body triggers CORB — must be absent on errors
  expect(res.headers()['x-content-type-options']).toBeUndefined();
});

// Regression: macOS writes filenames in NFD (decomposed) unicode; S3 keys are
// stored in NFC (composed). The proxy must normalize the decoded path to NFC
// so that NFD-encoded URLs resolve to the correct S3 object (37b3d41).
// 'á' NFC = %C3%A1, NFD = a%CC%81 — sending NFD must still return 200.
test('CDN: NFD-encoded path normalizes to NFC and serves correctly', async ({ request }) => {
  // NFC path (normal): 'música' → m%C3%BAsica
  // NFD path (macOS):  'música' → mu%CC%81sica  (u + combining acute)
  const nfdPath = 'indie/2026%20-%20Barulhista%20-%20mu%CC%81sica%20para%20dan%C3%A7ar%20sentado/capa-min.jpg';
  const res = await request.get(`${CDN}/${nfdPath}`, {
    headers: { 'User-Agent': BROWSER_UA },
  });
  // NFD path must resolve — proxy normalizes to NFC before S3 lookup
  expect(res.status()).toBe(200);
});

// Regression: Bun's S3Client didn't encode # in keys, treating them as URL
// fragment delimiters and truncating the S3 request path. Paths with # must
// be served via the manual AWS-signed fetch fallback (2a7364a + d5fc327).
// TODO: enable once test data with # in album path is uploaded to S3
test.skip('CDN: path with # (encoded as %23) is served correctly', async ({ request }) => {
  const hashTrack = 'indie/2026%20-%20Naturezautom%C3%A1tica%20-%20Hominis%20Canidae%20%23191%20-%20Abril/01.%20Naturezautomatica%20-%20VEM!.mp3';
  const res = await request.head(`${CDN}/${hashTrack}`, {
    headers: { 'User-Agent': BROWSER_UA, 'Referer': PLAYER_REFERER },
  });
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('audio/mpeg');
});
