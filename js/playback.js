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
      // The queue turned to the next track while the page was hidden (screen locked, another
      // app) and the browser refused to start it: iOS can do this, and the album then stopped
      // in silence. Try again when the page comes back, and say so if that fails too.
      if (document.hidden) retomarAoVoltar(audio);
    } else if (err.name === 'NotSupportedError') {
      // The <audio> 'error' listener (js/ui.js) finds out why and says so, with a retry.
    } else if (err.name !== 'AbortError') {
      showToast('Não foi possível tocar a faixa', 4000);
    }
  });
}

let _retomando = false;
function retomarAoVoltar(audio) {
  if (_retomando) return;
  _retomando = true;
  const src = audio.currentSrc || audio.src;
  const aoVoltar = () => {
    if (document.hidden) return;
    document.removeEventListener('visibilitychange', aoVoltar);
    _retomando = false;
    // Only if nothing changed meanwhile: the listener paused, or picked another track.
    if (!audio.paused || (audio.currentSrc || audio.src) !== src) return;
    const p = audio.play();
    const avisar = () => showToast('A próxima faixa não começou com a tela bloqueada — toque ▶ para continuar', 6000);
    if (p?.catch) p.catch(e => { if (e.name === 'NotAllowedError') avisar(); });
  };
  document.addEventListener('visibilitychange', aoVoltar);
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
  if (metaEl) {
    metaEl.innerHTML = `${artistLinksHTML(album.artists)} · ${escapeHtml(album.year)} · ${album.tracks.length} faixas`;
    attachArtistHandlers(metaEl);
  }
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

// Selects an album without going through openAlbum(), which primes the first track and would cut the audio.
function switchToAlbum(album) {
  if (album === selectedAlbum) return;
  selectedAlbum = album;
  renderedAlbum = null;
  renderAlbumHeader();
  renderTrackList();
  renderMobileDrawer(album);
  virtualGrid.refresh();
  updateMetaTags(album);
  window.history.pushState({ album: album.path }, '', generateAlbumUrl(album));
}

// ── Tocar os salvos ───────────────────────────────────────────────────────
// O coração com play da barra do player toca os álbuns salvos deste acervo, um depois do outro (ou misturados, com o
// aleatório ligado). A fila é uma foto do momento do clique; o catálogo do outro acervo nem está carregado aqui.
function syncSavedQueueButton() {
  const btn = document.getElementById('btn-play-saved');
  if (!btn) return;
  const on = !!savedQueue;
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-pressed', String(on));
  btn.title = on ? 'Parar de tocar os salvos' : 'Tocar os álbuns salvos';
  btn.setAttribute('aria-label', btn.title);
}

function setSavedQueue(queue) {
  savedQueue = queue;
  syncSavedQueueButton();
}

function toggleSavedQueue() {
  if (savedQueue) { setSavedQueue(null); return; }
  const queue = salvosNoCatalogo().filter(a => a.tracks.some(trackAllowed));
  if (!queue.length) { showToast('Nenhum álbum salvo neste acervo'); return; }
  setSavedQueue(queue);
  showToast(`Tocando ${queue.length} ${queue.length === 1 ? 'álbum salvo' : 'álbuns salvos'}`, undefined, { ok: true });
  const album = queue[shuffleOn ? Math.floor(Math.random() * queue.length) : 0];
  switchToAlbum(album);
  playTrack(album.tracks.find(trackAllowed));
}

// Abrir um álbum de fora da fila encerra o modo: quem escolheu outra coisa não espera voltar aos salvos.
function savedQueueActive() {
  if (savedQueue && !savedQueue.includes(selectedAlbum)) setSavedQueue(null);
  return !!savedQueue;
}

// Shuffle draws from what the grid shows (the search, decade, artist, genre, Pegada or
// shared-list filter; the saved queue when it's on): an album first, uniformly, then one of
// its playable tracks, so big compilations don't crowd everything else out. The last
// SHUFFLE_RECENT tracks are skipped while there's anything else to play.
const SHUFFLE_RECENT = 50;
const shuffleRecent = [];
const shuffleHistory = [];   // [album, track] pairs, for "previous" in shuffle
function pickShuffleTrack(pool) {
  const albumsOk = pool.filter(a => a.tracks.some(t => t !== currentTrack && trackAllowed(t)));
  if (!albumsOk.length) return null;
  const recent = new Set(shuffleRecent);
  let pick = null;
  for (let tries = 0; tries < 12 && !pick; tries++) {
    const a = albumsOk[Math.floor(Math.random() * albumsOk.length)];
    const ts = a.tracks.filter(t => t !== currentTrack && trackAllowed(t) && !recent.has(t));
    if (ts.length) pick = [a, ts[Math.floor(Math.random() * ts.length)]];
  }
  if (!pick) {   // everything left was heard recently: take any playable track
    const a = albumsOk[Math.floor(Math.random() * albumsOk.length)];
    const ts = a.tracks.filter(t => t !== currentTrack && trackAllowed(t));
    pick = [a, ts[Math.floor(Math.random() * ts.length)]];
  }
  shuffleRecent.push(pick[1]);
  if (shuffleRecent.length > SHUFFLE_RECENT) shuffleRecent.shift();
  return pick;
}

function playNext() {
  const inQueue = savedQueueActive();
  if (shuffleOn) {
    const pick = pickShuffleTrack(inQueue ? savedQueue : filteredAlbums);
    if (!pick) return;
    if (currentTrack) {
      const from = selectedAlbum?.tracks.includes(currentTrack) ? selectedAlbum : albums.find(a => a.tracks.includes(currentTrack));
      if (from) shuffleHistory.push([from, currentTrack]);
      if (shuffleHistory.length > 200) shuffleHistory.shift();
    }
    switchToAlbum(pick[0]);
    playTrack(pick[1]);
    return;
  }
  if (!selectedAlbum || !currentTrack) return;
  const tracks = selectedAlbum.tracks;
  const idx = tracks.indexOf(currentTrack);
  const next = tracks.find((t, i) => i > idx && trackAllowed(t));
  if (next) {
    playTrack(next);
  } else if (inQueue) {
    let i = savedQueue.indexOf(selectedAlbum) + 1;
    if (i >= savedQueue.length) {
      if (repeatMode !== 'all') { setSavedQueue(null); return; }   // fim da fila
      i = 0;
    }
    const album = savedQueue.slice(i).find(a => a.tracks.some(trackAllowed));
    if (!album) { setSavedQueue(null); return; }
    switchToAlbum(album);
    playTrack(album.tracks.find(trackAllowed));
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
  if (shuffleOn && shuffleHistory.length) {
    const [album, track] = shuffleHistory.pop();
    switchToAlbum(album);
    playTrack(track);
    return;
  }
  const idx = selectedAlbum.tracks.indexOf(currentTrack);
  let prev = null;
  for (let i = idx - 1; i >= 0; i--) if (trackAllowed(selectedAlbum.tracks[i])) { prev = selectedAlbum.tracks[i]; break; }
  if (prev) playTrack(prev);
  else if (audio) audio.currentTime = 0;
}

// ── Timer para dormir e velocidade ──────────────────────────────────────────
// #btn-timer opens #timer-menu. Sleep: after N minutes (the volume fades over the last 10 s,
// then playback pauses and the volume comes back), at the end of the track, or at the end of
// the album. Speed: 0.75–1.5×, kept in 'tocador-rate' and carried across tracks through
// defaultPlaybackRate (a new src resets playbackRate to it).
let _sleep = null;          // { kind: 'min', end } | { kind: 'track' } | { kind: 'album' }
let _sleepTick = 0;
let _sleepFadeFrom = null;  // the listener's volume before the fade
const SLEEP_FADE = 10;

function sleepStopsOnEnded() {
  if (!_sleep) return false;
  const lastOfAlbum = selectedAlbum && currentTrack && !selectedAlbum.tracks.some((t, i) => i > selectedAlbum.tracks.indexOf(currentTrack) && trackAllowed(t));
  if (_sleep.kind === 'track' || (_sleep.kind === 'album' && lastOfAlbum && !shuffleOn)) {
    setSleep('off');
    showToast('Timer: reprodução parada', 4000, { ok: true });
    return true;
  }
  return false;
}

function setSleep(value) {
  const audio = document.getElementById('audio');
  clearInterval(_sleepTick);
  if (_sleepFadeFrom != null) { audio.volume = _sleepFadeFrom; _sleepFadeFrom = null; }
  _sleep = value === 'off' ? null
    : value === 'track' || value === 'album' ? { kind: value }
    : { kind: 'min', minutes: String(value), end: Date.now() + Number(value) * 60_000 };
  if (_sleep?.kind === 'min') _sleepTick = setInterval(sleepTick, 1000);
  syncTimerUI();
}

function sleepTick() {
  const audio = document.getElementById('audio');
  const left = (_sleep.end - Date.now()) / 1000;
  if (left <= 0) {
    audio.pause();
    setSleep('off');
    showToast('Timer: reprodução parada', 4000, { ok: true });
    return;
  }
  if (left <= SLEEP_FADE && !audio.paused) {
    _sleepFadeFrom ??= audio.volume;
    audio.volume = _sleepFadeFrom * Math.max(0, left / SLEEP_FADE);
  }
  syncTimerUI();
}

function setRate(rate, audio = document.getElementById('audio')) {
  audio.defaultPlaybackRate = rate;
  audio.playbackRate = rate;
  if ('preservesPitch' in audio) audio.preservesPitch = true;
  try { localStorage.setItem('tocador-rate', String(rate)); } catch {}
  syncTimerUI();
}

function syncTimerUI() {
  const btn = document.getElementById('btn-timer');
  const menu = document.getElementById('timer-menu');
  if (!btn || !menu) return;
  const rate = document.getElementById('audio').defaultPlaybackRate || 1;
  const left = _sleep?.kind === 'min' ? Math.max(0, Math.ceil((_sleep.end - Date.now()) / 60_000)) : 0;
  const label = _sleep?.kind === 'min' ? `${left}′` : _sleep?.kind === 'track' ? 'faixa' : _sleep?.kind === 'album' ? 'álbum'
    : rate !== 1 ? `${String(rate).replace('.', ',')}×` : '';
  btn.querySelector('.timer-left').textContent = label;
  btn.classList.toggle('active', !!_sleep || rate !== 1);
  const sleepVal = !_sleep ? 'off' : _sleep.kind === 'min' ? _sleep.minutes : _sleep.kind;
  for (const b of menu.querySelectorAll('[data-sleep]')) b.setAttribute('aria-pressed', String(b.dataset.sleep === sleepVal));
  for (const b of menu.querySelectorAll('[data-rate]')) b.setAttribute('aria-pressed', String(Number(b.dataset.rate) === rate));
  btn.title = _sleep?.kind === 'min' ? `Para em ${left} min` : _sleep ? `Para no fim ${_sleep.kind === 'track' ? 'da faixa' : 'do álbum'}` : 'Timer e velocidade';
}

function initTimerMenu(audio) {
  const btn = document.getElementById('btn-timer');
  const menu = document.getElementById('timer-menu');
  let saved = 1;
  try { saved = parseFloat(localStorage.getItem('tocador-rate')) || 1; } catch {}
  setRate([0.75, 1, 1.25, 1.5].includes(saved) ? saved : 1, audio);
  if (!btn || !menu) return;
  const abrir = (on) => {
    menu.hidden = !on;
    btn.setAttribute('aria-expanded', String(on));
    document.body.classList.toggle('timer-aberto', on);   // the "Continuar" strip would cover it
    if (on) menu.querySelector('[aria-pressed="true"]')?.focus();
  };
  btn.addEventListener('click', () => abrir(menu.hidden));
  menu.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.sleep) setSleep(b.dataset.sleep);
    if (b.dataset.rate) setRate(Number(b.dataset.rate));
  });
  menu.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); abrir(false); btn.focus(); } });
  document.addEventListener('click', e => { if (!menu.hidden && !e.target.closest('.timer-wrap')) abrir(false); });
}
