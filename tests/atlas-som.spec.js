// A música do /atlas (js/atlas-som.js): quando soa, quando cala e o que a câmera escolhe. O áudio em si é medido
// renderizando com OfflineAudioContext; `__atlas.som().rms` lê o que sairia nas caixas.
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const fx = n => fs.readFileSync(path.join(__dirname, 'fixtures', n));
const gz = body => ({ status: 200, headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' }, body });

test.use({ serviceWorkers: 'block' });

async function boot(page) {
  await page.route('**/data/atlas-faixas.json.gz', r => r.fulfill(gz(fx('atlas-faixas-teste.json.gz'))));
  await page.route('**/data/atlas-artistas.json.gz', r => r.fulfill({ status: 404 }));
  await page.route('**/data/*-features.json.gz', r => r.fulfill({ status: 404 }));
  await page.route('**/uqt/data/uqt-albums.json.gz', r => r.fulfill(gz(fx('atlas-uqt.json.gz'))));
  await page.route('**/hominiscanidae/data/homi-albums.json.gz', r => r.fulfill(gz(fx('atlas-homi.json.gz'))));
  await page.route('**/capa-min.jpg', r => r.fulfill({ status: 404 }));
  await page.goto('/atlas.html');
  await page.evaluate(() => window.__atlas.pronto);
}
const som = page => page.evaluate(() => window.__atlas.som());
const soando = page => expect.poll(async () => (await som(page)).rms, { timeout: 6000 }).toBeGreaterThan(0.001);
const calado = page => expect.poll(async () => (await som(page)).rms, { timeout: 6000 }).toBeLessThan(0.0005);
const previa = (page, ev) => page.evaluate(e => document.getElementById('previa').dispatchEvent(new Event(e)), ev);
const aba = (page, msg) => page.evaluate(m => { const c = new BroadcastChannel('tocador-som'); c.postMessage(m); c.close(); }, msg);

test('liga por padrão no primeiro gesto, e a roda do mouse sozinha não conta', async ({ page }) => {
  await boot(page);
  const b = page.locator('#btn-musica');
  await expect(b).toHaveAttribute('aria-pressed', 'true');
  expect((await som(page)).contexto).toBeNull();
  await page.mouse.move(400, 300);
  await page.mouse.wheel(0, -200);
  expect((await som(page)).contexto).toBeNull();
  await page.keyboard.press('+');
  await soando(page);
  expect((await som(page)).contexto).toBe('running');
});

test('♪ desliga, guarda a escolha e a tecla M faz o mesmo', async ({ page }) => {
  await boot(page);
  await page.locator('#btn-musica').click();     // o primeiro clique no botão já é a escolha: nada chega a tocar
  await expect(page.locator('#btn-musica')).toHaveAttribute('aria-pressed', 'false');
  expect((await som(page)).audivel).toBe(false);
  await page.reload();
  await page.evaluate(() => window.__atlas.pronto);
  await page.keyboard.press('+');
  await expect(page.locator('#btn-musica')).toHaveAttribute('aria-pressed', 'false');
  expect((await som(page)).audivel).toBe(false);
  await page.keyboard.press('m');
  await expect(page.locator('#btn-musica')).toHaveAttribute('aria-pressed', 'true');
  await soando(page);
});

test('a prévia cala a música, que volta quando ela para', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('+');
  await soando(page);
  await previa(page, 'play');
  await calado(page);
  await previa(page, 'pause');
  await soando(page);
});

test('♪ também para uma prévia que esteja tocando', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('+');
  await page.evaluate(() => {
    const a = document.getElementById('previa');
    Object.defineProperty(a, 'paused', { configurable: true, get: () => false });
    a.pause = () => { window.pausou = true; delete a.paused; };
  });
  await page.locator('#btn-musica').click();
  expect(await page.evaluate(() => window.pausou)).toBe(true);
  await expect(page.locator('#btn-musica')).toHaveAttribute('aria-pressed', 'false');
});

test('outra aba do tocador tocando deixa em espera, e clicar em ♪ ouve assim mesmo', async ({ page, context }) => {
  await boot(page);
  const outra = await context.newPage();
  await outra.goto('/atlas.html');
  await aba(outra, { id: 'player', tocando: true });
  const b = page.locator('#btn-musica');
  await expect(b).toHaveAttribute('aria-pressed', 'false');
  await expect(b).toHaveClass(/espera/);
  await page.keyboard.press('+');
  expect((await som(page)).audivel).toBe(false);
  await b.click();
  await expect(b).toHaveAttribute('aria-pressed', 'true');
  expect((await som(page)).espera).toBe(false);
  await aba(outra, { id: 'player', tocando: false });
  await expect(b).not.toHaveClass(/espera/);
  await outra.close();
});

test('o player responde à pergunta de quem abre o atlas depois', async ({ page, context }) => {
  await page.goto('/atlas.html');
  await page.evaluate(() => {
    const a = document.createElement('audio');
    Object.defineProperty(a, 'paused', { get: () => false });
    window.anunciarSom(a);
    window.__tocando = a;
  });
  const atlas = await context.newPage();
  await boot(atlas);
  await expect(atlas.locator('#btn-musica')).toHaveClass(/espera/);
  await atlas.close();
});

test('a música segue o que está à vista, e o filtro muda o que se ouve', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('+');
  const nomes = async () => (await som(page)).vozes.filter(v => v.peso > 0).map(v => v.nome);
  await expect.poll(async () => (await som(page)).regente).toBeTruthy();
  await page.locator('[data-acervo="uqt"]').click();           // no fixture, a uqt é toda samba
  await expect.poll(nomes).toEqual(['samba']);
  await expect.poll(async () => (await som(page)).regente, { timeout: 8000 }).toBe('samba');
  await page.locator('[data-acervo="homi"]').click();          // e a homi é punk e techno
  await expect.poll(async () => (await nomes()).sort()).toEqual(['punk', 'techno']);
  await page.fill('#busca', 'zzzzzz');                         // nada aceso: só resta o vento
  await expect.poll(nomes).toEqual([]);
});

test('longe só a cama; perto entram baixo, ritmo, acordes e melodia', async ({ page }) => {
  await boot(page);
  const c = await page.evaluate(() => [camadasSom(1), camadasSom(3), camadasSom(12)]);
  expect(c[0]).toMatchObject({ perc: 0, acorde: 0, mel: 0 });
  expect(c[0].cama).toBe(1);
  expect(c[1].perc).toBeGreaterThan(0.5);
  expect(c[1].mel).toBe(0);
  expect(c[2].mel).toBe(1);
  expect(await page.evaluate(() => filtroSom(1) < 500 && filtroSom(12) > 3000)).toBe(true);
});

test('toda família soa sem saturar, e dois gêneros dividem o mesmo relógio', async ({ page }) => {
  test.setTimeout(60000);
  await boot(page);
  const r = await page.evaluate(async () => {
    const seg = 5, sr = 22050;
    async function render(fatias) {
      const ac = new OfflineAudioContext(2, seg * sr, sr), m = criarMotorSom(ac);
      m.saida.gain.value = 1;
      m.definir({ fatias, camadas: camadasSom(20), cam: filtroSom(20), sala: 0.3 }, true);
      m.avancar(seg - 0.5);
      const e = m.estado(), d = (await ac.startRendering()).getChannelData(0);
      let pk = 0, soma = 0;
      for (const x of d) { pk = Math.max(pk, Math.abs(x)); soma += x * x; }
      return { pk, rms: Math.sqrt(soma / d.length), ...e };
    }
    const fam = {};
    for (const f of RECEITAS_ATLAS.familias) fam[f] = await render([{ nome: f, peso: 1 }]);
    return { fam, mistura: await render([{ nome: 'samba', peso: 0.55 }, { nome: 'punk', peso: 0.45 }]) };
  });
  for (const [nome, x] of Object.entries(r.fam)) {
    expect(x.pk, nome).toBeLessThanOrEqual(1);
    expect(x.rms, nome).toBeGreaterThan(0.03);
    expect(x.rms, nome).toBeLessThan(0.3);
    expect(x.regente).toBe(nome);
  }
  expect(r.mistura.regente).toBe('samba');
  expect(r.mistura.vozes.find(v => v.nome === 'punk').mult).toBe(2);   // punk ~ o dobro do samba: grade dobrada, não outro tempo
});

test('receitas: padrões do tamanho da grade e nenhum rótulo sem família', async ({ page }) => {
  await boot(page);
  const erros = await page.evaluate(() => {
    const R = RECEITAS_ATLAS, e = [];
    for (const f of R.familias) {
      const r = R.receita(f);
      if (96 % r.passos) e.push(`${f}: passos`);
      for (const p of [...Object.values(r.perc), r.baixo?.p, r.acorde?.p, r.mel?.r]) if (p && p.length % r.passos) e.push(`${f}: ${p}`);
      if (!r.escalaNotas) e.push(`${f}: escala`);
    }
    for (const g of ['Latin---Samba', 'Latin---Coisa Nova', 'Rock---Punk', 'Blues---Delta Blues', 'Non-Music---Poetry', 'Stage & Screen---Score']) if (!R.receita(R.familiaDe(g))) e.push(g);
    return e;
  });
  expect(erros).toEqual([]);
  expect(await page.evaluate(() => [RECEITAS_ATLAS.familiaDe('Latin---Samba'), RECEITAS_ATLAS.familiaDe('Jazz---Bossa Nova'), RECEITAS_ATLAS.familiaDe('Reggae---Inexistente')]))
    .toEqual(['samba', 'bossa', 'reggae']);
});
