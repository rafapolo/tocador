// /atlas: mapa WebGL de faixas. Catálogos e payload vêm de tests/fixtures/build-atlas-fixture.js,
// sem rede. O gancho window.__atlas (js/atlas.js) dá o ponto de uma faixa e onde ele está na tela.
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const fx = n => fs.readFileSync(path.join(__dirname, 'fixtures', n));
const uqtGz = fx('atlas-uqt.json.gz');
const homiGz = fx('atlas-homi.json.gz');
const faixasGz = fx('atlas-faixas-teste.json.gz');
const faixas2dGz = fx('atlas-faixas-2d.json.gz');
const AxeBuilder = require('@axe-core/playwright').default;
const uqt = JSON.parse(zlib.gunzipSync(uqtGz));
const homi = JSON.parse(zlib.gunzipSync(homiGz));
const primeiro = uqt.albums[0];
const recente = uqt.albums[2];
const perigo = homi.albums[2];
const PONTOS = 12;   // faixas do fixture com ponto: o álbum "Recente" fica de fora

// O service worker buscaria os arquivos reais e ignoraria o page.route.
test.use({ serviceWorkers: 'block' });

const gz = body => ({ status: 200, headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' }, body });
async function rotear(page, { faixas = faixasGz } = {}) {
  await page.route('**/data/atlas-faixas.json.gz', r => r.fulfill(gz(faixas)));
  await page.route('**/uqt/data/uqt-albums.json.gz', r => r.fulfill(gz(uqtGz)));
  await page.route('**/hominiscanidae/data/homi-albums.json.gz', r => r.fulfill(gz(homiGz)));
  await page.route('**/capa-min.jpg', r => r.fulfill({ status: 404 }));
  await page.route('**/*.mp3', r => r.fulfill({ status: 200, body: Buffer.alloc(0) }));
}

async function boot(page, { url = '/atlas.html', faixas } = {}) {
  await rotear(page, { faixas });
  await page.goto(url);
  // Sem WebGL a página só avisa e não monta o gancho dos catálogos: o teste não tem o que verificar.
  const semGL = await page.evaluate(() => { const c = document.createElement('canvas'); return !(c.getContext('webgl')); });
  test.skip(semGL, 'este navegador não tem WebGL em modo headless; o mapa precisa dele');
  await page.evaluate(() => window.__atlas.pronto);
  await expect(page.locator('#busca')).toBeEnabled();
}

const ponto = (page, album, faixa, acervo = 'uqt') =>
  page.evaluate(([ac, p, f]) => window.__atlas.ponto(ac, p, f), [acervo, album.path, faixa.file]);

// Centraliza o ponto, lê onde ele ficou e devolve as coordenadas em px CSS da janela.
async function posicao(page, i, zoom = 40) {
  return page.evaluate(([i, z]) => { window.__atlas.focar(i, z); return window.__atlas.tela(i); }, [i, zoom]);
}
const estado = page => page.evaluate(() => window.__atlas.estado());

async function clicarNoPonto(page, album, faixa, acervo = 'uqt') {
  const i = await ponto(page, album, faixa, acervo);
  expect(i).toBeGreaterThanOrEqual(0);
  const { x, y } = await posicao(page, i);
  await page.mouse.click(x, y);
  return i;
}

test('carrega: a contagem mostra o total de pontos e a busca fica habilitada', async ({ page }) => {
  const erros = [];
  page.on('pageerror', e => erros.push(e.message));
  await boot(page);
  await expect(page.locator('#contagem')).toHaveText(`${PONTOS} faixas`);
  expect((await estado(page)).n).toBe(PONTOS);
  await expect(page.locator('#cartao')).toBeHidden();
  expect(erros).toEqual([]);
});

test('clicar num ponto abre o cartão com título, artista e o link do player', async ({ page }) => {
  await boot(page);
  await clicarNoPonto(page, primeiro, primeiro.tracks[0]);
  await expect(page.locator('#cartao')).toBeVisible();
  await expect(page.locator('#cartao-titulo')).toHaveText('Alfa');
  await expect(page.locator('#cartao-artista')).toHaveText('Joãozinho Samba');
  await expect(page.locator('#cartao-album')).toContainText('Primeiro');
  const href = await page.locator('#cartao-ouvir').getAttribute('href');
  const esperado = new URL(`./?${new URLSearchParams({ acervo: 'uqt', album: primeiro.path, t: 1, play: 1 })}`, page.url());
  expect(new URL(href, page.url()).href).toBe(esperado.href);
});

test('a numeração do link segue a do player: título repetido em subpasta e faixa sem num', async ({ page }) => {
  await boot(page);
  const t = async faixa => {
    await clicarNoPonto(page, primeiro, faixa);
    await expect(page.locator('#cartao-titulo')).toHaveText(faixa.title);
    return new URL(await page.locator('#cartao-ouvir').getAttribute('href'), page.url()).searchParams.get('t');
  };
  // Beta aparece duas vezes (a primeira cópia está em CD1/): as duas apontam para a posição 2, a que ficou.
  expect(await t(primeiro.tracks[1])).toBe('2');
  expect(await t(primeiro.tracks[2])).toBe('2');
  // Gama, sem num, é a 3ª depois de tirar a repetida (não a 4ª da lista crua).
  expect(await t(primeiro.tracks[3])).toBe('3');
});

test('mobile: um toque abre o cartão e um toque no vazio fecha', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  try {
    await boot(page);
    const i = await ponto(page, primeiro, primeiro.tracks[0]);
    const { x, y } = await posicao(page, i);
    await page.touchscreen.tap(x, y);
    await expect(page.locator('#cartao')).toBeVisible();
    await expect(page.locator('#cartao-titulo')).toHaveText('Alfa');
    // No vazio (o vizinho mais próximo está a dezenas de px de distância no zoom de 40x).
    await page.touchscreen.tap(x, y > 400 ? y - 150 : y + 150);
    await expect(page.locator('#cartao')).toBeHidden();
    expect((await estado(page)).sel).toBe(-1);
  } finally { await ctx.close(); }
});

test('busca: o nome de um artista reduz a contagem e Esc limpa', async ({ page }) => {
  await boot(page);
  await page.locator('#busca').fill('joaozinho');   // sem acento: a busca ignora acentos
  await expect(page.locator('#contagem')).toHaveText(`${primeiro.tracks.length} faixas`);
  expect((await estado(page)).nAtivo).toBe(primeiro.tracks.length);
  await page.locator('#busca').fill('xyzxyz');
  await expect(page.locator('#contagem')).toHaveText('nada encontrado');
  await page.locator('#busca').fill('os punks');
  await expect(page.locator('#contagem')).toHaveText('3 faixas');
  await page.locator('#busca').press('Escape');
  await expect(page.locator('#busca')).toHaveValue('');
  await expect(page.locator('#contagem')).toHaveText(`${PONTOS} faixas`);
});

test('filtros: o acervo e um gênero da legenda reduzem os pontos ativos', async ({ page }) => {
  await boot(page);
  await page.locator('[data-acervo="homi"]').click();
  await expect(page.locator('[data-acervo="homi"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-acervo="todos"]')).toHaveAttribute('aria-pressed', 'false');
  const homiPontos = homi.albums.reduce((s, a) => s + a.tracks.length, 0);
  expect((await estado(page)).nAtivo).toBe(homiPontos);
  await page.locator('[data-acervo="todos"]').click();
  expect((await estado(page)).nAtivo).toBe(PONTOS);

  // O botão do gênero tem o contador; Latino (uqt) são 6 pontos no fixture.
  const latino = page.locator('#legenda-lista [data-genero="1"]');
  await expect(latino).toBeVisible();
  await latino.click();
  await expect(latino).toHaveAttribute('aria-pressed', 'false');
  expect((await estado(page)).nAtivo).toBe(PONTOS - 6);
  await latino.click();
  expect((await estado(page)).nAtivo).toBe(PONTOS);
});

test('troca de mapa: "rotulos" muda o estado e a URL', async ({ page }) => {
  await boot(page);
  expect((await estado(page)).mapa).toBe('som');
  await page.locator('[data-mapa="rotulos"]').click();
  await expect(page.locator('[data-mapa="rotulos"]')).toHaveAttribute('aria-pressed', 'true');
  expect((await estado(page)).mapa).toBe('rotulos');
  await expect.poll(() => new URL(page.url()).searchParams.get('mapa')).toBe('rotulos');
  await page.locator('[data-mapa="som"]').click();
  await expect.poll(() => new URL(page.url()).searchParams.has('mapa')).toBe(false);
});

test('segurança: HTML no título da faixa aparece como texto, não vira elemento', async ({ page }) => {
  await boot(page);
  await clicarNoPonto(page, perigo, perigo.tracks[0], 'homi');
  await expect(page.locator('#cartao-titulo')).toHaveText(perigo.tracks[0].title);
  await expect(page.locator('#cartao img[src="x"]')).toHaveCount(0);
  await expect(page.locator('#cartao-titulo *')).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('catálogo novo: álbum fora do payload não quebra e suas faixas não têm ponto', async ({ page }) => {
  const erros = [];
  page.on('pageerror', e => erros.push(e.message));
  await boot(page);
  for (const faixa of recente.tracks) expect(await ponto(page, recente, faixa)).toBe(-1);
  // Os outros álbuns continuam ligados e a busca por artistas conhecidos funciona.
  expect(await ponto(page, primeiro, primeiro.tracks[0])).toBeGreaterThanOrEqual(0);
  await page.locator('#busca').fill('artista novo');
  await expect(page.locator('#contagem')).toHaveText('nada encontrado');
  expect(erros).toEqual([]);
});

// ── mapa "som" em 3D ──
const centro = async page => {
  const r = await page.locator('#atlas-canvas').boundingBox();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
};
async function girar(page, dx = 120, dy = 60, botao = 'right') {
  const { x, y } = await centro(page);
  await page.mouse.move(x, y);
  await page.mouse.down({ button: botao });
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up({ button: botao });
}

test('3D: o payload com somz liga tem3d', async ({ page }) => {
  await boot(page);
  const e = await estado(page);
  expect(e.tem3d).toBe(true);
  expect(e.yaw).toBe(0);
  expect(e.pitch).toBe(0);
});

test('3D: botão direito arrastado gira a vista e não abre o menu de contexto', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { window.__menus = 0; document.addEventListener('contextmenu', e => { if (!e.defaultPrevented) window.__menus++; }); });
  await girar(page);
  const e = await estado(page);
  expect(Math.abs(e.yaw)).toBeGreaterThan(0.3);
  expect(Math.abs(e.pitch)).toBeGreaterThan(0.1);
  expect(await page.evaluate(() => window.__menus)).toBe(0);
  await expect(page.locator('#cartao')).toBeHidden();
});

test('3D: Shift + arrastar com o botão esquerdo também gira', async ({ page }) => {
  await boot(page);
  const { x, y } = await centro(page);
  await page.keyboard.down('Shift');
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 30, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  expect(Math.abs((await estado(page)).yaw)).toBeGreaterThan(0.2);
});

test('3D: depois de girar, clicar em tela(i) seleciona exatamente essa faixa', async ({ page }) => {
  await boot(page);
  await girar(page);
  expect((await estado(page)).sel).toBe(-1);
  for (const [album, faixa] of [[primeiro, primeiro.tracks[0]], [uqt.albums[1], uqt.albums[1].tracks[1]]]) {
    const i = await ponto(page, album, faixa);
    expect(i).toBeGreaterThanOrEqual(0);
    const { x, y } = await posicao(page, i);
    await page.mouse.click(x, y);
    await expect.poll(async () => (await estado(page)).sel).toBe(i);
    await expect(page.locator('#cartao-titulo')).toHaveText(faixa.title);
  }
  const e = await estado(page);
  expect(e.yaw).not.toBe(0);
});

test('3D: ⌂ devolve yaw e pitch para 0 (animado)', async ({ page }) => {
  await boot(page);
  await girar(page);
  expect(Math.abs((await estado(page)).yaw)).toBeGreaterThan(0.3);
  await page.locator('#zoom-reset').click();
  await expect.poll(async () => { const e = await estado(page); return [e.yaw, e.pitch]; }, { timeout: 5000 }).toEqual([0, 0]);
});

test('3D: com movimento reduzido o ⌂ zera a rotação na hora', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await ctx.newPage();
  try {
    await boot(page);
    await girar(page);
    expect(Math.abs((await estado(page)).yaw)).toBeGreaterThan(0.3);
    await page.locator('#zoom-reset').click();
    const e = await estado(page);
    expect([e.yaw, e.pitch]).toEqual([0, 0]);
  } finally { await ctx.close(); }
});

test('3D: em ?mapa=rotulos o botão direito gira quando o payload tem rotulosz', async ({ page }) => {
  await boot(page, { url: '/atlas?mapa=rotulos' });
  const antes = await estado(page);
  expect(antes.mapa).toBe('rotulos');
  expect(antes.tem3d).toBe(true);
  await girar(page);
  const e = await estado(page);
  expect(Math.abs(e.yaw)).toBeGreaterThan(0.3);
  expect(Math.abs(e.pitch)).toBeGreaterThan(0.1);
});

test('payload 2D antigo (sem somz): a página funciona e tem3d é false', async ({ page }) => {
  const erros = [];
  page.on('pageerror', e => erros.push(e.message));
  await boot(page, { faixas: faixas2dGz });
  expect((await estado(page)).tem3d).toBe(false);
  await expect(page.locator('#contagem')).toHaveText(`${PONTOS} faixas`);
  await girar(page);   // sem z não há o que girar, mas não pode quebrar
  expect(((await estado(page)).yaw)).toBe(0);
  await page.locator('[data-mapa="rotulos"]').click();
  expect((await estado(page)).tem3d).toBe(false);
  await girar(page);
  const r = await estado(page);
  expect([r.yaw, r.pitch]).toEqual([0, 0]);
  await page.locator('[data-mapa="som"]').click();
  // a troca de mapa anima por ~0,9 s, e o clique só vale quando ela termina
  await expect.poll(async () => (await estado(page)).t).toBe(0);
  await clicarNoPonto(page, primeiro, primeiro.tracks[0]);
  await expect(page.locator('#cartao-titulo')).toHaveText('Alfa');
  expect(erros).toEqual([]);
});

// ── robustez do navegador e da rede ──
// Pixels que se afastam do fundo (#0f0e0c) no canvas, lidos de um screenshot dele.
async function pixelsAcesos(page) {
  const png = await page.locator('#atlas-canvas').screenshot();
  return page.evaluate(async b64 => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 15) + Math.abs(d[i + 1] - 14) + Math.abs(d[i + 2] - 12) > 90) n++;
    return n;
  }, png.toString('base64'));
}

test('contexto WebGL perdido e restaurado: volta a desenhar e o clique ainda abre o cartão', async ({ page, browserName }) => {
  await boot(page);
  const i = await ponto(page, primeiro, primeiro.tracks[0]);
  await posicao(page, i);
  await expect.poll(() => pixelsAcesos(page)).toBeGreaterThan(20);
  const antes = await pixelsAcesos(page);

  const temExt = await page.evaluate(() => {
    const gl = document.getElementById('atlas-canvas').getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_lose_context');
    if (!ext) return false;
    window.__ext = ext;
    return true;
  });
  test.skip(!temExt, `${browserName}: sem WEBGL_lose_context neste navegador`);

  await page.evaluate(() => new Promise(res => {
    const c = document.getElementById('atlas-canvas');
    c.addEventListener('webglcontextlost', () => res(), { once: true });
    window.__ext.loseContext();
  }));
  await page.evaluate(() => new Promise(res => {
    const c = document.getElementById('atlas-canvas');
    c.addEventListener('webglcontextrestored', () => setTimeout(res, 50), { once: true });
    window.__ext.restoreContext();
  }));
  // Força um novo quadro e espera os pontos voltarem.
  const { x, y } = await posicao(page, i);
  await expect.poll(() => pixelsAcesos(page), { message: 'o canvas voltou a desenhar pontos' }).toBeGreaterThan(Math.min(20, antes / 2));
  await page.mouse.click(x, y);
  await expect(page.locator('#cartao')).toBeVisible();
  await expect(page.locator('#cartao-titulo')).toHaveText('Alfa');
});

test('sem WebGL: a página avisa que precisa dele e não trava', async ({ page }) => {
  await page.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (tipo, ...r) {
      return /webgl/i.test(String(tipo)) ? null : orig.call(this, tipo, ...r);
    };
  });
  await rotear(page);
  await page.goto('/atlas.html');
  await expect(page.locator('#carregando-status')).toHaveText(/WebGL/);
  await expect(page.locator('#carregando')).toBeVisible();
});

test('sem DecompressionStream: mensagem clara em vez de "Carregando…"', async ({ page }) => {
  await page.addInitScript(() => { delete window.DecompressionStream; });
  await rotear(page);
  await page.goto('/atlas.html');
  await expect(page.locator('#carregando-status')).toHaveText(/antigo demais/);
});

for (const [nome, resposta] of [['abortada', r => r.abort()], ['com erro 500', r => r.fulfill({ status: 500, body: 'erro' })]]) {
  test(`payload ${nome}: aparece a mensagem de erro, não um spinner eterno`, async ({ page }) => {
    await rotear(page);
    // Vale também para a reserva em tocador.cc.
    await page.route('**/atlas-faixas.json.gz', resposta);
    await page.goto('/atlas.html');
    await expect(page.locator('#carregando-status')).toHaveText('Não foi possível carregar o mapa.');
    await expect(page.locator('#busca')).toBeDisabled();
  });
}

test('acessibilidade: o atlas carregado não tem violações sérias ou críticas no axe', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#carregando')).toBeHidden();
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const graves = violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
  expect(graves.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)).toEqual([]);
});

test('aria-live: #contagem acompanha o filtro da legenda', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#contagem')).toHaveAttribute('aria-live', 'polite');
  await expect(page.locator('#contagem')).toHaveAttribute('role', 'status');
  await expect(page.locator('#legenda-lista [data-genero="1"]')).toBeVisible();   // a legenda abre por padrão no desktop
  await page.locator('#legenda-lista [data-genero="1"]').click();   // Latino: 6 pontos
  await expect(page.locator('#contagem')).toHaveText(`${PONTOS - 6} faixas`);
  await page.locator('#legenda-lista [data-genero="1"]').click();
  await expect(page.locator('#contagem')).toHaveText(`${PONTOS} faixas`);
});

test('3D no toque: com ⟳ ligado, arrastar um dedo gira e um toque parado ainda abre a faixa', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  try {
    await boot(page);
    const btn = page.locator('#zoom-girar');
    await expect(btn).toBeVisible();
    await btn.tap();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    const { x, y } = await centro(page);
    const cdp = await page.context().newCDPSession(page).catch(() => null);
    if (cdp) {
      const toque = (type, px, py) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: px, y: py }] });
      await toque('touchStart', x, y);
      for (let s = 1; s <= 8; s++) await toque('touchMove', x + s * 15, y + s * 8);
      await toque('touchEnd');
      const e = await estado(page);
      expect(e.yaw).not.toBe(0);
      expect(e.pitch).not.toBe(0);
      expect(e.sel).toBe(-1);
    }
    // toque sem arrastar continua escolhendo a faixa, girado ou não
    const i = await ponto(page, primeiro, primeiro.tracks[0]);
    const p = await posicao(page, i);
    await page.touchscreen.tap(p.x, p.y);
    await expect(page.locator('#cartao-titulo')).toHaveText('Alfa');
  } finally { await ctx.close(); }
});

test('3D: payload sem z esconde o ⟳', async ({ page }) => {
  await boot(page, { faixas: faixas2dGz });
  await expect(page.locator('#zoom-girar')).toBeHidden();
});
