const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const fixtureGz = fs.readFileSync(path.join(__dirname, 'fixtures', 'albums.json.gz'));

const ac = {
  catalogo: {
    ano_min: 1930, ano_max: 2025,
    albuns_por_decada: { '1960': 3, '1970': 4, '2020': 3 },
    albuns_por_ano: { '1971': 1, '1972': 1 },
    artistas_mais_albuns: [{ nome: 'Chico Buarque', n: 5 }],
  },
  bpm_histograma_10: { '80': 10, '90': 30 },
  humores_essentia: [{ nome: 'melodic', n: 9 }],
  instrumentos: [{ nome: 'drums', n: 7 }],
  tom: { por_tom: [{ tom: 'C', modo: 'minor', n: 4 }] },
  features_por_decada: { '1970': { bpm: 100.2, dance: 0.4, happy: 0.3, sad: 0.2, relaxed: 0.8, faixas: 12 } },
};
// O service worker buscaria o resumo real e ignoraria o page.route.
test.use({ serviceWorkers: 'block' });

const resumo = { versao: 1, acervos: { uqt: ac, homi: ac } };

async function boot(page, { semResumo = false } = {}) {
  await page.addInitScript(() => localStorage.clear());
  for (const f of ['uqt-albums.json.gz', 'homi-albums.json.gz']) {
    await page.route(`**/${f}`, r => r.fulfill({ status: 200, headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' }, body: fixtureGz }));
  }
  await page.route('**/*-genres.json.gz', r => r.fulfill({ status: 404 }));
  await page.route('**/*.mp3', r => r.fulfill({ status: 200, body: Buffer.alloc(0) }));
  await page.route('**/capa-min.jpg', r => r.fulfill({ status: 404 }));
  await page.route('**/report-error', r => r.fulfill({ status: 204 }));
  await page.route('**/resumo-acervo.json', r => semResumo
    ? r.fulfill({ status: 404 })
    : r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(resumo) }));
  await page.goto('/');
  await page.waitForSelector('.album-item', { timeout: 8000 });
}

test('abre e fecha, trocando com o painel de navegação', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#explorar-panel')).toBeHidden();
  await page.click('#btn-explorar');
  await expect(page.locator('#explorar-panel')).toBeVisible();
  await expect(page.locator('#browse-panel')).toBeHidden();
  await expect(page.locator('#btn-explorar')).toHaveAttribute('aria-pressed', 'true');
  await page.click('#btn-explorar-close');
  await expect(page.locator('#explorar-panel')).toBeHidden();
  await expect(page.locator('#browse-panel')).toBeVisible();
});

test('atalho E abre e Esc fecha', async ({ page }) => {
  await boot(page);
  await page.locator('body').press('e');
  await expect(page.locator('#explorar-panel')).toBeVisible();
  await page.locator('#explorar-search').press('Escape');
  await expect(page.locator('#explorar-panel')).toBeHidden();
});

test('escolher uma década filtra a grade e clicar de novo limpa', async ({ page }) => {
  await boot(page);
  await page.click('#btn-explorar');
  await page.locator('.explorar-row', { hasText: 'Anos 1970' }).click();
  await expect(page.locator('.explorar-row.active')).toContainText('Anos 1970');
  await expect(page.locator('#search-count')).toHaveText('4 álbuns');
  await page.locator('.explorar-row', { hasText: 'Anos 1970' }).click();
  await expect(page.locator('#search-count')).not.toHaveClass(/visible/);
});

test('escolher um artista usa o filtro de artista', async ({ page }) => {
  await boot(page);
  await page.click('#btn-explorar');
  await page.locator('summary', { hasText: 'Mais álbuns' }).click();
  await page.locator('.explorar-row', { hasText: 'Chico Buarque' }).click();
  await expect(page.locator('#clear-all-filters')).toBeVisible();
});

test('a busca do painel esconde seções sem resultado e mostra só leitura', async ({ page }) => {
  await boot(page);
  await page.click('#btn-explorar');
  await page.fill('#explorar-search', 'melodic');
  await expect(page.locator('.explorar-sec')).toHaveCount(1);
  await expect(page.locator('.explorar-sec summary')).toContainText('Humor');
  await expect(page.locator('.explorar-row.is-link')).toHaveCount(0);
});

test('sem o resumo, o painel avisa em vez de quebrar', async ({ page }) => {
  await boot(page, { semResumo: true });
  await page.click('#btn-explorar');
  await expect(page.locator('.explorar-empty')).toContainText('Não foi possível');
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 780 } });
  test('vira gaveta e fecha pelo scrim', async ({ page }) => {
    await boot(page);
    await page.click('#btn-explorar');
    await expect(page.locator('#explorar-panel')).toHaveClass(/open/);
    await expect(page.locator('#browse-scrim')).toHaveClass(/open/);
    await page.locator('#browse-scrim').click({ position: { x: 380, y: 400 } });
    await expect(page.locator('#explorar-panel')).toBeHidden();
  });
});
