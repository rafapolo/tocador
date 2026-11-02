// UX features from tasks/ux-improvements.md. Fixture: tests/fixtures/albums.json.gz (via helpers).
const { test, expect } = require('@playwright/test');
const { gotoWithFixture } = require('./helpers');

// page.route() doesn't see requests from a page the service worker controls (the error
// classifier's HEAD would reach the live CDN).
test.use({ serviceWorkers: 'block' });

const card = (page, title) => page.locator('.album-item', { hasText: title });

test.describe('card play button', () => {
  test('plays track 1 of the album, and toggles pause on the playing album', async ({ page }) => {
    await gotoWithFixture(page);
    const c = card(page, 'Construção');
    await c.hover();
    await c.locator('.card-play').click();
    await expect(page.locator('#btn-play')).toHaveClass(/playing/);
    await expect(page.locator('#album-header h2')).toContainText('Construção');
    await expect(page.locator('#track-list .track-item').first()).toHaveClass(/playing/);
    expect(await page.evaluate(() => currentTrack === selectedAlbum.tracks[0]
      && document.getElementById('audio').src === new URL(`${BASE_URL}/${currentTrack.file}`, location.href).href)).toBe(true);
    await expect(c).toHaveClass(/playing-album/);

    await c.locator('.card-play').click();
    await expect.poll(() => page.evaluate(() => document.getElementById('audio').paused)).toBe(true);
    await c.locator('.card-play').click();
    await expect.poll(() => page.evaluate(() => document.getElementById('audio').paused)).toBe(false);
  });

  test('a click on the card body still only primes (C17)', async ({ page }) => {
    await gotoWithFixture(page);
    await card(page, 'Construção').locator('.album-item-title').click();
    await expect(page.locator('#album-header h2')).toContainText('Construção');
    expect(await page.evaluate(() => document.getElementById('audio').paused)).toBe(true);
  });

  test('the card keeps the visible title as its accessible name', async ({ page }) => {
    await gotoWithFixture(page);
    const c = card(page, 'Construção');
    await expect(c.locator('.card-play')).toHaveAttribute('aria-hidden', 'true');
    expect(await c.getAttribute('aria-label')).toBeNull();
  });
});

test.describe('actionable playback errors', () => {
  test('a missing file names the track, marks it and moves on', async ({ page }) => {
    await gotoWithFixture(page);
    await page.unroute('**/*.mp3');
    let first = true;
    await page.route('**/*.mp3', r => {
      if (first || r.request().method() === 'HEAD') { if (r.request().method() !== 'HEAD') first = false; return r.fulfill({ status: 404 }); }
      return r.fulfill({ status: 200, headers: { 'Content-Type': 'audio/mpeg' }, body: require('./helpers').fixtureMp3 });
    });
    await card(page, 'Construção').locator('.card-play').click();
    const titulo = await page.evaluate(() => selectedAlbum.tracks[0].title);
    await expect(page.locator('#toast')).toContainText(`Faixa indisponível: ${titulo}`);
    await expect(page.locator('#track-list .track-item').first()).toHaveClass(/unavailable/);
    await expect.poll(() => page.evaluate(() => selectedAlbum.tracks.indexOf(currentTrack)), { timeout: 5000 }).toBe(1);
  });

  test('offline: no skip, a retry button, and it resumes when the network is back', async ({ page, context }) => {
    await gotoWithFixture(page);
    await page.unroute('**/*.mp3');
    let down = true;
    await page.route('**/*.mp3', r => down ? r.abort('internetdisconnected')
      : r.fulfill({ status: 200, headers: { 'Content-Type': 'audio/mpeg' }, body: require('./helpers').fixtureMp3 }));
    await context.setOffline(true);
    await card(page, 'Construção').locator('.card-play').click();
    await expect(page.locator('#toast')).toContainText('Sem conexão');
    await expect(page.locator('#toast .toast-action')).toHaveText('Tentar de novo');
    await page.waitForTimeout(2000);
    expect(await page.evaluate(() => selectedAlbum.tracks.indexOf(currentTrack))).toBe(0);
    down = false;
    await context.setOffline(false);
    await expect(page.locator('#btn-play')).toHaveClass(/playing/);
    await expect.poll(() => page.evaluate(() => document.getElementById('audio').paused)).toBe(false);
  });

  test('a server error offers a retry that plays the same track', async ({ page }) => {
    await gotoWithFixture(page);
    await page.unroute('**/*.mp3');
    let falha = true;
    await page.route('**/*.mp3', r => falha ? r.fulfill({ status: 502 })
      : r.fulfill({ status: 200, headers: { 'Content-Type': 'audio/mpeg' }, body: require('./helpers').fixtureMp3 }));
    await card(page, 'Construção').locator('.card-play').click();
    await expect(page.locator('#toast')).toContainText('Servidor de áudio indisponível');
    falha = false;
    await page.locator('#toast .toast-action').click();
    await expect.poll(() => page.evaluate(() => document.getElementById('audio').paused)).toBe(false);
    expect(await page.evaluate(() => selectedAlbum.tracks.indexOf(currentTrack))).toBe(0);
  });
});
