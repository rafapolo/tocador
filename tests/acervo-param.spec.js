// ?acervo= robustness (#640): a mistyped alias used to be fetched as a relative URL
// ("homis" → /homis → 404), leaving the skeleton forever and an unhandled rejection.

const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const gz = fs.readFileSync(path.join(__dirname, 'fixtures', 'albums.json.gz'));

async function stub(page) {
  const hits = [];
  page.on('request', r => { if (r.url().includes('.json.gz') || /\/homis$/.test(r.url())) hits.push(r.url()); });
  for (const pattern of ['**/uqt-albums.json.gz', '**/homi-albums.json.gz']) {
    await page.route(pattern, route => route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' },
      body: gz,
    }));
  }
  await page.route('**/*-genres.json.gz', route => route.fulfill({ status: 404 }));
  await page.route('**/capa-min.jpg', route => route.fulfill({ status: 404 }));
  await page.route('**/report-error', route => route.fulfill({ status: 204 }));
  return hits;
}

for (const [typed, key] of [['homis', 'homi'], ['HOMI', 'homi'], ['Hominis', 'homi'], ['UQT', 'uqt']]) {
  test(`alias "${typed}" loads ${key} and canonicalises the URL`, async ({ page }) => {
    const hits = await stub(page);
    await page.goto(`/?acervo=${typed}`);
    await page.waitForSelector('.album-item', { timeout: 8000 });
    expect(new URL(page.url()).searchParams.get('acervo')).toBe(key);
    expect(hits.some(u => u.includes(`${key}-albums.json.gz`))).toBe(true);
    expect(hits.some(u => /\/homis$|\/HOMI$|\/Hominis$|\/UQT$/.test(u))).toBe(false);
  });
}

test('unknown bare word falls back to the default acervo', async ({ page }) => {
  const hits = await stub(page);
  await page.goto('/?acervo=xyzzy');
  await page.waitForSelector('.album-item', { timeout: 8000 });
  expect(new URL(page.url()).searchParams.has('acervo')).toBe(false);
  expect(hits.some(u => u.includes('homi-albums.json.gz'))).toBe(true);
});

test('dead catalog URL shows a message, raises nothing and is not remembered', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await stub(page);
  await page.route('**/gone.json.gz', route => route.fulfill({ status: 404 }));
  await page.goto('/?acervo=' + encodeURIComponent('http://localhost:3456/gone.json.gz'));
  await expect(page.locator('.album-not-found')).toContainText('Não foi possível carregar o acervo');
  await expect(page.locator('.grid-skeleton')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('acervo'))).toBeNull();
  expect(errors).toEqual([]);
});
