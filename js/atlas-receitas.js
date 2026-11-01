// atlas-receitas.js — what each genre sounds like on /atlas: a table of data, no audio code.
// js/atlas-som.js plays it. Classic script, no dependencies. Nothing here is a recording: every family is
// the handful of things that make a genre recognisable (its beat, its bass cell, its comp, its harmony,
// its scale), written down so a synth can play them.
//
// Patterns have one character per step: `.` rest, `o` ghost, `x` normal, `X` accent. A bar is 96 ticks, so
// `passos` must divide 96 (12 for ternary feels and 3/4, 16 for binary, 32 for trap hats). A pattern
// longer than `passos` spans several bars.
//
// `harm` is the chord per bar, as "<semitones from the tonic> <quality>", in major and/or minor; a family
// with only one of them always plays that one. `tonica` is the pitch class used when no track data says
// otherwise. Harmony is always the strongest family's: the others play their own rhythms over its chords,
// and that is what makes the space between two genres sound like a third thing instead of two songs.
(function (global) {
  'use strict';

  const ESCALAS = {
    maior: [0, 2, 4, 5, 7, 9, 11], menor: [0, 2, 3, 5, 7, 8, 10], dorico: [0, 2, 3, 5, 7, 9, 10],
    mixo: [0, 2, 4, 5, 7, 9, 10], lidiomixo: [0, 2, 4, 6, 7, 9, 10],     // the northeastern Brazilian scale
    pentaM: [0, 2, 4, 7, 9], pentam: [0, 3, 5, 7, 10], blues: [0, 3, 5, 6, 7, 10],
    harmonica: [0, 2, 3, 5, 7, 8, 11], frigiodom: [0, 1, 4, 5, 7, 8, 10], frigio: [0, 1, 3, 5, 7, 8, 10],
    tons: [0, 2, 4, 6, 8, 10],
  };

  const ACORDES = {
    '': [0, 4, 7], m: [0, 3, 7], 5: [0, 7, 12], 7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10],
    9: [0, 4, 10, 14], maj9: [0, 4, 11, 14], m9: [0, 3, 10, 14], 6: [0, 4, 7, 9], m6: [0, 3, 7, 9],
    sus: [0, 5, 7], m7b5: [0, 3, 6, 10], dim: [0, 3, 6, 9], '7b9': [0, 4, 10, 13],
  };

  // Every family inherits these.
  // `nivel` evens out how loud families come out: measured by rendering each one, a drone is 20 dB under a punk band.
  // `curta`: how much of the reverb is the short room, not the long one. `camaPerto`: what is left of the bed once a band plays.
  const BASE = { passos: 16, swing: 0, compassos: 1, escala: 'maior', tonica: 0, cama: 'pad', perc: {}, faixa: 72, nivel: 1, curta: 0.7, camaPerto: 0.3, mix: { cama: 1, perc: 1, baixo: 1, acorde: 1, mel: 1 } };

  // Groove is where a recording lives and a grid doesn't. `cel`: how far each step of the beat sits from the grid, as a
  // fraction of a step, repeating; samba's anticipated third and fourth sixteenths are its ginga. `atraso`: each
  // instrument's habitual lean, in ms: bass and backbeat behind in soul, hats ahead in boom bap. `solto`: human error, in s.
  const GROOVES = {
    samba: { cel: [0, 0.04, -0.09, -0.13], atraso: { surdo: 6, baixo: 5, acorde: -2 }, solto: 0.005 },
    bossa: { cel: [0, 0.02, -0.05, -0.07], atraso: { baixo: 6, mel: 8 }, solto: 0.005 },
    forro: { cel: [0, 0.02, -0.03, -0.11], atraso: { zabumba: 4, baixo: 4 }, solto: 0.005 },
    funk: { cel: [0, 0.1, 0, 0.1], atraso: { caixa: 5, baixo: -3 }, solto: 0.003 },
    soul: { cel: [0, 0.08, 0, 0.08], atraso: { caixa: 10, baixo: 8, acorde: 6, mel: 12 }, solto: 0.004 },
    boombap: { cel: [0], atraso: { caixa: 14, chimbal: -4, baixo: 10, acorde: 8 }, solto: 0.004 },
    reggae: { cel: [0, 0.16, 0, 0.16], atraso: { aro: 12, acorde: 8, baixo: 10 }, solto: 0.005 },
    rock: { cel: [0], atraso: { caixa: 6, chimbal: -2, baixo: 4 }, solto: 0.005 },
    punk: { cel: [0], atraso: { caixa: -3, baixo: -2 }, solto: 0.005 },
    jazz: { cel: [0], atraso: { prato: -4, baixo: -3, acorde: 8, mel: 10 }, solto: 0.007 },
    latino: { cel: [0], atraso: { conga: 4, baixo: 2 }, solto: 0.004 },
    humano: { cel: [0], atraso: {}, solto: 0.007 },
  };
  const GROOVE_DE = {
    samba: 'samba', batucada: 'samba', mpb: 'bossa', bossa: 'bossa', forro: 'forro', funk: 'funk', afrobeat: 'funk', soul: 'soul',
    boombap: 'boombap', downtempo: 'boombap', reggae: 'reggae', dub: 'reggae', ska: 'reggae', rock: 'rock', alternativo: 'rock',
    psicodelico: 'rock', dream: 'rock', postrock: 'rock', doom: 'rock', punk: 'punk', hardcore: 'punk', metal: 'punk', black: 'punk',
    jazz: 'jazz', jazzcontemporaneo: 'jazz', manouche: 'jazz', blues: 'jazz', salsa: 'latino', reggaeton: 'latino', bolero: 'latino', africa: 'latino',
  };
  const MAQUINAS = new Set(['house', 'techno', 'electro', 'synthpop', 'dnb', 'trap', 'nuvem', 'ambient', 'experimental', 'ruido']);
  const LONGAS = ['ambient', 'classica', 'cinema', 'contemporanea', 'dream', 'postrock', 'nuvem', 'balada', 'experimental', 'dub', 'black', 'neofolk', 'doom'];
  // `eco`: tape echo in beats, its feedback, its level and what goes into it. `bomba`: how far the kick ducks the rest.
  const EFEITOS = {
    dub: { eco: { t: 0.75, fb: 0.56, n: 0.7, em: ['acorde', 'aro', 'caixa'] } },
    reggae: { eco: { t: 0.75, fb: 0.28, n: 0.25, em: ['acorde', 'aro'] } },
    dream: { eco: { t: 0.75, fb: 0.42, n: 0.35, em: ['acorde', 'mel'] } },
    downtempo: { eco: { t: 0.75, fb: 0.32, n: 0.2, em: ['acorde', 'mel'] } },
    psicodelico: { eco: { t: 0.5, fb: 0.4, n: 0.3, em: ['mel'] } },
    house: { bomba: 0.55 }, techno: { bomba: 0.5 }, synthpop: { bomba: 0.3 }, electro: { bomba: 0.3 },
  };
  // Measured, not written: script/ajustar-som-atlas.py rewrites this block from each family's real tracks.
  // eq: dB at 80 200 500 1200 3000 8000 Hz. cel: their microtiming. bpm: their tempo. mix, camaPerto, curta, melT: the best found.
  // AJUSTES:INICIO
  const AJUSTES = {};
  // AJUSTES:FIM

  // Who plays a fill, from the first the family has; and where a timbre's line sits if the family doesn't say.
  const VIRADA = ['repique', 'caixa', 'conga', 'bongo', 'tamborim', 'palma', 'aro', 'pandeiro'];
  const REGISTRO = { voz: -12, guitarra: -12, sopro: -5 };

  const FAMILIAS = {
    // ── Brazil: the acervos' heart, so the most careful ones ──
    samba: {
      bpm: 104, tonica: 2, escala: 'maior', cama: 'padQuente',
      harm: { maior: '0 6|9 7|2 m7|7 7', menor: '0 m7|5 m7|10 7|7 7' },
      perc: { surdo: 'o...X...o...X...', tamborim: 'X.x.xx.x.x.xx.x.', ganza: 'xoooxoooxoooxooo', pandeiro: '..x...x...x..x..', cuica: '......x.......x.', agogo: 'x.x..x.x..x.x...' },
      baixo: { t: 'violao7', p: 'x...x...x...x.x.', n: [0, 7, 0, 7, 5] },
      acorde: { t: 'cavaco', p: 'x.xx.x.xx.xx.x.x' },
      mel: { t: 'flauta', d: 0.3, oit: 0 },
    },
    batucada: {
      bpm: 112, tonica: 7, cama: 'padQuente',
      harm: { maior: '0 |0 |5 |7 7' },
      perc: { surdo: 'X...x...X...x...', zabumba: '....X..x....X.x.', caixa: 'xoxoxxoxxoxoxxox', repique: '..x..x....x..x.x', tamborim: 'X.x.xx.x.x.xx.x.', agogo: 'x.x..x.x..x.x...', ganza: 'xoooxoooxoooxooo' },
      baixo: { t: 'violao7', p: 'x.......x.......', n: [0, 7] },
      mel: { t: 'apito', d: 0.1, oit: 12, r: 'x..x..x...x.....' },
    },
    bossa: {
      bpm: 132, tonica: 5, escala: 'maior', cama: 'padQuente',
      harm: { maior: '0 maj7|0 maj7|2 7|2 7|2 m7|7 7|0 maj7|7 7b9', menor: '0 m9|5 7|10 maj7|7 7b9' },
      perc: { aro: 'x..x..x...x..x..', ganza: 'xoxoxoxoxoxoxoxo', bumbo: 'x.....x.x.....x.' },
      baixo: { t: 'contrabaixo', p: 'x.....x.x.....x.', n: [0, 7, 7, 0] },
      acorde: { t: 'violao', p: 'x.x..x..x.x..x..', suave: 1 },
      mel: { t: 'flauta', d: 0.18, oit: 0, escala: 'maior' },
    },
    mpb: {
      bpm: 98, tonica: 9, escala: 'maior', cama: 'padQuente',
      harm: { maior: '0 maj9|9 m7|5 maj7|7 9', menor: '0 m7|5 9|10 maj7|4 7' },
      perc: { aro: '....x.......x...', bumbo: 'x.....x...x.....', ganza: 'xoxoxoxoxoxoxoxo', chimbal: 'x.o.x.o.x.o.x.o.' },
      baixo: { t: 'baixo', p: 'x..x..x.x.....x.', n: [0, 0, 7, 5, 7] },
      acorde: { t: 'violao', p: 'x..x..x.x..x..x.', suave: 1 },
      mel: { t: 'rhodes', d: 0.2 },
    },
    forro: {
      bpm: 124, tonica: 7, escala: 'lidiomixo', cama: 'padQuente',
      harm: { maior: '0 |0 7|5 |7 7', menor: '0 m|5 m|10 |7 7' },
      perc: { zabumba: 'X..x....X..x....', aro: '......x.......x.', triangulo: 'x.Xxx.Xxx.Xxx.Xx', ganza: 'xoxoxoxoxoxoxoxo' },
      baixo: { t: 'baixo', p: 'x..x....x..x....', n: [0, 7, 0, 7] },
      mel: { t: 'sanfona', d: 0.42, oit: 0, r: 'x.x.x..xx.x.x..x' },
      acorde: { t: 'sanfona', p: 'x...x...x...x...', suave: 1 },
    },
    // ── Latin ──
    salsa: {
      bpm: 188, tonica: 9, escala: 'menor',
      harm: { menor: '0 m|5 m|7 7|0 m' },
      perc: { clave: 'x..x..x...x.x...', conga: '....x.x.....x.xx', bongo: 'x.oox.oox.oox.oo', cowbell: 'x...x...x...x...' },
      baixo: { t: 'baixo', p: '...x..x....x..x.', n: [0, 7, 5, 7] },
      acorde: { t: 'piano', p: 'x.xx.xx.x.xx.xx.', suave: 1 },
      mel: { t: 'sopro', d: 0.22, oit: 0 },
    },
    reggaeton: {
      bpm: 92, tonica: 9, escala: 'menor',
      harm: { menor: '0 m|8 |3 |10 ' },
      perc: { bumbo: 'x...x...x...x...', caixa: '...x..x....x..x.', chimbal: 'x.x.x.x.x.x.x.x.' },
      baixo: { t: 'sub', p: 'x..x..x.x..x..x.', n: [0, 0, 0, 0] },
      acorde: { t: 'lead', p: 'x..x..x...x.....', suave: 1 },
      mel: { t: 'lead', d: 0.2 },
    },
    tango: {
      bpm: 118, tonica: 9, escala: 'harmonica', cama: 'cordas',
      harm: { menor: '0 m|0 m|7 7|7 7|5 m|0 m|7 7|0 m' },
      perc: {},
      baixo: { t: 'contrabaixo', p: 'X...x...X...x.x.', n: [0, 7, 0, 7, 7] },
      acorde: { t: 'sanfona', p: 'X...x...X...x...' },
      mel: { t: 'sanfona', d: 0.3 },
    },
    bolero: {
      bpm: 78, tonica: 4, escala: 'menor', cama: 'padQuente',
      harm: { menor: '0 m|5 m|7 7|0 m', maior: '0 maj7|9 m7|2 m7|7 7' },
      perc: { clave: 'x..x..x...x.x...', bongo: 'x.oox.oox.oox.oo', ganza: 'x.x.x.x.x.x.x.x.' },
      baixo: { t: 'contrabaixo', p: 'x.....x.x.......', n: [0, 7, 0] },
      acorde: { t: 'violao', p: 'x...x.x.x...x.x.', suave: 1 },
      mel: { t: 'bandolim', d: 0.24 },
    },
    // ── Folk and the world ──
    folk: {
      nivel: 1.3, bpm: 96, tonica: 7, cama: 'padQuente',
      harm: { maior: '0 |5 |9 m|7 ', menor: '0 m|10 |8 |7 m' },
      perc: { ganza: '..x...x...x...x.' },
      baixo: { t: 'violao', p: 'x.......x.......', n: [0, 7] },
      acorde: { t: 'violao', p: 'x.x.x.x.x.x.x.x.', arpejo: [0, 2, 1, 3, 0, 2, 1, 2], suave: 1 },
      mel: { t: 'flauta', d: 0.14, escala: 'pentaM' },
    },
    neofolk: {
      nivel: 1.4, bpm: 72, tonica: 2, escala: 'menor', cama: 'cordas',
      harm: { menor: '0 m|8 |3 |10 ' },
      perc: { surdo: 'x.......x.......' },
      baixo: { t: 'violao', p: 'x...............', n: [0] },
      acorde: { t: 'violao', p: 'x.x.x.x.x.x.x.x.', arpejo: [0, 1, 2, 3, 2, 1, 2, 3], suave: 1 },
      mel: { t: 'voz', d: 0.1 },
    },
    country: {
      nivel: 1.3, bpm: 120, tonica: 7,
      harm: { maior: '0 |0 |5 |7 7' },
      perc: { aro: '....x.......x...', bumbo: 'x.......x.......', ganza: 'x.x.x.x.x.x.x.x.' },
      baixo: { t: 'contrabaixo', p: 'x.......x.......', n: [0, 7] },
      acorde: { t: 'banjo', p: 'xxxxxxxxxxxxxxxx', arpejo: [0, 1, 2, 0, 1, 2, 0, 1], suave: 1 },
      mel: { t: 'bandolim', d: 0.2, escala: 'pentaM' },
    },
    africa: {
      bpm: 112, passos: 12, tonica: 7, cama: 'padQuente',
      harm: { maior: '0 |5 |0 |7 ' },
      perc: { agogo: 'x.x.xx.x.x.x', conga: 'x..o.xx..o.x', bumbo: 'x.....x.....', ganza: 'xooxooxooxoo' },
      baixo: { t: 'baixo', p: 'x..x.x..x.x.', n: [0, 0, 7, 5, 7] },
      acorde: { t: 'guitarra', p: 'x.x.xx.x.x.x', arpejo: [2, 1, 2, 0, 2, 1], suave: 1 },
      mel: { t: 'bandolim', d: 0.2, escala: 'pentaM' },
    },
    afrobeat: {
      bpm: 112, tonica: 2, escala: 'dorico',
      harm: { menor: '0 m7|0 m7|0 m7|5 9' },
      perc: { bumbo: 'x..x..x...x..x..', caixa: '....x..o....x.o.', chimbal: 'xoxoxoxoxoxoxoxo', clave: 'x..x...x..x.x...', conga: '..x.x...xx.x..x.' },
      baixo: { t: 'baixo', p: 'x.x..x.x..x.x.x.', n: [0, 0, 10, 0, 7, 5, 7] },
      acorde: { t: 'guitarra', p: 'x.xx.x.xx.x.x.xx', suave: 1 },
      mel: { t: 'sopro', d: 0.14, r: 'x..x..x.........' },
    },
    flamenco: {
      bpm: 112, passos: 12, tonica: 4, escala: 'frigiodom', cama: 'padQuente',
      harm: { maior: '0 |1 |0 |5 m', menor: '0 |1 |0 |5 m' },
      perc: { palma: 'X..x..X.x.X.' },
      baixo: { t: 'violao', p: 'x.....x.....', n: [0, 7] },
      acorde: { t: 'violao', p: 'X..x.xX.xxX.', rasgueado: 1 },
      mel: { t: 'violao', d: 0.3, oit: 12 },
    },
    fado: {
      nivel: 1.4, bpm: 76, tonica: 9, escala: 'menor', cama: 'padQuente',
      harm: { menor: '0 m|0 m|7 7|7 7|7 7|7 7|0 m|0 m' },
      perc: {},
      baixo: { t: 'violao', p: 'x...x...x...x...', n: [0, 7, 0, 7] },
      acorde: { t: 'bandolim', p: 'x.x.x.x.x.x.x.x.', arpejo: [0, 2, 1, 2], suave: 1 },
      mel: { t: 'voz', d: 0.2 },
    },
    laiko: {
      bpm: 96, tonica: 2, escala: 'harmonica',
      harm: { menor: '0 m|0 m|5 m|7 7' },
      perc: { aro: '....x.......x...', bumbo: 'x...x...x...x...', ganza: 'x.x.x.x.x.x.x.x.' },
      baixo: { t: 'baixo', p: 'x...x...x...x...', n: [0, 7] },
      acorde: { t: 'bandolim', p: 'x.xxx.xxx.xxx.xx', arpejo: [0, 1, 2, 1], suave: 1 },
      mel: { t: 'bandolim', d: 0.42 },
    },
    // ── Rock ──
    rock: {
      bpm: 122, tonica: 4,
      harm: { maior: '0 |7 |9 m|5 ', menor: '0 m|8 |3 |10 ' },
      perc: { bumbo: 'x.....x.x.......', caixa: '....x.......x...', chimbal: 'x.x.x.x.x.x.x.x.' },
      baixo: { t: 'baixo', p: 'x.x.x.x.x.x.x.x.', n: [0] },
      acorde: { t: 'guitarra', p: 'x.x.x.x.x.x.x.x.', arpejo: [0, 2, 1, 3], suave: 1 },
      mel: { t: 'guitarra', d: 0.14, escala: 'pentaM' },
    },
    alternativo: {
      bpm: 116, tonica: 9, escala: 'menor',
      harm: { menor: '0 5|8 5|3 5|10 5', maior: '0 5|5 5|9 5|7 5' },
      perc: { bumbo: 'x..x..x...x.....', caixa: '....x.......x..o', chimbal: 'x.x.x.x.x.x.x.x.' },
      baixo: { t: 'baixo', p: 'x.x.x.x.x.x.x.x.', n: [0] },
      acorde: { t: 'dist', p: 'x..x..x...x..x..', pesado: 1 },
      mel: { t: 'guitarra', d: 0.1, escala: 'pentam' },
    },
    punk: {
      bpm: 184, tonica: 4, escala: 'pentam',
      harm: { maior: '0 5|5 5|7 5|5 5', menor: '0 5|3 5|5 5|10 5' },
      perc: { bumbo: 'x.......x.x.....', caixa: '....x.......x...', aberto: 'x.x.x.x.x.x.x.x.' },
      baixo: { t: 'baixo', p: 'x.x.x.x.x.x.x.x.', n: [0] },
      acorde: { t: 'dist', p: 'x.x.x.x.x.x.x.x.', pesado: 1 },
    },
    hardcore: {
      bpm: 204, tonica: 9, escala: 'pentam',
      harm: { menor: '0 5|3 5|0 5|1 5' },
      perc: { bumbo: 'x...x..xx...x...', caixa: '..x...x...x...x.', aberto: 'x.x.x.x.x.x.x.x.' },
      baixo: { t: 'baixo', p: 'xxxxxxxxxxxxxxxx', n: [0] },
      acorde: { t: 'dist', p: 'xxxxxxxxxxxxxxxx', pesado: 1 },
    },
    metal: {
      bpm: 150, tonica: 4, escala: 'frigio',
      harm: { menor: '0 5|0 5|8 5|10 5' },
      perc: { bumbo: 'x.xxx.xxx.xxx.xx', caixa: '....x.......x...', prato: 'x...x...x...x...' },
      baixo: { t: 'baixo', p: 'x.xxx.xxx.xxx.xx', n: [0] },
      acorde: { t: 'dist', p: 'x.xxx.xxx.xxx.xx', pesado: 1 },
      mel: { t: 'dist', d: 0.08, oit: 12 },
    },
    black: {
      bpm: 196, tonica: 4, escala: 'menor', cama: 'cordas',
      harm: { menor: '0 m|8 |1 |0 m' },
      perc: { bumbo: 'xxxxxxxxxxxxxxxx', caixa: 'x.x.x.x.x.x.x.x.', prato: 'x.......x.......' },
      baixo: { t: 'baixo', p: 'x...x...x...x...', n: [0] },
      acorde: { t: 'dist', p: 'xxxxxxxxxxxxxxxx', arpejo: [0, 1, 2, 1], pesado: 1 },
    },
    doom: {
      bpm: 62, tonica: 2, escala: 'blues',
      harm: { menor: '0 5|0 5|3 5|1 5' },
      perc: { bumbo: 'x.......x.....x.', caixa: '........x.......', prato: 'x...x...x...x...' },
      baixo: { t: 'baixo', p: 'x.......x.....x.', n: [0], longo: 1 },
      acorde: { t: 'dist', p: 'x.......x.....x.', pesado: 1, longo: 1 },
    },
    psicodelico: {
      bpm: 106, tonica: 4, escala: 'mixo', cama: 'orgao',
      harm: { maior: '0 |10 |0 |5 ', menor: '0 m7|10 |0 m7|5 7' },
      perc: { bumbo: 'x.....x...x.....', caixa: '....x.......x...', pandeiro: 'x.x.x.x.x.x.x.x.' },
      baixo: { t: 'baixo', p: 'x..x..x.x.....x.', n: [0, 0, 7, 10, 7] },
      acorde: { t: 'orgao', p: 'x...............', longo: 1, suave: 1 },
      mel: { t: 'guitarra', d: 0.24, escala: 'mixo' },
    },
    dream: {
      bpm: 84, tonica: 11, cama: 'pad',
      harm: { maior: '0 maj7|5 maj7|9 m7|5 maj7', menor: '0 m9|8 maj7|3 maj7|10 ' },
      perc: { bumbo: 'x.......x.x.....', caixa: '....x.......x...', chimbal: 'x...x...x...x...' },
      baixo: { t: 'baixo', p: 'x.......x.......', n: [0, 7] },
      acorde: { t: 'guitarra', p: 'x.x.x.x.x.x.x.x.', arpejo: [0, 2, 3, 1], suave: 1 },
      mel: { t: 'voz', d: 0.1 },
    },
    postrock: {
      bpm: 92, tonica: 2, cama: 'cordas',
      harm: { maior: '0 |9 m|5 |7 ', menor: '0 m|8 |3 |10 ' },
      perc: { bumbo: 'x.....x.........', caixa: '........x.......', prato: 'x.x.x.x.x.x.x.x.' },
      baixo: { t: 'baixo', p: 'x.......x.......', n: [0] },
      acorde: { t: 'guitarra', p: 'x.x.x.x.x.x.x.x.', arpejo: [0, 1, 2, 3, 2, 1, 2, 3], suave: 1 },
      mel: { t: 'guitarra', d: 0.08 },
    },
    ska: {
      bpm: 156, tonica: 0,
      harm: { maior: '0 |5 |7 7|0 ', menor: '0 m|5 m|7 7|0 m' },
      perc: { bumbo: 'x...x...x...x...', caixa: '....x.......x...', chimbal: '..x...x...x...x.' },
      baixo: { t: 'baixo', p: 'x.x.x.x.x.x.x.x.', n: [0, 4, 7, 9, 12, 9, 7, 4] },
      acorde: { t: 'guitarra', p: '..x...x...x...x.', suave: 1 },
      mel: { t: 'sopro', d: 0.18 },
    },
    // ── Reggae ──
    reggae: {
      bpm: 76, tonica: 9, escala: 'menor', cama: 'orgao',
      harm: { menor: '0 m|0 m|10 |5 ', maior: '0 |5 |7 |5 ' },
      perc: { bumbo: '........x.......', aro: '........x.......', chimbal: 'x.x.x.x.x.x.x.x.' },
      baixo: { t: 'baixo', p: 'x.....x.x..x....', n: [0, 7, 12, 10] },
      acorde: { t: 'guitarra', p: '....x.......x...', suave: 1 },
      mel: { t: 'orgao', d: 0.08 },
    },
    dub: {
      bpm: 72, tonica: 7, escala: 'menor', cama: 'orgao', sala: 0.8,
      harm: { menor: '0 m|0 m|8 |10 ' },
      perc: { bumbo: '........x.......', aro: '........x.......', chimbal: '..x...x...x...x.' },
      baixo: { t: 'sub', p: 'x.....x...x.....', n: [0, 7, 0] },
      acorde: { t: 'guitarra', p: '....x.......x...', suave: 1 },
    },
    // ── Hip hop ──
    boombap: {
      bpm: 88, tonica: 5, escala: 'dorico', swing: 0.2,
      harm: { menor: '0 m9|0 m9|8 maj7|7 7' },
      perc: { bumbo: 'x.....x..x......', caixa: '....x.......x...', chimbal: 'x.x.x.x.x.x.x.x.' },
      baixo: { t: 'baixo', p: 'x.....x..x......', n: [0, 0, 7] },
      acorde: { t: 'rhodes', p: 'x.....x.....x...', suave: 1 },
      mel: { t: 'rhodes', d: 0.1 },
    },
    trap: {
      bpm: 70, passos: 32, tonica: 1, escala: 'menor',
      harm: { menor: '0 m|0 m|8 |7 m' },
      perc: { bumbo: 'x.......x.........x.....x.......', caixa: '................x...............', chimbal: 'x...x...x...x.x.x...x...xxxxx.x.' },
      baixo: { t: 'sub', p: 'x...............x.......x.......', n: [0, 0, -2], longo: 1 },
      mel: { t: 'sino', d: 0.05, oit: 12, r: 'x.......x.......x.......x...x...' },
    },
    nuvem: {     // cloud rap: trap slowed, washed out, a bell in the fog
      bpm: 68, passos: 32, tonica: 6, escala: 'pentam', cama: 'pad', sala: 0.7,
      harm: { menor: '0 m9|8 maj7|3 maj7|10 ' },
      perc: { bumbo: 'x...............x.......x.......', caixa: '................x...............', chimbal: 'x.......x.......x.......x...x.x.' },
      baixo: { t: 'sub', p: 'x...............x.......x.......', n: [0, 0, -2], longo: 1 },
      acorde: { t: 'rhodes', p: 'x...............................', longo: 1, suave: 1 },
      mel: { t: 'sino', d: 0.04, oit: 12, r: 'x.......x.......x.......x...x...' },
    },
    // ── Electronic ──
    house: {
      bpm: 124, tonica: 9, escala: 'menor',
      harm: { menor: '0 m7|0 m7|8 maj7|10 ' },
      perc: { bumbo: 'x...x...x...x...', palma: '....x.......x...', aberto: '..x...x...x...x.', chimbal: 'x.x.x.x.x.x.x.x.' },
      baixo: { t: 'baixo', p: '..x...x...x..xx.', n: [0, 0, 0, 12, 10] },
      acorde: { t: 'piano', p: 'x..x..x...x..x..', suave: 1 },
      mel: { t: 'lead', d: 0.08 },
    },
    techno: {
      nivel: 1.7, bpm: 134, tonica: 5, escala: 'frigio', cama: 'pad',
      harm: { menor: '0 m|0 m|0 m|1 ' },
      perc: { bumbo: 'x...x...x...x...', aberto: '..x...x...x...x.', chimbal: 'xxxxxxxxxxxxxxxx', aro: '.......x.......x' },
      baixo: { t: 'acid', p: 'x.xx.x.xx.x.xx.x', n: [0, 0, 12, 0, 3, 0, 0, 7] },
    },
    ambient: {
      nivel: 4, bpm: 60, tonica: 2, cama: 'pad', sala: 0.9,
      harm: { maior: '0 maj9|5 maj9', menor: '0 m9|8 maj9' }, compassos: 4,
      perc: {},
      mel: { t: 'sino', d: 0.05, oit: 12, escala: 'pentaM' },
    },
    experimental: {
      nivel: 3.5, bpm: 92, tonica: 1, escala: 'tons', cama: 'pad', sala: 0.6, acaso: 0.2,
      harm: { menor: '0 m7b5|6 dim', maior: '0 m7b5|6 dim' }, compassos: 2,
      perc: { estalo: 'x..o.x...o..x.o.', aro: '...x.......x..x.' },
      mel: { t: 'sino', d: 0.08 },
    },
    ruido: {
      bpm: 100, tonica: 1, escala: 'tons', cama: 'orgao', sala: 0.3, acaso: 0.4,
      harm: { menor: '0 dim' },
      perc: { aberto: 'x..xx.x...xx.x..', estalo: 'xxxxxxxxxxxxxxxx' },
      acorde: { t: 'dist', p: 'x.......x..x....', pesado: 1, longo: 1 },
    },
    downtempo: {
      bpm: 84, tonica: 3, escala: 'dorico', cama: 'padQuente', swing: 0.14,
      harm: { menor: '0 m9|8 maj7|3 maj7|10 9', maior: '0 maj9|9 m7|5 maj7|7 9' },
      perc: { bumbo: 'x.....x...x.....', caixa: '....x.......x...', chimbal: 'x.x.x.x.x.x.x.x.', estalo: 'x..o..x.o...x..o' },
      baixo: { t: 'baixo', p: 'x.....x...x..x..', n: [0, 7, 0, 10] },
      acorde: { t: 'rhodes', p: 'x.......x.......', suave: 1, longo: 1 },
      mel: { t: 'vibrafone', d: 0.08 },
    },
    synthpop: {
      nivel: 1.7, bpm: 118, tonica: 0, escala: 'menor',
      harm: { menor: '0 m|8 |3 |10 ', maior: '0 |7 |9 m|5 ' },
      perc: { bumbo: 'x...x...x...x...', palma: '....x.......x...', chimbal: 'x.x.x.x.x.x.x.x.' },
      baixo: { t: 'acid', p: 'x.x.x.x.x.x.x.x.', n: [0, 0, 12, 0] },
      acorde: { t: 'lead', p: 'xxxxxxxxxxxxxxxx', arpejo: [0, 1, 2, 3], suave: 1 },
      mel: { t: 'chip', d: 0.12 },
    },
    electro: {
      bpm: 126, tonica: 7, escala: 'menor',
      harm: { menor: '0 m|0 m|3 |10 ' },
      perc: { bumbo: 'x..x..x...x.....', palma: '....x.......x...', chimbal: 'x.xxx.xxx.xxx.xx', cowbell: '...x.....x...x..' },
      baixo: { t: 'sub', p: 'x..x..x...x.....', n: [0, 0, 7, 0] },
      mel: { t: 'chip', d: 0.14 },
    },
    dnb: {
      bpm: 174, tonica: 5, escala: 'menor', cama: 'pad',
      harm: { menor: '0 m9|0 m9|8 maj7|10 ' },
      perc: { bumbo: 'x.........x.....', caixa: '....x.......x..o', chimbal: 'x.x.x.x.x.x.x.x.' },
      baixo: { t: 'sub', p: 'x.........x.....', n: [0, 7], longo: 1 },
      acorde: { t: 'rhodes', p: 'x...............', longo: 1, suave: 1 },
    },
    // ── Jazz, blues, soul ──
    jazz: {
      bpm: 152, passos: 12, tonica: 10, escala: 'dorico', cama: 'padQuente',
      harm: { maior: '2 m7|7 7|0 maj7|9 7', menor: '0 m7|5 7|10 maj7|2 7b9' },
      perc: { prato: 'X..x.xX..x.x', chimbal: '...x.....x..' },
      baixo: { t: 'contrabaixo', p: 'x..x..x..x..', n: 'anda' },
      acorde: { t: 'piano', p: '.....x..x...', suave: 1 },
      mel: { t: 'vibrafone', d: 0.32 },
    },
    jazzcontemporaneo: {
      bpm: 104, tonica: 2, escala: 'dorico', cama: 'padQuente',
      harm: { maior: '0 maj9|2 m9|4 m7|5 maj9', menor: '0 m9|5 9|10 maj9|8 maj9' },
      perc: { bumbo: 'x.....x...x.....', aro: '....x.......x...', chimbal: 'xoxoxoxoxoxoxoxo' },
      baixo: { t: 'baixo', p: 'x..x..x...x.x...', n: [0, 7, 10, 5, 7] },
      acorde: { t: 'rhodes', p: 'x..x.....x..x...', suave: 1 },
      mel: { t: 'sopro', d: 0.26 },
    },
    manouche: {
      bpm: 180, tonica: 2, escala: 'harmonica',
      harm: { menor: '0 m6|0 m6|7 7|7 7|0 m6|5 m6|7 7|0 m6' },
      perc: {},
      baixo: { t: 'contrabaixo', p: 'x...x...x...x...', n: 'anda' },
      acorde: { t: 'violao', p: 'X.x.X.x.X.x.X.x.', suave: 1 },
      mel: { t: 'bandolim', d: 0.4 },
    },
    blues: {
      bpm: 92, passos: 12, tonica: 4, escala: 'blues', compassos: 1,
      harm: { maior: '0 7|0 7|0 7|0 7|5 7|5 7|0 7|0 7|7 7|5 7|0 7|7 7' },
      perc: { bumbo: 'x..x..x..x..', caixa: '...x.....x..', chimbal: 'x.xx.xx.xx.x' },
      baixo: { t: 'baixo', p: 'x.xx.xx.xx.x', n: [0, 0, 4, 4, 7, 7, 9, 9] },
      acorde: { t: 'guitarra', p: '...x.....x..', suave: 1 },
      mel: { t: 'guitarra', d: 0.22 },
    },
    funk: {
      bpm: 104, tonica: 4, escala: 'dorico',
      harm: { menor: '0 7|0 7|0 7|5 9' },
      perc: { bumbo: 'X..x..x...x..x..', caixa: '....x..o.o..x..o', chimbal: 'xoxoxoxoxoxoxoxo' },
      baixo: { t: 'baixo', p: 'X..x..x.x.xx.x..', n: [0, 12, 10, 0, 7, 10] },
      acorde: { t: 'guitarra', p: '..x.xx.x.xx.x.xx', suave: 1 },
      mel: { t: 'sopro', d: 0.12, r: 'x..x..x.........' },
    },
    soul: {
      bpm: 84, tonica: 8, cama: 'orgao',
      harm: { maior: '0 maj7|9 m7|2 m7|7 9', menor: '0 m9|5 9|10 maj7|7 7' },
      perc: { bumbo: 'x.....x...x.....', caixa: '....x.......x...', chimbal: 'x.x.x.x.x.x.x.x.' },
      baixo: { t: 'baixo', p: 'x.....x.x..x....', n: [0, 7, 5, 7] },
      acorde: { t: 'rhodes', p: 'x...x...x...x...', suave: 1 },
      mel: { t: 'voz', d: 0.16 },
    },
    // ── Pop and the rest ──
    pop: {
      bpm: 112, tonica: 0,
      harm: { maior: '0 |7 |9 m|5 ', menor: '0 m|8 |3 |10 ' },
      perc: { bumbo: 'x.....x.x.......', palma: '....x.......x...', chimbal: 'x.x.x.x.x.x.x.x.' },
      baixo: { t: 'baixo', p: 'x...x...x...x.x.', n: [0, 0, 0, 0, 7] },
      acorde: { t: 'piano', p: 'x...x...x...x...', suave: 1 },
      mel: { t: 'lead', d: 0.2 },
    },
    balada: {
      bpm: 72, tonica: 7, cama: 'cordas',
      harm: { maior: '0 |7 |9 m|5 ', menor: '0 m|5 m|10 |3 ' },
      perc: { bumbo: 'x.......x.......', aro: '....x.......x...' },
      baixo: { t: 'baixo', p: 'x.......x.......', n: [0, 7] },
      acorde: { t: 'piano', p: 'x.x.x.x.x.x.x.x.', arpejo: [0, 2, 3, 2], suave: 1 },
      mel: { t: 'voz', d: 0.14 },
    },
    valsa: {     // chanson and the older vocal pop: an accordion in three
      nivel: 1.2, bpm: 132, passos: 12, tonica: 2, cama: 'padQuente', escala: 'harmonica',
      harm: { menor: '0 m|0 m|7 7|0 m', maior: '0 |5 |7 7|0 ' },
      perc: {},
      baixo: { t: 'contrabaixo', p: 'x...........', n: [0, 7] },
      acorde: { t: 'sanfona', p: '....x...x...', suave: 1 },
      mel: { t: 'sanfona', d: 0.22 },
    },
    classica: {
      bpm: 88, tonica: 7, cama: 'cordas',
      harm: { maior: '0 |7 |9 m|4 m|5 |0 |5 |7 7', menor: '0 m|7 7|0 m|8 |5 m|10 |3 |7 7' },
      perc: {},
      baixo: { t: 'contrabaixo', p: 'x...x...x...x...', n: [0, 7] },
      acorde: { t: 'cravo', p: 'xxxxxxxxxxxxxxxx', arpejo: [0, 1, 2, 3, 2, 1, 2, 1], suave: 1 },
      mel: { t: 'cordas', d: 0.1 },
    },
    contemporanea: {
      nivel: 3.5, bpm: 66, tonica: 1, escala: 'tons', cama: 'cordas', sala: 0.7, acaso: 0.15,
      harm: { menor: '0 m7b5|6 dim|2 m7b5|8 dim' }, compassos: 2,
      perc: {},
      mel: { t: 'piano', d: 0.1 },
    },
    cinema: {
      nivel: 2, bpm: 76, tonica: 2, escala: 'menor', cama: 'cordas', sala: 0.6,
      harm: { menor: '0 m|8 |3 |10 ', maior: '0 |5 |9 m|7 ' }, compassos: 2,
      perc: { surdo: 'x...............' },
      acorde: { t: 'piano', p: 'x.......x.......', arpejo: [0, 1, 2, 3], suave: 1 },
      mel: { t: 'cordas', d: 0.08 },
    },
    fanfarra: {
      nivel: 1.5, bpm: 112, tonica: 10,
      harm: { maior: '0 |5 |7 7|0 ' },
      perc: { caixa: 'x.oox.oox.oox.oo', surdo: 'x.......x.......', prato: '....x.......x...' },
      baixo: { t: 'sopro', p: 'x.......x.......', n: [-12, -5] },
      acorde: { t: 'sopro', p: '....x.......x...', suave: 1 },
      mel: { t: 'sopro', d: 0.3 },
    },
    fala: {      // spoken word, comedy, field recordings: a murmur under a held note
      nivel: 2, bpm: 80, tonica: 7, cama: 'padQuente',
      harm: { maior: '0 sus', menor: '0 sus' },
      perc: { estalo: 'x....o...x..o...' },
      mel: { t: 'voz', d: 0.14, escala: 'pentaM', oit: -12 },
    },
    infantil: {
      nivel: 2.2, bpm: 104, tonica: 0,
      harm: { maior: '0 |5 |7 |0 ' },
      perc: { ganza: 'x...x...x...x...' },
      acorde: { t: 'caixinha', p: 'x.x.x.x.x.x.x.x.', arpejo: [0, 1, 2, 1], suave: 1 },
      mel: { t: 'caixinha', d: 0.3, oit: 12 },
    },
  };

  // Discogs-style "<macro>---<sub>" as the audio model labels tracks, mapped by hand for the labels that
  // cover 96% of the 79k tracks. The rest fall back on PADRAO_MACRO through their macro.
  const POR_FAMILIA = {
    samba: ['Latin---Samba'],
    batucada: ['Latin---Batucada'],
    bossa: ['Latin---Bossanova', 'Jazz---Bossa Nova'],
    mpb: ['Latin---MPB', 'Latin---Nueva Cancion'],
    forro: ['Latin---Forró', 'Latin---Baião'],
    salsa: ['Latin---Salsa', 'Latin---Mambo', 'Latin---Son', 'Latin---Son Montuno', 'Latin---Cubano', 'Latin---Guaguancó', 'Latin---Guajira', 'Latin---Guaracha', 'Latin---Rumba', 'Latin---Cha-Cha', 'Latin---Charanga', 'Latin---Descarga', 'Latin---Afro-Cuban', 'Latin---Pachanga', 'Latin---Boogaloo', 'Latin---Cumbia', 'Latin---Merengue', 'Latin---Porro', 'Latin---Vallenato', 'Latin---Compas', 'Latin---Beguine', 'Jazz---Afro-Cuban Jazz', 'Jazz---Latin Jazz'],
    reggaeton: ['Latin---Reggaeton', 'Reggae---Dancehall', 'Reggae---Ragga', 'Reggae---Soca', 'Folk, World, & Country---Zouk'],
    tango: ['Latin---Tango'],
    bolero: ['Latin---Bolero', 'Latin---Ranchera', 'Latin---Mariachi', 'Latin---Norteño', 'Latin---Tejano'],
    folk: ['Folk, World, & Country---Folk', 'Folk, World, & Country---Celtic', 'Folk, World, & Country---Nordic', 'Folk, World, & Country---Catalan Music', 'Folk, World, & Country---Canzone Napoletana', 'Rock---Acoustic', 'Rock---Folk Rock', 'Rock---Lo-Fi'],
    neofolk: ['Rock---Neofolk'],
    country: ['Folk, World, & Country---Country', 'Folk, World, & Country---Bluegrass', 'Folk, World, & Country---Hillbilly', 'Folk, World, & Country---Honky Tonk', 'Folk, World, & Country---Cajun', 'Folk, World, & Country---Polka', 'Folk, World, & Country---Volksmusik', 'Rock---Country Rock'],
    africa: ['Folk, World, & Country---African', 'Folk, World, & Country---Highlife', 'Folk, World, & Country---Soukous', 'Folk, World, & Country---Séga', 'Folk, World, & Country---Pacific', 'Folk, World, & Country---Hindustani', 'Folk, World, & Country---Indian Classical', 'Reggae---Calypso'],
    afrobeat: ['Jazz---Afrobeat', 'Funk / Soul---Afrobeat'],
    flamenco: ['Folk, World, & Country---Flamenco', 'Folk, World, & Country---Romani', 'Folk, World, & Country---Raï'],
    fado: ['Folk, World, & Country---Fado'],
    laiko: ['Folk, World, & Country---Laïkó', 'Folk, World, & Country---Éntekhno'],
    rock: ['Rock---Indie Rock', 'Rock---Pop Rock', 'Rock---Classic Rock', 'Rock---Hard Rock', 'Rock---Blues Rock', 'Rock---Arena Rock', 'Rock---AOR', 'Rock---Brit Pop', 'Rock---Beat', 'Rock---Glam', 'Rock---Prog Rock', 'Rock---Art Rock', 'Pop---Indie Pop', 'Rock---Surf', 'Rock---Garage Rock'],
    alternativo: ['Rock---Alternative Rock', 'Rock---Grunge', 'Rock---Math Rock', 'Rock---Post-Punk', 'Rock---Emo', 'Rock---Noise', 'Rock---Goth Rock', 'Rock---Coldwave', 'Rock---Deathrock'],
    punk: ['Rock---Punk', 'Rock---Melodic Hardcore', 'Rock---Pop Punk', 'Rock---Oi', 'Rock---Psychobilly'],
    hardcore: ['Rock---Hardcore', 'Rock---Crust', 'Rock---Grindcore', 'Rock---Noisecore', 'Rock---Goregrind', 'Rock---Powerviolence'],
    metal: ['Rock---Heavy Metal', 'Rock---Melodic Death Metal', 'Rock---Thrash', 'Rock---Death Metal', 'Rock---Deathcore', 'Rock---Metalcore', 'Rock---Power Metal', 'Rock---Speed Metal', 'Rock---Folk Metal', 'Rock---Gothic Metal', 'Rock---Funk Metal', 'Rock---Nu Metal', 'Rock---Progressive Metal'],
    black: ['Rock---Black Metal', 'Rock---Atmospheric Black Metal', 'Rock---Depressive Black Metal'],
    doom: ['Rock---Doom Metal', 'Rock---Stoner Rock', 'Rock---Sludge Metal', 'Rock---Post-Metal', 'Rock---Funeral Doom Metal'],
    psicodelico: ['Rock---Psychedelic Rock', 'Funk / Soul---Psychedelic', 'Rock---Space Rock', 'Rock---Krautrock', 'Rock---Experimental', 'Rock---Avantgarde'],
    dream: ['Rock---Dream Pop', 'Rock---Shoegaze', 'Rock---Ethereal', 'Electronic---Chillwave', 'Electronic---Vaporwave'],
    postrock: ['Rock---Post Rock'],
    ska: ['Rock---Ska', 'Reggae---Ska', 'Reggae---Rocksteady'],
    reggae: ['Reggae---Reggae', 'Reggae---Roots Reggae', 'Reggae---Lovers Rock', 'Reggae---Reggae-Pop'],
    dub: ['Reggae---Dub', 'Electronic---Dub', 'Electronic---Dub Techno'],
    boombap: ['Hip Hop---Boom Bap', 'Hip Hop---Gangsta', 'Hip Hop---Conscious', 'Hip Hop---Jazzy Hip-Hop', 'Hip Hop---Instrumental', 'Hip Hop---Hardcore Hip-Hop', 'Hip Hop---Horrorcore', 'Hip Hop---Thug Rap', 'Hip Hop---Pop Rap', 'Hip Hop---G-Funk', 'Hip Hop---Britcore', 'Hip Hop---RnB/Swing', 'Hip Hop---Cut-up/DJ', 'Hip Hop---Turntablism', 'Hip Hop---Ragga HipHop'],
    trap: ['Hip Hop---Trap', 'Hip Hop---Crunk', 'Hip Hop---Grime', 'Electronic---Grime', 'Electronic---Juke', 'Electronic---Halftime', 'Hip Hop---Bass Music', 'Hip Hop---Miami Bass', 'Hip Hop---Bounce'],
    nuvem: ['Hip Hop---Cloud Rap', 'Hip Hop---Screw'],
    house: ['Electronic---House', 'Electronic---Nu-Disco', 'Electronic---Deep House', 'Electronic---Tropical House', 'Electronic---Electro House', 'Electronic---Euro House', 'Electronic---Disco', 'Electronic---Euro-Disco', 'Funk / Soul---Disco', 'Electronic---Dance-pop', 'Electronic---Eurobeat'],
    techno: ['Electronic---Techno', 'Electronic---Deep Techno', 'Electronic---Minimal Techno', 'Electronic---Tech House', 'Electronic---Trance', 'Electronic---Psy-Trance', 'Electronic---Goa Trance', 'Electronic---Acid', 'Electronic---Hard Techno', 'Electronic---Hardcore', 'Electronic---EBM'],
    ambient: ['Electronic---Ambient', 'Electronic---Dark Ambient', 'Electronic---Drone', 'Electronic---New Age', 'Electronic---Berlin-School', 'Electronic---Dungeon Synth'],
    experimental: ['Electronic---Experimental', 'Electronic---Abstract', 'Electronic---IDM', 'Electronic---Musique Concrète', 'Electronic---Glitch'],
    ruido: ['Electronic---Noise', 'Electronic---Power Electronics', 'Electronic---Industrial'],
    downtempo: ['Electronic---Downtempo', 'Electronic---Trip Hop', 'Hip Hop---Trip Hop', 'Electronic---Future Jazz', 'Electronic---Acid Jazz', 'Electronic---Lo-Fi'],
    synthpop: ['Electronic---Synth-pop', 'Electronic---Synthwave', 'Electronic---Darkwave', 'Electronic---New Wave', 'Electronic---Italo-Disco', 'Electronic---Electroclash', 'Electronic---Chiptune', 'Pop---City Pop', 'Pop---Europop', 'Pop---K-pop', 'Pop---J-pop'],
    electro: ['Electronic---Electro', 'Hip Hop---Electro', 'Electronic---Freestyle'],
    dnb: ['Electronic---Drum n Bass', 'Electronic---Jungle', 'Electronic---Breakcore', 'Electronic---Breakbeat', 'Electronic---Breaks', 'Electronic---Big Beat', 'Electronic---Dubstep', 'Electronic---Bassline'],
    jazz: ['Jazz---Bop', 'Jazz---Hard Bop', 'Jazz---Post Bop', 'Jazz---Cool Jazz', 'Jazz---Swing', 'Jazz---Big Band', 'Jazz---Dixieland', 'Jazz---Ragtime', 'Jazz---Modal', 'Jazz---Avant-garde Jazz', 'Jazz---Free Jazz', 'Jazz---Free Improvisation'],
    jazzcontemporaneo: ['Jazz---Contemporary Jazz', 'Jazz---Fusion', 'Jazz---Smooth Jazz', 'Jazz---Jazz-Funk', 'Jazz---Jazz-Rock', 'Jazz---Soul-Jazz', 'Jazz---Easy Listening', 'Jazz---Space-Age'],
    manouche: ['Jazz---Gypsy Jazz'],
    funk: ['Funk / Soul---Funk', 'Funk / Soul---P.Funk', 'Funk / Soul---Free Funk', 'Funk / Soul---Boogie'],
    soul: ['Funk / Soul---Soul', 'Funk / Soul---Neo Soul', 'Funk / Soul---Contemporary R&B', 'Funk / Soul---Rhythm & Blues', 'Funk / Soul---New Jack Swing', 'Funk / Soul---Gospel', 'Funk / Soul---Swingbeat', 'Funk / Soul---UK Street Soul', 'Folk, World, & Country---Gospel', 'Blues---Rhythm & Blues', 'Rock---Doo Wop'],
    balada: ['Pop---Ballad', 'Pop---Vocal', 'Pop---Bollywood'],
    valsa: ['Pop---Chanson', 'Pop---Kayōkyoku', 'Pop---Schlager', 'Pop---Music Hall', 'Pop---Light Music'],
    pop: ['Pop---Bubblegum', 'Pop---Novelty', 'Pop---Parody'],
    contemporanea: ['Classical---Contemporary', 'Classical---Modern', 'Classical---Post-Modern'],
    cinema: ['Stage & Screen---Soundtrack', 'Stage & Screen---Score', 'Stage & Screen---Theme', 'Stage & Screen---Musical'],
  };

  const PADRAO_MACRO = {
    Latin: 'samba', Rock: 'rock', 'Folk, World, & Country': 'folk', Electronic: 'downtempo', 'Hip Hop': 'boombap',
    Jazz: 'jazz', Pop: 'pop', 'Funk / Soul': 'soul', Reggae: 'reggae', Blues: 'blues', Classical: 'classica',
    'Stage & Screen': 'cinema', 'Non-Music': 'fala', 'Brass & Military': 'fanfarra', "Children's": 'infantil',
  };

  const familiaPorGenero = new Map();
  for (const [f, lista] of Object.entries(POR_FAMILIA)) for (const g of lista) familiaPorGenero.set(g, f);

  // The family that plays a label: its own, or its macro's default ("Pop" alone, no sub, counts as a macro).
  function familiaDe(genero) {
    return familiaPorGenero.get(genero) || PADRAO_MACRO[genero.split('---')[0]] || 'pop';
  }

  function lerAcordes(s) {
    return s.split('|').map(c => {
      const [raiz, q = ''] = c.split(' ');
      return { raiz: Number(raiz), notas: ACORDES[q] || ACORDES[''] };
    });
  }

  function ajustar(f, a) {
    if (!a) return f;
    const { melT, cel, mix, ...resto } = a;
    Object.assign(f, resto);
    if (mix) f.mix = { ...f.mix, ...mix };
    if (melT && f.mel) f.mel = { ...f.mel, t: melT, oit: REGISTRO[melT] ?? 0 };
    if (cel && f.groove) f.groove = { ...f.groove, cel };
    return f;
  }

  // A family ready to play: defaults filled in, chords parsed, scale resolved.
  const prontas = new Map();
  function receita(nome) {
    if (prontas.has(nome)) return prontas.get(nome);
    const f = { ...BASE, ...FAMILIAS[nome], ...EFEITOS[nome], nome };
    f.groove = MAQUINAS.has(nome) ? null : GROOVES[GROOVE_DE[nome] || 'humano'];
    if (LONGAS.includes(nome)) f.curta = 0;
    // Every family has a line: the dots on screen are its score, and a genre without one would leave them silent.
    f.mel ??= { t: f.acorde?.t === 'dist' ? 'dist' : f.baixo?.t === 'acid' || f.baixo?.t === 'sub' ? 'lead' : 'guitarra', d: 0.1 };
    if (f.mel) f.mel = { oit: REGISTRO[f.mel.t], ...f.mel };
    ajustar(f, AJUSTES[nome]);
    const insts = Object.keys(f.perc);
    f.virada = VIRADA.filter(i => insts.includes(i)).slice(0, 2);
    f.bateria = 'caixa' in f.perc || 'palma' in f.perc;
    f.banda = !!f.acorde || insts.length >= 2;
    f.harmonia = {};
    for (const modo of Object.keys(f.harm)) f.harmonia[modo] = lerAcordes(f.harm[modo]);
    f.escalaNotas = ESCALAS[f.escala];
    prontas.set(nome, f);
    return f;
  }

  global.RECEITAS_ATLAS = { familias: Object.keys(FAMILIAS), familiaDe, receita, ajustar, ESCALAS, GROOVES };
})(window);
