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

async function gotoWithFixture(page, url = '/') {
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
  await page.route('**/*.mp3', route => route.fulfill({ status: 200, headers: { 'Content-Type': 'audio/mpeg' }, body: fixtureMp3 }));
  await page.route('**/capa-min.jpg', route => route.fulfill({ status: 404 }));
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
  expect(hours?.trim()).toMatch(/\d+\s*horas?/i);
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
