// 3d.html sem WebGL (#668): a página diz que o navegador não abriu o WebGL, em vez de um erro não tratado
// que virava issue. three.js vem de node_modules, nunca do jsdelivr.
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

test.use({
  serviceWorkers: 'block',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
});

test('sem contexto WebGL, o Universo avisa e não reporta erro', async ({ page }) => {
  const raiz = path.join(__dirname, '..', 'node_modules', 'three');
  await page.route('https://cdn.jsdelivr.net/npm/three@*/**', r => {
    const rel = new URL(r.request().url()).pathname.replace(/^\/npm\/three@[^/]+\//, '');
    const f = path.join(raiz, rel);
    if (!fs.existsSync(f)) return r.fulfill({ status: 404 });
    r.fulfill({ status: 200, headers: { 'Content-Type': 'text/javascript' }, body: fs.readFileSync(f) });
  });
  await page.route('**/*.json.gz', r => r.fulfill({ status: 404 }));
  const reportes = [];
  await page.route('**/report-error', r => {
    try { reportes.push(JSON.parse(r.request().postData() || '{}')); } catch {}
    r.fulfill({ status: 204 });
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (tipo, ...resto) {
      return /webgl/.test(tipo) ? null : orig.call(this, tipo, ...resto);
    };
  });
  const erros = [];
  page.on('pageerror', e => erros.push(e.message));
  await page.goto('/3d.html');
  await expect(page.locator('#loading-status')).toContainText('WebGL');
  await page.waitForTimeout(500);
  expect(erros).toEqual([]);
  expect(reportes).toEqual([]);
});
