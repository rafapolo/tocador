const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { gerar } = require('../script/build-home-seo.js');
const { gotoWithFixture } = require('./helpers');

// Home para crawlers e previews: metatags com JPG, texto citável e JSON-LD gerados no deploy
// (script/build-home-seo.js) a partir de data/resumo-acervo.json.
const raiz = path.join(__dirname, '..');
const fonte = fs.readFileSync(path.join(raiz, 'index.html'), 'utf8');
const resumo = JSON.parse(fs.readFileSync(path.join(raiz, 'data', 'resumo-acervo.json'), 'utf8'));
const { html: gerado, llms } = gerar(fonte, resumo);

function tamanhoJpeg(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

test('og:image e twitter:image da home são JPG absolutos de 1200x630, sem ♪ no título', () => {
  const meta = (attr, nome) => (fonte.match(new RegExp(`<meta ${attr}="${nome}" content="([^"]*)"`)) || [])[1];
  for (const [attr, nome] of [['property', 'og:image'], ['name', 'twitter:image']]) {
    const url = meta(attr, nome);
    expect(url, nome).toMatch(/^https:\/\/tocador\.cc\/assets\/[\w-]+\.jpg$/);
    expect(url).not.toMatch(/\.svg$/);
  }
  expect(meta('property', 'og:image:width')).toBe('1200');
  expect(meta('property', 'og:image:height')).toBe('630');
  expect(meta('property', 'og:image:alt')).toBeTruthy();
  for (const [attr, nome] of [['property', 'og:title'], ['name', 'twitter:title']]) expect(meta(attr, nome)).toBe('Tocador — Acervo UQT e Hominis Canidae');
  expect(meta('property', 'og:description')).toBe(meta('name', 'description'));
  expect(meta('name', 'twitter:description')).toBe(meta('name', 'description'));
  const img = fs.readFileSync(path.join(raiz, 'assets', 'og.jpg'));
  expect(tamanhoJpeg(img)).toEqual({ w: 1200, h: 630 });
});

test('o texto citável vem no HTML estático, com números do resumo e links reais', () => {
  const corpo = gerado.slice(gerado.indexOf('<body'));
  const bloco = corpo.match(/<section class="sr-only" id="sobre-tocador"[\s\S]*?<\/section>/)[0];
  const texto = bloco.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const palavras = texto.split(' ');
  expect(palavras.length).toBeGreaterThan(120);
  expect(palavras.length).toBeLessThan(200);
  expect(palavras.slice(0, 60).join(' ')).toContain('O Tocador é');
  const alb = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  expect(texto).toContain(alb(resumo.acervos.uqt.catalogo.albuns));
  expect(texto).toContain(alb(resumo.acervos.homi.catalogo.albuns));
  expect(texto).toContain(alb(Number(resumo.acervos.homi.meta.hours)));
  expect(bloco).toContain('<a href="https://tocador.cc/uqt/">');
  expect(bloco).toContain('<a href="https://tocador.cc/homi/">');
  // o texto precede qualquer script do app que o poderia ter escrito
  expect(fonte).not.toMatch(/sobre-tocador/);
});

test('JSON-LD da home: WebSite com SearchAction, Organization e DataCatalog; sem FAQPage', () => {
  const m = gerado.match(/<script type="application\/ld\+json">\n([\s\S]*?)\n<\/script>/);
  const ld = JSON.parse(m[1]);
  const tipos = ld['@graph'].map(x => x['@type']);
  expect(tipos).toEqual(['WebSite', 'Organization', 'DataCatalog']);
  expect(gerado).not.toContain('FAQPage');
  const site = ld['@graph'][0];
  expect(site.potentialAction.target.urlTemplate).toBe('https://tocador.cc/?acervo=uqt&q={search_term_string}');
  expect(ld['@graph'][2].dataset.map(d => d.url)).toEqual(['https://tocador.cc/uqt/', 'https://tocador.cc/homi/']);
});

test('gerar() é idempotente e llms.txt lista acervos, ferramentas e sitemaps', () => {
  expect(gerar(gerado, resumo).html).toBe(gerado);
  for (const s of ['/uqt/', '/homi/', '/atlas', '/radio', '/3d', 'sitemap-albums-uqt.xml', 'sitemap-albums-homi.xml']) expect(llms).toContain(s);
});

test('o parâmetro q da SearchAction realmente filtra o player', async ({ page }) => {
  await gotoWithFixture(page, '/?acervo=uqt&q=chico');
  await expect(page.locator('#search-input')).toHaveValue('chico');
});

test('com o app pronto o bloco não ocupa lugar nem duplica o cabeçalho', async ({ page }) => {
  await page.route('**/', route => route.request().resourceType() === 'document'
    ? route.fulfill({ status: 200, contentType: 'text/html', body: gerado }) : route.fallback());
  await gotoWithFixture(page, '/');
  const caixa = await page.locator('#sobre-tocador').boundingBox();
  expect(caixa.width).toBeLessThanOrEqual(1);
  expect(caixa.height).toBeLessThanOrEqual(1);
  await expect(page.locator('#sobre-tocador')).toBeAttached();
  // h1 único, como antes
  await expect(page.locator('h1')).toHaveCount(1);
  const pagina = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  expect(pagina).toBeLessThanOrEqual(1);
});

test('--catalog: os números da home vêm do catálogo baixado, não do resumo antigo', () => {
  const { contarCatalogo, numeros } = require('../script/build-home-seo.js');
  const fixture = path.join(raiz, 'tests', 'fixtures', 'albums.json.gz');
  const c = contarCatalogo(fixture);
  expect(c.albuns).toBeGreaterThan(0);
  expect(c.faixas).toBeGreaterThanOrEqual(c.albuns);
  expect(c.anoMin).toBeLessThanOrEqual(c.anoMax);
  const n = numeros(resumo, { uqt: fixture });
  expect(n.uqt.albuns).toBe(c.albuns);       // sobreposto
  expect(n.homi.albuns).toBe(resumo.acervos.homi.catalogo.albuns); // sem --catalog fica o resumo
});
