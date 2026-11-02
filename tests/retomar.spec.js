// Item 6 de tasks/compat-navegadores-2026-11-02.md: com a tela bloqueada, o iOS pode recusar o
// play() da próxima faixa (NotAllowedError) e o álbum parava em silêncio. safePlay() agora tenta
// de novo quando a página volta a ficar visível, e avisa se ainda assim não der.
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const fixtureGz = fs.readFileSync(path.join(__dirname, 'fixtures', 'albums.json.gz'));

async function abrir(page) {
  const gz = { status: 200, headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' }, body: fixtureGz };
  await page.route('**/uqt-albums.json.gz', r => r.fulfill(gz));
  await page.route('**/*-genres.json.gz', r => r.fulfill({ status: 404 }));
  await page.route('**/*.mp3', r => r.fulfill({ status: 404 }));
  await page.goto('/?acervo=uqt');
  await expect(page.locator('.album-item').first()).toBeVisible({ timeout: 8000 });
  // Página oculta, play() recusado como faz o iOS; `recusas` controla quantas vezes.
  await page.evaluate(() => {
    window.__oculta = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__oculta });
    window.__plays = 0;
    HTMLMediaElement.prototype.play = function () {
      window.__plays++;
      if (window.__recusas-- > 0) return Promise.reject(new DOMException('bloqueado', 'NotAllowedError'));
      return Promise.resolve();
    };
    audio.src = 'https://cdn.tocador.cc/uqt/x/01.mp3';
  });
}
const voltar = page => page.evaluate(() => { window.__oculta = false; document.dispatchEvent(new Event('visibilitychange')); });

test('RT1: recusado com a página oculta, tenta de novo ao voltar', async ({ page }) => {
  await abrir(page);
  await page.evaluate(() => { window.__recusas = 1; safePlay(audio); });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__plays)).toBe(1);
  await voltar(page);
  await expect.poll(() => page.evaluate(() => window.__plays)).toBe(2);
  await expect(page.locator('#toast')).not.toContainText('tela bloqueada');
});

test('RT2: se recusar de novo ao voltar, avisa para tocar ▶', async ({ page }) => {
  await abrir(page);
  await page.evaluate(() => { window.__recusas = 2; safePlay(audio); });
  await page.waitForTimeout(100);
  await voltar(page);
  await expect(page.locator('#toast')).toContainText('tela bloqueada');
});

test('RT3: com a página visível, uma recusa não agenda nada', async ({ page }) => {
  await abrir(page);
  await page.evaluate(() => { window.__oculta = false; window.__recusas = 1; safePlay(audio); });
  await page.waitForTimeout(100);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__plays)).toBe(1);
});
