// Tocador service worker — instant repeat loads + offline app shell.
//
// Strategy: network-first for pages, stale-while-revalidate for same-origin
// static assets and for the acervo catalogs (*.json.gz, cross-origin on GitHub
// raw). A page must never be older than the scripts it gets: pages from before
// a deploy lack the tags of files added since, and the new scripts crash on the
// missing globals. Audio and covers
// (cdn.tocador.cc) are never intercepted so Range requests pass straight
// through to the proxy untouched.
//
// tocador.cc's deploy rewrites the CACHE literal below with the commit SHA, so
// every deploy changes sw.js, installs a fresh worker and drops the old caches
// (no hand-bumping). The uqt/hominiscanidae mirrors copy sw.js unstamped and keep
// this literal; bump it there if the shell changes in a way that must invalidate.
const CACHE = 'tocador-v5';
// Needed for the app to start offline.
const SHELL = ['./', './index.html', './assets/player.css', './js/acervo-format.js', './js/util.js', './js/som-abas.js', './js/atlas-data.js', './js/virtual-lists.js', './js/ui.js', './js/url-meta.js', './js/browse.js', './js/acervo-features.js', './js/explorar.js', './js/album-view.js', './js/playback.js', './manifest.json'];
// Best effort: radio.html isn't deployed to the mirrors at all, and a 404 here
// must not fail the install.
const EXTRAS = ['./radio.html', './js/radio.js', './assets/radio.css', './3d.html', './js/3d.js', './assets/3d.css', './atlas.html', './js/atlas-data.js', './js/atlas-grafo.js', './js/atlas-receitas.js', './js/atlas-som.js', './js/atlas-visor.js', './js/atlas.js', './js/atlas-tour.js', './assets/atlas.css', './data/resumo-acervo.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL).then(() => Promise.allSettled(EXTRAS.map(u => c.add(u)))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Serve from cache immediately when available; refresh the cache from the
// network in the background. Falls back to cache when offline.
async function staleWhileRevalidate(cacheKey, request, offlineKey = cacheKey) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(cacheKey);
  const network = fetch(request)
    .then(resp => {
      if (resp.ok) cache.put(cacheKey, resp.clone());
      return resp;
    })
    .catch(async err => {
      const copia = cached || await cache.match(offlineKey);
      if (copia) return copia;
      throw err;
    });
  // Com a cópia do cache servida, a falha da atualização em segundo plano (offline, deploy no meio) não é erro de
  // ninguém: sem este catch ela vira "Uncaught (in promise) TypeError: Failed to fetch" no console.
  if (cached) { network.catch(() => {}); return cached; }
  return network;
}

async function networkFirst(cacheKey, request) {
  const cache = await caches.open(CACHE);
  try {
    const resp = await fetch(request);
    if (resp.ok) cache.put(cacheKey, resp.clone());
    return resp;
  } catch (err) {
    const copia = await cache.match(cacheKey);
    if (copia) return copia;
    throw err;
  }
}

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  const sameOrigin = url.origin === self.location.origin;
  const isCatalog = url.pathname.endsWith('.json.gz');
  if (!sameOrigin && !isCatalog) return; // audio, covers, fonts, analytics: network only

  // ?album=/?q=/?acervo= variants are all the same SPA shell — key by pathname
  // so one cached copy serves every deep link.
  if (request.mode === 'navigate') { e.respondWith(networkFirst(url.pathname, request)); return; }

  // deploy.yml stamps ?v=<sha> on scripts and styles: that is part of the file's
  // identity, or a page would get whatever build of the file was cached last. The
  // bare path is what install precached, the copy to use offline.
  const versao = sameOrigin && url.searchParams.has('v');
  const cacheKey = !sameOrigin ? request : versao ? url.pathname + url.search : url.pathname;
  e.respondWith(staleWhileRevalidate(cacheKey, request, sameOrigin ? url.pathname : request));
});
