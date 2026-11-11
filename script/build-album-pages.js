#!/usr/bin/env bun
// Builds a static, crawlable HTML page per album plus the sitemaps that list them.
//
//   bun script/build-album-pages.js --out . uqt=uqt-albums.json.gz homi=homi-albums.json.gz
//
// Why this exists: the player is a single index.html that renders albums from a
// catalog with JavaScript, so every ?acervo=&album= URL serves the same "♪" shell.
// Google never fetched the album sitemaps and left every album URL unknown, and
// link-preview crawlers (WhatsApp, Telegram, Mastodon…) never run JS, so a shared
// album link showed no cover. Each album here gets a real page at /<alias>/<slug>/:
// the player itself (index.html), with the album's own title, description, cover
// og:image and JSON-LD in <head> and its header and tracklist pre-rendered in the
// body. The player keeps that URL in the address bar (the track as #tN), so any
// copied link unfurls with the cover. /<alias>/ lists every album so crawlers can
// reach all of them by following links, not only through the sitemap.
//
// Writes, under --out:
//   <alias>/index.html                 album index for the acervo
//   <alias>/<slug>/index.html          one page per album
//   <alias>/artista/<slug>/index.html  one small page per artist, for link previews
//   <alias>/genero/<slug>/index.html   one page per genre: the player, filtered, indexable
//   sitemap-albums-<alias>.xml         index + album and genre pages, with cover images
//   sitemap.xml                        sitemap index over the per-acervo files
//
// Slugs come from albumSlugs() in js/acervo-format.js, which the player also uses
// for its address bar, canonical and share links, so the two can't drift apart.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
require('../js/acervo-format.js');
// js/util.js is a classic script with no exports; these two must be the player's own (see artistSlugs()).
const { fold, parseArtists } = new Function(
  `${fs.readFileSync(path.join(__dirname, '..', 'js', 'util.js'), 'utf8')}\nreturn { fold, parseArtists };`)();

const SITE = 'https://tocador.cc';

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Every <loc> needs its path segments percent-encoded; slugs are already [a-z0-9-].
const pathEnc = p => p.split('/').map(encodeURIComponent).join('/');

function fmtDuration(sec) {
  if (!sec || !isFinite(sec)) return '';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const isoDuration = sec => {
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), r = Math.floor(sec % 60);
  return `PT${h ? `${h}H` : ''}${h || m ? `${m}M` : ''}${r}S`;
};

// Mirrors buildAlbums() in js/ui.js: repeated titles collapse to one entry
// (preferring the copy that isn't in a subfolder), and un-numbered tracks are
// numbered by position *after* that. The player resolves ?t= against those
// numbers, so the track links here must be computed the same way.
function playerTracks(album) {
  const out = [];
  const seen = new Map();
  for (const t of album.tracks || []) {
    const key = (t.title || '').toLowerCase();
    const inSub = t.file?.includes('/');
    if (!seen.has(key)) {
      seen.set(key, out.length);
      out.push(t);
    } else if (!inSub && out[seen.get(key)].file?.includes('/')) {
      out[seen.get(key)] = t;
    }
  }
  const nums = playerTrackNums(out);
  return out.map((t, i) => ({
    title: t.title,
    num: nums[i],
    duration: t.duration || 0,
    artists: t.artists ? t.artists.replace(/\x00/g, '; ') : null,
  }));
}

const coverUrl = (base, album) =>
  album.has_cover !== false && base ? `${base}/${encodeURIComponent(album.path)}/capa-min.jpg` : null;

const PAGE_CSS = `
:root{--bg:#0f0e0c;--surface:#1a1814;--surface-light:#2a2620;--accent:#d4a574;--text:#f5f1ed;--text2:#b8b0a8;--muted:#958d83;--border:#3a3530}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 Inter,system-ui,-apple-system,sans-serif}
a{color:var(--accent)}
.wrap{max-width:760px;margin:0 auto;padding:24px 16px 64px}
.crumbs{font-size:.85rem;color:var(--muted);margin-bottom:24px}
.crumbs a{color:var(--text2);text-decoration:none}
.crumbs a:hover{color:var(--accent)}
h1{font-family:"Playfair Display",Georgia,serif;font-size:2rem;line-height:1.2;margin:0 0 4px}
.meta{color:var(--text2);margin:0}
h2{font-family:"Playfair Display",Georgia,serif;font-size:1.2rem;margin:40px 0 8px}
ul.more{padding-left:18px;margin:0}
ul.more li{margin:4px 0}
.artist{margin:0 0 12px}
.artist h2{margin:28px 0 4px;font-size:1.05rem}
@media (max-width:520px){h1{font-size:1.6rem}}
`;

function headMeta({ title, desc, canonical, image, ogType, ld }) {
  return `<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="${ogType}">
<meta property="og:site_name" content="Tocador">
<meta property="og:locale" content="pt_BR">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(canonical)}">
${image ? `<meta property="og:image" content="${esc(image)}">
<meta property="og:image:type" content="image/jpeg">
<meta name="twitter:card" content="summary">
<meta name="twitter:image" content="${esc(image)}">` : `<meta property="og:image" content="${SITE}/assets/og.svg">
<meta name="twitter:card" content="summary">`}
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
${[].concat(ld || []).map(o => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`).join('\n')}`;
}

function head(page) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${headMeta(page)}
<meta name="theme-color" content="#1a1814">
<link rel="preconnect" href="https://cdn.tocador.cc">
<style>${PAGE_CSS}</style>
</head>
<body>
<main class="wrap">
`;
}

const FOOT = `</main>
</body>
</html>
`;

// index.html turned into a template for album pages. They live two levels down, so
// its relative asset paths become root-absolute (index.html itself stays relative:
// the uqt/hominiscanidae mirrors serve it from a subdirectory). Its site-wide
// title, description, canonical and og/twitter tags are cut out for the album's
// own, and data-album-pages tells js/ui.js to keep /<alias>/<slug>/ URLs even off
// tocador.cc (local previews, tests). Every cut is checked, so a reshuffled
// index.html fails the build instead of shipping album pages with the home meta.
function playerTemplate(html) {
  const cut = (re, what) => {
    const before = html;
    html = html.replace(re, '');
    if (html === before) throw new Error(`index.html template: no ${what} found`);
  };
  const headEnd = html.indexOf('</head>');
  if (headEnd < 0) throw new Error('index.html template: no </head>');
  let head = html.slice(0, headEnd);
  const body = html.slice(headEnd);
  html = head;
  cut(/[ \t]*<title>[^<]*<\/title>\n/, '<title>');
  cut(/[ \t]*<meta name="description"[^>]*>\n/, 'meta description');
  cut(/[ \t]*<meta property="og:[^>]*>\n/g, 'og: meta');
  cut(/[ \t]*<meta name="twitter:[^>]*>\n/g, 'twitter: meta');
  cut(/[ \t]*<link rel="canonical"[^>]*>\n/, 'canonical link');
  cut(/[ \t]*<script>\(function\(\)\{var p=new URLSearchParams[^\n]*<\/script>\n/, 'inline canonical script');
  const marker = html.match(/[ \t]*<meta name="viewport"[^>]*>\n/);
  if (!marker) throw new Error('index.html template: no meta viewport');
  head = html.slice(0, marker.index + marker[0].length) + '<!--ALBUM_HEAD-->\n' + html.slice(marker.index + marker[0].length);
  html = (head + body)
    .replace(/<html\b/, '<html data-album-pages')
    .replace(/\b(href|src)="(?:\.\/)?(?![a-z][a-z0-9+.-]*:|\/|#)/gi, '$1="/');
  for (const id of ['album-header', 'track-list']) {
    if (!new RegExp(`id="${id}"[^>]*></`).test(html)) throw new Error(`index.html template: no empty #${id}`);
  }
  // The page's one <h1> is the album's (or genre's) own title, pre-rendered in #album-header: the app's name
  // becomes a <div> with the same class, so the look is the same (tests use #app-title-text, not the tag).
  const h1 = /<h1 class="app-title" id="app-title">([\s\S]*?)<\/h1>/;
  if (!h1.test(html)) throw new Error('index.html template: no <h1 class="app-title" id="app-title">');
  html = html.replace(h1, (_, inner) => `<div class="app-title" id="app-title">${inner}</div>`);
  return html;
}

// The player's own header rules are for <h2>; the pre-rendered title is the page's <h1> and has to look the same.
const PLAYER_CSS_EXTRA = `<style>.album-header-info h1{font-family:var(--font-display);font-size:1.4rem;margin-bottom:var(--spacing-xs);color:var(--color-text);line-height:1.3}` +
  `@media (max-width:768px){.album-header-info h1{font-size:1.3rem}}</style>`;

function albumPage({ template, alias, meta, album, slug, genres = [] }) {
  const tracks = playerTracks(album);
  const archive = meta.title || alias;
  const artist = album.artist || ''; // compilations often have none (6 in uqt, 113 in homi); say nothing rather than "desconhecido"
  const year = album.year > 0 ? album.year : null;
  const canonical = `${SITE}/${alias}/${slug}/`;
  const image = coverUrl(meta.base_url, album);
  const total = tracks.reduce((n, t) => n + (t.duration || 0), 0);
  const title = `♪ Tocador - ${album.title}${artist ? ` — ${artist}` : ''}${year ? ` (${year})` : ''}`;
  const acervo = /^acervo\b/i.test(archive) ? `no ${archive}` : `no acervo ${archive}`;
  const desc = `Ouça ${album.title}${artist ? `, de ${artist}` : ''}${year ? ` (${year})` : ''}: ` +
    `${tracks.length} faixa${tracks.length === 1 ? '' : 's'}, ${acervo}.`;

  const ld = [{
    '@context': 'https://schema.org',
    '@type': 'MusicAlbum',
    name: album.title,
    url: canonical,
    inLanguage: 'pt-BR',
    ...(artist && { byArtist: { '@type': 'MusicGroup', name: artist } }),
    ...(year && { datePublished: String(year) }),
    ...(image && { image }),
    ...(genres.length && { genre: genres.slice(0, 3).map(g => g.name) }),
    numTracks: tracks.length,
    ...(total > 0 && { duration: isoDuration(total) }),
    track: tracks.map(t => ({
      '@type': 'MusicRecording',
      name: t.title,
      position: t.num,
      url: `${canonical}#t${t.num}`,
      ...(t.duration > 0 && { duration: isoDuration(t.duration) }),
      ...(t.artists && t.artists !== artist && { byArtist: { '@type': 'Person', name: t.artists } }),
    })),
  }, {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Tocador', item: `${SITE}/` },
      { '@type': 'ListItem', position: 2, name: archive, item: `${SITE}/${alias}/` },
      { '@type': 'ListItem', position: 3, name: album.title, item: canonical },
    ],
  }];

  // Same markup js/ui.js renders (renderAlbumHeader, buildTrackItemsFragment), so
  // the page reads right before the catalog arrives and the player replaces it.
  // The title is an <h1> here (the player's JS swaps it for its own <h2> once the catalog loads).
  const header = `${image ? `<img class="album-cover-large" src="${esc(image)}" alt="${esc(album.title)}" width="200" height="200">` : ''}` +
    `<div class="album-header-info"><h1>${esc(album.title)}</h1><p><strong>${esc(artist)}</strong></p>` +
    `<p>${year ?? ''}${year ? ' • ' : ''}${tracks.length} canções</p></div>`;
  const rows = tracks.map(t => {
    const other = t.artists && t.artists !== artist ? `<div class="track-artist">${esc(t.artists)}</div>` : '';
    return `<li class="track-item"><span class="track-num" aria-hidden="true">${esc(t.num)}</span>` +
      `<div class="track-details"><div class="track-title">${esc(t.title)}</div>${other}</div>` +
      `<span class="track-duration">${fmtDuration(t.duration) || '-'}</span></li>`;
  }).join('');

  return template
    .replace('<!--ALBUM_HEAD-->', () => headMeta({ title, desc, canonical, image, ogType: 'music.album', ld }) + '\n' + PLAYER_CSS_EXTRA)
    .replace(/(id="album-header"[^>]*>)(<\/)/, (_, open, close) => open + header + close)
    .replace(/(id="track-list"[^>]*>)(<\/)/, (_, open, close) => open + rows + close);
}

// Every artist of a catalog with their albums: { name, slug, albums }, keyed like artistSlugs().
function catalogArtists(albums) {
  const slugs = globalThis.artistSlugs(albums, parseArtists, fold);
  const artists = new Map([...slugs].map(([key, slug]) => [key, { name: '', slug, albums: new Set() }]));
  const add = (text, album) => {
    for (const name of parseArtists(text)) {
      const a = artists.get(fold(name));
      if (!a) continue;
      if (!a.name || (a.name === a.name.toLowerCase() && name !== name.toLowerCase())) a.name = name;   // "Cartola", not "cartola"
      a.albums.add(album);
    }
  };
  for (const album of albums) {
    add(album.artist, album);
    for (const t of album.tracks || []) if (t.artists) add(t.artists.replace(/\x00/g, '; '), album);
  }
  return [...artists.values()];
}

// What a shared artist link unfurls to. Link previews don't run JS, so the name and a cover have to be in the HTML;
// people go straight on to the player's ?artista= filter. Deliberately not the whole player (a copy per artist would
// double the size of the Pages site) and not indexed: the albums are the pages worth finding.
function artistPage({ alias, meta, artist }) {
  const canonical = `${SITE}/${alias}/artista/${artist.slug}/`;
  const player = `${SITE}/?${new URLSearchParams({ acervo: alias, artista: artist.name })}`;
  const albums = [...artist.albums].sort((a, b) => (b.year || 0) - (a.year || 0));
  const cover = albums.find(a => a.has_cover);
  const n = albums.length;
  const title = `♪ ${artist.name} no Tocador`;
  const desc = `♪ ${artist.name} - ${n} álbu${n === 1 ? 'm' : 'ns'}: ${albums.slice(0, 4).map(a => a.title).join(', ')}${n > 4 ? '…' : ''}`;
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${headMeta({ title, desc, canonical, image: cover && coverUrl(meta.base_url, cover), ogType: 'music.musician' })}
<script>location.replace(${JSON.stringify(player).replace(/</g, '\\u003c')})</script>
</head>
<body><p><a href="${esc(player)}">${esc(artist.name)} no Tocador</a></p></body>
</html>
`;
}

// Every genre of a catalog, parents ("Latin") and subgenres ("Latin---Samba") alike, with the same rule as the grid:
// an album is under every genre one of its tracks has. albums[] starts with those where the genre ranks highest.
function catalogGenres(entries, index) {
  const genres = new Map();
  const add = (value, entry, rank) => {
    if (!genres.has(value)) genres.set(value, { value, name: value.split('---').pop(), parent: value.includes('---') ? value.split('---')[0] : null, slug: globalThis.genreSlug(value), albums: new Map() });
    const albums = genres.get(value).albums;
    if (!albums.has(entry)) albums.set(entry, rank);
  };
  for (const entry of entries) {
    (index[entry.album.path.normalize('NFC')] || []).forEach((g, rank) => {
      add(g, entry, rank);
      add(g.split('---')[0], entry, rank);
    });
  }
  const slugs = new Map();
  return [...genres.values()].map(g => {
    if (slugs.has(g.slug)) throw new Error(`genre slug collision: ${slugs.get(g.slug)} / ${g.value}`);
    slugs.set(g.slug, g.value);
    const albums = [...g.albums].sort(([a, x], [b, y]) => x - y
      || (b.album.has_cover !== false) - (a.album.has_cover !== false) || (b.album.year || 0) - (a.album.year || 0)).map(([e]) => e);
    return { ...g, albums };
  }).sort((a, b) => b.albums.length - a.albums.length);
}

const GENERO_MIN_INDEXAVEL = 3;   // fewer albums is a thin page: it still works as a shared link, but stays out of Google
const GENERO_MAX_ALBUNS = 120;    // albums listed in the HTML; every album is reachable through the index and the sitemap
const GENERO_VIZINHOS = 12;
const indexavel = g => g.albums.length >= GENERO_MIN_INDEXAVEL;
const nAlbuns = n => `${n} álbu${n === 1 ? 'm' : 'ns'}`;

// The player, like an album page: same URL for people, link previews and crawlers. <html data-genero> tells js/url-meta.js
// which filter to apply; what the catalog replaces on load is pre-rendered so that it reads without JS.
function genrePage({ template, alias, meta, genre, genres }) {
  const archive = meta.title || alias;
  const canonical = `${SITE}/${alias}/genero/${genre.slug}/`;
  const n = genre.albums.length;
  const listed = genre.albums.slice(0, GENERO_MAX_ALBUNS);
  const cover = genre.albums.find(e => e.album.has_cover !== false);
  const image = cover ? coverUrl(meta.base_url, cover.album) : null;
  const title = `♪ ${genre.name}${genre.parent ? ` (${genre.parent})` : ''} · ${nAlbuns(n)} para ouvir no ${archive}`;
  const desc = `♪ ${nAlbuns(n)} de ${genre.name} em ${archive}, para ouvir online: ` +
    `${genre.albums.slice(0, 4).map(e => [e.album.artist, e.album.title].filter(Boolean).join(' - ')).join(', ')}${n > 4 ? '…' : ''}`;
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: `${genre.name} no ${archive}`,
    url: canonical,
    description: desc,
    inLanguage: 'pt-BR',
    ...(image && { image }),
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: n,
      itemListElement: listed.slice(0, 50).map((e, i) => ({
        '@type': 'ListItem', position: i + 1, url: `${SITE}/${alias}/${e.slug}/`, name: e.album.title,
      })),
    },
  };
  const vizinhos = genres.filter(g => g !== genre && indexavel(g) && (genre.parent ? g.value === genre.parent || g.parent === genre.parent : g.parent === genre.value)).slice(0, GENERO_VIZINHOS);
  const link = g => `<a href="/${alias}/genero/${g.slug}/">${esc(g.name)}</a>`;
  const header = `${image ? `<img class="album-cover-large" src="${esc(image)}" alt="${esc(genre.name)}" width="200" height="200">` : ''}` +
    `<div class="album-header-info"><h1>${esc(genre.name)}</h1><p><strong>${esc(archive)}</strong></p><p>${nAlbuns(n)}</p>` +
    `${vizinhos.length ? `<p>${vizinhos.map(link).join(' · ')}</p>` : ''}</div>`;
  const rows = listed.map((e, i) => `<li class="track-item"><span class="track-num" aria-hidden="true">${i + 1}</span>` +
    `<div class="track-details"><div class="track-title"><a href="/${alias}/${e.slug}/">${esc(e.album.title)}</a></div>` +
    `${e.album.artist ? `<div class="track-artist">${esc(e.album.artist)}</div>` : ''}</div>` +
    `<span class="track-duration">${e.album.year > 0 ? e.album.year : ''}</span></li>`).join('');
  const robots = indexavel(genre) ? '' : '<meta name="robots" content="noindex">\n';

  return template
    .replace('<html data-album-pages', () => `<html data-album-pages data-genero="${esc(genre.value)}"`)
    .replace('<!--ALBUM_HEAD-->', () => robots + headMeta({ title, desc, canonical, image, ogType: 'website', ld }) + '\n' + PLAYER_CSS_EXTRA)
    .replace(/(id="album-header"[^>]*>)(<\/)/, (_, open, close) => open + header + close)
    .replace(/(id="track-list"[^>]*>)(<\/)/, (_, open, close) => open + rows + close);
}

function indexPage({ alias, meta, entries, genres = [] }) {
  const archive = meta.title || alias;
  const canonical = `${SITE}/${alias}/`;
  const byArtist = new Map();
  for (const e of entries) {
    const key = e.album.artist || 'Artista desconhecido';
    if (!byArtist.has(key)) byArtist.set(key, []);
    byArtist.get(key).push(e);
  }
  const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
  const artists = [...byArtist.keys()].sort(collator.compare);
  const title = `${archive}${meta.subtitle ? ` — ${meta.subtitle}` : ''} · todos os álbuns`;
  const desc = `Índice dos ${entries.length} álbuns de ${artists.length} artistas do acervo ${archive}` +
    `${meta.subtitle ? ` (${meta.subtitle})` : ''}, para ouvir no Tocador.`;
  const body = artists.map(a => {
    const list = byArtist.get(a).sort((x, y) => (x.album.year || 0) - (y.album.year || 0) || collator.compare(x.album.title, y.album.title));
    return `<section class="artist"><h2>${esc(a)}</h2><ul class="more">${list.map(e =>
      `<li><a href="/${alias}/${e.slug}/">${esc(e.album.title)}</a>${e.album.year > 0 ? ` (${e.album.year})` : ''}</li>`).join('')}</ul></section>`;
  }).join('\n');

  return head({ title, desc, canonical, image: null, ogType: 'website', ld: null }) +
`<nav class="crumbs"><a href="/">♪ Tocador</a> / <a href="/?acervo=${alias}">abrir o player</a></nav>
<h1>${esc(archive)}</h1>
<p class="meta">${meta.subtitle ? `${esc(meta.subtitle)} · ` : ''}${entries.length} álbuns · ${artists.length} artistas</p>
${genres.some(indexavel) ? `<h2>Gêneros</h2><p>${genres.filter(indexavel).map(g => `<a href="/${alias}/genero/${g.slug}/">${esc(g.name)}</a>`).join(' · ')}</p>` : ''}
${body}
` + FOOT;
}

// lastmod: the catalog's own modification date (YYYY-MM-DD), never the build date; without one, no <lastmod> is written.
function sitemapFor(alias, entries, meta, genres = [], lastmod = null) {
  const imgNs = ' xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"';
  const lm = lastmod ? `    <lastmod>${esc(lastmod)}</lastmod>\n` : '';
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${imgNs}>\n`;
  xml += `  <url>\n    <loc>${SITE}/${alias}/</loc>\n${lm}  </url>\n`;
  for (const { album, slug } of entries) {
    xml += `  <url>\n    <loc>${SITE}/${alias}/${pathEnc(slug)}/</loc>\n${lm}`;
    const img = coverUrl(meta.base_url, album);
    if (img) xml += `    <image:image><image:loc>${esc(img)}</image:loc></image:image>\n`;
    xml += '  </url>\n';
  }
  for (const g of genres.filter(indexavel)) {
    xml += `  <url>\n    <loc>${SITE}/${alias}/genero/${pathEnc(g.slug)}/</loc>\n${lm}`;
    const capa = g.albums.find(e => e.album.has_cover !== false);
    const img = capa && coverUrl(meta.base_url, capa.album);
    if (img) xml += `    <image:image><image:loc>${esc(img)}</image:loc></image:image>\n`;
    xml += '  </url>\n';
  }
  return xml + '</urlset>\n';
}

// The fixed pages (home, the three other apps). No <lastmod>: nothing here has a date that is true other than the build's.
// The /<alias>/ indexes are in each acervo's own sitemap.
const PAGINAS_FIXAS = ['/', '/atlas', '/3d', '/radio'];
function sitemapPaginas() {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    PAGINAS_FIXAS.map(p => `  <url><loc>${SITE}${p}</loc></url>\n`).join('') + '</urlset>\n';
}

const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d));

function loadCatalog(file) {
  let raw = fs.readFileSync(file);
  if (raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw);
  return globalThis.decodeAcervo(JSON.parse(raw.toString('utf8')));
}

// The index the player loads (data/<alias>-album-genres.json.gz, committed here): album path (NFC) -> genres, most voted first.
function loadGenres(file) {
  if (!fs.existsSync(file)) return {};
  const { g, a } = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  return Object.fromEntries(Object.entries(a).map(([p, idx]) => [p, idx.map(i => g[i])]));
}

function build({ out, catalogs, lastmod = {}, templateFile = path.join(__dirname, '..', 'index.html'), genresDir = path.join(__dirname, '..', 'data') }) {
  const template = playerTemplate(fs.readFileSync(templateFile, 'utf8'));
  const sitemaps = [], sitemapDatas = [];
  const summary = [];
  for (const [alias, file] of catalogs) {
    if (!/^[a-z0-9-]+$/.test(alias)) throw new Error(`bad acervo alias: ${alias}`);
    const db = loadCatalog(file);
    const meta = db.meta || {};
    const albums = db.albums || [];
    if (!albums.length) throw new Error(`${alias}: catalog ${file} has no albums`);
    const slugs = globalThis.albumSlugs(albums);
    const entries = albums.map((album, i) => ({ album, slug: slugs[i] }));

    const root = path.join(out, alias);
    fs.rmSync(root, { recursive: true, force: true });
    // Genres first: the album pages list and link their own.
    const genres = catalogGenres(entries, loadGenres(path.join(genresDir, `${alias}-album-genres.json.gz`)));
    const indiceGeneros = loadGenres(path.join(genresDir, `${alias}-album-genres.json.gz`));
    const porValor = new Map(genres.map(g => [g.value, g]));
    for (const e of entries) {
      const dir = path.join(root, e.slug);
      fs.mkdirSync(dir, { recursive: true });
      const generosAlbum = (indiceGeneros[e.album.path.normalize('NFC')] || []).map(v => porValor.get(v)).filter(Boolean);
      fs.writeFileSync(path.join(dir, 'index.html'), albumPage({ template, alias, meta, album: e.album, slug: e.slug, genres: generosAlbum }));
    }
    for (const genre of genres) {
      const dir = path.join(root, 'genero', genre.slug);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), genrePage({ template, alias, meta, genre, genres }));
    }
    fs.writeFileSync(path.join(root, 'index.html'), indexPage({ alias, meta, entries, genres }));
    const artists = catalogArtists(albums);
    for (const artist of artists) {
      const dir = path.join(root, 'artista', artist.slug);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), artistPage({ alias, meta, artist }));
    }

    const smName = `sitemap-albums-${alias}.xml`;
    fs.writeFileSync(path.join(out, smName), sitemapFor(alias, entries, meta, genres, lastmod[alias] || null));
    sitemapDatas.push(lastmod[alias] || null);
    sitemaps.push(smName);
    summary.push(`${alias}: ${entries.length} album pages, ${artists.length} artist pages, ${genres.length} genre pages (${genres.filter(indexavel).length} indexable), lastmod ${lastmod[alias] || 'none'} → ${alias}/, ${smName}`);
  }

  let index = '<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  sitemaps.forEach((s, i) => { index += `  <sitemap><loc>${SITE}/${s}</loc>${sitemapDatas[i] ? `<lastmod>${sitemapDatas[i]}</lastmod>` : ''}</sitemap>\n`; });
  fs.writeFileSync(path.join(out, 'sitemap-paginas.xml'), sitemapPaginas());
  index += `  <sitemap><loc>${SITE}/sitemap-paginas.xml</loc></sitemap>\n`;
  index += '</sitemapindex>\n';
  fs.writeFileSync(path.join(out, 'sitemap.xml'), index);
  return summary;
}

module.exports = { build, playerTracks, playerTemplate, albumPage, artistPage, catalogArtists, catalogGenres, genrePage, indexPage, sitemapFor, sitemapPaginas };

if (require.main === module) {
  const args = process.argv.slice(2);
  let out = '.';
  const lastmod = {};
  let mtime = false;
  const catalogs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') out = args[++i];
    else if (args[i] === '--lastmod') {   // --lastmod uqt=2026-11-03: the catalog's modification date, never the build's
      const [al, d] = args[++i].split('=');
      if (!al || !validDate(d)) { console.error(`--lastmod wants <alias>=YYYY-MM-DD, got ${args[i]}`); process.exit(2); }
      lastmod[al] = d;
    } else if (args[i] === '--lastmod-mtime') mtime = true;   // read it from each catalog file's mtime (use with curl -R)
    else if (args[i].includes('=')) {
      const at = args[i].indexOf('=');
      catalogs.push([args[i].slice(0, at), args[i].slice(at + 1)]);
    } else {
      console.error(`unknown argument: ${args[i]}`);
      process.exit(2);
    }
  }
  if (!catalogs.length) {
    console.error('usage: bun script/build-album-pages.js [--out dir] [--lastmod alias=YYYY-MM-DD | --lastmod-mtime] <alias>=<catalog.json.gz> ...');
    process.exit(2);
  }
  if (mtime) for (const [al, file] of catalogs) lastmod[al] ??= fs.statSync(file).mtime.toISOString().slice(0, 10);
  for (const line of build({ out, catalogs, lastmod })) console.log(line);
}
