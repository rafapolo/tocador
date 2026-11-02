// js/reporter.js: o que vira POST /report-error (e daí issue no GitHub).
// O reporter se cala para automação (navigator.webdriver, UA "HeadlessChrome"), então estes testes
// mascaram os dois — como os testes de heartbeat do rádio.
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const albumsGz = fs.readFileSync(path.join(__dirname, 'fixtures', 'albums.json.gz'));
test.use({
  serviceWorkers: 'block',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
});

async function rotear(page, { mp3 = r => r.fulfill({ status: 500 }), generos = 404 } = {}) {
  const reportes = [];
  await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
  const gz = { status: 200, headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' }, body: albumsGz };
  for (const f of ['uqt-albums.json.gz', 'homi-albums.json.gz']) await page.route(`**/${f}`, r => r.fulfill(gz));
  await page.route('**/*-genres.json.gz', r => r.fulfill({ status: generos }));
  await page.route('**/*.mp3', mp3);
  await page.route('**/capa-m*.jpg', r => r.fulfill({ status: 404 }));
  await page.route('**/report-error', r => {
    try { reportes.push(JSON.parse(r.request().postData() || '{}')); } catch {}
    r.fulfill({ status: 204 });
  });
  return reportes;
}

test('erro de JS não tratado vira reporte "js" com contexto', async ({ page }) => {
  const reportes = await rotear(page);
  await page.goto('/');
  await page.waitForSelector('.album-item');
  await page.evaluate(() => setTimeout(() => { throw new Error('boom de teste'); }));
  await expect.poll(() => reportes.find(r => r.title.includes('boom de teste'))).toBeTruthy();
  const r = reportes.find(r => r.title.includes('boom de teste'));
  expect(r.categoria).toBe('js');
  expect(r.title).toMatch(/^\[tocador\] JS error: .*boom de teste/);
  expect(r.body).toContain('**viewport:**');
  expect(r.body).toContain('**online:**');
});

test('rejeição com valor que não é Error diz o tipo do valor e leva pilha sintética', async ({ page }) => {
  const reportes = await rotear(page);
  await page.goto('/');
  await page.waitForSelector('.album-item');
  await page.evaluate(() => { Promise.reject(404); });
  await expect.poll(() => reportes.find(r => r.title.endsWith('Unhandled rejection: 404'))).toBeTruthy();
  const r = reportes.find(r => r.title.endsWith('Unhandled rejection: 404'));
  expect(r.body).toContain('number: 404');
  expect(r.body).toContain('sem pilha própria');
});

test('teto de 3 reportes por categoria e por página; título repetido não reenvia', async ({ page }) => {
  const reportes = await rotear(page);
  await page.goto('/');
  await page.waitForSelector('.album-item');
  const enviados = await page.evaluate(() => [
    reportar('atlas', 'a'), reportar('atlas', 'a'), reportar('atlas', 'b'), reportar('atlas', 'c'), reportar('atlas', 'd'),
    reportar('catalogo', 'outra categoria'),
  ]);
  expect(enviados).toEqual([true, false, true, true, false, true]);
  await expect.poll(() => reportes.filter(r => r.categoria === 'atlas').length).toBe(3);
});

test('índice de gêneros que não carrega vira reporte "features"', async ({ page }) => {
  const reportes = await rotear(page, { generos: 500 });
  await page.goto('/?acervo=homi');
  await page.waitForSelector('.album-item');
  await expect.poll(() => reportes.find(r => r.categoria === 'features')?.title).toMatch(/índice de gêneros não carregou: homi/);
});

test('faixa que não toca vira reporte "reproducao" com o Audio src que o proxy confere', async ({ page }) => {
  const reportes = await rotear(page);
  await page.goto('/');
  await page.waitForSelector('.album-item');
  await page.locator('.album-item', { hasText: 'Construção' }).click();
  await page.locator('#track-list .track-item').first().click();
  await expect.poll(() => reportes.find(r => r.categoria === 'reproducao')).toBeTruthy();
  const r = reportes.find(r => r.categoria === 'reproducao');
  expect(r.title).toMatch(/^\[tocador\] not playable: .*Construção/);
  expect(r.body).toMatch(/\*\*Audio src:\*\* `[^`]+\.mp3`/);
  expect(r.body).toContain('**Media error:** MediaError');
});

test('robô (navigator.webdriver) não reporta nada', async ({ page }) => {
  const reportes = [];
  await page.route('**/report-error', r => { reportes.push(1); r.fulfill({ status: 204 }); });
  await page.goto('/atlas.html');
  expect(await page.evaluate(() => reportar('atlas', 'x'))).toBe(false);
  await page.waitForTimeout(200);
  expect(reportes).toHaveLength(0);
});

test('/atlas: payload que não carrega vira reporte "atlas" com o prefixo da página', async ({ page }) => {
  const reportes = await rotear(page);
  await page.route('**/atlas-faixas.json.gz', r => r.fulfill({ status: 500, body: 'erro' }));
  await page.goto('/atlas.html');
  await expect(page.locator('#carregando-status')).toHaveText('Não foi possível carregar o mapa.');
  await expect.poll(() => reportes.find(r => r.categoria === 'atlas')?.title).toMatch(/^\[atlas\] mapa não carregou/);
});
