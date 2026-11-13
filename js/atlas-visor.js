// atlas-visor.js — what "Sonificar" is playing, drawn at the bottom middle of /atlas while it sounds.
// The spectrum of the real output (the engine's own AnalyserNode), each bar coloured by the genre family that owns
// that share of the band (the voices' weights, heaviest first, so the colours read as "this much samba, this much
// jazz"), the waveform over it, and the families with the tempo underneath. Decorative: the ♪ button carries the
// state for screen readers. Classic script, no dependencies; criarVisorSom() is called by js/atlas.js.
(function (global) {
  'use strict';

  const BARRAS = 40, F_MIN = 40, F_MAX = 12000;

  function criarVisorSom({ som, cor, nome }) {
    const caixa = document.getElementById('visor-som');
    if (!caixa) return null;
    const cv = caixa.querySelector('canvas'), legenda = caixa.querySelector('p');
    const ctx = cv.getContext('2d');
    const reduzMovimento = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let freq = null, onda = null, alturas = new Float32Array(BARRAS), cores = [], ultimoEstado = 0, raf = 0, visivel = false;
    let texto = '';

    function ler(an) {
      if (!freq || freq.length !== an.frequencyBinCount) { freq = new Uint8Array(an.frequencyBinCount); onda = new Float32Array(an.fftSize); }
      an.getByteFrequencyData(freq);
      an.getFloatTimeDomainData(onda);
      const binHz = an.context.sampleRate / an.fftSize;
      for (let i = 0; i < BARRAS; i++) {
        const f0 = F_MIN * (F_MAX / F_MIN) ** (i / BARRAS), f1 = F_MIN * (F_MAX / F_MIN) ** ((i + 1) / BARRAS);
        let s = 0, n = 0;
        for (let b = Math.floor(f0 / binHz); b <= Math.ceil(f1 / binHz) && b < freq.length; b++) { s += freq[b]; n++; }
        const alvo = n ? s / n / 255 : 0;
        alturas[i] = alvo > alturas[i] ? alvo : alturas[i] * 0.86 + alvo * 0.14;   // fast up, slow down
      }
    }

    // Every 250 ms: which families sound and how much → one colour per bar, and the line underneath.
    function lerEstado(e) {
      const vozes = (e.vozes || []).filter(v => v.peso > 0.05).sort((a, b) => b.peso - a.peso);
      const total = vozes.reduce((a, v) => a + v.peso, 0) || 1;
      cores = [];
      let acc = 0;
      for (const v of vozes) {
        const ate = Math.round((acc += v.peso) / total * BARRAS);
        while (cores.length < ate) cores.push(cor(v.nome));
      }
      while (cores.length < BARRAS) cores.push(cores[cores.length - 1] || '#d4a574');
      const nomes = vozes.slice(0, 3).map(v => nome(v.nome));
      const novo = nomes.length ? `${nomes.join(' · ')}${e.bpm ? ` — ${e.bpm} bpm` : ''}` : '';
      if (novo !== texto) legenda.textContent = texto = novo;
    }

    function desenhar() {
      const dpr = Math.min(2, devicePixelRatio || 1), w = cv.clientWidth, h = cv.clientHeight;
      if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const passo = w / BARRAS, larg = Math.max(1, passo - 2);
      for (let i = 0; i < BARRAS; i++) {
        const a = Math.max(0.03, alturas[i]) * h;
        ctx.globalAlpha = 0.35 + 0.65 * alturas[i];
        ctx.fillStyle = cores[i] || '#d4a574';
        ctx.fillRect(i * passo + 1, h - a, larg, a);
      }
      if (onda && !reduzMovimento) {   // reduced motion: the bars still follow the sound, no waveform flicker
        ctx.globalAlpha = 0.8;
        ctx.strokeStyle = '#f5f1ed';
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        const n = 256, salto = Math.floor(onda.length / n);
        for (let i = 0; i < n; i++) {
          const x = i / (n - 1) * w, y = h / 2 - onda[i * salto] * h * 0.9;
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    function quadro(t) {
      raf = 0;
      const an = som.analisador?.();
      const agora = performance.now();
      if (agora - ultimoEstado > 250) {
        ultimoEstado = agora;
        const e = som.estado();
        const tocando = !!an && e.audivel && e.rms > 0.0005;
        if (tocando !== visivel) { visivel = tocando; caixa.classList.toggle('ativo', tocando); }
        if (tocando) lerEstado(e);
      }
      if (visivel && an) {
        ler(an);
        desenhar();
      }
      raf = requestAnimationFrame(quadro);
    }

    // Nothing to draw while the tab is hidden: the browser pauses rAF anyway, this just keeps it explicit.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else if (!raf) raf = requestAnimationFrame(quadro);
    });
    raf = requestAnimationFrame(quadro);
    // During the tour the visor sits in its black bar: #atlas is its own stacking context, under #tour, so the
    // element moves into #tour for the length of it (body.em-tour, js/atlas-tour.js) and back afterwards.
    const casa = caixa.parentElement;
    new MutationObserver(() => {
      const tour = document.body.classList.contains('em-tour') && document.getElementById('tour');
      const alvo = tour || casa;
      if (caixa.parentElement !== alvo) alvo.append(caixa);
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    // Arrastável, no mouse e no toque, como o cartão da banda: solto, fica onde ficou (guardado neste navegador, só
    // conveniência: sem localStorage volta ao meio, embaixo), sempre inteiro dentro da janela; duplo clique volta ao
    // lugar padrão. No tour não se mexe: lá ele mora na barra da legenda.
    const CHAVE = 'tocador-atlas-visor';
    function colocar(p) {
      if (!p) { caixa.classList.remove('movido'); caixa.style.removeProperty('--visor-x'); caixa.style.removeProperty('--visor-y'); return; }
      const w = caixa.offsetWidth || 280, h = caixa.offsetHeight || 70;
      caixa.style.setProperty('--visor-x', `${Math.round(Math.max(8, Math.min(p.x, innerWidth - w - 8)))}px`);
      caixa.style.setProperty('--visor-y', `${Math.round(Math.max(8, Math.min(p.y, innerHeight - h - 8)))}px`);
      caixa.classList.add('movido');
    }
    const lido = () => { try { return JSON.parse(localStorage.getItem(CHAVE) || 'null'); } catch { return null; } };
    colocar(lido());
    caixa.addEventListener('pointerdown', e => {
      if (document.body.classList.contains('em-tour') || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault();
      e.stopPropagation();
      const r = caixa.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      caixa.classList.add('arrastando');
      const mover = ev => colocar({ x: ev.clientX - dx, y: ev.clientY - dy });
      const soltar = () => {
        removeEventListener('pointermove', mover);
        removeEventListener('pointerup', soltar);
        removeEventListener('pointercancel', soltar);
        caixa.classList.remove('arrastando');
        if (caixa.classList.contains('movido')) {
          const q = caixa.getBoundingClientRect();
          try { localStorage.setItem(CHAVE, JSON.stringify({ x: Math.round(q.left), y: Math.round(q.top) })); } catch {}
        }
      };
      addEventListener('pointermove', mover);
      addEventListener('pointerup', soltar);
      addEventListener('pointercancel', soltar);
    });
    caixa.addEventListener('dblclick', e => {
      e.stopPropagation();
      try { localStorage.removeItem(CHAVE); } catch {}
      colocar(null);
    });
    addEventListener('resize', () => { const p = lido(); if (p) colocar(p); });

    return { visivel: () => visivel, texto: () => texto };
  }

  global.criarVisorSom = criarVisorSom;
})(window);
