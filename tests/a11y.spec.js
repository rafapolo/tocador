const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const path = require('path');
const fs = require('fs');

const fixtureGz = fs.readFileSync(path.join(__dirname, 'fixtures', 'albums.json.gz'));

async function open(page, url) {
  await page.addInitScript(() => localStorage.setItem('tocador-browse-collapsed', 'true'));
  await page.route('**/uqt-albums.json.gz', route => route.fulfill({
    status: 200,
    headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' },
    body: fixtureGz,
  }));
  await page.goto(url);
  await page.waitForSelector('.album-item');
}

const scan = page => new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();

test('A11Y1: album grid has no axe violations', async ({ page }) => {
  await open(page, '/?acervo=uqt');
  const { violations } = await scan(page);
  expect(violations.map(v => `${v.id}: ${v.nodes.length} nodes`)).toEqual([]);
});

test('A11Y2: an open album (header + tracklist) has no axe violations', async ({ page }) => {
  await open(page, '/?acervo=uqt');
  await page.locator('.album-item').first().click();
  await page.waitForSelector('#track-list [data-track-idx]');
  const { violations } = await scan(page);
  expect(violations.map(v => `${v.id}: ${v.nodes.length} nodes`)).toEqual([]);
});

test('A11Y5: the browse panel (artist list) has no axe violations', async ({ page }) => {
  // open() collapses the panel; this test wants it expanded.
  await page.addInitScript(() => localStorage.setItem('tocador-browse-collapsed', 'false'));
  await open(page, '/?acervo=uqt');
  await page.waitForSelector('#browse-list .browse-item');
  const { violations } = await scan(page);
  expect(violations.map(v => `${v.id}: ${v.nodes.length} nodes`)).toEqual([]);
});

test('A11Y6: the keyboard-shortcuts modal has no axe violations', async ({ page }) => {
  await open(page, '/?acervo=uqt');
  await page.locator('#btn-shortcuts').click();
  await page.waitForSelector('[role=dialog]:visible, .shortcuts-modal:visible');
  const { violations } = await scan(page);
  expect(violations.map(v => `${v.id}: ${v.nodes.length} nodes`)).toEqual([]);
});

test('A11Y7: the mobile layout (drawer + browse toggle) has no axe violations', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/?acervo=uqt');
  await page.locator('.album-item').first().click();
  await page.waitForSelector('#drawer-track-list [data-track-idx]', { state: 'attached' });
  const { violations } = await scan(page);
  expect(violations.map(v => `${v.id}: ${v.nodes.length} nodes`)).toEqual([]);
});

test('A11Y3: pinch-zoom is not disabled by the viewport meta', async ({ page }) => {
  await open(page, '/?acervo=uqt');
  const content = await page.locator('meta[name=viewport]').getAttribute('content');
  expect(content).not.toMatch(/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/);
});

test('A11Y4: grid DOM order matches visual order after scrolling down and back up', async ({ page }) => {
  await open(page, '/?acervo=uqt');
  const grid = page.locator('#albums-list');
  await grid.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(150);
  await grid.evaluate(el => { el.scrollTop = 0; });
  await page.waitForTimeout(150);
  const idx = await page.$$eval('.album-item', els => els.map(e => Number(e.dataset.albumIdx)));
  expect(idx.length).toBeGreaterThan(0);
  expect(idx).toEqual([...idx].sort((a, b) => a - b));
});
