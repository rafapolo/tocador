// Os 12 cenários de demonstração do chat (tasks/proximos-passos.md §5.1.8), contra um catálogo de 13 álbuns
// desenhado para que cada cenário tenha uma resposta certa (tests/fixtures/build-cenarios.js).
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const albumsGz = fs.readFileSync(path.join(__dirname, 'fixtures', 'cenarios-albums.json.gz'));
const featuresGz = fs.readFileSync(path.join(__dirname, 'fixtures', 'cenarios-features.json.gz'));
const gz = body => r => r.fulfill({ status: 200, headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' }, body });

async function boot(page) {
  await page.addInitScript(() => localStorage.setItem('tocador-browse-collapsed', 'true'));
  await page.route('**/uqt-albums.json.gz', gz(albumsGz));
  await page.route('**/homi-albums.json.gz', gz(albumsGz));
  await page.route('**/*-features.json.gz', gz(featuresGz));
  await page.route('**/*-genres.json.gz', r => r.fulfill({ status: 404 }));
  await page.route('**/*.mp3', r => r.fulfill({ status: 200, headers: { 'Content-Type': 'audio/mpeg' }, body: Buffer.alloc(16) }));
  await page.route('**/capa-min.jpg', r => r.fulfill({ status: 404 }));
  await page.route('**/report-error', r => r.fulfill({ status: 204 }));
  await page.goto('/');
  await page.waitForSelector('.album-item', { timeout: 8000 });
  await page.click('#btn-chat');
  await expect(page.locator('#chat-panel')).toBeVisible();
  // the engine is loaded on first open: wait until the welcome line mentions audio (features were found)
  await expect(page.locator('.chat-msg.bot').first()).toContainText('medidos no áudio');
}

async function ask(page, text) {
  const n = await page.locator('.chat-msg.bot').count();
  await page.fill('#chat-input', text);
  await page.press('#chat-input', 'Enter');
  await expect(page.locator('.chat-msg.bot')).toHaveCount(n + 1);
}
const bot = page => page.locator('.chat-msg.bot').last();
const titulos = async page => (await bot(page).locator('.chat-result .r-title').allTextContents());
const porque = async page => { await bot(page).locator('summary').first().click(); return bot(page).locator('details.chat-why').innerText(); };

test.beforeEach(async ({ page }) => { await boot(page); });
// same-origin fetches (the features file) would go through the service worker and skip page.route
test.use({ serviceWorkers: 'block' });


test('1. samba lento dos anos 60', async ({ page }) => {
  await ask(page, 'samba lento dos anos 60');
  expect(await titulos(page)).toEqual(['Samba Devagar']);                  // "Samba Animado" (138 BPM) não é lento
  const t = await porque(page);
  expect(t).toContain('BPM mediano 66');
  expect(t).toContain('medido');
  expect(t).toContain('inferido');
});

test('2. algo calmo pra dormir', async ({ page }) => {
  await ask(page, 'algo calmo pra dormir');
  const t = await titulos(page);
  expect(t[0]).toBe('Cantiga para Dormir');
  expect(t).not.toContain('Garagem Suja');
  expect(t).not.toContain('Samba Animado');
});

test('3. forró dançante anos 90', async ({ page }) => {
  await ask(page, 'forro dancante anos 90');
  expect(await titulos(page)).toEqual(['Forró Dançante Show']);              // o de 1995 é calmo, não dançante
});

test('4. só instrumental, sem bateria', async ({ page }) => {
  await ask(page, 'só instrumental, sem bateria');
  const t = await titulos(page);
  expect(t).toEqual(expect.arrayContaining(['Piano Solo', 'Quarteto de Cordas', 'Choro das Tardes']));
  expect(t).not.toContain('Banda Instrumental');                            // tem bateria
  expect(t).not.toContain('Samba Animado');                                 // tem voz
});

test('5. mais lento que <álbum>', async ({ page }) => {
  await ask(page, 'mais lento que Samba Animado');
  const t = await titulos(page);
  expect(t).toContain('Samba Devagar');
  expect(t).not.toContain('Garagem Suja');
  expect(await porque(page)).toContain('Samba Animado');
  expect(await porque(page)).not.toContain('undefined');
});

test('6. q albuns seriam "ritmo de São João"??', async ({ page }) => {
  await ask(page, 'q albuns seriam "ritmo de São João"??');
  expect((await titulos(page))[0]).toBe('São João do Sertão');
  expect(await porque(page)).toContain('ignorei');
});

test('7. choro com bandolim', async ({ page }) => {
  await ask(page, 'choro com bandolim');
  expect(await titulos(page)).toEqual(['Choro das Tardes']);
  expect(await porque(page)).toContain('bandolim');                          // o detector não mede bandolim: dito
});

test('8. rock pesado de garagem', async ({ page }) => {
  await ask(page, 'rock pesado de garagem');
  expect(await titulos(page)).toEqual(['Garagem Suja']);
});

test('9. cartolla anos 70 e 80 (erro de digitação)', async ({ page }) => {
  await ask(page, 'cartolla anos 70 e 80');
  await expect(bot(page)).toContainText('quis dizer');
  await expect(bot(page).locator('.chat-chip', { hasText: 'cartola' })).toBeVisible();
});

test('10. me surpreenda com algo triste', async ({ page }) => {
  await ask(page, 'me surpreenda com algo triste');
  const t = await titulos(page);
  expect(t.length).toBeGreaterThan(0);
  expect(t.length).toBeLessThanOrEqual(5);
  expect(t).toContain('Noites Tristes');
  for (const ruim of ['Forró Dançante Show', 'Samba Animado', 'Garagem Suja']) expect(t).not.toContain(ruim);
});

test('11. letra da música X: recusa com clareza', async ({ page }) => {
  await ask(page, 'letra da música Construção');
  await expect(bot(page)).toContainText('Não tenho letras');
  expect(await titulos(page)).toEqual([]);
});

test('12. eta?: explica que não faz isso', async ({ page }) => {
  await ask(page, 'eta?');
  await expect(bot(page)).toContainText('Isso eu não faço aqui');
  expect(await titulos(page)).toEqual([]);
});

// ── "por quê?": cada filtro de áudio dito contra os álbuns devolvidos (números do catálogo de fixture) ──────────

test('por quê? andamento: critério, resumo medido e o que é medido × inferido', async ({ page }) => {
  await ask(page, 'samba lento dos anos 60');
  const t = await porque(page);
  expect(t).toContain('andamento "lento" — BPM até 80');
  expect(t).toContain('Também entram os 15% mais lentos do acervo');       // corte relativo ao acervo, dito
  expect(t).toContain('BPM mediano 66 (de 66 a 66)');
  expect(t).toContain('O detector pode errar por meio ou dobro de tempo');
  expect(t).toContain('[medido]');
  expect(t).toContain('gênero "samba"');
  expect(t).toContain('1 de 1 com samba como principal');
  expect(t).toContain('Inferido do som; não é rótulo de gravadora');
  expect(t).toContain('[inferido]');
  expect(t).not.toContain('200%');                                          // participação limitada a 100%
});

test('por quê? humor: corte e mediana sobre o resultado', async ({ page }) => {
  await ask(page, 'algo triste dos anos 80');
  const t = await porque(page);
  expect(t).toContain('humor "melancólico"');
  expect(t).toContain('triste ≥ 0,35 (mediana 0,95; 100% passam)');
  expect(t).toContain('alegre ≤ 0,3 (mediana 0,05; 100% passam)');
  expect(t).toContain('São probabilidades de um modelo');
});

test('por quê? voz e comparação com um álbum', async ({ page }) => {
  await ask(page, 'só instrumental, sem bateria');
  let t = await porque(page);
  expect(t).toContain('voz "instrumental" — Vale voz média < 0,5');
  expect(t).toContain('mediana 0,05');
  await ask(page, 'mais lento que Samba Animado');
  t = await porque(page);
  expect(t).toContain('BPM ≥ 8 abaixo do de "Samba Animado" (138)');
  expect(t).toContain('BPM mediano 80 (de 60 a 124)');
});

test('por quê? conta as faixas de baixa confiança e as sem análise', async ({ page }) => {
  await ask(page, 'samba lento anos 90');
  expect(await titulos(page)).toEqual(['Samba Incerto']);
  const t = await porque(page);
  expect(t).toContain('1 faixa tem BPM pouco confiável (< 1,5)');
  expect(t).toContain('Faixas sem análise de áudio, fora das medidas: 1 de 2');
});

test('por quê? é texto puro (nada do catálogo vira HTML) e não repete a evidência do 1º resultado', async ({ page }) => {
  await ask(page, 'samba lento dos anos 60');
  await bot(page).locator('summary').first().click();
  expect(await bot(page).locator('details.chat-why *:not(summary):not(ul):not(li):not(span)').count()).toBe(0);
  expect(await bot(page).locator('details.chat-why').innerText()).not.toContain('1º resultado');
  expect(await bot(page).locator('details.chat-why').innerText()).not.toContain('a grade ao lado mostra exatamente');
});

// ── UX das respostas: curtas, com exemplos clicáveis quando recusa, não entende ou não acha ─────────────────

const chips = async page => bot(page).locator('.chat-chip').allTextContents();

test('boas-vindas curtas com exemplos reais', async ({ page }) => {
  const m = page.locator('.chat-msg.bot').first();
  expect((await m.innerText()).split('\n')[0].length).toBeLessThan(110);
  const c = await m.locator('.chat-chip').allTextContents();
  expect(c).toEqual(expect.arrayContaining(['samba lento dos anos 60', 'algo calmo']));
  expect(c.some(x => x.startsWith('mais lento que '))).toBe(true);
  expect(c.length).toBeLessThanOrEqual(4);
});

test('recusa em 1 frase curta e com 2–3 exemplos clicáveis; clicar pergunta', async ({ page }) => {
  await ask(page, 'letra da música Construção');
  expect((await bot(page).locator('p').first().innerText()).length).toBeLessThan(70);
  const c = await chips(page);
  expect(c.length).toBeGreaterThanOrEqual(2);
  expect(c.length).toBeLessThanOrEqual(3);
  await bot(page).locator('.chat-chip').first().click();
  await expect(page.locator('.chat-msg.user').last()).toHaveText(c[0]);
});

test('zero resultados oferece o mesmo pedido com menos coisas', async ({ page }) => {
  await ask(page, 'samba rapido anos 20');
  await expect(bot(page)).toContainText('Não achei nenhum álbum');
  const c = await chips(page);
  expect(c).toEqual(expect.arrayContaining(['samba', 'anos 20']));
});

test('não entendeu: uma frase, 3 álbuns e exemplos', async ({ page }) => {
  await ask(page, 'qualquer coisa meio assim');
  await expect(bot(page)).toContainText('Não entendi direito');
  expect((await chips(page)).length).toBeGreaterThanOrEqual(2);
});

test('exemplos por contexto: humor pede humor com época', async ({ page }) => {
  await ask(page, 'sou o robo');                                            // conversa: exemplos genéricos
  expect((await chips(page)).length).toBeGreaterThanOrEqual(2);
  await ask(page, 'algo triste samba anos 20');
  await expect(bot(page)).toContainText('Não achei nenhum álbum');
  expect(await chips(page)).toContain('samba');
});
