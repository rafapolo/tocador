// Service worker ligado de verdade: o resto da suíte o bloqueia para o page.route valer.
// HTML antigo com JS novo derrubou o /atlas (criarGrafoAtlas is not defined): o HTML saía do
// cache e o ?v= dos scripts era ignorado, porque a chave do cache era só o caminho.
const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'allow' });   // the config blocks them for every other spec

async function comWorker(page) {
  await page.goto('/?acervo=uqt');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise(res => navigator.serviceWorker.addEventListener('controllerchange', res, { once: true }));
    }
  });
}
// Grava `corpo` no cache do worker, como se uma versão anterior tivesse ficado lá.
const envelhecer = (page, chave, corpo) => page.evaluate(async ([k, c]) => {
  const [nome] = await caches.keys();
  await (await caches.open(nome)).put(k, new Response(c, { headers: { 'Content-Type': 'text/html' } }));
}, [chave, corpo]);

test('SW1: uma página no cache não vence a da rede', async ({ page }) => {
  await comWorker(page);
  await envelhecer(page, '/atlas', '<title>pagina velha</title>');
  await page.goto('/atlas?de=uqt&album=x');
  await expect(page).toHaveTitle(/Atlas/);
});

test('SW2: script com ?v= novo não recebe a cópia guardada de outra versão', async ({ page }) => {
  await comWorker(page);
  await envelhecer(page, '/js/util.js', '// velho');
  const texto = await page.evaluate(() => fetch('/js/util.js?v=novo').then(r => r.text()));
  expect(texto).not.toContain('// velho');
});

test('SW3: sem rede, página e script com ?v= saem do cache', async ({ page, context }) => {
  await comWorker(page);
  await context.setOffline(true);
  const texto = await page.evaluate(() => fetch('/js/util.js?v=outra').then(r => r.text()));
  expect(texto).toContain('parseArtists');
  await page.goto('/?acervo=uqt');
  await expect(page.locator('#btn-atlas')).toBeAttached();
});

// Depois de um ETL o catálogo novo chegava antes das features (revalidadas só quando alguém abre um acordeão
// ou a Pegada), a cópia velha era recusada pela impressão digital e todo álbum dizia "não tem análise de áudio".
// js/explorar.js então pede de novo com cache: 'reload', e o worker não pode responder isso com a cópia guardada.
test('SW4: um pedido cache: "reload" vai à rede, e a cópia nova substitui a velha no cache', async ({ page }) => {
  await comWorker(page);
  await envelhecer(page, '/data/homi-features.json.gz', 'velho');
  const tamanho = init => page.evaluate(i => fetch('/data/homi-features.json.gz', i).then(r => r.arrayBuffer()).then(b => b.byteLength), init);
  // (sem um fetch normal antes: a revalidação em segundo plano dele trocaria a cópia velha por conta própria)
  expect(await tamanho({ cache: 'reload' })).toBeGreaterThan(1000);
  expect(await tamanho({})).toBeGreaterThan(1000);       // e ficou guardada no lugar da velha
});
