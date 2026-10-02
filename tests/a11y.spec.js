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

// Chat: boas-vindas com exemplos, uma recusa com chips, e uma resposta com o "por quê?" aberto (features do fixture de cenários).
test.describe('chat', () => {
  test.use({ serviceWorkers: 'block' });
  const albumsGz = fs.readFileSync(path.join(__dirname, 'fixtures', 'cenarios-albums.json.gz'));
  const featuresGz = fs.readFileSync(path.join(__dirname, 'fixtures', 'cenarios-features.json.gz'));
  const gz = body => r => r.fulfill({ status: 200, headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' }, body });
  async function openChat(page) {
    await page.addInitScript(() => localStorage.setItem('tocador-browse-collapsed', 'true'));
    await page.route('**/uqt-albums.json.gz', gz(albumsGz));
    await page.route('**/*-features.json.gz', gz(featuresGz));
    await page.route('**/*-genres.json.gz', r => r.fulfill({ status: 404 }));
    await page.route('**/capa-min.jpg', r => r.fulfill({ status: 404 }));
    await page.goto('/?acervo=uqt');
    await page.waitForSelector('.album-item');
    await page.click('#btn-chat');
    await expect(page.locator('.chat-msg.bot').first()).toContainText('medidos no áudio');
  }
  const ask = async (page, t) => {
    const n = await page.locator('.chat-msg.bot').count();
    await page.fill('#chat-input', t);
    await page.press('#chat-input', 'Enter');
    await expect(page.locator('.chat-msg.bot')).toHaveCount(n + 1);
  };
  const semViolacoes = async page => expect((await scan(page)).violations.map(v => `${v.id}: ${v.nodes.length} nodes`)).toEqual([]);

  test('A11Y9: chat welcome and a refusal with example chips have no axe violations', async ({ page }) => {
    await openChat(page);
    await semViolacoes(page);
    await ask(page, 'letra da música Construção');
    await semViolacoes(page);
  });

  test('A11Y10: chat answer with results and "por quê?" open has no axe violations; chips reach 40px touch height', async ({ page }) => {
    await openChat(page);
    await ask(page, 'samba lento dos anos 60');
    await page.locator('.chat-msg.bot').last().locator('summary').first().click();
    await semViolacoes(page);
    await ask(page, 'samba rapido anos 20');
    const h = await page.locator('.chat-msg.bot').last().locator('.chat-chip').first().evaluate(el => el.getBoundingClientRect().height);
    expect(h).toBeGreaterThanOrEqual(40);
    await page.locator('.chat-msg.bot').last().locator('.chat-chip').first().focus();
    const outline = await page.locator('.chat-msg.bot').last().locator('.chat-chip').first().evaluate(el => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe('none');
  });
});
