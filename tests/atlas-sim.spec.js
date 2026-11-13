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

test('Sonificar, ZigZag e Simulação formam um grupo nos controles, nessa ordem, com ícones', async ({ page }) => {
  await boot(page);
  const grupo = page.locator('#controles > .seg[aria-label="Som"]');
  await expect(grupo.locator('#btn-sim svg use')).toHaveAttribute('href', '#i-banda');
  expect(await grupo.locator('button').evaluateAll(bs => bs.map(b => b.id))).toEqual(['btn-musica', 'btn-zigue', 'btn-sim']);
  await expect(page.locator('.seg[aria-label="Visualização"] #btn-zigue')).toHaveCount(0);
});

test('instrumentos num painel recolhível no alto do cartão: fechado não calcula nada; aberto mostra a parte de cada um', async ({ page }) => {
  await boot(page);
  await page.locator('#btn-sim').click();
  await expect.poll(() => sim(page)).not.toBeNull();
  const painel = page.locator('#sim-instrumentos');
  await expect(painel).not.toHaveAttribute('open', '');
  // fechado: as notas não são somadas
  for (let k = 0; k < 3; k++) await nota(page, { papel: 'pandeiro', familia: 'samba', vel: 0.8 });
  await expect.poll(async () => (await sim(page)).musicos.length).toBe(1);
  expect((await sim(page)).instCalculados).toBe(0);
  // o painel fica acima do palco
  const [p0, palco] = await Promise.all([painel.boundingBox(), page.locator('#sim-palco').boundingBox()]);
  expect(p0.y + p0.height).toBeLessThanOrEqual(palco.y + 1);
  // aberto: começa ouvindo e calcula a parte de cada um
  await painel.locator('summary').click();
  await expect(page.locator('#sim-instrumentos-lista .ouvindo')).toBeVisible();
  for (let k = 0; k < 6; k++) await nota(page, { papel: 'pandeiro', familia: 'samba', vel: 0.8 });
  await nota(page, { papel: 'mel', familia: 'samba', vel: 0.2, timbre: 'cavaco' });
  const lista = page.locator('#sim-instrumentos-lista li:not(.ouvindo)');
  await expect(lista.first()).toContainText('pandeiro');
  await expect(page.locator('#sim-instrumentos-lista')).toContainText('cavaquinho');
  const partes = await lista.evaluateAll(lis => lis.map(li => +li.querySelector('b').textContent.replace('%', '')));
  expect(partes[0]).toBeGreaterThan(partes[1]);
  const soma = partes.reduce((a, b) => a + b, 0);
  expect(soma).toBeGreaterThanOrEqual(98);
  expect(soma).toBeLessThanOrEqual(102);
  // fechar para de calcular e lembra a escolha ao reabrir a banda
  await painel.locator('summary').click();
  await expect.poll(async () => (await sim(page)).instCalculados).toBe(0);
  await painel.locator('summary').click();
  await page.locator('#sim-sair').click();
  await page.locator('#btn-sim').click();
  await expect.poll(() => sim(page)).not.toBeNull();
  await expect(painel).toHaveAttribute('open', '');
});

test('no desktop o cartão se move pela faixa de cima, se redimensiona pelo canto e lembra o lugar', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await boot(page);
  await page.locator('#btn-sim').click();
  await expect.poll(() => sim(page)).not.toBeNull();
  const caixa = () => page.locator('#sim').boundingBox();
  const a = await caixa();
  // mover: arrasta a faixa de cima (numa parte sem botão)
  const topo = await page.locator('#sim-topo').boundingBox();
  await page.mouse.move(topo.x + 30, topo.y + topo.height - 4);
  await page.mouse.down();
  await page.mouse.move(topo.x + 230, topo.y + topo.height + 96, { steps: 6 });
  await page.mouse.up();
  const b = await caixa();
  expect(b.x - a.x).toBeGreaterThan(180);
  expect(b.y - a.y).toBeGreaterThan(80);
  // redimensionar: o canto de baixo à direita
  const canto = await page.locator('#sim-redim').boundingBox();
  await page.mouse.move(canto.x + 9, canto.y + 9);
  await page.mouse.down();
  await page.mouse.move(canto.x + 129, canto.y + 89, { steps: 6 });
  await page.mouse.up();
  const c = await caixa();
  expect(c.width - b.width).toBeGreaterThan(100);
  expect(c.height - b.height).toBeGreaterThan(60);
  // fecha e reabre: volta onde estava, do tamanho que estava
  await page.locator('#sim-sair').click();
  await page.locator('#btn-sim').click();
  await expect.poll(() => sim(page)).not.toBeNull();
  const d = await caixa();
  expect(Math.abs(d.x - c.x)).toBeLessThan(3);
  expect(Math.abs(d.width - c.width)).toBeLessThan(3);
  // duplo clique na faixa de cima: lugar e tamanho padrão
  await page.mouse.dblclick(topo.x + 230, topo.y + topo.height + 92);
  await expect.poll(async () => Math.round((await caixa()).width)).toBe(Math.round(a.width));
});

test('a banda só escuta: abrir e deixar aberta não move o mapa nem muda o que a música toca', async ({ page }) => {
  test.slow();
  await boot(page);
  const cam = () => page.evaluate(() => { const c = window.__atlas.camera(); return [c.cx, c.cy, c.k].map(v => +v.toFixed(6)); });
  const antes = await cam();
  await page.locator('#btn-sim').click();
  await expect.poll(() => sim(page)).not.toBeNull();
  await page.waitForTimeout(3000);
  expect(await cam()).toEqual(antes);
  await page.locator('#sim-sair').click();
  expect(await cam()).toEqual(antes);
});

test('a câmera não corta nem para: desliza e vai até o instrumento que acabou de entrar', async ({ page }) => {
  test.slow();
  await boot(page);
  await page.locator('#btn-sim').click();
  await expect.poll(() => sim(page)).not.toBeNull();
  await nota(page, { papel: 'surdo', familia: 'samba', vel: 0.7 });
  await expect.poll(async () => (await sim(page)).musicos.length).toBe(1);
  await page.waitForTimeout(3300);         // a câmera não troca de foco antes de 3 s: nada de correria
  // um instrumento novo: a câmera vai até ele
  await nota(page, { papel: 'mel', familia: 'samba', vel: 0.5, timbre: 'flauta' });
  await expect.poll(async () => (await sim(page)).foco, { timeout: 4000 }).toBe('samba|mel|flauta');
  // amostras seguidas da posição: sempre mexendo, e nunca um salto (corte)
  const pos = await page.evaluate(async () => {
    const out = [];
    for (let k = 0; k < 40; k++) { out.push(window.__atlasSim.estado().cam); await new Promise(r => requestAnimationFrame(r)); }
    return out;
  });
  const passos = pos.slice(1).map((p, i) => Math.hypot(p[0] - pos[i][0], p[1] - pos[i][1], p[2] - pos[i][2]));
  expect(Math.max(...passos)).toBeLessThan(0.5);
  expect(passos.reduce((a, b) => a + b, 0)).toBeGreaterThan(0.01);
});

test('com uma prévia tocando, a banda toca a faixa: os instrumentos da análise dela, no ritmo do mp3', async ({ page }) => {
  test.slow();
  await boot(page);
  await page.locator('#btn-sim').click();
  await expect.poll(() => sim(page)).not.toBeNull();
  // uma prévia simulada: um <audio> que avança no tempo, com a análise da faixa (sem captureStream: o ritmo vem do bpm)
  await page.evaluate(() => {
    const t0 = performance.now();
    const el = { paused: false, readyState: 4, get currentTime() { return (performance.now() - t0) / 1000; } };
    window.__atlas.previaAtual = () => ({ el, i: 7, titulo: 'Faixa de teste', familia: 'samba', bpm: 120, analisada: true,
      instrumentos: [{ name: 'drums', p: 0.5 }, { name: 'acousticguitar', p: 0.3 }, { name: 'voice', p: 0.2 }] });
  });
  await expect.poll(async () => (await sim(page)).musicos.map(m => m.chave).sort()).toEqual(['samba|acorde|violao', 'samba|mel|voz', 'samba|perc']);
  await expect(page.locator('#sim-legenda')).toContainText('Prévia: Faixa de teste');
  await expect(page.locator('#sim-legenda')).toContainText('120 bpm');
  // os golpes seguem o tempo: o percussionista prepara e bate
  await expect.poll(async () => (await sim(page)).previa?.vozes.length).toBe(3);
  const b0 = (await sim(page)).batida;
  await page.waitForTimeout(1000);
  expect((await sim(page)).batida - b0).toBeGreaterThan(1.5);       // 120 bpm: ~2 tempos por segundo
  // a prévia parou: a banda volta a ouvir a sonificação
  await page.evaluate(() => { window.__atlas.previaAtual = () => null; });
  await expect.poll(async () => (await sim(page)).previa).toBeNull();
});

test('caixa e chimbal trazem a bateria, pandeiro vai na mão, e a flauta fica presa na boca', async ({ page }) => {
  await boot(page);
  await page.locator('#btn-sim').click();
  await expect.poll(() => sim(page)).not.toBeNull();
  await nota(page, { papel: 'pandeiro', familia: 'samba', vel: 0.6 });
  await nota(page, { papel: 'caixa', familia: 'rock', vel: 0.8 });
  await nota(page, { papel: 'mel', familia: 'jazz', vel: 0.5, timbre: 'flauta' });
  await expect.poll(async () => (await sim(page)).musicos.length).toBe(3);
  const por = Object.fromEntries((await sim(page)).musicos.map(m => [m.chave, m]));
  expect(por['rock|perc'].kit).toBe(true);
  expect(por['samba|perc'].kit).toBe(false);
  expect(por['samba|perc'].pandeiro).toBe(true);
  expect(por['jazz|mel|flauta'].pose).toBe('flauta');
});

test('com um cantor no palco, a câmera faz dele a estrela de vez em quando', async ({ page }) => {
  test.slow();
  await boot(page);
  await page.locator('#btn-sim').click();
  await expect.poll(() => sim(page)).not.toBeNull();
  await page.evaluate(() => { Math.random = () => 0.1; });     // o sorteio sempre favorece o cantor
  await nota(page, { papel: 'mel', familia: 'mpb', vel: 0.5, timbre: 'voz' });
  await nota(page, { papel: 'acorde', familia: 'mpb', vel: 0.5, timbre: 'violao' });
  // mantém a banda tocando enquanto a câmera escolhe
  const tocar = setInterval(() => { nota(page, { papel: 'acorde', familia: 'mpb', vel: 0.6, timbre: 'violao' }).catch(() => {}); nota(page, { papel: 'mel', familia: 'mpb', vel: 0.4, timbre: 'voz' }).catch(() => {}); }, 400);
  try {
    await expect.poll(async () => { const e = await sim(page); return e.foco === 'mpb|mel|voz' && e.estrela; }, { timeout: 25000 }).toBe(true);
  } finally { clearInterval(tocar); }
});

test('no celular o cartão também se arrasta (para cima e para baixo, já que tem a largura da tela)', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  try {
    await boot(page);
    await page.locator('#btn-sim').click();
    await expect.poll(() => sim(page)).not.toBeNull();
    const a = await page.locator('#sim').boundingBox();
    const topo = await page.locator('#sim-topo').boundingBox();
    const x = topo.x + 40, y = topo.y + topo.height - 6;
    await page.locator('#sim-topo').dispatchEvent('pointerdown', { pointerType: 'touch', clientX: x, clientY: y, button: 0, isPrimary: true });
    await page.evaluate(([x, y]) => window.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'touch', clientX: x, clientY: y + 160, isPrimary: true })), [x, y]);
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', isPrimary: true })));
    const b = await page.locator('#sim').boundingBox();
    expect(b.y - a.y).toBeGreaterThan(120);
    expect(Math.abs(b.x - a.x)).toBeLessThan(2);
  } finally { await ctx.close(); }
});

test('percussão de mão em 3D e cabelos por gênero', async ({ page }) => {
  await boot(page);
  await page.locator('#btn-sim').click();
  await expect.poll(() => sim(page)).not.toBeNull();
  for (let k = 0; k < 3; k++) await nota(page, { papel: 'tamborim', familia: 'samba', vel: 0.6 });
  for (let k = 0; k < 3; k++) await nota(page, { papel: 'ganza', familia: 'forro', vel: 0.6 });
  await nota(page, { papel: 'acorde', familia: 'rock', vel: 0.5, timbre: 'guitarra' });
  await expect.poll(async () => (await sim(page)).musicos.length).toBe(3);
  const por = Object.fromEntries((await sim(page)).musicos.map(m => [m.chave, m]));
  expect(por['samba|perc'].mao).toBe('tamborim');
  expect(por['forro|perc'].mao).toBe('ganza');
  expect(por['samba|perc'].pose).toBe('mao');            // sem surdo nem bumbo, o surdo sai de cena
  expect(typeof por['rock|acorde|guitarra'].penteado).toBe('string');
});

test('ao lado do ✕, ampliar leva a banda à janela inteira (com margem); de novo ou Esc volta ao cartão', async ({ page }) => {
  await boot(page);
  await page.locator('#btn-sim').click();
  await expect.poll(() => sim(page)).not.toBeNull();
  const caixa = () => page.locator('#sim').boundingBox();
  const antes = await caixa(), vp = page.viewportSize();
  const btn = page.locator('#sim-ampliar');
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await caixa()).width).toBeGreaterThan(vp.width - 40);
  const amp = await caixa();
  expect(amp.x).toBeGreaterThan(0);                       // não é a tela cheia: sobra uma margem
  expect(amp.height).toBeGreaterThan(vp.height - 40);
  // o palco cresce junto (o canvas acompanha)
  await expect.poll(() => page.locator('#sim-canvas').evaluate(c => c.clientHeight)).toBeGreaterThan(vp.height * 0.6);
  await btn.click();
  await expect.poll(async () => Math.round((await caixa()).width)).toBe(Math.round(antes.width));
  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');                     // o primeiro Esc só reduz
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#sim')).toBeVisible();
  await page.locator('#sim-sair').focus();               // fora do modo ampliado, Esc fecha só com o foco na banda
  await page.keyboard.press('Escape');
  await expect(page.locator('#sim')).toBeHidden();
});

test('palco vazio: a câmera fica parada onde estava, sem passear pelo cenário', async ({ page }) => {
  await boot(page);
  await page.locator('#btn-sim').click();
  await expect.poll(() => sim(page)).not.toBeNull();
  // sem ninguém, a câmera não dá a volta pelo cenário: só se assenta de frente, no eixo do palco
  for (let i = 0; i < 6; i++) {
    expect(Math.abs((await sim(page)).cam[0])).toBeLessThan(0.05);
    await page.waitForTimeout(500);
  }
});
