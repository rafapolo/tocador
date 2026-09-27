import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';

const { build, playerTracks, playerTemplate, albumPage } = require('./build-album-pages.js');
// Loaded by build-album-pages.js onto globalThis.
const { albumSlugs } = globalThis;

describe('albumSlugs', () => {
  test('folds accents and punctuation into a lowercase slug', () => {
    expect(albumSlugs([{ path: '1971 - Chico Buarque - Construção' }]))
      .toEqual(['1971-chico-buarque-construcao']);
  });

  // Real case from homi: distinct folders that fold to the same slug must not
  // overwrite each other's page.
  test('disambiguates colliding slugs in catalog order', () => {
    expect(albumSlugs([
      { path: '2018 - Chuva - Chuva' },
      { path: '2018 - Chuva Chuva' },
      { path: '2018 - Chuva — Chuva' },
    ])).toEqual(['2018-chuva-chuva', '2018-chuva-chuva-2', '2018-chuva-chuva-3']);
  });

  test('never yields an empty slug', () => {
    expect(albumSlugs([{ path: '★★★' }])).toEqual(['album']);
  });
});

describe('playerTracks', () => {
  // Must match buildAlbums() in js/ui.js, or #tN links open the wrong track.
  test('dedupes titles before numbering un-numbered tracks', () => {
    const tracks = playerTracks({
      tracks: [
        { title: 'A', file: 'A.mp3' },
        { title: 'a', file: 'dup/A.mp3' },
        { title: 'B', file: 'B.mp3' },
      ],
    });
    expect(tracks.map(t => [t.title, t.num])).toEqual([['A', 1], ['B', 2]]);
  });

  test('prefers the top-level copy over a subfolder duplicate', () => {
    const tracks = playerTracks({
      tracks: [{ title: 'A', file: 'cd1/A.mp3', num: 1 }, { title: 'A', file: 'A.mp3', num: 1 }],
    });
    expect(tracks).toHaveLength(1);
  });
});

describe('albumPage', () => {
  const meta = { title: 'Acervo <Teste>', base_url: 'https://cdn.tocador.cc/uqt' };
  const album = {
    title: 'Fé & "Festa"', artist: 'Zé <b>', year: 1975, path: '1975 - Zé - Fé', has_cover: true,
    tracks: [{ title: 'Um</script><script>x()', num: 1, file: '01.mp3', duration: 125 }],
  };
  const template = playerTemplate(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'));
  const html = albumPage({ template, alias: 'uqt', meta, album, slug: '1975-ze-fe' });

  test('sets canonical, og:url and a cover og:image for link previews', () => {
    expect(html).toContain('<link rel="canonical" href="https://tocador.cc/uqt/1975-ze-fe/">');
    expect(html).toContain('<meta property="og:url" content="https://tocador.cc/uqt/1975-ze-fe/">');
    expect(html).toContain('<meta property="og:image" content="https://cdn.tocador.cc/uqt/1975%20-%20Z%C3%A9%20-%20F%C3%A9/capa-min.jpg">');
  });

  test('escapes catalog text in markup and JSON-LD', () => {
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('</script><script>x()');
    expect(html).toContain('Fé &amp; &quot;Festa&quot;');
    const ld = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1];
    expect(JSON.parse(ld).track[0].name).toBe('Um</script><script>x()');
  });

  // The page is the player, so a copied /<alias>/<slug>/ URL both unfurls and plays.
  test('is the player with the album pre-rendered into it', () => {
    expect(html).toContain('<html data-album-pages lang="pt-BR">');
    expect(html).toContain('src="/js/ui.js"');
    expect(html).toContain('href="/assets/player.css"');
    expect(html).toContain('href="/radio.html"');
    expect(html).not.toMatch(/(?:href|src)="(?:\.\/)?(?:js|assets)\//);
    expect(html).toMatch(/id="album-header"[^>]*><img class="album-cover-large"[^>]*><div class="album-header-info"><h2>Fé &amp; &quot;Festa&quot;<\/h2>/);
    expect(html).toContain('<div class="track-title">Um&lt;/script&gt;&lt;script&gt;x()</div>');
    expect(html).toContain('2:05');
  });

  test('replaces the home page meta instead of adding to it', () => {
    expect(html.match(/<title>/g)).toHaveLength(2); // the album's, plus the mute icon's inline SVG <title>
    expect(html.match(/<link rel="canonical"/g)).toHaveLength(1);
    expect(html.match(/property="og:url"/g)).toHaveLength(1);
    expect(html).not.toContain('Acervo UQT e Hominis Canidae');
  });

  test('fails loudly when index.html no longer has what it cuts', () => {
    expect(() => playerTemplate('<html><head><title>x</title></head><body></body></html>')).toThrow(/index.html template/);
  });

  // Shared links read "<album> — <artist> (<year>) ♪ Tocador", not the archive name.
  test('titles the page and its preview with the album and ♪ Tocador', () => {
    expect(html).toContain('<meta property="og:title" content="Fé &amp; &quot;Festa&quot; — Zé &lt;b&gt; (1975) ♪ Tocador">');
    expect(html).toContain('<title>Fé &amp; &quot;Festa&quot; — Zé &lt;b&gt; (1975) ♪ Tocador</title>');
  });

  test('describes the album as "♪ Toque : banda - álbum - ano - N faixas"', () => {
    expect(html).toContain('<meta property="og:description" content="♪ Toque : Zé &lt;b&gt; - Fé &amp; &quot;Festa&quot; - 1975 - 1 faixa">');
    const bare = albumPage({ template, alias: 'uqt', meta, album: { ...album, artist: '', year: 0, tracks: [...album.tracks, { title: 'Dois', num: 2, file: '02.mp3' }] }, slug: 'y' });
    expect(bare).toContain('<meta property="og:description" content="♪ Toque : Fé &amp; &quot;Festa&quot; - 2 faixas">');
  });

  test('omits og:image cover when the album has none', () => {
    const noCover = albumPage({ template, alias: 'uqt', meta, album: { ...album, has_cover: false }, slug: 'x' });
    expect(noCover).not.toContain('capa-min.jpg');
  });
});

describe('build', () => {
  let out;
  beforeAll(() => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'album-pages-'));
    const fixtures = path.join(__dirname, '..', 'tests', 'fixtures');
    build({ out, catalogs: [['uqt', path.join(fixtures, 'albums.json.gz')], ['v2', path.join(fixtures, 'albums-v2.json.gz')]] });
  });
  afterAll(() => fs.rmSync(out, { recursive: true, force: true }));

  test('writes one page per album and an index linking every one', () => {
    const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tests', 'fixtures', 'albums.json'), 'utf8'));
    const slugs = albumSlugs(catalog.albums);
    const index = fs.readFileSync(path.join(out, 'uqt', 'index.html'), 'utf8');
    for (const slug of slugs) {
      expect(fs.existsSync(path.join(out, 'uqt', slug, 'index.html'))).toBe(true);
      expect(index).toContain(`href="/uqt/${slug}/"`);
    }
  });

  test('reads v2 catalogs too', () => {
    expect(fs.readdirSync(path.join(out, 'v2')).length).toBeGreaterThan(1);
  });

  test('sitemaps list the static pages, not player URLs', () => {
    const idx = fs.readFileSync(path.join(out, 'sitemap.xml'), 'utf8');
    expect(idx).toContain('<loc>https://tocador.cc/sitemap-albums-uqt.xml</loc>');
    expect(idx).toContain('<loc>https://tocador.cc/sitemap-albums-v2.xml</loc>');
    const sm = fs.readFileSync(path.join(out, 'sitemap-albums-uqt.xml'), 'utf8');
    const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    expect(locs[0]).toBe('https://tocador.cc/uqt/');
    for (const loc of locs) expect(loc).toMatch(/^https:\/\/tocador\.cc\/uqt\/([a-z0-9-]+\/)?$/);
  });
});
