// Playback: play/next/previous, progress, now-playing and mobile drawer.
// Classic script: shares ui.js's global scope (state lives at the top of ui.js).
// Loaded after ui.js; everything here runs at call time, after DOMContentLoaded.

// ── Playback ──────────────────────────────────────────────────────────────

function safePlay(audio) {
  _playRequested = true;
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

// Zero the progress UI immediately on track change — before any media event
// fires — so the previous track's bar/labels never linger through a slow load.
function resetProgressUI(track) {
  _progressFillEl ??= document.getElementById('progress-fill');
  _mainProgressBarEl ??= document.getElementById('main-progress-bar');
  _overlayProgressFillEl ??= document.getElementById('overlay-progress-fill');
  _timeCurrentLbl ??= document.getElementById('time-current');
  _timeDurationLbl ??= document.getElementById('time-duration');
  _overlayTimeCurrentLbl ??= document.getElementById('overlay-time-current');
  _overlayTimeDurationLbl ??= document.getElementById('overlay-time-duration');
  if (_progressFillEl) _progressFillEl.style.width = '0%';
  if (_overlayProgressFillEl) _overlayProgressFillEl.style.width = '0%';
  if (_mainProgressBarEl) {
    _mainProgressBarEl.classList.remove('has-progress');
    _mainProgressBarEl.setAttribute('aria-valuenow', 0);
  }
  const dur = formatTime(durationCache.get(track?.file) ?? track?.duration);
  if (_timeCurrentLbl) _timeCurrentLbl.textContent = '0:00';
  if (_overlayTimeCurrentLbl) _overlayTimeCurrentLbl.textContent = '0:00';
  if (_timeDurationLbl) _timeDurationLbl.textContent = dur;
  if (_overlayTimeDurationLbl) _overlayTimeDurationLbl.textContent = dur;
}

function playTrack(track) {
  currentTrack = track;
  updateNowPlaying();
  const audio = document.getElementById('audio');
  const newSrc = `${BASE_URL}/${track.file}`;
  // Also reload when audio.error is set: retrying the same src after a failed
  // load needs a fresh load() call, otherwise play() just re-rejects the stuck resource.
  if (audio.src !== newSrc || audio.error) {
    resetProgressUI(track);
    audio.src = newSrc;
    audio.load();
  }
  safePlay(audio);
  (_btnPlay ??= document.getElementById('btn-play'))?.classList.add('playing');
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
    if (listEl)  { listEl.replaceChildren(); renderTrackFilterNote(listEl, null); }
    return;
  }

  if (titleEl) titleEl.textContent = album.name;
  if (metaEl)  metaEl.textContent  = `${album.artists} · ${album.year} · ${album.tracks.length} faixas`;
  if (coverEl) loadCoverImage(coverEl, album.cover);
  if (!listEl) return;

  listEl.replaceChildren(buildTrackItemsFragment(album.tracks, album.artists));
  renderTrackFilterNote(listEl, album.tracks);
}

function syncDrawerPlayingState() {
  const listEl = document.getElementById('drawer-track-list');
  if (!listEl || !selectedAlbum) return;
  syncTrackPlayingState(listEl, selectedAlbum.tracks);
  listEl.querySelector('.track-item.playing')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function updateNowPlaying() {
  if (!currentTrack) return;
  (_playerTitleEl ??= document.getElementById('player-title')).textContent = currentTrack.title;
  const playerArtistEl = document.getElementById('player-artist');
  if (playerArtistEl) { playerArtistEl.innerHTML = artistLinksHTML(currentTrack.artists); attachArtistHandlers(playerArtistEl); }
  const folder = currentTrack.file.split('/')[0];
  const coverUrl = `${BASE_URL}/${folder}/capa-min.jpg`;
  const coverImg = document.getElementById('player-cover');
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
  if (_overlayTrackArtist) { _overlayTrackArtist.innerHTML = artistLinksHTML(currentTrack.artists); attachArtistHandlers(_overlayTrackArtist); }

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
    let nextAlbum, track;
    if (trackFilter) {
      // Explorar is filtering: shuffle only among the tracks it lets through, inside the albums on the grid.
      const pool = [];
      for (const a of filteredAlbums) for (const t of a.tracks) if (t !== currentTrack && trackAllowed(t)) pool.push([a, t]);
      if (!pool.length) return;
      [nextAlbum, track] = pool[Math.floor(Math.random() * pool.length)];
    } else {
      // Avoid flatMap allocation: pick a random album (weighted by track count), then a random track.
      // Falls back to retry if the single track selected is currentTrack (rare; at most 1 retry).
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
    }
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
  const next = tracks.find((t, i) => i > idx && trackAllowed(t));
  if (next) {
    playTrack(next);
  } else if (repeatMode === 'all') {
    const first = tracks.find(trackAllowed);
    if (first) playTrack(first);
  }
}

function playPrevious() {
  if (!selectedAlbum || !currentTrack) return;
  // Match standard player convention: restart the current track if meaningfully
  // into it, only step back to the prior track when near the start.
  const audio = document.getElementById('audio');
  if (audio && audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  const idx = selectedAlbum.tracks.indexOf(currentTrack);
  let prev = null;
  for (let i = idx - 1; i >= 0; i--) if (trackAllowed(selectedAlbum.tracks[i])) { prev = selectedAlbum.tracks[i]; break; }
  if (prev) playTrack(prev);
  else if (audio) audio.currentTime = 0;
}
