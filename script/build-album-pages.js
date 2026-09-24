#!/usr/bin/env bun
// Builds a static, crawlable HTML page per album plus the sitemaps that list them.
//
//   bun script/build-album-pages.js --out . uqt=uqt-albums.json.gz homi=homi-albums.json.gz
//
// Why this exists: the player is a single index.html that renders albums from a
// catalog with JavaScript, so every ?acervo=&album= URL serves the same "♪" shell.
// Google never fetched the album sitemaps and left every album URL unknown, and
// link-preview crawlers (WhatsApp, Telegram, Mastodon…) never run JS, so a shared
// album link showed no cover. Each album here gets a real page at
// /<alias>/<slug>/ with its own title, description, cover og:image, JSON-LD and
// tracklist, linking into the player. /<alias>/ lists every album so crawlers can
// reach all of them by following links, not only through the sitemap.
//
// Writes, under --out:
//   <alias>/index.html                 album index for the acervo
//   <alias>/<slug>/index.html          one page per album
//   sitemap-albums-<alias>.xml         index + album pages, with cover images
//   sitemap.xml                        sitemap index over the per-acervo files
//
// Slugs come from albumSlugs() in js/acervo-format.js, which the player also uses
// for its canonical and share links, so the two can't drift apart.

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

function playerUrl(alias, album, trackNum) {
  const q = new URLSearchParams({ acervo: alias, album: album.path });
  if (trackNum) q.set('t', trackNum);
  return `/?${q}`;
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
.album{display:flex;gap:24px;align-items:flex-end;flex-wrap:wrap}
.cover{width:200px;height:200px;border-radius:8px;object-fit:cover;background:var(--surface-light);box-shadow:0 8px 24px rgba(0,0,0,.5)}
h1{font-family:"Playfair Display",Georgia,serif;font-size:2rem;line-height:1.2;margin:0 0 4px}
.meta{color:var(--text2);margin:0}
.play{display:inline-block;margin-top:16px;padding:10px 22px;border-radius:999px;background:var(--accent);color:#1a1814;font-weight:600;text-decoration:none}
.play:hover{filter:brightness(1.08)}
ol.tracks{list-style:none;padding:0;margin:32px 0 0;border-top:1px solid var(--border)}
ol.tracks li{border-bottom:1px solid var(--border)}
ol.tracks a{display:flex;gap:12px;padding:10px 4px;color:var(--text);text-decoration:none}
ol.tracks a:hover{background:var(--surface)}
.n{color:var(--muted);min-width:2ch;text-align:right}
.t{flex:1}
.ta{display:block;color:var(--muted);font-size:.85rem}
.d{color:var(--muted);font-variant-numeric:tabular-nums}
h2{font-family:"Playfair Display",Georgia,serif;font-size:1.2rem;margin:40px 0 8px}
ul.more{padding-left:18px;margin:0}
ul.more li{margin:4px 0}
.artist{margin:0 0 12px}
.artist h2{margin:28px 0 4px;font-size:1.05rem}
@media (max-width:520px){.album{flex-direction:column;align-items:flex-start}h1{font-size:1.6rem}}
`;

function head({ title, desc, canonical, image, ogType, ld }) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
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
<meta name="theme-color" content="#1a1814">
<link rel="preconnect" href="https://cdn.tocador.cc">
<style>${PAGE_CSS}</style>
${ld ? `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>` : ''}
</head>
<body>
<main class="wrap">
`;
}

const FOOT = `</main>
</body>
</html>
`;

function albumPage({ alias, meta, album, slug, siblings }) {
  const tracks = playerTracks(album);
  const archive = meta.title || alias;
  const artist = album.artist || 'Artista desconhecido';
  const year = album.year > 0 ? album.year : null;
  const canonical = `${SITE}/${alias}/${slug}/`;
  const image = coverUrl(meta.base_url, album);
  const total = tracks.reduce((s, t) => s + t.duration, 0);
  const title = `${album.title} — ${artist}${year ? ` (${year})` : ''} · ${archive}`;
  const trackNames = tracks.slice(0, 4).map(t => String(t.title ?? "").replace(/\s+/g, ' ')).join(', ');
  const desc = `Ouça ${album.title}, álbum de ${artist}${year ? ` lançado em ${year}` : ''}: ` +
    `${tracks.length} faixa${tracks.length === 1 ? '' : 's'}${trackNames ? ` — ${trackNames}${tracks.length > 4 ? '…' : '.'}` : '.'} ` +
    `Em ${archive}.`;

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'MusicAlbum',
    name: album.title,
    url: canonical,
    byArtist: { '@type': 'MusicGroup', name: artist },
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

  const rows = tracks.map(t => {
    const other = t.artists && t.artists !== artist ? `<span class="ta">${esc(t.artists)}</span>` : '';
    return `<li id="t${esc(t.num)}"><a rel="nofollow" href="${esc(playerUrl(alias, album, t.num))}"><span class="n">${esc(t.num)}</span>` +
      `<span class="t">${esc(t.title)}${other}</span><span class="d">${fmtDuration(t.duration)}</span></a></li>`;
  }).join('\n');

  const more = siblings.length
    ? `<h2>Mais de ${esc(artist)}</h2>\n<ul class="more">\n${siblings.map(s =>
        `<li><a href="/${alias}/${s.slug}/">${esc(s.album.title)}</a>${s.album.year > 0 ? ` (${s.album.year})` : ''}</li>`).join('\n')}\n</ul>`
    : '';

  return head({ title, desc, canonical, image, ogType: 'music.album', ld }) +
`<nav class="crumbs"><a href="/">♪ Tocador</a> / <a href="/${alias}/">${esc(archive)}</a></nav>
<article class="album">
${image ? `<img class="cover" src="${esc(image)}" alt="Capa de ${esc(album.title)}" width="200" height="200">` : ''}
<div>
<h1>${esc(album.title)}</h1>
<p class="meta">${esc(artist)}${year ? ` · ${year}` : ''} · ${tracks.length} faixa${tracks.length === 1 ? '' : 's'}${total ? ` · ${Math.round(total / 60)} min` : ''}</p>
<a class="play" rel="nofollow" href="${esc(playerUrl(alias, album))}">▶ Ouvir no Tocador</a>
</div>
</article>
<ol class="tracks">
${rows}
</ol>
${more}
` + FOOT;
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

function build({ out, catalogs }) {
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

    const byArtist = new Map();
    for (const e of entries) {
      const k = e.album.artist || '';
      if (!byArtist.has(k)) byArtist.set(k, []);
      byArtist.get(k).push(e);
    }

    const root = path.join(out, alias);
    fs.rmSync(root, { recursive: true, force: true });
    for (const e of entries) {
      const siblings = e.album.artist
        ? byArtist.get(e.album.artist).filter(s => s !== e).slice(0, 30)
        : [];
      const dir = path.join(root, e.slug);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), albumPage({ alias, meta, album: e.album, slug: e.slug, siblings }));
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

module.exports = { build, playerTracks, albumPage, indexPage, sitemapFor };

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
