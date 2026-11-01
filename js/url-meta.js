// URL state, canonical/OG meta tags, album slugs and sharing.
// Classic script: shares ui.js's global scope (state lives at the top of ui.js).
// Loaded after ui.js; everything here runs at call time, after DOMContentLoaded.

// { alias, slug } when the current path is an album page, else null.
function albumPageFromPath() {
  if (!location.pathname.startsWith(APP_ROOT)) return null;
  const m = location.pathname.slice(APP_ROOT.length).match(/^([a-z0-9-]+)\/([a-z0-9-]+)\/$/);
  return m && KNOWN_ACERVOS[m[1]] ? { alias: m[1], slug: m[2] } : null;
}

function getAlbumFromUrl() {
  const page = albumPageFromPath();
  // An unknown slug (catalog changed since the page was built) comes back as-is:
  // it matches no album path, so the player says the album doesn't exist.
  if (page) return albumPathForSlug(page.slug) ?? page.slug;
  return new URLSearchParams(window.location.search).get('album');
}

function getQueryFromUrl() {
  return new URLSearchParams(window.location.search).get('q');
}

function getYearFromUrl() {
  return parseInt(new URLSearchParams(window.location.search).get('ano') || 0);
}

function getTrackNumFromUrl() {
  const m = location.hash.match(/^#t(\d+)$/);
  if (m) return parseInt(m[1]);
  return parseInt(new URLSearchParams(window.location.search).get('t') || 0);
}

function getPlayFromUrl() {
  return new URLSearchParams(window.location.search).get('play') === '1';
}

function getListaFromUrl() {
  return new URLSearchParams(window.location.search).get('lista') || '';
}

function generateAlbumUrl(album, trackNum) {
  const params = new URLSearchParams(window.location.search);
  params.delete('artista');
  params.delete('genero');
  const page = ALBUM_PAGES && albumPagePath(album);
  if (page) {
    params.delete('acervo');
    params.delete('album');
    params.delete('t');
    const qs = params.toString();
    return `${page}${qs ? `?${qs}` : ''}${trackNum ? `#t${trackNum}` : ''}`;
  }
  // Leaving an album page for a ?album= URL: the path no longer names the acervo.
  if (albumPageFromPath() && activeAcervoKey) params.set('acervo', activeAcervoKey);
  params.set('album', album.path);
  if (trackNum) params.set('t', trackNum); else params.delete('t');
  return `${APP_ROOT}?${params}`;
}

// The current path and fragment with a different query string.
function urlWithParams(params) {
  const qs = params.toString();
  return `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`;
}

// Rewriting the address bar to a URL that differs only in encoding (`,` → `%2C`,
// param order) still counts as a JS redirect to crawlers, so keep the current
// URL whenever the path, fragment and parameters are the same.
function replaceUrl(state, url) {
  const u = new URL(url, location.href);
  const same = u.pathname === location.pathname && u.hash === location.hash &&
    u.searchParams.toString() === new URLSearchParams(location.search).toString();
  window.history.replaceState(state, '', same ? location.pathname + location.search + location.hash : url);
}

function updateTrackInUrl(trackNum) {
  const state = { album: selectedAlbum?.path, t: trackNum };
  if (albumPageFromPath()) {
    replaceUrl(state, `${location.pathname}${location.search}${trackNum ? `#t${trackNum}` : ''}`);
    return;
  }
  const params = new URLSearchParams(window.location.search);
  if (trackNum) params.set('t', trackNum); else params.delete('t');
  replaceUrl(state, urlWithParams(params));
}

function updateQueryInUrl(q, push) {
  const params = new URLSearchParams(window.location.search);
  if (q) params.set('q', q); else params.delete('q');
  const url = urlWithParams(params);
  const state = selectedAlbum ? { album: selectedAlbum.path } : {};
  if (push) window.history.pushState(state, '', url);
  else window.history.replaceState(state, '', url);
}

function updateYearInUrl(year) {
  const params = new URLSearchParams(window.location.search);
  if (year) params.set('ano', year); else params.delete('ano');
  const url = urlWithParams(params);
  const state = selectedAlbum ? { album: selectedAlbum.path } : {};
  window.history.replaceState(state, '', url);
}

function getGeneroFromUrl() {
  return new URLSearchParams(window.location.search).get('genero') || null;
}

function getArtistaFromUrl() {
  return new URLSearchParams(window.location.search).get('artista') || null;
}

function updateBrowseFilterInUrl() {
  const params = new URLSearchParams(window.location.search);
  params.delete('genero');
  params.delete('artista');
  if (activeGenre)  params.set('genero', activeGenre);
  if (activeArtist) params.set('artista', activeArtist);
  const state = selectedAlbum ? { album: selectedAlbum.path } : {};
  window.history.replaceState(state, '', urlWithParams(params));
}

function removeListaFromUrl() {
  const params = new URLSearchParams(window.location.search);
  params.delete('lista');
  const state = selectedAlbum ? { album: selectedAlbum.path } : {};
  window.history.replaceState(state, '', urlWithParams(params));
}

// ── Playlist compartilhada (?lista=) ──────────────────────────────────────
// A lista vive só nesta faceta: quem abre o link vê os álbuns no grid, e os salvos dessa pessoa nem são lidos.
let _albumsByShareId = null;

// O valor vem de um link, então só serve de chave de busca. Um id pode trazer dois álbuns numa colisão de hash:
// melhor um álbum a mais do que o errado.
function albumsFromLista(lista) {
  const ids = /^[0-9A-Za-z]+$/.test(lista) && lista.length % 5 === 0 ? lista.match(/.{5}/g) : [];
  if (!_albumsByShareId) {
    _albumsByShareId = new Map();
    for (const a of albums) {
      const id = albumShareId(a.path);
      const iguais = _albumsByShareId.get(id);
      if (iguais) iguais.push(a); else _albumsByShareId.set(id, [a]);
    }
  }
  const posicoes = new Map();
  let perdidos = 0;
  for (const id of new Set(ids)) {
    const achados = _albumsByShareId.get(id);
    if (!achados) { perdidos++; continue; }
    for (const a of achados) posicoes.set(a, posicoes.size);
  }
  return { posicoes, perdidos };
}

// Põe sharedAlbums de acordo com a URL e diz se há lista. Quem chama roda filterAlbums().
function aplicarListaDaUrl() {
  const lista = getListaFromUrl();
  const { posicoes, perdidos } = lista ? albumsFromLista(lista) : { posicoes: new Map(), perdidos: 0 };
  if (!posicoes.size) {
    sharedAlbums = null;
    activeLista = '';
    if (lista) {
      removeListaFromUrl();
      showToast('Nenhum álbum deste link está neste acervo');
    }
    return false;
  }
  resetFacets('lista');
  sharedAlbums = posicoes;
  activeLista = lista;
  if (perdidos) showToast(perdidos === 1 ? '1 álbum não está mais no acervo' : `${perdidos} álbuns não estão mais no acervo`);
  return true;
}

function setMeta(attr, key, value) {
  let el = document.querySelector(`meta[${attr}="${key}"]`);
  if (!el) { el = document.createElement('meta'); el.setAttribute(attr, key); document.head.appendChild(el); }
  el.setAttribute('content', value);
}

// Static, crawlable page for an album: /<acervo>/<slug>/ on tocador.cc, built at
// deploy by script/build-album-pages.js with the same albumSlugs(). Only KNOWN_ACERVOS
// get one, so a third-party ?acervo=<url> catalog returns null. Always tocador.cc,
// even on the uqt/hominiscanidae Pages mirrors, which don't serve these pages.
const SITE_ORIGIN = 'https://tocador.cc';
let activeAcervoKey = null;
let _albumSlugByPath = null, _albumPathBySlug = null;
function albumSlug(album) {
  if (!activeAcervoKey || !db?.albums || typeof albumSlugs !== 'function') return null;
  if (!_albumSlugByPath) {
    const slugs = albumSlugs(db.albums);
    _albumSlugByPath = new Map(db.albums.map((a, i) => [a.path, slugs[i]]));
    _albumPathBySlug = new Map(db.albums.map((a, i) => [slugs[i], a.path]));
  }
  return _albumSlugByPath.get(album.path) ?? null;
}
function albumPathForSlug(slug) {
  if (!_albumPathBySlug && db?.albums) albumSlug(db.albums[0]);
  return _albumPathBySlug?.get(slug) ?? null;
}
function albumPageUrl(album) {
  const slug = albumSlug(album);
  return slug ? `${SITE_ORIGIN}/${activeAcervoKey}/${slug}/` : null;
}
function albumPagePath(album) {
  const slug = albumSlug(album);
  return slug ? `${APP_ROOT}${activeAcervoKey}/${slug}/` : null;
}

// The artist's page, /<alias>/artista/<slug>/: a tiny static page for link previews that sends people on to the
// ?artista= filter. An artist of a third-party catalog has none, so the link is the filter itself.
let _artistSlugs = null;
function artistShareUrl(name) {
  if (activeAcervoKey && db?.albums) {
    _artistSlugs ??= artistSlugs(db.albums, parseArtists, fold);
    const slug = _artistSlugs.get(fold(name));
    if (slug) return `${SITE_ORIGIN}/${activeAcervoKey}/artista/${slug}/`;
  }
  const acervo = new URLSearchParams(location.search).get('acervo');
  return `${location.origin}${APP_ROOT}?${new URLSearchParams({ ...(acervo && { acervo }), artista: name })}`;
}

// Share sheet where there is one, else the clipboard, else the URL itself in a toast.
async function shareLink(title, url, copied) {
  if (navigator.share) {
    try { await navigator.share({ title, url }); return; }
    catch (err) { if (err?.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast(copied);
  } catch {
    showToast(url, 6000);
  }
}

function shareArtist(name) {
  return shareLink(`${name} no Tocador`, artistShareUrl(name), 'Link do artista copiado');
}

// A static page on tocador.cc gives the link its preview and forwards to the player with ?lista=. Mirrors don't serve
// it, so the link never uses this origin. Only the active acervo goes in: one link names one acervo.
function savedShareUrl() {
  const lista = salvosNoCatalogo().map(a => albumShareId(a.path)).join('');
  return `${SITE_ORIGIN}/share-playlist?${new URLSearchParams({ acervo: activeAcervoKey ?? activeAcervoId, lista })}`;
}

function shareSaved() {
  const fora = salvosDeFora();
  return shareLink('Uma playlist no Tocador', savedShareUrl(),
    fora ? `Link copiado, sem ${fora === 1 ? 'o salvo' : `os ${fora} salvos`} de outro acervo` : 'Link da playlist copiado');
}

// With a track of this album loaded, the link names it: #tN on the static page
// (whose tracklist rows carry id="tN" with the player's own numbering), or ?t=N
// on the player fallback. The preview itself stays album-level either way. The
// first track is left out: opening an album primes it, so it says nothing about
// what the listener picked, and the album page starts there anyway.
function shareAlbum(album) {
  const track = currentTrack !== album.tracks?.[0] && album.tracks?.includes(currentTrack) ? currentTrack : null;
  const page = albumPageUrl(album);
  const url = page
    ? (track ? `${page}#t${track.num}` : page)
    : window.location.origin + generateAlbumUrl(album, track?.num);
  const title = track
    ? `${track.title} — ${album.name} — ${album.artists}`
    : `${album.name} — ${album.artists}`;
  return shareLink(title, url, track ? 'Link da faixa copiado' : 'Link do álbum copiado');
}

function updateMetaTags(album) {
  // Same wording as the album pages script/build-album-pages.js writes, which is what
  // link previews show; Google reads this rendered copy too.
  const n = album.tracks.length;
  const title = `♪ Tocador - ${album.name}${album.artists ? ` — ${album.artists}` : ''}${album.year > 0 ? ` (${album.year})` : ''}`;
  const desc = `♪ ${[album.artists, `${album.name}${album.year > 0 ? ` (${album.year})` : ''}`, `${n} faixa${n === 1 ? '' : 's'}`]
    .filter(Boolean).join(' - ')}`;
  const image = `${BASE_URL}/${encodeURIComponent(album.path)}/capa-min.jpg`;
  // og:url and <link rel=canonical> must be absolute — generateAlbumUrl() returns a
  // path-relative URL (right for pushState/anchor hrefs, wrong for these two). The
  // album's static page is the canonical when one exists: it's what gets indexed and
  // what unfurls with the cover, since crawlers don't run this script.
  const url = albumPageUrl(album) || window.location.origin + generateAlbumUrl(album);
  document.title = `♪ ${album.artists} · ${album.name}`;
  setMeta('property', 'og:title', title);
  setMeta('property', 'og:description', desc);
  setMeta('property', 'og:image', image);
  setMeta('property', 'og:url', url);
  setMeta('name', 'twitter:title', title);
  setMeta('name', 'twitter:description', desc);
  setMeta('name', 'twitter:image', image);
  setMeta('name', 'description', desc);

  let canonical = document.querySelector('link[rel="canonical"]');
  if (!canonical) { canonical = document.createElement('link'); canonical.rel = 'canonical'; document.head.appendChild(canonical); }
  canonical.href = url;

  const secsToIso = s => { const m = Math.floor(s / 60), sc = s % 60; return `PT${m}M${sc}S`; };
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'MusicAlbum',
    name: album.name,
    byArtist: { '@type': 'MusicGroup', name: album.artists },
    datePublished: String(album.year || ''),
    numTracks: album.tracks.length,
    image,
    url,
    track: album.tracks.map((t, i) => ({
      '@type': 'MusicRecording',
      name: t.title,
      position: t.num ?? (i + 1),
      ...(t.duration > 0 && { duration: secsToIso(t.duration) }),
      ...(t.artists && t.artists !== album.artists && { byArtist: { '@type': 'Person', name: t.artists } }),
    })),
  };
  let ldEl = document.querySelector('script[type="application/ld+json"]');
  if (!ldEl) { ldEl = document.createElement('script'); ldEl.type = 'application/ld+json'; document.head.appendChild(ldEl); }
  ldEl.textContent = JSON.stringify(ld);
}
