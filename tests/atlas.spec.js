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
// Grafo pequeno: quatro artistas em anel no som e em estrela nos rótulos.
const u16b64 = a => Buffer.from(Uint16Array.from(a).buffer).toString('base64');
const artistasGz = zlib.gzipSync(JSON.stringify({
  v: 1, k: 2, nomes: [primeiro.artist, 'Beta', '<img src=x onerror=alert(1)>', 'Delta'],
  generos: ['Latin---Samba', 'Rock---Punk'], acervos: ['uqt', 'homi'],
  faixas: [40, 20, 10, 5], genero: [0, 0, 1, 1], acervo: [0, 0, 1, 1],
  viz: { som: u16b64([1, 3, 2, 0, 3, 1, 0, 2]), rotulos: u16b64([3, 2, 0, 3, 0, 3, 0, 2]) },
}));
// O mesmo grafo com layout pré-calculado: a visão geral passa para o canvas, com todos os artistas.
const i16b64 = a => Buffer.from(Int16Array.from(a).buffer).toString('base64');
const POS = [-20000, -20000, 0, 20000, -20000, 5000, 20000, 20000, -5000, -20000, 20000, 0];
const artistasLayoutGz = zlib.gzipSync(JSON.stringify({
  ...JSON.parse(zlib.gunzipSync(artistasGz)), pos: { som: i16b64(POS), rotulos: i16b64(POS) },
}));
async function rotear(page, { faixas = faixasGz, artistas = artistasGz } = {}) {
  await page.route('**/data/atlas-faixas.json.gz', r => r.fulfill(gz(faixas)));
  await page.route('**/data/atlas-artistas.json.gz', r => artistas ? r.fulfill(gz(artistas)) : r.fulfill({ status: 404 }));
  await page.route('**/uqt/data/uqt-albums.json.gz', r => r.fulfill(gz(uqtGz)));
  await page.route('**/hominiscanidae/data/homi-albums.json.gz', r => r.fulfill(gz(homiGz)));
  await page.route('**/capa-min.jpg', r => r.fulfill({ status: 404 }));
  await page.route('**/*.mp3', r => r.fulfill({ status: 200, body: Buffer.alloc(0) }));
}

async function boot(page, { url = '/atlas.html', faixas, artistas } = {}) {
  await rotear(page, { faixas, artistas });
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

const grafo = page => page.evaluate(() => window.__atlas.grafo());

test('grafo: o botão abre a visão geral e fecha de volta ao mapa, com a contagem certa', async ({ page }) => {
  await boot(page);
  const antes = await page.locator('#contagem').textContent();
  const btn = page.locator('#btn-grafo');
  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#grafo-nos .grafo-no')).toHaveCount(4);
  await expect(page.locator('#contagem')).toContainText('4 artistas');
  await expect(page.locator('#zoom')).toBeHidden();
  await page.waitForFunction(() => location.search.includes('grafo=1'));
  await btn.click();
  await expect(page.locator('#grafo')).toBeHidden();
  await expect(page.locator('#contagem')).toHaveText(antes);
  await page.waitForFunction(() => !location.search.includes('grafo'));
});

test('grafo: com layout, a visão geral mostra todos no canvas e clicar num ponto abre o artista', async ({ page }) => {
  await boot(page, { artistas: artistasLayoutGz });
  await page.locator('#btn-grafo').click();
  await expect(page.locator('#contagem')).toContainText('4 artistas');
  expect((await grafo(page)).tudo).toBe(true);
  await expect(page.locator('#grafo-tudo')).toHaveClass(/ligada/);
  await expect(page.locator('#grafo-nos .grafo-no')).toHaveCount(0);
  await expect(page.locator('#grafo-ouvir')).toBeHidden();
  await page.waitForFunction(() => window.__atlas.grafoTudo('Beta'));
  await page.waitForTimeout(100);
  const beta = await page.evaluate(() => window.__atlas.grafoTudo('Beta'));
  const caixa = await page.locator('#grafo-svg').boundingBox();
  await page.mouse.click(caixa.x + beta.x, caixa.y + beta.y);
  await expect(page.locator('#grafo-titulo')).toHaveText('Beta');
  expect((await grafo(page)).tudo).toBe(false);
  await expect(page.locator('#grafo-tudo')).not.toHaveClass(/ligada/);
  await expect(page.locator('.grafo-no.centro')).toHaveCount(1);
  await page.waitForFunction(() => location.search.includes('artista=Beta'));
  await page.goBack();
  await expect(page.locator('#grafo-tudo')).toHaveClass(/ligada/);
  await expect(page.locator('#grafo-nos .grafo-no')).toHaveCount(0);
});

test('grafo: o painel do artista leva ao filtro dele no tocador', async ({ page }) => {
  await boot(page, { url: `/atlas?grafo=1&artista=${encodeURIComponent(primeiro.artist.toUpperCase())}` });
  await expect(page.locator('#grafo-titulo')).toHaveText(primeiro.artist);
  await expect(page.locator('#grafo-ouvir')).toBeVisible();
  const url = new URL(await page.locator('#grafo-ouvir').getAttribute('href'));
  expect(url.searchParams.get('artista')).toBe(primeiro.artist);
  expect(['uqt', 'homi']).toContain(url.searchParams.get('acervo'));
});

test('grafo: ?grafo=1&artista= centra no artista, ignorando caixa e acento, e clicar recentra', async ({ page }) => {
  await boot(page, { url: '/atlas?grafo=1&artista=DELTA' });
  await expect(page.locator('#grafo-titulo')).toHaveText('Delta');
  await expect(page.locator('.grafo-no.centro')).toHaveCount(1);
  await page.locator('.grafo-no', { hasText: 'Beta' }).click();
  await expect(page.locator('#grafo-titulo')).toHaveText('Beta');
  await page.waitForFunction(() => new URLSearchParams(location.search).get('artista') === 'Beta');
  await page.keyboard.press('Escape');
  await expect(page.locator('#grafo')).toBeHidden();
});

// Meio da área do grafo e, em px, a distância do nó central até ele.
const foraDoCentro = page => page.evaluate(() => {
  const r = document.querySelector('.grafo-no.centro circle').getBoundingClientRect();
  const topo = document.getElementById('controles').getBoundingClientRect().bottom + 16;
  const baixo = innerHeight - document.getElementById('grafo-painel').offsetHeight - 28;
  return Math.hypot(r.x + r.width / 2 - innerWidth / 2, r.y + r.height / 2 - (topo + baixo) / 2);
});
const assentou = page => page.waitForFunction(() =>
  !document.querySelector('.grafo-no.saindo') && !document.querySelector('.grafo-no[style*="--o: 0;"]'));

test('grafo: o nó clicado termina no centro e as arestas chegam junto com os nós', async ({ page }) => {
  await boot(page, { url: '/atlas?grafo=1&artista=Delta' });
  await page.locator('.grafo-no', { hasText: 'Beta' }).click();
  await expect(page.locator('.grafo-no.centro')).toContainText('Beta');
  await expect.poll(() => foraDoCentro(page)).toBeLessThan(1);
  await assentou(page);
  const soltas = await page.evaluate(() => {
    const pos = new Map([...document.querySelectorAll('.grafo-no')].map(n => [n.dataset.i, n.getAttribute('transform').match(/-?[\d.]+/g).map(Number)]));
    return [...document.querySelectorAll('#grafo-arestas line')].filter(l => {
      const a = pos.get(l.dataset.a), b = pos.get(l.dataset.b);
      return !a || !b || Math.hypot(a[0] - +l.getAttribute('x1'), a[1] - +l.getAttribute('y1')) > 0.01
        || Math.hypot(b[0] - +l.getAttribute('x2'), b[1] - +l.getAttribute('y2')) > 0.01;
    }).length;
  });
  expect(soltas).toBe(0);
  await expect(page.locator('#grafo-arestas line').first()).toBeAttached();
});

test('grafo: a transição é contínua: no meio dela o nó está a caminho e as arestas o acompanham', async ({ page }) => {
  await boot(page, { url: '/atlas?grafo=1&artista=Delta' });
  await assentou(page);
  const inicio = await foraDoCentro(page);
  const meio = await page.evaluate(() => new Promise(res => {
    const no = [...document.querySelectorAll('.grafo-no')].find(n => n.textContent === 'Beta');
    no.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const antes = no.getAttribute('transform');
    setTimeout(() => {
      const [x, y] = no.getAttribute('transform').match(/-?[\d.]+/g).map(Number);
      const i = no.dataset.i, linha = document.querySelector(`#grafo-arestas line[data-a="${i}"], #grafo-arestas line[data-b="${i}"]`);
      const ponta = linha.dataset.a === i ? [+linha.getAttribute('x1'), +linha.getAttribute('y1')] : [+linha.getAttribute('x2'), +linha.getAttribute('y2')];
      res({ moveu: no.getAttribute('transform') !== antes, solta: Math.hypot(ponta[0] - x, ponta[1] - y) });
    }, 300);
  }));
  expect(inicio).toBeLessThan(1);
  expect(meio.moveu).toBe(true);
  expect(meio.solta).toBeLessThan(0.01);
});

test('grafo: um segundo clique no meio da transição parte de onde os nós estão', async ({ page }) => {
  await boot(page, { url: '/atlas?grafo=1&artista=Delta' });
  await assentou(page);
  await page.evaluate(() => {
    const no = nome => [...document.querySelectorAll('.grafo-no')].find(n => n.textContent === nome);
    no('Beta').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return new Promise(res => setTimeout(() => {
      no('Delta').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      res();
    }, 120));
  });
  await expect(page.locator('#grafo-titulo')).toHaveText('Delta');
  await assentou(page);
  await expect.poll(() => foraDoCentro(page)).toBeLessThan(1);
  await expect(page.locator('.grafo-no')).toHaveCount((await grafo(page)).nos.length);
});

test('grafo: a opacidade cai com a distância ao centro e o texto segue legível', async ({ page }) => {
  await boot(page, { url: '/atlas?grafo=1&artista=Delta' });
  await assentou(page);
  const op = (nome, sel) => page.locator('.grafo-no', { hasText: nome }).locator(sel).evaluate(e => +getComputedStyle(e).opacity);
  await expect.poll(() => op('Delta', 'circle')).toBeCloseTo(1);
  await expect(page.locator('.grafo-no', { hasText: 'Beta' })).toHaveAttribute('data-nivel', '2');
  await expect(page.locator('.grafo-no[data-nivel="1"]')).toHaveCount(2);
  const direto = page.locator('.grafo-no[data-nivel="1"] circle').first();
  await expect.poll(() => direto.evaluate(e => +getComputedStyle(e).opacity)).toBeCloseTo(0.72);
  await expect.poll(() => op('Beta', 'circle')).toBeCloseTo(0.42);
  await expect.poll(() => op('Beta', 'text')).toBeCloseTo(0.652);
  await page.locator('.grafo-no', { hasText: 'Beta' }).hover();
  await expect.poll(() => op('Beta', 'circle')).toBeCloseTo(1);
});

test('grafo: com movimento reduzido a troca é direta', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page, { url: '/atlas?grafo=1&artista=Delta' });
  const direta = await page.evaluate(() => {
    const no = [...document.querySelectorAll('.grafo-no')].find(n => n.textContent === 'Beta');
    no.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const c = document.querySelector('.grafo-no.centro');
    return c.textContent === 'Beta' && !document.querySelector('.grafo-no.saindo');
  });
  expect(direta).toBe(true);
  expect(await foraDoCentro(page)).toBeLessThan(1);
});

test('grafo: redimensionar recoloca o centro sem animar', async ({ page }) => {
  await boot(page, { url: '/atlas?grafo=1&artista=Delta' });
  await assentou(page);
  await page.setViewportSize({ width: 900, height: 620 });
  await expect.poll(() => foraDoCentro(page)).toBeLessThan(1);
});

// Reprodução simulada: o mp3 dos testes é vazio, então `paused` e `pause()` são trocados no elemento.
const simularPrevia = page => page.evaluate(() => {
  const a = document.getElementById('previa');
  window.__pausou = 0;
  Object.defineProperty(a, 'paused', { value: false, configurable: true });
  Object.defineProperty(a, 'duration', { value: 100, configurable: true });
  Object.defineProperty(a, 'currentTime', { value: 30, configurable: true });
  a.pause = () => { window.__pausou++; Object.defineProperty(a, 'paused', { value: true, configurable: true }); };
  a.dispatchEvent(new Event('timeupdate'));
});
const pausou = page => page.evaluate(() => window.__pausou);
// Painel e cartão não se cobrem, e nenhum nó fica atrás deles.
async function expectSemCobrir(page) {
  await expect(page.locator('.grafo-no').first()).toBeVisible();
  await assentou(page);
  const r = await page.evaluate(() => {
    const ret = id => document.getElementById(id).getBoundingClientRect();
    const toca = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const c = ret('cartao'), p = ret('grafo-painel');
    const nos = [...document.querySelectorAll('.grafo-no circle')].map(n => n.getBoundingClientRect());
    return { sobre: toca(c, p), escondidos: nos.filter(n => toca(n, c) || toca(n, p)).length };
  });
  expect(r).toEqual({ sobre: false, escondidos: 0 });
}
const emTresCaminhos = [
  ['botão Grafo', page => page.locator('#btn-grafo').click()],
  ['tecla G', page => page.keyboard.press('g')],
  ['chip de parecidos', page => page.locator('#cartao-parecidos-lista button', { hasText: 'Delta' }).click()],
];
for (const [nome, abrir] of emTresCaminhos) {
  test(`prévia: segue tocando ao entrar no grafo pelo ${nome}`, async ({ page }) => {
    await boot(page);
    await clicarNoPonto(page, primeiro, primeiro.tracks[0]);
    await expect(page.locator('#cartao-parecidos-lista button').first()).toBeVisible();
    await simularPrevia(page);
    await abrir(page);
    await expect(page.locator('#grafo')).toBeVisible();
    await expect(page.locator('#cartao')).toBeVisible();
    await expect(page.locator('#cartao-progresso')).toBeVisible();
    await expect(page.locator('#cartao-previa')).toBeVisible();
    expect(await pausou(page)).toBe(0);
    await expectSemCobrir(page);
  });
}

test('prévia: no celular o painel fica acima do cartão e nenhum nó some', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await boot(page);
  await clicarNoPonto(page, primeiro, primeiro.tracks[0]);
  await simularPrevia(page);
  await page.keyboard.press('g');
  await expect(page.locator('#grafo')).toBeVisible();
  await expect(page.locator('#cartao')).toBeVisible();
  await expectSemCobrir(page);
  await page.locator('#cartao-fechar').click();
  await expect(page.locator('#cartao')).toBeHidden();
  expect(await pausou(page)).toBe(1);
});

test('prévia: clicar em nós e buscar no grafo não interrompe o áudio', async ({ page }) => {
  await boot(page);
  await clicarNoPonto(page, primeiro, primeiro.tracks[0]);
  await simularPrevia(page);
  await page.locator('#btn-grafo').click();
  await page.locator('.grafo-no', { hasText: 'Beta' }).click();
  await expect(page.locator('#grafo-titulo')).toHaveText('Beta');
  await page.locator('#busca').fill('delt');
  await expect(page.locator('#grafo-titulo')).toHaveText('Delta');
  expect(await pausou(page)).toBe(0);
  await expect(page.locator('#cartao')).toBeVisible();
});

test('prévia: sair do grafo voa até o artista sem trocar a faixa selecionada', async ({ page }) => {
  await boot(page);
  const i = await clicarNoPonto(page, primeiro, primeiro.tracks[1]);
  await simularPrevia(page);
  await page.locator('#btn-grafo').click();
  await expect(page.locator('#grafo-titulo')).toHaveText(primeiro.artist);
  const antes = (await estado(page)).k;
  await page.keyboard.press('Escape');
  await expect(page.locator('#grafo')).toBeHidden();
  await page.waitForFunction(k => Math.abs(window.__atlas.estado().k - k) > 1, antes);
  expect((await estado(page)).sel).toBe(i);
  await expect(page.locator('#cartao')).toBeVisible();
  await expect(page.locator('#cartao-progresso')).toBeVisible();
  expect(await pausou(page)).toBe(0);
});

test('grafo: sem prévia tocando o cartão fecha ao entrar', async ({ page }) => {
  await boot(page);
  await clicarNoPonto(page, primeiro, primeiro.tracks[0]);
  await page.locator('#btn-grafo').click();
  await expect(page.locator('#grafo')).toBeVisible();
  await expect(page.locator('#cartao')).toBeHidden();
});

test('grafo: artista fora do grafo abre a visão geral e avisa', async ({ page }) => {
  await boot(page, { url: '/atlas?grafo=1&artista=Ningu%C3%A9m' });
  await expect(page.locator('#contagem')).toHaveText('Artista fora do grafo');
  expect((await grafo(page)).centro).toBeNull();
  await expect(page.locator('#grafo-genero')).toBeHidden();
});

test('grafo: Som e Gêneros trocam as ligações sem fechar o grafo', async ({ page }) => {
  await boot(page, { url: '/atlas?grafo=1&artista=Delta' });
  await expect(page.locator('#grafo-detalhe')).toContainText('pelo som');
  await page.locator('[data-mapa="rotulos"]').click();
  await expect(page.locator('#grafo-detalhe')).toContainText('rótulos de gênero');
  expect((await grafo(page)).aberto).toBe(true);
});

test('grafo: a busca centra no artista e nome hostil fica como texto', async ({ page }) => {
  await boot(page, { url: '/atlas?grafo=1' });
  await page.locator('#busca').fill('delt');
  await expect(page.locator('#grafo-titulo')).toHaveText('Delta');
  await expect(page.locator('#grafo img')).toHaveCount(0);
  await expect(page.locator('.grafo-no', { hasText: '<img src=x' })).toHaveCount(1);
});

test('grafo: sair centrado num artista leva o mapa ao ponto dele; a visão geral não mexe no mapa', async ({ page }) => {
  await boot(page, { url: `/atlas?grafo=1&artista=${encodeURIComponent(primeiro.artist)}` });
  await expect(page.locator('#grafo-titulo')).toHaveText(primeiro.artist);
  await page.keyboard.press('Escape');
  await expect(page.locator('#cartao-artista')).toContainText(primeiro.artist);
  await expect(page.locator('#anel-sel')).toBeVisible();
  await page.waitForFunction(() => { const e = window.__atlas.estado(); return e.k > e.k0 * 2.9; });
  const { sel } = await estado(page);
  await page.waitForFunction(i => {
    const p = window.__atlas.tela(i);
    return Math.abs(p.x - innerWidth / 2) < 2 && Math.abs(p.y - innerHeight / 2) < 2;
  }, sel);

  await page.locator('#cartao-fechar').click();
  await page.locator('#btn-grafo').click();
  await expect(page.locator('#grafo-nos .grafo-no')).toHaveCount(4);
  await page.locator('#btn-grafo').click();
  await expect(page.locator('#grafo')).toBeHidden();
  await expect(page.locator('#cartao')).toBeHidden();
});

test('?de=&album= abre o mapa centrado no ponto do álbum, sem zoom fechado', async ({ page }) => {
  await boot(page, { url: `/atlas?de=uqt&album=${encodeURIComponent(primeiro.path)}` });
  await expect(page.locator('#cartao-album')).toContainText(primeiro.title);
  await expect(page.locator('#grafo')).toBeHidden();
  await page.waitForFunction(() => {
    const e = window.__atlas.estado(), p = window.__atlas.tela(e.sel);
    return e.k > e.k0 * 2.9 && e.k < e.k0 * 3.1 && Math.abs(p.x - innerWidth / 2) < 2 && Math.abs(p.y - innerHeight / 2) < 2;
  });
});

test('?de=&album= de álbum sem ponto avisa e deixa o mapa inteiro', async ({ page }) => {
  await boot(page, { url: `/atlas?de=uqt&album=${encodeURIComponent(recente.path)}` });
  await expect(page.locator('#contagem')).toHaveText('Álbum fora do mapa');
  await expect(page.locator('#cartao')).toBeHidden();
});

// Onde o nó está desenhado agora.
const noNaTela = (page, nome) => page.evaluate(n => {
  const g = [...document.querySelectorAll('.grafo-no')].find(x => x.textContent === n);
  return g.getAttribute('transform');
}, nome);
const fimDaTransicao = page => page.evaluate(() => new Promise(r => setTimeout(r, 800)));
async function arrastarNoVazio(page, dx, dy, opcoes = {}) {
  await page.mouse.move(40, 300);
  if (opcoes.shift) await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(40 + dx, 300 + dy, { steps: 6 });
  await page.mouse.up();
  if (opcoes.shift) await page.keyboard.up('Shift');
}

test('grafo 3D: arrastar gira a cena, o centro fica e as arestas seguem os nós', async ({ page }) => {
  await boot(page, { url: '/atlas?grafo=1&artista=Delta' });
  await fimDaTransicao(page);
  const centro = await noNaTela(page, 'Delta'), beta = await noNaTela(page, 'Beta');
  await arrastarNoVazio(page, 120, 40);
  const e = await grafo(page);
  expect(e.yaw).toBeGreaterThan(0.5);
  expect(e.pitch).toBeGreaterThan(0.1);
  expect(e.centro).toBe('Delta');
  expect(await noNaTela(page, 'Delta')).toBe(centro);
  expect(await noNaTela(page, 'Beta')).not.toBe(beta);
  const soltas = await page.evaluate(() => {
    const pontos = new Map([...document.querySelectorAll('.grafo-no')].map(g => [g.dataset.i, g.getAttribute('transform').match(/[-\d.]+/g).map(Number)]));
    return [...document.querySelectorAll('#grafo-arestas line')].filter(l => {
      const a = pontos.get(l.dataset.a);
      return Math.abs(a[0] - +l.getAttribute('x1')) > 0.01 || Math.abs(a[1] - +l.getAttribute('y1')) > 0.01;
    }).length;
  });
  expect(soltas).toBe(0);
});

test('grafo 3D: Shift + arrastar desloca sem girar; as setas giram', async ({ page }) => {
  await boot(page, { url: '/atlas?grafo=1&artista=Delta' });
  await fimDaTransicao(page);
  await arrastarNoVazio(page, 80, 0, { shift: true });
  expect((await grafo(page)).yaw).toBe(0);
  await expect(page.locator('#grafo-mundo')).toHaveAttribute('transform', /translate\(80 /);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowUp');
  const e = await grafo(page);
  expect(e.yaw).toBeGreaterThan(0);
  expect(e.pitch).toBeLessThan(0);
});

test('grafo 3D: clicar num nó com a cena girada ainda o leva ao centro, sem desfazer o giro', async ({ page }) => {
  await boot(page, { url: '/atlas?grafo=1&artista=Delta' });
  await fimDaTransicao(page);
  const meio = await noNaTela(page, 'Delta');
  await arrastarNoVazio(page, 60, 20);
  const { yaw } = await grafo(page);
  await page.locator('.grafo-no', { hasText: 'Beta' }).click();
  await expect(page.locator('#grafo-titulo')).toHaveText('Beta');
  await fimDaTransicao(page);
  expect((await grafo(page)).yaw).toBe(yaw);
  expect(await noNaTela(page, 'Beta')).toBe(meio);
});

test('grafo: com o mouse parado no nó clicado, os vizinhos não apagam durante a transição', async ({ page }) => {
  await boot(page, { url: '/atlas?grafo=1&artista=Delta' });
  await fimDaTransicao(page);
  await page.locator('.grafo-no', { hasText: 'Beta' }).click();
  await page.waitForTimeout(150);
  await expect(page.locator('#grafo-svg')).not.toHaveClass(/foco/);
});

test('histórico: voltar e avançar percorrem o grafo nó a nó até o mapa', async ({ page }) => {
  await boot(page);
  await page.locator('#btn-grafo').click();
  await page.waitForFunction(() => location.search.includes('grafo=1'));
  await page.locator('.grafo-no', { hasText: 'Delta' }).click();
  await page.waitForFunction(() => location.search.includes('artista=Delta'));
  await fimDaTransicao(page);
  await page.locator('.grafo-no', { hasText: 'Beta' }).click();
  await page.waitForFunction(() => location.search.includes('artista=Beta'));

  await page.goBack();
  await expect(page.locator('#grafo-titulo')).toHaveText('Delta');
  await page.goBack();
  await expect(page.locator('#grafo-titulo')).toHaveText('Artistas parecidos');
  await page.goBack();
  await expect(page.locator('#grafo')).toBeHidden();
  await expect(page.locator('#btn-grafo')).toHaveAttribute('aria-pressed', 'false');
  await page.goForward();
  await expect(page.locator('#grafo')).toBeVisible();
  await page.goForward();
  await expect(page.locator('#grafo-titulo')).toHaveText('Delta');
  await page.goForward();
  await expect(page.locator('#grafo-titulo')).toHaveText('Beta');
});

test('histórico: abrir e fechar uma faixa voltam e avançam, e o link recarregado abre a mesma faixa', async ({ page }) => {
  await boot(page);
  const i = await clicarNoPonto(page, primeiro, primeiro.tracks[0]);
  await expect(page.locator('#cartao')).toBeVisible();
  await page.waitForFunction(() => location.search.includes('faixa='));
  await page.locator('#cartao-fechar').click();
  await expect(page.locator('#cartao')).toBeHidden();
  await page.waitForFunction(() => !location.search.includes('faixa='));
  await page.goBack();
  await expect(page.locator('#cartao')).toBeVisible();
  expect((await estado(page)).sel).toBe(i);
  await page.goBack();
  await expect(page.locator('#cartao')).toBeHidden();
  await page.goForward();
  await expect(page.locator('#cartao')).toBeVisible();

  const url = page.url();
  await page.goto(url);
  await page.evaluate(() => window.__atlas.pronto);
  await expect(page.locator('#cartao')).toBeVisible();
  expect((await estado(page)).sel).toBe(i);
});

test('histórico: Som/Gêneros, acervo e legenda voltam um clique por vez', async ({ page }) => {
  await boot(page);
  await page.locator('[data-mapa="rotulos"]').click();
  await page.waitForFunction(() => location.search.includes('mapa=rotulos'));
  await page.locator('[data-acervo="homi"]').click();
  await page.waitForFunction(() => location.search.includes('acervo=homi'));
  await page.locator('#legenda-lista [data-genero="0"]').click();
  await page.waitForFunction(() => location.search.includes('off=0'));

  await page.goBack();
  await expect(page.locator('#legenda-lista [data-genero="0"]')).toHaveAttribute('aria-pressed', 'true');
  await page.goBack();
  await expect(page.locator('[data-acervo="todos"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-mapa="rotulos"]')).toHaveAttribute('aria-pressed', 'true');
  await page.goBack();
  await expect(page.locator('[data-mapa="som"]')).toHaveAttribute('aria-pressed', 'true');
  expect((await estado(page)).mapa).toBe('som');
  await page.goForward();
  await page.goForward();
  await page.goForward();
  await expect(page.locator('#legenda-lista [data-genero="0"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('[data-acervo="homi"]')).toHaveAttribute('aria-pressed', 'true');
});

test('histórico: digitar na busca não cria uma entrada por letra; Enter cria uma', async ({ page }) => {
  await boot(page);
  const antes = await page.evaluate(() => history.length);
  await page.locator('#busca').pressSequentially('sam', { delay: 30 });
  await page.waitForFunction(() => location.search.includes('q=sam'));
  expect(await page.evaluate(() => history.length)).toBe(antes);
  await page.locator('#busca').fill('');
  await page.locator('#busca').pressSequentially('samba');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => location.search.includes('q=samba'));
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => history.length)).toBe(antes + 1);
  await page.goBack();
  await expect(page.locator('#busca')).not.toHaveValue('samba');
});

test('grafo: desligar o botão volta ao mapa 3D inteiro, sem cartão; Esc ainda vai ao ponto', async ({ page }) => {
  await boot(page, { url: `/atlas?grafo=1&artista=${encodeURIComponent(primeiro.artist)}` });
  await expect(page.locator('#grafo-titulo')).toHaveText(primeiro.artist);
  await page.locator('#btn-grafo').click();
  await expect(page.locator('#grafo')).toBeHidden();
  await expect(page.locator('#cartao')).toBeHidden();
  await page.waitForTimeout(800);
  const e = await estado(page);
  expect(e.sel).toBe(-1);
  expect(Math.abs(e.k / e.k0 - 1)).toBeLessThan(0.05);
});

test('grafo: o painel mostra todas as capas do artista, com link em nova aba, sem botões', async ({ page }) => {
  await rotear(page);
  await page.route('**/capa-min.jpg', r => r.fulfill({
    status: 200, contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
  }));
  // A fixture não tem capas: aqui todo álbum do catálogo passa a ter.
  const comCapa = { ...uqt, albums: uqt.albums.map(a => ({ ...a, has_cover: true })) };
  await page.route('**/uqt/data/uqt-albums.json.gz', r => r.fulfill(gz(zlib.gzipSync(JSON.stringify(comCapa)))));
  await page.goto(`/atlas?grafo=1&artista=${encodeURIComponent(primeiro.artist)}`);
  await page.evaluate(() => window.__atlas.pronto);
  const esperadas = comCapa.albums.filter(a => a.artist === primeiro.artist).length;
  expect(esperadas).toBeGreaterThan(0);
  const capas = page.locator('#grafo-capas a');
  await expect(capas).toHaveCount(esperadas);
  await expect(capas.first()).toHaveAttribute('target', '_blank');
  await expect(capas.first().locator('img')).toHaveAttribute('src', /capa-min\.jpg$/);
  await expect(page.locator('#grafo-acoes')).toHaveCount(0);
  await expect(page.locator('#grafo-genero')).toBeVisible();
});

test('UQT e Homi usam o mesmo ícone de acervo', async ({ page }) => {
  await boot(page);
  await expect(page.locator('[data-acervo="uqt"] use')).toHaveAttribute('href', '#i-acervo');
  await expect(page.locator('[data-acervo="homi"] use')).toHaveAttribute('href', '#i-acervo');
});

test('grafo: sem o payload avisa e o mapa segue funcionando', async ({ page }) => {
  await page.route('https://tocador.cc/data/atlas-artistas.json.gz', r => r.fulfill({ status: 404 }));
  await boot(page, { artistas: null });
  await page.locator('#btn-grafo').click();
  await expect(page.locator('#contagem')).toHaveText('grafo indisponível');
  await page.locator('#btn-grafo').click();
  await expect(page.locator('#contagem')).toContainText('faixas');
});

test('cartão: lista os parecidos e clicar num deles abre o grafo nele', async ({ page }) => {
  await boot(page);
  await clicarNoPonto(page, primeiro, primeiro.tracks[0]);
  const chip = page.locator('#cartao-parecidos-lista button', { hasText: 'Delta' });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.locator('#grafo-titulo')).toHaveText('Delta');
  await expect(page.locator('#cartao')).toBeHidden();
});

test('cartão: a linha dourada acompanha a prévia e some ao parar', async ({ page }) => {
  await boot(page);
  await clicarNoPonto(page, primeiro, primeiro.tracks[0]);
  const barra = page.locator('#cartao-progresso');
  await expect(barra).toBeHidden();
  await page.evaluate(() => {
    const a = document.getElementById('previa');
    Object.defineProperty(a, 'duration', { value: 100, configurable: true });
    Object.defineProperty(a, 'currentTime', { value: 25, configurable: true });
    a.dispatchEvent(new Event('timeupdate'));
  });
  await expect(barra).toBeVisible();
  await expect(barra.locator('span')).toHaveAttribute('style', /scaleX\(0\.25\)/);
  await expect(barra).toHaveCSS('bottom', '0px');
  await page.locator('#cartao-fechar').click();
  await expect(barra).toBeHidden();
});

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
