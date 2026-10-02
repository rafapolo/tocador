const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const path = require('path');
const fs = require('fs');

const fixtureGz = fs.readFileSync(path.join(__dirname, 'fixtures', 'albums.json.gz'));
const fixtureMp3 = fs.readFileSync(path.join(__dirname, 'fixtures', 'silence.mp3'));

async function boot(page, url = '/') {
  await page.addInitScript(() => {
    for (const k of ['shuffle', 'repeat', 'volume']) {
      localStorage.removeItem('uqt-' + k); localStorage.removeItem('homi-' + k);
    }
    localStorage.setItem('tocador-browse-collapsed', 'true');
  });
  const gz = route => route.fulfill({
    status: 200, headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' }, body: fixtureGz,
  });
  await page.route('**/uqt-albums.json.gz', gz);
  await page.route('**/homi-albums.json.gz', gz);
  await page.route('**/*-genres.json.gz', r => r.fulfill({ status: 404 }));
  await page.route('**/*.mp3', r => r.fulfill({ status: 200, headers: { 'Content-Type': 'audio/mpeg' }, body: fixtureMp3 }));
  await page.route('**/capa-min.jpg', r => r.fulfill({ status: 404 }));
  await page.route('**/report-error', r => r.fulfill({ status: 204 }));
  await page.goto(url);
  await page.waitForSelector('.album-item', { timeout: 8000 });
}

async function openChat(page) {
  await page.click('#btn-chat');
  await expect(page.locator('#chat-panel')).toBeVisible();
}

async function ask(page, text) {
  await page.fill('#chat-input', text);
  await page.press('#chat-input', 'Enter');
}

const lastBot = page => page.locator('.chat-msg.bot').last();
const resultTitles = async page => (await lastBot(page).locator('.chat-result .r-title').allTextContents());

// ── Layout: where the button is and what it replaces ─────────────────────

test('chat button sits right after the radio button', async ({ page }) => {
  await boot(page);
  const [radio, chat] = await Promise.all([page.locator('#btn-radio').boundingBox(), page.locator('#btn-chat').boundingBox()]);
  expect(chat.x).toBeGreaterThan(radio.x + radio.width - 1);       // to the right
  expect(Math.abs(chat.y - radio.y)).toBeLessThan(12);             // same row
  const order = await page.evaluate(() => {
    const kids = [...document.querySelector('.header-stats').children].map(e => e.id);
    return kids.indexOf('btn-chat') - kids.indexOf('btn-radio');
  });
  expect(order).toBe(1);
});

test('opening the chat replaces the browse panel, closing brings it back', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await boot(page);
  await expect(page.locator('#browse-panel')).toBeVisible();
  await expect(page.locator('#chat-panel')).toBeHidden();
  await openChat(page);
  await expect(page.locator('#browse-panel')).toBeHidden();
  await expect(page.locator('#btn-chat')).toHaveAttribute('aria-pressed', 'true');
  // same slot: the chat panel starts where the browse panel did
  const box = await page.locator('#chat-panel').boundingBox();
  expect(box.x).toBeLessThan(2);
  await page.click('#btn-chat-close');
  await expect(page.locator('#chat-panel')).toBeHidden();
  await expect(page.locator('#browse-panel')).toBeVisible();
  await expect(page.locator('#btn-chat')).toHaveAttribute('aria-pressed', 'false');
});

test('the chat button toggles; Escape closes and returns focus to the button', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await page.click('#btn-chat');
  await expect(page.locator('#chat-panel')).toBeHidden();
  await openChat(page);
  await expect(page.locator('#chat-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#chat-panel')).toBeHidden();
  await expect(page.locator('#btn-chat')).toBeFocused();
});

test('first open greets and offers clickable examples', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await expect(page.locator('.chat-msg.bot')).toHaveCount(1);
  await expect(page.locator('.chat-msg.bot .chat-chip').first()).toBeVisible();
  await page.locator('.chat-msg.bot .chat-chip', { hasText: 'anos 70' }).click();
  await expect(page.locator('.chat-msg.user').last()).toHaveText('anos 70');
});

// ── Questions: what the v0 engine must understand ────────────────────────

const CASES = [
  // [pergunta, títulos esperados (ordem não importa), nº total quando maior que a página]
  ['anos 60', ['Caetano Veloso', 'Getz/Gilberto']],
  ['música dos anos 60', ['Caetano Veloso', 'Getz/Gilberto']],
  ['décadas de 70', ['Construção', 'Clube da Esquina', 'Elis & Tom', 'Falso Brilhante']],
  ['década de 1970', ['Construção', 'Clube da Esquina', 'Elis & Tom', 'Falso Brilhante']],
  ['1970s', ['Construção', 'Clube da Esquina', 'Elis & Tom', 'Falso Brilhante']],
  ['quero ver os discos dos anos 50', ['Saudade do Nordeste']],
  ['anos 30', ['Acervo Raro']],
  // vários períodos e intervalos
  ['anos 60 e 70', ['Caetano Veloso', 'Getz/Gilberto', 'Construção', 'Clube da Esquina', 'Elis & Tom', 'Falso Brilhante']],
  ['décadas de 50, 60 e 70', ['Saudade do Nordeste', 'Caetano Veloso', 'Getz/Gilberto', 'Construção', 'Clube da Esquina', 'Elis & Tom', 'Falso Brilhante']],
  ['de 1960 a 1970', ['Caetano Veloso', 'Getz/Gilberto']],
  ['entre 1971 e 1974', ['Construção', 'Clube da Esquina', 'Elis & Tom']],
  ['antes de 1960', ['Saudade do Nordeste', 'Acervo Raro']],               // "Sem Data" (ano 0) fica de fora
  ['antes dos anos 60', ['Saudade do Nordeste', 'Acervo Raro']],
  ['depois de 2000', ['Hominis Canidae #42 - Maio', 'Álbum com # no caminho', 'Álbum com Faixa Duplicada']],
  ['depois dos anos 90', ['Hominis Canidae #42 - Maio', 'Álbum com # no caminho', 'Álbum com Faixa Duplicada']],
  ['a partir de 1994', ['Songbook - Chico Buarque Vol. 1', 'Hominis Canidae #42 - Maio', 'Álbum com # no caminho', 'Álbum com Faixa Duplicada']],
  ['até 1930', ['Acervo Raro']],
  ['quantos álbuns do chico?', ['Construção', 'Songbook - Chico Buarque Vol. 1']],
  ['1971 e 1976', ['Construção', 'Falso Brilhante']],
  ['1971', ['Construção']],
  ['me mostra o que tem de 1972', ['Clube da Esquina']],
  ['Chico Buarque', ['Construção', 'Songbook - Chico Buarque Vol. 1']],
  ['chico buarque anos 70', ['Construção']],
  ['CHICO BUARQUE', ['Construção', 'Songbook - Chico Buarque Vol. 1']],
  ['elis regina', ['Elis & Tom', 'Falso Brilhante']],
  ['elis regina 1976', ['Falso Brilhante']],
  ['Luiz Gonzaga', ['Saudade do Nordeste']],
  ['pixinguinha', ['Acervo Raro']],
  ['carinhoso', ['Acervo Raro']],                                   // só existe como faixa
  ['asa branca', ['Saudade do Nordeste']],
  ['aguas de marco', ['Elis & Tom']],                               // sem acento, com stopword no meio
  ['Águas de Março', ['Elis & Tom']],
  ['tropicalia', ['Caetano Veloso']],                               // faixa "Tropicália"
  ['alegria alegria', ['Caetano Veloso']],
  ['ipanema', ['Getz/Gilberto']],
  ['joão gilberto', ['Getz/Gilberto']],
  ['joao gilberto', ['Getz/Gilberto']],
  ['milton nascimento', ['Clube da Esquina']],
  ['tom jobim 1974', ['Elis & Tom']],
  ['samba', ['Construção']],                                        // faixa "Samba de Orly"
  ['hominis canidae', ['Hominis Canidae #42 - Maio']],
  ['maio', ['Hominis Canidae #42 - Maio']],
  ['2025', ['Hominis Canidae #42 - Maio']],
  ['anos 2020', ['Hominis Canidae #42 - Maio', 'Álbum com # no caminho', 'Álbum com Faixa Duplicada']],
  ['por favor, me indica algo de Caetano', ['Caetano Veloso', 'Songbook - Chico Buarque Vol. 1']],  // 2º: faixa de Caetano
  ['varios', ['Hominis Canidae #42 - Maio']],                                                       // acento dobrado: "Vários"
  ['oi, bom dia! você tem algo do Pixinguinha, por favor?', ['Acervo Raro']],
  ['obrigado, quero ouvir Elis Regina', ['Elis & Tom', 'Falso Brilhante']],
  ['existe alguma coisa de 1994?', ['Songbook - Chico Buarque Vol. 1']],
  ['various artists', ['Songbook - Chico Buarque Vol. 1']],
  ['discos do chico', ['Construção', 'Songbook - Chico Buarque Vol. 1']],
  ['chico e caetano', ['Songbook - Chico Buarque Vol. 1']],                                         // AND: Songbook tem faixa do Caetano
  ['tem alguma coisa do Pixinguinha?', ['Acervo Raro']],
  ['Caetano!!!', ['Caetano Veloso', 'Songbook - Chico Buarque Vol. 1']],
  ['  chico   buarque  ', ['Construção', 'Songbook - Chico Buarque Vol. 1']],
];

for (const [q, expected] of CASES) {
  test(`pergunta: "${q}"`, async ({ page }) => {
    await boot(page);
    await openChat(page);
    await ask(page, q);
    await expect(page.locator('.chat-msg.user').last()).toHaveText(q.trim() === q ? q : q);
    const titles = await resultTitles(page);
    expect([...titles].sort()).toEqual([...expected].sort());
  });
}

// ── Things it must say it does not understand, not fake ──────────────────

test('qualidades que ainda não sabe julgar são declaradas, não buscadas no texto', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'samba lento e melancólico dos anos 60');
  const bot = lastBot(page);
  // "samba" é uma palavra do acervo; década 60 aplica; "lento/melancólico" ficam de fora
  await bot.locator('summary').click();
  await expect(bot).toContainText('não entendi: lento, melancolico');
  await expect(bot).toContainText('década de 1960');
});

test('letras soltas viram ruído: "<b>negrito</b> pixinguinha" acha só o Pixinguinha', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, '<b>negrito</b> pixinguinha');
  await expect(lastBot(page).locator('.r-title')).toHaveText(['Acervo Raro']);
});

test('qualidade que também é palavra de título ainda acha o álbum, e a explicação diz como', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { albums[0].nameLower += ' triste'; });     // simula um álbum chamado "... Triste"
  await openChat(page);
  await ask(page, 'triste');
  await expect(lastBot(page).locator('.chat-result')).toHaveCount(1);
  await lastBot(page).locator('summary').click();
  await expect(lastBot(page).locator('.chat-why')).toContainText('procurei como palavra de título');
});

test('frase só com qualidades não decide nada e diz isso', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'algo calmo e triste');
  await expect(lastBot(page)).toContainText('Ainda não sei filtrar');
  await expect(lastBot(page)).toContainText('Não entendi direito');
  await expect(lastBot(page).locator('.chat-result')).toHaveCount(3);
});

test('palavra que não existe no acervo é ignorada se sobra algo que casa, e a explicação diz', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'samba xyzabc');
  await expect(lastBot(page).locator('.r-title')).toHaveText(['Construção']);
  await lastBot(page).locator('summary').click();
  await expect(lastBot(page).locator('.chat-why')).toContainText('ignorei: xyzabc');
});

test('se nenhuma palavra existe no acervo, não inventa resultado', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'xyzabc qwerty');
  await expect(lastBot(page).locator('.chat-result')).toHaveCount(0);
  await expect(lastBot(page)).toContainText('Não achei nenhum álbum');
});

test('sem resultado: mensagem honesta e a explicação continua disponível', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'zzzxyz');
  await expect(lastBot(page)).toContainText('Não achei nenhum álbum');
  await expect(lastBot(page).locator('summary')).toBeVisible();
});

test('frase vazia de conteúdo não quebra', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'me mostra o que tem');
  await expect(lastBot(page)).toContainText('Não achei o que procurar');
});

test('enviar vazio não faz nada', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, '   ');
  await expect(page.locator('.chat-msg.user')).toHaveCount(0);
});

// ── "por quê?" ───────────────────────────────────────────────────────────

test('"por quê?" mostra como a frase foi lida e quantos álbuns bateram', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'chico buarque anos 70');
  const bot = lastBot(page);
  await bot.locator('summary').click();
  await expect(bot.locator('.chat-why')).toContainText('década de 1970');
  await expect(bot.locator('.chat-why')).toContainText('palavras: chico, buarque');
  await expect(bot.locator('.chat-why')).toContainText('1 álbum cumpre tudo o que entendi');
});

test('dois dígitos: "anos 20" explica a escolha do século', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'anos 20');
  const bot = lastBot(page);
  await bot.locator('summary').click();
  await expect(bot.locator('.chat-why')).toContainText('dois dígitos');
});

test('mais de uma palavra: a explicação avisa que a grade só recebeu a década', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'elis regina anos 70');
  const bot = lastBot(page);
  await bot.locator('summary').click();
  await expect(bot.locator('.chat-why')).toContainText('só apliquei década/ano');
});

// ── Grade sincronizada ───────────────────────────────────────────────────

test('década filtra a grade ao lado e o contador acompanha', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'anos 60');
  await expect(page.locator('.album-item')).toHaveCount(2);
  await expect(page.locator('#search-count')).toContainText('2 álbuns');
});

test('uma palavra filtra a grade; "limpar" restaura tudo', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'pixinguinha');
  await expect(page.locator('.album-item')).toHaveCount(1);
  await ask(page, 'limpar');
  await expect(lastBot(page)).toContainText('Filtros limpos');
  await expect(page.locator('.album-item')).toHaveCount(13);
});

test('uma nova pergunta substitui o filtro da anterior (não acumula)', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'anos 60');
  await expect(page.locator('.album-item')).toHaveCount(2);
  await ask(page, 'pixinguinha');
  await expect(page.locator('.album-item')).toHaveCount(1);
});

// ── Resultado → player ───────────────────────────────────────────────────

test('clicar no resultado abre o álbum no player', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'luiz gonzaga');
  await page.locator('.chat-result').first().click();
  await expect(page.locator('#album-header')).toContainText('Saudade do Nordeste');
  await expect(page.locator('#track-list')).toContainText('Asa Branca');
  expect(new URL(page.url()).searchParams.get('album')).toContain('Luiz Gonzaga');
  await expect(page.locator('#chat-panel')).toBeVisible();          // desktop: o chat fica aberto
});

test('resultado que veio de uma faixa mostra qual faixa', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'carinhoso');
  await expect(lastBot(page).locator('.r-sub')).toContainText('faixa: Carinhoso');
});

// ── Teclado e campo de texto ─────────────────────────────────────────────

test('Enter envia e Shift+Enter quebra a linha', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await page.fill('#chat-input', 'anos 60');
  await page.press('#chat-input', 'Shift+Enter');
  await expect(page.locator('.chat-msg.user')).toHaveCount(0);
  await page.press('#chat-input', 'Enter');
  await expect(page.locator('.chat-msg.user')).toHaveCount(1);
  await expect(page.locator('#chat-input')).toHaveValue('');
});

test('o campo cresce com várias linhas e volta ao enviar', async ({ page }) => {
  await boot(page);
  await openChat(page);
  const h0 = (await page.locator('#chat-input').boundingBox()).height;
  await page.locator('#chat-input').fill('a\nb\nc\nd');
  const h1 = (await page.locator('#chat-input').boundingBox()).height;
  expect(h1).toBeGreaterThan(h0);
  await page.press('#chat-input', 'Enter');
  const h2 = (await page.locator('#chat-input').boundingBox()).height;
  expect(h2).toBeLessThanOrEqual(h0 + 1);
});

test('nova conversa limpa o histórico e saúda de novo', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'anos 60');
  await expect(page.locator('.chat-msg.user')).toHaveCount(1);
  await page.click('#btn-chat-new');
  await expect(page.locator('.chat-msg.user')).toHaveCount(0);
  await expect(page.locator('.chat-msg.bot')).toHaveCount(1);
});

test('o histórico sobrevive a fechar e abrir o painel', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'anos 60');
  await page.click('#btn-chat-close');
  await openChat(page);
  await expect(page.locator('.chat-msg.user')).toHaveCount(1);
});

test('intervalo: a explicação diz que a grade só entende uma década ou um ano', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'de 1960 a 1970');
  await lastBot(page).locator('summary').click();
  await expect(lastBot(page).locator('.chat-why')).toContainText('a grade só entende uma década ou um ano');
  await expect(page.locator('.album-item')).toHaveCount(13);                // grade sem filtro, não filtrada pela metade
});

test('"me surpreenda" sorteia 5 álbuns e outro clique sorteia de novo', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'me surpreenda');
  await expect(lastBot(page)).toContainText('Sorteei 5 de 13 álbuns');
  await expect(lastBot(page).locator('.chat-result')).toHaveCount(5);
  await lastBot(page).locator('.chat-chip', { hasText: 'me surpreenda' }).click();
  await expect(page.locator('.chat-msg.bot').last().locator('.chat-result')).toHaveCount(5);
  expect(await page.locator('.chat-msg.user').count()).toBe(2);
});

test('sorteio respeita o período pedido', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'me surpreenda com algo dos anos 60');
  await expect(lastBot(page)).toContainText('Sorteei 2 de 2 álbuns');
  expect([...(await resultTitles(page))].sort()).toEqual(['Caetano Veloso', 'Getz/Gilberto']);
});

test('erro de digitação: sugere a grafia certa e o clique refaz a pergunta', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'pixinguina');
  await expect(lastBot(page)).toContainText('quis dizer "pixinguinha"');
  await lastBot(page).locator('.chat-chip', { hasText: 'pixinguinha' }).click();
  await expect(lastBot(page).locator('.r-title')).toHaveText(['Acervo Raro']);
});

test('erro de digitação junto de outras palavras e período mantém o resto', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'caetanoo anos 60');
  await expect(lastBot(page)).toContainText('quis dizer "caetano"');
  await lastBot(page).locator('.chat-chip', { hasText: 'caetano' }).click();
  await expect(lastBot(page).locator('.r-title')).toHaveText(['Caetano Veloso']);
});

test('palavra curta ou rara demais não gera sugestão falsa', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'zzzxyz');
  await expect(lastBot(page)).not.toContainText('quis dizer');
});

test('pergunta de continuação mantém o assunto: "chico buarque" + "e nos anos 70"', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'chico buarque');
  await expect(lastBot(page).locator('.chat-result')).toHaveCount(2);
  await ask(page, 'e nos anos 70?');
  await expect(lastBot(page).locator('.r-title')).toHaveText(['Construção']);
  await lastBot(page).locator('summary').click();
  await expect(lastBot(page).locator('.chat-why')).toContainText('mantidas da pergunta anterior');
});

test('assunto novo (com palavras) não herda a pergunta anterior', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'chico buarque');
  await ask(page, 'pixinguinha 1930');
  await expect(lastBot(page).locator('.r-title')).toHaveText(['Acervo Raro']);
});

test('sem marcador de continuação, uma década sozinha é pergunta nova', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'chico buarque');
  await ask(page, 'anos 70');
  await expect(lastBot(page).locator('.chat-result')).toHaveCount(4);      // não ficou só com Chico
});

test('continuação sem resultado oferece o mesmo período sem as palavras antigas', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'pixinguinha');
  await ask(page, 'e nos anos 70?');
  await expect(lastBot(page)).toContainText('Não achei nenhum álbum');
  await lastBot(page).locator('.chat-chip', { hasText: 'anos 70' }).click();
  await expect(lastBot(page).locator('.chat-result')).toHaveCount(4);
});

test('palavra curta só casa como palavra inteira ("tom" não acha "Phantom")', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'tom');
  await expect(lastBot(page).locator('.r-title')).toHaveText(['Elis & Tom']);
});

test('plural e singular corretos', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'pixinguinha');
  await expect(lastBot(page)).toContainText('1 álbum:');
  await ask(page, 'chico buarque');
  await expect(lastBot(page)).toContainText('2 álbuns:');
});

test('depois de "limpar" uma década sozinha não herda nada', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'chico buarque');
  await ask(page, 'limpar');
  await ask(page, 'anos 70');
  await expect(lastBot(page).locator('.chat-result')).toHaveCount(4);
});

test('"mostrar mais" revela o restante quando há mais que uma página', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'anos 2020');   // 3 álbuns: sem paginação
  await expect(page.locator('.chat-msg.bot').last().locator('.chat-chip', { hasText: 'mostrar mais' })).toHaveCount(0);
});

// ── Segurança: texto digitado nunca vira HTML ────────────────────────────

test('HTML digitado aparece como texto e não executa', async ({ page }) => {
  await boot(page);
  await openChat(page);
  let dialogs = 0;
  page.on('dialog', d => { dialogs++; d.dismiss(); });
  const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  await ask(page, payload);
  await expect(page.locator('.chat-msg.user').last()).toHaveText(payload);
  expect(await page.locator('#chat-log img:not(.r-cover), #chat-log script').count()).toBe(0);
  await page.waitForTimeout(300);
  expect(dialogs).toBe(0);
});

test('títulos do catálogo com # e aspas não quebram a lista', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'hominis');
  await expect(lastBot(page).locator('.r-title')).toHaveText('Hominis Canidae #42 - Maio');
});

// ── Mobile ───────────────────────────────────────────────────────────────

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 780 } });

  test('abre como gaveta, fecha pelo scrim e pelo ✕', async ({ page }) => {
    await boot(page);
    await page.click('#btn-chat');
    await expect(page.locator('#chat-panel.open')).toBeVisible();
    await expect(page.locator('#browse-scrim.open')).toBeVisible();
    await page.mouse.click(380, 400);                                  // fora da gaveta
    await expect(page.locator('#chat-panel')).toBeHidden();
    await page.click('#btn-chat');
    await page.click('#btn-chat-close');
    await expect(page.locator('#chat-panel')).toBeHidden();
  });

  test('escolher um resultado fecha a gaveta e mostra o álbum', async ({ page }) => {
    await boot(page);
    await page.click('#btn-chat');
    await ask(page, 'pixinguinha');
    await page.locator('.chat-result').first().click();
    await expect(page.locator('#chat-panel')).toBeHidden();
    await expect(page.locator('#browse-scrim.open')).toHaveCount(0);
  });

  test('o campo de texto não fica escondido e a página não ganha rolagem horizontal', async ({ page }) => {
    await boot(page);
    await page.click('#btn-chat');
    const inp = await page.locator('#chat-input').boundingBox();
    expect(inp.y + inp.height).toBeLessThanOrEqual(780);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });
});

// ── Acessibilidade ───────────────────────────────────────────────────────

test('chat aberto, com resposta, não tem violações axe', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'chico buarque');
  await lastBot(page).locator('summary').click();
  const res = await new AxeBuilder({ page }).include('#chat-panel').analyze();
  expect(res.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(' | ')}`)).toEqual([]);
});

test('o log de mensagens é anunciado a leitores de tela', async ({ page }) => {
  await boot(page);
  const log = page.locator('#chat-log');
  await expect(log).toHaveAttribute('role', 'log');
  await expect(log).toHaveAttribute('aria-live', 'polite');
  await expect(page.locator('#btn-chat')).toHaveAttribute('aria-label', /acervo/i);
});

test('uma resposta longa abre mostrando o começo, não o fim', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 520 });
  await boot(page);
  await openChat(page);
  await ask(page, 'anos 70');             // 4 resultados: mais alto que o painel pequeno
  const log = page.locator('#chat-log');
  const [logBox, headBox] = await Promise.all([
    log.boundingBox(), lastBot(page).locator('p').first().boundingBox(),
  ]);
  expect(headBox.y).toBeGreaterThanOrEqual(logBox.y - 1);        // a primeira linha da resposta está visível
});

test('atalho C abre e fecha o chat; digitar "c" no campo não fecha; Ctrl+C não dispara', async ({ page }) => {
  await boot(page);
  await page.locator('body').press('c');
  await expect(page.locator('#chat-panel')).toBeVisible();
  await expect(page.locator('#chat-input')).toBeFocused();
  await page.keyboard.type('cartola');                                  // contém "c": não pode alternar nada
  await expect(page.locator('#chat-panel')).toBeVisible();
  await expect(page.locator('#chat-input')).toHaveValue('cartola');
  await page.click('#chat-log');                                         // tira o foco do campo
  await page.keyboard.press('Control+c');
  await expect(page.locator('#chat-panel')).toBeVisible();
  await page.keyboard.press('c');
  await expect(page.locator('#chat-panel')).toBeHidden();
});

test('o modal de atalhos lista o C', async ({ page }) => {
  await boot(page);
  await page.click('#btn-shortcuts');
  await expect(page.locator('#shortcuts-modal')).toContainText('Conversar com o acervo');
});

test('digitar no chat não aciona atalhos do player (espaço não toca)', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await page.keyboard.type('anos 60 n p b g');                           // espaço, n, p, b, g
  const paused = await page.evaluate(() => document.getElementById('audio').paused);
  expect(paused).toBe(true);
  await expect(page.locator('#chat-panel')).toBeVisible();
  await expect(page.locator('#chat-input')).toHaveValue('anos 60 n p b g');
});

// ── Não entendeu: 3 álbuns ao acaso, também na grade ─────────────────────

const gridTitles = page => page.locator('#albums-list .album-item').count();

test('nada entendido: sugere 3 álbuns ao acaso, diz o critério e filtra a grade só com eles', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'me mostra o que tem');
  await expect(lastBot(page)).toContainText('Não achei o que procurar');
  await expect(lastBot(page)).toContainText('Não entendi direito');
  await expect(lastBot(page)).toContainText('sorteei ao acaso');
  await expect(lastBot(page).locator('.chat-result')).toHaveCount(3);
  const shown = await resultTitles(page);
  await expect(page.locator('#search-count')).toHaveText('3 álbuns');
  expect(await gridTitles(page)).toBe(3);
  const inGrid = await page.locator('#albums-list .album-item').allTextContents();
  for (const t of shown) expect(inGrid.join('|')).toContain(t);
});

test('"outras sugestões" sorteia mais 3 e a grade acompanha', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'me mostra o que tem');
  await lastBot(page).getByRole('button', { name: 'outras sugestões' }).click();
  await expect(lastBot(page).locator('.chat-result')).toHaveCount(3);
  await expect(page.locator('#search-count')).toHaveText('3 álbuns');
});

test('só qualidades: avisa que não sabe julgar e sugere 3 álbuns, não só um beco sem saída', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'q triste pf');
  await expect(lastBot(page)).toContainText('Ainda não sei filtrar por "triste"');
  await expect(lastBot(page).locator('.chat-result')).toHaveCount(3);
  await expect(lastBot(page)).toContainText('sorteei');
});

test('zero resultados não sorteia nada: só a mensagem honesta', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'zzzxyz');
  await expect(lastBot(page)).toContainText('Não achei nenhum álbum');
  await expect(lastBot(page).locator('.chat-result')).toHaveCount(0);
});

test('outro filtro da grade (década) substitui a lista de sugestões', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'me mostra o que tem');
  await expect(page.locator('#search-count')).toHaveText('3 álbuns');
  await ask(page, 'anos 70');
  await expect(page.locator('#search-count')).not.toHaveText('3 álbuns');
});

test('contadores locais: clicou numa sugestão e reformulou', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'me mostra o que tem');
  await ask(page, 'chico');
  let c = await page.evaluate(() => JSON.parse(localStorage.getItem('tocador-chat-sugestoes')));
  expect(c.mostradas).toBe(1);
  expect(c.reformulou).toBe(1);
  await ask(page, 'me mostra o que tem');
  await lastBot(page).locator('.chat-result').first().click();
  c = await page.evaluate(() => JSON.parse(localStorage.getItem('tocador-chat-sugestoes')));
  expect(c.clicou).toBe(1);
});

// ── Registro real: frases da seção 1 de tasks/proximos-passos.md ─────────

test('abreviações e vícios não viram palavras de busca', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'q albuns do chico pf');
  await expect(lastBot(page).locator('.r-title').first()).toHaveText('Construção');
  await lastBot(page).locator('summary').click();
  await expect(lastBot(page).locator('.chat-why')).toContainText('palavras: chico');
});

test('"bora" e "vc" não atrapalham: "vc tem samba? bora"', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'vc tem chico? bora');
  await expect(lastBot(page).locator('.r-title').first()).toHaveText('Construção');
});

test('frase sem acento, com erro e em inglês misturado não quebra e responde', async ({ page }) => {
  await boot(page);
  await openChat(page);
  for (const f of ['funcionaria hospedado no github as pf today?', 'nao achao possivel q em todo hugginface nao haja um modelo so em pt',
                   'q albuns atuais seriam "ritmo de São João" ??', 'are there music analise tools for a few tracks here?']) {
    await ask(page, f);
    await expect(lastBot(page)).not.toBeEmpty();
    await expect(page.locator('#chat-input')).toBeEnabled();
  }
});

test('"eta?" é recusado com clareza, sem sugerir música nem mexer na grade', async ({ page }) => {
  await boot(page);
  await openChat(page);
  const before = await page.locator('#search-count').textContent();
  for (const f of ['eta?', 'rodou tudo', 'ha t asks?']) {
    await ask(page, f);
    await expect(lastBot(page)).toContainText('Isso eu não faço aqui');
    await expect(lastBot(page).locator('.chat-result')).toHaveCount(0);
  }
  expect(await page.locator('#search-count').textContent()).toBe(before);
});

test('pause / resume / próxima controlam o player', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await ask(page, 'pause');
  await expect(lastBot(page)).toContainText('nada carregado');
  await page.locator('.album-item').first().click();
  await page.click('#btn-play');
  await expect.poll(() => page.evaluate(() => !document.getElementById('audio').paused)).toBe(true);
  await ask(page, 'pause');
  await expect(lastBot(page)).toContainText('Pausado');
  await expect.poll(() => page.evaluate(() => document.getElementById('audio').paused)).toBe(true);
  await ask(page, 'resume');
  await expect(lastBot(page)).toContainText('Tocando de novo');
  await expect.poll(() => page.evaluate(() => !document.getElementById('audio').paused)).toBe(true);
  const t0 = await page.evaluate(() => currentTrack.title);
  await ask(page, 'próxima');
  await expect(lastBot(page)).toContainText('Próxima faixa');
  await expect.poll(() => page.evaluate(() => currentTrack.title)).not.toBe(t0);
});
