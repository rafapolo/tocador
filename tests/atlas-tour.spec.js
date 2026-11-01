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

test('▶ Tour fica ativo quando o mapa carrega, começa pela abertura com os totais contados e dura 1 minuto', async ({ page }) => {
  await boot(page);
  const btn = page.locator('#btn-tour');
  await expect(btn).toBeEnabled();
  expect((await tour(page)).total).toBe(60);
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
  await boot(page, '/atlas?tour=1&t=42&acervo=uqt');
  await expect.poll(async () => (await tour(page)).cena).toBe('som-generos');
  const u = new URL(page.url());
  expect(u.searchParams.has('tour')).toBe(false);
  expect(u.searchParams.has('t')).toBe(false);
  const t = (await tour(page)).t;
  expect(t).toBeGreaterThanOrEqual(41);
  expect(t).toBeLessThan(45);
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

test('durante o tour o visor da sonificação vai para a barra preta, e volta ao mapa no fim', async ({ page }) => {
  await boot(page);
  const pai = () => page.evaluate(() => document.getElementById('visor-som').parentElement.id);
  expect(await pai()).toBe('atlas');
  await page.locator('#btn-tour').click();
  await expect.poll(pai).toBe('tour');
  await page.keyboard.press('Escape');
  await expect.poll(pai).toBe('atlas');
});

test('a câmera nunca fica parada mais de 8 s no mesmo lugar (aqui, abertura e Sonificar)', async ({ page }) => {
  test.setTimeout(40_000);
  await boot(page);
  await page.locator('#btn-tour').click();
  await expect(page.locator('body')).toHaveClass(/em-tour/);
  const parada = await page.evaluate(async () => {
    let ultima = '', desde = performance.now(), maior = 0;
    const fim = performance.now() + 13_000;
    while (performance.now() < fim) {
      const c = window.__atlas.estado();
      const a = [c.cx, c.cy, c.k, c.yaw, c.pitch].map(v => (+v).toFixed(6)).join();
      const agora = performance.now();
      if (a !== ultima) { ultima = a; desde = agora; }
      maior = Math.max(maior, agora - desde);
      await new Promise(r => setTimeout(r, 200));
    }
    return maior;
  });
  expect(parada).toBeLessThan(8000);
});

test('a travessia vai de uma ponta à outra do mapa, de um macro-gênero a outro, parando nos lugares do caminho', async ({ page }) => {
  await boot(page);
  const T = await page.evaluate(() => window.__atlasTour.dados().trav);
  test.skip(!T, 'o mapa de teste não tem lugares grandes o bastante');
  expect(T.length).toBeGreaterThanOrEqual(2);
  expect(T[0].macro).not.toBe(T[T.length - 1].macro);
  const d = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  // as paradas vão se afastando do começo, em ordem
  for (let j = 1; j < T.length; j++) expect(d(T[j], T[0])).toBeGreaterThan(d(T[j - 1], T[0]) - 0.05);
});
