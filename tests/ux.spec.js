// UX features from tasks/done/ux-improvements.md. Fixture: tests/fixtures/albums.json.gz (via helpers).
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

  // MP3 de 0 bytes (os 74 do uqt) é problema do arquivo, não do CDN: pula e marca cada um, e as
  // três faixas vazias seguidas não disparam o "Vários erros seguidos" (que é o aviso de CDN fora).
  test('empty (0-byte) files are marked and skipped without the CDN-down pause', async ({ page }) => {
    await gotoWithFixture(page);
    await page.unroute('**/*.mp3');
    await page.route('**/*.mp3', r => r.fulfill({ status: 200, headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '0' }, body: '' }));
    await card(page, 'Construção').locator('.card-play').click();
    const titulo = await page.evaluate(() => selectedAlbum.tracks[0].title);
    await expect(page.locator('#toast')).toContainText(`Faixa vazia: ${titulo}`);
    const itens = page.locator('#track-list .track-item');
    await expect(itens.nth(0)).toHaveClass(/unavailable/);
    await expect(itens.nth(1)).toHaveClass(/unavailable/, { timeout: 5000 });
    await expect(itens.nth(2)).toHaveClass(/unavailable/, { timeout: 5000 });
    await expect(page.locator('#toast')).not.toContainText('Vários erros');
  });

  // Faixas conhecidas como quebradas (js/faixas-indisponiveis.js) ficam no catálogo, listadas desativadas:
  // não tocam, não recebem clique e a sequência passa por cima delas.
  test('known-broken tracks stay listed but disabled, and playback skips them', async ({ page }) => {
    await page.route('**/js/faixas-indisponiveis.js', r => r.fulfill({ contentType: 'text/javascript', body: `
      const FAIXAS_INDISPONIVEIS = {};
      function faixaIndisponivel(b, p, f) {
        if (p === '1971 - Chico Buarque - Construção' && f === '01 Construção.mp3') return 'vazio';
        if (p === '1930 - Pixinguinha - Acervo Raro') return 'truncado';
      }` }));
    await gotoWithFixture(page);
    await card(page, 'Construção').locator('.card-play').click();
    const itens = page.locator('#track-list .track-item');
    await expect(itens).toHaveCount(3);                                   // still listed
    await expect(itens.nth(0)).toHaveClass(/indisponivel/);
    await expect(itens.nth(0)).toHaveAttribute('aria-disabled', 'true');
    await expect.poll(() => page.evaluate(() => currentTrack.title)).toBe('Deus lhe Pague');   // started on the 2nd
    await itens.nth(0).click({ force: true });                            // a click does nothing
    expect(await page.evaluate(() => currentTrack.title)).toBe('Deus lhe Pague');
    await page.evaluate(() => playPrevious());                            // previous never lands on it
    expect(await page.evaluate(() => currentTrack.title)).not.toBe('Construção');
    // An album with nothing playable opens, lists its track, and says so instead of playing
    await card(page, 'Pixinguinha').locator('.card-play').click();
    await expect(page.locator('#track-list .track-item.indisponivel')).toHaveCount(1);
    await expect(page.locator('#toast')).toContainText('Nenhuma faixa deste álbum está disponível');
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

  test('left alone, it fades out after 5 s and comes back on the next visit', async ({ page }) => {
    await gotoWithFixture(page, '/?acervo=uqt');
    const file = await page.evaluate(() => albums[0].tracks[0].file);
    await seed(page, { file, time: 30 });
    await page.reload();
    const bar = page.locator('.continue-listening');
    await expect(bar).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(bar).toHaveCount(0, { timeout: 8000 });
    await page.evaluate(() => sessionStorage.removeItem('pw-seeded'));
    await page.reload();
    await expect(page.locator('.continue-listening')).toBeVisible();
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
  test('turning it on with nothing playing starts a track from the grid', async ({ page }) => {
    await gotoWithFixture(page, '/?acervo=uqt&artista=Elis%20Regina');
    expect(await page.evaluate(() => document.getElementById('audio').paused)).toBe(true);
    await page.locator('#btn-shuffle').click();
    await expect(page.locator('#btn-shuffle')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#btn-play')).toHaveClass(/playing/);
    expect(await page.evaluate(() => filteredAlbums.some(a => a.tracks.includes(currentTrack)))).toBe(true);
    // turning it off doesn't touch playback
    await page.locator('#btn-shuffle').click();
    await expect(page.locator('#btn-play')).toHaveClass(/playing/);
  });

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

test('a file that exists but will not decode is skipped, not stuck behind a retry', async ({ page }) => {
  await gotoWithFixture(page);
  await page.unroute('**/*.mp3');
  let first = true;
  await page.route('**/*.mp3', r => {
    if (r.request().method() === 'HEAD') return r.fulfill({ status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
    if (first) { first = false; return r.fulfill({ status: 200, headers: { 'Content-Type': 'audio/mpeg' }, body: 'isto não é um mp3' }); }
    return r.fulfill({ status: 200, headers: { 'Content-Type': 'audio/mpeg' }, body: require('./helpers').fixtureMp3 });
  });
  await card(page, 'Construção').locator('.card-play').click();
  const titulo = await page.evaluate(() => selectedAlbum.tracks[0].title);
  await expect(page.locator('#toast')).toContainText(`Não foi possível tocar: ${titulo}`);
  await expect.poll(() => page.evaluate(() => selectedAlbum.tracks.indexOf(currentTrack)), { timeout: 5000 }).toBe(1);
});

test('clicking the player title brings the tracks panel back to the playing album', async ({ page }) => {
  await gotoWithFixture(page);
  const c = card(page, 'Construção');
  await c.hover();
  await c.locator('.card-play').click();
  await expect(page.locator('#btn-play')).toHaveClass(/playing/);
  await card(page, 'Clube da Esquina').click();
  await expect(page.locator('#album-header h2')).toContainText('Clube da Esquina');
  await page.locator('#player-title').click();
  await expect(page.locator('#album-header h2')).toContainText('Construção');
  await expect(page.locator('#track-list .track-item').first()).toHaveClass(/playing/);
  expect(await page.evaluate(() => document.getElementById('audio').paused)).toBe(false);   // the audio is not cut
});
