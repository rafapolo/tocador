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

test.describe('continue listening', () => {
  async function seed(page, entry) {
    await page.addInitScript(e => {
      if (sessionStorage.getItem('pw-seeded')) return;
      sessionStorage.setItem('pw-seeded', '1');
      localStorage.setItem('tocador-position', JSON.stringify(e));   // the old single key: migrated
    }, entry);
  }

  test('a bare visit offers the saved track and resumes it where it stopped', async ({ page }) => {
    await gotoWithFixture(page, '/?acervo=uqt');
    const file = await page.evaluate(() => albums.find(a => a.name.includes('Construção')).tracks[1].file);
    await page.evaluate(() => localStorage.clear());
    await seed(page, { file, time: 5 });
    await page.reload();
    const bar = page.locator('.continue-listening');
    await expect(bar).toContainText('Continuar de 0:05:');
    await expect(bar).toContainText('Construção');
    await bar.locator('.continue-go').click();
    await expect(bar).toHaveCount(0);
    await expect(page.locator('#album-header h2')).toContainText('Construção');
    await expect(page.locator('#btn-play')).toHaveClass(/playing/);
    await expect.poll(() => page.evaluate(() => document.getElementById('audio').currentTime)).toBeGreaterThanOrEqual(4);
    expect(await page.evaluate(() => selectedAlbum.tracks.indexOf(currentTrack))).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem('tocador-position'))).toBeNull();
  });

  test('dismissed, it stays hidden on the next visit; an album URL never shows it', async ({ page }) => {
    await gotoWithFixture(page, '/?acervo=uqt');
    const file = await page.evaluate(() => albums[0].tracks[0].file);
    await seed(page, { file, time: 30 });
    await page.reload();
    await page.locator('.continue-listening .continue-close').click();
    await page.reload();
    await page.waitForSelector('.album-item');
    await expect(page.locator('.continue-listening')).toHaveCount(0);
    await page.goto(await page.evaluate(() => generateAlbumUrl(albums[2])));
    await page.waitForSelector('.album-item');
    await expect(page.locator('.continue-listening')).toHaveCount(0);
  });
});

test.describe('shuffle', () => {
  test('draws only from the filtered albums', async ({ page }) => {
    await gotoWithFixture(page, '/?acervo=uqt&artista=Elis%20Regina');
    const n = await page.evaluate(() => filteredAlbums.length);
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThan(await page.evaluate(() => albums.length));
    await page.locator('#btn-shuffle').click();
    await page.locator('.album-item').first().locator('.card-play').click();
    for (let i = 0; i < 10; i++) {
      await page.locator('#btn-next').click();
      expect(await page.evaluate(() => filteredAlbums.some(a => a.tracks.includes(currentTrack)))).toBe(true);
    }
  });

  test('previous walks back through what shuffle played', async ({ page }) => {
    await gotoWithFixture(page);
    await page.locator('#btn-shuffle').click();
    await card(page, 'Construção').locator('.card-play').click();
    const first = await page.evaluate(() => currentTrack.file);
    await page.locator('#btn-next').click();
    const second = await page.evaluate(() => currentTrack.file);
    await page.locator('#btn-next').click();
    await page.evaluate(() => { document.getElementById('audio').currentTime = 0; });
    await page.locator('#btn-prev').click();
    expect(await page.evaluate(() => currentTrack.file)).toBe(second);
    await page.locator('#btn-prev').click();
    expect(await page.evaluate(() => currentTrack.file)).toBe(first);
  });
});

test.describe('sleep timer and speed', () => {
  test('15 min: fades, pauses and gives the volume back', async ({ page }) => {
    await page.clock.install();
    await gotoWithFixture(page, '/', { ranges: true });
    await card(page, 'Construção').locator('.card-play').click();
    await expect(page.locator('#btn-play')).toHaveClass(/playing/);
    await page.locator('#btn-timer').click();
    await page.locator('#timer-menu [data-sleep="15"]').click();
    await expect(page.locator('#btn-timer .timer-left')).toHaveText('15′');
    // keep the 10 s silence from ending (and moving on) while the fake clock runs
    await page.evaluate(() => { const a = document.getElementById('audio'); a.loop = true; });
    await page.clock.runFor(15 * 60 * 1000 - 5000);
    const meio = await page.evaluate(() => document.getElementById('audio').volume);
    expect(meio).toBeLessThan(0.75);
    await page.clock.runFor(7000);
    await expect.poll(() => page.evaluate(() => document.getElementById('audio').paused)).toBe(true);
    expect(await page.evaluate(() => document.getElementById('audio').volume)).toBe(1);
    await expect(page.locator('#btn-timer .timer-left')).toHaveText('');
  });

  test('end of track: stops instead of moving on', async ({ page }) => {
    await gotoWithFixture(page, '/', { ranges: true });
    await card(page, 'Construção').locator('.card-play').click();
    await page.locator('#btn-timer').click();
    await page.locator('#timer-menu [data-sleep="track"]').click();
    await page.evaluate(() => document.getElementById('audio').dispatchEvent(new Event('ended')));
    expect(await page.evaluate(() => selectedAlbum.tracks.indexOf(currentTrack))).toBe(0);
    await expect(page.locator('#toast')).toContainText('Timer');
  });

  test('speed is kept across tracks and reloads', async ({ page }) => {
    await gotoWithFixture(page, '/', { ranges: true });
    await card(page, 'Construção').locator('.card-play').click();
    await page.locator('#btn-timer').click();
    await page.locator('#timer-menu [data-rate="1.5"]').click();
    await page.locator('#btn-next').click();
    await expect.poll(() => page.evaluate(() => document.getElementById('audio').playbackRate)).toBe(1.5);
    await expect(page.locator('#btn-timer .timer-left')).toHaveText('1,5×');
    await page.reload();
    await page.waitForSelector('.album-item');
    expect(await page.evaluate(() => document.getElementById('audio').defaultPlaybackRate)).toBe(1.5);
    await page.keyboard.press('Escape');
  });
});
