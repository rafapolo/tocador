import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';

const { build, playerTracks, albumPage } = require('./build-album-pages.js');
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
  // Must match buildAlbums() in js/ui.js, or ?t= links open the wrong track.
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
  const html = albumPage({ alias: 'uqt', meta, album, slug: '1975-ze-fe', siblings: [] });

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

  test('links tracks into the player with ?t=', () => {
    expect(html).toContain('href="/?acervo=uqt&amp;album=1975+-+Z%C3%A9+-+F%C3%A9&amp;t=1"');
    expect(html).toContain('2:05');
  });

  test('omits og:image cover when the album has none', () => {
    const noCover = albumPage({ alias: 'uqt', meta, album: { ...album, has_cover: false }, slug: 'x', siblings: [] });
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
