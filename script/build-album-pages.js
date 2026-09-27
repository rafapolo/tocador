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
//   sitemap-albums-<alias>.xml         index + album pages, with cover images
//   sitemap.xml                        sitemap index over the per-acervo files
//
// Slugs come from albumSlugs() in js/acervo-format.js, which the player also uses
// for its address bar, canonical and share links, so the two can't drift apart.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
require('../js/acervo-format.js');

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

const isoDuration = sec => `PT${Math.floor(sec / 60)}M${Math.floor(sec % 60)}S`;

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
  return out.map((t, i) => ({
    title: t.title,
    num: t.num ?? (i + 1),
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
<meta property="og:image:width" content="200">
<meta property="og:image:height" content="200">
<meta property="og:image:type" content="image/jpeg">
<meta name="twitter:card" content="summary">
<meta name="twitter:image" content="${esc(image)}">` : `<meta property="og:image" content="${SITE}/assets/og.svg">
<meta name="twitter:card" content="summary">`}
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
${ld ? `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>` : ''}`;
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
  return html;
}

function albumPage({ template, alias, meta, album, slug }) {
  const tracks = playerTracks(album);
  const archive = meta.title || alias;
  const artist = album.artist || ''; // compilations often have none; say nothing rather than "desconhecido"
  const year = album.year > 0 ? album.year : null;
  const canonical = `${SITE}/${alias}/${slug}/`;
  const image = coverUrl(meta.base_url, album);
  const title = `${album.title}${artist ? ` — ${artist}` : ''}${year ? ` (${year})` : ''} ♪ Tocador`;
  const trackNames = tracks.slice(0, 4).map(t => String(t.title ?? "").replace(/\s+/g, ' ')).join(', ');
  const desc = `Ouça ${album.title}${artist ? `, álbum de ${artist}` : ''}${year ? ` lançado em ${year}` : ''}: ` +
    `${tracks.length} faixa${tracks.length === 1 ? '' : 's'}${trackNames ? ` — ${trackNames}${tracks.length > 4 ? '…' : '.'}` : '.'} ` +
    `Em ${archive}.`;

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'MusicAlbum',
    name: album.title,
    url: canonical,
    ...(artist && { byArtist: { '@type': 'MusicGroup', name: artist } }),
    ...(year && { datePublished: String(year) }),
    ...(image && { image }),
    numTracks: tracks.length,
    track: tracks.map(t => ({
      '@type': 'MusicRecording',
      name: t.title,
      position: t.num,
      url: `${canonical}#t${t.num}`,
      ...(t.duration > 0 && { duration: isoDuration(t.duration) }),
      ...(t.artists && t.artists !== artist && { byArtist: { '@type': 'Person', name: t.artists } }),
    })),
  };

  // Same markup js/ui.js renders (renderAlbumHeader, buildTrackItemsFragment), so
  // the page reads right before the catalog arrives and the player replaces it.
  const header = `${image ? `<img class="album-cover-large" src="${esc(image)}" alt="${esc(album.title)}" width="200" height="200">` : ''}` +
    `<div class="album-header-info"><h2>${esc(album.title)}</h2><p><strong>${esc(artist)}</strong></p>` +
    `<p>${year ?? ''}${year ? ' • ' : ''}${tracks.length} canções</p></div>`;
  const rows = tracks.map(t => {
    const other = t.artists && t.artists !== artist ? `<div class="track-artist">${esc(t.artists)}</div>` : '';
    return `<li class="track-item"><span class="track-num" aria-hidden="true">${esc(t.num)}</span>` +
      `<div class="track-details"><div class="track-title">${esc(t.title)}</div>${other}</div>` +
      `<span class="track-duration">${fmtDuration(t.duration) || '-'}</span></li>`;
  }).join('');

  return template
    .replace('<!--ALBUM_HEAD-->', () => headMeta({ title, desc, canonical, image, ogType: 'music.album', ld }))
    .replace(/(id="album-header"[^>]*>)(<\/)/, (_, open, close) => open + header + close)
    .replace(/(id="track-list"[^>]*>)(<\/)/, (_, open, close) => open + rows + close);
}

function indexPage({ alias, meta, entries }) {
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
${body}
` + FOOT;
}

function sitemapFor(alias, entries, meta) {
  const imgNs = ' xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"';
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${imgNs}>\n`;
  xml += `  <url><loc>${SITE}/${alias}/</loc></url>\n`;
  for (const { album, slug } of entries) {
    xml += `  <url>\n    <loc>${SITE}/${alias}/${pathEnc(slug)}/</loc>\n`;
    const img = coverUrl(meta.base_url, album);
    if (img) xml += `    <image:image><image:loc>${esc(img)}</image:loc></image:image>\n`;
    xml += '  </url>\n';
  }
  return xml + '</urlset>\n';
}

function loadCatalog(file) {
  let raw = fs.readFileSync(file);
  if (raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw);
  return globalThis.decodeAcervo(JSON.parse(raw.toString('utf8')));
}

function build({ out, catalogs, templateFile = path.join(__dirname, '..', 'index.html') }) {
  const template = playerTemplate(fs.readFileSync(templateFile, 'utf8'));
  const sitemaps = [];
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
    for (const e of entries) {
      const dir = path.join(root, e.slug);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), albumPage({ template, alias, meta, album: e.album, slug: e.slug }));
    }
    fs.writeFileSync(path.join(root, 'index.html'), indexPage({ alias, meta, entries }));

    const smName = `sitemap-albums-${alias}.xml`;
    fs.writeFileSync(path.join(out, smName), sitemapFor(alias, entries, meta));
    sitemaps.push(smName);
    summary.push(`${alias}: ${entries.length} album pages → ${alias}/, ${smName}`);
  }

  let index = '<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  for (const s of sitemaps) index += `  <sitemap><loc>${SITE}/${s}</loc></sitemap>\n`;
  index += '</sitemapindex>\n';
  fs.writeFileSync(path.join(out, 'sitemap.xml'), index);
  return summary;
}

module.exports = { build, playerTracks, playerTemplate, albumPage, indexPage, sitemapFor };

if (require.main === module) {
  const args = process.argv.slice(2);
  let out = '.';
  const catalogs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') out = args[++i];
    else if (args[i].includes('=')) {
      const at = args[i].indexOf('=');
      catalogs.push([args[i].slice(0, at), args[i].slice(at + 1)]);
    } else {
      console.error(`unknown argument: ${args[i]}`);
      process.exit(2);
    }
  }
  if (!catalogs.length) {
    console.error('usage: bun script/build-album-pages.js [--out dir] <alias>=<catalog.json.gz> ...');
    process.exit(2);
  }
  for (const line of build({ out, catalogs })) console.log(line);
}
