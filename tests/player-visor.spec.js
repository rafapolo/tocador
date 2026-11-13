// "Visor do som" no painel de faixas (js/player-visor.js): fica no grupo de acordeões (um aberto por vez), só
// desenha aberto, e lê o som por captureStream() com o <audio> em modo CORS, sem tirar o som dele.
const { test, expect } = require('@playwright/test');
const { gotoWithFixture, fixtureMp3 } = require('./helpers');

test.use({ serviceWorkers: 'block' });

const card = (page, title) => page.locator('.album-item', { hasText: title });

test('o visor fica entre os acordeões, um aberto por vez, e com a faixa tocando desenha o som', async ({ page, browserName }) => {
  await gotoWithFixture(page);
  // o cdn.tocador.cc responde com CORS; o mp3 do teste também precisa
  await page.route('**/*.mp3', r => r.fulfill({ status: 200, headers: { 'Content-Type': 'audio/mpeg', 'Access-Control-Allow-Origin': '*' }, body: fixtureMp3 }));
  await page.route('**/*-features.json.gz', r => r.fulfill({ status: 404 }));
  const c = card(page, 'Construção');
  await c.hover();
  await c.locator('.card-play').click();
  await expect(page.locator('#btn-play')).toHaveClass(/playing/);
  const visor = page.locator('#tracks-panel .album-visor');
  const temCaptura = await page.evaluate(() => typeof HTMLMediaElement.prototype.captureStream === 'function');
  if (!temCaptura) {                                  // Safari: sem captureStream, sem visor
    await expect(visor).toBeHidden();
    return;
  }
  await expect(visor).toBeVisible();
  // logo acima de "Soa parecido com"
  expect(await visor.evaluate(d => d.nextElementSibling?.classList.contains('album-parecidos'))).toBe(true);
  const generos = page.locator('#tracks-panel .album-generos');
  await generos.locator('summary').click();
  await expect(generos).toHaveAttribute('open', '');
  await visor.locator('summary').click();
  await expect(visor).toHaveAttribute('open', '');
  await expect(generos).not.toHaveAttribute('open', '');          // só um aberto
  await expect.poll(() => page.evaluate(() => window.__visorPlayer.estado().cors)).toBe('anonymous');
  await expect.poll(() => page.evaluate(() => window.__visorPlayer.estado().desenhando)).toBe(true);
  await expect(visor.locator('p')).not.toBeEmpty();
  // a faixa segue tocando depois de recarregar em modo CORS
  await expect.poll(() => page.evaluate(() => !document.getElementById('audio').paused)).toBe(true);
  // fechado, para de desenhar
  await visor.locator('summary').click();
  await expect.poll(() => page.evaluate(() => window.__visorPlayer.estado().desenhando)).toBe(false);
});
