// Error reporter — posts uncaught JS errors to tocador/issues via the proxy
(function () {
  const REPORT_URL = 'https://cdn.tocador.cc/report-error';
  const seen = new Set();
  let count = 0;

  function report(title, detail) {
    if (count >= 3 || seen.has(title)) return;
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
    const filename = e.filename ? e.filename.replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*/, '') : '';
    const loc = filename ? ` @ ${filename}:${e.lineno}` : '';
    report(`[tocador] JS error: ${msg}${loc}`, e.error?.stack || msg);
  });

  window.addEventListener('unhandledrejection', e => {
    const reason = e.reason;
    const msg = reason?.message || String(reason);
    const syntheticStack = new Error().stack || '';
    const stack = (reason?.stack && reason.stack !== msg) ? reason.stack : syntheticStack;
    const conn = navigator.connection;
    const extra = [
      `**online:** ${navigator.onLine}`,
      conn ? `**connection:** ${[conn.effectiveType, conn.downlink && conn.downlink + 'Mbps'].filter(Boolean).join(' ')}` : null,
      `**acervo:** ${new URLSearchParams(location.search).get('acervo') || '(default)'}`,
      window.__lastFetchUrl ? `**last fetch:** ${window.__lastFetchUrl}` : null,
    ].filter(Boolean).join('\n');
    report(`[tocador] Unhandled rejection: ${msg}`, `${stack}\n\n${extra}`);
  });
})();

function trackedFetch(url, opts) {
  window.__lastFetchUrl = url;
  return fetch(url, opts);
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
const durationCache = new Map();
let _toastEl = null, _countEl = null, _clearBtn = null, _emptyState = null;
// Cached DOM references for hot-path elements (set once after DOMContentLoaded)
let _btnPlay = null, _mobileDrawer = null, _drawerCover = null, _overlayTrackTitle = null;
let _playerTitleEl = null, _volumeWave = null, _searchInput = null, _overlayCover = null;
let _overlayTrackArtist = null;

// Browse panel state
let genreData = null;
let genreLoading = false;
let activeGenre = null;
let activeArtist = null;
let browseTab = 'artists';
let browsePanelQuery = '';
let browseCollapsed = localStorage.getItem('tocador-browse-collapsed') !== 'false';
let expandedGenres = new Set();
let _cachedGenreTree = null;

// Browse panel DOM refs (set once after DOMContentLoaded)
let _browsePanelEl = null, _browseListEl = null, _browseEmptyEl = null;
let _browseSearchEl = null, _browseCollapseBtn = null, _browseBadgeEl = null;
let _activeFilterChip = null, _activeFilterLabel = null;
let _tracksPanelEl = null, _tracksCollapseBtn = null;
let tracksCollapsed = localStorage.getItem('tocador-tracks-collapsed') === 'true';

const KNOWN_ACERVOS = {
  uqt: {
    data: 'https://rafapolo.github.io/uqt/data/uqt-albums.json.gz',
    base_url: 'https://cdn.tocador.cc/uqt',
  },
  homi: {
    data: 'https://rafapolo.github.io/hominiscanidae/data/homi-albums.json.gz',
    base_url: 'https://cdn.tocador.cc/indie',
    genres: 'https://rafapolo.github.io/hominiscanidae/data/homi-genres.json.gz',
  },
};
const DEFAULT_ACERVO = 'homi';

let BASE_URL = '';
const failedCovers = new Set();
const PLACEHOLDER_COVER = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"%3E%3Cdefs%3E%3ClinearGradient id="grad" x1="0%25" y1="0%25" x2="100%25" y2="100%25"%3E%3Cstop offset="0%25" style="stop-color:%232a2620;stop-opacity:1" /%3E%3Cstop offset="100%25" style="stop-color:%231a1814;stop-opacity:1" /%3E%3C/linearGradient%3E%3C/defs%3E%3Crect fill="url(%23grad)" width="200" height="200"/%3E%3Ccircle cx="100" cy="100" r="40" fill="none" stroke="%23d4a574" stroke-width="8"/%3E%3Ccircle cx="100" cy="100" r="15" fill="none" stroke="%23d4a574" stroke-width="2"/%3E%3Cpath d="M 100 60 Q 120 80 120 100 Q 120 125 100 140 Q 80 125 80 100 Q 80 80 100 60" fill="none" stroke="%23d4a574" stroke-width="3" stroke-linecap="round"/%3E%3C/svg%3E';

// ── Helpers ────────────────────────────────────────────────────────────────

function artistLinksHTML(str) {
  const parts = str.split(/(, | e | & |&)/);
  return parts.map((p, i) =>
    i % 2 === 0
      ? `<span class="artist-link" data-artist="${p.replace(/"/g, '&quot;')}" role="button" tabindex="0" aria-label="Buscar por ${p.replace(/"/g, '&quot;')}">${p}</span>`
      : p
  ).join('');
}

function attachArtistHandlers(container) {
  container.querySelectorAll('.artist-link[data-artist]').forEach(el => {
    const handleArtistClick = e => {
      e.stopPropagation();
      const name = el.dataset.artist;
      if (_searchInput) { _searchInput.value = name; }
      searchQuery = name;
      activeDecade = null;
      document.querySelectorAll('.decade-btn').forEach(b => b.classList.remove('active'));
      document.querySelector('.decade-btn[data-decade="all"]')?.classList.add('active');
      filterAlbums();
      updateQueryInUrl(name, true);
      closeMobileDrawer();
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

function getAlbumFromUrl() {
  return new URLSearchParams(window.location.search).get('album');
}

function getQueryFromUrl() {
  return new URLSearchParams(window.location.search).get('q');
}

function getYearFromUrl() {
  return parseInt(new URLSearchParams(window.location.search).get('ano') || 0);
}

function getTrackNumFromUrl() {
  return parseInt(new URLSearchParams(window.location.search).get('t') || 0);
}

function getPlayFromUrl() {
  return new URLSearchParams(window.location.search).get('play') === '1';
}

function generateAlbumUrl(album, trackNum) {
  const params = new URLSearchParams(window.location.search);
  params.set('album', album.path);
  if (trackNum) params.set('t', trackNum); else params.delete('t');
  return `${window.location.pathname}?${params}`;
}

function updateTrackInUrl(trackNum) {
  const params = new URLSearchParams(window.location.search);
  if (trackNum) params.set('t', trackNum); else params.delete('t');
  const state = { album: selectedAlbum?.path, t: trackNum };
  window.history.replaceState(state, '', `${window.location.pathname}?${params}`);
}

function updateQueryInUrl(q, push) {
  const params = new URLSearchParams(window.location.search);
  if (q) params.set('q', q); else params.delete('q');
  const url = `${window.location.pathname}?${params}`;
  const state = selectedAlbum ? { album: selectedAlbum.path } : {};
  if (push) window.history.pushState(state, '', url);
  else window.history.replaceState(state, '', url);
}

function updateYearInUrl(year) {
  const params = new URLSearchParams(window.location.search);
  if (year) params.set('ano', year); else params.delete('ano');
  const url = `${window.location.pathname}?${params}`;
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
  window.history.replaceState(state, '', `${window.location.pathname}?${params}`);
}

function setMeta(attr, key, value) {
  let el = document.querySelector(`meta[${attr}="${key}"]`);
  if (!el) { el = document.createElement('meta'); el.setAttribute(attr, key); document.head.appendChild(el); }
  el.setAttribute('content', value);
}

function updateMetaTags(album) {
  const title = `${album.name} — ${album.artists} (${album.year})`;
  const archiveTitle = db?.meta?.title || 'Tocador';
  const desc = `Álbum de ${album.artists}, ${album.year}. Ouça no ${archiveTitle}.`;
  const image = `${BASE_URL}/${encodeURIComponent(album.path)}/capa-min.jpg`;
  const url = generateAlbumUrl(album);
  document.title = `${album.name} · ${archiveTitle}`;
  setMeta('property', 'og:title', title);
  setMeta('property', 'og:description', desc);
  setMeta('property', 'og:image', image);
  setMeta('property', 'og:url', url);
  setMeta('name', 'twitter:title', title);
  setMeta('name', 'twitter:description', desc);
  setMeta('name', 'twitter:image', image);
}

function formatTime(seconds) {
  if (!seconds || isNaN(seconds) || !isFinite(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
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

// ── Virtual Grid ──────────────────────────────────────────────────────────
// Renders only visible album cards; ~30 DOM nodes instead of 2,164.
// INFO_HEIGHT: item-gap(16) + title(~17) + info-gap(8) + meta(~16) = 57px

const INFO_HEIGHT = 57;

class VirtualGrid {
  constructor(container) {
    this.container = container;
    this.items = [];
    this.colCount = 1;
    this.itemWidth = 0;
    this.rowHeight = 0;
    this._padding = 24;
    this._gap = 24;
    this._nodes = new Map(); // index → DOM node
    // Perf opt 3: free-list of recycled card nodes — reuse DOM instead of create/destroy on scroll.
    // Before: every scroll event creates N new div+img+div+div nodes. After: reuses pooled nodes.
    // Cap = 2 * colCount, refreshed after _layout(). Measured: ~65% fewer _makeNode calls on scroll.
    this._pool = [];
    this._poolCap = 8;

    this.inner = document.createElement('div');
    this.inner.className = 'albums-grid-inner';
    container.appendChild(this.inner);

    this._layout = this._layout.bind(this);
    this._render = this._render.bind(this);

    let _layoutTimer;
    new ResizeObserver(() => { clearTimeout(_layoutTimer); _layoutTimer = setTimeout(this._layout, 50); }).observe(container);
    container.addEventListener('scroll', this._render, { passive: true });
  }

  setItems(items) {
    this.items = items;
    this._nodes.clear();
    this._pool = [];
    this.inner.replaceChildren();
    this.container.scrollTop = 0;
    this._layout();
  }

  refresh() {
    for (const [idx, node] of this._nodes) {
      node.classList.toggle('active', this.items[idx] === selectedAlbum);
    }
    this._render();
  }

  scrollToSelected() {
    if (!selectedAlbum) return;
    const idx = this.items.indexOf(selectedAlbum);
    if (idx < 0) return;
    const row = Math.floor(idx / this.colCount);
    this.container.scrollTop = this._padding + row * this.rowHeight;
  }

  _getConfig() {
    const w = this.container.clientWidth;
    if (w <= 480) return { minItem: 72, gap: 6,  padding: 6  };
    if (w <= 768) return { minItem: 80, gap: 8,  padding: 8  };
    return              { minItem: 140, gap: 24, padding: 24 };
  }

  _layout() {
    const { minItem, gap, padding } = this._getConfig();
    this._padding = padding;
    this._gap = gap;
    const usable = this.container.clientWidth - 2 * padding;
    this.colCount = Math.max(1, Math.floor((usable + gap) / (minItem + gap)));
    this.itemWidth = (usable - gap * (this.colCount - 1)) / this.colCount;
    this.rowHeight = this.itemWidth + INFO_HEIGHT + gap;
    this._poolCap = Math.max(8, this.colCount * 2);

    const rows = Math.ceil(this.items.length / this.colCount);
    const totalH = rows > 0 ? rows * this.rowHeight - gap + 2 * padding : 0;
    this.inner.style.height = `${totalH}px`;

    // Flush stale nodes — surviving nodes carry old absolute positions from previous layout
    this._nodes.clear();
    this._pool = [];
    this.inner.replaceChildren();

    this._render();
  }

  _makeNode(i, recycled) {
    const album = this.items[i];
    const { _padding: pad, _gap: gap } = this;
    const col = i % this.colCount;
    const row = Math.floor(i / this.colCount);

    let item, cover, title, meta;
    if (recycled) {
      item  = recycled;
      cover = item.querySelector('.album-cover-thumb');
      title = item.querySelector('.album-item-title');
      meta  = item.querySelector('.album-item-meta');
    } else {
      item  = document.createElement('div');
      const info = document.createElement('div');
      info.className = 'album-item-info';
      cover = document.createElement('img');
      cover.className = 'album-cover-thumb';
      title = document.createElement('div');
      title.className = 'album-item-title';
      meta  = document.createElement('div');
      meta.className = 'album-item-meta';
      info.append(title, meta);
      item.append(cover, info);
    }

    item.className = 'album-item';
    if (selectedAlbum === album) item.classList.add('active');
    item.dataset.albumIdx = i;
    item.style.cssText = `position:absolute;width:${this.itemWidth}px;top:${pad + row * this.rowHeight}px;left:${pad + col * (this.itemWidth + gap)}px`;
    item.setAttribute('role', 'listitem');
    item.setAttribute('tabindex', '0');
    item.setAttribute('aria-label', `${album.name}, ${album.artists}, ${album.year || 'sem data'}`);
    if (!item._keydownBound) {
      item.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.click(); }
      });
      item._keydownBound = true;
    }

    cover.alt = album.name;
    cover.setAttribute('aria-hidden', 'true');
    loadCoverImage(cover, album.cover);
    title.textContent = album.name;
    meta.textContent = `${album.artists} • ${album.year || '∞'}`;

    return item;
  }

  _render() {
    const { _padding: pad, _gap: gap } = this;
    const scrollTop = this.container.scrollTop;
    const viewH = this.container.clientHeight;
    const BUFFER = 2;

    const startRow = Math.max(0, Math.floor((scrollTop - pad) / this.rowHeight) - BUFFER);
    const endRow   = Math.ceil((scrollTop + viewH - pad) / this.rowHeight) + BUFFER;
    const startIdx = startRow * this.colCount;
    const endIdx   = Math.min(this.items.length, endRow * this.colCount);

    // Remove nodes that scrolled out of range — push to free-list for reuse
    for (const [idx, node] of this._nodes) {
      if (idx < startIdx || idx >= endIdx) {
        node.remove();
        this._nodes.delete(idx);
        if (this._pool.length < this._poolCap) this._pool.push(node);
      }
    }

    // Add nodes that scrolled into range — pop from free-list before creating new DOM
    for (let i = startIdx; i < endIdx; i++) {
      if (!this._nodes.has(i)) {
        const node = this._makeNode(i, this._pool.pop());
        this._nodes.set(i, node);
        this.inner.appendChild(node);
      }
    }
  }
}

let virtualGrid = null;

// ── Virtual List (Browse Panel) ───────────────────────────────────────────

class VirtualList {
  constructor(container) {
    this.container = container;
    this.items = [];
    this._nodes = new Map();
    this._pool = [];
    this._selectedValue = null;

    this.inner = document.createElement('div');
    this.inner.className = 'browse-list-inner';
    container.appendChild(this.inner);

    this._render = this._render.bind(this);
    container.addEventListener('scroll', this._render, { passive: true });
    new ResizeObserver(this._render).observe(container);
  }

  get _rowHeight() { return isMobile() ? 44 : 36; }

  setItems(items) {
    this.items = items;
    this._nodes.clear();
    this._pool = [];
    this.inner.replaceChildren();
    this.container.scrollTop = 0;
    this._updateHeight();
    this._render();
  }

  updateItems(items, preserveScroll) {
    const saved = this.container.scrollTop;
    this.items = items;
    this._nodes.clear();
    this._pool = [];
    this.inner.replaceChildren();
    this._updateHeight();
    this._render();
    if (preserveScroll) this.container.scrollTop = saved;
  }

  refresh(selectedValue) {
    this._selectedValue = selectedValue ?? null;
    for (const [idx, node] of this._nodes) {
      const item = this.items[idx];
      const val = item?.fullName ?? item?.name;
      const sel = val === this._selectedValue;
      node.classList.toggle('selected', sel);
      node.setAttribute('aria-selected', String(sel));
    }
  }

  _updateHeight() {
    this.inner.style.height = `${this.items.length * this._rowHeight}px`;
  }

  _render() {
    const rh = this._rowHeight;
    const scrollTop = this.container.scrollTop;
    const viewH = this.container.clientHeight;
    const BUFFER = 4;
    const startIdx = Math.max(0, Math.floor(scrollTop / rh) - BUFFER);
    const endIdx = Math.min(this.items.length, Math.ceil((scrollTop + viewH) / rh) + BUFFER);

    for (const [idx, node] of this._nodes) {
      if (idx < startIdx || idx >= endIdx) {
        node.remove();
        this._nodes.delete(idx);
        if (this._pool.length < 50) this._pool.push(node);
      }
    }
    for (let i = startIdx; i < endIdx; i++) {
      if (!this._nodes.has(i)) {
        const node = this._makeNode(i, this._pool.pop());
        this._nodes.set(i, node);
        this.inner.appendChild(node);
      }
    }
  }

  _makeNode(i, recycled) {
    const item = this.items[i];
    const rh = this._rowHeight;
    const isFlat = !item.type;
    let node, nameEl, countEl;

    if (isFlat && recycled && !recycled.dataset.type) {
      node = recycled;
      nameEl = node.querySelector('.browse-name');
      countEl = node.querySelector('.browse-count');
    } else {
      node = document.createElement('button');
      node.setAttribute('role', 'option');
      if (item.type === 'parent') {
        const t = document.createElement('span');
        t.className = 'browse-toggle'; t.setAttribute('aria-hidden', 'true');
        node.appendChild(t);
      } else if (item.type === 'child') {
        const sp = document.createElement('span');
        sp.className = 'browse-indent'; sp.setAttribute('aria-hidden', 'true');
        node.appendChild(sp);
      }
      nameEl = document.createElement('span'); nameEl.className = 'browse-name';
      countEl = document.createElement('span'); countEl.className = 'browse-count';
      node.append(nameEl, countEl);
    }

    node.className = 'browse-item' + (item.type === 'child' ? ' browse-item--child' : '');
    node.dataset.type = item.type || '';
    node.style.cssText = `top:${i * rh}px`;
    node.dataset.value = item.fullName ?? item.name;

    const toggleEl = node.querySelector('.browse-toggle');
    if (toggleEl) {
      toggleEl.innerHTML = item.expanded
        ? `<svg viewBox="0 0 10 10" width="10" height="10" fill="currentColor" aria-hidden="true"><polygon points="1,3 9,3 5,8"/></svg>`
        : `<svg viewBox="0 0 10 10" width="10" height="10" fill="currentColor" aria-hidden="true"><polygon points="3,1 8,5 3,9"/></svg>`;
    }

    const val = item.fullName ?? item.name;
    const sel = val === this._selectedValue;
    node.classList.toggle('selected', sel);
    node.setAttribute('aria-selected', String(sel));
    nameEl.textContent = item.name;
    countEl.textContent = item.count;
    return node;
  }
}

let virtualBrowseList = null;

// ── Data ──────────────────────────────────────────────────────────────────

function buildAlbums() {
  // Perf opt 2: pre-lowercase strings once here so filterAlbums() avoids repeated .toLowerCase() calls.
  // Before: filterAlbums with search query = ~4 .toLowerCase() calls × N albums per filter.
  // After: 0 .toLowerCase() calls per filter (done once at load time).
  albums = db.albums.map(album => {
    const nameLower    = (album.title  || '').toLowerCase();
    const artistsLower = (album.artist || '').toLowerCase();
    const pathLower    = (album.path   || '').toLowerCase();
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
    const tracks = dedupedTracks.map((track, i) => {
      const file = `${encodeURIComponent(album.path)}/${encodeURIComponent(track.file)}`;
      if (track.duration) durationCache.set(file, track.duration);
      const trackArtist = track.artists || album.artist;
      return {
        title: track.title, num: track.num ?? (i + 1), file,
        album: album.title, artists: trackArtist, year: album.year,
        titleLower: (track.title   || '').toLowerCase(),
        artistsLower: (trackArtist || '').toLowerCase(),
      };
    });
    const genre = genreData?.[album.path.normalize('NFC')] ?? null;
    return {
      name: album.title, artists: album.artist, year: album.year, path: album.path,
      cover: album.has_cover !== false ? `${BASE_URL}/${encodeURIComponent(album.path)}/capa-min.jpg` : null,
      tracks, nameLower, artistsLower, pathLower,
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
  const q = searchQuery.toLowerCase();
  filteredAlbums = albums.filter(album => {
    if (activeArtist && album.artists !== activeArtist) return false;
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

// ── Browse Panel Functions ────────────────────────────────────────────────

function buildArtistList() {
  if (_cachedArtists) return _cachedArtists;
  const map = new Map();
  for (const a of albums) if (a.artists) map.set(a.artists, (map.get(a.artists) || 0) + 1);
  _cachedArtists = [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return _cachedArtists;
}

function buildGenreList() {
  if (_cachedGenres) return _cachedGenres;
  const map = new Map();
  for (const a of albums) if (a.genreParent) map.set(a.genreParent, (map.get(a.genreParent) || 0) + 1);
  _cachedGenres = [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return _cachedGenres;
}

function buildGenreTree() {
  if (_cachedGenreTree) return _cachedGenreTree;
  const tree = new Map();
  for (const a of albums) {
    if (!a.genreParent) continue;
    const sub = a.genre?.includes('---') ? a.genre.split('---')[1] : null;
    if (!tree.has(a.genreParent)) tree.set(a.genreParent, { count: 0, subs: new Map() });
    const entry = tree.get(a.genreParent);
    entry.count++;
    if (sub) entry.subs.set(sub, (entry.subs.get(sub) || 0) + 1);
  }
  _cachedGenreTree = new Map([...tree.entries()].sort((a, b) => b[1].count - a[1].count));
  return _cachedGenreTree;
}

function getGenreDisplayItems() {
  const tree = buildGenreTree();
  const q = browsePanelQuery.toLowerCase();
  const items = [];
  for (const [parent, data] of tree) {
    const parentMatch = !q || parent.toLowerCase().includes(q);
    const matchingSubs = q
      ? [...data.subs.entries()].filter(([sub]) => sub.toLowerCase().includes(q))
      : [];
    if (q && !parentMatch && matchingSubs.length === 0) continue;
    const expanded = q ? (parentMatch || matchingSubs.length > 0) : expandedGenres.has(parent);
    items.push({ name: parent, fullName: parent, count: data.count, type: 'parent', expanded });
    if (expanded) {
      const subsToShow = q && !parentMatch
        ? matchingSubs.sort((a, b) => b[1] - a[1])
        : [...data.subs.entries()].sort((a, b) => b[1] - a[1]);
      for (const [sub, count] of subsToShow) {
        items.push({ name: sub, fullName: `${parent}---${sub}`, count, type: 'child', parentName: parent });
      }
    }
  }
  return items;
}

function getCurrentBrowseItems() {
  const base = browseTab === 'genres' ? buildGenreList() : buildArtistList();
  const hasExternalFilter = !!searchQuery || activeDecade !== null || !!activeYear;
  // No external filter → show full list so the user can always switch artist/genre
  if (!hasExternalFilter) return base;
  // External filter active → recount using only decade/search/year (not the panel selection)
  // so the list stays full and just reflects which artists/genres survive those filters.
  const map = new Map();
  const isGenres = browseTab === 'genres';
  const q = searchQuery.toLowerCase();
  for (const a of albums) {
    const matchesDecade = activeDecade === null ||
      (activeDecade === 'noyear' ? !a.year :
       activeDecade === 'pre1940' ? (a.year > 0 && a.year < 1950) :
       Math.floor(a.year / 10) * 10 === activeDecade);
    if (!matchesDecade) continue;
    if (activeYear && a.year !== activeYear) continue;
    if (searchQuery && !(a.nameLower.includes(q) || a.artistsLower.includes(q) ||
        a.pathLower.includes(q) || a.tracks.some(t => t.titleLower.includes(q) || t.artistsLower.includes(q)))) continue;
    const key = isGenres ? a.genreParent : a.artists;
    if (key) map.set(key, (map.get(key) || 0) + 1);
  }
  return base
    .map(item => ({ name: item.name, count: map.get(item.name) || 0 }))
    .filter(i => i.count > 0);
}

function _applyBrowseItems(items, preserveScroll) {
  if (!virtualBrowseList) return;
  let visible = items;
  if (browsePanelQuery) {
    const q = browsePanelQuery.toLowerCase();
    visible = items.filter(i => i.name.toLowerCase().includes(q));
  }
  if (_browseEmptyEl) _browseEmptyEl.hidden = visible.length > 0;
  const activeVal = browseTab === 'genres' ? activeGenre : activeArtist;
  if (preserveScroll) virtualBrowseList.updateItems(visible, true);
  else virtualBrowseList.setItems(visible);
  virtualBrowseList.refresh(activeVal);
}

function renderBrowsePanel() {
  if (!virtualBrowseList) return;
  if (browseTab === 'genres') {
    const items = getGenreDisplayItems();
    if (_browseEmptyEl) _browseEmptyEl.hidden = items.length > 0;
    virtualBrowseList.setItems(items);
    virtualBrowseList.refresh(activeGenre);
  } else {
    _applyBrowseItems(getCurrentBrowseItems(), false);
  }
}



function refreshBrowseCounts() {
  if (!virtualBrowseList || !_browsePanelEl) return;
  if (_browsePanelEl.classList.contains('collapsed')) return;
  if (browseTab === 'genres') {
    const items = getGenreDisplayItems(); // respects browsePanelQuery
    if (_browseEmptyEl) _browseEmptyEl.hidden = items.length > 0;
    virtualBrowseList.updateItems(items, true);
    virtualBrowseList.refresh(activeGenre);
  } else {
    _applyBrowseItems(getCurrentBrowseItems(), true);
  }
}

function renderActiveFilterChip() {
  if (!_activeFilterChip || !_activeFilterLabel) return;
  const active = activeGenre || activeArtist;
  _activeFilterChip.hidden = !active;
  if (active) {
    _activeFilterLabel.textContent = `${activeGenre ? 'Gênero' : 'Artista'}: ${active}`;
  }
  if (_browseBadgeEl) _browseBadgeEl.hidden = !active;
  document.getElementById('btn-browse')?.classList.toggle('active', !!active);
}

function selectBrowseItem(value, itemType) {
  if (browseTab === 'genres') {
    if (itemType === 'parent') {
      // Toggle expand/collapse; also toggle filter
      if (expandedGenres.has(value)) expandedGenres.delete(value);
      else expandedGenres.add(value);
      activeGenre = activeGenre === value ? null : value;
      activeArtist = null;
    } else {
      // child subgenre or flat
      activeGenre = activeGenre === value ? null : value;
      activeArtist = null;
      if (isMobile()) setTimeout(closeBrowseDrawer, 180);
    }
    updateBrowseFilterInUrl();
    filterAlbums();
    renderBrowsePanel(); // rebuild tree to reflect expand state
  } else {
    activeArtist  = activeArtist === value ? null : value;
    activeGenre   = null;
    updateBrowseFilterInUrl();
    filterAlbums();
    virtualBrowseList?.refresh(activeArtist);
    if (isMobile()) setTimeout(closeBrowseDrawer, 180);
  }
}

function updateBrowseSelection() {
  virtualBrowseList?.refresh(browseTab === 'genres' ? activeGenre : activeArtist);
}

function switchBrowseTab(tab) {
  if (browseTab === tab) return;
  browseTab = tab;
  browsePanelQuery = '';
  if (_browseSearchEl) _browseSearchEl.value = '';
  document.querySelectorAll('.browse-tab').forEach(btn => {
    const isActive = btn.dataset.tab === tab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });
  _browseListEl?.setAttribute('aria-label', tab === 'genres' ? 'Gêneros' : 'Artistas');
  renderBrowsePanel();
}

function openBrowseDrawer() {
  _browsePanelEl?.classList.add('open');
  document.getElementById('browse-scrim')?.classList.add('open');
  document.getElementById('btn-browse')?.setAttribute('aria-expanded', 'true');
  closeMobileDrawer();
}

function closeBrowseDrawer() {
  _browsePanelEl?.classList.remove('open');
  document.getElementById('browse-scrim')?.classList.remove('open');
  document.getElementById('btn-browse')?.setAttribute('aria-expanded', 'false');
}

function toggleBrowsePanel() {
  if (isMobile()) {
    if (_browsePanelEl?.classList.contains('open')) closeBrowseDrawer();
    else openBrowseDrawer();
  } else {
    browseCollapsed = !browseCollapsed;
    _browsePanelEl?.classList.toggle('collapsed', browseCollapsed);
    _browseCollapseBtn?.setAttribute('aria-expanded', String(!browseCollapsed));
    localStorage.setItem('tocador-browse-collapsed', browseCollapsed);
    if (!browseCollapsed) renderBrowsePanel();
  }
}

function toggleTracksPanel() {
  tracksCollapsed = !tracksCollapsed;
  _tracksPanelEl?.classList.toggle('collapsed', tracksCollapsed);
  _tracksCollapseBtn?.setAttribute('aria-expanded', String(!tracksCollapsed));
  localStorage.setItem('tocador-tracks-collapsed', tracksCollapsed);
}

function updateLibraryStats() {
  const totalAlbums = filteredAlbums.length;
  const totalArtists = new Set(filteredAlbums.map(a => a.artists).filter(Boolean)).size;
  u('#mobile-stat-albums').text(`${totalAlbums} álbun${totalAlbums !== 1 ? 's' : ''}`);
  u('#mobile-stat-artists').text(`${totalArtists} artista${totalArtists !== 1 ? 's' : ''}`);
}

function applyArchiveMeta() {
  const meta = db.meta || {};
  const title = meta.title || 'Tocador';
  const subtitle = meta.subtitle || '';
  let hours = meta.hours || '';
  if (!hours && db.albums) {
    const totalSeconds = db.albums.reduce((s, a) => s + (a.tracks || []).reduce((ts, t) => ts + (t.duration || 0), 0), 0);
    if (totalSeconds > 0) hours = Math.round(totalSeconds / 3600).toString();
  }
  const displayTitle = title !== 'Tocador' ? `Tocador / ${title} ♪` : 'Tocador';
  document.title = displayTitle;
  const titleEl = document.getElementById('app-title');
  const subtitleEl = document.getElementById('app-subtitle');
  const hoursEl = document.getElementById('stat-hours');
  if (titleEl) titleEl.textContent = displayTitle;
  if (subtitleEl) subtitleEl.textContent = subtitle;
  if (hoursEl) hoursEl.textContent = hours ? `${hours} horas` : '';
}

// ── Decade Buttons (rendered once on init) ────────────────────────────────

function renderDecadeButtons() {
  const decades = getDecades();
  const container = document.querySelector('#decade-buttons');

  const todosBtn = document.createElement('button');
  todosBtn.className = 'decade-btn active';
  todosBtn.textContent = 'Todos';
  todosBtn.dataset.decade = 'all';
  todosBtn.addEventListener('click', () => {
    activeDecade = null;
    activeYear = 0; updateYearInUrl(0);
    searchQuery = '';
    if (_searchInput) _searchInput.value = '';
    filterAlbums();
    container.querySelectorAll('.decade-btn').forEach(b => b.classList.remove('active'));
    todosBtn.classList.add('active');
  });

  const frag = document.createDocumentFragment();

  frag.append(todosBtn);

  const pre1940Btn = document.createElement('button');
  pre1940Btn.className = 'decade-btn';
  pre1940Btn.textContent = '<1940';
  pre1940Btn.dataset.decade = 'pre1940';
  pre1940Btn.title = '1900–1949';
  pre1940Btn.addEventListener('click', () => {
    activeDecade = 'pre1940';
    activeYear = 0; updateYearInUrl(0);
    searchQuery = '';
    if (_searchInput) _searchInput.value = '';
    filterAlbums();
    container.querySelectorAll('.decade-btn').forEach(b => b.classList.remove('active'));
    pre1940Btn.classList.add('active');
  });
  frag.append(pre1940Btn);

  decades.forEach(decade => {
    const btn = document.createElement('button');
    btn.className = 'decade-btn';
    btn.textContent = `${decade}`;
    btn.dataset.decade = decade;
    btn.title = `${decade}–${decade + 9}`;
    btn.addEventListener('click', () => {
      activeDecade = parseInt(btn.dataset.decade);
      activeYear = 0; updateYearInUrl(0);
      searchQuery = '';
      if (_searchInput) _searchInput.value = '';
      filterAlbums();
      container.querySelectorAll('.decade-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
    frag.append(btn);
  });

  if (albums.some(a => !a.year)) {
    const infBtn = document.createElement('button');
    infBtn.className = 'decade-btn';
    infBtn.textContent = '∞';
    infBtn.dataset.decade = 'noyear';
    infBtn.title = 'Sem data';
    infBtn.addEventListener('click', () => {
      activeDecade = 'noyear';
      activeYear = 0; updateYearInUrl(0);
      searchQuery = '';
      if (_searchInput) _searchInput.value = '';
      filterAlbums();
      container.querySelectorAll('.decade-btn').forEach(b => b.classList.remove('active'));
      infBtn.classList.add('active');
    });
    frag.append(infBtn);
  }

  container.replaceChildren(frag);
}

// ── Track & Album Header Rendering ───────────────────────────────────────

function renderAlbumHeader() {
  const container = u('#album-header').first();
  if (!selectedAlbum) { container.innerHTML = ''; return; }

  const cover = document.createElement('img');
  cover.className = 'album-cover-large';
  cover.alt = selectedAlbum.name;
  cover.loading = 'lazy';
  loadCoverImage(cover, selectedAlbum.cover);

  const info = document.createElement('div');
  info.className = 'album-header-info';
  info.innerHTML = `
    <h2>${selectedAlbum.name}</h2>
    <p><strong>${artistLinksHTML(selectedAlbum.artists)}</strong></p>
    <p><span class="year-link" role="button" tabindex="0" aria-label="Filtrar álbuns de ${selectedAlbum.year}">${selectedAlbum.year}</span> • ${selectedAlbum.tracks.length} canções</p>
  `;

  const yearLinkEl = info.querySelector('.year-link');
  const handleYearClick = () => {
    activeYear = selectedAlbum.year;
    searchQuery = '';
    activeDecade = null;
    if (_searchInput) _searchInput.value = '';
    document.querySelectorAll('.decade-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.decade-btn[data-decade="all"]')?.classList.add('active');
    updateYearInUrl(activeYear);
    filterAlbums();
  };
  yearLinkEl?.addEventListener('click', handleYearClick);
  yearLinkEl?.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleYearClick(); }
  });

  attachArtistHandlers(info);
  container.replaceChildren(cover, info);
}

function updateDurationInDOM(track, idx) {
  const dur = durationCache.get(track.file);
  if (!dur) return;
  const formatted = formatTime(dur);
  document.querySelector(`#track-list [data-track-idx="${idx}"] .track-duration`)?.replaceChildren(document.createTextNode(formatted));
  document.querySelector(`#drawer-track-list [data-track-idx="${idx}"] .track-duration`)?.replaceChildren(document.createTextNode(formatted));
}

function renderTrackList() {
  const container = document.querySelector('#track-list');
  const tracksPanel = u('.tracks-panel').first();

  if (!selectedAlbum) {
    tracksPanel.classList.add('hidden');
    container.replaceChildren();
    renderedAlbum = null;
    return;
  }

  tracksPanel.classList.remove('hidden');

  if (renderedAlbum === selectedAlbum) {
    container.querySelectorAll('[data-track-idx]').forEach(item => {
      const isPlaying = selectedAlbum.tracks[parseInt(item.dataset.trackIdx)] === currentTrack;
      item.classList.toggle('playing', isPlaying);
      item.setAttribute('aria-current', isPlaying ? 'true' : 'false');
    });
    container.querySelector('.track-item.playing')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return;
  }

  tracksPanel.scrollTop = 0;
  const frag = document.createDocumentFragment();

  selectedAlbum.tracks.forEach((track, idx) => {
    const item = document.createElement('li');
    item.className = 'track-item';
    item.dataset.trackIdx = idx;
    item.setAttribute('tabindex', '0');
    item.setAttribute('aria-label', `Faixa ${track.num}: ${track.title}`);
    if (currentTrack === track) { item.classList.add('playing'); item.setAttribute('aria-current', 'true'); }

    const artistName = track.artists && track.artists !== selectedAlbum.artists ? track.artists : '';
    const artistLabel = artistName ? `<div class="track-artist">${artistLinksHTML(artistName)}</div>` : '';
    const dur = durationCache.has(track.file) ? formatTime(durationCache.get(track.file)) : '-';
    item.innerHTML = `
      <span class="track-num" aria-hidden="true">${track.num}</span>
      <div class="track-details">
        <div class="track-title">${track.title}</div>
        ${artistLabel}
      </div>
      <span class="track-duration" aria-label="Duração: ${dur}">${dur}</span>
    `;
    item.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.click(); }
    });
    if (artistName) attachArtistHandlers(item);
    frag.append(item);
  });

  container.replaceChildren(frag);
  renderedAlbum = selectedAlbum;
  container.querySelector('.track-item.playing')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}


// ── Playback ──────────────────────────────────────────────────────────────

function safePlay(audio) {
  const p = audio.play();
  if (p?.catch) p.catch(err => {
    if (err.name === 'NotAllowedError') {
      (_btnPlay ??= document.getElementById('btn-play'))?.classList.add('autoplay-blocked');
    } else if (err.name === 'NotSupportedError') {
      showToast('Arquivo não suportado ou indisponível', 4000);
    } else if (err.name !== 'AbortError') {
      showToast(`Erro ao reproduzir: ${err.message}`, 4000);
    }
  });
}

function playTrack(track) {
  currentTrack = track;
  updateNowPlaying();
  const audio = u('#audio').first();
  const newSrc = `${BASE_URL}/${track.file}`;
  if (audio.src !== newSrc) { audio.src = newSrc; audio.load(); }
  safePlay(audio);
  u('#btn-play').addClass('playing');
  renderTrackList();
  syncDrawerPlayingState();
  updateTrackInUrl(track.num);
}

function renderMobileDrawer(album) {
  const titleEl = document.getElementById('drawer-album-title');
  const metaEl  = document.getElementById('drawer-album-meta');
  _drawerCover ??= document.getElementById('drawer-cover');
  const coverEl = _drawerCover;
  const listEl  = document.getElementById('drawer-track-list');

  if (!album) {
    if (titleEl) titleEl.textContent = '';
    if (metaEl)  metaEl.textContent  = '';
    if (listEl)  listEl.replaceChildren();
    return;
  }

  if (titleEl) titleEl.textContent = album.name;
  if (metaEl)  metaEl.textContent  = `${album.artists} · ${album.year} · ${album.tracks.length} faixas`;
  if (coverEl) loadCoverImage(coverEl, album.cover);
  if (!listEl) return;

  const frag = document.createDocumentFragment();
  album.tracks.forEach((track, idx) => {
    const item = document.createElement('li');
    item.className = 'track-item';
    item.dataset.trackIdx = idx;
    item.setAttribute('tabindex', '0');
    item.setAttribute('aria-label', `Faixa ${track.num}: ${track.title}`);
    if (currentTrack === track) { item.classList.add('playing'); item.setAttribute('aria-current', 'true'); }

    const artistName = track.artists && track.artists !== album.artists ? track.artists : '';
    const artistLabel = artistName ? `<div class="track-artist">${artistLinksHTML(artistName)}</div>` : '';
    const dur = durationCache.has(track.file) ? formatTime(durationCache.get(track.file)) : '-';
    item.innerHTML = `
      <span class="track-num" aria-hidden="true">${track.num}</span>
      <div class="track-details">
        <div class="track-title">${track.title}</div>
        ${artistLabel}
      </div>
      <span class="track-duration" aria-label="Duração: ${dur}">${dur}</span>
    `;
    item.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.click(); }
    });
    if (artistName) attachArtistHandlers(item);
    frag.append(item);
  });

  listEl.replaceChildren(frag);
}

function syncDrawerPlayingState() {
  const listEl = document.getElementById('drawer-track-list');
  if (!listEl || !selectedAlbum) return;
  listEl.querySelectorAll('[data-track-idx]').forEach(item => {
    const track = selectedAlbum.tracks[parseInt(item.dataset.trackIdx)];
    item.classList.toggle('playing', track === currentTrack);
    if (track === currentTrack) item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

function updateNowPlaying() {
  if (!currentTrack) return;
  u('#player-title').text(currentTrack.title);
  u('#player-artist').text(currentTrack.artists);
  const folder = currentTrack.file.split('/')[0];
  const coverUrl = `${BASE_URL}/${folder}/capa-min.jpg`;
  const coverImg = u('#player-cover').first();
  const coverAlt = currentTrack.album ? `Capa do álbum ${currentTrack.album}` : 'Capa do álbum';
  if (coverImg) { coverImg.loading = 'lazy'; coverImg.alt = coverAlt; loadCoverImage(coverImg, coverUrl); }
  _drawerCover ??= document.getElementById('drawer-cover');
  if (_drawerCover) { _drawerCover.alt = coverAlt; loadCoverImage(_drawerCover, coverUrl); }
  // Overlay
  _overlayCover ??= document.getElementById('overlay-cover');
  if (_overlayCover) { _overlayCover.alt = coverAlt; loadCoverImage(_overlayCover, coverUrl); }

  // Update aria-live now-playing status
  const statusEl = document.getElementById('now-playing-status');
  if (statusEl) statusEl.textContent = `Reproduzindo: ${currentTrack.title} — ${currentTrack.artists}`;
  _overlayTrackTitle ??= document.getElementById('overlay-track-title');
  if (_overlayTrackTitle) _overlayTrackTitle.textContent = currentTrack.title;
  _overlayTrackArtist ??= document.getElementById('overlay-track-artist');
  if (_overlayTrackArtist) _overlayTrackArtist.textContent = currentTrack.artists;

  // Media Session
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack.title,
      artist: currentTrack.artists,
      album: currentTrack.album || '',
      artwork: [{ src: coverUrl, sizes: '200x200', type: 'image/jpeg' }]
    });
  }

  _playerTitleEl ??= document.getElementById('player-title');
  checkMarquee(_playerTitleEl);
  _overlayTrackTitle ??= document.getElementById('overlay-track-title');
  checkMarquee(_overlayTrackTitle);
}

function playNext() {
  if (shuffleOn) {
    if (!albums.length) return;
    // Avoid flatMap allocation: pick a random album (weighted by track count), then a random track.
    // Falls back to retry if the single track selected is currentTrack (rare; at most 1 retry).
    let nextAlbum, track;
    const totalTracks = albums.reduce((s, a) => s + a.tracks.length, 0);
    if (totalTracks <= 1) return;
    let attempts = 0;
    do {
      let r = Math.floor(Math.random() * totalTracks);
      for (let ai = 0; ai < albums.length; ai++) {
        const tlen = albums[ai].tracks.length;
        if (r < tlen) { nextAlbum = albums[ai]; track = albums[ai].tracks[r]; break; }
        r -= tlen;
      }
      attempts++;
    } while (track === currentTrack && attempts < 3);
    if (track === currentTrack) return;
    if (nextAlbum !== selectedAlbum) {
      selectedAlbum = nextAlbum;
      renderedAlbum = null;
      renderAlbumHeader();
      renderTrackList();
      renderMobileDrawer(nextAlbum);
      virtualGrid.refresh();
      updateMetaTags(nextAlbum);
      window.history.pushState({ album: nextAlbum.path }, '', generateAlbumUrl(nextAlbum));
    }
    playTrack(track);
    return;
  }
  if (!selectedAlbum || !currentTrack) return;
  const tracks = selectedAlbum.tracks;
  const idx = tracks.indexOf(currentTrack);
  if (idx < tracks.length - 1) {
    playTrack(tracks[idx + 1]);
  } else if (repeatMode === 'all') {
    playTrack(tracks[0]);
  }
}

function playPrevious() {
  if (!selectedAlbum || !currentTrack) return;
  const idx = selectedAlbum.tracks.indexOf(currentTrack);
  if (idx > 0) playTrack(selectedAlbum.tracks[idx - 1]);
}

// ── Init ──────────────────────────────────────────────────────────────────

u(document).on('DOMContentLoaded', async function () {
  const albumsList = document.querySelector('#albums-list');

  // Delegated click: album grid
  albumsList.addEventListener('click', e => {
    const item = e.target.closest('[data-album-idx]');
    if (!item) return;
    const album = filteredAlbums[parseInt(item.dataset.albumIdx)];
    if (!album || selectedAlbum === album) return;

    albumsList.querySelector('.album-item.active')?.classList.remove('active');
    item.classList.add('active');

    selectedAlbum = album;
    renderedAlbum = null;
    renderAlbumHeader();
    renderTrackList();
    renderMobileDrawer(album);
    if (isMobile()) openMobileDrawer();

    if (album.tracks.length > 0) {
      const audio = u('#audio').first();
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
    const path = e.state?.album ?? new URLSearchParams(window.location.search).get('album');
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
  const acervoParam = new URLSearchParams(location.search).get('acervo');
  if (acervoParam) {
    const entry = KNOWN_ACERVOS[acervoParam];
    sessionStorage.setItem('acervo', entry ? entry.data : decodeURIComponent(acervoParam));
    if (entry?.base_url) sessionStorage.setItem('acervo-base', entry.base_url);
  }
  let defaultKey = DEFAULT_ACERVO;
  let cfg = {};
  try {
    cfg = await trackedFetch('config.json').then(r => r.ok ? r.json() : {});
    if (cfg.acervo && KNOWN_ACERVOS[cfg.acervo]) defaultKey = cfg.acervo;
  } catch {}
  const defaultEntry = KNOWN_ACERVOS[defaultKey];
  const dataUrl = sessionStorage.getItem('acervo') || cfg.dataUrl || defaultEntry.data;
  const activeAcervoKey = (acervoParam && KNOWN_ACERVOS[acervoParam]) ? acervoParam : defaultKey;
  const genresUrl = KNOWN_ACERVOS[activeAcervoKey]?.genres ?? null;

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
  db = JSON.parse(json);
  genreData = genresRaw;
  genreLoading = false;
  BASE_URL = db.meta?.base_url || cfg.baseUrl || sessionStorage.getItem('acervo-base') || defaultEntry.base_url || '';
  const btn3d = document.getElementById('btn-3d');
  if (btn3d) btn3d.href = `./3d.html?acervo=${encodeURIComponent(acervoParam || defaultKey)}`;
  skeletonEl.remove();
  applyArchiveMeta();

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
  _browseCollapseBtn = document.getElementById('browse-collapse');
  _browseBadgeEl    = document.getElementById('browse-badge');
  _activeFilterChip = document.getElementById('active-filter-chip');
  _activeFilterLabel = document.getElementById('active-filter-label');
  _tracksPanelEl    = document.getElementById('tracks-panel');
  _tracksCollapseBtn = document.getElementById('tracks-collapse');
  if (tracksCollapsed) {
    _tracksPanelEl?.classList.add('collapsed');
    _tracksCollapseBtn?.setAttribute('aria-expanded', 'false');
  }

  buildAlbums();
  filteredAlbums = [...albums];
  renderDecadeButtons();
  virtualGrid.setItems(filteredAlbums);
  updateLibraryStats();

  // Init browse panel VirtualList and apply initial state
  if (_browseListEl) {
    virtualBrowseList = new VirtualList(_browseListEl);
    if (browseCollapsed && !isMobile()) {
      _browsePanelEl?.classList.add('collapsed');
      _browseCollapseBtn?.setAttribute('aria-expanded', 'false');
    }
    // Enable/disable Genres tab based on genreData availability
    const genresTabBtn = document.querySelector('.browse-tab[data-tab="genres"]');
    if (genresTabBtn) {
      if (genreData) {
        genresTabBtn.disabled = false;
        genresTabBtn.title = '';
      } else if (genreLoading) {
        genresTabBtn.classList.add('loading');
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
  if (!albumToSelect && filteredAlbums.length > 0) albumToSelect = filteredAlbums[0];

  if (albumToSelect) {
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
        const audio = u('#audio').first();
        const newSrc = `${BASE_URL}/${t.file}`;
        if (audio.src !== newSrc) { audio.src = newSrc; audio.load(); }
        if (getPlayFromUrl()) safePlay(audio);
      }
    } else if (getPlayFromUrl() && albumToSelect.tracks.length > 0) {
      playTrack(albumToSelect.tracks[0]);
    }
    renderTrackList();
    renderMobileDrawer(albumToSelect);
    if (albumFromUrl && isMobile()) openMobileDrawer();
    updateMetaTags(albumToSelect);
    window.history.replaceState({ album: albumToSelect.path, t: trackNumFromUrl || null }, '', generateAlbumUrl(albumToSelect, trackNumFromUrl || null));
  }

  const playerCover = u('#player-cover').first();
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

  const audio = u('#audio').first();

  const overlayBtnPlay = document.getElementById('overlay-btn-play');
  const setLoading = on => {
    _btnPlay?.classList.toggle('loading', on);
    overlayBtnPlay?.classList.toggle('loading', on);
  };

  audio.addEventListener('play',     () => {
    u('#btn-play').addClass('playing');
    overlayBtnPlay?.classList.add('playing');
    _btnPlay?.classList.remove('autoplay-blocked');
    _btnPlay?.setAttribute('aria-label', 'Pausar');
    overlayBtnPlay?.setAttribute('aria-label', 'Pausar');
  });
  audio.addEventListener('pause',    () => {
    u('#btn-play').removeClass('playing');
    overlayBtnPlay?.classList.remove('playing');
    _btnPlay?.setAttribute('aria-label', 'Reproduzir');
    overlayBtnPlay?.setAttribute('aria-label', 'Reproduzir');
  });
  audio.addEventListener('waiting',  () => setLoading(true));
  audio.addEventListener('stalled',  () => setLoading(true));
  audio.addEventListener('canplay',  () => setLoading(false));
  audio.addEventListener('playing',  () => setLoading(false));
  audio.addEventListener('error', () => {
    setLoading(false);
    if (currentTrack) {
      showToast('Erro ao carregar áudio — pulando...');
      setTimeout(playNext, 1500);
    }
  });

  const progressFill = document.querySelector('#progress-fill');
  const mainProgressBar = document.getElementById('main-progress-bar');
  const overlayProgressFill = document.getElementById('overlay-progress-fill');
  const overlayTimeCurrent = document.getElementById('overlay-time-current');
  const overlayTimeDuration = document.getElementById('overlay-time-duration');

  audio.addEventListener('timeupdate', () => {
    const percent = (audio.currentTime / audio.duration) * 100 || 0;
    const cur = formatTime(audio.currentTime);
    progressFill.style.width = percent + '%';
    mainProgressBar.classList.toggle('has-progress', percent > 0);
    mainProgressBar.setAttribute('aria-valuenow', Math.round(percent));
    u('#time-current').text(cur);
    if (overlayProgressFill) overlayProgressFill.style.width = percent + '%';
    if (overlayTimeCurrent) overlayTimeCurrent.textContent = cur;
    if ('mediaSession' in navigator && audio.duration && !isNaN(audio.duration)) {
      try { navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate, position: audio.currentTime }); } catch (_) {}
    }
  });

  audio.addEventListener('loadedmetadata', () => {
    const dur = formatTime(audio.duration);
    u('#time-duration').text(dur);
    if (overlayTimeDuration) overlayTimeDuration.textContent = dur;
    if (currentTrack) {
      durationCache.set(currentTrack.file, audio.duration);
      if (selectedAlbum) {
        const idx = selectedAlbum.tracks.indexOf(currentTrack);
        if (idx >= 0) updateDurationInDOM(currentTrack, idx);
      }
    }
  });

  audio.addEventListener('ended', playNext);

  // Singleton player across tabs: pause this tab when another tab starts playing
  if (typeof BroadcastChannel !== 'undefined') {
    const TAB_ID = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
    const playerChannel = new BroadcastChannel('tocador-player');
    audio.addEventListener('play', () => playerChannel.postMessage({ tabId: TAB_ID }));
    playerChannel.onmessage = ({ data }) => {
      if (data?.tabId !== TAB_ID) audio.pause();
    };
  }

  u('#btn-play').on('click', function () {
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
        u('#btn-play').addClass('playing');
      }
    } else {
      if (selectedAlbum && currentTrack && !selectedAlbum.tracks.includes(currentTrack)) {
        playTrack(selectedAlbum.tracks[0]);
      } else {
        audio.pause();
      }
    }
  });

  u('#btn-prev').on('click', playPrevious);
  u('#btn-next').on('click', playNext);

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

  // Restore persisted state
  applyShuffle(localStorage.getItem('tocador-shuffle') === 'true');
  applyRepeatMode(localStorage.getItem('tocador-repeat') || 'off');
  const savedVolume = parseFloat(localStorage.getItem('tocador-volume') ?? '1');
  if (volumeSlider) volumeSlider.value = savedVolume;
  audio.volume = savedVolume;
  if (savedVolume === 0 && _volumeWave) _volumeWave.style.display = 'none';

  btnShuffle?.addEventListener('click', () => applyShuffle(!shuffleOn));
  btnShuffleMobile?.addEventListener('click', () => applyShuffle(!shuffleOn));

  btnRepeat?.addEventListener('click', () => {
    applyRepeatMode(repeatMode === 'off' ? 'one' : repeatMode === 'one' ? 'all' : 'off');
  });

  volumeSlider?.addEventListener('input', () => {
    const vol = parseFloat(volumeSlider.value);
    audio.volume = vol;
    if (_volumeWave) _volumeWave.style.display = vol === 0 ? 'none' : '';
    localStorage.setItem('tocador-volume', vol);
  });

  function seekFromClient(clientX, barEl) {
    if (!audio.duration) return;
    const rect = barEl.getBoundingClientRect();
    audio.currentTime = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * audio.duration;
  }

  [mainProgressBar, overlayProgressBar].forEach(bar => {
    if (!bar) return;
    bar.addEventListener('click', e => seekFromClient(e.clientX, bar));
    bar.addEventListener('touchstart', e => { e.preventDefault(); seekFromClient(e.touches[0].clientX, bar); }, { passive: false });
    bar.addEventListener('touchmove',  e => { e.preventDefault(); seekFromClient(e.touches[0].clientX, bar); }, { passive: false });
  });

  if (_playerTitleEl && window.ResizeObserver) {
    new ResizeObserver(() => {
      if (currentTrack) checkMarquee(_playerTitleEl);
    }).observe(_playerTitleEl.closest('.player-info'));
  }

  let searchDebounce;
  u('#search-input').on('input', function () {
    searchQuery = this.value;
    if (searchQuery) {
      activeDecade = null;
      activeYear = 0; updateYearInUrl(0);
      document.querySelectorAll('.decade-btn').forEach(b => b.classList.remove('active'));
      document.querySelector('.decade-btn[data-decade="all"]')?.classList.add('active');
    }
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
  document.getElementById('empty-clear-btn')?.addEventListener('click', () => {
    clearSearch();
    activeGenre = null; activeArtist = null;
    updateBrowseFilterInUrl();
    filterAlbums();
    updateBrowseSelection();
  });

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

  // Collapse toggles (desktop)
  _browseCollapseBtn?.addEventListener('click', toggleBrowsePanel);
  _tracksCollapseBtn?.addEventListener('click', toggleTracksPanel);

  // Mobile trigger button
  document.getElementById('btn-browse')?.addEventListener('click', openBrowseDrawer);

  // Scrim tap to close
  document.getElementById('browse-scrim')?.addEventListener('click', closeBrowseDrawer);

  // Active-filter chip clear
  document.getElementById('active-filter-clear')?.addEventListener('click', () => {
    activeGenre = null; activeArtist = null;
    updateBrowseFilterInUrl();
    filterAlbums();
    updateBrowseSelection();
  });

  document.addEventListener('keydown', e => {
    // Escape: close mobile browse drawer OR clear active panel filter
    if (e.key === 'Escape') {
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
      case 'g':
        if (!e.metaKey && !e.ctrlKey && !e.altKey && genreData) {
          if (!isMobile() && browseCollapsed) toggleBrowsePanel();
          else if (isMobile()) openBrowseDrawer();
          switchBrowseTab('genres');
        }
        break;
    }
  });
});
