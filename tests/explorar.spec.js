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
  await page.addInitScript(() => localStorage.clear());
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
  await expect(page.locator('#explorar-panel .ex-tab.active')).toContainText('Explorar');
  await page.locator('#explorar-panel [data-ex-tab="artists"]').click();
  await expect(page.locator('#explorar-panel')).toBeHidden();
  await expect(page.locator('#browse-panel')).toBeVisible();
});

test('a aba Explorar fica em browse-tabs e as abas do painel voltam à lista', async ({ page }) => {
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
  await page.locator('#explorar-search').press('Escape');
  await expect(page.locator('#explorar-panel')).toBeHidden();
});

test('mostra os grupos e a cobertura da análise', async ({ page }) => {
  await boot(page);
  await abrir(page);
  for (const g of ['Ritmo', 'Clima', 'Timbre']) await expect(page.locator('.explorar-sec summary', { hasText: g })).toBeVisible();
  await expect(page.locator('.ex-resumo')).toContainText('álbuns com análise de áudio');
  await expect(page.locator('#explorar-apply')).toHaveText('ver todos os álbuns');
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

test('faixas fora do filtro ficam desativadas no álbum e não tocam', async ({ page }) => {
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
      await page.locator('#track-list .track-item.filtered-out').first().click({ force: true });
      await expect(page.locator('#track-list .track-item.playing.filtered-out')).toHaveCount(0);
    }
  }
  expect(achou).toBe(true);
  await page.locator('.ex-chip-limpar').click();
  await expect(page.locator('#track-list .track-item.filtered-out')).toHaveCount(0);
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
    await expect(page.locator('#browse-scrim')).toHaveClass(/open/);
    await ajustar(page, 'Andamento', 'lo', 100);
    await page.click('#explorar-apply');
    await expect(page.locator('#explorar-panel')).toBeHidden();
    await expect(page.locator('#clear-all-filters')).toBeVisible();
  });
});
