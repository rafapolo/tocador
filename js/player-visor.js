// player-visor.js — "Visor do som": o acordeão sob as faixas que desenha a música que está tocando, como o visor do
// /atlas (js/atlas-visor.js): 40 barras do espectro em escala log e a forma de onda por cima. Faz parte do grupo de
// acordeões do painel (name="album-extra"), então só um deles fica aberto por vez, e só desenha enquanto está aberto
// e visível. Classic script, loaded after playback.js; uses the ui.js globals (BASE_URL, currentTrack, safePlay).
//
// O som é lido sem desviar o <audio>: captureStream() (Chrome, Firefox) dá uma cópia do que ele toca a um
// AnalyserNode, e o som segue saindo pelo próprio <audio>. Assim nada muda na reprodução, nem no fundo com a tela
// apagada. Ler o som de outro domínio exige CORS: o cdn.tocador.cc responde com Access-Control-Allow-Origin, então
// na primeira abertura o <audio> passa a pedir em modo CORS (crossorigin="anonymous"), recarregando a faixa atual
// no mesmo ponto. Um acervo de fora (?acervo=<url>) pode não ter CORS: aí o visor nem aparece. Sem captureStream
// sem prefixo (Safari, Firefox) também não.
(function () {
  'use strict';

  const BARRAS = 40, F_MIN = 40, F_MAX = 12000;
  const audio = document.getElementById('audio');
  const AC = window.AudioContext || window.webkitAudioContext;
  // só o captureStream() sem prefixo: o mozCaptureStream() do Firefox tira o som do <audio> enquanto captura
  const capturar = audio?.captureStream ? () => audio.captureStream() : null;
  let tentou = 0, ac = null, an = null, fluxo = null, trilha = null, fonte = null, raf = 0, freq = null, onda = null, falhou = false;
  const alturas = new Float32Array(BARRAS);
  const reduzMovimento = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // o servidor do som aceita CORS? o da casa (e a própria origem) sim; um de fora, não dá para saber sem tentar
  function corsOk() {
    try {
      const u = new URL(BASE_URL || '', location.href);
      return u.origin === location.origin || /(^|\.)tocador\.cc$/.test(u.hostname);
    } catch { return false; }
  }
  const possivel = () => !!(capturar && AC) && !falhou && corsOk();
  const caixas = () => document.querySelectorAll('.album-visor');

  // chamado por album-view.js junto com os outros acordeões
  function renderAlbumVisor() {
    const ok = possivel();
    caixas().forEach(d => { d.hidden = !selectedAlbum || !ok; });
    atualizar();
  }

  // a faixa atual, carregada sem CORS, volta a carregar com CORS no mesmo ponto (só uma vez por página)
  function garantirCors() {
    if (audio.crossOrigin === 'anonymous') return true;
    if (!corsOk()) return false;
    audio.crossOrigin = 'anonymous';
    if (!audio.src || audio.readyState === 0) return true;
    const t = audio.currentTime, tocando = !audio.paused, src = audio.src;
    window.__visorRecarregando = true;               // o tratador de erro do player não pula a faixa por isso
    const pronto = () => {
      audio.removeEventListener('error', erro);
      try { audio.currentTime = t; } catch {}
      if (tocando) safePlay(audio);
      window.__visorRecarregando = false;
    };
    const erro = () => {                             // o servidor recusou CORS: volta como era, sem visor
      audio.removeEventListener('loadedmetadata', pronto);
      falhou = true;
      audio.removeAttribute('crossorigin');
      audio.src = src;
      audio.addEventListener('loadedmetadata', () => { try { audio.currentTime = t; } catch {} if (tocando) safePlay(audio); window.__visorRecarregando = false; }, { once: true });
      audio.load();
      renderAlbumVisor();
    };
    audio.addEventListener('loadedmetadata', pronto, { once: true });
    audio.addEventListener('error', erro, { once: true });
    audio.src = src;
    audio.load();
    return true;
  }

  // o analisador, ligado à trilha de áudio atual da cópia (a trilha muda a cada faixa)
  function ligar() {
    if (!possivel() || !garantirCors()) return false;
    try {
      ac ||= new AC();
      if (!an) {
        an = ac.createAnalyser();
        an.fftSize = 2048;
        an.smoothingTimeConstant = 0.6;
        freq = new Uint8Array(an.frequencyBinCount);
        onda = new Float32Array(an.fftSize);
      }
      fluxo ||= capturar();
      const t0 = fluxo.getAudioTracks()[0] || null;
      if (t0 && t0 !== trilha) {
        fonte?.disconnect();
        trilha = t0;
        fonte = ac.createMediaStreamSource(new MediaStream([t0]));
        fonte.connect(an);                           // só o analisador: o som continua saindo pelo <audio>
      }
      if (ac.state === 'suspended') ac.resume();
      return true;
    } catch { return false; }
  }

  function desenhar(cv, legenda) {
    const ctx = cv.getContext('2d'), dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
    if (!w || !h) return;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    ctx.clearRect(0, 0, w, h);
    const cor = getComputedStyle(cv).getPropertyValue('--color-accent').trim() || '#d4a574';
    const gap = Math.max(1, Math.round(w / BARRAS * 0.18)), bw = (w - gap * (BARRAS - 1)) / BARRAS;
    ctx.fillStyle = cor;
    for (let i = 0; i < BARRAS; i++) {
      const bh = Math.max(dpr, alturas[i] * h * 0.95);
      ctx.globalAlpha = 0.35 + 0.65 * alturas[i];
      ctx.fillRect(i * (bw + gap), h - bh, bw, bh);
    }
    ctx.globalAlpha = 1;
    if (!reduzMovimento && onda) {
      ctx.strokeStyle = getComputedStyle(cv).getPropertyValue('--color-text').trim() || '#eee';
      ctx.lineWidth = dpr * 1.2;
      ctx.beginPath();
      const passo = Math.max(1, Math.floor(onda.length / w));
      for (let x = 0, k = 0; x < w && k < onda.length; x++, k += passo) {
        const y = h / 2 - onda[k] * h * 0.45;
        if (x) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
    const txt = currentTrack ? `${currentTrack.title || ''}${currentTrack.artists ? ' — ' + currentTrack.artists : ''}` : 'Nada tocando agora';
    if (legenda.textContent !== txt) legenda.textContent = txt;
  }

  function ler() {
    an.getByteFrequencyData(freq);
    an.getFloatTimeDomainData(onda);
    const binHz = ac.sampleRate / an.fftSize;
    for (let i = 0; i < BARRAS; i++) {
      const f0 = F_MIN * (F_MAX / F_MIN) ** (i / BARRAS), f1 = F_MIN * (F_MAX / F_MIN) ** ((i + 1) / BARRAS);
      let s = 0, n = 0;
      for (let b = Math.floor(f0 / binHz); b <= Math.ceil(f1 / binHz) && b < freq.length; b++) { s += freq[b]; n++; }
      const alvo = n ? s / n / 255 : 0;
      alturas[i] = alvo > alturas[i] ? alvo : alturas[i] * 0.86 + alvo * 0.14;      // sobe rápido, desce devagar
    }
  }

  function quadro() {
    raf = 0;
    const vistos = [...caixas()].filter(d => d.open && !d.hidden && d.getClientRects().length);
    if (!vistos.length || document.hidden) { ac?.suspend?.(); return; }
    raf = requestAnimationFrame(quadro);
    if (!audio.paused) {
      // a trilha da cópia muda a cada faixa (e a captura falha enquanto a faixa recarrega): religa, no máximo 2× por s
      if ((!an || !trilha || trilha.readyState === 'ended') && performance.now() - tentou > 500) { tentou = performance.now(); ligar(); }
      if (an && trilha) ler();
    }
    else { for (let i = 0; i < BARRAS; i++) alturas[i] *= 0.9; onda?.fill(0); }
    for (const d of vistos) desenhar(d.querySelector('canvas'), d.querySelector('p'));
  }
  function atualizar() {
    const algum = [...caixas()].some(d => d.open && !d.hidden);
    if (algum) { ligar(); if (!raf) raf = requestAnimationFrame(quadro); }
  }

  // Acordeões do mesmo grupo: um aberto por vez. O atributo name já faz isso nos navegadores novos; aqui, para os
  // que não o conhecem (Safari < 17.2, Firefox < 130).
  document.addEventListener('toggle', e => {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement) || !d.open || !d.name) return;
    for (const o of document.querySelectorAll(`details[name="${CSS.escape(d.name)}"]`)) if (o !== d && o.open) o.open = false;
    if (d.classList.contains('album-visor')) atualizar();
  }, true);
  audio?.addEventListener('play', atualizar);
  audio?.addEventListener('playing', () => { if (an) ligar(); });
  document.addEventListener('visibilitychange', atualizar);

  window.renderAlbumVisor = renderAlbumVisor;
  window.__visorPlayer = { estado: () => ({ possivel: possivel(), cors: audio.crossOrigin, ligado: !!an, desenhando: !!raf, falhou }) };
})();
