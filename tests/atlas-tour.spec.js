// O tour do /atlas (js/atlas-tour.js, roteiro em TOUR.md): começa pelo botão ou por ?tour=1, pula com &t=, não escreve
// no endereço e devolve tudo como estava com Esc. Mesmos fixtures de tests/atlas.spec.js, sem rede.
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const fx = n => fs.readFileSync(path.join(__dirname, 'fixtures', n));
const gz = body => ({ status: 200, headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' }, body });

test.use({ serviceWorkers: 'block' });

async function boot(page, url = '/atlas.html') {
  await page.route('**/data/atlas-faixas.json.gz', r => r.fulfill(gz(fx('atlas-faixas-teste.json.gz'))));
  await page.route('**/data/atlas-artistas.json.gz', r => r.fulfill({ status: 404 }));
  await page.route('**/data/*-features.json.gz', r => r.fulfill({ status: 404 }));
  await page.route('**/uqt/data/uqt-albums.json.gz', r => r.fulfill(gz(fx('atlas-uqt.json.gz'))));
  await page.route('**/hominiscanidae/data/homi-albums.json.gz', r => r.fulfill(gz(fx('atlas-homi.json.gz'))));
  await page.route('**/capa-min.jpg', r => r.fulfill({ status: 404 }));
  await page.goto(url);
  const semGL = await page.evaluate(() => !document.createElement('canvas').getContext('webgl'));
  test.skip(semGL, 'este navegador não tem WebGL em modo headless; o mapa precisa dele');
  await page.evaluate(() => window.__atlas.pronto);
}
const tour = page => page.evaluate(() => window.__atlasTour.estado());
const estado = page => page.evaluate(() => window.__atlas.estado());

test('▶ Tour fica ativo quando o mapa carrega, começa pela abertura com os totais contados e dura 2 minutos', async ({ page }) => {
  await boot(page);
  const btn = page.locator('#btn-tour');
  await expect(btn).toBeEnabled();
  expect((await tour(page)).total).toBe(120);
  await btn.click();
  await expect(page.locator('body')).toHaveClass(/em-tour/);
  await expect(page.locator('#tour')).toBeVisible();
  await expect(page.locator('#tour-kicker')).toHaveText('atlas');
  const n = (await estado(page)).n;
  await expect(page.locator('#tour-linha')).toContainText(`${n} faixas`);
  expect(await tour(page)).toMatchObject({ ativo: true, cena: 'abertura' });
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
});

test('Esc encerra e devolve mapa, busca, endereço e câmera; o tour não escreve no endereço', async ({ page }) => {
  await boot(page, '/atlas?mapa=rotulos&q=Alfa');
  await expect(page.locator('#busca')).toHaveValue('Alfa');
  const antes = await estado(page);
  await page.locator('#btn-tour').click();
  // o tour começa do mapa limpo: Som, sem busca
  await expect.poll(async () => (await estado(page)).mapa).toBe('som');
  await expect(page.locator('#busca')).toHaveValue('');
  await page.waitForTimeout(700);
  expect(new URL(page.url()).search).toBe('');
  await page.keyboard.press('g');                          // as teclas do mapa ficam paradas
  expect((await page.evaluate(() => window.__atlas.grafo())).aberto).toBe(false);
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).not.toHaveClass(/em-tour/);
  await expect(page.locator('#tour')).toBeHidden();
  expect((await tour(page)).ativo).toBe(false);
  await expect(page.locator('#busca')).toHaveValue('Alfa');
  await expect.poll(async () => (await estado(page)).mapa).toBe('rotulos');
  const depois = await estado(page);
  expect(depois.k).toBeCloseTo(antes.k, 3);
  expect(depois.cx).toBeCloseTo(antes.cx, 5);
  expect(depois.cy).toBeCloseTo(antes.cy, 5);
  await page.waitForTimeout(500);
  expect(new URL(page.url()).searchParams.get('mapa')).toBe('rotulos');
  expect(new URL(page.url()).searchParams.get('q')).toBe('Alfa');
});

test('✕ esc também encerra', async ({ page }) => {
  await boot(page);
  await page.locator('#btn-tour').click();
  await page.locator('#tour-sair').click();
  await expect(page.locator('body')).not.toHaveClass(/em-tour/);
});

test('?tour=1 começa sozinho e sai do endereço; &t= começa na cena daquele segundo', async ({ page }) => {
  await boot(page, '/atlas?tour=1&t=76&acervo=uqt');
  await expect.poll(async () => (await tour(page)).cena).toBe('som-generos');
  const u = new URL(page.url());
  expect(u.searchParams.has('tour')).toBe(false);
  expect(u.searchParams.has('t')).toBe(false);
  const t = (await tour(page)).t;
  expect(t).toBeGreaterThanOrEqual(75);
  expect(t).toBeLessThan(80);
  // depois do Esc o acervo do endereço volta
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  expect(new URL(page.url()).searchParams.get('acervo')).toBe('uqt');
});

test('com Sonificar desligado, o tour o liga no clique e o desliga ao encerrar', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('tocador-atlas-musica', '0'));
  await boot(page);
  const som = () => page.evaluate(() => window.__atlas.som());
  expect((await som(page)).vontade).toBe(false);
  await page.locator('#btn-tour').click();
  await expect.poll(async () => (await som(page)).vontade).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await som(page)).vontade).toBe(false);
  expect(await page.evaluate(() => localStorage.getItem('tocador-atlas-musica'))).toBe('0');
});
