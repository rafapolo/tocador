// Decade buttons, album header and track-list rendering.
// Classic script: shares ui.js's global scope (state lives at the top of ui.js).
// Loaded after ui.js; everything here runs at call time, after DOMContentLoaded.

// ── Decade Buttons (rendered once on init) ────────────────────────────────

function renderDecadeButtons() {
  const decades = getDecades();
  const container = document.querySelector('#decade-buttons');

  const todosBtn = document.createElement('button');
  todosBtn.className = 'decade-btn active';
  todosBtn.textContent = 'Todos';
  todosBtn.dataset.decade = 'all';
  todosBtn.addEventListener('click', () => {
    resetFacets('decade');
    activeDecade = null;
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
    resetFacets('decade');
    activeDecade = 'pre1940';
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
      resetFacets('decade');
      activeDecade = parseInt(btn.dataset.decade);
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
      resetFacets('decade');
      activeDecade = 'noyear';
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
  const container = document.getElementById('album-header');
  if (!selectedAlbum) { container.innerHTML = ''; return; }

  const cover = document.createElement('img');
  cover.className = 'album-cover-large';
  cover.alt = selectedAlbum.name;
  cover.loading = 'lazy';
  loadCoverImage(cover, selectedAlbum.cover);

  const info = document.createElement('div');
  info.className = 'album-header-info';
  info.innerHTML = `
    <h2>${escapeHtml(selectedAlbum.name)}</h2>
    <p><strong>${artistLinksHTML(selectedAlbum.artists)}</strong></p>
    <p><span class="year-link" role="button" tabindex="0" aria-label="Filtrar álbuns de ${escapeHtml(selectedAlbum.year)}">${escapeHtml(selectedAlbum.year)}</span> • ${selectedAlbum.tracks.length} canções</p>
  `;

  const yearLinkEl = info.querySelector('.year-link');
  const handleYearClick = () => {
    resetFacets('year');
    activeYear = selectedAlbum.year;
    updateYearInUrl(activeYear);
    filterAlbums();
  };
  yearLinkEl?.addEventListener('click', handleYearClick);
  yearLinkEl?.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleYearClick(); }
  });

  attachArtistHandlers(info);

  const album = selectedAlbum;
  const share = document.createElement('button');
  share.type = 'button';
  share.className = 'album-share';
  share.textContent = 'Compartilhar';
  share.setAttribute('aria-label', `Compartilhar link de ${album.name}`);
  share.addEventListener('click', () => shareAlbum(album));
  info.appendChild(share);

  container.replaceChildren(cover, info);
}

function updateDurationInDOM(track, idx) {
  const dur = durationCache.get(track.file);
  if (!dur) return;
  const formatted = formatTime(dur);
  document.querySelector(`#track-list [data-track-idx="${idx}"] .track-duration`)?.replaceChildren(document.createTextNode(formatted));
  document.querySelector(`#drawer-track-list [data-track-idx="${idx}"] .track-duration`)?.replaceChildren(document.createTextNode(formatted));
}

// Shared by the desktop track list and the mobile drawer track list — both render
// the same row markup for a given track set, differing only in target container.
function buildTrackItemsFragment(tracks, albumArtists) {
  const frag = document.createDocumentFragment();
  tracks.forEach((track, idx) => {
    const item = document.createElement('li');
    item.className = 'track-item';
    item.dataset.trackIdx = idx;
    item.setAttribute('tabindex', '0');
    item.setAttribute('aria-label', `Faixa ${track.num}: ${track.title}`);
    if (currentTrack === track) { item.classList.add('playing'); item.setAttribute('aria-current', 'true'); }
    if (!trackAllowed(track)) {
      // Fora do filtro do Explorar: continua listada, mas não toca nem entra na sequência.
      item.classList.add('filtered-out');
      item.setAttribute('aria-disabled', 'true');
      item.setAttribute('tabindex', '-1');
      item.setAttribute('aria-label', `Faixa ${track.num}: ${track.title} (fora do filtro)`);
    }

    const artistName = track.artists && track.artists !== albumArtists ? track.artists : '';
    const artistLabel = artistName ? `<div class="track-artist">${artistLinksHTML(artistName)}</div>` : '';
    const dur = durationCache.has(track.file) ? formatTime(durationCache.get(track.file)) : '-';
    item.innerHTML = `
      <span class="track-num" aria-hidden="true">${escapeHtml(track.num)}</span>
      <div class="track-details">
        <div class="track-title">${escapeHtml(track.title)}</div>
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
  return frag;
}

function syncTrackPlayingState(container, tracks) {
  container.querySelectorAll('[data-track-idx]').forEach(item => {
    const isPlaying = tracks[parseInt(item.dataset.trackIdx)] === currentTrack;
    item.classList.toggle('playing', isPlaying);
    item.setAttribute('aria-current', isPlaying ? 'true' : 'false');
  });
}

function renderTrackList() {
  const container = document.querySelector('#track-list');
  const tracksPanel = (_tracksPanelEl ??= document.getElementById('tracks-panel'));

  if (!selectedAlbum) {
    tracksPanel.classList.add('hidden');
    container.replaceChildren();
    renderedAlbum = null;
    return;
  }

  tracksPanel.classList.remove('hidden');

  if (renderedAlbum === selectedAlbum) {
    syncTrackPlayingState(container, selectedAlbum.tracks);
    container.querySelector('.track-item.playing')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return;
  }

  tracksPanel.scrollTop = 0;
  container.replaceChildren(buildTrackItemsFragment(selectedAlbum.tracks, selectedAlbum.artists));
  renderedAlbum = selectedAlbum;
  container.querySelector('.track-item.playing')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
