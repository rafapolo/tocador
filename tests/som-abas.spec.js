// js/som-abas.js: um som por vez entre as abas do tocador — quando uma começa a tocar, a outra pausa
// (a prévia do /atlas pausa o player e vice-versa).
const { test, expect } = require('@playwright/test');

const HTML = `<!doctype html><audio id="a" loop muted></audio><script src="/js/som-abas.js"></script><script>
  // 1 s de silêncio em WAV, para ter um <audio> que toca de verdade sem rede
  const n = 8000, b = new ArrayBuffer(44 + n), v = new DataView(b), s = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  s(0, 'RIFF'); v.setUint32(4, 36 + n, true); s(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true);
  v.setUint16(34, 8, true); s(36, 'data'); v.setUint32(40, n, true); new Uint8Array(b, 44).fill(128);
  const a = document.getElementById('a');
  a.src = URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
  window.calados = 0;
  anunciarSom(a, () => window.calados++);
</script>`;

async function aba(context) {
  const page = await context.newPage();
  await page.route('**/som-abas-teste.html', r => r.fulfill({ status: 200, contentType: 'text/html', body: HTML }));
  await page.goto('/som-abas-teste.html');
  return page;
}
const tocar = page => page.evaluate(() => document.getElementById('a').play());
const pausada = page => page.evaluate(() => document.getElementById('a').paused);

test('a aba que começa a tocar pausa a que tocava, e vice-versa', async ({ context }) => {
  const atlas = await aba(context), player = await aba(context);

  await tocar(player);
  expect(await pausada(player)).toBe(false);

  await tocar(atlas);                                 // a prévia começa: o player pausa
  await expect.poll(() => pausada(player)).toBe(true);
  expect(await pausada(atlas)).toBe(false);
  expect(await player.evaluate(() => window.calados)).toBe(1);

  await tocar(player);                                // o player volta: a prévia pausa
  await expect.poll(() => pausada(atlas)).toBe(true);
  expect(await pausada(player)).toBe(false);
  expect(await atlas.evaluate(() => window.calados)).toBe(1);
});
