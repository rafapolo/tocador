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

// Regression: an NFD-encoded URL must still resolve to an NFC-stored key
// (37b3d41). NFC 'a-acute' = %C3%A1, NFD = a%CC%81 -- sending NFD must return 200.
//
// NOTE: this test used to be called "NFD-encoded path normalizes to NFC", and its
// rationale read "S3 keys are stored in NFC, so the proxy must normalize the
// decoded path to NFC". That premise is false, and stating it here is part of why
// the 2026-05-28 regression looked deliberate. S3 stores whatever bytes were
// uploaded and never normalizes: sambaraiz/uqt is mostly NFD, indie/indie mostly
// NFC. Normalizing every request to NFC 404'd half the uqt catalogue for three
// months while this test stayed green -- the object it checks happens to live in
// the NFC bucket, so composing the request could only ever help it. The proxy now
// tries the requested form first and falls back to the other; the cross-bucket
// block at the end of this file covers the direction this test cannot.
test('CDN: NFD-encoded URL resolves to an NFC-stored key', async ({ request }) => {
  // NFC path (normal): 'música' → m%C3%BAsica
  // NFD path (macOS):  'música' → mu%CC%81sica  (u + combining acute)
  const nfdPath = 'indie/2026%20-%20Barulhista%20-%20mu%CC%81sica%20para%20dan%C3%A7ar%20sentado/capa-min.jpg';
  const res = await request.get(`${CDN}/${nfdPath}`, {
    headers: { 'User-Agent': BROWSER_UA },
  });
  // NFD path must resolve — the proxy falls back to NFC when NFD misses
  expect(res.status()).toBe(200);
});

// Regression: Bun's S3Client doesn't encode # in keys, so paths with # must
// be served via the manual AWS-signed fetch fallback (2a7364a + d5fc327).
// Further regression: sigV4Encode must encode ! ' ( ) * — encodeURIComponent
// leaves them literal, causing Hetzner S3 to compute a different canonical URI
// and return 403 SignatureDoesNotMatch (ff33929).
test('CDN: path with # served correctly (s3GetSigned fallback)', async ({ request }) => {
  const res = await request.head(
    `${CDN}/indie/2022%20-%20Jean%20Medeiros%20-%20Hominis%20Canidae%20%23147%20-%20Agosto%20%282022%29/capa-min.jpg`,
    { headers: { 'User-Agent': BROWSER_UA } },
  );
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('image/jpeg');
});

test('CDN: path with # and ! served correctly (sigV4Encode encodes !)', async ({ request }) => {
  // VICTIM! was returning 403 because encodeURIComponent left ! unencoded;
  // Hetzner S3 encodes ! → %21 when verifying, causing a signature mismatch.
  const res = await request.head(
    `${CDN}/indie/2015%20-%20VICTIM!%20-%20Hominis%20Canidae%20%2360%20-%20Maio/capa-min.jpg`,
    { headers: { 'User-Agent': BROWSER_UA } },
  );
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('image/jpeg');
});

test('CDN: path with # and () served correctly (sigV4Encode encodes parentheses)', async ({ request }) => {
  // (2022) was returning 403 for the same reason as ! above.
  const res = await request.head(
    `${CDN}/indie/2022%20-%20Jean%20Medeiros%20-%20Hominis%20Canidae%20%23147%20-%20Agosto%20%282022%29/03.%20Gorduratrans%20-%20alquimistas.mp3`,
    { headers: { 'User-Agent': BROWSER_UA, 'Referer': PLAYER_REFERER } },
  );
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('audio/mpeg');
});

// ── Unicode normalization across buckets ─────────────────────────────────────
//
// S3 stores keys byte-exactly and never normalizes, and the buckets are not
// uniform: sambaraiz/uqt is mostly NFD (uploaded from macOS), indie/indie is
// mostly NFC, and each holds keys in the other form. Every check above lives in
// indie and is ASCII or NFC — which is exactly why all of them stayed green
// through the 2026-05→08 outage where a blanket `.normalize('NFC')` in proxy.js
// 404'd 14,676 of 28,817 uqt tracks (50.9%, across 2,199 of 2,306 albums).
// These probe the axis that was actually broken: the other bucket, both forms.

const NORMALIZATION_TRACKS = [
  {
    label: 'uqt NFD-stored filename',
    key: 'uqt/1965 - Forma65/03 Canção do Olhar Amado.mp3',
    stored: 'NFD',
  },
  {
    label: 'uqt NFC-stored directory',
    key: 'uqt/1960 - Elza Soares, Oswaldo Borba - Se Acaso Você Chegasse/03 Mulata Assanhada.mp3',
    stored: 'NFC',
  },
];

for (const { label, key, stored } of NORMALIZATION_TRACKS) {
  const other = stored === 'NFD' ? 'NFC' : 'NFD';

  // Guard against a silent tautology: if this source file is ever re-saved in a
  // single normalization form, both variants would collapse to one string and
  // these tests would pass while checking nothing.
  test(`CDN: ${label} — fixture really is accented`, async () => {
    expect(key.normalize('NFD')).not.toBe(key.normalize('NFC'));
  });

  for (const asked of [stored, other]) {
    test(`CDN: ${label}, requested as ${asked}`, async ({ request }) => {
      const url = `${CDN}/${encodeURI(key.normalize(asked))}`;
      const res = await request.get(url, {
        headers: {
          'User-Agent': BROWSER_UA,
          'Referer': PLAYER_REFERER,
          'Range': 'bytes=0-1000',
        },
      });
      expect(res.status()).toBe(206);
      expect(res.headers()['content-type']).toContain('audio/mpeg');
      // Content-Range must carry the real total, not "*" — mobile Safari
      // abandons playback otherwise, and the fallback path must not lose it.
      expect(res.headers()['content-range']).toMatch(/^bytes 0-1000\/\d+$/);
    });
  }
}
