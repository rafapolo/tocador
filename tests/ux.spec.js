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
    await expect(page.locator('#toast')).toContainText(`Faixa vazia: ${titulo}`, { timeout: 8000 });
    const itens = page.locator('#track-list .track-item');
    await expect(itens.nth(0)).toHaveClass(/unavailable/);
    // no WebKit não há 'error' para 0 bytes: o vigia (3 s) pergunta ao servidor, e só então pula
    await expect(itens.nth(1)).toHaveClass(/unavailable/, { timeout: 8000 });
    await expect(itens.nth(2)).toHaveClass(/unavailable/, { timeout: 8000 });
    await expect(page.locator('#toast')).not.toContainText('Vários erros');
  });

  // O vigia do WebKit (0 bytes sem 'error') não pode confundir rede lenta com arquivo vazio: com o GET parado e o
  // HEAD dizendo que o arquivo existe e tem tamanho, a faixa espera, sem pular e sem marcar nada.
  test('a slow track is waited for, not skipped by the empty-file watchdog', async ({ page }) => {
    await gotoWithFixture(page);
    await page.unroute('**/*.mp3');
    await page.route('**/*.mp3', r => r.request().method() === 'HEAD'
      ? r.fulfill({ status: 200, headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '4000000' }, body: '' })
      : undefined);                                                       // o GET nunca responde
    await card(page, 'Construção').locator('.card-play').click();
    await page.waitForTimeout(5000);                                      // passa do VIGIA_MS (3 s) com folga
    expect(await page.evaluate(() => selectedAlbum.tracks.indexOf(currentTrack))).toBe(0);
    await expect(page.locator('#track-list .track-item').first()).not.toHaveClass(/unavailable/);
    await expect(page.locator('#toast')).not.toContainText('Faixa');
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
    // two silent retries (1.5 s, 5 s) come first: only then the toast
    await expect(page.locator('#toast')).toContainText('Servidor de áudio indisponível', { timeout: 15000 });
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

  test('it fades out after 5 s even while hovered, and comes back on the next visit', async ({ page }) => {
    await gotoWithFixture(page, '/?acervo=uqt');
    const file = await page.evaluate(() => albums[0].tracks[0].file);
    await seed(page, { file, time: 30 });
    await page.reload();
    const bar = page.locator('.continue-listening');
    await expect(bar).toBeVisible();
    await page.locator('.continue-go').hover();
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

test('a file that exists but will not decode is skipped after the silent retries, not stuck behind them', async ({ page }) => {
  await gotoWithFixture(page);
  await page.unroute('**/*.mp3');
  const pedidos = [];
  await page.route('**/*.mp3', r => {
    if (r.request().method() === 'HEAD') return r.fulfill({ status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
    const quebrada = decodeURIComponent(r.request().url()).includes('01 Construção');
    if (quebrada) pedidos.push(Date.now());
    return r.fulfill({ status: 200, headers: { 'Content-Type': 'audio/mpeg' }, body: quebrada ? 'isto não é um mp3' : require('./helpers').fixtureMp3 });
  });
  await card(page, 'Construção').locator('.card-play').click();
  const titulo = await page.evaluate(() => selectedAlbum.tracks[0].title);
  await expect(page.locator('#toast')).toContainText(`Não foi possível tocar: ${titulo}`, { timeout: 15000 });
  await expect.poll(() => page.evaluate(() => selectedAlbum.tracks.indexOf(currentTrack)), { timeout: 5000 }).toBe(1);
  expect(new Set(pedidos.map(t => Math.round(t / 1000))).size).toBeGreaterThanOrEqual(3);   // the load + 2 retries
});

// S3 stalling on one object (2026-11-20, #657): the file is fine a moment later. The player loads it again quietly
// instead of skipping it, toasting and filing an issue.
test('a failure that clears is retried silently: no toast, no skip, no report', async ({ page }) => {
  await gotoWithFixture(page);
  await page.evaluate(() => { window.__reportes = []; window.reportar = (cat, titulo) => window.__reportes.push(titulo); });
  await page.unroute('**/*.mp3');
  let falhas = 1;
  await page.route('**/*.mp3', r => {
    if (r.request().method() === 'HEAD') return r.fulfill({ status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
    if (falhas > 0) { falhas--; return r.fulfill({ status: 504, headers: { 'Access-Control-Allow-Origin': '*' } }); }
    return r.fulfill({ status: 200, headers: { 'Content-Type': 'audio/mpeg' }, body: require('./helpers').fixtureMp3 });
  });
  await card(page, 'Construção').locator('.card-play').click();
  await expect.poll(() => page.evaluate(() => document.getElementById('audio').currentTime), { timeout: 10000 }).toBeGreaterThan(0.2);
  expect(await page.evaluate(() => selectedAlbum.tracks.indexOf(currentTrack))).toBe(0);
  await expect(page.locator('#toast')).not.toContainText('Faixa');
  await expect(page.locator('#toast')).not.toContainText('Não foi possível');
  expect(await page.evaluate(() => window.__reportes)).toEqual([]);
});

test('a retry resumes the track where it was, not from 0:00', async ({ page }) => {
  await gotoWithFixture(page);
  await page.unroute('**/*.mp3');
  await page.route('**/*.mp3', require('./helpers').rangedMp3);   // seeking needs Range, as on the real CDN
  await card(page, 'Construção').locator('.card-play').click();
  await expect.poll(() => page.evaluate(() => document.getElementById('audio').currentTime)).toBeGreaterThan(0.2);
  await page.evaluate(() => { document.getElementById('audio').pause(); _ultimaPosicao = { track: currentTrack, t: 3 }; retomarFaixa(currentTrack); });
  // within 1.5 s: playing on from ~0.2 s could not get there by itself
  await expect.poll(() => page.evaluate(() => document.getElementById('audio').currentTime), { timeout: 1500 }).toBeGreaterThanOrEqual(3);
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
