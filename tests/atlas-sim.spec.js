// A banda em 3D do /atlas (js/atlas-sim.js): ?sim=1 pede um clique, os músicos entram com as notas que o motor de
// som agenda e saem quando a voz se cala, e Esc fecha. three.js vem de node_modules, nunca do jsdelivr.
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const fx = n => fs.readFileSync(path.join(__dirname, 'fixtures', n));
const gz = body => ({ status: 200, headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' }, body });
const three = n => fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'three', 'build', n));

test.use({ serviceWorkers: 'block' });

async function boot(page, url = '/atlas') {
  await page.route('**/data/atlas-faixas.json.gz', r => r.fulfill(gz(fx('atlas-faixas-teste.json.gz'))));
  await page.route('**/data/atlas-artistas.json.gz', r => r.fulfill({ status: 404 }));
  await page.route('**/data/*-features.json.gz', r => r.fulfill({ status: 404 }));
  await page.route('**/uqt/data/uqt-albums.json.gz', r => r.fulfill(gz(fx('atlas-uqt.json.gz'))));
  await page.route('**/hominiscanidae/data/homi-albums.json.gz', r => r.fulfill(gz(fx('atlas-homi.json.gz'))));
  await page.route('**/capa-min.jpg', r => r.fulfill({ status: 404 }));
  await page.route('https://cdn.jsdelivr.net/npm/three@*/build/*.js', r => {
    const n = r.request().url().split('/').pop();
    r.fulfill({ status: 200, headers: { 'Content-Type': 'text/javascript' }, body: three(n) });
  });
  await page.goto(url);
  const semGL = await page.evaluate(() => !document.createElement('canvas').getContext('webgl'));
  test.skip(semGL, 'este navegador não tem WebGL em modo headless; o mapa precisa dele');
  await page.evaluate(() => window.__atlas.pronto);
  // só as notas que o teste manda (__atlasSim.nota): o motor de verdade, que toca no headless, traria outros músicos
  await page.evaluate(() => { window.__atlas.ouvirBanda = () => true; });
}
const sim = page => page.evaluate(() => window.__atlasSim.estado());
const nota = (page, e, adiante = 0) => page.evaluate(([e, a]) => window.__atlasSim.nota({ ...e, t: window.__atlas.ouvidoSom() + a }), [e, adiante]);

test('?sim=1 pede o clique, sai do endereço e abre o palco; Esc fecha', async ({ page }) => {
  await boot(page, '/atlas?sim=1');
  await expect.poll(() => new URL(page.url()).searchParams.has('sim')).toBe(false);
  if (await page.evaluate(() => !!window.__atlas.som())) {
    await expect(page.locator('#sim-convite')).toBeVisible();
    await page.locator('#sim-convite button').click();
  }
  await expect(page.locator('#sim')).toBeVisible();
  await expect.poll(() => sim(page)).not.toBeNull();
  await page.keyboard.press('Escape');
  await expect(page.locator('#sim')).toBeHidden();
  expect(await sim(page)).toBeNull();
});

test('cada voz vira um músico com o instrumento do timbre, e a percussão junta as peças que tocou', async ({ page }) => {
  await boot(page);
  await page.locator('#btn-sim').click();
  await expect.poll(() => sim(page)).not.toBeNull();
  const fam = 'samba';
  await nota(page, { papel: 'mel', familia: fam, vel: 0.5, timbre: 'cavaco' });
  await nota(page, { papel: 'baixo', familia: fam, vel: 0.5, timbre: 'violao7' });
  await nota(page, { papel: 'pandeiro', familia: fam, vel: 0.6 });
  await nota(page, { papel: 'surdo', familia: fam, vel: 0.6 });
  await nota(page, { papel: 'mel', familia: 'rock', vel: 0.5, timbre: 'dist' });
  await expect.poll(async () => (await sim(page)).musicos.length).toBe(4);
  const ms = (await sim(page)).musicos;
  const por = Object.fromEntries(ms.map(m => [m.chave.split('|').slice(0, 2).join('|'), m]));
  expect(por['samba|mel'].timbre).toBe('cavaco');
  expect(por['samba|baixo'].timbre).toBe('violao7');
  expect(por['samba|perc'].pecas.sort()).toEqual(['pandeiro', 'surdo']);
  expect(por['rock|mel'].timbre).toBe('dist');
  await expect(page.locator('#sim-vazio')).toBeHidden();
  await expect(page.locator('#sim-legenda')).not.toBeEmpty();
});

test('quem para de tocar sai do palco depois de alguns segundos', async ({ page }) => {
  test.slow();
  await boot(page);
  await page.locator('#btn-sim').click();
  await expect.poll(() => sim(page)).not.toBeNull();
  await nota(page, { papel: 'acorde', familia: 'bossa', vel: 0.5, timbre: 'violao' });
  await expect.poll(async () => (await sim(page)).musicos.length).toBe(1);
  await expect.poll(async () => (await sim(page)).musicos.length, { timeout: 12000 }).toBe(0);
});

test('com o palco aberto o T não começa o tour; fechar e abrir de novo monta outro palco', async ({ page }) => {
  const erros = [];
  page.on('pageerror', e => erros.push(e.message));
  await boot(page);
  await page.locator('#btn-sim').click();
  await expect.poll(() => sim(page)).not.toBeNull();
  await page.keyboard.press('t');
  expect(await page.evaluate(() => window.__atlasTour.estado().ativo)).toBe(false);
  await page.keyboard.press('Escape');
  await expect(page.locator('#sim')).toBeHidden();
  await page.locator('#btn-sim').click();
  await expect.poll(() => sim(page)).not.toBeNull();
  await nota(page, { papel: 'mel', familia: 'jazz', vel: 0.5, timbre: 'sopro' });
  await expect.poll(async () => (await sim(page)).musicos.length).toBe(1);
  expect(erros).toEqual([]);
});

test('o Sonificar desligado volta a ficar desligado ao fechar o palco, mesmo com Esc antes do 3D carregar', async ({ page }) => {
  await boot(page);
  await page.route('https://cdn.jsdelivr.net/npm/three@*/build/three.module.js', async r => {
    await new Promise(res => setTimeout(res, 800));      // o Esc chega antes do three.js
    r.fallback();
  });
  test.skip(!(await page.evaluate(() => !!window.__atlas.som())), 'sem Web Audio');
  await page.evaluate(() => window.__atlas.querSom(false));
  await page.locator('#btn-sim').click();
  await expect.poll(async () => (await page.evaluate(() => window.__atlas.som().vontade))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('#sim')).toBeHidden();
  await expect.poll(async () => (await page.evaluate(() => window.__atlas.som().vontade))).toBe(false);
  await page.waitForTimeout(1000);                     // o three.js chegou depois: o palco não reabre
  await expect(page.locator('#sim')).toBeHidden();
  expect(await sim(page)).toBeNull();
});

test('no máximo 8 músicos: quem trocou de instrumento sai, e com o palco cheio a voz nova entra no lugar de quem calou', async ({ page }) => {
  test.slow();
  await boot(page);
  await page.locator('#btn-sim').click();
  await expect.poll(() => sim(page)).not.toBeNull();
  await nota(page, { papel: 'mel', familia: 'choro', vel: 0.5, timbre: 'cavaco' });
  await expect.poll(async () => (await sim(page)).musicos.map(m => m.timbre)).toEqual(['cavaco']);
  await nota(page, { papel: 'mel', familia: 'choro', vel: 0.5, timbre: 'flauta' });
  await expect.poll(async () => (await sim(page)).musicos.map(m => m.timbre)).toEqual(['flauta']);
  const fams = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  for (const f of fams) await nota(page, { papel: 'acorde', familia: f, vel: 0.5, timbre: 'violao' });
  await expect.poll(async () => (await sim(page)).musicos.length).toBe(8);
  await page.waitForTimeout(1200);       // todos calados há mais de 1 s: a próxima voz pode entrar
  await nota(page, { papel: 'baixo', familia: 'z', vel: 0.5, timbre: 'contrabaixo' });
  await expect.poll(async () => (await sim(page)).musicos.some(m => m.chave === 'z|baixo|contrabaixo')).toBe(true);
  expect((await sim(page)).musicos.length).toBe(8);
});

test('cartão à esquerda: o mapa segue navegável, e o cenário mistura os gêneros pelo peso de quem toca', async ({ page }) => {
  await boot(page);
  await page.locator('#btn-sim').click();
  await expect.poll(() => sim(page)).not.toBeNull();
  const caixa = await page.locator('#sim').boundingBox();
  const vp = page.viewportSize();
  expect(caixa.x).toBeLessThan(40);
  expect(caixa.width).toBeLessThan(vp.width / 2);
  // o mapa ainda responde ao teclado com a banda aberta (o foco saiu do cartão)
  await page.locator('#busca').focus();
  await page.locator('#busca').blur();
  const k0 = (await page.evaluate(() => window.__atlas.estado())).k;
  await page.keyboard.press('+');
  await expect.poll(async () => (await page.evaluate(() => window.__atlas.estado())).k).toBeGreaterThan(k0);
  expect(await sim(page)).not.toBeNull();
  // bossa nova: a praia; entra o samba e a roda aparece junto, cada uma com o seu peso
  for (let k = 0; k < 3; k++) await nota(page, { papel: 'acorde', familia: 'bossa', vel: 0.6, timbre: 'violao' });
  await expect.poll(async () => (await sim(page)).cenarios.praia || 0).toBeGreaterThan(0.5);
  await nota(page, { papel: 'pandeiro', familia: 'samba', vel: 0.6 });
  await expect.poll(async () => (await sim(page)).cenarios.roda || 0).toBeGreaterThan(0.2);
  expect((await sim(page)).cenarios.praia).toBeGreaterThan(0.2);
});

test('no grafo o cartão da banda fica por cima e fecha pelo ✕ ou pelo próprio botão Banda', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('g');
  await expect(page.locator('#grafo')).toBeVisible();
  const banda = page.locator('#btn-sim');
  await banda.click();
  await expect.poll(() => sim(page)).not.toBeNull();
  await expect(banda).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#sim')).toBeVisible();
  await page.locator('#sim-sair').click();                  // o ✕ responde por cima do grafo
  await expect(page.locator('#sim')).toBeHidden();
  await expect(banda).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#grafo')).toBeVisible();       // e o grafo continua lá
  await banda.click();
  await expect.poll(() => sim(page)).not.toBeNull();
  await banda.click();                                      // o botão desliga também
  await expect(page.locator('#sim')).toBeHidden();
  expect(await sim(page)).toBeNull();
});

test('a nota aparece quando sai no alto-falante, e o braço sobe antes dela', async ({ page }) => {
  await boot(page);
  await page.locator('#btn-sim').click();
  await expect.poll(() => sim(page)).not.toBeNull();
  await nota(page, { papel: 'surdo', familia: 'samba', vel: 0.6 });
  await expect.poll(async () => (await sim(page)).musicos.length).toBe(1);
  // uma voz nova daqui a 1,2 s: ainda não está no palco
  await nota(page, { papel: 'mel', familia: 'samba', vel: 0.5, timbre: 'cavaco' }, 1.2);
  await page.waitForTimeout(300);
  expect((await sim(page)).musicos.map(m => m.chave)).toEqual(['samba|perc']);
  await expect.poll(async () => (await sim(page)).musicos.length, { timeout: 4000 }).toBe(2);
  // o percussionista prepara o golpe antes da próxima batida dele
  await nota(page, { papel: 'surdo', familia: 'samba', vel: 0.6 }, 0.6);
  await expect.poll(async () => (await sim(page)).musicos.find(m => m.chave === 'samba|perc').preparo, { timeout: 3000, intervals: [20] }).toBeGreaterThan(0.3);
});

test('a Simulação tem o seu grupo nos controles, com ícone, fora do grupo do Tour', async ({ page }) => {
  await boot(page);
  const grupo = page.locator('#controles > .seg[aria-label="Simulação"]');
  await expect(grupo.locator('#btn-sim svg use')).toHaveAttribute('href', '#i-banda');
  await expect(page.locator('.seg[aria-label="Tour"] #btn-sim')).toHaveCount(0);
  const ordem = await page.evaluate(() => [...document.querySelectorAll('#controles > .seg')].map(g => g.getAttribute('aria-label')));
  expect(ordem.indexOf('Simulação')).toBe(ordem.indexOf('Som') + 1);
});
