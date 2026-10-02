// Browse panel (artists/genres), filter chips, shortcuts modal, acervo switcher.
// Classic script: shares ui.js's global scope (state lives at the top of ui.js).
// Loaded after ui.js; everything here runs at call time, after DOMContentLoaded.

// ── Browse Panel Functions ────────────────────────────────────────────────

function buildArtistList() {
  if (_cachedArtists) return _cachedArtists;
  // Count albums per individual artist. Artist strings may be "; "-separated.
  // Set-based deduplication prevents double-counting the same album.
  const key = fold;
  // map: fold-key → { canonical name (mixed-case preferred), Set<album.path> }
  const map = new Map();
  const add = (name, path) => {
    const k = key(name);
    if (!map.has(k)) map.set(k, { name, paths: new Set() });
    const entry = map.get(k);
    const hasDiacritics = s => s !== fold(s);
    // prefer mixed-case over all-uppercase, then accented over plain ASCII
    if (entry.name === entry.name.toUpperCase() && name !== name.toUpperCase()) entry.name = name;
    else if (!hasDiacritics(entry.name) && hasDiacritics(name)) entry.name = name;
    entry.paths.add(path);
  };
  for (const a of albums) {
    if (a.artists) for (const ar of parseArtists(a.artists)) add(ar, a.path);
    for (const t of a.tracks) if (t.artists) for (const ar of parseArtists(t.artists)) add(ar, a.path);
  }
  _cachedArtists = [...map.values()]
    .map(({ name, paths }) => ({ name, count: paths.size }))
    .sort((a, b) => {
      const aLetter = /^\p{L}/u.test(a.name);
      const bLetter = /^\p{L}/u.test(b.name);
      if (aLetter !== bLetter) return aLetter ? -1 : 1;
      return PT_COLLATOR.compare(a.name, b.name);
    });
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
  const q = fold(browsePanelQuery);
  const items = [];
  for (const [parent, data] of tree) {
    const parentMatch = !q || fold(parent).includes(q);
    const matchingSubs = q
      ? [...data.subs.entries()].filter(([sub]) => fold(sub).includes(q))
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
  return browseTab === 'genres' ? buildGenreList() : buildArtistList();
}

function _updateBrowseCountUI(count) {
  if (_browseCountEl) {
    _browseCountEl.textContent = count;
    _browseCountEl.classList.toggle('visible', !!browsePanelQuery);
  }
  if (_browseClearBtn) _browseClearBtn.classList.toggle('visible', !!browsePanelQuery);
}

function _applyBrowseItems(items, preserveScroll) {
  if (!virtualBrowseList) return;
  let visible = items;
  if (browsePanelQuery) {
    const q = fold(browsePanelQuery);
    visible = items.filter(i => fold(i.name).includes(q));
  }
  if (_browseEmptyEl) _browseEmptyEl.hidden = visible.length > 0;
  _updateBrowseCountUI(visible.length);
  const activeVal = browseTab === 'genres' ? activeGenre : activeArtist;
  if (preserveScroll) virtualBrowseList.updateItems(visible, true);
  else virtualBrowseList.setItems(visible);
  virtualBrowseList.refresh(activeVal);
}

// Os gêneros vêm do áudio (modelo treinado com o Discogs), não de etiqueta: a aba avisa disso.
function renderGenreNote() {
  const note = document.getElementById('browse-genre-note');
  if (note) note.hidden = browseTab !== 'genres';
}

// Gênero escolhido: as faixas do álbum que não se encaixam ficam apagadas (como na Pegada). A faixa se encaixa quando
// o gênero (ou, no pai, algum filho) está entre os 3 melhores palpites dela — a mesma conta que elege o gênero do álbum
// em script/build-genre-index.js. Precisa das features por faixa; sem elas o gênero filtra só álbuns.
let _genreTrackFilter = null;
function syncGenreTrackFilter() {
  if (!activeGenre) {
    if (_genreTrackFilter && trackFilter === _genreTrackFilter) {
      trackFilter = null;
      trackFilterInfo = null;
      if (typeof _exRefazerFaixas === 'function') _exRefazerFaixas();
    }
    _genreTrackFilter = null;
    return;
  }
  const g = activeGenre;
  if (typeof _exCarregar !== 'function') return;
  _exCarregar().then(d => {
    if (!d || activeGenre !== g) return;
    const f = d.f, filho = g.includes('---');
    const fn = t => {
      const r = t.src?._row;
      if (r === undefined || !f.has(r)) return false;
      return f.genre(r).some(x => (filho ? x.name === g : x.name.startsWith(g + '---')));
    };
    _genreTrackFilter = fn;
    trackFilter = fn;
    trackFilterInfo = {
      frase: 'combinam com o gênero escolhido',
      titulo: 'Fora do gênero escolhido: não toca',
      limpar: clearAllFilters,
    };
    if (typeof _exRefazerFaixas === 'function') _exRefazerFaixas();
  });
}

function renderBrowsePanel() {
  renderGenreNote();
  if (!virtualBrowseList) return;
  if (browseTab === 'genres') {
    const items = getGenreDisplayItems();
    if (_browseEmptyEl) _browseEmptyEl.hidden = items.length > 0;
    _updateBrowseCountUI(items.length);
    virtualBrowseList.updateItems(items, true);
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
    _updateBrowseCountUI(items.length);
    virtualBrowseList.updateItems(items, true);
    virtualBrowseList.refresh(activeGenre);
  } else {
    _applyBrowseItems(getCurrentBrowseItems(), true);
  }
}

// Name of the single live facet, or null when nothing is filtering. Exactly
// one can be set at a time — see resetFacets() — so the order here is only for
// determinism, not precedence.
//
// searchQuery deliberately returns null: the chip sits right beside the search
// input, which already shows the query and carries its own ✕. Showing a chip
// too put two clear buttons side by side saying the same thing. The chip
// exists for facets whose own control is somewhere else — a decade that has
// scrolled out of the strip on mobile, or an artist/genre picked in a drawer
// that is now closed.
function activeFilterLabel() {
  if (activeAlbumSet) return activeAlbumSetLabel || 'Características';
  if (activeArtist) return activeArtist;
  if (activeGenre)  return activeGenre.includes('---') ? activeGenre.split('---')[1] : activeGenre;
  if (activeYear)   return String(activeYear);
  if (activeDecade !== null) {
    if (activeDecade === 'pre1940') return 'Antes de 1940';
    if (activeDecade === 'noyear')  return 'Sem data';
    return `Anos ${activeDecade}`;
  }
  return null;
}

function renderActiveFilterChip() {
  // The chip below says *what* is filtering; this highlight says *where* to
  // change it. A dot badge used to sit on this same button under this same
  // condition — with the chip a few pixels away naming the selection, it was
  // a second, less informative copy of the highlight, so it's gone.
  document.getElementById('btn-browse')?.classList.toggle('active', !!(activeGenre || activeArtist));

  _clearAllBtn ??= document.getElementById('clear-all-filters');
  _clearAllLabel ??= document.getElementById('clear-all-label');
  const label = activeFilterLabel();
  if (_clearAllLabel && label) _clearAllLabel.textContent = label;
  if (_clearAllBtn) {
    _clearAllBtn.hidden = !label;
    if (label) _clearAllBtn.title = `Limpar filtro: ${label}`;
  }
}

// The six filter facets (search, decade, year, artist, genre, audio features) are mutually
// exclusive: choosing one resets the other four. Cumulative filtering let a
// stale facet silently empty the grid — picking an artist while a search was
// still live returned zero albums with no visible reason why.
//
// `keep` names the facet the caller is about to set; every other facet is
// cleared along with its URL param and its chrome. This only ever clears, so
// callers assign their own facet afterwards. Omit `keep` to clear all five.
function resetFacets(keep) {
  if (keep !== 'features') {
    activeAlbumSet = null;
    activeAlbumSetLabel = '';
    if (typeof explorarReset === 'function') explorarReset();   // também cancela um filtro ainda no debounce
  }
  if (keep !== 'search' && searchQuery) {
    searchQuery = '';
    if (_searchInput) _searchInput.value = '';
    updateQueryInUrl('', false);
  }
  if (keep !== 'decade' && activeDecade !== null) {
    activeDecade = null;
    document.querySelectorAll('.decade-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.decade-btn[data-decade="all"]')?.classList.add('active');
  }
  if (keep !== 'year' && activeYear) {
    activeYear = 0;
    updateYearInUrl(0);
  }
  if ((keep !== 'artist' && activeArtist) || (keep !== 'genre' && activeGenre)) {
    if (keep !== 'artist') activeArtist = null;
    if (keep !== 'genre')  activeGenre  = null;
    updateBrowseFilterInUrl();
    updateBrowseSelection();
  }
}

// Used by the empty-state clear button and the always-visible "clear all" chip.
function clearAllFilters() {
  resetFacets();
  filterAlbums();
}

function selectBrowseItem(value, itemType) {
  resetFacets(browseTab === 'genres' ? 'genre' : 'artist');
  if (browseTab === 'genres') {
    if (itemType === 'parent') {
      // Toggle expand/collapse; also toggle filter
      if (expandedGenres.has(value)) expandedGenres.delete(value);
      else expandedGenres.add(value);
      activeGenre = activeGenre === value ? null : value;
    } else {
      // child subgenre or flat
      activeGenre = activeGenre === value ? null : value;
      if (isMobile()) setTimeout(closeBrowseDrawer, 180);
    }
    updateBrowseFilterInUrl();
    filterAlbums();
    renderBrowsePanel(); // rebuild tree to reflect expand state
  } else {
    activeArtist  = activeArtist === value ? null : value;
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
  _updateBrowseCountUI(0);
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
  if (_browsePanelEl?.classList.contains('open')) closeBrowseDrawer();
  else openBrowseDrawer();
}

// The modal declares aria-modal="true", which promises the rest of the page is
// inert while it is up. Without focus handling that promise is false: Tab walks
// straight out into the album grid behind the scrim. Move focus in on open, keep
// it inside, and hand it back to whatever opened the modal on close.
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
let _shortcutsReturnFocus = null;

function _trapShortcutsTab(e) {
  if (e.key !== 'Tab') return;
  const modal = document.getElementById('shortcuts-modal');
  if (!modal) return;
  const items = [...modal.querySelectorAll(FOCUSABLE)].filter(el => !el.disabled && el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  // activeElement can sit outside the modal if focus was moved programmatically;
  // wrapping on both edges keeps it corralled either way.
  if (e.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
    e.preventDefault(); last.focus();
  } else if (!e.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
    e.preventDefault(); first.focus();
  }
}

function openShortcutsModal() {
  const modal = document.getElementById('shortcuts-modal');
  _shortcutsReturnFocus = document.activeElement;
  modal?.classList.add('open');
  document.getElementById('shortcuts-scrim')?.classList.add('open');
  document.getElementById('shortcuts-close')?.focus();
  document.addEventListener('keydown', _trapShortcutsTab, true);
}

function closeShortcutsModal() {
  document.getElementById('shortcuts-modal')?.classList.remove('open');
  document.getElementById('shortcuts-scrim')?.classList.remove('open');
  document.removeEventListener('keydown', _trapShortcutsTab, true);
  // Only restore if the opener is still in the document and focusable.
  if (_shortcutsReturnFocus?.isConnected) _shortcutsReturnFocus.focus();
  _shortcutsReturnFocus = null;
}

function isShortcutsModalOpen() {
  return !!document.getElementById('shortcuts-modal')?.classList.contains('open');
}

function updateLibraryStats() {
  const totalAlbums = filteredAlbums.length;
  const totalArtists = new Set(filteredAlbums.map(a => a.artists).filter(Boolean)).size;
  const albumsStatEl = document.getElementById('mobile-stat-albums');
  const artistsStatEl = document.getElementById('mobile-stat-artists');
  if (albumsStatEl) albumsStatEl.textContent = `${totalAlbums} álbun${totalAlbums !== 1 ? 's' : ''}`;
  if (artistsStatEl) artistsStatEl.textContent = `${totalArtists} artista${totalArtists !== 1 ? 's' : ''}`;
}

// Which KNOWN_ACERVOS entry is loaded. The ?acervo= alias is only present right
// after a switch, so fall back to matching the data URL's basename (the uqt Pages
// deploy pins a *relative* dataUrl in config.json) and then the base_url baked into
// the payload. Returns null for a third-party acervo passed as a full URL.
function resolveAcervoKey(dataUrl, param) {
  if (param && KNOWN_ACERVOS[param]) return param;
  const file = (dataUrl || '').split('?')[0].split('/').pop();
  for (const [key, entry] of Object.entries(KNOWN_ACERVOS)) {
    if (file && entry.data.split('/').pop() === file) return key;
  }
  const base = db?.meta?.base_url;
  if (base) {
    for (const [key, entry] of Object.entries(KNOWN_ACERVOS)) {
      if (entry.base_url === base) return key;
    }
  }
  return null;
}

// Acervo switcher at the foot of the browse panel. Switching reloads the page:
// albums, indexes, the virtual grid, BASE_URL and the genre data are all built
// once at boot, and a bare ?acervo= correctly drops any album/artist deep link
// pointing at the archive we're leaving.
function renderAcervoSelect(activeKey) {
  // One switcher per side panel (navegação e Explorar), same options and behavior.
  for (const select of document.querySelectorAll('.acervo-select')) {
    const frag = document.createDocumentFragment();
    if (!activeKey) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = db?.meta?.title || 'Acervo externo';
      frag.append(opt);
    }
    for (const [key, entry] of Object.entries(KNOWN_ACERVOS)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = entry.label || key;
      frag.append(opt);
    }
    select.replaceChildren(frag);
    select.value = activeKey || '';
    select.addEventListener('change', () => {
      const key = select.value;
      if (!KNOWN_ACERVOS[key]) return;
      location.href = `${APP_ROOT}?acervo=${encodeURIComponent(key)}`;
    });
  }
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
  const titleAcervoEl = document.getElementById('app-title-acervo');
  const subtitleEl = document.getElementById('app-subtitle');
  const hoursEl = document.getElementById('stat-hours');
  if (titleAcervoEl) titleAcervoEl.textContent = title !== 'Tocador' ? ` ♪ ${title}` : '';
  // Tab title: the archive until an album is opened, then artist · album.
  document.title = `♪ Tocador · ${title}`;
  if (subtitleEl) subtitleEl.textContent = subtitle;
  if (hoursEl) hoursEl.textContent = hours ? `${hours} horas` : '';
}
