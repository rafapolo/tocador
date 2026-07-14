// Tocador service worker — instant repeat loads + offline app shell.
//
// Strategy: stale-while-revalidate for same-origin static assets and for the
// acervo catalogs (*.json.gz, cross-origin on GitHub raw). Audio and covers
// (cdn.tocador.cc) are never intercepted so Range requests pass straight
// through to the proxy untouched.
//
// Bump CACHE when the shell changes in a way that must invalidate old copies;
// day-to-day updates propagate anyway via revalidation on each visit.
const CACHE = 'tocador-v1';
const SHELL = ['./', './index.html', './assets/player.css', './js/ui.js', './manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
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
async function staleWhileRevalidate(cacheKey, request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(cacheKey);
  const network = fetch(request)
    .then(resp => {
      if (resp.ok) cache.put(cacheKey, resp.clone());
      return resp;
    })
    .catch(() => cached);
  return cached || network;
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
  const cacheKey = sameOrigin ? url.pathname : request;
  e.respondWith(staleWhileRevalidate(cacheKey, request));
});
