const { test, expect } = require('@playwright/test');
const { gotoWithFixture } = require('./helpers');

// Páginas de álbum estáticas (<html data-album-pages>, script/build-album-pages.js): o JS do player
// não pode desfazer o que o gerador escreveu, porque é a cópia renderizada que o Google lê.
test.use({ serviceWorkers: 'block' });

test('na página estática o título do álbum continua sendo o único H1 e a descrição do gerador fica como veio', async ({ page }) => {
  await gotoWithFixture(page, '/?acervo=uqt');
  const r = await page.evaluate(() => {
    document.documentElement.setAttribute('data-album-pages', '');
    const album = albums[0];
    // o gerador escreve estes dois; o canônico é a página do álbum
    document.querySelector('meta[name="description"]')?.remove();
    const m = document.createElement('meta'); m.name = 'description'; m.content = 'Descrição do gerador'; document.head.appendChild(m);
    let c = document.querySelector('link[rel="canonical"]');
    if (!c) { c = document.createElement('link'); c.rel = 'canonical'; document.head.appendChild(c); }
    c.href = albumPageUrl(album);
    selectedAlbum = album;
    renderAlbumHeader();
    updateMetaTags(album);
    return {
      desc: document.querySelector('meta[name="description"]').content,
      h1: [...document.querySelectorAll('#album-header h1')].map(e => e.textContent),
      h2: document.querySelectorAll('#album-header h2').length,
      nome: album.name,
    };
  });
  expect(r.desc).toBe('Descrição do gerador');
  expect(r.h1).toEqual([r.nome]);
  expect(r.h2).toBe(0);
});

test('fora das páginas estáticas o álbum é um H2 e a aba mantém o título de sempre, "♪ Artista · Álbum"', async ({ page }) => {
  await gotoWithFixture(page, '/?acervo=uqt');
  const r = await page.evaluate(() => {
    const album = albums.find(a => a.artists) || albums[0];
    selectedAlbum = album;
    renderAlbumHeader();
    updateMetaTags(album);
    return {
      titulo: document.title,
      desc: document.querySelector('meta[name="description"]').content,
      h2: [...document.querySelectorAll('#album-header h2')].map(e => e.textContent),
      h1: document.querySelectorAll('#album-header h1').length,
      nome: album.name, artistas: album.artists,
    };
  });
  expect(r.h2).toEqual([r.nome]);
  expect(r.h1).toBe(0);
  expect(r.titulo).toBe(`♪ ${r.artistas} · ${r.nome}`);
});
