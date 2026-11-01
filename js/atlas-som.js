// atlas-som.js — the music of /atlas: everything is synthesised here with Web Audio, no audio file.
// Classic script, loaded after atlas-receitas.js (RECEITAS_ATLAS) and som-abas.js. Reference for the mix is
// ../swissviz/design/sound.md; the choices made here are in tasks/generative-music-nav.md.
//
// criarMotor(ac) plays the recipes on any AudioContext, also an OfflineAudioContext (tests/atlas-som.spec.js
// renders with it). criarSomAtlas(o) decides when it sounds, and what the camera is looking at feeds it.
//
// One transport and one key, always: a bar is 96 ticks of a single clock and every family steps on it (its grid doubled
// or halved to sit near its own tempo). What is on screen writes the music: the families in view merge into one band
// (fundir()), however many they are, and the line reads the visible dots as a score (leitura, planoFrase()).
(function (global) {
  'use strict';

  const { familiaDe, receita, ESCALAS } = global.RECEITAS_ATLAS;
  const BARRA = 96, POR_SEMINIMA = 24;
  const EQ_HZ = [80, 200, 500, 1200, 3000, 8000];
  const NIVEL = { '.': 0, o: 0.38, x: 0.72, X: 1 };
  const GRAVES = new Set(['bumbo', 'surdo', 'zabumba']);      // the floor stays under a fill
  // The roles of a kit: when genres merge each has one owner. What isn't here is colour, and everybody keeps theirs.
  const PAPEL = { bumbo: 'chao', surdo: 'chao', zabumba: 'chao', caixa: 'tronco', aro: 'tronco', palma: 'tronco', chimbal: 'conducao', aberto: 'conducao', ganza: 'conducao', prato: 'conducao' };
  const MAX_GENEROS = 6;          // merging at once where the map mixes them
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

  // o: [wave, frequency ratio, cents, gain]; a wave may be a key of ONDAS. a/d/s/r: envelope. lp/env/q: lowpass, its
  // sweep, its resonance. fm: [ratio, index, seconds]. vogal: sung, through the formants of a vowel. vib: [Hz, cents, seconds to swell].
  // dist: goes through the family's distortion. corda: a plucked string (see CORDA), which replaces `o`.
  // ar: [Hz, Q, gain] of breath under the note. clique: [Hz, Q, seconds, gain], the burst that starts it.
  // liga: seconds a legato note takes to slide up from the one before.
  // corda: { seg, brilho (harmonics in the pluck), pua (pick position), perda (per pass), m (loop lowpass), corpo: [[Hz, r, mix]] }
  const VIOLAO = [[105, 0.994, 0.5], [205, 0.992, 0.35]], CAIXA_ACUSTICA = [[280, 0.99, 0.4], [520, 0.985, 0.25]];
  const TIMBRES = {
    violao: { corda: { seg: 2.2, brilho: 14, pua: 0.17, perda: 0.9965, m: 0.36, corpo: VIOLAO }, a: 0.001, d: 1.1, s: 0, r: 0.09, lp: 1700, env: 2600, g: 0.72 },
    violao7: { corda: { seg: 2.2, brilho: 10, pua: 0.2, perda: 0.997, m: 0.36, corpo: VIOLAO }, a: 0.002, d: 1.1, s: 0, r: 0.08, lp: 1100, env: 1200, g: 0.82 },
    cavaco: { corda: { seg: 0.9, brilho: 30, pua: 0.13, perda: 0.994, m: 0.42, corpo: CAIXA_ACUSTICA }, a: 0.001, d: 1.1, s: 0, r: 0.03, lp: 3200, env: 3200, g: 0.5 },
    bandolim: { corda: { seg: 1, brilho: 30, pua: 0.11, perda: 0.994, m: 0.44, corpo: CAIXA_ACUSTICA }, o2: 4, a: 0.001, d: 1.1, s: 0, r: 0.05, lp: 3600, env: 2200, g: 0.46 },
    banjo: { corda: { seg: 0.6, brilho: 40, pua: 0.09, perda: 0.99, m: 0.46, corpo: [[420, 0.985, 0.5]] }, a: 0.001, d: 1.1, s: 0, r: 0.03, lp: 4200, env: 2000, g: 0.46 },
    guitarra: { corda: { seg: 1.8, brilho: 18, pua: 0.14, perda: 0.9975, m: 0.4 }, a: 0.001, d: 1.1, s: 0, r: 0.07, lp: 2100, env: 1500, g: 0.56 },
    dist: { o: [['sawtooth', 1, -6, 0.5], ['sawtooth', 1, 6, 0.5]], a: 0.003, d: 0.2, s: 0.8, r: 0.05, g: 0.32, dist: 1 },
    baixo: { o: [['triangle', 1, 0, 0.9], ['sawtooth', 1, 0, 0.2]], clique: [1100, 1, 0.012, 0.05], a: 0.004, d: 0.3, s: 0.5, r: 0.06, lp: 700, env: 500, liga: 0.04, g: 0.62 },
    contrabaixo: { o: [['sine', 1, 0, 0.8], ['triangle', 1, 0, 0.5]], clique: [700, 1, 0.02, 0.06], a: 0.008, d: 0.4, s: 0.1, r: 0.08, lp: 650, g: 0.66 },
    sub: { o: [['sine', 1, 0, 0.9], ['triangle', 2, 0, 0.16]], a: 0.005, d: 0.3, s: 0.9, r: 0.09, g: 0.72 },
    acid: { o: [['sawtooth', 1, 0, 0.9]], a: 0.002, d: 0.16, s: 0.25, r: 0.05, lp: 260, env: 2400, q: 11, liga: 0.06, g: 0.34 },
    rhodes: { o: [['sine', 1, 0, 0.9]], fm: [1, 1.8, 0.5], clique: [2400, 2, 0.012, 0.03], a: 0.003, d: 1.2, s: 0, r: 0.2, g: 0.3 },
    piano: { o: [['piano', 1, 2, 0.5], ['piano', 1, -2, 0.5]], clique: [1300, 1, 0.018, 0.06], a: 0.002, d: 1.5, s: 0, r: 0.14, lp: 1500, env: 3600, g: 0.42 },
    cravo: { corda: { seg: 1, brilho: 70, pua: 0.07, perda: 0.995, m: 0.46 }, a: 0.001, d: 1.1, s: 0, r: 0.05, g: 0.3 },
    orgao: { o: [['sine', 1, 0, 0.7], ['sine', 2, 0, 0.4], ['sine', 3, 0, 0.3], ['sine', 4, 0, 0.12]], clique: [2800, 1, 0.006, 0.05], a: 0.008, d: 0.1, s: 0.85, r: 0.08, vib: [6.6, 6, 0.02], g: 0.2 },
    sanfona: { o: [['palheta', 1, -6, 0.5], ['palheta', 1, 6, 0.5]], ar: [1800, 1.2, 0.05], a: 0.022, d: 0.1, s: 0.8, r: 0.07, lp: 2600, q: 1, vib: [5.5, 4, 0.2], liga: 0.02, g: 0.4 },
    sopro: { o: [['metal', 1, 0, 0.9]], ar: [1500, 0.9, 0.08], a: 0.035, d: 0.15, s: 0.7, r: 0.08, lp: 900, env: 2000, vib: [5.2, 7, 0.28], liga: 0.04, g: 0.32 },
    cordas: { o: [['sawtooth', 1, -6, 0.4], ['sawtooth', 1, 6, 0.4]], a: 0.22, d: 0.4, s: 0.85, r: 0.5, lp: 1800, vib: [5, 5, 0.3], liga: 0.08, g: 0.2 },
    flauta: { o: [['sine', 1, 0, 0.9], ['triangle', 2, 0, 0.07]], ar: [2600, 1.2, 0.09], clique: [3000, 1, 0.02, 0.02], a: 0.04, d: 0.1, s: 0.8, r: 0.07, vib: [5, 9, 0.25], liga: 0.03, g: 0.3 },
    apito: { o: [['sine', 1, 0, 0.9]], a: 0.008, d: 0.05, s: 0.7, r: 0.02, vib: [28, 40, 0.001], g: 0.12 },
    vibrafone: { o: [['sine', 1, 0, 0.9]], fm: [4, 0.7, 0.2], a: 0.002, d: 1.6, s: 0, r: 0.3, vib: [4.5, 4, 0.1], g: 0.26 },
    sino: { o: [['sine', 1, 0, 0.9]], fm: [3.5, 1.4, 0.3], a: 0.002, d: 1.8, s: 0, r: 0.4, g: 0.17 },
    caixinha: { o: [['sine', 1, 0, 0.9]], fm: [5.4, 0.8, 0.1], a: 0.001, d: 0.7, s: 0, r: 0.15, g: 0.22 },
    lead: { o: [['sawtooth', 1, 0, 0.5], ['square', 1, 6, 0.3]], a: 0.004, d: 0.2, s: 0.5, r: 0.08, lp: 1600, env: 1200, liga: 0.03, g: 0.2 },
    chip: { o: [['square', 1, 0, 0.7]], a: 0.001, d: 0.1, s: 0.5, r: 0.02, lp: 5000, g: 0.14 },
    voz: { o: [['sawtooth', 1, 0, 0.9]], ar: [3000, 1.4, 0.02], clique: [5200, 1.2, 0.03, 0.02], a: 0.05, d: 0.2, s: 0.8, r: 0.14, vogal: 1, vib: [5.2, 16, 0.35], liga: 0.07, g: 0.5 },
    coro: { o: [['sawtooth', 1, -11, 0.4], ['sawtooth', 1, 2, 0.4], ['sawtooth', 2, 7, 0.22]], ar: [3200, 1.2, 0.03], a: 0.09, d: 0.2, s: 0.85, r: 0.2, vogal: 1, vib: [4.8, 12, 0.3], liga: 0.08, g: 0.46 },
    pad: { o: [['sawtooth', 1, -8, 0.5], ['sawtooth', 1, 8, 0.5]], a: 1.6, d: 1, s: 0.85, r: 2.4, lp: 820, g: 0.13 },
    padQuente: { o: [['triangle', 1, -5, 0.7], ['sine', 2, 5, 0.3]], a: 1.4, d: 1, s: 0.85, r: 2.2, lp: 1200, g: 0.26 },
  };

  // Formants of the sung vowels a, e, i, o, u, as [Hz, Q]: a line that changes vowel reads as singing, a fixed filter as a synth.
  const VOGAIS = [[[800, 7], [1200, 9], [2500, 8]], [[420, 7], [2000, 10], [2600, 9]], [[310, 6], [2300, 11], [3000, 9]], [[470, 7], [820, 8], [2600, 8]], [[340, 6], [720, 7], [2500, 8]]];

  // Harmonic spectra of what a plain wave can't do, for createPeriodicWave: first value is the fundamental.
  const ONDAS = {
    piano: [1, 0.62, 0.42, 0.3, 0.18, 0.14, 0.1, 0.07, 0.05, 0.03],
    palheta: [1, 0.2, 0.75, 0.14, 0.55, 0.1, 0.36, 0.08, 0.2, 0.06, 0.12],     // a reed: strong odd harmonics
    metal: [0.6, 0.8, 1, 0.85, 0.65, 0.5, 0.36, 0.26, 0.18, 0.12, 0.08, 0.05], // brass: the peak is above the fundamental
  };

  // Where each instrument sits inside its family's stereo image.
  const PANO = {
    caixa: -0.04, aro: -0.06, chimbal: 0.28, aberto: 0.28, prato: -0.3, tamborim: 0.38, ganza: -0.4, pandeiro: -0.22, repique: 0.2,
    cuica: 0.5, agogo: -0.52, triangulo: 0.45, clave: 0.32, cowbell: 0.3, conga: -0.3, bongo: 0.35, palma: 0.06, estalo: 0.2,
    acorde: 0.24, mel: -0.14,
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
    // Cymbal metal, as the 808 makes it: six square waves at unrelated pitches, baked once so a hat costs one source.
    const metalico = ac.createBuffer(1, sr, sr);
    {
      const d = metalico.getChannelData(0);
      for (const f of [205.3, 304.4, 369.6, 522.7, 540, 800]) {
        const p = sr / (f * 3.1);
        for (let i = 0; i < d.length; i++) d[i] += (i % p < p / 2 ? 1 : -1) / 6;
      }
    }
    // Two spaces, noise dying away with its highs first: a long room and a short one for bands that play close.
    function espaco(seg, queda) {
      const ir = ac.createBuffer(2, Math.round(sr * seg), sr);
      for (let c = 0; c < 2; c++) {
        const d = ir.getChannelData(c);
        let lp = 0;
        for (let i = 0; i < d.length; i++) {
          const x = i / d.length;
          lp += (0.9 - 0.8 * x) * ((Math.random() * 2 - 1) - lp);
          d[i] = lp * (1 - x) ** queda * Math.min(1, i / (0.012 * sr)) * 0.5;
        }
      }
      return ir;
    }
    const verb = ac.createConvolver();
    verb.buffer = espaco(2.2, 3);
    const sala = ac.createGain();
    sala.gain.value = 0.2;
    sala.connect(verb); verb.connect(saida);
    const verbCurto = ac.createConvolver();
    verbCurto.buffer = espaco(0.5, 2);
    const quarto = ac.createGain();
    quarto.gain.value = 0;
    quarto.connect(verbCurto); verbCurto.connect(saida);
    // the camera's lowpass, over everything but the dots crossing the sights
    const leito = ac.createGain();
    leito.gain.value = 0.9;
    leito.connect(saida); leito.connect(sala); leito.connect(quarto);
    const cam = ac.createBiquadFilter();
    cam.frequency.value = 900; cam.Q.value = 0.4;
    cam.connect(leito);
    // percussion has its own path: opens an octave ahead of the rest, and sends less to the rooms
    const leitoP = ac.createGain();
    leitoP.gain.value = 0.9;
    leitoP.connect(saida);
    const envioP = ac.createGain();
    envioP.gain.value = 0.3;
    leitoP.connect(envioP); envioP.connect(sala); envioP.connect(quarto);
    const camP = ac.createBiquadFilter();
    camP.frequency.value = 1800; camP.Q.value = 0.4;
    camP.connect(leitoP);
    // tape echo for the families that ask for it (`eco`)
    const ecoIn = ac.createGain(), ecoD = ac.createDelay(2), ecoLp = ac.createBiquadFilter(), ecoHp = ac.createBiquadFilter(), ecoFb = ac.createGain();
    ecoLp.frequency.value = 2200; ecoHp.type = 'highpass'; ecoHp.frequency.value = 320;
    ecoFb.gain.value = 0;
    ecoIn.connect(ecoD); ecoD.connect(ecoLp); ecoLp.connect(ecoHp); ecoHp.connect(ecoFb); ecoFb.connect(ecoD); ecoHp.connect(cam);
    // each family's distorted guitars go through one amp, so a power chord intermodulates as it should
    const curvaDist = Float32Array.from({ length: 1025 }, (_, i) => Math.tanh(((i - 512) / 512) * 7));
    const amps = new WeakMap();
    function ampDe(dest) {
      let e = amps.get(dest);
      if (e) return e;
      e = ac.createGain();
      const ws = ac.createWaveShaper(), hp = ac.createBiquadFilter(), lp = ac.createBiquadFilter(), g = ac.createGain();
      ws.curve = curvaDist; ws.oversample = '2x';
      hp.type = 'highpass'; hp.frequency.value = 95;
      lp.frequency.value = 3200; lp.Q.value = 0.8;     // the cabinet
      g.gain.value = 0.3;
      e.connect(ws); ws.connect(hp); hp.connect(lp); lp.connect(g); g.connect(dest);
      amps.set(dest, e);
      return e;
    }
    // wind: as fast as the map moves
    const vento = ac.createBufferSource();
    vento.buffer = ruido; vento.loop = true;
    const ventoF = ac.createBiquadFilter();
    ventoF.type = 'bandpass'; ventoF.frequency.value = 600; ventoF.Q.value = 0.8;
    const ventoG = ac.createGain();
    ventoG.gain.value = 0;
    vento.connect(ventoF); ventoF.connect(ventoG); ventoG.connect(saida);
    vento.start();

    const ondas = new Map();
    function onda(nome) {
      let w = ondas.get(nome);
      if (!w) {
        const im = Float32Array.from([0, ...ONDAS[nome]]);
        w = ac.createPeriodicWave(new Float32Array(im.length), im);
        ondas.set(nome, w);
      }
      return w;
    }

    // Plucked strings are Karplus-Strong: a burst of noise circling a short delay that loses its highs on every pass.
    // Too costly per note as a node graph, so a timbre bakes an octave at a time on first use, two takes of each,
    // and notes play them back at the rate that lands on pitch. Fast: about a millisecond a buffer.
    const CORDA = new Map();
    function assarCorda(C, m, tomada) {
      const N = Math.max(2, Math.round(sr / hz(m) - C.m));
      const len = Math.round(sr * C.seg), buf = ac.createBuffer(1, len, sr), d = buf.getChannelData(0), linha = new Float32Array(N);
      // The burst's brightness counts harmonics, not hertz: plain noise would spread a low string's energy over dozens
      // of them and leave its fundamental thin. Run twice around the loop, so it starts and ends at the same value.
      const k = 1 - Math.exp(-2 * Math.PI * C.brilho * hz(m) / sr);
      for (let i = 0; i < N; i++) linha[i] = hash(m, i, tomada) * 2 - 1;
      for (let p = 0, lp = 0; p < 2; p++) for (let i = 0; i < N; i++) { lp += k * (linha[i] - lp); linha[i] = lp; }
      for (let p = 0, lp = 0; p < 2; p++) for (let i = N - 1; i >= 0; i--) { lp += k * (linha[i] - lp); linha[i] = lp; }
      const orig = linha.slice(), pua = Math.max(1, Math.round(N * C.pua));
      for (let i = 0; i < N; i++) linha[i] = orig[i] - orig[(i + N - pua) % N];     // plucked this far from the bridge
      let ant = 0;
      for (let n = 0, i = 0; n < len; n++) {
        const x = linha[i];
        linha[i] = C.perda * ((1 - C.m) * x + C.m * ant);
        ant = x; d[n] = x;
        i = i + 1 === N ? 0 : i + 1;
      }
      for (const [f, r, mix] of C.corpo || []) {      // the wooden body: a resonance or two ringing with the string
        const c = 2 * r * Math.cos(2 * Math.PI * f / sr), r2 = r * r;
        let y1 = 0, y2 = 0;
        for (let n = 0; n < len; n++) {
          const y = d[n] + c * y1 - r2 * y2;
          y2 = y1; y1 = y;
          d[n] += y * mix * (1 - r) * 6;
        }
      }
      let pico = 0.001;
      for (let n = 0; n < len; n++) pico = Math.max(pico, Math.abs(d[n]));
      for (let n = 0; n < len; n++) d[n] /= pico;
      return { buf, f: sr / (N + C.m) };
    }
    function corda(nome, m, tomada) {
      const reg = 28 + 12 * Math.round((m - 28) / 12), k = `${nome}:${reg}:${tomada}`;
      let c = CORDA.get(k);
      if (!c) { c = assarCorda(TIMBRES[nome].corda, reg, tomada); CORDA.set(k, c); }
      return c;
    }

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

    function nota(nome, m, t0, dur, vel, dest, brilho = 1, desde = null) {
      const T = TIMBRES[nome], f = hz(m), g = ac.createGain();
      // no two notes alike: a repeated note that comes out identical is what gives a machine away
      const a1 = hash(m, Math.round(t0 * 1000), 1), a2 = hash(m, Math.round(t0 * 1000), 2);
      const fino = (a1 - 0.5) * 5, pk = vel * T.g * (0.93 + 0.14 * a2);
      const fim = t0 + dur + T.r * 1.5 + 0.05;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(pk, t0 + T.a);
      g.gain.setTargetAtTime(pk * T.s, t0 + T.a, T.d / 3);
      g.gain.setTargetAtTime(0, t0 + Math.max(dur, T.a), T.r / 3);
      let topo = g;
      if (T.lp) {
        const lp = ac.createBiquadFilter();
        const base = T.lp * brilho * (0.9 + 0.2 * a1) * (0.7 + 0.5 * Math.min(1, vel));   // hit harder, brighter
        if (T.q) lp.Q.value = T.q;
        lp.frequency.setValueAtTime(base + (T.env || 0) * vel, t0);
        if (T.env) lp.frequency.setTargetAtTime(base, t0, Math.max(T.d, 0.08) / 2.5);
        g.connect(lp);
        topo = lp;
      }
      if (T.vogal) {
        const soma = ac.createGain();
        for (const [fq, q] of VOGAIS[Math.floor(a2 * 5)]) {
          const b = ac.createBiquadFilter();
          b.type = 'bandpass'; b.frequency.value = fq; b.Q.value = q;
          topo.connect(b); b.connect(soma);
        }
        topo = soma;
      }
      topo.connect(T.dist ? ampDe(dest) : dest);
      const fontes = [];
      if (T.clique) { const [fq, q, dec, ganho] = T.clique; chiado(t0, 'bandpass', fq, q, dec, ganho * vel * 2, dest); }
      if (T.ar) {
        const s = ac.createBufferSource(), b = ac.createBiquadFilter(), ag = ac.createGain();
        s.buffer = ruido; s.loop = true;
        b.type = 'bandpass'; b.frequency.value = T.ar[0]; b.Q.value = T.ar[1];
        ag.gain.value = T.ar[2] / T.g;
        s.connect(b); b.connect(ag); ag.connect(g);
        s.start(t0, a1 * 1.5); s.stop(fim);
        fontes.push(s);
      }
      if (T.corda) {
        const c = corda(nome, m, a2 < 0.5 ? 0 : 1), mk = [[c, 0, 1]];
        if (T.o2) mk.push([corda(nome, m, a2 < 0.5 ? 1 : 0), T.o2, 0.7]);     // a pair of strings, as on a mandolin
        for (const [cc, cents, ganho] of mk) {
          const s = ac.createBufferSource(), og = ac.createGain();
          s.buffer = cc.buf;
          s.playbackRate.value = f / cc.f; s.detune.value = fino + cents;
          og.gain.value = ganho;
          s.connect(og); og.connect(g);
          s.start(t0); s.stop(fim);
          fontes.push(s);
        }
        viva(g, fontes, t0, fim);
        return;
      }
      let lfo = null;
      if (T.vib) {
        lfo = ac.createOscillator();
        const prof = ac.createGain();
        lfo.frequency.value = T.vib[0];
        prof.gain.setValueAtTime(0, t0);                       // vibrato arrives after the note has settled
        prof.gain.linearRampToValueAtTime(T.vib[1], t0 + T.vib[2]);
        lfo.connect(prof);
        lfo.prof = prof;
        lfo.start(t0); lfo.stop(fim);
        fontes.push(lfo);
      }
      for (const [tipo, razao, cents, ganho] of T.o) {
        const os = ac.createOscillator(), og = ac.createGain();
        if (ONDAS[tipo]) os.setPeriodicWave(onda(tipo)); else os.type = tipo;
        if (desde !== null && T.liga) {
          os.frequency.setValueAtTime(hz(desde) * razao, t0);
          os.frequency.exponentialRampToValueAtTime(f * razao, t0 + T.liga);
        } else os.frequency.setValueAtTime(f * razao, t0);
        os.detune.value = cents + fino; og.gain.value = ganho;
        if (lfo) lfo.prof.connect(os.detune);
        if (T.fm) {
          const mod = ac.createOscillator(), mg = ac.createGain(), [rz, ind, tf] = T.fm;
          mod.frequency.value = f * razao * rz;
          mg.gain.setValueAtTime(f * ind * (0.35 + 0.85 * Math.min(1, vel)), t0);
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
      const os = ac.createOscillator(), g = ac.createGain(), k = 1 + (hash(t * 1000, f0) - 0.5) * 0.025;
      os.type = tipo;
      os.frequency.setValueAtTime(f0 * k, t);
      os.frequency.exponentialRampToValueAtTime(f1 * k, t + Math.max(0.02, dec * 0.5));
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.0008, t + dec);
      os.connect(g); g.connect(dest);
      os.start(t); os.stop(t + dec + 0.02);
    }
    function chiado(t, tipo, f, q, dec, v, dest, fonte = ruido) {
      const s = ac.createBufferSource(), b = ac.createBiquadFilter(), g = ac.createGain();
      s.buffer = fonte; s.loop = true;
      b.type = tipo; b.frequency.value = f; b.Q.value = q;
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.0008, t + dec);
      s.connect(b); b.connect(g); g.connect(dest);
      s.start(t, hash(t * 1000) * fonte.duration * 0.75); s.stop(t + dec + 0.02);
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
      caixa(t, v, d) { tom(t, 220, 165, 0.1, 0.24 * v, d, 'triangle'); tom(t, 340, 260, 0.05, 0.1 * v, d, 'triangle'); chiado(t, 'bandpass', 2600, 0.6, 0.17, 0.42 * v, d); chiado(t, 'highpass', 5000, 0.7, 0.1, 0.12 * v, d); },
      aro(t, v, d) { tom(t, 1650, 1400, 0.025, 0.2 * v, d, 'square'); chiado(t, 'bandpass', 3000, 2, 0.03, 0.2 * v, d); },
      palma(t, v, d) { for (const a of [0, 0.011, 0.022]) chiado(t + a, 'bandpass', 1500, 1.4, 0.05, 0.26 * v, d); chiado(t + 0.03, 'bandpass', 1500, 1, 0.13, 0.26 * v, d); },
      chimbal(t, v, d) { chiado(t, 'highpass', 7000, 0.7, 0.05, 0.3 * v, d, metalico); chiado(t, 'highpass', 9000, 0.7, 0.03, 0.06 * v, d); },
      aberto(t, v, d) { chiado(t, 'highpass', 6500, 0.7, 0.28, 0.28 * v, d, metalico); },
      prato(t, v, d) { chiado(t, 'highpass', 4500, 0.7, 0.7, 0.2 * v, d, metalico); chiado(t, 'highpass', 7000, 0.7, 0.4, 0.05 * v, d); metal(t, 2400, 1.48, 0.7, 0.3, 0.03 * v, d); },
      tamborim(t, v, d) { tom(t, 900, 780, 0.055, 0.2 * v, d, 'triangle'); chiado(t, 'highpass', 4500, 0.7, 0.03, 0.14 * v, d); },
      ganza(t, v, d) { chiado(t, 'bandpass', 6200, 1.1, 0.05, 0.2 * v, d); },
      pandeiro(t, v, d) { chiado(t, 'bandpass', 6400, 2, 0.08, 0.24 * v, d, metalico); tom(t, 310, 250, 0.06, 0.12 * v, d); },
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
    const ID = Object.fromEntries(Object.keys(PERC).map((k, i) => [k, i + 1]));

    // ── the transport ──
    const vozes = new Map();      // family -> { r, alvo, peso, g, gp, d, pan, panP, subs, mult }
    let bpm = 100, bpmAlvo = 100, tick = 0, barra = -1, tProx = ac.currentTime + 0.06;
    let regente = null, acorde = null, seguinte = null, modo = 'maior', tonica = 0;
    let camadas = { cama: 1, perc: 0, baixo: 0, acorde: 0, mel: 0 };
    let tempero = null, semente = 1, cama = { fim: 0, raiz: -1 };
    let melodista = null, frase = null, grauMel = 0, ultimaMel = null, leitura = null, lugar = { x: 0, y: 0, vel: 0 };
    let fusao = null, baixista = null, comper = null;
    let forma = { virada: 0, secao: 0, b: false, entrada: false, parada: false };

    function voz(nome) {
      let v = vozes.get(nome);
      if (v) return v;
      const g = ac.createGain(), gp = ac.createGain(), d = ac.createGain(), pan = ac.createStereoPanner(), panP = ac.createStereoPanner();
      g.gain.value = 0; gp.gain.value = 0;
      const r = receita(nome);
      // the family's measured curve: what its real tracks have in each band that a clean synth doesn't (r.eq, in dB)
      const faixa = (de, para) => {
        let n = de;
        if (r.eq) r.eq.forEach((db, i) => {
          if (!db) return;
          const b = ac.createBiquadFilter();
          b.type = 'peaking'; b.frequency.value = EQ_HZ[i]; b.Q.value = 0.9; b.gain.value = db;
          n.connect(b); n = b;
        });
        n.connect(para);
      };
      d.connect(g); faixa(g, pan); pan.connect(cam);
      faixa(gp, panP); panP.connect(camP);
      v = { nome, r, alvo: 0, peso: 0, g, gp, d, pan, panP, subs: new Map(), mult: 1, hits: 0, grau: 0, frase: null, vozeado: [], chaveV: '', ultima: null };
      if (r.eco) { v.eco = ac.createGain(); v.eco.gain.value = r.eco.n; v.eco.connect(ecoIn); }
      vozes.set(nome, v);
      return v;
    }
    // Each instrument of a family has its own place in the image; `perc` takes the drier, brighter path.
    function sub(v, nome, perc = false) {
      let p = v.subs.get(nome);
      if (p) return p;
      p = ac.createStereoPanner();
      p.pan.value = PANO[nome] ?? 0;
      p.connect(perc ? v.gp : v.d);
      if (v.eco && v.r.eco.em.includes(nome)) p.connect(v.eco);
      v.subs.set(nome, p);
      return p;
    }

    // What the region asks for. `fatias`: [{ nome, peso, pan }], strongest first, summing to about 1.
    function definir({ fatias, cam: fc, sala: s, cam_tau = 0.35, ...resto }, instantaneo = false) {
      for (const v of vozes.values()) v.alvo = 0;
      for (const f of fatias) { const v = voz(f.nome); v.alvo = f.peso; v.panAlvo = f.pan || 0; }
      const t = ac.currentTime, tau = instantaneo ? 0.001 : 1;
      for (const v of vozes.values()) {
        v.peso = v.alvo > v.peso ? v.peso + (v.alvo - v.peso) * (instantaneo ? 1 : 0.2) : v.peso + (v.alvo - v.peso) * (instantaneo ? 1 : 0.15);
        // equal power: five genres at a fifth each must sound as full as one, or the mixed places go quiet
        const ganho = Math.sqrt(v.alvo) * v.r.nivel;
        v.g.gain.setTargetAtTime(ganho, t, tau);
        v.gp.gain.setTargetAtTime(ganho, t, tau);
        const p = limita(v.panAlvo || 0, -0.8, 0.8);
        v.pan.pan.setTargetAtTime(p, t, 0.6);
        v.panP.pan.setTargetAtTime(p, t, 0.6);
        if (v.alvo === 0 && v.peso < 0.015 && v !== regente) {
          setTimeout(() => { for (const n of [v.g, v.gp, v.pan, v.panP]) n.disconnect(); }, 4000);
          vozes.delete(v.nome);
        }
      }
      if (fc) {
        cam.frequency.setTargetAtTime(fc, t, cam_tau);
        camP.frequency.setTargetAtTime(Math.min(fc * 2, 16000), t, cam_tau);
      }
      if (s !== undefined) {
        const curta = (fatias[0] && receita(fatias[0].nome).curta) ?? 0;
        sala.gain.setTargetAtTime(s * (1 - curta), t, 0.8);
        quarto.gain.setTargetAtTime(s * curta * 1.4, t, 0.8);
      }
      if (resto.camadas) camadas = resto.camadas;
      tempero = resto.tempero ?? null;
      if (resto.semente) semente = resto.semente;
      leitura = resto.leitura ?? null;
      lugar = resto.lugar ?? { x: hash(semente, 1) * 9, y: hash(semente, 2) * 9, vel: 0 };
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
      if (barra % 4 === 0 || !acorde) {         // mode and key only at a phrase: a small move shouldn't flip them
        modo = modoDe(r);
        tonica = tempero?.tonica ?? r.tonica;
      }
      fundir();
      bpmAlvo = dobra(fusao ? fusao.bpm : tempoAlvo(r));
      for (const v of vozes.values()) {
        v.hits = 0;
        const alvo = v === regente ? tempoAlvo(r) : v.r.bpm;
        let mult = 2 ** limita(Math.round(Math.log2(alvo / bpmAlvo)), -1, 1);
        if (!Number.isInteger(BARRA / v.r.passos / mult)) mult = 1;
        v.mult = mult;
      }
      // The form: phrases of 8 bars in A A B A, a fill closing every 4th bar and a longer one every 8th, a stop
      // before the turn of 16, a cymbal on the way in. A loop that never does this is what sounds like a loop.
      const fr = barra % 8, secao = Math.floor(barra / 8) % 4;
      forma = { virada: fr === 7 ? 2 : barra % 4 === 3 ? 1 : 0, secao, b: secao === 2, entrada: fr === 0 && barra > 0, parada: barra % 16 === 15 };
      const h = r.harmonia[modo];
      // only a held tonic from far away: harmony arrives with the rhythm
      const longe = camadas.acorde + camadas.baixo < 0.2;
      const desloca = forma.b && h.length >= 4 && h.length < 8 ? h.length >> 1 : 0;     // the B part starts elsewhere in the cycle
      // the genres in view share the chords too: every two bars someone's turn, as often as it weighs, on the same tonic
      const quadro = n => {
        const q = fusao && sorteia(fusao.vs, Math.floor(n / 2), 41);
        return q && q !== regente ? q.r.harmonia[modo] ?? q.r.harmonia[modoDe(q.r)] : h;
      };
      const grau = n => { const q = quadro(n); return q[(Math.floor(n / r.compassos) + desloca) % q.length]; };
      const a = longe ? h[0] : grau(barra), b = longe ? h[0] : grau(barra + 1);
      acorde = { raiz: (tonica + a.raiz) % 12, notas: a.notas };
      seguinte = { raiz: (tonica + b.raiz) % 12, notas: b.notas };
      if (regente.r.eco) {
        ecoD.delayTime.setTargetAtTime(regente.r.eco.t * 60 / bpm, t, 0.05);
        ecoFb.gain.setTargetAtTime(regente.r.eco.fb, t, 0.2);
      } else ecoFb.gain.setTargetAtTime(0, t, 0.4);
      const durBarra = 60 / bpm * 4;
      if (acorde.raiz !== cama.raiz || t >= cama.fim - durBarra) {
        const dur = Math.max(durBarra * r.compassos, 2.5);
        cama = { raiz: acorde.raiz, fim: t + dur };
        let n = 0;
        for (const v of [...vozes.values()].sort((x, y) => y.alvo - x.alvo)) {
          if (v.alvo < 0.12 || n++ > 1) continue;
          const notas = n === 1 ? acorde.notas.slice(0, 3) : [0, 7];
          // the bed is what plays from afar; once a band is in, it steps back, or everything reads as ambient
          const perto = v.r.banda ? 1 - (1 - v.r.camaPerto) * Math.max(camadas.perc, camadas.acorde) : 1;
          for (const x of notas) nota(v.r.cama, 48 + acorde.raiz + x, t, dur, 0.8 * camadas.cama * perto * v.r.mix.cama, sub(v, 'cama'));
        }
      }
    }

    // Where genres meet the map doesn't play two bands at once, it plays one band made of both, as `fatias` weigh them.
    // One tempo between theirs, one pocket averaged from their grooves, one bass that changes hands, and a kit where
    // each role (floor, backbeat, timekeeping) has one owner while the others fill only the gaps it leaves.
    function fundir() {
      const vs = [...vozes.values()].filter(v => v.alvo > 0.04).sort((a, b) => b.alvo - a.alvo);
      if (vs.length < 2 || !regente) { fusao = null; baixista = comper = regente; return; }
      const soma = vs.reduce((a, v) => a + v.alvo, 0), lead = tempoAlvo(regente.r);
      let lg = 0, swing = 0;
      const bolso = [0, 0, 0, 0], dono = {};
      for (const v of vs) {
        const w = v.alvo / soma, b = v === regente ? lead : v.r.bpm;
        lg += w * Math.log2(b * 2 ** Math.round(Math.log2(lead / b)));     // half or double time counts as the same pulse
        swing += w * v.r.swing;
        const c = v.r.passos === 16 && v.r.groove?.cel;
        if (c) for (let i = 0; i < 4; i++) bolso[i] += w * c[i % c.length];
        for (const inst in v.r.perc) { const p = PAPEL[inst]; if (p && !dono[p]) dono[p] = v; }
      }
      fusao = { bpm: 2 ** lg, swing, bolso, dono, vs };
      baixista = sorteia(vs.filter(v => v.r.baixo), Math.floor(barra / 4), 43) ?? regente;
      comper = sorteia(vs.filter(v => v.r.acorde), Math.floor(barra / 2), 47) ?? regente;
    }
    // One of them, as often as it weighs, always the same for the same bar: over a long stretch each genre gets its share.
    function sorteia(lista, n, canal) {
      if (!lista.length) return null;
      let x = hash(n, canal) * lista.reduce((a, v) => a + v.alvo, 0);
      for (const v of lista) { x -= v.alvo; if (x <= 0) return v; }
      return lista[0];
    }
    // Does the `papel` owner hit at this point of the bar? Patterns on other grids count as free.
    function ocupado(v, pat) {
      const passo = BARRA / v.r.passos / v.mult;
      if (tick % passo) return false;
      return pat[(tick / passo) % pat.length] !== '.';
    }
    function donoToca(dono, papel) {
      for (const inst in dono.r.perc) if (PAPEL[inst] === papel && ocupado(dono, dono.r.perc[inst])) return true;
      return false;
    }

    // Steps until the pattern's next hit: how long a note may ring.
    function ateProxima(p, s) {
      for (let j = 1; j <= p.length; j++) if (p[(s + j) % p.length] !== '.') return j;
      return p.length;
    }

    // A chord as a hand would move to it: of its inversions in the register, the one that moves the least from the
    // last, without the root when the bass already plays it.
    function vozear(v, C) {
      const chave = `${acorde.raiz}|${acorde.notas}|${!C.arpejo}`;
      if (chave === v.chaveV) return v.vozeado;
      let xs = acorde.notas;
      if (!C.arpejo && xs.length >= 4 && camadas.baixo > 0.3 && v.r.baixo) xs = xs.filter(x => x % 12);
      const pcs = xs.map(x => (acorde.raiz + x) % 12), ant = v.vozeado, centro = C.reg ?? 60;
      let melhor = null, custo = Infinity;
      for (let lo = centro - 9; lo <= centro; lo++) for (let j = 0; j < pcs.length; j++) {
        let p = lo + ((pcs[j] - lo) % 12 + 12) % 12;
        const lista = [p];
        for (let k = 1; k < pcs.length; k++) { const q = pcs[(j + k) % pcs.length]; p += ((q - p) % 12 + 12) % 12 || 12; lista.push(p); }
        const c = (ant.length ? lista.reduce((s, x, i) => s + Math.abs(x - (ant[i] ?? ant[ant.length - 1])), 0) : 0)
          + Math.abs((lista[0] + lista[lista.length - 1]) / 2 - centro) * 0.3;
        if (c < custo) { custo = c; melhor = lista; }
      }
      v.vozeado = melhor; v.chaveV = chave;
      return melhor;
    }

    // The dots on screen are the score. `leitura` is what the camera sees, a piano roll of 4 rows by 16 columns around
    // the center: how many dots fall in each cell (m), and the note their height and identity ask for (g, in scale
    // degrees). The line reads it left to right, so panning slides the notes, zooming swaps them and a filter takes
    // away the ones it hides. Empty screen, no line. Without dots to read (the graph, an offline render) smooth noise over `lugar` plays that
    // part, so a small move still changes little. A place left alone keeps varying: each phrase reads a little further.
    function ruidoLugar(canal, i) {
      const f = 8, deriva = Math.floor(barra / 4) * 0.15;
      const x = lugar.x * f + deriva, y = lugar.y * f, ix = Math.floor(x), iy = Math.floor(y);
      const u = x - ix, w = y - iy, su = u * u * (3 - 2 * u), sw = w * w * (3 - 2 * w), c = (a, b) => hash(a, b, canal, i);
      const n = (c(ix, iy) * (1 - su) + c(ix + 1, iy) * su) * (1 - sw) + (c(ix, iy + 1) * (1 - su) + c(ix + 1, iy + 1) * su) * sw;
      return limita(0.5 + (n - 0.5) * 1.7, 0, 1);
    }
    // What a stretch of the roll holds: the top or bottom half, columns c0 to c1, so no dot falls between two readings.
    function lerFaixa(metade, c0, c1) {
      let m = 0, g = 0;
      for (let l = metade * 2; l < metade * 2 + 2; l++) for (let c = c0; c <= c1; c++) {
        const k = l * 16 + c, x = leitura ? leitura.m[k] : ruidoLugar(3, k), y = leitura ? leitura.g[k] : (ruidoLugar(5, k) - 0.5) * 10;
        m += x; g += x * y;
      }
      return { m, g: m ? g / m : 0 };
    }
    // Four bars: the top of the screen, the bottom, the top again, the bottom in half the time, leaving room to breathe. However many genres are in view there is one line: each note's rhythm and scale come from one of
    // them, as often as it weighs, and all of them sing it.
    function planoFrase(can) {
      const A = can[0], r = A.r, n = r.passos, sub8 = Math.max(1, Math.round(n / 8)), soma = can.reduce((a, v) => a + v.alvo, 0);
      const media = can.reduce((a, v) => a + v.r.mel.d * v.alvo, 0) / soma;
      const dens = limita(media * (tempero?.densidade ?? 0.7) * 2.6 * (1 + 0.4 * lugar.vel), 0.28, 0.9);
      const plano = new Map();
      [0, 1, 0, 1].forEach((metade, c) => {
        const cols = [], fim = c < 3 ? n : n >> 1;
        for (let i = 0; i < fim; i += sub8) {
          const c0 = Math.floor(i / fim * 16), c1 = Math.max(c0, Math.ceil((i + sub8) / fim * 16) - 1);
          cols.push({ i, ...lerFaixa(metade, c0, Math.min(15, c1)) });
        }
        const cheias = cols.filter(x => x.m > 0).sort((a, b) => b.m - a.m);
        const fortes = new Set(cheias.slice(0, Math.ceil(cols.length * dens)).map(x => x.i));
        const toca = [];
        for (const x of cols) {
          const M = (can.length > 1 ? sorteia(can, x.i * 7 + c, 77) : A).r;
          const tem = M.mel.r ? M.mel.r[Math.floor(x.i / n * M.passos) % M.mel.r.length] !== '.' && x.m > 0 : fortes.has(x.i);
          if (tem) toca.push({ ...x, esc: M.mel.escala || M.escala });
        }
        toca.forEach((x, k) => plano.set(c * n + x.i, { g: x.g, esc: x.esc, forte: x.i % (n >> 1) === 0, lg: Math.max(sub8, (toca[k + 1]?.i ?? n) - x.i) }));
      });
      if (plano.size) { const ult = plano.get(Math.max(...plano.keys())); ult.fim = true; ult.lg = n * 1.25; }
      return plano;
    }

    function passoMelodia(t0) {
      if (camadas.mel <= 0.02 || !acorde) { frase = null; return; }
      const can = [...vozes.values()].filter(v => v.r.mel && v.alvo > 0.05).sort((a, b) => b.alvo - a.alvo).slice(0, 4);
      melodista = can[0] ?? null;
      if (!melodista) return;
      const A = melodista, r = A.r, n = r.passos, st = BARRA / n;
      if (tick % st) return;
      if (forma.parada && tick % BARRA >= BARRA * 0.75 && regente?.r.virada.length) return;
      const p = (barra % 4) * n + (tick % BARRA) / st;
      if (!frase || p % Math.max(1, n >> 2) === 0) frase = planoFrase(can);     // every beat: what's on screen now
      const N = frase.get(p);
      if (!N) return;
      const esc = ESCALAS[N.esc] || ESCALAS.maior, dt = st * 60 / bpm / POR_SEMINIMA, s = tick / st;
      const salto = limita(Math.round(N.g - grauMel), -2, 2) || (hash(p, 13) < 0.5 ? 1 : -1);     // a line moves by step
      grauMel = limita(grauMel + salto, -esc.length - 2, esc.length + 2);
      const oit = Math.floor(grauMel / esc.length), pc = ((grauMel % esc.length) + esc.length) % esc.length;
      let m = r.faixa + (forma.b ? 2 : 0) + oit * 12 + ((tonica + 5) % 12) - 5 + esc[pc];
      // on the strong beats, a chord tone; the phrase ends on the root or the third
      if (N.forte || N.fim) {
        const alvos = (N.fim ? acorde.notas.slice(0, 2) : acorde.notas).map(x => (acorde.raiz + x) % 12);
        for (const d of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6]) if (alvos.includes(((m + d) % 12 + 12) % 12)) { m += d; break; }
      }
      const t = t0 + desvio(A, s, dt, 'mel'), dur = dt * N.lg * (N.fim ? 1 : 0.92);
      const liga = ultimaMel && t - ultimaMel.fim < 0.06 && Math.abs(m - ultimaMel.m) <= 4 ? ultimaMel.m : null;
      // every genre in view sings it on its own instrument, as loud as it weighs: the timbre crosses over with the map
      for (const v of can) {
        const base = v.r.mel.oit || 0, lig = liga === null ? null : liga + base;
        nota(v.r.mel.t, m + base, t, dur, (N.forte || N.fim ? 0.5 : 0.4) * camadas.mel * v.r.mix.mel, sub(v, 'mel'), 1, lig);
      }
      ultimaMel = { m, fim: t + dur };
    }

    // How far from the grid this instrument plays this step, in seconds: the swing, the genre's microtiming cell,
    // the instrument's habitual lean, and a little human error. The machines (`groove` absent) stay on the grid.
    function desvio(v, s, dt, papel) {
      const r = v.r, G = r.groove;
      let x = s % 2 ? r.swing * dt : 0;
      if (fusao && r.passos === 16) x = (s % 2 ? fusao.swing * dt : 0) + fusao.bolso[s % 4] * dt;
      else if (G) x += G.cel[s % G.cel.length] * dt;
      if (G) x += (G.atraso[papel] || 0) / 1000 + (hash(barra, s, ID[papel] || 90) - 0.5) * 2 * G.solto;
      return x;
    }
    const ultimaDoCompasso = (p, s, passos) => {
      for (let j = 1, i = s % passos; i + j < passos; j++) if (p[(s + j) % p.length] !== '.') return false;
      return true;
    };
    function raizBaixo(raiz) { return 36 + (raiz > 7 ? raiz - 12 : raiz); }

    function passoVoz(v, s, t0, dt) {
      const r = v.r, pos = tick % BARRA / BARRA, lider = v === regente;
      const inicio = lider && r.virada.length ? [1, 0.75, 0.5][forma.virada] : 1, emVirada = pos >= inicio;
      const dens = tempero?.densidade ?? 0.7, onda8 = 0.93 + 0.07 * (barra % 8) / 7;
      if (camadas.perc > 0.02) {
        if (lider && forma.entrada && pos === 0 && r.bateria) PERC.prato(t0, 1.2 * camadas.perc, sub(v, 'prato', true));
        for (const inst in r.perc) {
          const p = r.perc[inst], c = p[s % p.length];
          if (c === '.') continue;
          if (emVirada && !GRAVES.has(inst)) continue;
          const papel = PAPEL[inst], dono = fusao && papel && fusao.dono[papel];
          let fora = 1;
          if (dono && dono !== v) {          // not the owner of this role: only in its gaps, softer, and only with weight to back it
            if (v.alvo < 0.12 || donoToca(dono, papel)) continue;
            fora = 0.7;
          }
          if (forma.b && !GRAVES.has(inst) && inst !== 'caixa' && hash(ID[inst], Math.floor(barra / 8), 5) < 0.35) continue;
          if (c === 'o' && hash(s, ID[inst]) > dens + 0.2) continue;
          if (r.acaso && hash(barra, s, ID[inst]) < r.acaso) continue;
          const t = t0 + desvio(v, s, dt, inst);
          PERC[inst](t, fora * NIVEL[c] * camadas.perc * r.mix.perc * onda8 * (0.88 + 0.2 * hash(barra, s, ID[inst])), sub(v, inst, true));
          if (inst === 'bumbo' && r.bomba) {       // the kick pushes everything else down: the pump of a dance track
            v.d.gain.cancelScheduledValues(t);
            v.d.gain.setValueAtTime(1 - r.bomba, t);
            v.d.gain.setTargetAtTime(1, t + 0.01, 60 / bpm / 4);
          }
        }
        if (emVirada) {
          const f = (pos - inicio) / (1 - inicio);
          if (hash(barra, s, 21) < 0.55 + 0.4 * f) {
            const inst = r.virada[Math.floor(hash(barra, s, 22) * r.virada.length)];
            PERC[inst](t0 + desvio(v, s, dt, inst), (0.5 + 0.5 * f) * camadas.perc * r.mix.perc, sub(v, inst, true));
          }
        }
      }
      if (!acorde) return;
      if (lider && forma.parada && pos >= 0.75 && r.virada.length) return;     // the band stops, the drums answer
      const B = r.baixo;
      if (B && camadas.baixo > 0.02 && v === (baixista ?? regente)) {
        const c = B.p[s % B.p.length];
        if (c !== '.') {
          const t = t0 + desvio(v, s, dt, 'baixo');
          const fim = ultimaDoCompasso(B.p, s, r.passos * v.mult);
          let m;
          if (B.n === 'anda') {
            const ns = acorde.notas;
            m = raizBaixo(acorde.raiz) + [0, ns[1], ns[2], ns[3] ?? 9][v.hits & 3] - (v.hits & 2 ? 12 * (hash(barra, 6) < 0.5) : 0);
          } else m = raizBaixo(acorde.raiz) + B.n[v.hits % B.n.length];
          // the last note of the bar leads into the next chord, a semitone away
          if (fim && r.groove && seguinte && seguinte.raiz !== acorde.raiz && (B.n === 'anda' || hash(barra, 3) < 0.6)) {
            m = raizBaixo(seguinte.raiz) + (hash(barra, 4) < 0.5 ? 1 : -1);
          }
          v.hits++;
          const dur = dt * ateProxima(B.p, s) * (B.longo ? 1 : 0.85);
          nota(B.t, m, t, dur, NIVEL[c] * camadas.baixo * r.mix.baixo, sub(v, 'baixo'), tempero?.brilho ?? 1, hash(barra, s, 8) < 0.3 ? v.notaB ?? null : null);
          v.notaB = m;
        }
      }
      const C = r.acorde;
      if (C && camadas.acorde > 0.02) {
        const c = C.p[s % C.p.length];
        // whoever has the comp this stretch leads it; the others answer only in its gaps
        if (c !== '.' && !(fusao && comper && v !== comper && (v.alvo < 0.12 || ocupado(comper, comper.r.acorde.p)))) {
          const t = t0 + desvio(v, s, dt, 'acorde');
          const vel = NIVEL[c] * camadas.acorde * (C.suave ? 0.62 : 1) * onda8 * r.mix.acorde;
          const dur = dt * ateProxima(C.p, s) * (C.longo ? 1 : 0.8), d = sub(v, 'acorde');
          if (C.arpejo) {
            const a = C.arpejo[s % C.arpejo.length], ns = vozear(v, C);
            nota(C.t, ns[a % ns.length] + (a >= ns.length ? 12 : 0), t, dur * 2, vel, d, tempero?.brilho ?? 1);
          } else if (C.pesado) {
            const base = 52 + ((acorde.raiz + 8) % 12) - 8;
            for (const x of [0, 7]) nota(C.t, base - 12 + x, t, dur, vel, d);
          } else {
            // a strum goes down on the beat and up off it, and an upstroke is lighter
            const ns = vozear(v, C), sobe = s % 2 === 1, ord = sobe ? [...ns].reverse() : ns, passo = C.rasgueado ? 0.014 : 0.006;
            ord.forEach((x, j) => nota(C.t, x, t + j * passo, dur, vel * (sobe ? 0.6 : 0.72), d, tempero?.brilho ?? 1));
          }
        }
      }
    }

    function passo(t) {
      if (tick % BARRA === 0) virarBarra(t);
      for (const v of vozes.values()) {
        if (v.peso < 0.02 && v.alvo < 0.02) continue;
        const r = v.r, st = BARRA / r.passos / v.mult;
        if (tick % st === 0) passoVoz(v, tick / st, t, st * 60 / bpm / POR_SEMINIMA);
      }
      passoMelodia(t);
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
          acorde: acorde && { raiz: acorde.raiz, notas: acorde.notas }, notas: vivas.length, forma, fusao: fusao && { bpm: Math.round(fusao.bpm), bolso: fusao.bolso, baixista: baixista?.nome, generos: fusao.vs.length, donos: Object.fromEntries(Object.entries(fusao.dono).map(([p, v]) => [p, v.nome])) }, frase: frase && [...frase].map(([p, n]) => `${p}:${Math.round(n.g)}`),
          vozes: [...vozes.values()].map(v => ({ nome: v.nome, peso: +v.alvo.toFixed(3), mult: v.mult })),
        };
      },
    };
  }

  // Zoom to layers: from afar the bed alone, then the bass and the beat, the comp, the line.
  function camadasDe(z) {
    const l = Math.log2(Math.max(z, 0.5));
    return { cama: 1 - 0.45 * liso(l, 2, 4), baixo: liso(l, 0.3, 1.3), perc: liso(l, 0.5, 1.6), acorde: liso(l, 0.9, 2.2), mel: liso(l, 1.8, 3) };
  }
  // Muffled with the whole map in view, open by the time the rhythm is in: percussion is an octave ahead (camP).
  const filtroDe = z => limita(900 * z ** 1.4, 220, 16000);

  // o: { generos, regiao(), mira(), previa, pararPrevia(), botao, aoPrimeiroSom() }. regiao() says what the camera
  // sees: { pesos, somaX, largura, z, giro, velocidade, semente, tempero, leitura, lugar } or null while nothing can be read.
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
      const top = [...porFam].sort((a, b) => b[1].peso - a[1].peso).slice(0, MAX_GENEROS);
      const soma = top.reduce((a, [, c]) => a + c.peso, 0);
      const fatias = top.map(([nome, c]) => ({ nome, peso: c.peso / (soma || 1), pan: (c.x / c.peso / (R.largura || 1) - 0.5) * 1.5 }))
        .filter(f => f.peso >= 0.05);
      const camadas = camadasDe(R.z);
      if (!fatias.length) camadas.cama = 0;       // the empty space between clusters: only the wind
      m.definir({ fatias, camadas, cam: filtroDe(R.z), sala: limita(0.18 + R.giro * 0.35, 0, 0.7) + (receita(fatias[0]?.nome || 'pop').sala || 0) * 0.3, tempero: R.tempero, semente: R.semente, leitura: R.leitura, lugar: R.lugar });
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
