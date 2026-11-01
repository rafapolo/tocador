// atlas-som.js — the music of /atlas: everything is synthesised here with Web Audio, no audio file.
// Classic script, loaded after atlas-receitas.js (RECEITAS_ATLAS) and som-abas.js. Reference for the mix is
// ../swissviz/design/sound.md; the choices made here are in tasks/generative-music-nav.md.
//
// criarMotor(ac) plays the recipes on any AudioContext, also an OfflineAudioContext (tests/atlas-som.spec.js
// renders with it). criarSomAtlas(o) decides when it sounds, and what the camera is looking at feeds it.
//
// One transport and one key, always: a bar is 96 ticks of a single clock, every family steps on that clock
// (its grid doubled or halved to sit near its own tempo), and the strongest family sets tempo and chords,
// changing only on a bar line. So two genres on screen are one groove with two accents, not two songs.
(function (global) {
  'use strict';

  const { familiaDe, receita, ESCALAS } = global.RECEITAS_ATLAS;
  const BARRA = 96, POR_SEMINIMA = 24;
  const NIVEL = { '.': 0, o: 0.38, x: 0.72, X: 1 };
  const MAX_NOTAS = 44;           // ringing at once; a new note lets the oldest go
  const DORME_MS = 60000;
  const CHAVE = 'tocador-atlas-musica';

  const hz = m => 440 * 2 ** ((m - 69) / 12);
  const limita = (v, a, b) => Math.min(b, Math.max(a, v));
  const liso = (v, a, b) => { const x = limita((v - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };
  // integers to [0, 1): the same place always plays the same notes
  const hash = (...xs) => {
    let h = 2166136261;
    for (const x of xs) { h = Math.imul(h ^ (x | 0), 16777619); h ^= h >>> 13; }
    h = Math.imul(h, 0x5bd1e995);
    return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
  };

  // o: [wave, frequency ratio, cents, gain]. a/d/s/r: envelope. lp/env/q: lowpass, its sweep, its resonance.
  // fm: [ratio, index, seconds]. form: formant bands. vib: [Hz, cents]. dist: goes through the shared distortion.
  const TIMBRES = {
    violao: { o: [['triangle', 1, 0, 0.8], ['sawtooth', 1, 0, 0.16]], a: 0.002, d: 0.7, s: 0, r: 0.12, lp: 1500, env: 2200, g: 0.5 },
    violao7: { o: [['triangle', 1, 0, 0.9], ['sawtooth', 1, 0, 0.12]], a: 0.003, d: 0.5, s: 0, r: 0.1, lp: 900, env: 900, g: 0.6 },
    cavaco: { o: [['triangle', 1, 0, 0.6], ['square', 1, 4, 0.14]], a: 0.001, d: 0.22, s: 0, r: 0.05, lp: 2600, env: 2600, g: 0.34 },
    bandolim: { o: [['sawtooth', 1, 0, 0.3], ['triangle', 2, 3, 0.4]], a: 0.001, d: 0.3, s: 0, r: 0.06, lp: 3000, env: 1800, g: 0.3 },
    banjo: { o: [['sawtooth', 1, 0, 0.24], ['square', 2, 0, 0.1]], a: 0.001, d: 0.16, s: 0, r: 0.05, lp: 3600, env: 1800, g: 0.3 },
    guitarra: { o: [['sawtooth', 1, 0, 0.3], ['triangle', 1, 5, 0.5]], a: 0.002, d: 0.45, s: 0.1, r: 0.1, lp: 1500, env: 1000, g: 0.4 },
    dist: { o: [['sawtooth', 1, -6, 0.5], ['sawtooth', 1, 6, 0.5]], a: 0.003, d: 0.2, s: 0.8, r: 0.05, g: 0.32, dist: 1 },
    baixo: { o: [['triangle', 1, 0, 0.9], ['sawtooth', 1, 0, 0.2]], a: 0.004, d: 0.3, s: 0.5, r: 0.06, lp: 700, env: 500, g: 0.62 },
    contrabaixo: { o: [['sine', 1, 0, 0.8], ['triangle', 1, 0, 0.5]], a: 0.008, d: 0.4, s: 0.1, r: 0.08, lp: 650, g: 0.66 },
    sub: { o: [['sine', 1, 0, 0.9], ['triangle', 2, 0, 0.16]], a: 0.005, d: 0.3, s: 0.9, r: 0.09, g: 0.72 },
    acid: { o: [['sawtooth', 1, 0, 0.9]], a: 0.002, d: 0.16, s: 0.25, r: 0.05, lp: 260, env: 2400, q: 11, g: 0.34 },
    rhodes: { o: [['sine', 1, 0, 0.9]], fm: [1, 1.8, 0.5], a: 0.003, d: 1.2, s: 0, r: 0.2, g: 0.3 },
    piano: { o: [['triangle', 1, 2, 0.6], ['sine', 2, 0, 0.3]], fm: [2, 0.8, 0.25], a: 0.002, d: 1.3, s: 0, r: 0.14, g: 0.3 },
    cravo: { o: [['sawtooth', 1, 0, 0.3], ['square', 2, 0, 0.1]], a: 0.001, d: 0.34, s: 0, r: 0.05, lp: 4800, g: 0.2 },
    orgao: { o: [['sine', 1, 0, 0.7], ['sine', 2, 0, 0.4], ['sine', 3, 0, 0.3]], a: 0.012, d: 0.1, s: 0.85, r: 0.1, g: 0.2 },
    sanfona: { o: [['square', 1, -5, 0.4], ['square', 1, 5, 0.4]], a: 0.02, d: 0.1, s: 0.8, r: 0.08, lp: 1700, q: 2, vib: [5.5, 7], g: 0.24 },
    sopro: { o: [['sawtooth', 1, 0, 0.8]], a: 0.03, d: 0.15, s: 0.7, r: 0.08, lp: 900, env: 1400, g: 0.28 },
    cordas: { o: [['sawtooth', 1, -6, 0.4], ['sawtooth', 1, 6, 0.4]], a: 0.22, d: 0.4, s: 0.85, r: 0.5, lp: 1500, vib: [5, 5], g: 0.2 },
    flauta: { o: [['sine', 1, 0, 0.9], ['triangle', 2, 0, 0.07]], a: 0.04, d: 0.1, s: 0.8, r: 0.07, vib: [5, 8], g: 0.26 },
    apito: { o: [['sine', 1, 0, 0.9]], a: 0.008, d: 0.05, s: 0.7, r: 0.02, vib: [28, 40], g: 0.12 },
    vibrafone: { o: [['sine', 1, 0, 0.9]], fm: [4, 0.7, 0.2], a: 0.002, d: 1.6, s: 0, r: 0.3, vib: [4.5, 4], g: 0.26 },
    sino: { o: [['sine', 1, 0, 0.9]], fm: [3.5, 1.4, 0.3], a: 0.002, d: 1.8, s: 0, r: 0.4, g: 0.17 },
    caixinha: { o: [['sine', 1, 0, 0.9]], fm: [5.4, 0.8, 0.1], a: 0.001, d: 0.7, s: 0, r: 0.15, g: 0.22 },
    lead: { o: [['sawtooth', 1, 0, 0.5], ['square', 1, 6, 0.3]], a: 0.004, d: 0.2, s: 0.5, r: 0.08, lp: 1600, env: 1200, g: 0.2 },
    chip: { o: [['square', 1, 0, 0.7]], a: 0.001, d: 0.1, s: 0.5, r: 0.02, lp: 5000, g: 0.14 },
    voz: { o: [['sawtooth', 1, 0, 0.9]], a: 0.07, d: 0.2, s: 0.8, r: 0.14, form: [[640, 7], [1150, 9]], vib: [5.2, 12], g: 0.5 },
    pad: { o: [['sawtooth', 1, -8, 0.5], ['sawtooth', 1, 8, 0.5]], a: 1.6, d: 1, s: 0.85, r: 2.4, lp: 820, g: 0.13 },
    padQuente: { o: [['triangle', 1, -5, 0.7], ['sine', 2, 5, 0.3]], a: 1.4, d: 1, s: 0.85, r: 2.2, lp: 1200, g: 0.26 },
  };

  function criarMotor(ac) {
    // out → below 30 Hz cut → glue compressor → limiter → soft ceiling: nothing past 0 dBFS (as in Cantography)
    const saida = ac.createGain();
    saida.gain.value = 0;
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 30;
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 3;
    const lim = ac.createDynamicsCompressor();
    lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.1;
    const trim = ac.createGain();
    trim.gain.value = 0.48;       // the limiter's own makeup gain, taken back
    const teto = ac.createWaveShaper();
    teto.curve = Float32Array.from({ length: 1025 }, (_, i) => Math.tanh(((i - 512) / 512) * 1.2) / Math.tanh(1.2));
    const medidor = ac.createAnalyser();
    medidor.fftSize = 2048;
    saida.connect(hp); hp.connect(comp); comp.connect(lim); lim.connect(trim); trim.connect(teto);
    teto.connect(ac.destination); teto.connect(medidor);

    const sr = ac.sampleRate;
    const ruido = ac.createBuffer(1, sr * 2, sr);
    { const d = ruido.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    // a room: 2.2 s of noise dying away, its highs first
    const ir = ac.createBuffer(2, Math.round(sr * 2.2), sr);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < d.length; i++) {
        const x = i / d.length;
        lp += (0.9 - 0.8 * x) * ((Math.random() * 2 - 1) - lp);
        d[i] = lp * (1 - x) ** 3 * Math.min(1, i / (0.012 * sr)) * 0.5;
      }
    }
    const verb = ac.createConvolver();
    verb.buffer = ir;
    const sala = ac.createGain();
    sala.gain.value = 0.2;
    sala.connect(verb); verb.connect(saida);
    // the camera's lowpass, over everything but the dots crossing the sights
    const leito = ac.createGain();
    leito.gain.value = 0.9;
    leito.connect(saida); leito.connect(sala);
    const cam = ac.createBiquadFilter();
    cam.frequency.value = 500; cam.Q.value = 0.4;
    cam.connect(leito);
    // shared distortion for guitars
    const distIn = ac.createGain();
    const ws = ac.createWaveShaper();
    ws.curve = Float32Array.from({ length: 1025 }, (_, i) => Math.tanh(((i - 512) / 512) * 7));
    ws.oversample = '2x';
    const distLp = ac.createBiquadFilter();
    distLp.frequency.value = 2600; distLp.Q.value = 0.8;
    distIn.connect(ws); ws.connect(distLp);
    const distG = ac.createGain();
    distG.gain.value = 0.3;
    distLp.connect(distG);
    // wind: as fast as the map moves
    const vento = ac.createBufferSource();
    vento.buffer = ruido; vento.loop = true;
    const ventoF = ac.createBiquadFilter();
    ventoF.type = 'bandpass'; ventoF.frequency.value = 600; ventoF.Q.value = 0.8;
    const ventoG = ac.createGain();
    ventoG.gain.value = 0;
    vento.connect(ventoF); ventoF.connect(ventoG); ventoG.connect(saida);
    vento.start();

    // Ringing notes, soonest to end first. Times are the notes' own, so this holds ahead of the clock too.
    const vivas = [];
    function viva(g, fontes, t0, fim) {
      while (vivas.length && vivas[0].fim < t0) vivas.shift();
      vivas.push({ g, fontes, fim });
      vivas.sort((x, y) => x.fim - y.fim);
      if (vivas.length > MAX_NOTAS) {       // the one with the least left to play goes
        const v = vivas.shift();
        v.g.gain.cancelScheduledValues(t0);
        v.g.gain.setTargetAtTime(0, t0, 0.006);
        for (const f of v.fontes) { try { f.stop(t0 + 0.04); } catch {} }
      }
    }

    function nota(nome, m, t0, dur, vel, dest, brilho = 1) {
      const T = TIMBRES[nome], f = hz(m), g = ac.createGain(), pk = vel * T.g;
      const fim = t0 + dur + T.r * 1.5 + 0.05;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(pk, t0 + T.a);
      g.gain.setTargetAtTime(pk * T.s, t0 + T.a, T.d / 3);
      g.gain.setTargetAtTime(0, t0 + Math.max(dur, T.a), T.r / 3);
      let topo = g;
      if (T.lp) {
        const lp = ac.createBiquadFilter();
        const base = T.lp * brilho;
        if (T.q) lp.Q.value = T.q;
        lp.frequency.setValueAtTime(base + (T.env || 0) * vel, t0);
        if (T.env) lp.frequency.setTargetAtTime(base, t0, Math.max(T.d, 0.08) / 2.5);
        g.connect(lp);
        topo = lp;
      }
      if (T.form) {
        const soma = ac.createGain();
        for (const [fq, q] of T.form) {
          const b = ac.createBiquadFilter();
          b.type = 'bandpass'; b.frequency.value = fq; b.Q.value = q;
          topo.connect(b); b.connect(soma);
        }
        topo = soma;
      }
      topo.connect(T.dist ? distIn : dest);
      const fontes = [];
      let lfo = null;
      if (T.vib) {
        lfo = ac.createOscillator();
        const prof = ac.createGain();
        lfo.frequency.value = T.vib[0]; prof.gain.value = T.vib[1];
        lfo.connect(prof);
        lfo.prof = prof;
        lfo.start(t0); lfo.stop(fim);
        fontes.push(lfo);
      }
      for (const [tipo, razao, cents, ganho] of T.o) {
        const os = ac.createOscillator(), og = ac.createGain();
        os.type = tipo; os.frequency.value = f * razao; os.detune.value = cents; og.gain.value = ganho;
        if (lfo) lfo.prof.connect(os.detune);
        if (T.fm) {
          const mod = ac.createOscillator(), mg = ac.createGain(), [rz, ind, tf] = T.fm;
          mod.frequency.value = f * razao * rz;
          mg.gain.setValueAtTime(f * ind, t0);
          mg.gain.setTargetAtTime(0, t0, tf / 3);
          mod.connect(mg); mg.connect(os.frequency);
          mod.start(t0); mod.stop(fim);
          fontes.push(mod);
        }
        os.connect(og); og.connect(g);
        os.start(t0); os.stop(fim);
        fontes.push(os);
      }
      viva(g, fontes, t0, fim);
    }

    // ── drums ──
    function tom(t, f0, f1, dec, v, dest, tipo = 'sine') {
      const os = ac.createOscillator(), g = ac.createGain();
      os.type = tipo;
      os.frequency.setValueAtTime(f0, t);
      os.frequency.exponentialRampToValueAtTime(f1, t + Math.max(0.02, dec * 0.5));
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.0008, t + dec);
      os.connect(g); g.connect(dest);
      os.start(t); os.stop(t + dec + 0.02);
    }
    function chiado(t, tipo, f, q, dec, v, dest) {
      const s = ac.createBufferSource(), b = ac.createBiquadFilter(), g = ac.createGain();
      s.buffer = ruido;
      b.type = tipo; b.frequency.value = f; b.Q.value = q;
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.0008, t + dec);
      s.connect(b); b.connect(g); g.connect(dest);
      s.start(t, hash(t * 1000) * 1.5); s.stop(t + dec + 0.02);
    }
    function metal(t, f, razao, ind, dec, v, dest) {
      const os = ac.createOscillator(), mod = ac.createOscillator(), mg = ac.createGain(), g = ac.createGain();
      os.frequency.value = f; mod.frequency.value = f * razao; mg.gain.value = f * ind;
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.0008, t + dec);
      mod.connect(mg); mg.connect(os.frequency); os.connect(g); g.connect(dest);
      mod.start(t); os.start(t); mod.stop(t + dec + 0.02); os.stop(t + dec + 0.02);
    }
    const PERC = {
      bumbo(t, v, d) { tom(t, 150, 48, 0.28, 0.8 * v, d); chiado(t, 'highpass', 2500, 0.7, 0.012, 0.1 * v, d); },
      surdo(t, v, d) { tom(t, 96, 58, 0.6, 0.72 * v, d); tom(t, 190, 120, 0.1, 0.1 * v, d); },
      zabumba(t, v, d) { tom(t, 118, 64, 0.3, 0.66 * v, d); chiado(t, 'bandpass', 1400, 1, 0.03, 0.14 * v, d); },
      caixa(t, v, d) { tom(t, 220, 165, 0.1, 0.24 * v, d, 'triangle'); chiado(t, 'bandpass', 2600, 0.6, 0.17, 0.42 * v, d); },
      aro(t, v, d) { tom(t, 1650, 1400, 0.025, 0.2 * v, d, 'square'); chiado(t, 'bandpass', 3000, 2, 0.03, 0.2 * v, d); },
      palma(t, v, d) { for (const a of [0, 0.011, 0.022]) chiado(t + a, 'bandpass', 1500, 1.4, 0.05, 0.26 * v, d); chiado(t + 0.03, 'bandpass', 1500, 1, 0.13, 0.26 * v, d); },
      chimbal(t, v, d) { chiado(t, 'highpass', 8000, 0.7, 0.045, 0.2 * v, d); },
      aberto(t, v, d) { chiado(t, 'highpass', 7200, 0.7, 0.26, 0.2 * v, d); },
      prato(t, v, d) { chiado(t, 'highpass', 6000, 0.7, 0.42, 0.13 * v, d); metal(t, 2400, 1.48, 0.7, 0.3, 0.04 * v, d); },
      tamborim(t, v, d) { tom(t, 900, 780, 0.055, 0.2 * v, d, 'triangle'); chiado(t, 'highpass', 4500, 0.7, 0.03, 0.14 * v, d); },
      ganza(t, v, d) { chiado(t, 'bandpass', 6200, 1.1, 0.05, 0.2 * v, d); },
      pandeiro(t, v, d) { chiado(t, 'bandpass', 5200, 1.6, 0.07, 0.2 * v, d); tom(t, 310, 250, 0.06, 0.1 * v, d); },
      repique(t, v, d) { tom(t, 430, 340, 0.1, 0.3 * v, d, 'triangle'); chiado(t, 'bandpass', 2000, 1, 0.05, 0.14 * v, d); },
      cuica(t, v, d) {
        const os = ac.createOscillator(), b = ac.createBiquadFilter(), g = ac.createGain();
        os.type = 'sawtooth'; b.type = 'bandpass'; b.frequency.value = 900; b.Q.value = 3;
        const sobe = v > 0.8;   // the cuíca's laugh: up on an accent, down otherwise
        os.frequency.setValueAtTime(sobe ? 330 : 620, t);
        os.frequency.exponentialRampToValueAtTime(sobe ? 640 : 340, t + 0.16);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.42 * v, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0008, t + 0.2);
        os.connect(b); b.connect(g); g.connect(d);
        os.start(t); os.stop(t + 0.22);
      },
      agogo(t, v, d) { metal(t, v > 0.8 ? 1180 : 880, 2.4, 0.5, 0.17, 0.13 * v, d); },
      triangulo(t, v, d) { metal(t, 4300, 2.76, 0.35, v > 0.8 ? 0.34 : 0.05, 0.1 * v, d); },
      clave(t, v, d) { tom(t, 2500, 2300, 0.03, 0.3 * v, d); },
      cowbell(t, v, d) { tom(t, 545, 540, 0.1, 0.1 * v, d, 'square'); tom(t, 815, 810, 0.1, 0.1 * v, d, 'square'); },
      conga(t, v, d) { tom(t, 340, 240, 0.16, 0.36 * v, d); },
      bongo(t, v, d) { tom(t, 540, 430, 0.08, 0.28 * v, d); },
      estalo(t, v, d) { chiado(t, 'highpass', 3000, 3, 0.006, 0.14 * v, d); },
    };

    // ── the transport ──
    const vozes = new Map();      // family -> { r, alvo, peso, bus, pan, mult }
    let bpm = 100, bpmAlvo = 100, tick = 0, barra = -1, tProx = ac.currentTime + 0.06;
    let regente = null, acorde = null, modo = 'maior', tonica = 0;
    let camadas = { cama: 1, perc: 0, baixo: 0, acorde: 0, mel: 0 };
    let tempero = null, semente = 1, sementeFrase = 1, cama = { fim: 0, raiz: -1 };
    let melodista = null, fraseMel = -1;

    function voz(nome) {
      let v = vozes.get(nome);
      if (v) return v;
      const g = ac.createGain(), pan = ac.createStereoPanner();
      g.gain.value = 0;
      g.connect(pan); pan.connect(cam);
      v = { nome, r: receita(nome), alvo: 0, peso: 0, g, pan, mult: 1, hits: 0 };
      vozes.set(nome, v);
      return v;
    }

    // What the region asks for. `fatias`: [{ nome, peso, pan }], strongest first, summing to about 1.
    function definir({ fatias, cam: fc, sala: s, cam_tau = 0.35, ...resto }, instantaneo = false) {
      for (const v of vozes.values()) v.alvo = 0;
      for (const f of fatias) { const v = voz(f.nome); v.alvo = f.peso; v.panAlvo = f.pan || 0; }
      const t = ac.currentTime, tau = instantaneo ? 0.001 : 1;
      for (const v of vozes.values()) {
        v.peso = v.alvo > v.peso ? v.peso + (v.alvo - v.peso) * (instantaneo ? 1 : 0.2) : v.peso + (v.alvo - v.peso) * (instantaneo ? 1 : 0.15);
        v.g.gain.setTargetAtTime(v.alvo * v.r.nivel, t, tau);
        v.pan.pan.setTargetAtTime(limita(v.panAlvo || 0, -0.8, 0.8), t, 0.6);
        if (v.alvo === 0 && v.peso < 0.015 && v !== regente) {
          setTimeout(() => { v.g.disconnect(); v.pan.disconnect(); }, 4000);
          vozes.delete(v.nome);
        }
      }
      if (fc) cam.frequency.setTargetAtTime(fc, t, cam_tau);
      if (s !== undefined) sala.gain.setTargetAtTime(s, t, 0.8);
      if (resto.camadas) camadas = resto.camadas;
      tempero = resto.tempero ?? null;
      if (resto.semente) semente = resto.semente;
      if (!regente && fatias.length) tick -= tick % BARRA;     // nothing was playing: the next tick starts a bar
    }

    const modoDe = r => {
      const quer = tempero?.modo;
      return r.harmonia[quer] ? quer : r.harmonia.maior && !r.harmonia.menor ? 'maior' : r.harmonia.menor && !r.harmonia.maior ? 'menor' : 'maior';
    };
    function tempoAlvo(r) {
      let b = tempero?.bpm;
      if (!b) return r.bpm;
      const lo = r.bpm / 1.3, hi = r.bpm * 1.3;      // the tracks tune the family's tempo, never overturn it
      while (b < lo) b *= 2;
      while (b > hi) b /= 2;
      return limita(b, lo, hi);
    }
    // Among half, same and double of a tempo, the nearest to where the clock already is: fewer long glides.
    function dobra(alvo) {
      return [alvo / 2, alvo, alvo * 2].filter(b => b >= 56 && b <= 210)
        .reduce((a, b) => (Math.abs(Math.log2(b / bpm)) < Math.abs(Math.log2(a / bpm)) ? b : a), alvo);
    }

    function virarBarra(t) {
      barra++;
      let forte = null;
      for (const v of vozes.values()) if (v.alvo > 0 && (!forte || v.alvo > forte.alvo)) forte = v;
      if (forte && (!regente || !vozes.has(regente.nome) || regente.alvo === 0 || forte.alvo > regente.alvo * 1.2)) regente = forte;
      if (!regente) return;
      const r = regente.r;
      modo = modoDe(r);
      tonica = tempero?.tonica ?? r.tonica;
      bpmAlvo = dobra(tempoAlvo(r));
      for (const v of vozes.values()) {
        v.hits = 0;
        const alvo = v === regente ? tempoAlvo(r) : v.r.bpm;
        let mult = 2 ** limita(Math.round(Math.log2(alvo / bpmAlvo)), -1, 1);
        if (!Number.isInteger(BARRA / v.r.passos / mult)) mult = 1;
        v.mult = mult;
      }
      const h = r.harmonia[modo];
      // only a held tonic from far away: harmony arrives with the rhythm
      const i = camadas.acorde + camadas.baixo < 0.2 ? 0 : Math.floor(barra / r.compassos) % h.length;
      acorde = { raiz: (tonica + h[i].raiz) % 12, notas: h[i].notas };
      const durBarra = 60 / bpm * 4;
      if (acorde.raiz !== cama.raiz || t >= cama.fim - durBarra) {
        const dur = Math.max(durBarra * r.compassos, 2.5);
        cama = { raiz: acorde.raiz, fim: t + dur };
        let n = 0;
        for (const v of [...vozes.values()].sort((a, b) => b.alvo - a.alvo)) {
          if (v.alvo < 0.12 || n++ > 1) continue;
          const notas = n === 1 ? acorde.notas.slice(0, 3) : [0, 7];
          for (const x of notas) nota(v.r.cama, 48 + acorde.raiz + x, t, dur, 0.8 * camadas.cama, v.g);
        }
      }
    }

    // Steps until the pattern's next hit: how long a note may ring.
    function ateProxima(p, s) {
      for (let j = 1; j <= p.length; j++) if (p[(s + j) % p.length] !== '.') return j;
      return p.length;
    }

    function tocarMelodia(v, s, t, dt) {
      const r = v.r, M = r.mel, n = r.passos * 2, i = s % n, f = Math.floor(s / n);
      const motivo = [0, 0, 1, 0][f & 3];           // AABA: repetition is most of what makes a line a tune
      let toca;
      if (M.r) toca = M.r[i % M.r.length] !== '.';
      else toca = i % Math.max(1, r.passos / 8) === 0 && hash(sementeFrase, motivo, i, 9) < M.d * (tempero?.densidade ?? 1) * 2;
      if (!toca) return;
      const a = hash(sementeFrase, motivo, 0) * 6.28, b = 1 + hash(sementeFrase, motivo, 1) * 2.5;
      const esc = ESCALAS[M.escala || r.escala] || ESCALAS.maior;
      const grau = Math.round(4 * Math.sin(a + b * i / n * 6.28) + 2 * (hash(sementeFrase, motivo, i) - 0.5));
      const oit = Math.floor(grau / esc.length), pc = ((grau % esc.length) + esc.length) % esc.length;
      let m = r.faixa + (M.oit || 0) + oit * 12 + tonica + esc[pc];
      // on the strong beats, a chord tone
      if (i % (r.passos / 2) === 0 && acorde) {
        const alvos = acorde.notas.map(x => (acorde.raiz + x) % 12);
        let melhor = m, dist = 99;
        for (const d of [0, 1, -1, 2, -2]) if (alvos.includes(((m + d) % 12 + 12) % 12) && Math.abs(d) < dist) { melhor = m + d; dist = Math.abs(d); }
        m = melhor;
      }
      const dur = dt * Math.max(1, r.passos / 8) * (1 + hash(sementeFrase, i) * 1.5);
      nota(M.t, m, t, dur, 0.75 * camadas.mel, v.g);
    }

    function passoVoz(v, s, t0, dt) {
      const r = v.r;
      const t = t0 + (s % 2 ? r.swing * dt : 0);
      const dens = tempero?.densidade ?? 0.7;
      if (camadas.perc > 0.02) for (const inst in r.perc) {
        const p = r.perc[inst], c = p[s % p.length];
        if (c === '.') continue;
        if (c === 'o' && hash(s, inst.length) > dens + 0.2) continue;
        if (r.acaso && hash(barra, s, inst.length) < r.acaso) continue;
        PERC[inst](t + hash(s, 7) * 0.003, NIVEL[c] * camadas.perc * (0.88 + 0.2 * hash(barra, s)), v.g);
      }
      if (!acorde) return;
      const B = r.baixo;
      if (B && camadas.baixo > 0.02 && v === regente) {
        const c = B.p[s % B.p.length];
        if (c !== '.') {
          const n = B.n === 'anda' ? [0, 7, 5, 11, 12, 10, 7, 4][(v.hits + Math.floor(hash(barra) * 4)) & 7] : B.n[v.hits % B.n.length];
          v.hits++;
          const dur = dt * ateProxima(B.p, s) * (B.longo ? 1 : 0.85);
          nota(B.t, 36 + acorde.raiz + n, t, dur, NIVEL[c] * camadas.baixo, v.g, tempero?.brilho ?? 1);
        }
      }
      const C = r.acorde;
      if (C && camadas.acorde > 0.02) {
        const c = C.p[s % C.p.length];
        if (c !== '.') {
          const base = 52 + ((acorde.raiz + 8) % 12) - 8;     // a fixed register, so chords don't jump around
          const vel = NIVEL[c] * camadas.acorde * (C.suave ? 0.62 : 1);
          const dur = dt * ateProxima(C.p, s) * (C.longo ? 1 : 0.8);
          if (C.arpejo) {
            const a = C.arpejo[s % C.arpejo.length], ns = acorde.notas;
            nota(C.t, base + ns[a % ns.length] + (a >= ns.length ? 12 : 0), t, dur * 2, vel, v.g, tempero?.brilho ?? 1);
          } else if (C.pesado) {
            for (const x of [0, 7]) nota(C.t, base - 12 + x, t, dur, vel, v.g);
          } else {
            acorde.notas.forEach((x, j) => nota(C.t, base + x, t + j * (C.rasgueado ? 0.014 : 0.004), dur, vel * 0.72, v.g, tempero?.brilho ?? 1));
          }
        }
      }
      if (r.mel && camadas.mel > 0.02 && v === melodista) tocarMelodia(v, s, t, dt);
    }

    function passo(t) {
      if (tick % BARRA === 0) virarBarra(t);
      if (tick % (BARRA * 2) === 0) {
        // two genres take turns on the line, each as often as it weighs: call and response between neighbours
        fraseMel = barra;
        sementeFrase = semente;
        const com = [...vozes.values()].filter(v => v.r.mel && v.alvo > 0.1);
        const soma = com.reduce((a, v) => a + v.alvo, 0);
        let x = hash(semente, barra) * soma;
        melodista = null;
        for (const v of com) { x -= v.alvo; if (x <= 0) { melodista = v; break; } }
      }
      for (const v of vozes.values()) {
        if (v.peso < 0.02 && v.alvo < 0.02) continue;
        const r = v.r, st = BARRA / r.passos / v.mult;
        if (tick % st === 0) passoVoz(v, tick / st, t, st * 60 / bpm / POR_SEMINIMA);
      }
    }

    function avancar(ate) {
      if (tProx < ac.currentTime) tProx = ac.currentTime + 0.02;     // back from a suspend
      while (tProx < ate) {
        passo(tProx);
        tick++;
        bpm += (bpmAlvo - bpm) * 0.012;
        tProx += 60 / bpm / POR_SEMINIMA;
      }
    }

    // ── sounds off the grid ──
    // Data: a dot crossing the sights. Past the camera's filter: it is the sharpest thing on the map.
    function ponto(chave, nomeFamilia, pan, vel) {
      const r = receita(nomeFamilia);
      const esc = ESCALAS[r.mel?.escala || r.escala] || ESCALAS.maior;
      const m = 72 + tonica + esc[Math.floor(hash(chave) * esc.length)] + (hash(chave, 2) < 0.3 ? 12 : 0);
      const p = ac.createStereoPanner();
      p.pan.value = limita(pan, -0.8, 0.8);
      p.connect(leito);
      nota('caixinha', m, ac.currentTime + 0.01, 0.1, vel, p);
      setTimeout(() => p.disconnect(), 2500);
    }
    // Interface: a dry click and note, no room.
    function tap(graus = [0], vel = 0.5) {
      const t = ac.currentTime + 0.005;
      graus.forEach((x, j) => {
        const os = ac.createOscillator(), g = ac.createGain(), tj = t + j * 0.07;
        os.type = 'triangle'; os.frequency.value = hz(72 + tonica + x);
        g.gain.setValueAtTime(0.09 * vel, tj);
        g.gain.exponentialRampToValueAtTime(0.0008, tj + 0.15);
        os.connect(g); g.connect(saida);
        os.start(tj); os.stop(tj + 0.17);
      });
    }
    // Moments: a swell into the room. The longer the sound, the rarer the moment.
    function swell(graus = [0, 7, 12], vel = 0.6) {
      const t = ac.currentTime + 0.01;
      graus.forEach((x, j) => {
        const g = ac.createGain(), tj = t + j * 0.14, fim = tj + 1.9;
        g.gain.setValueAtTime(0, tj);
        g.gain.linearRampToValueAtTime(0.11 * vel, tj + 0.12);
        g.gain.exponentialRampToValueAtTime(0.0008, fim);
        for (const [tipo, c] of [['sine', -4], ['triangle', 4]]) {
          const os = ac.createOscillator();
          os.type = tipo; os.frequency.value = hz(64 + tonica + x); os.detune.value = c;
          os.connect(g); os.start(tj); os.stop(fim + 0.02);
        }
        g.connect(leito);
      });
    }

    distG.connect(cam);
    return {
      saida, avancar, definir, ponto, tap, swell, medidor,
      vento(x) {
        const t = ac.currentTime;
        ventoG.gain.setTargetAtTime(0.09 * Math.sqrt(x), t, x > 0.01 ? 0.1 : 0.4);
        ventoF.frequency.setTargetAtTime(300 + 1400 * x, t, 0.2);
      },
      estado() {
        return {
          bpm: Math.round(bpm), tonica, modo, regente: regente?.nome ?? null, melodista: melodista?.nome ?? null,
          acorde: acorde && { raiz: acorde.raiz, notas: acorde.notas }, notas: vivas.length,
          vozes: [...vozes.values()].map(v => ({ nome: v.nome, peso: +v.alvo.toFixed(3), mult: v.mult })),
        };
      },
    };
  }

  // Zoom to layers: from afar the bed alone, then the bass and the beat, the comp, the line.
  function camadasDe(z) {
    const l = Math.log2(Math.max(z, 0.5));
    return { cama: 1 - 0.45 * liso(l, 2, 4), baixo: liso(l, 0.4, 1.6), perc: liso(l, 0.6, 2), acorde: liso(l, 1.2, 2.6), mel: liso(l, 2, 3.3) };
  }
  // 400 Hz with the whole map in view, open by the time single tracks are named
  const filtroDe = z => limita(400 * 2 ** (Math.log2(Math.max(z, 0.5)) * 1.25), 220, 16000);

  // o: { generos, regiao(), mira(), previa, pararPrevia(), botao, aoPrimeiroSom() }. regiao() says what the camera
  // sees: { pesos, somaX, largura, z, giro, velocidade, semente, tempero } or null while nothing can be read.
  function criarSomAtlas(o) {
    const famDe = o.generos.map(familiaDe);
    const lerPref = () => { try { return localStorage.getItem(CHAVE); } catch { return null; } };
    let vontade = lerPref() !== '0';         // on by default
    let ativado = false, previaTocando = false, outroSom = false, ignorarOutro = false, dormindo = false;
    let ac = null, m = null, relogio = 0, tDesliga = 0, ultimaAnalise = 0, ultimaMira = 0, ultimoGesto = performance.now();

    const emEspera = () => vontade && outroSom && !ignorarOutro;
    const audivel = () => ativado && vontade && !previaTocando && !emEspera() && !document.hidden && !dormindo;

    function rotular() {
      const b = o.botao, espera = emEspera();
      b.setAttribute('aria-pressed', String(vontade && !espera));
      b.classList.toggle('espera', espera);
      b.title = espera ? 'Em espera: o Tocador está tocando em outra aba. Clique para ouvir a música do mapa assim mesmo'
        : vontade ? 'Música do mapa ligada: gerada na hora a partir dos gêneros à vista. Clique para silenciar (M)'
          : 'Música do mapa desligada. Clique para ligar (M)';
    }

    function montar() {
      if (ac) return;
      const Ctx = global.AudioContext || global.webkitAudioContext;
      if (!Ctx) return;
      ac = new Ctx({ latencyHint: 'playback' });
      m = criarMotor(ac);
      o.aoPrimeiroSom?.();
    }

    // iOS: ambient mixes with other apps' sound instead of pausing it, and obeys the silent switch. A preview
    // is a song someone asked for, so it goes back to the default session.
    function sessao() {
      try { if (navigator.audioSession) navigator.audioSession.type = previaTocando ? 'auto' : 'ambient'; } catch {}
    }

    function pulso() {
      const agora = performance.now();
      if (agora - ultimoGesto > DORME_MS) { dormindo = true; atualizar(); return; }
      m.avancar(ac.currentTime + 0.14);
      if (agora - ultimaAnalise >= 200) { ultimaAnalise = agora; analisar(); }
      if (agora - ultimaMira >= 90) { ultimaMira = agora; mirar(); }
    }

    function analisar() {
      const R = o.regiao();
      if (!R) return;
      const porFam = new Map();
      R.pesos.forEach((w, g) => {
        if (!w) return;
        const f = famDe[g], c = porFam.get(f) || { peso: 0, x: 0 };
        c.peso += w; c.x += R.somaX[g];
        porFam.set(f, c);
      });
      const top = [...porFam].sort((a, b) => b[1].peso - a[1].peso).slice(0, 3);
      const soma = top.reduce((a, [, c]) => a + c.peso, 0);
      const fatias = top.map(([nome, c]) => ({ nome, peso: c.peso / (soma || 1), pan: (c.x / c.peso / (R.largura || 1) - 0.5) * 1.5 }))
        .filter(f => f.peso >= 0.08);
      const camadas = camadasDe(R.z);
      if (!fatias.length) camadas.cama = 0;       // the empty space between clusters: only the wind
      m.definir({ fatias, camadas, cam: filtroDe(R.z), sala: limita(0.18 + R.giro * 0.35, 0, 0.7) + (receita(fatias[0]?.nome || 'pop').sala || 0) * 0.3, tempero: R.tempero, semente: R.semente });
      m.vento(limita(R.velocidade, 0, 1));
    }

    function mirar() {
      const lista = o.mira?.();
      if (lista) for (const [chave, g, pan, vel] of lista) m.ponto(chave, famDe[g], pan, vel);
    }

    function atualizar() {
      rotular();
      sessao();
      const on = audivel();
      if (on) {
        montar();
        if (!ac) return;
        clearTimeout(tDesliga);
        ac.resume?.();
        m.saida.gain.cancelScheduledValues(ac.currentTime);
        m.saida.gain.setTargetAtTime(1, ac.currentTime, 0.35);
        if (!relogio) relogio = setInterval(pulso, 25);
        return;
      }
      clearInterval(relogio); relogio = 0;
      if (!ac) return;
      m.saida.gain.cancelScheduledValues(ac.currentTime);
      m.saida.gain.setTargetAtTime(0, ac.currentTime, dormindo ? 1 : 0.14);
      clearTimeout(tDesliga);
      tDesliga = setTimeout(() => { if (!audivel()) ac.suspend?.(); }, dormindo ? 3500 : 700);
    }

    // A browser lets no page sound before a click, touch or key (a wheel doesn't count): any of them starts it,
    // and every one retries, since iOS only unlocks inside the gesture.
    function gesto() {
      ultimoGesto = performance.now();
      const primeiro = !ativado;
      ativado = true;
      dormindo = false;
      if (primeiro || !ac || ac.state !== 'running') atualizar();
    }
    for (const ev of ['pointerdown', 'pointerup', 'touchend', 'keydown', 'click']) document.addEventListener(ev, gesto, { capture: true, passive: true });
    document.addEventListener('visibilitychange', atualizar);

    const pv = o.previa;
    pv.addEventListener('play', () => { previaTocando = true; atualizar(); });
    for (const ev of ['pause', 'ended', 'emptied']) pv.addEventListener(ev, () => { previaTocando = false; atualizar(); });

    global.ouvirSomDasAbas?.(on => {
      outroSom = on;
      if (!on) ignorarOutro = false;
      atualizar();
    });

    // ♪ also stops a preview: one button that means "no more sound from this page", or "this one, not that one".
    function alternar() {
      const estava = vontade && !emEspera();
      if (!pv.paused) o.pararPrevia();
      if (estava) vontade = false;
      else { vontade = true; ignorarOutro = true; dormindo = false; }
      try { localStorage.setItem(CHAVE, vontade ? '1' : '0'); } catch {}
      atualizar();
      if (vontade && m) m.tap([0, 7], 0.6);
    }
    o.botao.addEventListener('click', alternar);
    rotular();

    return {
      alternar,
      // the map moved: not asleep
      mexeu() {
        ultimoGesto = performance.now();
        if (dormindo) { dormindo = false; atualizar(); }
      },
      tap(graus, vel) { if (audivel() && m) m.tap(graus, vel); },
      momento(graus, vel) { if (audivel() && m) m.swell(graus, vel); },
      estado() {
        let rms = 0;
        if (m) {
          const b = new Float32Array(m.medidor.fftSize);
          m.medidor.getFloatTimeDomainData(b);
          rms = Math.sqrt(b.reduce((a, x) => a + x * x, 0) / b.length);
        }
        return { vontade, espera: emEspera(), ativado, audivel: audivel(), previa: previaTocando, outroSom, dormindo, contexto: ac?.state ?? null, rms, ...(m ? m.estado() : {}) };
      },
    };
  }

  global.criarSomAtlas = criarSomAtlas;
  global.criarMotorSom = criarMotor;
  global.camadasSom = camadasDe;
  global.filtroSom = filtroDe;
})(window);
