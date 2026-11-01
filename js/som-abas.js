// som-abas.js — tocador's tabs telling each other whether they are playing.
// A web page cannot see other apps or other sites' tabs, but pages of the same origin can talk, which is how
// /atlas (opened from the player's .album-atlas link, in a new tab) knows to keep quiet while an album plays.
// Classic script, no dependencies; loaded by index.html, radio.html and atlas.html. Older cached tabs simply
// don't answer, and the mirrors are other origins: both read as "nothing playing".
(function (global) {
  'use strict';

  const CANAL = 'tocador-som';
  const ID = Math.random().toString(36).slice(2);
  const abrir = () => { try { return new BroadcastChannel(CANAL); } catch { return null; } };

  // Tells the other tabs when this <audio> plays or stops, and answers when one of them asks.
  function anunciarSom(audio) {
    const ch = abrir();
    if (!ch) return;
    const dizer = () => ch.postMessage({ id: ID, tocando: !audio.paused && !audio.ended });
    for (const ev of ['play', 'pause', 'ended']) audio.addEventListener(ev, dizer);
    addEventListener('pagehide', () => ch.postMessage({ id: ID, tocando: false }));
    ch.onmessage = e => { if (e.data?.pergunta) dizer(); };
  }

  // Calls aoMudar(true/false) as "some other tocador tab is playing" changes, asking once at the start.
  function ouvirSomDasAbas(aoMudar) {
    const ch = abrir();
    if (!ch) return;
    const tocando = new Set();
    ch.onmessage = e => {
      const { id, tocando: on } = e.data || {};
      if (!id || id === ID) return;      // a page hears its own other channels too
      const antes = tocando.size > 0;
      if (on) tocando.add(id); else tocando.delete(id);
      if (antes !== tocando.size > 0) aoMudar(tocando.size > 0);
    };
    ch.postMessage({ pergunta: true });
  }

  global.anunciarSom = anunciarSom;
  global.ouvirSomDasAbas = ouvirSomDasAbas;
})(window);
