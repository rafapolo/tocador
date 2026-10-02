const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const fx = n => fs.readFileSync(path.join(__dirname, 'fixtures', n));
const albumsGz = fx('albums.json.gz');
const featuresGz = fx('albums-features.json.gz');

// O service worker buscaria os arquivos reais e ignoraria o page.route.
test.use({ serviceWorkers: 'block' });

// Features em que as faixas de um mesmo álbum divergem (ver fixtures/build-features-mistas.js).
const mistasFile = fx('albums-features-mistas.json.gz');

async function boot(page, { semFeatures = false, mistas = false } = {}) {
  // Limpa só na primeira carga da aba: um reload no meio do teste mantém o que o painel guardou.
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('__limpo')) { localStorage.clear(); sessionStorage.setItem('__limpo', '1'); }
  });
  const gz = body => ({ status: 200, headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' }, body });
  for (const f of ['uqt-albums.json.gz', 'homi-albums.json.gz']) await page.route(`**/${f}`, r => r.fulfill(gz(albumsGz)));
  await page.route('**/*-features.json.gz', r => semFeatures ? r.fulfill({ status: 404 }) : r.fulfill(gz(mistas ? mistasFile : featuresGz)));
  await page.route('**/resumo-acervo.json', r => r.fulfill({ status: 404 }));
  await page.route('**/*-genres.json.gz', r => r.fulfill({ status: 404 }));
  await page.route('**/*.mp3', r => r.fulfill({ status: 200, body: Buffer.alloc(0) }));
  await page.route('**/capa-min.jpg', r => r.fulfill({ status: 404 }));
  await page.route('**/report-error', r => r.fulfill({ status: 204 }));
  await page.goto('/');
  await page.waitForSelector('.album-item', { timeout: 8000 });
}

const abrir = async page => {
  if (page.viewportSize().width <= 768) await page.click('#btn-browse');   // no mobile a aba fica na gaveta
  await page.click('#btn-explorar');
  await page.waitForSelector('.ex-feat');
};

// Move uma alça por teclado: o range nativo aceita setas e Home/End.
const ajustar = (page, nome, qual, valor) => page.locator('.ex-feat', { hasText: nome }).locator(`input.ex-${qual}`)
  .evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, valor);

test('abre e fecha, trocando com o painel de navegação', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#explorar-panel')).toBeHidden();
  await abrir(page);
  await expect(page.locator('#browse-panel')).toBeHidden();
  await expect(page.locator('#explorar-panel .ex-tab.active')).toContainText('Pegada');
  await page.locator('#explorar-panel [data-ex-tab="artists"]').click();
  await expect(page.locator('#explorar-panel')).toBeHidden();
  await expect(page.locator('#browse-panel')).toBeVisible();
});

test('a aba Pegada fica em browse-tabs e as abas do painel voltam à lista', async ({ page }) => {
  await boot(page);
  await expect(page.locator('.browse-tabs #btn-explorar')).toBeVisible();
  await expect(page.locator('.header-stats #btn-explorar')).toHaveCount(0);
  await abrir(page);
  await page.locator('#explorar-panel [data-ex-tab="artists"]').click();
  await expect(page.locator('#explorar-panel')).toBeHidden();
  await expect(page.locator('#browse-panel')).toBeVisible();
  await expect(page.locator('.browse-tab[data-tab="artists"]')).toHaveClass(/active/);
});

test('o seletor de acervo continua no topo e o X só aparece no mobile', async ({ page }) => {
  await boot(page);
  await abrir(page);
  await expect(page.locator('#explorar-acervo-select')).toBeVisible();
  await expect(page.locator('#explorar-acervo-select option')).not.toHaveCount(0);
  await expect(page.locator('#btn-explorar-close')).toBeHidden();
});

test('atalho E abre e Esc fecha', async ({ page }) => {
  await boot(page);
  await page.locator('body').press('e');
  await expect(page.locator('#explorar-panel')).toBeVisible();
  await expect(page.locator('#explorar-search')).toBeFocused();
  await expect(page.locator('#explorar-search')).toHaveValue('');   // a tecla do atalho não vaza para a busca
  await page.locator('#explorar-search').press('Escape');
  await expect(page.locator('#explorar-panel')).toBeHidden();
});

test('mostra os grupos e a cobertura da análise', async ({ page }) => {
  await boot(page);
  await abrir(page);
  for (const g of ['Ritmo', 'Clima', 'Timbre']) await expect(page.locator('.explorar-sec summary', { hasText: g })).toBeVisible();
  await expect(page.locator('.ex-resumo')).toContainText('álbuns com análise de áudio');
  await expect(page.locator('.ex-ajuda')).toContainText('por faixa');
  await expect(page.locator('#explorar-status')).toContainText('nenhum filtro');
  await expect(page.locator('#explorar-apply')).toHaveText('ver todos os álbuns');
});

test('a contagem de álbuns e faixas fica à vista no desktop e é anunciada', async ({ page }) => {
  await boot(page);
  await abrir(page);
  await expect(page.locator('#explorar-anuncio')).toHaveAttribute('role', 'status');
  await ajustar(page, 'Andamento', 'lo', 100);
  await expect(page.locator('#search-count')).toHaveClass(/visible/);
  const n = parseInt(await page.locator('#search-count').textContent(), 10);
  await expect(page.locator('#explorar-status')).toBeVisible();
  await expect(page.locator('#explorar-status')).toContainText(new RegExp(`^${n} álbu.* faixas? passam$`));
  await expect(page.locator('#explorar-anuncio')).toContainText(`${n} álbu`);
  await expect(page.locator('.explorar-sec', { hasText: 'Ritmo' }).locator('.ex-sec-n')).toHaveText('1');
});

test('grade vazia: o painel avisa e sugere qual filtro tirar', async ({ page }) => {
  await boot(page, { mistas: true });   // faixas a 80 ou 140 bpm: 100–120 não pega nenhuma
  await abrir(page);
  await ajustar(page, 'Andamento', 'lo', 100);
  await ajustar(page, 'Andamento', 'hi', 120);
  await ajustar(page, 'Triste', 'lo', 10);
  await expect(page.locator('#explorar-status')).toHaveClass(/vazio/);
  await expect(page.locator('#explorar-status')).toHaveText('Nenhuma faixa passa em todos os filtros');
  await expect(page.locator('#explorar-anuncio')).toContainText('Nenhuma faixa');
  // Só tirar o andamento devolve álbuns; tirar "Triste" não, então não vira sugestão.
  await expect(page.locator('.ex-sugestao')).toHaveCount(1);
  await expect(page.locator('.ex-sugestao')).toContainText('Andamento');
  await page.locator('.ex-sugestao').click();
  await expect(page.locator('#explorar-status')).not.toHaveClass(/vazio/);
  await expect(page.locator('#explorar-sugestoes')).toBeHidden();
  await expect(page.locator('.ex-chip', { hasText: 'Triste' })).toBeVisible();
});

test('cada característica tem o próprio botão de limpar', async ({ page }) => {
  await boot(page);
  await abrir(page);
  const feat = page.locator('.ex-feat', { hasText: 'Andamento' });
  await expect(feat.locator('.ex-feat-reset')).toBeHidden();
  await ajustar(page, 'Andamento', 'lo', 100);
  await feat.locator('.ex-feat-reset').click();
  await expect(feat.locator('.ex-feat-out')).toHaveText('qualquer');
  await expect(page.locator('.ex-chip')).toHaveCount(0);
  await expect(feat.locator('input.ex-lo')).toBeFocused();
});

test('teclado: PageUp/Shift+seta andam de 10, Delete limpa e o valor é falado em pt-BR', async ({ page }) => {
  await boot(page);
  await abrir(page);
  const lo = page.locator('.ex-feat', { hasText: 'Andamento' }).locator('input.ex-lo');
  await expect(lo).toHaveAttribute('aria-valuetext', 'sem limite');
  await lo.focus();
  await page.keyboard.press('PageUp');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(lo).toHaveValue('61');
  await expect(lo).toHaveAttribute('aria-valuetext', '61 bpm');
  await expect(page.locator('.ex-chip').first()).toContainText('Andamento 61 bpm+');
  await page.keyboard.press('Delete');
  await expect(lo).toHaveValue('40');
  await expect(page.locator('.ex-chip')).toHaveCount(0);
});

test('alças juntas no topo: a de baixo fica por cima para poder ser arrastada', async ({ page }) => {
  await boot(page);
  await abrir(page);
  await ajustar(page, 'Festa', 'lo', 100);
  const z = await page.locator('.ex-feat', { hasText: 'Festa' }).locator('input.ex-lo').evaluate(el => el.style.zIndex);
  expect(z).toBe('2');
});

test('grupos recolhidos continuam recolhidos depois de recarregar', async ({ page }) => {
  await boot(page);
  await abrir(page);
  await page.locator('.explorar-sec summary', { hasText: 'Clima' }).click();
  await expect(page.locator('.explorar-sec[data-grupo="Clima"]')).not.toHaveAttribute('open', '');
  // O evento toggle é assíncrono: espera a gravação antes de recarregar.
  await expect.poll(() => page.evaluate(() => localStorage.getItem('tocador-explorar-fechados'))).toBe('["Clima"]');
  await page.reload();
  await page.waitForSelector('.album-item');
  await abrir(page);
  await expect(page.locator('.explorar-sec[data-grupo="Clima"]')).not.toHaveAttribute('open', '');
  await expect(page.locator('.explorar-sec[data-grupo="Ritmo"]')).toHaveAttribute('open', '');
  // A busca abre o grupo enquanto dura; sem busca ele volta a ficar recolhido.
  await page.fill('#explorar-search', 'triste');
  await expect(page.locator('.explorar-sec[data-grupo="Clima"]')).toHaveAttribute('open', '');
  await page.fill('#explorar-search', '');
  await expect(page.locator('.explorar-sec[data-grupo="Clima"]')).not.toHaveAttribute('open', '');
});

test('mover um slider filtra a grade, vira chip e limpa', async ({ page }) => {
  await boot(page);
  await abrir(page);
  await ajustar(page, 'Andamento', 'lo', 100);
  await expect(page.locator('#search-count')).toHaveClass(/visible/);
  await expect(page.locator('.ex-chip').first()).toContainText('Andamento 100 bpm+');
  await expect(page.locator('#clear-all-filters')).toBeVisible();
  const n = parseInt(await page.locator('#search-count').textContent(), 10);
  await expect(page.locator('#explorar-apply')).toContainText(`ver ${n} álbun`);
  await page.locator('.ex-chip', { hasText: 'Andamento' }).click();
  await expect(page.locator('#search-count')).not.toHaveClass(/visible/);
  await expect(page.locator('.ex-chip')).toHaveCount(0);
});

test('arrastar a alça com o mouse funciona e a alça fica visível', async ({ page }) => {
  await boot(page);
  await abrir(page);
  const hi = page.locator('.ex-feat', { hasText: 'Andamento' }).locator('input.ex-hi');
  const b = await hi.boundingBox();
  await page.mouse.move(b.x + b.width - 7, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 5 });
  await page.mouse.up();
  expect(Number(await hi.inputValue())).toBeLessThan(200);
  await expect(page.locator('.ex-chip').first()).toContainText('Andamento até');
  // A alça herdava a cor preta do input e sumia no fundo escuro.
  const cor = await hi.evaluate(el => getComputedStyle(el, '::-webkit-slider-thumb').backgroundColor);
  expect(cor).not.toBe('rgb(0, 0, 0)');
});

test('arrastar não dispara a animação de troca da grade (piscava a cada passo)', async ({ page }) => {
  await boot(page);
  await abrir(page);
  await page.evaluate(() => {
    window.__swaps = 0;
    new MutationObserver(ms => ms.forEach(m => { if (m.target.classList.contains('swapping')) window.__swaps++; }))
      .observe(document.querySelector('.albums-grid-inner'), { attributes: true, attributeFilter: ['class'] });
  });
  for (const v of [60, 80, 100, 110, 120]) await ajustar(page, 'Andamento', 'lo', v);
  await expect(page.locator('#search-count')).toHaveClass(/visible/);
  expect(await page.evaluate(() => window.__swaps)).toBe(0);
});

test('faixas fora do filtro ficam desativadas no álbum, com legenda, e não tocam', async ({ page }) => {
  await boot(page, { mistas: true });
  await abrir(page);
  await ajustar(page, 'Andamento', 'lo', 120);
  await expect(page.locator('#search-count')).toHaveClass(/visible/);
  const itens = page.locator('.album-item');
  const total = await itens.count();
  let achou = false;
  for (let i = 0; i < total && !achou; i++) {
    await itens.nth(i).click();
    await page.waitForSelector('#track-list .track-item');
    const fora = await page.locator('#track-list .track-item.filtered-out').count();
    const dentro = await page.locator('#track-list .track-item:not(.filtered-out)').count();
    expect(dentro).toBeGreaterThan(0);               // o álbum só está na grade porque tem faixa dentro do filtro
    if (fora > 0) {
      achou = true;
      await expect(page.locator('#track-list .track-item.filtered-out').first()).toHaveAttribute('aria-disabled', 'true');
      await expect(page.locator('#track-list .track-item.filtered-out').first()).toHaveAttribute('title', /fora do filtro/i);
      await expect(page.locator('#tracks-panel .track-filter-note')).toHaveText(new RegExp(`^${dentro} de ${dentro + fora} faixas passam`));
      await page.locator('#track-list .track-item.filtered-out').first().click({ force: true });
      await expect(page.locator('#track-list .track-item.playing.filtered-out')).toHaveCount(0);
    }
  }
  expect(achou).toBe(true);
  await page.locator('.ex-chip-limpar').click();
  await expect(page.locator('#track-list .track-item.filtered-out')).toHaveCount(0);
  await expect(page.locator('.track-filter-note')).toHaveCount(0);
});

test('o "limpar filtro" da legenda do álbum tira os filtros da Pegada', async ({ page }) => {
  await boot(page, { mistas: true });
  await abrir(page);
  await ajustar(page, 'Andamento', 'lo', 120);
  await expect(page.locator('#search-count')).toHaveClass(/visible/);
  await page.locator('.album-item').first().click();
  await page.locator('#tracks-panel .track-filter-note button').click();
  await expect(page.locator('.track-filter-note')).toHaveCount(0);
  await expect(page.locator('.ex-chip')).toHaveCount(0);
  await expect(page.locator('#search-count')).not.toHaveClass(/visible/);
});

test('filtros combinam por E e a faixa impossível esvazia a grade', async ({ page }) => {
  await boot(page);
  await abrir(page);
  await ajustar(page, 'Dançabilidade', 'lo', 99);
  await ajustar(page, 'Agressivo', 'lo', 99);
  await expect(page.locator('.ex-chip')).toHaveCount(3);   // 2 filtros + "limpar tudo"
  await expect(page.locator('#search-count')).toHaveText('0 álbuns');
});

test('escolher voz e limpar tudo', async ({ page }) => {
  await boot(page);
  await abrir(page);
  await page.getByLabel('instrumental').check();
  await expect(page.locator('.ex-chip').first()).toContainText('Instrumental');
  await page.locator('.ex-chip-limpar').click();
  await expect(page.locator('.ex-chip')).toHaveCount(0);
  await expect(page.getByLabel('tanto faz')).toBeChecked();
  await expect(page.locator('#search-count')).not.toHaveClass(/visible/);
});

test('escolher uma década depois limpa os filtros de características', async ({ page }) => {
  await boot(page);
  await abrir(page);
  await ajustar(page, 'Andamento', 'lo', 100);
  await expect(page.locator('.ex-chip').first()).toBeVisible();
  await page.locator('.decade-btn[data-decade="1970"]').click();
  await expect(page.locator('.ex-chip')).toHaveCount(0);
  await expect(page.locator('#clear-all-filters')).toBeVisible();
});

test('a busca do painel esconde grupos sem resultado', async ({ page }) => {
  await boot(page);
  await abrir(page);
  await page.fill('#explorar-search', 'festa');
  await expect(page.locator('.explorar-sec:visible')).toHaveCount(1);
  await expect(page.locator('.ex-feat:visible')).toHaveCount(1);
});

test('a busca entende sinônimos e nome de grupo, e avisa quando nada casa', async ({ page }) => {
  await boot(page);
  await abrir(page);
  await page.fill('#explorar-search', 'instrumental');
  await expect(page.locator('.ex-feat:visible')).toHaveCount(1);
  await expect(page.locator('.ex-feat:visible .ex-feat-nome')).toHaveText('Voz');
  await page.fill('#explorar-search', 'clima');
  await expect(page.locator('.ex-feat:visible')).toHaveCount(4);
  await page.fill('#explorar-search', 'xyzw');
  await expect(page.locator('#explorar-busca-vazia')).toContainText('Nenhuma característica com “xyzw”');
  await page.locator('#explorar-search').press('Escape');
});

test('Enter na busca leva ao primeiro controle encontrado', async ({ page }) => {
  await boot(page);
  await abrir(page);
  await page.fill('#explorar-search', 'triste');
  await page.locator('#explorar-search').press('Enter');
  await expect(page.locator('.ex-feat', { hasText: 'Triste' }).locator('input.ex-lo')).toBeFocused();
});

test('mostra "carregando" enquanto a análise de áudio chega', async ({ page }) => {
  await boot(page);
  let solta;
  const espera = new Promise(r => { solta = r; });
  await page.unroute('**/*-features.json.gz');
  await page.route('**/*-features.json.gz', async r => {
    await espera;
    r.fulfill({ status: 200, headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' }, body: featuresGz });
  });
  await page.click('#btn-explorar');
  await expect(page.locator('.explorar-carregando')).toContainText('Carregando');
  solta();
  await expect(page.locator('.ex-feat').first()).toBeVisible();
  await expect(page.locator('.explorar-carregando')).toHaveCount(0);
});

test('sem features publicadas o painel avisa em vez de quebrar', async ({ page }) => {
  await boot(page, { semFeatures: true });
  await page.click('#btn-explorar');
  await expect(page.locator('.explorar-empty')).toContainText('não tem análise de áudio');
  await expect(page.locator('#explorar-apply')).toBeHidden();
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 780 } });
  test('vira gaveta, aplica pelo botão do rodapé', async ({ page }) => {
    await boot(page);
    await abrir(page);
    await expect(page.locator('#explorar-panel')).toHaveClass(/open/);
    // Focar a busca abriria o teclado virtual por cima dos controles.
    await expect(page.locator('#explorar-search')).not.toBeFocused();
    await expect(page.locator('#browse-scrim')).toHaveClass(/open/);
    await ajustar(page, 'Andamento', 'lo', 100);
    await page.click('#explorar-apply');
    await expect(page.locator('#explorar-panel')).toBeHidden();
    await expect(page.locator('#clear-all-filters')).toBeVisible();
  });

  test('alças e opções de voz têm alvo de toque confortável', async ({ page }) => {
    await boot(page);
    await abrir(page);
    const alca = await page.locator('#explorar-body').evaluate(el => parseFloat(getComputedStyle(el).getPropertyValue('--ex-thumb')));
    expect(alca).toBeGreaterThanOrEqual(24);
    const voz = await page.locator('.ex-radio').first().boundingBox();
    expect(voz.height).toBeGreaterThanOrEqual(40);
  });

  test('sem nenhum álbum o botão do rodapé diz isso', async ({ page }) => {
    await boot(page, { mistas: true });
    await abrir(page);
    await ajustar(page, 'Andamento', 'lo', 100);
    await ajustar(page, 'Andamento', 'hi', 120);
    await expect(page.locator('#explorar-apply')).toHaveText('nenhum álbum passa nos filtros');
  });
});
