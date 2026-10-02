// M5: o chat resolve ou recusa com clareza ≥ 90% das frases-semente (data/qgen/real/semente.jsonl)?
// Cada semente tem um `esperado`; o teste classifica a resposta pelo texto do chat e confere.
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const fixtureGz = fs.readFileSync(path.join(__dirname, 'fixtures', 'albums.json.gz'));
const featuresGz = fs.readFileSync(path.join(__dirname, 'fixtures', 'albums-features.json.gz'));
const sementes = fs.readFileSync(path.join(__dirname, '..', 'data/qgen/real/semente.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
test.use({ serviceWorkers: 'block' });

const RECUSA = /Isso eu não faço|Não tenho letras|Não tenho dados sobre a vida|outro serviço|sem vídeo|Não ensino técnica|fora do acervo|Nenhum álbum do acervo|se contradiz|Oi! Eu busco|Isso o acervo não faz|sobre o chat, não sobre a música|Entendo melhor português/;
const CMD = /Ainda não há nada carregado|Pausado|Tocando de novo|Próxima faixa|Faixa anterior|Já está/;

async function boot(page) {
  await page.addInitScript(() => localStorage.setItem('tocador-browse-collapsed', 'true'));
  const gz = r => r.fulfill({ status: 200, headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' }, body: fixtureGz });
  await page.route('**/uqt-albums.json.gz', gz);
  await page.route('**/homi-albums.json.gz', gz);
  await page.route('**/*-genres.json.gz', r => r.fulfill({ status: 404 }));
  await page.route('**/*-features.json.gz', r => r.fulfill({ status: 200, headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' }, body: featuresGz }));
  await page.route('**/*.mp3', r => r.fulfill({ status: 200, headers: { 'Content-Type': 'audio/mpeg' }, body: Buffer.alloc(16) }));
  await page.route('**/capa-min.jpg', r => r.fulfill({ status: 404 }));
  await page.goto('/');
  await page.waitForSelector('.album-item', { timeout: 8000 });
  await page.click('#btn-chat');
  await expect(page.locator('#chat-panel')).toBeVisible();
}

const ask = async (page, t) => {
  const n = await page.locator('.chat-msg.bot').count();
  await page.fill('#chat-input', t);
  await page.press('#chat-input', 'Enter');
  await expect(page.locator('.chat-msg.bot')).toHaveCount(n + 1);
  return (await page.locator('.chat-msg.bot').last().innerText());
};

function ok(esperado, texto) {
  const recusou = RECUSA.test(texto), cmd = CMD.test(texto), sugere = /Não entendi direito/.test(texto);
  if (esperado === 'fora' || esperado === 'status') return recusou;
  if (esperado === 'player') return cmd;
  if (esperado === 'vago') return sugere || /Sorteei/.test(texto);
  return !recusou && !cmd && !sugere;            // busca, referencial, continuacao: entendeu e respondeu
}

test('sementes: resolve ou recusa com clareza ≥ 90%', async ({ page }) => {
  test.setTimeout(120000);
  await boot(page);
  let acertos = 0; const erros = [];
  for (const s of sementes) {
    if (s.esperado === 'continuacao') await ask(page, 'samba');
    const texto = await ask(page, s.q);
    if (ok(s.esperado, texto)) acertos++; else erros.push(`${s.id} [${s.esperado}] "${s.q}" → ${texto.replace(/\s+/g, ' ').slice(0, 90)}`);
  }
  const pct = 100 * acertos / sementes.length;
  console.log(`SEMENTES: ${acertos}/${sementes.length} = ${pct.toFixed(1)}%`);
  for (const e of erros) console.log('  ✗ ' + e);
  expect(pct).toBeGreaterThanOrEqual(90);
});
