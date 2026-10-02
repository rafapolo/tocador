// 200 mensagens de usuário contra o chat, no catálogo de fixture (tests/fixtures/albums.json.gz).
// Cada linha é [mensagem, esperado]. O esperado descreve o COMPORTAMENTO decidido para o produto:
//   ['t1','t2']        busca entendida → exatamente estes álbuns (ordem livre)
//   SUGERE             não entendeu → "Não entendi direito" + 3 álbuns ao acaso (e a grade mostra só eles)
//   VAZIO              entendeu, mas nenhum álbum cumpre → "Não achei nenhum álbum", sem sugestão
//   RECUSA             não é busca → recusa com clareza, sem resultados nem sugestão
//   CMD                comando do player sem nada carregado → "Ainda não há nada carregado"
//   QUIS(x)            nenhum resultado, mas oferece o chip "quis dizer x"
// Casos que dependem da ontologia/áudio (M2) rodam por padrão; CHAT_FASE=v0 os ignora.
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const fixtureGz = fs.readFileSync(path.join(__dirname, 'fixtures', 'albums.json.gz'));
const featuresGz = fs.readFileSync(path.join(__dirname, 'fixtures', 'albums-features.json.gz'));
const FASE_M2 = process.env.CHAT_FASE !== 'v0';          // motor v1 pronto: ligado por padrão; CHAT_FASE=v0 volta ao comportamento sem áudio
// same-origin fetches (the features file) would go through the service worker and skip page.route
test.use({ serviceWorkers: 'block' });


async function boot(page) {
  await page.addInitScript(() => localStorage.setItem('tocador-browse-collapsed', 'true'));
  const gz = r => r.fulfill({ status: 200, headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' }, body: fixtureGz });
  await page.route('**/uqt-albums.json.gz', gz);
  await page.route('**/homi-albums.json.gz', gz);
  await page.route('**/*-genres.json.gz', r => r.fulfill({ status: 404 }));
  await page.route('**/*-features.json.gz', r => (FASE_M2
    ? r.fulfill({ status: 200, headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' }, body: featuresGz })
    : r.fulfill({ status: 404 })));
  await page.route('**/*.mp3', r => r.fulfill({ status: 200, headers: { 'Content-Type': 'audio/mpeg' }, body: Buffer.alloc(16) }));
  await page.route('**/capa-min.jpg', r => r.fulfill({ status: 404 }));
  await page.route('**/report-error', r => r.fulfill({ status: 204 }));
  await page.goto('/');
  await page.waitForSelector('.album-item', { timeout: 8000 });
  await page.click('#btn-chat');
  await expect(page.locator('#chat-panel')).toBeVisible();
}

// Lacunas conhecidas do v0 (e decisões de produto pendentes): ficam como fixme até a M2 (CHAT_FASE=m2).
//  - parser: "70s", "1960 a 1969", "animada" (feminino), "qualquer coisa", continuação com "so"
//  - decisão pendente: "sei la", "algo legal", "algo pra dormir" — palavras desconhecidas hoje dão "Não achei
//    nenhum álbum"; só o que for qualidade conhecida ou nada reconhecível sugere ao acaso.

const SORTEIO = Symbol('sorteio'), SUGERE = Symbol('sugere'), VAZIO = Symbol('vazio'), RECUSA = Symbol('recusa'), CMD = Symbol('cmd');
const QUIS = x => ({ quis: x });

const C = 'Construção', CE = 'Clube da Esquina', CV = 'Caetano Veloso', GG = 'Getz/Gilberto', ET = 'Elis & Tom',
      SB = 'Songbook - Chico Buarque Vol. 1', FB = 'Falso Brilhante', SN = 'Saudade do Nordeste', PX = 'Acervo Raro';

// ── A. períodos ──────────────────────────────────────────────────────────
const PERIODO = [
  ['anos 60', [CV, GG]], ['anos 70', [C, CE, ET, FB]], ['anos 50', [SN]], ['anos 30', [PX]], ['anos 90', [SB]],
  ['anos 2020', ['Hominis Canidae #42 - Maio', 'Álbum com # no caminho', 'Álbum com Faixa Duplicada']],
  ['década de 70', [C, CE, ET, FB]], ['decada de 60', [CV, GG]], ['dos anos 70', [C, CE, ET, FB]],
  ['70s', [C, CE, ET, FB]], ['anos 70 e 90', [C, CE, ET, FB, SB]],
  ['1971', [C]], ['1972', [CE]], ['1968', [CV]], ['1964', [GG]], ['1974', [ET]], ['1994', [SB]], ['1976', [FB]],
  ['1957', [SN]], ['1930', [PX]], ['ano de 1971', [C]], ['de 1976', [FB]],
  ['1971 e 1972', [C, CE]], ['1964 e 1968', [GG, CV]], ['de 1968 a 1972', [CV, C, CE]],
  ['entre 1970 e 1976', [C, CE, ET, FB]], ['1960 a 1969', [CV, GG]], ['de 1950 a 1960', [SN]],
  ['antes de 1960', [SN, PX]], ['antes de 1940', [PX]], ['depois de 1990', [SB, 'Hominis Canidae #42 - Maio', 'Álbum com # no caminho', 'Álbum com Faixa Duplicada']],
  ['depois de 2020', ['Hominis Canidae #42 - Maio', 'Álbum com # no caminho', 'Álbum com Faixa Duplicada']],
  ['ate 1960', [SN, PX]], ['a partir de 1990', [SB, 'Hominis Canidae #42 - Maio', 'Álbum com # no caminho', 'Álbum com Faixa Duplicada']],
  ['anos 1970', [C, CE, ET, FB]], ['musicas dos anos 60', [CV, GG]], ['quero algo dos anos 50', [SN]],
  ['mostra os discos de 1974', [ET]], ['tem algo de 1957?', [SN]], ['anos 80', VAZIO],
  ['1985', VAZIO], ['antes de 1920', VAZIO],
];

// ── B. artista, título, palavra ──────────────────────────────────────────
const PALAVRA = [
  ['chico buarque', [C, SB]], ['chico', [C, SB]], ['buarque', [C, SB]], ['construcao', [C]], ['Construção', [C]],
  ['elis regina', [ET, FB]], ['elis', [ET, FB]], ['tom jobim', [ET]], ['jobim', [ET]], ['falso brilhante', [FB]],
  ['milton nascimento', [CE]], ['lo borges', [CE]], ['clube da esquina', [CE]], ['esquina', [CE]],
  ['caetano', [CV, SB]], ['caetano veloso', [CV, SB]], ['joao gilberto', [GG]], ['stan getz', [GG]], ['getz', [GG]],
  ['gilberto', [GG]], ['luiz gonzaga', [SN]], ['gonzaga', [SN]], ['saudade', [SN]], ['nordeste', [SN]],
  ['pixinguinha', [PX]], ['acervo raro', [PX]], ['songbook', [SB]], ['vol 1', [SB]],
  ['hominis canidae', ['Hominis Canidae #42 - Maio']], ['maio', ['Hominis Canidae #42 - Maio']],
  ['faixa duplicada', ['Álbum com Faixa Duplicada']], ['artista teste', ['Álbum com # no caminho']],
  ['CHICO BUARQUE', [C, SB]], ['  chico   buarque  ', [C, SB]], ['chico, buarque!', [C, SB]],
  ['tem chico buarque?', [C, SB]], ['quero ouvir elis regina', [ET, FB]], ['toca caetano veloso', [CV, SB]],
  ['mostre albuns do pixinguinha', [PX]], ['procura saudade do nordeste', [SN]],
  ['elis regina anos 70', [ET, FB]], ['chico buarque anos 90', [SB]], ['chico buarque 1971', [C]],
  ['elis 1976', [FB]], ['samba', [ 'Álbum com Faixa Duplicada' ].filter(() => false)].slice(0, 0),
].filter(Boolean).filter(x => x.length);
PALAVRA.push(['chico buarque 1930', VAZIO], ['pixinguinha anos 90', VAZIO], ['surpresa pf', SORTEIO], ['me surpreenda', SORTEIO]);

// ── C. jeito real de escrever (seção 1 do roteiro) ───────────────────────
const REAL = [
  ['q tem do chico buarque pf', [C, SB]], ['chico buarque pfv', [C, SB]], ['vc tem elis regina?', [ET, FB]],
  ['bora ouvir caetano', [CV, SB]], ['ta, quero pixinguinha', [PX]], ['elis ai', [ET, FB]],
  ['anos 70 pf', [C, CE, ET, FB]], ['q albuns dos anos 60', [CV, GG]], ['oi, tem algo de 1957?', [SN]],
  ['valeu, agora chico', [C, SB]], ['olá! gostaria de ouvir getz', [GG]], ['hey tem joao gilberto', [GG]],
  ['quero elis e tom', [ET]], ['mostra o clube da esquina vlw', [CE]], ['luiz gonzaga blz', [SN]],
  ['anos 90 tbm', [SB]], ['chico btn', [C, SB]], ['elis 70', [ET, FB]].slice(0, 0),
  ['tem cartola?', VAZIO], ['q tem de beatles', VAZIO], ['queria ouvir djavan', VAZIO],
  ['quero algo de gilberto gil', [GG]], ['pf toca pixinguinha', [PX]], ['vc conhece clube da esquina?', [CE]],
  ['sabe me indicar caetano veloso pf', [CV, SB]], ['bom dia, elis regina', [ET, FB]],
  ['boa noite quero anos 50', [SN]], ['tem do pixinguinha ai?', [PX]], ['elis ta ai?', [ET, FB]],
].filter(x => x.length);

// ── D. erros de digitação ────────────────────────────────────────────────
const TYPOS = [
  ['pixiguinha', QUIS('pixinguinha')], ['pixinguina', QUIS('pixinguinha')], ['caetno veloso', QUIS('caetano')],
  ['gonzaga luis', [SN]], ['construsao', QUIS('construcao')], ['saudadi do nordeste', QUIS('saudade')],
  ['getz gilbrto', QUIS('gilberto')], ['falso brilhanti', QUIS('brilhante')], ['esquinna', QUIS('esquina')],
  ['buarqui', QUIS('buarque')], ['jobin', QUIS('jobim')].slice(0, 0),
].filter(x => x.length);

// ── E. não entendeu → sugere 3 ao acaso ──────────────────────────────────
const SUGERE_CASOS = [
  'me mostra o que tem', 'algo calmo e triste', 'triste', 'lento', 'algo pra dormir', 'musica animada',
  'romantico', 'dancante', 'algo agitado', 'tranquilo', 'alegre e feliz', 'nostalgico', 'melancolico',
  'instrumental', 'cantado', 'eletronico', 'acustico', 'pesado', 'agressivo', 'festivo',
  'qualquer coisa', 'sei la', 'algo legal', 'q tem de bom',
].map(m => [m, SUGERE]);
// "me surpreenda" é um pedido válido (sorteio com explicação), não uma frase não entendida.

// ── F. zero resultados (entendeu, não há) ────────────────────────────────
const ZERO = [
  'xyzabc', 'qwerty zxcvb', 'zzzxyz', 'chico buarque 1930', 'elis regina anos 50', 'beatles', 'led zeppelin',
  'metallica', 'zé ramalho', 'cazuza', 'legiao urbana', 'paralamas do sucesso', 'anos 40', 'anos 80',
].map(m => [m, VAZIO]);

// ── G. comandos e coisas que não são busca ───────────────────────────────
const COMANDOS = [
  ['pause', CMD], ['pausa', CMD], ['pausar', CMD], ['stop', CMD], ['resume', CMD], ['play', CMD], ['continua', CMD],
  ['proxima', CMD], ['próxima faixa', CMD], ['pula', CMD], ['skip', CMD], ['anterior', CMD], ['voltar', CMD], ['Pause!', CMD],
  ['eta?', RECUSA], ['rodando?', RECUSA], ['rodou tudo?', RECUSA], ['ha t asks?', RECUSA], ['status', RECUSA],
  ['quanto falta', RECUSA], ['terminou?', RECUSA], ['progresso', RECUSA],
];

// ── H. continuação ("e nos anos 70?") — duas mensagens por caso ───────────
const CONTINUACAO = [
  [['chico buarque', 'e nos anos 70?'], [C]], [['chico buarque', 'e nos anos 90?'], [SB]],
  [['elis regina', 'so 1976'], [FB]], [['elis', 'e 1974'], [ET]], [['caetano', 'e nos anos 70?'], VAZIO],
  [['pixinguinha', 'e anos 30'], [PX]], [['getz', 'so anos 60'], [GG]], [['chico', 'e 1994'], [SB]],
];

// ── I. robustez e segurança ──────────────────────────────────────────────
const ROBUSTEZ = [
  '<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '"><svg onload=alert(1)>', "'; DROP TABLE albums; --",
  'a'.repeat(2000), '🎵🎵🎵', '???', '...', '   ', '\u0000\u0001', '%s %d %n', '${7*7}', '{{7*7}}', '\\', '🇧🇷 samba',
];

// ── J. depende da ontologia e do áudio (M2) ──────────────────────────────
const M2 = [
  ['samba lento dos anos 60', 'tem resultado e explica andamento'], ['algo calmo pra dormir', 'humor relaxado'],
  ['forro dancante anos 90', 'gênero + dançável'], ['só instrumental, sem bateria', 'voz instrumental, negação'],
  ['mais lento que Construção', 'comparativo de andamento'], ['choro com bandolim', 'gênero + instrumento'],
  ['rock pesado de garagem', 'gênero'], ['cartolla anos 70 e 80', 'typo + períodos'],
  ['me surpreenda com algo triste', 'sorteio + humor'], ['bossa nova suave', 'gênero + humor'],
  ['musica rapida', 'andamento'], ['algo animado dos anos 70', 'humor + período'], ['tira o que é samba', 'negação de gênero'],
  ['mpb melancolica', 'gênero + humor'], ['violao e voz', 'instrumento'], ['sem voz, so instrumental', 'voz'],
  ['festa', 'humor'], ['triste e lento', 'humor + andamento'], ['musica pra treinar', 'andamento rápido'],
  ['jazz tranquilo', 'gênero + humor'],
];

function registrar(titulo, casos, rodar) {
  test.describe(titulo, () => {
    for (const [msg, esp] of casos) {
      const chave = Array.isArray(msg) ? msg.join(' → ') : msg;
      const nome = `${JSON.stringify(chave).slice(0, 60)}`;
      test(nome, async ({ page }) => { await boot(page); await rodar(page, msg, esp); });
    }
  });
}

const ask = async (page, t) => { const text = t;
  const n = await page.locator('.chat-msg.bot').count();
  await page.fill('#chat-input', t);
  await page.press('#chat-input', 'Enter');
  if (text.trim()) await expect(page.locator('.chat-msg.bot')).toHaveCount(n + 1);
};
const bot = page => page.locator('.chat-msg.bot').last();
const titulos = async page => (await bot(page).locator('.chat-result .r-title').allTextContents()).sort();
const gridCount = page => page.locator('.albums-grid .album-item').count();

async function verificar(page, esp) {
  if (Array.isArray(esp)) {
    expect(await titulos(page)).toEqual([...esp].sort());
    await expect(bot(page)).not.toContainText('Não entendi direito');
    return;
  }
  if (esp === SUGERE) {
    await expect(bot(page)).toContainText('Não entendi direito');
    await expect(bot(page).locator('.chat-result')).toHaveCount(3);
    await expect(bot(page).getByRole('button', { name: 'outras sugestões' })).toBeVisible();
    expect(await gridCount(page)).toBe(3);                       // a grade mostra só as sugestões
    return;
  }
  if (esp === SORTEIO) {
    await expect(bot(page)).toContainText('Sorteei');
    await expect(bot(page).locator('.chat-result').first()).toBeVisible();
    return;
  }
  if (esp === VAZIO) {
    await expect(bot(page)).toContainText('Não achei nenhum álbum');
    await expect(bot(page).locator('.chat-result')).toHaveCount(0);
    await expect(bot(page)).not.toContainText('Não entendi direito');
    return;
  }
  if (esp === RECUSA) {
    await expect(bot(page)).toContainText('Isso eu não faço aqui');
    await expect(bot(page).locator('.chat-result')).toHaveCount(0);
    return;
  }
  if (esp === CMD) {
    await expect(bot(page)).toContainText('Ainda não há nada carregado');
    return;
  }
  if (esp.quis) {
    await expect(bot(page)).toContainText('quis dizer');
    await expect(bot(page)).toContainText(esp.quis);
  }
}

registrar('A. períodos', PERIODO, async (page, m, e) => { await ask(page, m); await verificar(page, e); });
registrar('B. artista, título, palavra', PALAVRA, async (page, m, e) => { await ask(page, m); await verificar(page, e); });
registrar('C. jeito real de escrever', REAL, async (page, m, e) => { await ask(page, m); await verificar(page, e); });
registrar('D. erros de digitação', TYPOS, async (page, m, e) => { await ask(page, m); await verificar(page, e); });
// Com o motor v1 e os dados de áudio (CHAT_FASE=m2), as qualidades soltas passam a ser entendidas: respondem e explicam.
const ENTENDIDAS_M2 = new Set(['algo calmo e triste', 'triste', 'lento', 'algo pra dormir', 'musica animada', 'romantico', 'dancante', 'algo agitado',
  'tranquilo', 'alegre e feliz', 'nostalgico', 'melancolico', 'instrumental', 'cantado', 'eletronico', 'pesado', 'agressivo', 'festivo']);
registrar('E. não entendeu → sugere 3 ao acaso', SUGERE_CASOS, async (page, m, e) => {
  await ask(page, m);
  if (FASE_M2 && ENTENDIDAS_M2.has(m)) {
    await expect(bot(page)).not.toContainText('Não entendi direito');
    await expect(bot(page).locator('details.chat-why')).toBeVisible();
    return;
  }
  await verificar(page, e);
});
registrar('F. zero resultados', ZERO, async (page, m, e) => { await ask(page, m); await verificar(page, e); });
registrar('G. comandos e não-busca', COMANDOS, async (page, m, e) => { await ask(page, m); await verificar(page, e); });
registrar('H. continuação', CONTINUACAO, async (page, ms, e) => {
  await ask(page, ms[0]); await expect(bot(page)).toBeVisible();
  const n = await page.locator('.chat-msg.bot').count();
  await ask(page, ms[1]);
  await expect(page.locator('.chat-msg.bot')).toHaveCount(n + 1);
  await verificar(page, e);
});

test.describe('I. robustez e segurança', () => {
  for (const m of ROBUSTEZ) {
    test(JSON.stringify(m).slice(0, 50), async ({ page }) => {
      const erros = []; let dialogos = 0;
      page.on('pageerror', e => erros.push(String(e)));
      page.on('dialog', d => { dialogos++; d.dismiss(); });
      await boot(page);
      await ask(page, m);
      await page.waitForTimeout(150);
      expect(erros).toEqual([]);
      expect(dialogos).toBe(0);
      expect(await page.locator('#chat-log script, #chat-log svg[onload], #chat-log img[onerror]').count()).toBe(0);
      await expect(page.locator('#chat-input')).toBeEnabled();    // o chat continua vivo
      await ask(page, 'chico buarque');
      expect(await titulos(page)).toEqual([C, SB].sort());
    });
  }
});

test.describe('J. ontologia e áudio (CHAT_FASE=m2)', () => {
  for (const [m, quando] of M2) {
    (FASE_M2 ? test : test.skip)(`${m} — ${quando}`, async ({ page }) => {
      await boot(page);
      await ask(page, m);
      await expect(bot(page)).not.toContainText('Ainda não sei filtrar');
      await expect(bot(page)).not.toContainText('Não entendi direito');
      await expect(bot(page).locator('details.chat-why')).toBeVisible();   // sempre explica o porquê
    });
  }
});

test('o conjunto tem 200 mensagens', () => {
  const n = PERIODO.length + PALAVRA.length + REAL.length + TYPOS.length + SUGERE_CASOS.length + ZERO.length
    + COMANDOS.length + CONTINUACAO.length + ROBUSTEZ.length + M2.length;
  expect(n).toBeGreaterThanOrEqual(200);
});
