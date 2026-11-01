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
  const add = (name, path, cover) => {
    const k = key(name);
    if (!map.has(k)) map.set(k, { name, paths: new Set(), cover: null });
    const entry = map.get(k);
    entry.cover ??= cover;
    const hasDiacritics = s => s !== fold(s);
    // prefer mixed-case over all-uppercase, then accented over plain ASCII
    if (entry.name === entry.name.toUpperCase() && name !== name.toUpperCase()) entry.name = name;
    else if (!hasDiacritics(entry.name) && hasDiacritics(name)) entry.name = name;
    entry.paths.add(path);
  };
  for (const a of albums) {
    if (a.artists) for (const ar of parseArtists(a.artists)) add(ar, a.path, a.cover);
    for (const t of a.tracks) if (t.artists) for (const ar of parseArtists(t.artists)) add(ar, a.path, a.cover);
  }
  _cachedArtists = [...map.values()]
    .map(({ name, paths, cover }) => ({ name, count: paths.size, cover }))
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

// ── Álbuns salvos (coração) ───────────────────────────────────────────────
// Ficam no localStorage deste navegador, separados por acervo:
// { "<acervo>": [{ path, name, artists, year, em }] }, o mais recente primeiro.
// O path (NFC) é a chave; nome/artista/ano só servem para quem ler o JSON à mão.
const SALVOS_KEY = 'tocador-salvos';
const SALVO_FORA = 'salvo-fora:';     // valor de um item da lista que é de outro acervo

function _salvosLer() {
  try {
    const v = JSON.parse(localStorage.getItem(SALVOS_KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

// A base de cada acervo já aberto neste navegador ({ "<acervo>": "https://cdn…" }): os salvos de outro acervo vêm
// sem catálogo carregado, e é dela que sai a URL da capa deles.
const BASES_KEY = 'tocador-acervo-bases';
function _basesLer() {
  try { const v = JSON.parse(localStorage.getItem(BASES_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; }
  catch { return {}; }
}
function lembrarBaseDoAcervo(id, base) {
  if (!id || !/^https?:\/\//.test(base || '')) return;
  const todas = _basesLer();
  if (todas[id] === base) return;
  todas[id] = base;
  try { localStorage.setItem(BASES_KEY, JSON.stringify(todas)); } catch {}
}
function capaSalvoFora(id, s) {
  const base = _basesLer()[id];
  return base && s.capa !== 0 ? `${base}/${encodeURIComponent(s.path)}/capa-min.jpg` : null;
}

function salvosDoAcervo() {
  const lista = _salvosLer()[activeAcervoId];
  return Array.isArray(lista) ? lista.filter(s => s && typeof s.path === 'string') : [];
}

function albumSalvo(album) {
  const p = album.path.normalize('NFC');
  return salvosDoAcervo().some(s => s.path === p);
}

// Liga/desliga e devolve o novo estado (true = salvo).
function alternarSalvo(album) {
  const todos = _salvosLer();
  const p = album.path.normalize('NFC');
  const lista = salvosDoAcervo();
  const i = lista.findIndex(s => s.path === p);
  if (i < 0) lista.unshift({ path: p, name: album.name, artists: album.artists, year: album.year, capa: album.cover ? 1 : 0, em: Date.now() });
  else lista.splice(i, 1);
  if (lista.length) todos[activeAcervoId] = lista;
  else delete todos[activeAcervoId];
  try {
    localStorage.setItem(SALVOS_KEY, JSON.stringify(todos));
    navigator.storage?.persist?.();      // pede para o navegador não despejar os salvos sob pressão de espaço
  } catch {
    showToast('Este navegador não deixou salvar');
    return i >= 0;
  }
  salvosMudaram();
  return i < 0;
}

function salvosMudaram() {
  const n = Object.values(_salvosLer()).reduce((t, l) => t + (Array.isArray(l) ? l.length : 0), 0);
  document.querySelectorAll('.browse-tab[data-tab="saved"], .ex-tab[data-ex-tab="saved"]').forEach(b => {
    b.title = n ? `Álbuns salvos (${n})` : 'Álbuns salvos';
    b.setAttribute('aria-label', b.title);
  });
  const like = document.querySelector('#album-header .album-like');
  if (like && selectedAlbum) syncLikeButton(like, selectedAlbum);
  if (browseTab === 'saved') refreshBrowseCounts();
}

// Os salvos deste acervo que existem no catálogo. Um álbum que saiu dele some daqui, mas continua guardado (pode voltar).
function salvosNoCatalogo() {
  const porPath = new Map(albums.map(a => [a.path.normalize('NFC'), a]));
  return salvosDoAcervo().map(s => porPath.get(s.path)).filter(Boolean);
}

function salvosDeFora() {
  return Object.entries(_salvosLer()).reduce((t, [id, l]) => t + (id !== activeAcervoId && Array.isArray(l) ? l.length : 0), 0);
}

// O link leva só o acervo ativo, então o botão conta só ele, e não muda com o filtro de texto da lista.
function syncShareSaved() {
  const btn = document.getElementById('share-saved');
  if (!btn) return;
  const n = browseTab === 'saved' ? salvosNoCatalogo().length : 0;
  btn.hidden = !n;
  if (!n) return;
  const rotulo = `Compartilhar ${n} ${n === 1 ? 'álbum' : 'álbuns'}`;
  const fora = salvosDeFora();
  btn.lastElementChild.textContent = rotulo;
  btn.title = fora ? `${rotulo} deste acervo: os salvos de outro acervo ficam de fora` : rotulo;
  btn.setAttribute('aria-label', btn.title);
}

function buildSavedList() {
  const daqui = salvosNoCatalogo()
    .map(a => ({ name: a.artists ? `${a.name} — ${a.artists}` : a.name, label: a.name, sub: a.artists, cover: a.cover, fullName: a.path, count: a.year > 0 ? a.year : '' }));
  // A lista é uma só: o acervo ativo depende da aba, e sem isso os salvos do outro pareciam perdidos.
  // O catálogo dele não está carregado, então esses itens vivem do que foi guardado ao salvar.
  const fora = Object.entries(_salvosLer())
    .filter(([id, lista]) => id !== activeAcervoId && Array.isArray(lista))
    .flatMap(([id, lista]) => lista.filter(s => s && typeof s.path === 'string').map(s => ({
      name: s.artists ? `${s.name} — ${s.artists}` : s.name,
      label: s.name, sub: s.artists, cover: capaSalvoFora(id, s),   // outro acervo: a base lembrada de quando foi aberto
      fullName: SALVO_FORA + JSON.stringify([id, s.path]),
      count: KNOWN_ACERVOS[id] ? id : 'outro acervo',
    })));
  return [...daqui, ...fora];
}

function browseSelectedValue() {
  if (browseTab === 'genres') return activeGenre;
  if (browseTab === 'saved') return selectedAlbum?.path ?? null;
  return activeArtist;
}

function getCurrentBrowseItems() {
  if (browseTab === 'saved') return buildSavedList();
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
  if (_browseEmptyEl) {
    _browseEmptyEl.hidden = visible.length > 0;
    _browseEmptyEl.textContent = browseTab === 'saved' && !browsePanelQuery
      ? 'Nenhum álbum salvo. Toque no coração de um álbum para guardá-lo aqui.'
      : 'Nenhum resultado';
  }
  _updateBrowseCountUI(visible.length);
  if (preserveScroll) virtualBrowseList.updateItems(visible, true);
  else virtualBrowseList.setItems(visible);
  virtualBrowseList.refresh(browseSelectedValue());
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
      updateLibraryStats();
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
    updateLibraryStats();
  });
}

function renderBrowsePanel() {
  renderGenreNote();
  syncShareSaved();
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
  syncShareSaved();
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
  if (sharedAlbums) return `Playlist (${sharedAlbums.size})`;
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
  const share = document.getElementById('share-artist');
  if (share) {
    share.hidden = !activeArtist;
    if (activeArtist) share.setAttribute('aria-label', `Compartilhar link de ${activeArtist}`);
  }
}

// The seven filter facets (search, decade, year, artist, genre, audio features, shared
// playlist) are mutually exclusive: choosing one resets the others. Cumulative filtering let a
// stale facet silently empty the grid — picking an artist while a search was
// still live returned zero albums with no visible reason why.
//
// `keep` names the facet the caller is about to set; every other facet is
// cleared along with its URL param and its chrome. This only ever clears, so
// callers assign their own facet afterwards. Omit `keep` to clear them all.
function resetFacets(keep) {
  if (keep !== 'lista' && sharedAlbums) {
    sharedAlbums = null;
    activeLista = '';
    removeListaFromUrl();
  }
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
  if (browseTab === 'saved' && value.startsWith(SALVO_FORA)) {
    // Em outra aba: trocar de acervo aqui recarregaria a página e cortaria o áudio.
    const [acervo, album] = JSON.parse(value.slice(SALVO_FORA.length));
    window.open(`${APP_ROOT}?${new URLSearchParams({ acervo, album })}`, '_blank', 'noopener');
    return;
  }
  if (browseTab === 'saved') {
    // Abrir um salvo não mexe nos filtros: o álbum abre mesmo que o grid não o mostre.
    const album = albums.find(a => a.path === value);
    if (!album) return;
    if (isMobile()) closeBrowseDrawer();
    openAlbum(album);
    virtualBrowseList?.refresh(album.path);
    return;
  }
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

// A genre tag under an album: the panel opens on that genre, its parent expanded and the row selected. Unlike a click
// on the row itself this never toggles off, and it leaves the album open.
function abrirGeneroNoBrowse(valor) {
  resetFacets('genre');
  activeGenre = valor;
  expandedGenres.add(valor.split('---')[0]);
  browsePanelQuery = '';
  if (_browseSearchEl) _browseSearchEl.value = '';
  if (browseTab === 'genres') renderBrowsePanel();
  else switchBrowseTab('genres');
  updateBrowseFilterInUrl();
  filterAlbums();
  openBrowseDrawer();
  virtualBrowseList?.refresh(activeGenre);
  virtualBrowseList?.scrollToValue(activeGenre);
}

// "Soa parecido com" under an album: filters the grid to that artist, like picking the row in the Artistas tab.
function abrirArtistaNoBrowse(nome) {
  resetFacets('artist');
  activeArtist = nome;
  updateBrowseFilterInUrl();
  filterAlbums();
  virtualBrowseList?.refresh(activeArtist);
}

function updateBrowseSelection() {
  virtualBrowseList?.refresh(browseSelectedValue());
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
  _browseListEl?.setAttribute('aria-label', tab === 'genres' ? 'Gêneros' : tab === 'saved' ? 'Álbuns salvos' : 'Artistas');
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

// The header follows the grid: with a filter on, hours/albums/artists count what passes (a per-track filter such as
// Pegada counts only the tracks that pass); with none, the whole acervo.
function updateLibraryStats() {
  const filtrado = filteredAlbums.length !== albums.length || !!trackFilter;
  let seconds = 0;
  for (const a of filteredAlbums) for (const t of a.tracks) if (!trackFilter || trackAllowed(t)) seconds += t.src?.duration || 0;
  // meta.hours only when the catalog has no durations at all (it goes stale when albums are merged in)
  const hours = seconds > 0 ? seconds / 3600 : filtrado ? 0 : parseFloat(db?.meta?.hours) || 0;
  const days = Math.round(hours / 24);
  const totalAlbums = filteredAlbums.length;
  const totalArtists = new Set(filteredAlbums.map(a => a.artists).filter(Boolean)).size;
  const hoursEl = document.getElementById('stat-hours');
  const albumsStatEl = document.getElementById('mobile-stat-albums');
  const artistsStatEl = document.getElementById('mobile-stat-artists');
  if (hoursEl) {
    hoursEl.textContent = !hours ? ''
      : days >= 1 ? `${days.toLocaleString('pt-BR')} dia${days === 1 ? '' : 's'} de ♪`
      : hours >= 1 ? `${Math.round(hours)} hora${Math.round(hours) > 1 ? 's' : ''} de ♪`
      : `${Math.max(1, Math.round(hours * 60))} min de ♪`;
  }
  if (albumsStatEl) albumsStatEl.textContent = `${totalAlbums.toLocaleString('pt-BR')} ${totalAlbums === 1 ? 'álbum' : 'álbuns'}`;
  if (artistsStatEl) artistsStatEl.textContent = `${totalArtists.toLocaleString('pt-BR')} artista${totalArtists !== 1 ? 's' : ''}`;
  const titulo = filtrado ? 'No filtro atual' : 'No acervo inteiro';
  document.querySelector('.header-stats')?.classList.toggle('filtrado', filtrado);
  for (const el of [hoursEl, albumsStatEl, artistsStatEl]) if (el) el.title = titulo;
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
  const titleAcervoEl = document.getElementById('app-title-acervo');
  const subtitleEl = document.getElementById('app-subtitle');
  if (titleAcervoEl) titleAcervoEl.textContent = title !== 'Tocador' ? ` ♪ ${title}` : '';
  // Tab title: the archive until an album is opened, then artist · album.
  document.title = `♪ Tocador · ${title}`;
  if (subtitleEl) subtitleEl.textContent = subtitle;
}
