// Navegadores sem DecompressionStream (iOS < 16.4, Firefox < 113, Chrome < 80): o acervo,
// os gêneros e as features do painel Pegada passam por gunzipText() (js/acervo-format.js),
// que nesse caso carrega js/fflate-gunzip.js uma vez. Ver tasks/done/compat-navegadores-2026-11-02.md, item 3.
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const fixtureGz = fs.readFileSync(path.join(__dirname, 'fixtures', 'albums.json.gz'));
const gz = { status: 200, headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' }, body: fixtureGz };

async function abrir(page, { semApi }) {
  if (semApi) await page.addInitScript(() => { delete window.DecompressionStream; });
  const pedidos = [];
  page.on('request', r => { if (r.url().includes('fflate-gunzip.js')) pedidos.push(r.url()); });
  await page.route('**/uqt-albums.json.gz', r => r.fulfill(gz));
  await page.route('**/homi-albums.json.gz', r => r.fulfill(gz));
  await page.route('**/*-genres.json.gz', r => r.fulfill({ status: 404 }));
  await page.goto('/?acervo=uqt');
  await expect(page.locator('.album-item').first()).toBeVisible({ timeout: 8000 });
  return pedidos;
}

test('C1: sem DecompressionStream o acervo carrega, pelo fflate', async ({ page }) => {
  const pedidos = await abrir(page, { semApi: true });
  expect(await page.evaluate(() => albums.length)).toBeGreaterThan(0);
  expect(pedidos).toHaveLength(1);
});

test('C2: com DecompressionStream o fflate nem é baixado', async ({ page }) => {
  const pedidos = await abrir(page, { semApi: false });
  expect(pedidos).toHaveLength(0);
});

test('C3: gunzipText aceita bytes que já chegaram descomprimidos', async ({ page }) => {
  await abrir(page, { semApi: true });
  const txt = await page.evaluate(() => gunzipText(new TextEncoder().encode('{"ok":1}')));
  expect(JSON.parse(txt)).toEqual({ ok: 1 });
});
