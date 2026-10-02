// Error reporter — posts uncaught JS errors to tocador/issues via the proxy
(function () {
  const REPORT_URL = 'https://cdn.tocador.cc/report-error';
  const seen = new Set();
  let count = 0;
  // Real Chrome/Chromium patch numbers have never exceeded ~300; a randomized-UA
  // bot generator was flooding /radio with spoofed UAs like "Chrome/56.0.4817.1447"
  // — a 4-digit patch number that has never shipped. Same check, same source.
  const HAS_FAKE_CHROME_VERSION = /Chrome\/\d+\.\d+\.\d+\.\d{4,}/.test(navigator.userAgent);

  function report(title, detail) {
    if (navigator.webdriver || HAS_FAKE_CHROME_VERSION || count >= 3 || seen.has(title)) return;
    seen.add(title);
    count++;
    const body = [
      `**${title}**`,
      '',
      '```',
      detail,
      '```',
      '',
      `**URL:** ${location.href}`,
      `**UA:** ${navigator.userAgent}`,
      `**Time:** ${new Date().toISOString()}`,
    ].join('\n');
    fetch(REPORT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, body }), keepalive: true, credentials: 'omit' }).catch(() => {});
  }

  window.addEventListener('error', e => {
    const msg = e.message || String(e);
    if (msg.includes('ResizeObserver')) return; // browser noise, not actionable
    // Cross-origin scripts (loaded without CORS) report as bare "Script error."
    // with no filename/lineno — that's third-party code (analytics, etc.), not ours.
    if (msg === 'Script error.' && !e.filename) return;
    if (e.filename && /umami/i.test(e.filename)) return; // third-party analytics
    const filename = e.filename ? e.filename.replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*/, '') : '';
    const loc = filename ? ` @ ${filename}:${e.lineno}` : '';
    report(`[tocador] JS error: ${msg}${loc}`, e.error?.stack || msg);
  });

  window.addEventListener('unhandledrejection', e => {
    const reason = e.reason;
    if (reason?.name === 'NotAllowedError') { e.preventDefault(); return; }
    const msg = reason?.message || String(reason);
    if (/failed to fetch|network error|load failed/i.test(msg)) { e.preventDefault(); return; }
    const syntheticStack = new Error().stack || '';
    const stack = (reason?.stack && reason.stack !== msg) ? reason.stack : syntheticStack;
    const conn = navigator.connection;
    const extra = [
      `**online:** ${navigator.onLine}`,
      conn ? `**connection:** ${[conn.effectiveType, conn.downlink && conn.downlink + 'Mbps'].filter(Boolean).join(' ')}` : null,
      `**acervo:** ${new URLSearchParams(location.search).get('acervo') || location.pathname}`,
      window.__lastFetchUrl ? `**last fetch:** ${window.__lastFetchUrl}` : null,
    ].filter(Boolean).join('\n');
    report(`[tocador] Unhandled rejection: ${msg}`, `${stack}\n\n${extra}`);
  });
})();

function trackedFetch(url, opts) {
  window.__lastFetchUrl = url;
  return fetch(url, opts);
}

// Defends against acervo-format.js failing to load before this script runs
// (e.g. a flaky fetch, or a stale service-worker cache serving an old shell
// that doesn't reference it) — both are loaded `defer`, so order alone isn't
// enough if one of the two never arrives.
function ensureDecodeAcervo() {
  if (typeof decodeAcervo === 'function') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `${APP_ROOT}js/acervo-format.js`;
    s.onload = resolve;
    s.onerror = () => reject(new Error('failed to load js/acervo-format.js'));
    document.head.appendChild(s);
  });
}

// State
let db;
let albums = [];
let filteredAlbums = [];
let selectedAlbum = null;
let currentTrack = null;
let activeDecade = null;
let activeYear = 0;
let searchQuery = '';
let shuffleOn = false;
let repeatMode = 'off'; // 'off' | 'one' | 'all'
let renderedAlbum = null;
let _consecutiveErrors = 0;
// True from a play request until the next pause. A track that was only primed
// (album opened or ?t= loaded, nothing pressed) must not auto-skip on a load error:
// Googlebot's renderer can't fetch audio, and skipping rewrote ?t=4 to ?t=5, which
// Search Console reports as a redirect on every track URL it crawls.
let _playRequested = false;
const durationCache = new Map();
let _toastEl = null, _countEl = null, _clearBtn = null, _emptyState = null, _clearAllBtn = null;
// Cached DOM references for hot-path elements (set once after DOMContentLoaded)
let _btnPlay = null, _mobileDrawer = null, _drawerCover = null, _overlayTrackTitle = null;
let _playerTitleEl = null, _volumeWave = null, _searchInput = null, _overlayCover = null;
let _overlayTrackArtist = null;
let _progressFillEl = null, _mainProgressBarEl = null, _overlayProgressFillEl = null;
let _timeCurrentLbl = null, _timeDurationLbl = null, _overlayTimeCurrentLbl = null, _overlayTimeDurationLbl = null;

// Browse panel state
let genreData = null;
let genreLoading = false;
let activeGenre = null;
let activeArtist = null;
let browseTab = 'artists';
let browsePanelQuery = '';
let expandedGenres = new Set();
let _cachedGenreTree = null;

// Browse panel DOM refs (set once after DOMContentLoaded)
let _browsePanelEl = null, _browseListEl = null, _browseEmptyEl = null;
let _browseSearchEl = null, _clearAllLabel = null;
let _browseCountEl = null, _browseClearBtn = null;
let _tracksPanelEl = null;

const KNOWN_ACERVOS = {
  uqt: {
    label: 'UmQueTenha',
    data: 'https://rafapolo.github.io/uqt/data/uqt-albums.json.gz',
    base_url: 'https://cdn.tocador.cc/uqt',
  },
  homi: {
    label: 'Hominis Canidae',
    data: 'https://rafapolo.github.io/hominiscanidae/data/homi-albums.json.gz',
    base_url: 'https://cdn.tocador.cc/indie',
    genres: 'https://tocador.cc/data/homi-genres.json.gz',
  },
};
const DEFAULT_ACERVO = 'homi';

let BASE_URL = '';
const failedCovers = new Set();
const PLACEHOLDER_COVER = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"%3E%3Cdefs%3E%3ClinearGradient id="grad" x1="0%25" y1="0%25" x2="100%25" y2="100%25"%3E%3Cstop offset="0%25" style="stop-color:%232a2620;stop-opacity:1" /%3E%3Cstop offset="100%25" style="stop-color:%231a1814;stop-opacity:1" /%3E%3C/linearGradient%3E%3C/defs%3E%3Crect fill="url(%23grad)" width="200" height="200"/%3E%3Ccircle cx="100" cy="100" r="40" fill="none" stroke="%23d4a574" stroke-width="8"/%3E%3Ccircle cx="100" cy="100" r="15" fill="none" stroke="%23d4a574" stroke-width="2"/%3E%3Cpath d="M 100 60 Q 120 80 120 100 Q 120 125 100 140 Q 80 125 80 100 Q 80 80 100 60" fill="none" stroke="%23d4a574" stroke-width="3" stroke-linecap="round"/%3E%3C/svg%3E';

// ── Helpers ────────────────────────────────────────────────────────────────


function artistLinksHTML(str) {
  return parseArtists(str).map(p => {
    const e = escapeHtml(p);
    return `<span class="artist-link" data-artist="${e}" role="button" tabindex="0" aria-label="Buscar por ${e}">${e}</span>`;
  }).join(', ');
}

function attachArtistHandlers(container) {
  container.querySelectorAll('.artist-link[data-artist]').forEach(el => {
    const handleArtistClick = e => {
      e.stopPropagation();
      const name = el.dataset.artist;
      resetFacets('search');
      if (_searchInput) { _searchInput.value = name; }
      searchQuery = name;
      filterAlbums();
      updateQueryInUrl(name, true);
      closeMobileDrawer();
      document.getElementById('now-playing-overlay')?.classList.remove('open');
      _searchInput?.focus();
    };
    el.addEventListener('click', handleArtistClick);
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleArtistClick(e); }
    });
  });
}

function checkMarquee(el) {
  if (!el) return;
  const existing = el.querySelector('.marquee-inner');
  if (existing) el.textContent = existing.textContent;
  el.classList.remove('marquee-active');
  el.style.removeProperty('--marquee-distance');
  el.style.removeProperty('--marquee-duration');

  requestAnimationFrame(() => {
    if (el.scrollWidth <= el.offsetWidth) return;
    const distance = el.offsetWidth - el.scrollWidth;
    const totalSeconds = Math.max(6, Math.abs(distance) / 50 / 0.75);
    el.style.setProperty('--marquee-distance', `${distance}px`);
    el.style.setProperty('--marquee-duration', `${totalSeconds.toFixed(1)}s`);
    const inner = document.createElement('span');
    inner.className = 'marquee-inner';
    inner.textContent = el.textContent;
    el.textContent = '';
    el.appendChild(inner);
    el.classList.add('marquee-active');
  });
}

// Album URLs. On tocador.cc every album of a KNOWN_ACERVOS catalog has a real page
// at /<alias>/<slug>/ (script/build-album-pages.js) that is this same player with
// the album's own title, description and cover og:image in its <head>. The address
// bar shows that URL, so copying it from anywhere unfurls with the cover — a
// ?album= URL never can, since every query string serves the same index.html and
// link-preview crawlers don't run this script. The track rides in the fragment
// (#t5): crawlers never see it, so changing tracks never reads as a redirect.
// The uqt/hominiscanidae Pages mirrors and ?acervo=<url> catalogs have no such
// pages and keep ?album=&t=, which is also still read everywhere for old links.
//
// APP_ROOT is where index.html lives ('/' on tocador.cc, '/uqt/' on a mirror),
// taken from this script's own URL so it holds on any album page too.
const APP_ROOT = new URL('..', document.currentScript?.src || location.href).pathname;
const ALBUM_PAGES = location.origin === 'https://tocador.cc' ||
  document.documentElement.hasAttribute('data-album-pages');

// Resume-playback-position persistence: remembers only the most recently
// playing track, so a reload/restored session can continue where it left off
// instead of always restarting a restored track at 0:00.
const PLAYBACK_POSITION_KEY = 'tocador-position';

function savePlaybackPosition(track, audio) {
  if (!track) return;
  try {
    localStorage.setItem(PLAYBACK_POSITION_KEY, JSON.stringify({ file: track.file, time: audio.currentTime }));
  } catch {}
}

function restorePlaybackPosition(track, audio) {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(PLAYBACK_POSITION_KEY) || 'null'); } catch { return; }
  if (!saved || saved.file !== track.file || !(saved.time > 3)) return;
  const apply = () => {
    if (isFinite(audio.duration) && saved.time < audio.duration) audio.currentTime = saved.time;
    audio.removeEventListener('loadedmetadata', apply);
  };
  audio.addEventListener('loadedmetadata', apply);
}

let _toastTimer = null;
function showToast(msg, duration = 3500) {
  _toastEl ??= document.getElementById('toast');
  if (!_toastEl) return;
  clearTimeout(_toastTimer);
  _toastEl.textContent = msg;
  _toastEl.classList.add('show');
  _toastTimer = setTimeout(() => _toastEl.classList.remove('show'), duration);
}

function loadCoverImage(imgElement, primaryUrl) {
  if (!primaryUrl) {
    imgElement.src = PLACEHOLDER_COVER;
    imgElement.classList.add('placeholder');
    return;
  }
  if (failedCovers.has(primaryUrl)) {
    imgElement.src = PLACEHOLDER_COVER;
    imgElement.classList.add('placeholder');
    return;
  }
  imgElement.classList.remove('placeholder');
  imgElement.src = primaryUrl;
  imgElement.onerror = () => {
    // Virtual grid recycles <img> nodes: guard against a stale error for a
    // previously-assigned URL firing after this node was reused for another
    // album, which would blacklist the wrong (valid) cover permanently.
    if (imgElement.src !== primaryUrl) return;
    failedCovers.add(primaryUrl);
    imgElement.src = PLACEHOLDER_COVER;
    imgElement.classList.add('placeholder');
  };
}

function isMobile() {
  return window.matchMedia('(max-width: 768px)').matches;
}

function openMobileDrawer() {
  (_mobileDrawer ??= document.getElementById('mobile-track-drawer'))?.classList.add('open');
  document.getElementById('btn-tracklist')?.setAttribute('aria-expanded', 'true');
}
function closeMobileDrawer() {
  (_mobileDrawer ??= document.getElementById('mobile-track-drawer'))?.classList.remove('open');
  document.getElementById('btn-tracklist')?.setAttribute('aria-expanded', 'false');
}
function toggleMobileDrawer() {
  const drawer = (_mobileDrawer ??= document.getElementById('mobile-track-drawer'));
  if (!drawer) return;
  const isOpen = drawer.classList.toggle('open');
  document.getElementById('btn-tracklist')?.setAttribute('aria-expanded', String(isOpen));
}

// ── Data ──────────────────────────────────────────────────────────────────

function buildAlbums() {
  // Perf opt 2: pre-lowercase strings once here so filterAlbums() avoids repeated .toLowerCase() calls.
  // Before: filterAlbums with search query = ~4 .toLowerCase() calls × N albums per filter.
  // After: 0 .toLowerCase() calls per filter (done once at load time).
  albums = db.albums.map(album => {
    const nameLower    = fold(album.title);
    const artistsLower = fold(album.artist);
    const pathLower    = fold(album.path);
    // Dedup: generator sometimes finds same track at two paths (direct + subfolder).
    // Prefer the direct-path variant (no '/' in file field).
    const seenTitles = new Map();
    const dedupedTracks = [];
    for (const t of album.tracks) {
      const key = (t.title || '').toLowerCase();
      const isSubfolder = t.file?.includes('/');
      if (!seenTitles.has(key)) {
        seenTitles.set(key, dedupedTracks.length);
        dedupedTracks.push(t);
      } else if (!isSubfolder && dedupedTracks[seenTitles.get(key)].file?.includes('/')) {
        dedupedTracks[seenTitles.get(key)] = t;
      }
    }
    const encodedPath = encodeURIComponent(album.path);
    const tracks = dedupedTracks.map((track, i) => {
      const file = `${encodedPath}/${encodeURIComponent(track.file)}`;
      if (track.duration) durationCache.set(file, track.duration);
      const rawTrackArtist = track.artists ? track.artists.replace(/\x00/g, '; ') : null;
      const trackArtist = rawTrackArtist || album.artist;
      return {
        title: track.title, num: track.num ?? (i + 1), file,
        album: album.title, artists: trackArtist, year: album.year,
        titleLower: fold(track.title),
        artistsLower: fold(trackArtist),
      };
    });
    const genre = genreData?.[album.path.normalize('NFC')] ?? null;
    // Folded keys of every artist on the album (album-level + per-track), so the
    // activeArtist filter is a Set lookup instead of re-running parseArtists()
    // over every album and track on each filter pass.
    const artistKeys = new Set(parseArtists(album.artist).map(fold));
    // Most tracks repeat the album artist (or each other): parse each distinct string once.
    let lastArtists = album.artist;
    for (const t of tracks) {
      if (t.artists === lastArtists) continue;
      lastArtists = t.artists;
      for (const a of parseArtists(t.artists)) artistKeys.add(fold(a));
    }
    return {
      name: album.title, artists: album.artist, year: album.year, path: album.path,
      cover: album.has_cover !== false ? `${BASE_URL}/${encodeURIComponent(album.path)}/capa-min.jpg` : null,
      tracks, nameLower, artistsLower, pathLower, artistKeys,
      genre,
      genreParent: genre ? genre.split('---')[0] : null,
    };
  });
  albums.sort((a, b) => b.year - a.year);
  _cachedDecades = null;
  _cachedArtists = null;
  _cachedGenres  = null;
  _cachedGenreTree = null;
  return albums;
}

// ── Filtering ─────────────────────────────────────────────────────────────

// Perf opt 1: memoized decades — computed once after buildAlbums(), O(1) thereafter.
// Before: ~0.8ms per call × N filter invocations. After: 0ms after first call.
let _cachedDecades = null;
let _cachedArtists = null;
let _cachedGenres  = null;

function getDecades() {
  if (_cachedDecades) return _cachedDecades;
  const decades = new Set(albums.map(a => Math.floor(a.year / 10) * 10).filter(d => d >= 1950));
  _cachedDecades = Array.from(decades).sort((a, b) => a - b);
  return _cachedDecades;
}

function filterAlbums() {
  const q = fold(searchQuery);
  const ak = activeArtist ? fold(activeArtist) : null;
  filteredAlbums = albums.filter(album => {
    if (ak && !album.artistKeys.has(ak)) return false;
    if (activeGenre) {
      if (activeGenre.includes('---')) { if (album.genre !== activeGenre) return false; }
      else { if (album.genreParent !== activeGenre) return false; }
    }
    const matchesDecade = activeDecade === null ||
      (activeDecade === 'noyear' ? !album.year :
      activeDecade === 'pre1940' ? (album.year > 0 && album.year < 1950) : Math.floor(album.year / 10) * 10 === activeDecade);
    if (!matchesDecade) return false;
    const matchesYear = !activeYear || album.year === activeYear;
    if (!matchesYear) return false;
    if (!searchQuery) return true;
    return album.nameLower.includes(q) ||
      album.artistsLower.includes(q) ||
      album.pathLower.includes(q) ||
      album.tracks.some(t => t.titleLower.includes(q) || t.artistsLower.includes(q));
  });

  const inner = virtualGrid?.inner;
  if (inner) {
    inner.classList.add('swapping');
    requestAnimationFrame(() => requestAnimationFrame(() => inner.classList.remove('swapping')));
  }
  virtualGrid.setItems(filteredAlbums);

  _countEl ??= document.getElementById('search-count');
  _clearBtn ??= document.getElementById('search-clear');
  _emptyState ??= document.getElementById('empty-state');
  const isFiltered = !!searchQuery || activeDecade !== null || !!activeYear || !!activeGenre || !!activeArtist;
  if (_countEl) {
    _countEl.textContent = `${filteredAlbums.length} álbun${filteredAlbums.length !== 1 ? 's' : ''}`;
    _countEl.classList.toggle('visible', isFiltered);
  }
  if (_clearBtn) _clearBtn.classList.toggle('visible', !!searchQuery);
  if (_emptyState) _emptyState.hidden = filteredAlbums.length > 0;

  refreshBrowseCounts();
  renderActiveFilterChip();
}

// ── Init ──────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async function () {
  const albumsList = document.querySelector('#albums-list');

  // Delegated click: album grid
  albumsList.addEventListener('click', e => {
    const item = e.target.closest('[data-album-idx]');
    if (!item) return;
    e.preventDefault();
    const album = filteredAlbums[parseInt(item.dataset.albumIdx)];
    if (!album || (selectedAlbum === album && currentTrack != null)) return;

    albumsList.querySelector('.album-item.active')?.classList.remove('active');
    item.classList.add('active');

    selectedAlbum = album;
    renderedAlbum = null;
    renderAlbumHeader();
    renderTrackList();
    renderMobileDrawer(album);
    if (isMobile()) openMobileDrawer();

    if (album.tracks.length > 0) {
      const audio = document.getElementById('audio');
      if (audio.paused) {
        currentTrack = album.tracks[0];
        updateNowPlaying();
        const newSrc = `${BASE_URL}/${currentTrack.file}`;
        if (audio.src !== newSrc) { audio.src = newSrc; audio.load(); }
      }
    }

    updateMetaTags(album);
    const primedNum = currentTrack?.num || 1;
    window.history.pushState({ album: album.path, t: primedNum }, '', generateAlbumUrl(album, primedNum));
  });

  // Browser back/forward: restore album selection and search query from history state
  window.addEventListener('popstate', (e) => {
    const q = new URLSearchParams(window.location.search).get('q') ?? '';
    const yr = getYearFromUrl();
    const newGenero  = getGeneroFromUrl();
    const newArtista = getArtistaFromUrl();
    const browseChanged = newGenero !== activeGenre || newArtista !== activeArtist;
    if (q !== searchQuery || yr !== activeYear || browseChanged) {
      searchQuery = q;
      activeYear = yr;
      activeGenre  = newGenero;
      activeArtist = newArtista;
      if (_searchInput) _searchInput.value = q;
      filterAlbums();
      updateBrowseSelection();
    }
    const path = e.state?.album ?? getAlbumFromUrl();
    if (!path) return;
    const album = albums.find(a => a.path.normalize('NFC') === path.normalize('NFC'));
    if (!album || album === selectedAlbum) return;
    albumsList.querySelector('.album-item.active')?.classList.remove('active');
    selectedAlbum = album;
    renderedAlbum = null;
    virtualGrid.refresh();
    virtualGrid.scrollToSelected();
    renderAlbumHeader();
    const restoredTrackNum = e.state?.t ?? getTrackNumFromUrl();
    if (restoredTrackNum) {
      const t = album.tracks.find(t => t.num === restoredTrackNum);
      if (t) { currentTrack = t; updateNowPlaying(); }
    }
    renderTrackList();
    renderMobileDrawer(album);
    updateMetaTags(album);
  });

  // Delegated click: desktop track list
  document.querySelector('#track-list').addEventListener('click', e => {
    const item = e.target.closest('[data-track-idx]');
    if (item && selectedAlbum) playTrack(selectedAlbum.tracks[parseInt(item.dataset.trackIdx)]);
  });

  // Delegated click: mobile drawer track list
  document.querySelector('#drawer-track-list')?.addEventListener('click', e => {
    const item = e.target.closest('[data-track-idx]');
    if (item && selectedAlbum) playTrack(selectedAlbum.tracks[parseInt(item.dataset.trackIdx)]);
  });


// A cached, older player meeting a newer catalog payload is the one deploy-order
// hazard (see CLAUDE.md, "v2 payload"). Drop the service-worker caches and reload
// once to fetch the current player; if that doesn't help, say so instead of
// leaving an empty grid.
async function handleCatalogDecodeError(err, container) {
  const RELOAD_KEY = 'tocador-stale-reload';
  if (err?.code === 'UNSUPPORTED_ACERVO_VERSION' && !sessionStorage.getItem(RELOAD_KEY)) {
    sessionStorage.setItem(RELOAD_KEY, '1');
    try {
      const regs = await navigator.serviceWorker?.getRegistrations?.() ?? [];
      await Promise.all(regs.map(r => r.unregister()));
      await Promise.all((await caches.keys()).map(k => caches.delete(k)));
    } catch {}
    location.reload();
    return;
  }
  const p = document.createElement('p');
  p.className = 'album-not-found';
  p.textContent = err?.code === 'UNSUPPORTED_ACERVO_VERSION'
    ? 'Este acervo usa um formato mais novo. Recarregue a página para atualizar o player.'
    : 'Não foi possível ler o acervo.';
  container.replaceChildren(p);
}

// Show loading skeleton
  const skeletonEl = document.createElement('div');
  skeletonEl.className = 'grid-skeleton';
  for (let i = 0; i < 30; i++) {
    const card = document.createElement('div');
    card.className = 'skeleton-card';
    skeletonEl.append(card);
  }
  albumsList.append(skeletonEl);

  // Init virtual grid before data loads so it sizes correctly
  virtualGrid = new VirtualGrid(albumsList);

  // Async data: ?acervo=<url|alias> selects the archive; defaults to UQT if omitted
  const acervoParam = albumPageFromPath()?.alias ?? new URLSearchParams(location.search).get('acervo');
  if (acervoParam) {
    const entry = KNOWN_ACERVOS[acervoParam];
    sessionStorage.setItem('acervo', entry ? entry.data : decodeURIComponent(acervoParam));
    if (entry?.base_url) sessionStorage.setItem('acervo-base', entry.base_url);
  }
  let defaultKey = DEFAULT_ACERVO;
  let cfg = {};
  try {
    cfg = await trackedFetch(`${APP_ROOT}config.json`).then(r => r.ok ? r.json() : {});
    if (cfg.acervo && KNOWN_ACERVOS[cfg.acervo]) defaultKey = cfg.acervo;
  } catch {}
  const defaultEntry = KNOWN_ACERVOS[defaultKey];
  const dataUrl = sessionStorage.getItem('acervo') || cfg.dataUrl || defaultEntry.data;
  // db isn't loaded yet, so this can't use the base_url hint; refined below.
  const genresUrl = KNOWN_ACERVOS[resolveAcervoKey(dataUrl, acervoParam) ?? defaultKey]?.genres ?? null;

  async function decompressGzUrl(url) {
    const resp = await trackedFetch(url);
    if (!resp.ok) throw new Error(resp.status);
    return new Response(resp.body.pipeThrough(new DecompressionStream('gzip'))).text();
  }

  if (genresUrl) genreLoading = true;

  const [json, genresRaw] = await Promise.all([
    decompressGzUrl(dataUrl),
    genresUrl
      ? decompressGzUrl(genresUrl).then(t => JSON.parse(t)).catch(() => null)
      : Promise.resolve(null),
  ]);
  // Accepts both the v1 (row) and v2 (columnar) payloads; always yields v1 shape.
  await ensureDecodeAcervo();
  try {
    db = decodeAcervo(JSON.parse(json));
  } catch (err) {
    skeletonEl.remove();
    await handleCatalogDecodeError(err, albumsList);
    return;
  }
  genreData = genresRaw;
  genreLoading = false;
  BASE_URL = db.meta?.base_url || cfg.baseUrl || sessionStorage.getItem('acervo-base') || defaultEntry.base_url || '';
  // Now that db.meta is available, resolve for real — sub-pages and the switcher
  // must follow the acervo actually loaded, not the deployment's default.
  activeAcervoKey = resolveAcervoKey(dataUrl, acervoParam);
  const indexLink = document.getElementById('acervo-index-link');
  if (indexLink) {
    // Plain link to the static album index of the loaded acervo — the crawl path
    // from the player into every album page.
    if (activeAcervoKey) indexLink.href = `${SITE_ORIGIN}/${activeAcervoKey}/`;
    else indexLink.hidden = true;
  }
  const acervoQuery = activeAcervoKey
    ? `?acervo=${encodeURIComponent(activeAcervoKey)}`
    : (acervoParam ? `?acervo=${encodeURIComponent(acervoParam)}` : '');
  const btn3d = document.getElementById('btn-3d');
  if (btn3d) btn3d.href = `${APP_ROOT}3d.html${acervoQuery}`;
  const btnRadio = document.getElementById('btn-radio');
  if (btnRadio) btnRadio.href = `${APP_ROOT}radio.html${acervoQuery}`;
  skeletonEl.remove();
  applyArchiveMeta();
  renderAcervoSelect(activeAcervoKey);

  // Cache hot-path DOM elements once at init time
  _btnPlay = document.getElementById('btn-play');
  _mobileDrawer = document.getElementById('mobile-track-drawer');
  _volumeWave = document.getElementById('volume-wave');
  _searchInput = document.getElementById('search-input');
  _playerTitleEl = document.getElementById('player-title');
  _overlayTrackTitle = document.getElementById('overlay-track-title');
  _overlayTrackArtist = document.getElementById('overlay-track-artist');
  _overlayCover = document.getElementById('overlay-cover');
  _drawerCover = document.getElementById('drawer-cover');
  _browsePanelEl    = document.getElementById('browse-panel');
  _browseListEl     = document.getElementById('browse-list');
  _browseEmptyEl    = document.getElementById('browse-empty');
  _browseSearchEl   = document.getElementById('browse-search');
  _browseCountEl    = document.getElementById('browse-count');
  _browseClearBtn   = document.getElementById('browse-clear');
  _tracksPanelEl    = document.getElementById('tracks-panel');

  buildAlbums();
  filteredAlbums = [...albums];
  renderDecadeButtons();
  virtualGrid.setItems(filteredAlbums);
  updateLibraryStats();

  // Init browse panel VirtualList and apply initial state
  if (_browseListEl) {
    virtualBrowseList = new VirtualList(_browseListEl);
    // Enable/disable Genres tab based on genreData availability
    const genresTabBtn = document.querySelector('.browse-tab[data-tab="genres"]');
    if (genresTabBtn) {
      if (genreData) {
        genresTabBtn.hidden = false;
        genresTabBtn.disabled = false;
      }
    }
    renderBrowsePanel();
  }

  // Restore search query and year filter from URL
  const initialQuery = getQueryFromUrl();
  if (initialQuery) {
    searchQuery = initialQuery;
    if (_searchInput) _searchInput.value = initialQuery;
    filterAlbums();
  }
  const initialYear = getYearFromUrl();
  if (initialYear) { activeYear = initialYear; filterAlbums(); }

  // Restore browse filter from URL
  const initialGenero = getGeneroFromUrl();
  const initialArtista = getArtistaFromUrl();
  if (initialGenero && genreData) { activeGenre = initialGenero; filterAlbums(); }
  else if (initialArtista) { activeArtist = initialArtista; filterAlbums(); }

  // Select initial album from URL or first in list
  const albumFromUrl = getAlbumFromUrl();
  let albumToSelect = albumFromUrl ? albums.find(a => a.path.normalize('NFC') === albumFromUrl.normalize('NFC')) : null;
  if (!albumToSelect && !albumFromUrl && filteredAlbums.length > 0) albumToSelect = filteredAlbums[0];

  if (albumFromUrl && !albumToSelect) {
    const cleanParams = new URLSearchParams(window.location.search);
    cleanParams.delete('album'); cleanParams.delete('t'); cleanParams.delete('artista'); cleanParams.delete('genero');
    if (albumPageFromPath() && activeAcervoKey) cleanParams.set('acervo', activeAcervoKey);
    const cleanUrl = `${APP_ROOT}${cleanParams.toString() ? '?' + cleanParams : ''}`;
    window.history.replaceState({}, '', cleanUrl);
    virtualGrid.setItems(filteredAlbums);
    const container = document.getElementById('album-header');
    container.innerHTML = `<p class="album-not-found">Álbum não existe</p>`;
    document.getElementById('track-list').replaceChildren(); // an album page's pre-rendered tracks
  } else if (albumToSelect) {
    selectedAlbum = albumToSelect;
    virtualGrid.setItems(filteredAlbums);
    virtualGrid.scrollToSelected();
    renderAlbumHeader();
    const trackNumFromUrl = getTrackNumFromUrl();
    if (trackNumFromUrl) {
      const t = albumToSelect.tracks.find(t => t.num === trackNumFromUrl);
      if (t) {
        currentTrack = t;
        updateNowPlaying();
        const audio = document.getElementById('audio');
        const newSrc = `${BASE_URL}/${t.file}`;
        if (audio.src !== newSrc) { audio.src = newSrc; audio.load(); }
        restorePlaybackPosition(t, audio);
        if (getPlayFromUrl()) safePlay(audio);
      }
    } else if (getPlayFromUrl() && albumToSelect.tracks.length > 0) {
      playTrack(albumToSelect.tracks[0]);
    }
    renderTrackList();
    renderMobileDrawer(albumToSelect);
    if (albumFromUrl && isMobile()) openMobileDrawer();
    if (albumFromUrl) {
      updateMetaTags(albumToSelect);
      replaceUrl({ album: albumToSelect.path, t: trackNumFromUrl || null }, generateAlbumUrl(albumToSelect, trackNumFromUrl || null));
    }
  }

  const playerCover = document.getElementById('player-cover');
  if (playerCover && !playerCover.src) {
    playerCover.src = PLACEHOLDER_COVER;
    playerCover.classList.add('placeholder');
  }
  playerCover?.addEventListener('click', () => {
    if (!currentTrack) return;
    const playingAlbum = albums.find(a => a.tracks.includes(currentTrack));
    if (!playingAlbum || playingAlbum === selectedAlbum) return;
    selectedAlbum = playingAlbum;
    renderedAlbum = null;
    renderAlbumHeader();
    renderTrackList();
    virtualGrid.refresh();
    virtualGrid.scrollToSelected();
    if (isMobile()) {
      renderMobileDrawer(playingAlbum);
      openMobileDrawer();
    }
  });

  const audio = document.getElementById('audio');

  const overlayBtnPlay = document.getElementById('overlay-btn-play');
  const setLoading = on => {
    _btnPlay?.classList.toggle('loading', on);
    overlayBtnPlay?.classList.toggle('loading', on);
  };

  audio.addEventListener('play',     () => {
    (_btnPlay ??= document.getElementById('btn-play'))?.classList.add('playing');
    overlayBtnPlay?.classList.add('playing');
    _btnPlay?.classList.remove('autoplay-blocked');
    _btnPlay?.setAttribute('aria-label', 'Pausar');
    overlayBtnPlay?.setAttribute('aria-label', 'Pausar');
  });
  audio.addEventListener('pause',    () => {
    _playRequested = false;
    (_btnPlay ??= document.getElementById('btn-play'))?.classList.remove('playing');
    overlayBtnPlay?.classList.remove('playing');
    _btnPlay?.setAttribute('aria-label', 'Reproduzir');
    overlayBtnPlay?.setAttribute('aria-label', 'Reproduzir');
    savePlaybackPosition(currentTrack, audio);
  });
  audio.addEventListener('waiting',  () => setLoading(true));
  audio.addEventListener('stalled',  () => setLoading(true));
  audio.addEventListener('canplay',  () => setLoading(false));
  audio.addEventListener('playing',  () => { setLoading(false); _consecutiveErrors = 0; });
  const MAX_CONSECUTIVE_ERRORS = 3;
  audio.addEventListener('error', () => {
    setLoading(false);
    if (currentTrack && _playRequested) {
      const errored = currentTrack;
      _consecutiveErrors++;
      // Several tracks failing in a row usually means the proxy/network is down,
      // not that individual files are broken — stop thrashing through the whole
      // library and tell the user instead of silently skipping forever.
      if (_consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        showToast('Vários erros de reprodução seguidos — reprodução pausada.', 6000);
        audio.pause();
        return;
      }
      showToast('Erro ao carregar áudio — pulando...');
      // Only auto-skip if the user hasn't already moved on (manually picked another
      // track) and this track's error is still the audio element's current state —
      // otherwise a stale timeout can yank the user off a track they just chose.
      setTimeout(() => {
        if (currentTrack === errored && audio.error) playNext();
      }, 1500);
    }
  });

  const progressFill = document.querySelector('#progress-fill');
  const mainProgressBar = document.getElementById('main-progress-bar');
  const overlayProgressFill = document.getElementById('overlay-progress-fill');
  const overlayTimeCurrent = document.getElementById('overlay-time-current');
  const overlayTimeDuration = document.getElementById('overlay-time-duration');
  const timeCurrentEl = document.getElementById('time-current');

  // timeupdate fires ~4–60×/s. Only the progress-bar width needs that resolution;
  // the time label and mediaSession position change at most once per second, so gate
  // those on the integer-second boundary to skip the per-tick text writes and DOM query.
  let _lastWholeSecond = -1;
  audio.addEventListener('timeupdate', () => {
    // 'stalled'/'waiting' can fire mid-playback without a matching 'canplay'/'playing'
    // to clear them (readyState never actually drops), leaving the spinner stuck even
    // though audio is audibly advancing — timeupdate only fires while it truly is.
    if (!audio.paused) setLoading(false);
    const percent = (audio.currentTime / audio.duration) * 100 || 0;
    progressFill.style.width = percent + '%';
    mainProgressBar.classList.toggle('has-progress', percent > 0);
    mainProgressBar.setAttribute('aria-valuenow', Math.round(percent));
    if (overlayProgressFill) overlayProgressFill.style.width = percent + '%';

    const whole = Math.floor(audio.currentTime);
    if (whole === _lastWholeSecond) return;
    _lastWholeSecond = whole;
    const cur = formatTime(audio.currentTime);
    if (timeCurrentEl) timeCurrentEl.textContent = cur;
    if (overlayTimeCurrent) overlayTimeCurrent.textContent = cur;
    if ('mediaSession' in navigator && audio.duration && !isNaN(audio.duration)) {
      try { navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate, position: audio.currentTime }); } catch (_) {}
    }
    // localStorage writes are synchronous main-thread work — every 5s is plenty;
    // pause and pagehide handlers cover the exact position on stop/close.
    if (whole % 5 === 0) savePlaybackPosition(currentTrack, audio);
  });

  window.addEventListener('pagehide', () => savePlaybackPosition(currentTrack, audio));

  audio.addEventListener('loadedmetadata', () => {
    const dur = formatTime(audio.duration);
    (_timeDurationLbl ??= document.getElementById('time-duration')).textContent = dur;
    if (overlayTimeDuration) overlayTimeDuration.textContent = dur;
    // Guard against stale/aborted loads (rapid track switching): only trust this
    // event if it matches the track currently loaded and reports a real duration,
    // otherwise a race can zero out a good ID3-derived duration in the cache.
    if (currentTrack && audio.src === `${BASE_URL}/${currentTrack.file}` && isFinite(audio.duration) && audio.duration > 0) {
      durationCache.set(currentTrack.file, audio.duration);
      if (selectedAlbum) {
        const idx = selectedAlbum.tracks.indexOf(currentTrack);
        if (idx >= 0) updateDurationInDOM(currentTrack, idx);
      }
    }
  });

  audio.addEventListener('ended', playNext);

  // Singleton player across tabs: pause this tab when another tab starts playing.
  // BroadcastChannel's constructor can throw SecurityError in Firefox when
  // storage access is restricted (private browsing, strict tracking
  // protection, storage disabled) — this is an optional convenience, so
  // degrade silently instead of surfacing an uncaught error.
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      const TAB_ID = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
      const playerChannel = new BroadcastChannel('tocador-player');
      audio.addEventListener('play', () => playerChannel.postMessage({ tabId: TAB_ID }));
      playerChannel.onmessage = ({ data }) => {
        if (data?.tabId !== TAB_ID) audio.pause();
      };
    } catch (_) {}
  }

  _btnPlay?.addEventListener('click', function () {
    if (audio.paused) {
      if (!currentTrack) {
        if (selectedAlbum?.tracks.length > 0) {
          playTrack(selectedAlbum.tracks[0]);
        } else if (filteredAlbums.length > 0) {
          selectedAlbum = filteredAlbums[0];
          virtualGrid.refresh();
          renderAlbumHeader();
          renderTrackList();
          playTrack(selectedAlbum.tracks[0]);
        }
      } else {
        safePlay(audio);
        (_btnPlay ??= document.getElementById('btn-play'))?.classList.add('playing');
      }
    } else {
      if (selectedAlbum && currentTrack && !selectedAlbum.tracks.includes(currentTrack)) {
        playTrack(selectedAlbum.tracks[0]);
      } else {
        audio.pause();
      }
    }
  });

  document.getElementById('btn-prev')?.addEventListener('click', playPrevious);
  document.getElementById('btn-next')?.addEventListener('click', playNext);

  // Mobile now-playing overlay
  const overlay = document.getElementById('now-playing-overlay');
  const overlayProgressBar = document.getElementById('overlay-progress-bar');
  document.querySelector('.now-playing-compact')?.addEventListener('click', () => {
    if (isMobile() && currentTrack) overlay?.classList.add('open');
  });
  document.getElementById('overlay-close')?.addEventListener('click', () => overlay?.classList.remove('open'));
  document.getElementById('overlay-btn-prev')?.addEventListener('click', playPrevious);
  document.getElementById('overlay-btn-next')?.addEventListener('click', playNext);
  overlayBtnPlay?.addEventListener('click', () => _btnPlay?.click());

  // Media Session action handlers
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', () => safePlay(audio));
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('previoustrack', playPrevious);
    navigator.mediaSession.setActionHandler('nexttrack', playNext);
    navigator.mediaSession.setActionHandler('seekbackward', ({ seekOffset = 10 }) => { audio.currentTime = Math.max(0, audio.currentTime - seekOffset); });
    navigator.mediaSession.setActionHandler('seekforward', ({ seekOffset = 10 }) => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + seekOffset); });
    navigator.mediaSession.setActionHandler('seekto', ({ seekTime }) => { audio.currentTime = seekTime; });
  }

  document.getElementById('drawer-close')?.addEventListener('click', closeMobileDrawer);
  document.getElementById('btn-tracklist')?.addEventListener('click', toggleMobileDrawer);

  const btnShuffle = document.getElementById('btn-shuffle');
  const btnShuffleMobile = document.getElementById('btn-shuffle-mobile');
  const btnRepeat = document.getElementById('btn-repeat');
  const volumeSlider = document.getElementById('volume-slider');

  function applyRepeatMode(mode) {
    repeatMode = mode;
    audio.loop = (mode === 'one');
    const isActive = mode !== 'off';
    btnRepeat?.classList.toggle('active', isActive);
    const titles = { off: 'Repetir', one: 'Repetir faixa', all: 'Repetir álbum' };
    const labels = { off: 'Repetir: desativado', one: 'Repetir faixa: ativado', all: 'Repetir álbum: ativado' };
    if (btnRepeat) {
      btnRepeat.title = titles[mode];
      btnRepeat.setAttribute('aria-label', labels[mode]);
      btnRepeat.setAttribute('aria-pressed', String(isActive));
    }
    localStorage.setItem('tocador-repeat', mode);
  }

  function applyShuffle(val) {
    shuffleOn = val;
    btnShuffle?.classList.toggle('active', shuffleOn);
    btnShuffleMobile?.classList.toggle('active', shuffleOn);
    if (btnShuffle) {
      btnShuffle.setAttribute('aria-pressed', String(shuffleOn));
      btnShuffle.setAttribute('aria-label', shuffleOn ? 'Modo aleatório: ativado' : 'Modo aleatório: desativado');
    }
    if (btnShuffleMobile) {
      btnShuffleMobile.setAttribute('aria-pressed', String(shuffleOn));
      btnShuffleMobile.setAttribute('aria-label', shuffleOn ? 'Modo aleatório: ativado' : 'Modo aleatório: desativado');
    }
    localStorage.setItem('tocador-shuffle', shuffleOn);
  }

  const volumeIcon = document.getElementById('volume-icon');
  let _preMuteVolume = 1;

  function setVolume(vol) {
    audio.volume = vol;
    if (volumeSlider) volumeSlider.value = vol;
    if (_volumeWave) _volumeWave.style.display = vol === 0 ? 'none' : '';
    volumeIcon?.setAttribute('aria-label', vol === 0 ? 'Ativar som' : 'Silenciar');
    localStorage.setItem('tocador-volume', vol);
  }

  // Restore persisted state
  applyShuffle(localStorage.getItem('tocador-shuffle') === 'true');
  applyRepeatMode(localStorage.getItem('tocador-repeat') || 'off');
  const savedVolume = parseFloat(localStorage.getItem('tocador-volume') ?? '1');
  if (savedVolume > 0) _preMuteVolume = savedVolume;
  setVolume(savedVolume);

  btnShuffle?.addEventListener('click', () => applyShuffle(!shuffleOn));
  btnShuffleMobile?.addEventListener('click', () => applyShuffle(!shuffleOn));

  btnRepeat?.addEventListener('click', () => {
    applyRepeatMode(repeatMode === 'off' ? 'one' : repeatMode === 'one' ? 'all' : 'off');
  });

  volumeSlider?.addEventListener('input', () => {
    const vol = parseFloat(volumeSlider.value);
    if (vol > 0) _preMuteVolume = vol;
    setVolume(vol);
  });

  // Clicking the volume icon toggles mute, restoring the previous level on unmute
  const toggleMute = () => setVolume(audio.volume > 0 ? 0 : _preMuteVolume);
  volumeIcon?.addEventListener('click', toggleMute);
  volumeIcon?.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleMute(); }
  });

  function seekFromClient(clientX, barEl) {
    // audio.duration can be Infinity (unknown-length stream) or the bar can have zero
    // width if it seeked before layout — both slip past a bare `!audio.duration` check
    // and multiply out to a bogus, effectively-infinite currentTime.
    if (!isFinite(audio.duration) || audio.duration <= 0) return;
    const rect = barEl.getBoundingClientRect();
    if (!rect.width) return;
    audio.currentTime = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * audio.duration;
  }

  [mainProgressBar, overlayProgressBar].forEach(bar => {
    if (!bar) return;
    bar.addEventListener('click', e => seekFromClient(e.clientX, bar));
    bar.addEventListener('touchstart', e => { e.preventDefault(); seekFromClient(e.touches[0].clientX, bar); }, { passive: false });
    bar.addEventListener('touchmove',  e => { e.preventDefault(); seekFromClient(e.touches[0].clientX, bar); }, { passive: false });

    // Mouse drag-to-seek. preventDefault on mousedown stops the browser from
    // starting a native text-selection drag as the pointer moves off the bar —
    // without it, dragging seeks *and* highlights whatever text is underneath.
    bar.addEventListener('mousedown', e => {
      e.preventDefault();
      seekFromClient(e.clientX, bar);
      const onMove = moveEvt => seekFromClient(moveEvt.clientX, bar);
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });

  if (_playerTitleEl && window.ResizeObserver) {
    new ResizeObserver(() => {
      if (currentTrack) checkMarquee(_playerTitleEl);
    }).observe(_playerTitleEl.closest('.player-info'));
  }

  let searchDebounce;
  _searchInput?.addEventListener('input', function () {
    const typed = this.value;
    if (typed) resetFacets('search');
    searchQuery = typed;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => { filterAlbums(); updateQueryInUrl(searchQuery.trim(), false); }, 150);
  });

  const clearSearch = () => {
    searchQuery = '';
    activeYear = 0; updateYearInUrl(0);
    if (_searchInput) { _searchInput.value = ''; }
    filterAlbums();
    updateQueryInUrl('', false);
    _searchInput?.focus();
  };
  document.getElementById('search-clear')?.addEventListener('click', clearSearch);
  document.getElementById('empty-clear-btn')?.addEventListener('click', clearAllFilters);
  document.getElementById('clear-all-filters')?.addEventListener('click', clearAllFilters);

  // ── Browse panel events ─────────────────────────────────────────────────

  // Delegated click on list items
  _browseListEl?.addEventListener('click', e => {
    const item = e.target.closest('[data-value]');
    if (item) selectBrowseItem(item.dataset.value, item.dataset.type);
  });

  // Keyboard nav in browse list (Up/Down arrows, Enter/Space)
  _browseListEl?.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const nodes = [..._browseListEl.querySelectorAll('.browse-item')];
      const cur = document.activeElement;
      const idx = nodes.indexOf(cur);
      const next = e.key === 'ArrowDown' ? nodes[idx + 1] : nodes[idx - 1];
      next?.focus();
    }
    if (e.key === 'Enter' || e.key === ' ') {
      const item = e.target.closest('[data-value]');
      if (item) { e.preventDefault(); selectBrowseItem(item.dataset.value); }
    }
  });

  // Tab switcher
  document.querySelectorAll('.browse-tab').forEach(btn => {
    btn.addEventListener('click', () => { if (!btn.disabled) switchBrowseTab(btn.dataset.tab); });
    btn.addEventListener('keydown', e => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const tabs = [...document.querySelectorAll('.browse-tab:not([disabled])')];
        const idx = tabs.indexOf(btn);
        const next = e.key === 'ArrowRight' ? tabs[idx + 1] : tabs[idx - 1];
        if (next) { next.focus(); switchBrowseTab(next.dataset.tab); }
      }
    });
  });

  // In-panel search
  let browseSearchDebounce;
  _browseSearchEl?.addEventListener('input', () => {
    browsePanelQuery = _browseSearchEl.value;
    clearTimeout(browseSearchDebounce);
    browseSearchDebounce = setTimeout(renderBrowsePanel, 120);
  });
  _browseClearBtn?.addEventListener('click', () => {
    browsePanelQuery = '';
    if (_browseSearchEl) _browseSearchEl.value = '';
    _updateBrowseCountUI(0);
    renderBrowsePanel();
    _browseSearchEl?.focus();
  });

  // Mobile trigger button
  document.getElementById('btn-browse')?.addEventListener('click', openBrowseDrawer);

  // Scrim tap to close
  document.getElementById('browse-scrim')?.addEventListener('click', closeBrowseDrawer);
  document.getElementById('btn-browse-close')?.addEventListener('click', closeBrowseDrawer);

  // Keyboard shortcuts help modal
  document.getElementById('btn-shortcuts')?.addEventListener('click', openShortcutsModal);
  document.getElementById('shortcuts-close')?.addEventListener('click', closeShortcutsModal);
  document.getElementById('shortcuts-scrim')?.addEventListener('click', closeShortcutsModal);

  document.addEventListener('keydown', e => {
    // Escape: close shortcuts modal OR mobile browse drawer OR clear active panel filter
    if (e.key === 'Escape') {
      if (isShortcutsModalOpen()) { closeShortcutsModal(); return; }
      if (typeof isExplorarOpen === 'function' && isExplorarOpen()) { closeExplorar(); return; }
      if (isMobile() && _browsePanelEl?.classList.contains('open')) {
        closeBrowseDrawer(); return;
      }
      if (activeGenre || activeArtist) {
        activeGenre = null; activeArtist = null;
        updateBrowseFilterInUrl(); filterAlbums(); updateBrowseSelection(); return;
      }
    }
    if (e.target.closest('input, textarea, [contenteditable]')) return;
    switch (e.key) {
      case '?':
        e.preventDefault();
        openShortcutsModal();
        break;
      case ' ':
        e.preventDefault();
        _btnPlay?.click();
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime + 10);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (audio.duration) audio.currentTime = Math.max(0, audio.currentTime - 10);
        break;
      case 'n':
        if (!e.metaKey && !e.ctrlKey && !e.altKey) playNext();
        break;
      case 'p':
        if (!e.metaKey && !e.ctrlKey && !e.altKey) playPrevious();
        break;
      case '/':
        e.preventDefault();
        _searchInput?.focus();
        break;
      case 'b':
        if (!e.metaKey && !e.ctrlKey && !e.altKey) toggleBrowsePanel();
        break;
      case 'e':
        if (!e.metaKey && !e.ctrlKey && !e.altKey) toggleExplorar();
        break;
      case 'g':
        if (!e.metaKey && !e.ctrlKey && !e.altKey && genreData) {
          if (isMobile()) openBrowseDrawer();
          switchBrowseTab('genres');
        }
        break;
    }
  });
});

// ── Service Worker (PWA) ──────────────────────────────────────────────────
// Registered after load so it never competes with the initial catalog fetch.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${APP_ROOT}sw.js`, { scope: APP_ROOT }).catch(() => {});
  });
}
