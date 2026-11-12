// js/atlas-sim.js — /atlas?sim=1 (e /atlas/sim): a banda da sonificação num palco 3D, num cartão à esquerda do
// mapa (do tamanho do #grafo-painel), com o mapa ainda navegável por trás: andar pelo mapa muda a banda.
//
// O cenário é o dos gêneros que tocam: bossa nova e MPB numa praia do Rio, samba numa roda no morro, forró numa
// festa no sertão, rock numa garagem, eletrônica num clube… (CENARIOS). Cada família pesa no cenário pelos músicos
// dela no palco (quantos e quanto tocam): os objetos de cada cenário sobem do chão e somem com esse peso, espalhados
// no mesmo anel, e céu, chão, névoa e luz são a mistura ponderada dos cenários presentes.
//
// Cada músico é uma voz de verdade do motor (js/atlas-som.js, `ouvir()`): a percussão, o baixo, a harmonia ou a
// melodia de uma família de gêneros. Ele entra no palco quando a voz começa a tocar e some quando ela se cala por
// alguns segundos. Cada nota agendada chega com o horário do AudioContext em que soa; a banda a mostra quando ela
// sai no alto-falante (`ouvido()`: o currentTime menos a latência de saída), com o braço subindo 140 ms antes e
// descendo na nota. Os corpos dançam no pulso do próprio motor (`batida()`), não num relógio à parte. Entre as notas os músicos balançam no andamento da banda.
// A câmera nunca para e nunca corta: orbita num arco pela frente da banda e desliza de músico em músico, e quem
// entra com um instrumento novo ganha a câmera de perto por alguns segundos. Luz de filme (tone mapping ACES, contraluz, fachos aditivos sobre cada
// músico, clarão nos golpes fortes, poeira na névoa), sombra falsa sob os pés, vinheta e grão por CSS. Por trás do
// palco o mapa continua sendo a partitura: a música manda no vídeo, nunca o contrário. A banda não move o mapa nem
// muda o que toca; enquanto ela está aberta, o som agenda com mais folga (350 ms em vez de 140) e o 3D desenha a no
// máximo 60 quadros por segundo, para um quadro pesado não engasgar o áudio.
//
// three.js vem do jsdelivr só quando a simulação abre (import dinâmico; o resto do atlas é script clássico).
// Com movimento reduzido: câmera parada no plano aberto, ninguém dança, só as luzes respondem às notas.
// Ganchos: window.__atlas (ouvirBanda, agoraSom, ouvidoSom, batidaSom, folgaSom, acordarSom, familia, som, querSom,
// camera); expõe window.__atlasSim.
(() => {
  'use strict';
  const at = window.__atlas;
  if (!at) return;
  const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js';
  const reduz = matchMedia('(prefers-reduced-motion: reduce)');
  const $ = id => document.getElementById(id);
  const SOME_S = 5;            // calado por tanto tempo, o músico sai
  const MAX_MUSICOS = 8;
  const PREPARO_S = 0.14;      // o braço começa a subir tanto antes da nota       // no palco ao mesmo tempo; os que saem não contam

  // Cenário por família de gênero (as 57 de js/atlas-receitas.js). céu: [alto, horizonte]; chão; luz.
  const CENARIOS = {
    praia: { ceu: [0x3d6fb0, 0xf6b26b], chao: 0xd9c08a, luz: 0xffe2b8, fams: ['bossa', 'mpb', 'reggae', 'ska', 'dub', 'salsa'] },
    roda: { ceu: [0x141a3a, 0x5a3550], chao: 0x8a4b32, luz: 0xffc98a, fams: ['samba', 'batucada', 'fanfarra', 'infantil'] },
    sertao: { ceu: [0x10204a, 0xe0703a], chao: 0xb5733a, luz: 0xffb070, fams: ['forro', 'country'] },
    campo: { ceu: [0x5d9bd6, 0xd8ecf5], chao: 0x5f8a3a, luz: 0xfff4dc, fams: ['folk', 'neofolk', 'africa', 'afrobeat'] },
    taverna: { ceu: [0x1a0f0a, 0x4a2a18], chao: 0x4a2e1c, luz: 0xffb46a, fams: ['tango', 'bolero', 'flamenco', 'fado', 'laiko', 'manouche'] },
    garagem: { ceu: [0x0b0b0d, 0x3a1414], chao: 0x4a4a4a, luz: 0xff7a6a, fams: ['rock', 'alternativo', 'punk', 'hardcore', 'metal', 'black', 'doom', 'psicodelico', 'postrock'] },
    rua: { ceu: [0x1c1436, 0x7a4a6a], chao: 0x2e2e33, luz: 0xffd28a, fams: ['boombap', 'trap', 'nuvem', 'reggaeton', 'fala'] },
    clube: { ceu: [0x05030c, 0x1a0a33], chao: 0x0c0c12, luz: 0xb48cff, fams: ['house', 'techno', 'electro', 'dnb', 'synthpop', 'pop'] },
    espaco: { ceu: [0x02030a, 0x141a3a], chao: 0x12141c, luz: 0x9ab8ff, fams: ['ambient', 'experimental', 'ruido', 'dream', 'downtempo', 'cinema'] },
    jazz: { ceu: [0x0a0c18, 0x2a1a2e], chao: 0x5a3a22, luz: 0x8fb0ff, fams: ['jazz', 'jazzcontemporaneo', 'blues', 'soul', 'funk'] },
    teatro: { ceu: [0x120c0a, 0x3a1a14], chao: 0x6a4a2a, luz: 0xfff0d8, fams: ['classica', 'contemporanea', 'balada', 'valsa'] },
  };
  const CENARIO_DE = {};
  for (const [nome, c] of Object.entries(CENARIOS)) for (const f of c.fams) CENARIO_DE[f] = nome;

  // Grupo de cada papel do motor: tudo que não é baixo, harmonia ou melodia é percussão.
  const grupoDe = papel => (papel === 'baixo' || papel === 'acorde' || papel === 'mel' ? papel : 'perc');
  const ORDEM = { perc: 0, baixo: 1, acorde: 2, mel: 3 };
  const NOME_GRUPO = { perc: 'percussão', baixo: 'baixo', acorde: 'harmonia', mel: 'melodia' };
  const NOME_TIMBRE = {
    violao: 'violão', violao7: 'violão 7 cordas', cavaco: 'cavaquinho', bandolim: 'bandolim', banjo: 'banjo',
    guitarra: 'guitarra', dist: 'guitarra distorcida', baixo: 'baixo', contrabaixo: 'contrabaixo', sub: 'baixo sintético',
    acid: 'sintetizador', rhodes: 'piano Rhodes', piano: 'piano', cravo: 'cravo', orgao: 'órgão', sanfona: 'sanfona',
    sopro: 'sopro', cordas: 'violino', flauta: 'flauta', apito: 'apito', vibrafone: 'vibrafone', sino: 'sinos',
    caixinha: 'caixinha de música', lead: 'sintetizador', chip: 'chiptune', voz: 'voz', coro: 'coro', pad: 'teclado',
    padQuente: 'teclado',
  };
  const NOME_PERC = {
    bumbo: 'bumbo', surdo: 'surdo', zabumba: 'zabumba', caixa: 'caixa', aro: 'caixa', palma: 'palmas', chimbal: 'chimbal',
    aberto: 'chimbal', prato: 'prato', tamborim: 'tamborim', ganza: 'ganzá', pandeiro: 'pandeiro', repique: 'repique',
    cuica: 'cuíca', agogo: 'agogô', triangulo: 'triângulo', clave: 'clave', cowbell: 'cowbell', conga: 'conga',
    bongo: 'bongô', estalo: 'estalo',
  };
  const CORDA = { violao: 1, violao7: 1.05, cavaco: 0.62, bandolim: 0.58, banjo: 0.85, guitarra: 0.9, dist: 0.9, baixo: 1.15, sub: 1.15 };
  const TECLA = new Set(['rhodes', 'piano', 'cravo', 'orgao', 'acid', 'lead', 'chip', 'pad', 'padQuente']);

  // inteiros → [0, 1): o mesmo músico tem sempre a mesma cara
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return ((h >>> 0) % 10007) / 10007; };

  let THREE = null, run = null, somAntes = null, abrindo = false;
  const marcarBotao = on => $('btn-sim')?.setAttribute('aria-pressed', String(on));

  // ── figuras ──
  // Materiais opacos por padrão: só viram transparentes enquanto somem ou aparecem (transparência custa ordenação e
  // sobreposição de pixels, e um palco cheio de objetos semitransparentes pesa no celular).
  function material(cor, extra = {}) { return new THREE.MeshStandardMaterial({ color: cor, roughness: 0.65, metalness: 0.05, ...extra }); }
  function opacidade(m, o) {
    const tr = o < 0.995;
    m.opacity = o;
    if (m.transparent !== tr) { m.transparent = tr; m.depthWrite = !tr; }
  }
  function malha(geo, mat, x = 0, y = 0, z = 0) { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); return m; }
  // Geometrias dos músicos: uma de cada, compartilhada por todos (sair do palco descarta só os materiais).
  const GEO = new Map();
  const geo = (chave, fazer) => { let g = GEO.get(chave); if (!g) { g = fazer(); GEO.set(chave, g); } return g; };

  // Um corpo de bonecos com pinta de gente: pernas que dobram no quadril, sapatos, tronco na cor da família, cabeça
  // com cabelo e olhos, braços que giram no ombro. A sombra no chão é um disco desfocado, não um shadow map.
  function criarCorpo(chave, cor) {
    const { CylinderGeometry: Cil, CapsuleGeometry: Cap, SphereGeometry: Esf, BoxGeometry: Caixa } = THREE;
    const pele = new THREE.Color().setHSL(0.06 + hash(chave + 'p') * 0.04, 0.42, 0.26 + hash(chave + 'l') * 0.42);
    const cabelo = new THREE.Color().setHSL(0.06 + hash(chave + 'c') * 0.05, 0.35, 0.06 + hash(chave + 'k') * 0.3);
    const mats = { roupa: material(cor, { roughness: 0.8 }), pele: material(pele, { roughness: 0.55 }), cabelo: material(cabelo, { roughness: 0.9 }),
      calca: material(0x24211d, { roughness: 0.85 }), madeira: material(0x8a5a2b, { roughness: 0.45 }), metal: material(0xcfc6a8, { metalness: 0.8, roughness: 0.25 }),
      escuro: material(0x16130f, { roughness: 0.6 }) };
    const g = new THREE.Group(), corpo = new THREE.Group();
    g.add(corpo);
    const pernas = [-0.11, 0.11].map(x => {
      const quadril = new THREE.Group();
      quadril.position.set(x, 0.8, 0);
      quadril.add(malha(geo('perna', () => new Cil(0.075, 0.06, 0.8, 10)), mats.calca, 0, -0.4, 0));
      quadril.add(malha(geo('sapato', () => new Caixa(0.12, 0.07, 0.22)), mats.escuro, 0, -0.79, 0.05));
      corpo.add(quadril);
      return quadril;
    });
    const tronco = new THREE.Group();
    tronco.position.y = 0.8;
    corpo.add(tronco);
    tronco.add(malha(geo('tronco', () => new Cap(0.2, 0.42, 6, 16)), mats.roupa, 0, 0.28, 0));
    const cabeca = new THREE.Group();
    cabeca.position.set(0, 0.8, 0);
    tronco.add(cabeca);
    cabeca.add(malha(geo('cabeca', () => new Esf(0.16, 20, 16)), mats.pele, 0, 0, 0));
    const topo = malha(geo('cabelo', () => new Esf(0.168, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.55)), mats.cabelo, 0, 0.01, -0.012);
    topo.rotation.x = -0.25;
    cabeca.add(topo);
    for (const x of [-0.055, 0.055]) cabeca.add(malha(geo('olho', () => new Esf(0.022, 8, 6)), mats.escuro, x, 0.02, 0.148));
    // braço articulado: ombro → braço → cotovelo → antebraço → punho → mão. Cada junta é um grupo que gira
    const bracos = [-1, 1].map(lado => {
      const ombro = new THREE.Group();
      ombro.position.set(0.27 * lado, 0.55, 0);
      ombro.add(malha(geo('braco-sup', () => new Cil(0.056, 0.05, 0.32, 10)), mats.roupa, 0, -0.16, 0));
      const cotovelo = new THREE.Group();
      cotovelo.position.y = -0.32;
      ombro.add(cotovelo);
      cotovelo.add(malha(geo('cotovelo', () => new Esf(0.05, 10, 8)), mats.roupa, 0, 0, 0));
      cotovelo.add(malha(geo('antebraco', () => new Cil(0.048, 0.04, 0.28, 10)), mats.pele, 0, -0.14, 0));
      const punho = new THREE.Group();
      punho.position.y = -0.29;
      cotovelo.add(punho);
      punho.add(malha(geo('mao', () => new Esf(0.052, 10, 8)), mats.pele, 0, -0.03, 0));
      tronco.add(ombro);
      return { ombro, cotovelo, punho };
    });
    const sombra = new THREE.Mesh(geo('sombra', () => new THREE.PlaneGeometry(1.1, 1.1)), new THREE.MeshBasicMaterial({ map: texturaSombra(), transparent: true, depthWrite: false, opacity: 0.6 }));
    sombra.rotation.x = -Math.PI / 2;
    sombra.position.y = 0.02;
    g.add(sombra);
    mats.sombra = sombra.material;
    // o facho de luz sobre o músico: um cone aberto, aditivo, na cor da família, que acende com o que ele toca
    const facho = new THREE.Mesh(geo('facho', () => new THREE.ConeGeometry(0.9, 6, 24, 1, true)), new THREE.MeshBasicMaterial({ color: cor, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    facho.position.y = 3;
    g.add(facho);
    mats.facho = facho.material;
    return { g, corpo, tronco, cabeca, bracos, pernas, mats };
  }
  let TEX_SOMBRA = null;
  function texturaSombra() {
    if (TEX_SOMBRA) return TEX_SOMBRA;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d'), gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(0,0,0,0.85)'); gr.addColorStop(0.5, 'rgba(0,0,0,0.4)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
    return (TEX_SOMBRA = new THREE.CanvasTexture(c));
  }

  // O instrumento pela voz: o timbre da melodia ou da harmonia, ou as peças de percussão que o músico já tocou.
  function criarInstrumento(m, timbre) {
    const { mats } = m.fig, g = new THREE.Group();
    const { CylinderGeometry: Cil, CapsuleGeometry: Cap, SphereGeometry: Esf, BoxGeometry: Caixa } = THREE;
    let pose = 'corda';
    if (m.grupo === 'perc') {
      pose = 'perc';
      // baquetas na mão, apontando para a frente: o punho dá o estalo no fim do golpe
      for (const { punho } of m.fig.bracos) {
        const baqueta = malha(geo('baqueta', () => new Cil(0.011, 0.014, 0.42, 6)), mats.madeira, 0, -0.04, 0.17);
        baqueta.rotation.x = Math.PI / 2;
        punho.add(baqueta);
      }
      g.add(malha(geo('surdo', () => new Cil(0.26, 0.26, 0.42, 24)), mats.madeira, 0, 0.72, 0.36));
      g.add(malha(geo('pele-surdo', () => new Cil(0.265, 0.265, 0.02, 24)), mats.metal, 0, 0.94, 0.36));
    } else if (timbre === 'contrabaixo') {
      pose = 'contrabaixo';
      const corpo = malha(geo('contrabaixo', () => new Cap(0.24, 0.6, 6, 14)), mats.madeira, 0.18, 0.75, 0.32);
      corpo.scale.z = 0.45;
      g.add(corpo, malha(geo('braco-cb', () => new Caixa(0.05, 0.9, 0.05)), mats.escuro, 0.18, 1.55, 0.32));
    } else if (CORDA[timbre]) {
      const s = CORDA[timbre], caixa = malha(geo('caixa-corda', () => new Cap(0.15, 0.12, 6, 14)), timbre === 'guitarra' || timbre === 'dist' ? mats.roupa : mats.madeira, 0, 0, 0);
      caixa.scale.set(s, s, 0.35 * s);
      const braco = malha(geo('braco-corda', () => new Caixa(1, 0.045, 0.03)), mats.escuro, -0.35 * s - 0.08, 0.02, 0);
      braco.scale.x = 0.5 * s + 0.12;
      const corpo = new THREE.Group();
      corpo.add(caixa, braco);
      corpo.position.set(0.05, 1.05, 0.24);
      corpo.rotation.z = 0.45;
      g.add(corpo);
    } else if (timbre === 'sanfona') {
      pose = 'sanfona';
      g.add(malha(geo('sanfona', () => new Caixa(0.46, 0.34, 0.2)), mats.roupa, 0, 1.05, 0.28), malha(geo('fole', () => new Caixa(0.48, 0.3, 0.12)), mats.escuro, 0, 1.05, 0.28));
    } else if (TECLA.has(timbre) || timbre === 'vibrafone' || timbre === 'caixinha' || timbre === 'sino') {
      pose = 'tecla';
      g.add(malha(geo('teclado', () => new Caixa(0.9, 0.08, 0.32)), timbre === 'vibrafone' || timbre === 'sino' ? mats.metal : mats.escuro, 0, 0.92, 0.48));
      if (!mats.teclas) mats.teclas = material(0xf2eee6, { roughness: 0.3 });
      g.add(malha(geo('teclas', () => new Caixa(0.86, 0.02, 0.12)), mats.teclas, 0, 0.97, 0.4));
      for (const x of [-0.4, 0.4]) g.add(malha(geo('pe-teclado', () => new Cil(0.02, 0.02, 0.88, 6)), mats.metal, x, 0.44, 0.48));
    } else if (timbre === 'voz' || timbre === 'coro') {
      pose = 'voz';
      g.add(malha(geo('pedestal', () => new Cil(0.015, 0.015, 1.5, 6)), mats.metal, 0, 0.75, 0.32), malha(geo('microfone', () => new Esf(0.045, 10, 8)), mats.escuro, 0, 1.52, 0.3));
    } else {
      pose = 'sopro';     // sopro, flauta, apito, violino: um tubo à boca
      const tubo = malha(geo('tubo-' + timbre, () => new Cil(0.025, timbre === 'sopro' ? 0.09 : 0.025, timbre === 'flauta' ? 0.6 : 0.5, 10)), timbre === 'cordas' ? mats.madeira : mats.metal, 0, 0, 0);
      const s = new THREE.Group();
      s.add(tubo);
      s.position.set(timbre === 'flauta' ? 0.25 : 0, 1.4, 0.3);
      s.rotation.set(timbre === 'flauta' ? 0 : 1.2, 0, timbre === 'flauta' ? Math.PI / 2 : 0);
      g.add(s);
    }
    m.fig.g.add(g);
    m.pose = pose;
  }

  // ── figurinos ──
  // Cada cenário veste os seus músicos: linho branco e chapéu panamá na praia da bossa, camisa listrada e chapéu de
  // malandro na roda de samba, chapéu de couro e lenço no sertão, jaqueta de couro e óculos escuros na garagem, boné
  // virado na rua, terno e boina no jazz, smoking e gravata-borboleta no teatro… A cor da família aparece num detalhe
  // (fita do chapéu, lenço, gravata), que liga o músico à legenda e ao facho de luz dele. E alguns (~1 em 5), sorteados
  // de forma fixa por músico, sobem ao palco montados: roupa de paetê furta-cor, boá de plumas, capa, coroa, cabelo
  // neon, óculos de estrela, plataforma.
  const FIGURINOS = {
    praia: { roupa: [0xf2ede0, 0xe8dcc0, 0x9ac8d8], listra: null, calca: 0xd8cdb0, chapeu: 'panama', extras: [] },
    roda: { roupa: [0xffffff, 0xf2f2f2], listra: [0xffffff, 0x1a1a1a], calca: 0xf0ece0, chapeu: 'malandro', extras: ['lenco'] },
    sertao: { roupa: [0x8a5a3a, 0xc8a070, 0x6a4a2a], listra: null, calca: 0x4a3a2a, chapeu: 'couro', extras: ['lenco'] },
    campo: { roupa: [0x8a2a2a, 0x2a5a8a, 0x5a7a3a], listra: [null, 0x1a1a1a], calca: 0x3a4a6a, chapeu: null, extras: ['lenco'] },
    taverna: { roupa: [0x141414, 0x2a0a0a], listra: null, calca: 0x101010, chapeu: 'malandroEscuro', extras: ['gravata', 'camisa'] },
    garagem: { roupa: [0x151515, 0x1e1e1e], listra: null, calca: 0x2a3550, chapeu: null, extras: ['oculos', 'camisa'] },
    rua: { roupa: [0xd23a3a, 0x2a2a2a, 0xe8e8e8, 0x3a6ad2], listra: null, calca: 0x2a3550, chapeu: 'bone', extras: ['corrente'] },
    clube: { roupa: [0x101018, 0x2a1050], listra: null, calca: 0x101018, chapeu: null, extras: ['oculos', 'neon'] },
    espaco: { roupa: [0xc8ccd8, 0xe0e4f0], listra: null, calca: 0xa8acb8, chapeu: null, extras: ['brilho'] },
    jazz: { roupa: [0x2a2a3a, 0x3a2a24, 0x1a1a2a], listra: null, calca: 0x1a1a24, chapeu: 'boina', extras: ['gravata', 'camisa'] },
    teatro: { roupa: [0x0e0e10], listra: null, calca: 0x0e0e10, chapeu: null, extras: ['gravata', 'camisa'] },
  };
  const EXOTICOS = ['plumas', 'capa', 'coroa', 'cabeloNeon', 'oculosEstrela', 'plataforma'];
  const NEON = [0xff3ad8, 0x3af0ff, 0xb4ff3a, 0xffb43a, 0x9a5aff, 0xff4a6a];
  const TEX_LISTRA = new Map();
  function texturaListras(a, b) {
    const k = a + ':' + b;
    if (TEX_LISTRA.has(k)) return TEX_LISTRA.get(k);
    const c = document.createElement('canvas');
    c.width = 8; c.height = 64;
    const x = c.getContext('2d'), cor = v => '#' + v.toString(16).padStart(6, '0');
    for (let i = 0; i < 8; i++) { x.fillStyle = cor(i % 2 ? b : a); x.fillRect(0, i * 8, 8, 8); }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    TEX_LISTRA.set(k, t);
    return t;
  }
  // escolhe o figurino: o do cenário da família, e às vezes um montado. Fixo por músico (hash da chave).
  function figurinoDe(chave, familia, corFam) {
    const cen = CENARIO_DE[familia] || 'teatro', F = FIGURINOS[cen];
    const pick = (lista, sal) => lista[Math.floor(hash(chave + sal) * lista.length) % lista.length];
    const exotico = hash(chave + 'queer') < 0.2;
    if (exotico) {
      const neon = pick(NEON, 'n'), outros = [...EXOTICOS].sort((a, b) => hash(chave + a) - hash(chave + b)).slice(0, 2 + (hash(chave + 'q') < 0.5 ? 1 : 0));
      return { exotico: true, roupa: neon, brilho: true, calca: pick([0x101010, 0xf2f2f2, neon], 'c'), chapeu: outros.includes('coroa') ? 'coroa' : null, extras: outros, acento: pick(NEON, 'a') };
    }
    const listra = F.listra && hash(chave + 'l') < 0.6 ? F.listra : null;
    return { roupa: pick(F.roupa, 'r'), listra: listra && [listra[0] ?? pick(F.roupa, 'r'), listra[1]], calca: F.calca,
      chapeu: F.chapeu && hash(chave + 'h') < 0.85 ? F.chapeu : null, extras: F.extras, brilho: F.extras.includes('brilho'), acento: corFam };
  }
  // os acessórios, montados na cabeça, no tronco e nas pernas do boneco
  function vestir(fig, f) {
    const { CylinderGeometry: Cil, SphereGeometry: Esf, BoxGeometry: Caixa, ConeGeometry: Cone, TorusGeometry: Toro, PlaneGeometry: Plano } = THREE;
    const { cabeca, tronco, mats } = fig, add = (pai, o) => { pai.add(o); return o; };
    const novo = (k, cor, extra) => (mats[k] = material(cor, extra));
    const acento = novo('acento', f.acento, { roughness: 0.6 });
    if (f.listra) { mats.roupa.map = texturaListras(f.listra[0], f.listra[1]); mats.roupa.color.set(0xffffff); mats.roupa.needsUpdate = true; }
    if (f.brilho) { mats.roupa.metalness = 0.85; mats.roupa.roughness = 0.22; }
    // chapéus
    const aba = (r, cor, k) => add(cabeca, malha(geo('aba' + r, () => new Cil(r, r, 0.018, 24)), novo(k, cor, { roughness: 0.8 }), 0, 0.1, 0));
    switch (f.chapeu) {
      case 'panama': aba(0.27, 0xe6d3a0, 'palha'); add(cabeca, malha(geo('copa', () => new Cil(0.13, 0.15, 0.12, 16)), mats.palha, 0, 0.17, 0)); add(cabeca, malha(geo('fita', () => new Cil(0.152, 0.152, 0.03, 16)), acento, 0, 0.125, 0)); break;
      case 'malandro': aba(0.25, 0xf4f0e6, 'feltro'); add(cabeca, malha(geo('copaM', () => new Cil(0.12, 0.15, 0.14, 16)), mats.feltro, 0, 0.18, 0)); add(cabeca, malha(geo('fita', () => new Cil(0.152, 0.152, 0.03, 16)), acento, 0, 0.125, 0)); break;
      case 'malandroEscuro': aba(0.25, 0x141414, 'feltro'); add(cabeca, malha(geo('copaM', () => new Cil(0.12, 0.15, 0.14, 16)), mats.feltro, 0, 0.18, 0)); add(cabeca, malha(geo('fita', () => new Cil(0.152, 0.152, 0.03, 16)), acento, 0, 0.125, 0)); break;
      case 'couro': {
        const couro = novo('couro', 0x7a4a24, { roughness: 0.7 });
        add(cabeca, malha(geo('copaC', () => new Esf(0.17, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2)), couro, 0, 0.06, 0));
        const meiaLua = add(cabeca, malha(geo('meiaLua', () => new Cil(0.26, 0.26, 0.02, 24, 1, false, 0, Math.PI)), couro, 0, 0.13, 0.02));
        meiaLua.rotation.set(-1.35, 0, 0);
        for (const x of [-0.08, 0, 0.08]) add(cabeca, malha(geo('estrela', () => new Esf(0.018, 6, 4)), acento, x, 0.2, 0.12));
        break;
      }
      case 'bone': {
        add(cabeca, malha(geo('copaB', () => new Esf(0.168, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2)), acento, 0, 0.03, 0));
        add(cabeca, malha(geo('pala', () => new Caixa(0.2, 0.015, 0.16)), acento, 0, 0.05, -0.2));      // virado para trás
        break;
      }
      case 'boina': { const b = add(cabeca, malha(geo('boina', () => new Esf(0.19, 16, 10)), novo('boina', 0x1a1a1a, { roughness: 0.95 }), 0.03, 0.13, -0.01)); b.scale.y = 0.35; b.rotation.z = -0.25; break; }
      case 'coroa': {
        const ouro = novo('ouro', 0xffcf4a, { metalness: 1, roughness: 0.2, emissive: 0x4a3000 });
        add(cabeca, malha(geo('aro', () => new Cil(0.15, 0.15, 0.05, 16, 1, true)), ouro, 0, 0.15, 0));
        for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2; add(cabeca, malha(geo('ponta', () => new Cone(0.025, 0.08, 6)), ouro, Math.sin(a) * 0.15, 0.21, Math.cos(a) * 0.15)); }
        break;
      }
    }
    for (const x of f.extras) {
      switch (x) {
        case 'lenco': add(tronco, malha(geo('lenco', () => new Toro(0.13, 0.035, 8, 16)), acento, 0, 0.66, 0.02)).rotation.x = Math.PI / 2; break;
        case 'gravata': for (const l of [-1, 1]) { const c = add(tronco, malha(geo('laco', () => new Cone(0.035, 0.07, 4)), acento, l * 0.035, 0.62, 0.19)); c.rotation.z = l * Math.PI / 2; } break;
        case 'camisa': add(tronco, malha(geo('camisa', () => new Caixa(0.12, 0.42, 0.02)), novo('camisa', 0xf2efe8, { roughness: 0.7 }), 0, 0.38, 0.195)); break;
        case 'corrente': add(tronco, malha(geo('corrente', () => new Toro(0.14, 0.012, 6, 20)), novo('ouroC', 0xffcf4a, { metalness: 1, roughness: 0.25 }), 0, 0.6, 0.06)).rotation.x = 1.25; break;
        case 'oculos': case 'oculosEstrela': {
          const estrela = x === 'oculosEstrela', m2 = estrela ? novo('lente', 0xff4ab8, { emissive: 0x5a0a3a, metalness: 0.5, roughness: 0.3 }) : novo('lente', 0x050505, { metalness: 0.6, roughness: 0.15 });
          for (const l of [-1, 1]) add(cabeca, malha(estrela ? geo('estrelaO', () => new Cone(0.06, 0.02, 5)) : geo('lenteO', () => new Caixa(0.08, 0.045, 0.02)), m2, l * 0.058, 0.02, 0.16)).rotation.x = estrela ? Math.PI / 2 : 0;
          add(cabeca, malha(geo('ponte', () => new Caixa(0.04, 0.01, 0.01)), m2, 0, 0.03, 0.165));
          break;
        }
        case 'neon': add(tronco, malha(geo('faixaNeon', () => new Caixa(0.42, 0.04, 0.42)), novo('neonF', 0x3af0ff, { emissive: 0x3af0ff, emissiveIntensity: 1.5 }), 0, 0.3, 0)); break;
        case 'plumas': for (let k = 0; k < 14; k++) { const a = k / 14 * Math.PI * 2; add(tronco, malha(geo('pluma', () => new Esf(0.045, 6, 5)), mats.acento, Math.sin(a) * 0.17, 0.66 + Math.sin(a * 3) * 0.02, Math.cos(a) * 0.15)); } break;
        case 'capa': { const c = add(tronco, malha(geo('capa', () => new Plano(0.55, 0.95)), novo('capa', f.acento, { side: THREE.DoubleSide, metalness: 0.6, roughness: 0.3 }), 0, 0.2, -0.22)); c.rotation.x = 0.12; break; }
        case 'cabeloNeon': mats.cabelo.color.set(f.acento); mats.cabelo.emissive.set(f.acento); mats.cabelo.emissiveIntensity = 0.35; break;
        case 'plataforma': for (const p of fig.pernas) add(p, malha(geo('plataforma', () => new Caixa(0.13, 0.12, 0.24)), novo('plataforma', f.acento, { metalness: 0.7, roughness: 0.25 }), 0, -0.76, 0.05)); break;
      }
    }
    mats.calca.color.set(f.calca);
  }

  function criarMusico(chave, familia, grupo, timbre) {
    const f = at.familia(familia);
    // a cor do macro-gênero, com um desvio de matiz por família: samba, MPB e forró são todos "Latin"
    const cor = new THREE.Color(f.cor), hsl = {};
    cor.getHSL(hsl);
    cor.setHSL((hsl.h + (hash(familia) - 0.5) * 0.22 + 1) % 1, hsl.s, Math.min(0.7, hsl.l * (0.8 + hash(familia + 'l') * 0.45)));
    const figurino = figurinoDe(chave, familia, cor.getHex());
    const fig = criarCorpo(chave, new THREE.Color(figurino.roupa));
    vestir(fig, figurino);
    const m = { chave, familia, grupo, timbre, fig, nomeFamilia: f.nome, pose: 'corda', pecas: new Set(),
      vis: 0, energia: 0, foco: 0, golpe: [0, 0], lado: 0, preparo: 0, prox: Infinity, ultimo: performance.now() / 1000, cabecaY: 0,
      alvo: new THREE.Vector3(), fase: hash(chave) * Math.PI * 2, exotico: !!figurino.exotico, chapeu: figurino.chapeu };
    criarInstrumento(m, timbre);
    run.cena.add(fig.g);
    return m;
  }

  const instDe = m => (m.grupo === 'perc' ? [...m.pecas].slice(-3).map(p => NOME_PERC[p] || p).join(', ') || NOME_GRUPO.perc : NOME_TIMBRE[m.timbre] || NOME_GRUPO[m.grupo]);
  function rotulo(m) { return `${instDe(m)} · ${m.nomeFamilia}`; }

  // ── instrumentos ao vivo ──
  // Cada nota soma a sua força ao instrumento que a tocou (a peça, na percussão; o timbre, no resto), e tudo esquece
  // devagar (meia-vida de ~2 s). A parte de cada um é a fatia desse total: o que a banda está tocando agora.
  const MEIA_VIDA_S = 2;
  // Recolhido, o painel não custa nada: as notas nem são somadas. Abrir começa a ouvir do zero.
  const CHAVE_INST = 'tocador-atlas-sim-instrumentos';
  const instAberto = () => !!run && $('sim-instrumentos').open;
  function somarInstrumento(e, v) {
    if (!instAberto()) return;
    const g = grupoDe(e.papel), nome = g === 'perc' ? NOME_PERC[e.papel] || e.papel : NOME_TIMBRE[e.timbre] || NOME_GRUPO[g];
    let x = run.inst.get(nome);
    if (!x) { x = { nome, peso: 0, cor: '', li: null }; run.inst.set(nome, x); }
    x.peso += v;
    x.cor = at.familia(e.familia).cor;
  }
  function desenharInstrumentos(dt) {
    if (!instAberto()) return;
    const caiu = Math.pow(0.5, dt / MEIA_VIDA_S);
    let tot = 0;
    for (const x of run.inst.values()) { x.peso *= caiu; tot += x.peso; }
    run.tInst += dt;
    if (run.tInst < 0.25) return;            // quatro vezes por segundo basta para o número
    run.tInst = 0;
    const lista = $('sim-instrumentos-lista');
    const vivos = [...run.inst.values()].filter(x => tot > 0 && x.peso / tot >= 0.01).sort((a, b) => b.peso - a.peso).slice(0, 10);
    for (const x of run.inst.values()) {
      if (vivos.includes(x)) continue;
      if (x.li) { x.li.remove(); x.li = null; }
      if (x.peso < 1e-4) run.inst.delete(x.nome);
    }
    vivos.forEach((x, j) => {
      if (!x.li) {
        x.li = document.createElement('li');
        x.li.append(document.createElement('i'), document.createTextNode(x.nome + ' '), document.createElement('b'));
      }
      const pct = Math.round(100 * x.peso / tot);
      x.li.lastChild.textContent = `${pct}%`;
      x.li.style.setProperty('--p', `${pct}%`);
      x.li.style.setProperty('--cor', x.cor);
      x.li.classList.toggle('some', pct < 3);
      if (lista.children[j] !== x.li) lista.insertBefore(x.li, lista.children[j] || null);
    });
    let ouvindo = lista.querySelector('.ouvindo');
    if (!vivos.length && !ouvindo) {
      ouvindo = document.createElement('li');
      ouvindo.className = 'ouvindo';
      ouvindo.textContent = 'ouvindo…';
      lista.append(ouvindo);
    } else if (vivos.length && ouvindo) ouvindo.remove();
  }
  $('sim-instrumentos')?.addEventListener('toggle', () => {
    const aberto = $('sim-instrumentos').open;
    try { localStorage.setItem(CHAVE_INST, aberto ? '1' : '0'); } catch {}
    if (!run) return;
    for (const x of run.inst.values()) x.li?.remove();
    run.inst.clear();
    run.tInst = 1;           // desenha já: "ouvindo…" na hora em que abre
    if (!aberto) $('sim-instrumentos-lista').replaceChildren();
  });

  // ── palco ──
  // Em arco, agrupados por família na ordem em que entraram; dentro da família, percussão atrás e melodia na frente.
  function rearranjar() {
    const ms = [...run.musicos.values()].filter(m => !m.saindo);
    const famOrdem = [...new Set(ms.map(m => m.familia))];
    ms.sort((a, b) => famOrdem.indexOf(a.familia) - famOrdem.indexOf(b.familia) || ORDEM[a.grupo] - ORDEM[b.grupo]);
    const n = ms.length, abre = Math.min(2.4, 0.5 + n * 0.22), raio = 3 + n * 0.12;
    ms.forEach((m, j) => {
      const a = n === 1 ? 0 : -abre / 2 + abre * j / (n - 1);
      const fundo = m.grupo === 'perc' ? 0.9 : m.grupo === 'baixo' ? 0.5 : 0;
      m.alvo.set(Math.sin(a) * (raio + fundo), 0, -Math.cos(a) * (raio + fundo) + raio);
    });
  }

  function montarCena() {
    const { Scene, Fog, PerspectiveCamera, WebGLRenderer, HemisphereLight, DirectionalLight, SpotLight, CircleGeometry, Mesh, MeshStandardMaterial, RingGeometry, SphereGeometry, ShaderMaterial, Color, BackSide } = THREE;
    const cena = new Scene();
    cena.fog = new Fog(0x0f0e0c, 9, 22);
    const cam = new PerspectiveCamera(42, 1, 0.1, 90);
    cam.position.set(0, 3.2, 9.5);
    const r = new WebGLRenderer({ canvas: $('sim-canvas'), antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    r.toneMapping = THREE.ACESFilmicToneMapping;      // a curva de filme: brilhos que estouram com suavidade
    r.toneMappingExposure = 0.95;
    // céu: uma esfera por dentro, do horizonte ao alto, sem névoa
    const ceu = new Mesh(new SphereGeometry(60, 24, 12), new ShaderMaterial({
      side: BackSide, depthWrite: false, fog: false,
      uniforms: { alto: { value: new Color(0x0f0e0c) }, baixo: { value: new Color(0x0f0e0c) } },
      vertexShader: 'varying float h; void main() { h = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 alto; uniform vec3 baixo; varying float h; void main() { gl_FragColor = vec4(mix(baixo, alto, smoothstep(-0.05, 0.6, h)), 1.0); }',
    }));
    cena.add(ceu);
    const hemi = new HemisphereLight(0xfff1dc, 0x1a140d, 0.7);
    cena.add(hemi);
    const sol = new DirectionalLight(0xffe0b0, 1.1);
    sol.position.set(3, 8, 6);
    cena.add(sol);
    // contraluz: desenha a silhueta dos músicos contra o fundo, na cor do cenário
    const contra = new DirectionalLight(0xffc890, 1.6);
    contra.position.set(-2, 5, -8);
    cena.add(contra);
    // poeira na névoa dos fachos: 240 pontos aditivos que flutuam no shader, sem custo de CPU por quadro
    const n = 240, pos = new Float32Array(n * 3), fase = new Float32Array(n);
    for (let i = 0; i < n; i++) { pos.set([(hash('px' + i) - 0.5) * 12, hash('py' + i) * 5, (hash('pz' + i) - 0.5) * 8 + 2], i * 3); fase[i] = hash('pf' + i) * 6.28; }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    pg.setAttribute('fase', new THREE.BufferAttribute(fase, 1));
    const poeira = new THREE.Points(pg, new ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { t: { value: 0 }, cor: { value: new Color(0xffe8c0) } },
      vertexShader: 'attribute float fase; uniform float t; varying float a; void main() { vec3 p = position; p.y = mod(p.y + t * 0.12, 5.0); p.x += sin(t * 0.3 + fase) * 0.3; a = 0.35 + 0.35 * sin(t + fase); vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_PointSize = 40.0 / -mv.z; gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'uniform vec3 cor; varying float a; void main() { float d = length(gl_PointCoord - 0.5); gl_FragColor = vec4(cor, a * smoothstep(0.5, 0.0, d) * 0.5); }',
    }));
    cena.add(poeira);
    const terra = new Mesh(new CircleGeometry(45, 48), new MeshStandardMaterial({ color: 0x2a221a, roughness: 0.95 }));
    terra.rotation.x = -Math.PI / 2;
    terra.position.set(0, -0.01, 0);
    cena.add(terra);
    const chao = new Mesh(new CircleGeometry(6.5, 64), new MeshStandardMaterial({ color: 0x3a2a1c, roughness: 0.8 }));
    chao.rotation.x = -Math.PI / 2;
    chao.position.set(0, 0.01, 3);
    cena.add(chao);
    const borda = new Mesh(new RingGeometry(6.45, 6.6, 64), new MeshStandardMaterial({ color: 0xd4a574, emissive: 0x3a2a14 }));
    borda.rotation.x = -Math.PI / 2;
    borda.position.set(0, 0.015, 3);
    cena.add(borda);
    const foco = new SpotLight(0xfff0d0, 0, 14, 0.35, 0.6, 1);
    foco.position.set(0, 7, 5);
    cena.add(foco, foco.target);
    return { cena, cam, r, foco, ceu, hemi, sol, contra, terra, poeira, cenarios: {} };
  }

  // ── cenários ──
  // Os objetos ficam num anel atrás e dos lados do palco; cada cenário sorteia os seus ângulos (sempre os mesmos), e
  // dois cenários presentes ao mesmo tempo se intercalam no anel.
  function lugar(cen, j, rMin = 10, rMax = 17) {
    const a = (hash(cen + j) - 0.5) * 2 * 1.95, raio = rMin + hash(cen + j + 'r') * (rMax - rMin);
    return [Math.sin(a) * raio, 2 - Math.cos(a) * raio];
  }
  function montarCenario(nome) {
    const g = new THREE.Group(), mats = [], anim = [];
    const mat = (cor, extra = {}) => { const m = material(cor, extra); mats.push(m); return m; };
    const brilho = cor => mat(cor, { emissive: cor, emissiveIntensity: 1.2 });
    const add = (geo, m, x, y, z, rx = 0, ry = 0, rz = 0) => { const o = malha(geo, m, x, y, z); o.rotation.set(rx, ry, rz); g.add(o); return o; };
    const { BoxGeometry: Caixa, CylinderGeometry: Cil, ConeGeometry: Cone, SphereGeometry: Esf, TorusGeometry: Toro, PlaneGeometry: Plano } = THREE;
    const arvore = (x, z, copa, alto = 2.2) => { add(new Cil(0.12, 0.18, alto, 6), mat(0x5a3a1e), x, alto / 2, z); add(new Esf(0.9, 10, 8), mat(copa), x, alto + 0.5, z); };
    const coqueiro = (x, z) => {
      const tronco = add(new Cil(0.1, 0.16, 3.2, 6), mat(0x8a6a3e), x, 1.6, z, 0, 0, 0.18);
      for (let k = 0; k < 6; k++) add(new Cone(0.35, 1.8, 3), mat(0x2f7a3a), x - 0.3, 3.1, z, Math.PI / 2.4, k * Math.PI / 3, 0);
      return tronco;
    };
    const fio = (x0, x1, z, y, n, cores, forma) => {
      for (let k = 0; k <= n; k++) {
        const f = k / n, x = x0 + (x1 - x0) * f, yy = y - Math.sin(f * Math.PI) * 0.6;
        const cor = cores[k % cores.length];
        add(forma === 'bandeira' ? new Cone(0.16, 0.3, 3) : new Esf(0.08, 8, 6), forma === 'bandeira' ? mat(cor) : brilho(cor), x, yy, z, forma === 'bandeira' ? Math.PI : 0);
      }
      for (const x of [x0, x1]) add(new Cil(0.05, 0.05, y, 6), mat(0x3a2a1c), x, y / 2, z);
    };
    switch (nome) {
      case 'praia': {
        add(new Plano(90, 26), mat(0x2f7fb5, { roughness: 0.25, metalness: 0.2 }), 0, 0.02, -24, -Math.PI / 2);
        const pao = add(new Esf(4, 14, 10), mat(0x4f6b4a), -9, 3.5, -36); pao.scale.set(0.8, 1.8, 0.8);
        const urca = add(new Esf(3.5, 14, 10), mat(0x45603f), -16, 2, -34); urca.scale.set(1.2, 1.1, 0.9);
        add(new Esf(2.2, 16, 12), brilho(0xffa64d), 14, 2.5, -45);
        for (let j = 0; j < 4; j++) { const [x, z] = lugar(nome, j, 9, 13); coqueiro(x, Math.max(z, -8)); }
        const ondas = add(new Plano(90, 0.4), mat(0xf4f1e8), 0, 0.03, -11.2, -Math.PI / 2);
        anim.push(t => { ondas.position.z = -11.2 + Math.sin(t * 0.8) * 0.5; });
        break;
      }
      case 'roda': {
        for (const [x, z, rx] of [[-14, -24, 9], [12, -26, 11]]) {
          const morro = add(new Esf(rx, 16, 10), mat(0x3b4a2e), x, -rx * 0.35, z); morro.scale.y = 0.75;
          for (let k = 0; k < 18; k++) {
            const a = hash(nome + x + k) * Math.PI - Math.PI / 2, h = 0.2 + hash(nome + k + 'h') * 0.9, rr = rx * (0.55 + 0.3 * h);
            add(new Caixa(1, 0.8, 0.8), mat([0xe8b04a, 0xd2553a, 0x5ab0c8, 0xf0e6d0, 0x8fc05a][k % 5]), x + Math.sin(a) * rr, rx * 0.75 * h * 0.75 - rx * 0.35 + rx * 0.4, z + rx * 0.5 + Math.cos(a) * 0.5 * rr * 0.3);
          }
        }
        // a escadaria do morro, subindo atrás da roda até as casinhas
        const degrau = mat(0xb8a890), corrimao = mat(0x5a5a5a, { metalness: 0.5 });
        for (let k = 0; k < 16; k++) add(new Caixa(2.2, 0.28, 0.7), degrau, -5.5 - k * 0.32, 0.14 + k * 0.28, -9 - k * 0.6);
        add(new Cil(0.03, 0.03, 11, 6), corrimao, -4.3 - 2.4, 3.3, -13.8, 1.08, 0, 0.27);
        fio(-5, 5, -2.5, 4.2, 14, [0xffd27a, 0xffe7b0], 'lampada');
        // a mesa do bar, com o cavaquinho deitado em cima e o tantã ao lado
        const [x, z] = lugar(nome, 1, 8.5, 9.5);
        add(new Cil(0.7, 0.7, 0.08, 16), mat(0x7a4a2a), x, 0.9, z); add(new Cil(0.08, 0.08, 0.9, 6), mat(0x3a2a1c), x, 0.45, z);
        add(new Cil(0.12, 0.12, 0.3, 8), mat(0xf0c060), x + 0.2, 1.08, z);
        const cavaco = add(new Esf(0.16, 12, 8), mat(0x9a5a2a, { roughness: 0.4 }), x - 0.15, 0.97, z + 0.1); cavaco.scale.set(1, 0.3, 0.75);
        add(new Caixa(0.38, 0.03, 0.05), mat(0x2a1a10), x - 0.45, 0.97, z + 0.1);
        add(new Cil(0.3, 0.28, 0.75, 16), mat(0x2a2a2a, { metalness: 0.4, roughness: 0.4 }), x + 1.1, 0.38, z + 0.2, 0, 0, 0);
        add(new Cil(0.3, 0.3, 0.02, 16), mat(0xe8dcc0), x + 1.1, 0.76, z + 0.2);
        // a plateia em volta, batendo palma no tempo da banda
        const corpoGente = new Cil(0.17, 0.2, 0.75, 8), cabecaGente = new Esf(0.13, 10, 8), bracoGente = new Cil(0.035, 0.03, 0.45, 6);
        for (let k = 0; k < 11; k++) {
          const a = -1.75 + 3.5 * k / 10 + (hash('pl' + k) - 0.5) * 0.18, raio = 7.4 + hash('pr' + k) * 0.9;
          const p = new THREE.Group();
          p.position.set(Math.sin(a) * raio, 0, 2.5 - Math.cos(a) * raio);
          p.rotation.y = Math.atan2(-p.position.x, 2.5 - p.position.z);
          const pele = mat(new THREE.Color().setHSL(0.06 + hash('pp' + k) * 0.04, 0.4, 0.25 + hash('pq' + k) * 0.4));
          const roupa = mat([0xf2f2f2, 0xd2553a, 0x2a6ad2, 0xf2c230, 0x1a1a1a, 0x4fbf5a][k % 6]);
          p.add(malha(new Cil(0.06, 0.05, 0.85, 6), mat(0x2a2a30), 0, 0.42, 0));
          p.add(malha(corpoGente, roupa, 0, 1.2, 0), malha(cabecaGente, pele, 0, 1.72, 0));
          const bracos = [-1, 1].map(l => { const o = new THREE.Group(); o.position.set(0.2 * l, 1.5, 0); o.add(malha(bracoGente, pele, 0, -0.22, 0)); p.add(o); return o; });
          g.add(p);
          const fase = hash('pf' + k) * 0.3, alto = hash('pa' + k) < 0.35;     // alguns batem palma acima da cabeça
          anim.push(() => {
            const bt = (run?.batida ?? 0) + fase, junta = Math.pow(Math.max(0, Math.cos(bt * Math.PI * 2)), 6);   // as mãos se encontram na batida
            for (const [j, o] of bracos.entries()) { const l = j ? -1 : 1; o.rotation.x = alto ? -2.6 : -1.3; o.rotation.z = l * (0.55 - 0.45 * junta); }
            p.position.y = Math.max(0, Math.sin(bt * Math.PI * 2)) * 0.04;
          });
        }
        break;
      }
      case 'sertao': {
        for (let j = 0; j < 6; j++) {
          const [x, z] = lugar(nome, j); const h = 1.6 + hash(nome + j + 'c') * 1.6;
          add(new Cil(0.22, 0.25, h, 8), mat(0x4f7a3a), x, h / 2, z);
          add(new Cil(0.13, 0.13, 0.8, 8), mat(0x4f7a3a), x + 0.35, h * 0.6, z, 0, 0, 0.1);
          add(new Cil(0.13, 0.13, 0.7, 8), mat(0x4f7a3a), x - 0.35, h * 0.5, z, 0, 0, -0.1);
        }
        fio(-6, 6, -3, 4.5, 18, [0xe8443a, 0xf2c230, 0x3a8fe0, 0x4fbf5a, 0xf07ab0], 'bandeira');
        const [fx, fz] = lugar(nome, 9, 8, 9);
        const fogo = add(new Cone(0.5, 1.2, 7), brilho(0xff7a2a), fx, 0.6, fz);
        for (let k = 0; k < 3; k++) add(new Cil(0.08, 0.08, 1.2, 6), mat(0x4a2e1a), fx, 0.1, fz, Math.PI / 2, k * 1.05, 0);
        add(new Esf(1.4, 14, 10), brilho(0xf6e7c0), -12, 18, -40);
        anim.push(t => { fogo.scale.set(1, 0.85 + 0.25 * Math.abs(Math.sin(t * 7) + Math.sin(t * 11)) / 2, 1); });
        break;
      }
      case 'campo': {
        for (let j = 0; j < 7; j++) { const [x, z] = lugar(nome, j); arvore(x, z, [0x3f7a34, 0x5a8f3a, 0x2f6a2e][j % 3]); }
        for (const [x, z, rr] of [[-18, -30, 10], [10, -34, 13], [26, -26, 8]]) { const c = add(new Esf(rr, 16, 10), mat(0x6a9a46), x, -rr * 0.6, z); c.scale.y = 0.6; }
        break;
      }
      case 'taverna': {
        add(new Caixa(30, 9, 0.6), mat(0x6a3424), 0, 4.5, -10);
        for (let k = 0; k < 6; k++) add(new Caixa(29.8, 0.06, 0.62), mat(0x3a1a12), 0, 1 + k * 1.3, -9.98);
        for (let j = 0; j < 4; j++) { const [x, z] = lugar(nome, j, 8, 9.5); add(new Cil(0.5, 0.45, 1.1, 12), mat(0x7a4a24), x, 0.55, Math.max(z, -9)); add(new Toro(0.48, 0.03, 6, 16), mat(0x2a2a2a), x, 0.8, Math.max(z, -9), Math.PI / 2); }
        for (const x of [-4, -1.3, 1.3, 4]) { add(new Cil(0.01, 0.01, 2, 4), mat(0x1a1a1a), x, 5, -1); const l = add(new Esf(0.18, 10, 8), brilho(0xffb35a), x, 4, -1); anim.push(t => { l.material.emissiveIntensity = 1 + 0.15 * Math.sin(t * 3 + x); }); }
        break;
      }
      case 'garagem': {
        // a parede do fundo, de blocos, com a porta de enrolar meio aberta e pôsteres
        add(new Caixa(18, 7, 0.4), mat(0x3a3836, { roughness: 0.95 }), 0, 3.5, -8.5);
        for (let k = 0; k < 9; k++) add(new Caixa(17.9, 0.03, 0.42), mat(0x2a2826), 0, 0.4 + k * 0.75, -8.48);
        add(new Caixa(5.2, 4.2, 0.1), mat(0x0a0a0a), -4.5, 2.1, -8.25);                       // o vão escuro da porta
        for (let k = 0; k < 7; k++) add(new Caixa(5.2, 0.3, 0.08), mat(0x8a8e92, { metalness: 0.6, roughness: 0.4 }), -4.5, 2.6 + k * 0.3, -8.18);   // as lâminas, meio enroladas
        const posteres = ['AO VIVO', 'SOM NA GARAGEM', 'TOCADOR', 'SÁBADO 22H'];
        posteres.forEach((txt, k) => {
          const c = document.createElement('canvas'); c.width = 128; c.height = 180;
          const x2 = c.getContext('2d'), cores = [['#d2283a', '#f2e6d0'], ['#111', '#f2c230'], ['#f2e6d0', '#d2283a'], ['#2a3a8a', '#f2f2f2']][k];
          x2.fillStyle = cores[0]; x2.fillRect(0, 0, 128, 180);
          x2.fillStyle = cores[1]; x2.beginPath(); x2.arc(64, 70, 38 - k * 4, 0, Math.PI * 2); x2.fill();
          x2.font = 'bold 18px sans-serif'; x2.textAlign = 'center';
          txt.split(' ').forEach((w, i) => x2.fillText(w, 64, 140 + i * 20));
          const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
          const m2 = mat(0xffffff, { map: tex, roughness: 0.9 });
          add(new Plano(1.1, 1.55), m2, 1.2 + k * 1.6, 3.6 + (k % 2) * 0.35, -8.28, 0, 0, (hash('po' + k) - 0.5) * 0.12);
        });
        // a bateria no fundo do palco: bumbo deitado, caixa, tons e pratos nos pedestais
        const bx = 3.2, bz = -0.6, casco = mat(0x7a1a1a, { metalness: 0.3, roughness: 0.35 }), pele = mat(0xe8e2d6), cromo = mat(0xd8d8d8, { metalness: 0.9, roughness: 0.2 });
        add(new Cil(0.45, 0.45, 0.4, 20), casco, bx, 0.45, bz, Math.PI / 2);
        add(new Cil(0.43, 0.43, 0.02, 20), pele, bx, 0.45, bz + 0.21, Math.PI / 2);
        for (const [dx, y, r] of [[-0.55, 0.62, 0.2], [-0.25, 1.0, 0.16], [0.25, 1.0, 0.17], [0.65, 0.55, 0.24]]) {
          add(new Cil(r, r, 0.2, 16), casco, bx + dx, y, bz + 0.25); add(new Cil(r, r, 0.015, 16), pele, bx + dx, y + 0.1, bz + 0.25);
        }
        const pratos = [];
        for (const [dx, y, dz] of [[-0.95, 1.5, 0.1], [0.95, 1.65, 0], [-0.75, 1.05, 0.5]]) {
          add(new Cil(0.015, 0.015, y, 6), cromo, bx + dx, y / 2, bz + dz);
          pratos.push(add(new Cil(0.36, 0.02, 0.025, 20), mat(0xd8b44a, { metalness: 0.95, roughness: 0.25 }), bx + dx, y, bz + dz, 0.15, 0, 0));
        }
        // os pratos tremem quando a banda bate forte
        anim.push(t => { const f = run?.flash ?? 0; pratos.forEach((p, k) => { p.rotation.x = 0.15 + Math.sin(t * 30 + k) * 0.06 * f; }); });
        for (let j = 0; j < 4; j++) { const [x, z] = lugar(nome, j, 7.5, 9); const zz = Math.max(z, -7); add(new Caixa(1.4, 1.6, 0.8), mat(0x141414), x, 0.8, zz); add(new Caixa(1.2, 1.2, 0.05), mat(0x5a5a5a), x, 0.85, zz + 0.42); add(new Caixa(1.4, 1.2, 0.8), mat(0x141414), x, 2.2, zz); }
        for (const x of [-6, 6]) add(new Caixa(0.2, 6, 0.2), mat(0x8a8a8a, { metalness: 0.6 }), x, 3, -3);
        add(new Caixa(12.2, 0.2, 0.2), mat(0x8a8a8a, { metalness: 0.6 }), 0, 6, -3);
        for (const x of [-3, 0, 3]) { const r2 = add(new Cone(0.3, 0.6, 10), brilho(0xff3a2a), x, 5.6, -3, Math.PI); anim.push(t => { r2.material.emissiveIntensity = 0.6 + 0.8 * Math.max(0, Math.sin(t * 4 + x)); }); }
        // fumaça no chão: lençóis translúcidos que se arrastam devagar
        const fumacaTex = (() => {
          const c = document.createElement('canvas'); c.width = c.height = 64;
          const x2 = c.getContext('2d'), gr = x2.createRadialGradient(32, 32, 0, 32, 32, 32);
          gr.addColorStop(0, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
          x2.fillStyle = gr; x2.fillRect(0, 0, 64, 64);
          return new THREE.CanvasTexture(c);
        })();
        for (let k = 0; k < 9; k++) {
          const m2 = new THREE.MeshBasicMaterial({ map: fumacaTex, transparent: true, depthWrite: false, opacity: 0.5, color: 0xd8d0d8, fog: false });
          m2.userData.base = 0.5;
          mats.push(m2);
          const f = add(new Plano(4.5, 4.5), m2, (hash('fx' + k) - 0.5) * 12, 0.12 + k * 0.015, 2.5 + (hash('fz' + k) - 0.5) * 8, -Math.PI / 2);
          const x0 = f.position.x, v = 0.15 + hash('fv' + k) * 0.2;
          anim.push(t => { f.position.x = x0 + Math.sin(t * v + k) * 1.5; f.rotation.z = t * v * 0.3 + k; });
        }
        break;
      }
      case 'rua': {
        for (let j = 0; j < 8; j++) { const [x, z] = lugar(nome, j, 13, 20); const h = 4 + hash(nome + j + 'h') * 9; add(new Caixa(3, h, 3), mat([0x4a4458, 0x5a4a40, 0x3a4a58, 0x6a5a4a][j % 4]), x, h / 2, z); }
        add(new Caixa(14, 2.4, 0.4), mat(0x8a8a8a), 0, 1.2, -8);
        for (const [x, cor] of [[-5, 0xff4fa0], [-1, 0x3ad0ff], [3, 0xffd23a]]) add(new Caixa(3, 1.2, 0.05), mat(cor), x, 1.3, -7.77, 0, 0, 0.12);
        for (const x of [-7.5, 7.5]) { add(new Cil(0.07, 0.07, 4.5, 6), mat(0x2a2a2a), x, 2.25, -1); add(new Esf(0.25, 10, 8), brilho(0xffc070), x, 4.5, -1); }
        break;
      }
      case 'clube': {
        for (let j = 0; j < 8; j++) { const [x, z] = lugar(nome, j, 8, 11); add(new Caixa(0.15, 5, 0.15), brilho(j % 2 ? 0x3af0ff : 0xff3ad8), x, 2.5, Math.max(z, -9)); }
        const globo = add(new Esf(0.6, 16, 12), mat(0xdddddd, { metalness: 1, roughness: 0.15 }), 0, 6.5, 0);
        for (let k = 0; k < 5; k++) {
          const laser = new THREE.Group(); laser.position.set(-4 + k * 2, 0.2, -6);
          laser.add(malha(new Cil(0.015, 0.015, 14, 4), brilho([0x3aff6a, 0xff3a6a, 0x6a3aff][k % 3]), 0, 7, 0)); g.add(laser);
          anim.push(t => { laser.rotation.z = Math.sin(t * 0.9 + k) * 0.7; laser.rotation.x = 0.4 + Math.sin(t * 0.6 + k * 2) * 0.3; });
        }
        anim.push(t => { globo.rotation.y = t * 0.8; });
        break;
      }
      case 'espaco': {
        const pos = new Float32Array(900);
        for (let k = 0; k < 300; k++) { const a = hash('e' + k) * Math.PI * 2, b = hash('f' + k) * 1.3, rr = 50; pos.set([Math.cos(a) * Math.cos(b) * rr, Math.sin(b) * rr, Math.sin(a) * Math.cos(b) * rr], k * 3); }
        const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const pm = new THREE.PointsMaterial({ color: 0xffffff, size: 0.25, transparent: true, fog: false }); mats.push(pm);
        g.add(new THREE.Points(geo, pm));
        add(new Esf(5, 24, 16), mat(0x6a5aa0), 18, 9, -40);
        add(new Toro(8, 0.3, 4, 48), brilho(0xb0a0e0), 18, 9, -40, 1.2, 0, 0.3);
        for (let j = 0; j < 6; j++) { const [x, z] = lugar(nome, j, 7, 12); const b2 = add(new Esf(0.3 + hash(nome + j) * 0.4, 12, 8), brilho([0x9ab8ff, 0xffb0e0, 0xb0ffd8][j % 3]), x, 2.5, z); anim.push(t => { b2.position.y = 2.5 + Math.sin(t * 0.7 + j) * 0.8; }); }
        break;
      }
      case 'jazz': {
        add(new Caixa(28, 8, 0.4), mat(0x7a1a22), 0, 4, -9);
        for (let k = 0; k < 14; k++) add(new Cil(0.12, 0.12, 8, 6), mat(0x6a141c), -13 + k * 2, 4, -8.75);
        for (let j = 0; j < 4; j++) { const [x, z] = lugar(nome, j, 8, 9.5); const zz = Math.max(z, -7); add(new Cil(0.5, 0.5, 0.05, 16), mat(0x2a1a12), x, 0.85, zz); add(new Cil(0.05, 0.05, 0.85, 6), mat(0x2a1a12), x, 0.42, zz); const v = add(new Cil(0.04, 0.04, 0.12, 6), brilho(0xffc070), x, 0.95, zz); anim.push(t => { v.material.emissiveIntensity = 1 + 0.3 * Math.sin(t * 9 + j); }); }
        break;
      }
      case 'teatro': {
        add(new Caixa(26, 9, 0.4), mat(0x8a1a1a), 0, 4.5, -9);
        for (let j = 0; j < 6; j++) { const x = -10 + j * 4; add(new Cil(0.35, 0.4, 7, 12), mat(0xe8e0d0), x, 3.5, -7.5); }
        const lustre = add(new Esf(0.6, 12, 8), brilho(0xffe8b0), 0, 6.5, 0);
        anim.push(t => { lustre.rotation.y = t * 0.2; });
        break;
      }
    }
    g.visible = false;
    run.cena.add(g);
    return { g, mats, anim, peso: 0, alvo: 0, def: CENARIOS[nome] };
  }

  // Peso de cada cenário: os músicos no palco da família dele, cada um por quanto aparece e toca.
  function pesarCenarios(dt) {
    const alvo = {};
    for (const m of run.musicos.values()) {
      const cen = CENARIO_DE[m.familia];
      if (cen) alvo[cen] = (alvo[cen] || 0) + m.vis * (0.6 + Math.min(1, m.energia));
    }
    let max = 0;
    for (const v of Object.values(alvo)) max = Math.max(max, v);
    for (const nome of Object.keys(CENARIOS)) {
      const v = max ? (alvo[nome] || 0) / max : 0;
      let c = run.cenarios[nome];
      if (!c && v > 0.05) c = run.cenarios[nome] = montarCenario(nome);
      if (!c) continue;
      c.alvo = v;
      c.peso += (v - c.peso) * Math.min(1, dt * 0.7);
    }
  }
  const CORES = {};
  function aplicarCenarios(t) {
    if (!CORES.tmp) for (const k of ['alto', 'baixo', 'chao', 'luz', 'tmp']) CORES[k] = new THREE.Color();
    const { alto, baixo, chao, luz, tmp } = CORES;
    alto.setRGB(0, 0, 0); baixo.setRGB(0, 0, 0); chao.setRGB(0, 0, 0); luz.setRGB(0, 0, 0);
    let tot = 0;
    for (const c of Object.values(run.cenarios)) {
      const p = c.peso;
      c.g.visible = p > 0.02;
      if (!c.g.visible) continue;
      c.g.scale.set(1, Math.max(0.02, Math.min(1, p * 1.4)), 1);     // os objetos sobem do chão com o peso
      const op = Math.min(1, p * 1.6);
      if (op !== c.op) { c.op = op; for (const m of c.mats) opacidade(m, op * (m.userData.base ?? 1)); }     // a fumaça nunca passa da sua transparência
      if (!reduz.matches) for (const f of c.anim) f(t);
      tot += p;
      alto.add(tmp.setHex(c.def.ceu[0]).multiplyScalar(p));
      baixo.add(tmp.setHex(c.def.ceu[1]).multiplyScalar(p));
      chao.add(tmp.setHex(c.def.chao).multiplyScalar(p));
      luz.add(tmp.setHex(c.def.luz).multiplyScalar(p));
    }
    // sem cenário (ninguém no palco), o escuro do atlas
    const resto = Math.max(0, 1 - tot);
    alto.add(tmp.setHex(0x0f0e0c).multiplyScalar(resto)); baixo.add(tmp.setHex(0x1a1612).multiplyScalar(resto));
    chao.add(tmp.setHex(0x2a221a).multiplyScalar(resto)); luz.add(tmp.setHex(0xfff1dc).multiplyScalar(resto));
    const n = Math.max(1, tot);
    alto.multiplyScalar(1 / n); baixo.multiplyScalar(1 / n); chao.multiplyScalar(1 / n); luz.multiplyScalar(1 / n);
    run.ceu.material.uniforms.alto.value.copy(alto);
    run.ceu.material.uniforms.baixo.value.copy(baixo);
    run.cena.fog.color.copy(baixo);
    run.terra.material.color.copy(chao);
    run.hemi.color.copy(luz);
    run.sol.color.copy(luz);
    run.contra.color.copy(luz);
    run.poeira.material.uniforms.cor.value.copy(luz);
  }

  // ── notas ──
  // Chegam adiantadas (o motor agenda ~0,1 s à frente): ficam na fila até o relógio do áudio alcançá-las.
  function aoTocar(e) {
    if (!run) return;
    const f = run.fila;
    if (f.length && e.t < f[f.length - 1].t) run.desordem = true;     // quase sempre chegam em ordem: ordenar só quando não
    f.push(e);
  }
  // Um músico por família, grupo e instrumento: quando a voz troca de instrumento (cavaquinho → flauta), quem
  // tocava o antigo sai e entra quem toca o novo.
  const chaveDe = e => { const g = grupoDe(e.papel), tb = g === 'perc' ? '' : e.timbre || ''; return `${e.familia}|${g}${tb ? '|' + tb : ''}`; };
  function tocarNota(e, agora) {
    const grupo = grupoDe(e.papel), timbre = grupo === 'perc' ? '' : e.timbre || '';
    const chave = chaveDe(e);
    let m = run.musicos.get(chave);
    if (!m || m.saindo) {
      const ativos = [...run.musicos.values()].filter(x => !x.saindo && x !== m);
      const trocado = ativos.find(x => x.familia === e.familia && x.grupo === grupo);
      if (trocado) trocado.saindo = true;
      else if (ativos.length >= MAX_MUSICOS) {
        // palco cheio: sai quem está calado há mais tempo, se já calou por um instante; senão a voz nova espera
        const velho = ativos.reduce((a, x) => (x.ultimo < a.ultimo ? x : a), ativos[0]);
        if (agora - velho.ultimo < 1) return;
        velho.saindo = true;
      }
      if (m) removerMusico(m);
      m = criarMusico(chave, e.familia, grupo, timbre);
      run.musicos.set(chave, m);
      run.novo = m;                    // um instrumento novo: a câmera vai até ele
      const n = [...run.musicos.values()].filter(x => !x.saindo).length;
      m.fig.g.position.set(0, 0, 3 + 3 + n * 0.12 + 2);       // entra pela frente do palco
      rearranjar();
    }
    if (grupo === 'perc') m.pecas.add(e.papel);
    m.ultimo = agora;
    const v = Math.min(1.2, e.vel * 2.2 + 0.15);
    somarInstrumento(e, v);
    m.energia = Math.min(2, m.energia + v * 0.6);
    m.foco = m.foco * 0.98 + v;
    m.lado ^= 1;
    m.golpe[grupo === 'perc' ? m.lado : 1] = Math.max(m.golpe[1], v);
    if ((e.papel === 'bumbo' || e.papel === 'surdo' || e.papel === 'prato') && v > 0.9) run.flash = Math.min(1, run.flash + 0.5);
  }
  function removerMusico(m) {
    run.cena.remove(m.fig.g);
    for (const k in m.fig.mats) m.fig.mats[k].dispose();      // as geometrias são compartilhadas (GEO) e ficam
    run.musicos.delete(m.chave);
  }

  // ── a prévia: a banda toca a faixa de verdade ──
  // Com uma prévia tocando, a sonificação cala, e a banda passa a tocar a faixa. Quem sobe ao palco são os
  // instrumentos que a análise de áudio viu nela (o top-3 do modelo Jamendo, em js/acervo-features.js), na família
  // de gênero dela. O ritmo vem do próprio mp3: com captureStream (Chrome, Firefox) um analisador de espectro ouve o
  // <audio> sem desviar o som dele, e cada ataque no grave, no médio ou no agudo vira um golpe de quem toca naquela
  // faixa; sem captureStream (Safari), as batidas seguem o bpm da faixa e o tempo do <audio>.
  const DE_JAMENDO = {
    drums: ['perc', 'bumbo'], drummachine: ['perc', 'bumbo'], beat: ['perc', 'bumbo'], percussion: ['perc', 'pandeiro'], bongo: ['perc', 'bongo'],
    bass: ['baixo', 'baixo'], doublebass: ['baixo', 'contrabaixo'], acousticbassguitar: ['baixo', 'baixo'],
    guitar: ['acorde', 'violao'], acousticguitar: ['acorde', 'violao'], classicalguitar: ['acorde', 'violao'], electricguitar: ['acorde', 'guitarra'], harp: ['acorde', 'violao'],
    piano: ['acorde', 'piano'], electricpiano: ['acorde', 'rhodes'], rhodes: ['acorde', 'rhodes'], keyboard: ['acorde', 'piano'], organ: ['acorde', 'orgao'],
    pipeorgan: ['acorde', 'orgao'], synthesizer: ['acorde', 'lead'], pad: ['acorde', 'pad'], sampler: ['acorde', 'pad'], computer: ['acorde', 'pad'], accordion: ['acorde', 'sanfona'],
    voice: ['mel', 'voz'], flute: ['mel', 'flauta'], saxophone: ['mel', 'sopro'], trumpet: ['mel', 'sopro'], trombone: ['mel', 'sopro'], horn: ['mel', 'sopro'],
    brass: ['mel', 'sopro'], clarinet: ['mel', 'sopro'], oboe: ['mel', 'sopro'], harmonica: ['mel', 'sopro'],
    violin: ['mel', 'cordas'], viola: ['mel', 'cordas'], cello: ['mel', 'cordas'], strings: ['mel', 'cordas'], orchestra: ['mel', 'cordas'], bell: ['mel', 'sino'],
  };
  const PECAS_GRAVE = ['surdo', 'bumbo'], PECAS_AGUDO = ['caixa', 'chimbal', 'pandeiro', 'tamborim'];
  function vozesDaPrevia(pv) {
    const familia = pv.familia || 'mpb', vistas = new Map();
    for (const { name, p } of pv.instrumentos) {
      const d = DE_JAMENDO[name];
      if (!d || (p != null && p < 0.08)) continue;
      const [papel, timbre] = d, e = { papel: papel === 'perc' ? timbre : papel, familia, timbre: papel === 'perc' ? '' : timbre, peso: p ?? 0.5 };
      const k = chaveDe(e);
      if (!vistas.has(k)) vistas.set(k, e);
    }
    return [...vistas.values()];
  }
  function ouvirPrevia(pv) {
    const P = run.pv;
    if (P.an !== undefined) return;
    P.an = null;
    try {
      const st = pv.el.captureStream?.() || pv.el.mozCaptureStream?.();
      if (!st || !st.getAudioTracks().length) return;
      run.actx ||= new (window.AudioContext || window.webkitAudioContext)();
      const an = run.actx.createAnalyser();
      an.fftSize = 1024;
      an.smoothingTimeConstant = 0.2;
      run.actx.createMediaStreamSource(st).connect(an);      // só o analisador: o som continua saindo pelo <audio>
      P.an = an;
      P.esp = new Uint8Array(an.frequencyBinCount);
      P.media = [0, 0, 0];
      P.ultimo = [0, 0, 0];
      run.actx.resume?.();
    } catch { P.an = null; }
  }
  function tocarPrevia(pv, t) {
    let P = run.pv;
    if (!P || P.i !== pv.i) {
      P = run.pv = { i: pv.i, vozes: vozesDaPrevia(pv), bpm: pv.bpm || 100, batidaAnt: 0, oitavaAnt: -1, titulo: pv.titulo };
      for (const e of P.vozes) tocarNota({ ...e, vel: 0.35 }, t);      // sobem ao palco já
      if (P.an !== undefined) delete P.an;
    }
    if (!pv.el.paused && pv.el.readyState >= 2) ouvirPrevia(pv);
    // o pulso da dança: o tempo do <audio> no bpm da faixa
    const batida = pv.el.currentTime * P.bpm / 60;
    run.batida = Math.max(run.batida, batida);
    const perc = P.vozes.filter(e => grupoDe(e.papel) === 'perc'), baixo = P.vozes.filter(e => e.papel === 'baixo'), resto = P.vozes.filter(e => e.papel === 'acorde' || e.papel === 'mel');
    const bate = (lista, vel, peca) => { for (const e of lista) tocarNota({ ...e, papel: peca && grupoDe(e.papel) === 'perc' ? peca : e.papel, vel: vel * (0.6 + 0.6 * e.peso) }, t); };
    if (P.an) {
      // ataques por banda: o grave (40–160 Hz), o médio (200–2000 Hz) e o agudo (4–10 kHz) acima da média recente
      P.an.getByteFrequencyData(P.esp);
      const hz = run.actx.sampleRate / 2 / P.esp.length, faixa = (a, b) => { let x = 0, n = 0; for (let k = Math.floor(a / hz); k <= Math.ceil(b / hz) && k < P.esp.length; k++) { x += P.esp[k]; n++; } return n ? x / n / 255 : 0; };
      const e3 = [faixa(40, 160), faixa(200, 2000), faixa(4000, 10000)];
      e3.forEach((e, j) => {
        const ataque = e - P.media[j] > 0.07 + 0.25 * P.media[j] * 0.3 && t - P.ultimo[j] > 0.09;
        P.media[j] += (e - P.media[j]) * 0.12;
        if (!ataque) return;
        P.ultimo[j] = t;
        const forca = Math.min(1, (e - P.media[j]) * 4 + 0.3);
        if (j === 0) { bate(perc, forca, PECAS_GRAVE[Math.floor(t * 7) % 2]); bate(baixo, forca * 0.8); }
        else if (j === 1) bate(resto, forca * 0.7);
        else bate(perc, forca * 0.6, PECAS_AGUDO[Math.floor(t * 13) % PECAS_AGUDO.length]);
      });
    } else {
      // sem analisador: as batidas no bpm da faixa — grave no tempo, agudo nos contratempos, harmonia e melodia nas colcheias
      const oitava = Math.floor(batida * 2);
      if (oitava !== P.oitavaAnt) {
        P.oitavaAnt = oitava;
        if (oitava % 2 === 0) { bate(perc, 0.8, PECAS_GRAVE[(oitava / 2) % 2]); bate(baixo, 0.7); }
        else bate(perc, 0.5, PECAS_AGUDO[oitava % PECAS_AGUDO.length]);
        if (hash('pv' + pv.i + oitava) < 0.7) bate(resto, 0.5);
      }
    }
    return P;
  }

  // ── quadro a quadro ──
  // Nada é alocado por quadro: listas, cores e vetores são reaproveitados. A resolução se ajusta ao que o aparelho
  // aguenta (média do tempo de quadro: abaixo de ~40 fps desce um degrau, folgado acima de ~55 fps sobe de novo).
  const RESOLUCOES = [2, 1.5, 1.25, 1];
  function ajustarResolucao(dt) {
    run.dtMedio += (dt - run.dtMedio) * 0.05;
    run.tRes += dt;
    if (run.tRes < 2) return;
    let i = run.iRes;
    if (run.dtMedio > 1 / 40 && i < RESOLUCOES.length - 1) i++;
    else if (run.dtMedio < 1 / 55 && i > run.iResMax) i--;
    if (i !== run.iRes) { run.iRes = i; run.r.setPixelRatio(Math.min(RESOLUCOES[i], devicePixelRatio || 1)); medir(); }
    run.tRes = 0;
  }

  function quadro(ms) {
    if (!run) return;
    run.raf = requestAnimationFrame(quadro);
    // até 60 quadros por segundo: numa tela de 120 Hz, desenhar o dobro só tiraria tempo do agendador do som
    if (run.tq && ms / 1000 - run.tq < 1 / 62) return;
    const t = ms / 1000, dt = Math.min(0.05, t - (run.tq || t)), parado = reduz.matches;
    run.tq = t;
    // com a banda na tela, alguém está assistindo: a música não adormece (só isso; o que ela toca segue o mapa)
    if (t - (run.tAcordar || 0) > 5 && document.visibilityState === 'visible') { run.tAcordar = t; at.acordarSom?.(); }
    if (dt > 0) ajustarResolucao(dt);
    // Cada nota aparece quando ela sai no alto-falante (o tempo ouvido, já com a latência de saída), e o braço sobe
    // antes dela: a descida cai em cima do som, como num golpe de verdade.
    const agoraAudio = at.ouvidoSom ? at.ouvidoSom() : at.agoraSom(), fila = run.fila;
    if (run.desordem) { fila.sort((a, b) => a.t - b.t); run.desordem = false; }
    let k = 0;
    while (k < fila.length && fila[k].t <= agoraAudio) tocarNota(fila[k++], t);
    if (k) fila.splice(0, k);
    if (fila.length > 2000) fila.splice(0, fila.length - 2000);
    for (const m of run.musicos.values()) m.prox = Infinity;
    for (const e of fila) {
      if (e.t - agoraAudio > PREPARO_S) break;
      const m = run.musicos.get(chaveDe(e));
      if (m && e.t < m.prox) m.prox = e.t;
    }
    for (const m of run.musicos.values()) {
      const falta = m.prox - agoraAudio;
      const alvo = falta < PREPARO_S ? 1 - falta / PREPARO_S : 0;
      m.preparo = alvo > m.preparo ? alvo : m.preparo * Math.exp(-dt * 18);     // sobe junto com a nota; desce rápido
    }

    // o andamento: lido do motor duas vezes por segundo, a fase do tempo corre entre uma leitura e outra
    if (t - (run.tBpm || 0) > 0.5) {
      run.tBpm = t;
      const s = at.som();
      if (s?.bpm) run.bpm = s.bpm;
      legenda(s);
    }
    // O pulso vem do próprio motor (o tempo da banda no instante ouvido), não de um relógio à parte que derivaria.
    // Sem ele, um relógio no andamento lido.
    const antes = run.batida, pv = at.previaAtual?.();
    if (pv) { tocarPrevia(pv, t); run.bpm = run.pv.bpm; }
    else {
      if (run.pv) run.pv = null;
      const doMotor = at.batidaSom?.();
      if (doMotor != null && Number.isFinite(doMotor) && Math.abs(doMotor - antes) < 8) run.batida = Math.max(antes, doMotor);
      else run.batida += dt * (run.bpm || 100) / 60;
    }
    const b = run.batida * Math.PI * 2;

    let saiu = false;
    const ativos = run.ativos;
    ativos.length = 0;
    for (const m of run.musicos.values()) {
      if (!m.saindo && t - m.ultimo > SOME_S) { m.saindo = true; saiu = true; }
      m.vis += ((m.saindo ? 0 : 1) - m.vis) * Math.min(1, dt * (m.saindo ? 1.5 : 2.5));
      if (m.saindo && m.vis < 0.02) { removerMusico(m); continue; }
      if (!m.saindo && m.vis > 0.3) ativos.push(m);
      m.energia *= Math.exp(-dt * 1.4);
      m.foco *= Math.exp(-dt * 0.8);
      m.golpe[0] *= Math.exp(-dt * 12);
      m.golpe[1] *= Math.exp(-dt * 12);
      animarMusico(m, t, dt, b, parado);
    }
    if (saiu) rearranjar();
    pesarCenarios(dt);
    aplicarCenarios(t);
    run.poeira.material.uniforms.t.value = parado ? 0 : t;
    // um clarão na exposição a cada golpe forte: o "flash" de clipe
    run.flash *= Math.exp(-dt * 6);
    run.r.toneMappingExposure = 0.95 + (parado ? 0 : run.flash * 0.3);
    dirigir(t, dt, antes, parado);
    desenharInstrumentos(dt);
    run.r.render(run.cena, run.cam);
    const vazio = run.musicos.size === 0;
    const semAnalise = !!pv && !run.pv.vozes.length;
    if (semAnalise !== run.semAnalise) { run.semAnalise = semAnalise; $('sim-vazio').textContent = semAnalise ? 'A análise de áudio desta faixa não viu instrumentos que a banda saiba tocar.' : 'A banda entra quando o som começa. Nenhum som? Ligue o Sonificar (M).'; }
    if (vazio !== run.vazio || semAnalise) { run.vazio = vazio; $('sim-vazio').hidden = !vazio; }
  }

  function animarMusico(m, t, dt, b, parado) {
    const { g, corpo, tronco, cabeca, bracos, pernas, mats } = m.fig, vis = m.vis;
    g.position.lerp(m.alvo, Math.min(1, dt * 1.6));
    g.rotation.y = Math.atan2(run.cam.position.x * 0.15 - g.position.x, 12 - g.position.z);
    g.scale.setScalar(0.4 + 0.6 * vis);
    for (const k in mats) if (k !== 'sombra' && k !== 'facho') opacidade(mats[k], vis);
    mats.sombra.opacity = 0.6 * vis;
    const hit = m.golpe[0] + m.golpe[1];
    mats.roupa.emissive.setRGB(0.22 * hit, 0.16 * hit, 0.07 * hit);
    // de perto o facho some: com a câmera dentro do cone, a luz aditiva lavaria a imagem
    const dCam = run.cam.position.distanceTo(g.position), perto = Math.min(1, Math.max(0, (dCam - 2.4) / 2.2));
    mats.facho.opacity = vis * perto * (0.03 + 0.1 * Math.min(1, m.energia) + 0.08 * hit);
    if (parado) {
      corpo.position.set(0, 0, 0); corpo.rotation.set(0, 0, 0); tronco.rotation.set(0, 0, 0); cabeca.rotation.set(0, 0, 0);
      pernas[0].rotation.x = pernas[1].rotation.x = 0;
    } else {
      // no tempo: os joelhos dobram em cada batida, o peso passa de um pé ao outro a cada duas, o tronco se inclina
      // no golpe e a cabeça acompanha com um atraso, como quem sente a música
      const e = 0.25 + Math.min(1, m.energia), passo = Math.sin(b / 2 + m.fase * 0.2);
      const desce = Math.abs(Math.sin(b / 2)) * 0.07 * e;
      corpo.position.set(passo * 0.035 * e, -desce, 0);
      corpo.rotation.z = passo * 0.05 * e;
      pernas[0].rotation.x = -desce * 2.2 * (passo > 0 ? 1.4 : 0.6);
      pernas[1].rotation.x = -desce * 2.2 * (passo > 0 ? 0.6 : 1.4);
      tronco.rotation.x = 0.08 * hit + 0.03 * e;
      tronco.rotation.y = Math.sin(b / 4 + m.fase) * 0.14 * e;
      const alvoCabeca = Math.max(0, Math.sin(b - 0.5)) * 0.2 * e + 0.05 * hit;
      m.cabecaY += (alvoCabeca - m.cabecaY) * Math.min(1, dt * 9);
      cabeca.rotation.x = m.cabecaY;
      cabeca.rotation.z = -corpo.rotation.z * 0.6;
    }
    posar(m, bracos, b, parado);
  }

  // Braços por instrumento, em três juntas. `preparo` (0 → 1 nos 140 ms antes da próxima nota) arma o golpe e `golpe`
  // (1 na nota, caindo rápido) o descarrega. Na percussão o movimento é o de quem toca de verdade: o ombro quase não
  // mexe, o cotovelo sobe e dobra na preparação, e o punho chicoteia a baqueta para cima e estala para baixo na
  // nota, com um rebote. As mãos se alternam: arma a que bate em seguida.
  function junta(j, ox, oz, cx, px) { j.ombro.rotation.set(ox, 0, oz); j.cotovelo.rotation.x = cx; j.punho.rotation.x = px; }
  function posar(m, [esq, dir], b, parado) {
    const [ge, gd] = m.golpe, pr = parado ? 0 : m.preparo * m.preparo, osc = parado ? 0 : Math.sin(b * 2) * 0.04;
    switch (m.pose) {
      case 'perc': {
        const vez = m.lado ^ 1;
        [esq, dir].forEach((j, lado) => {
          const arma = vez === lado ? pr : 0, bate = lado === 0 ? ge : gd, l = lado ? -1 : 1;
          // repouso: braço junto ao corpo, antebraço para a frente, baqueta sobre a pele do surdo
          const ombro = -0.35 - arma * 0.25 + bate * 0.08 + osc * l;
          const cotov = -1.05 - arma * 0.55 + bate * 0.3;
          const punho = 0.15 - arma * 0.9 + bate * 0.55 - (bate > 0.6 ? (bate - 0.6) * 0.6 : 0);     // estalo e rebote
          junta(j, ombro, 0.12 * l, cotov, punho);
        });
        break;
      }
      case 'tecla':
        junta(esq, -0.45 - pr * 0.1, 0.18, -0.95 - pr * 0.25 + ge * 0.2, 0.3 - pr * 0.4 + ge * 0.35);
        junta(dir, -0.45 - pr * 0.1, -0.18, -0.95 - pr * 0.25 + gd * 0.2, 0.3 - pr * 0.4 + gd * 0.35);
        break;
      case 'sanfona':
        junta(esq, -0.55, -0.35 - pr * 0.12 - gd * 0.35, -1.2, 0);
        junta(dir, -0.55, 0.35 + pr * 0.12 + gd * 0.35, -1.2, 0);
        break;
      case 'voz':
        junta(esq, -0.1 + osc - pr * 0.25 - gd * 0.3, 0.25 + gd * 0.25, -0.3 - pr * 0.4 - gd * 0.5, -0.2);
        junta(dir, -0.75, -0.15, -1.55 - gd * 0.1, 0);
        break;
      case 'sopro':
        junta(esq, -0.9, 0.35, -1.5, -0.2);
        junta(dir, -0.75 - pr * 0.05, -0.3, -1.25 + gd * 0.08, 0.1 - gd * 0.2);
        break;
      case 'contrabaixo':
        junta(esq, -1.0, -0.45, -1.15, 0);
        junta(dir, -0.25 - pr * 0.2, 0.05, -0.75 - pr * 0.45 + gd * 0.4, -0.2 - pr * 0.4 + gd * 0.5);
        break;
      default:       // corda: a mão esquerda no braço do instrumento, a direita palheta para cima e para baixo na nota
        junta(esq, -0.75, 0.55, -1.3, 0.2);
        junta(dir, -0.35, -0.2, -1.05 - pr * 0.3 + gd * 0.35, 0.2 - pr * 0.6 + gd * 0.7);
    }
  }

  // ── direção: uma câmera na mão que nunca para ──
  // Sem cortes: a câmera orbita sempre, num arco pela frente da banda (vai e volta, sem passar para as costas dos
  // músicos), e desliza de um músico para outro. Quem acabou de entrar com um instrumento novo ganha a câmera por
  // alguns segundos, de perto; fora isso, a cada 8 tempos ela vai até quem tocou mais forte. O enquadramento (perto,
  // médio, a banda inteira) também muda devagar, no mesmo movimento. Movimento reduzido: o plano aberto, parado.
  const ENQUADRAMENTOS = {
    perto: { raio: 1.75, alto: 1.45, olhar: 1.25, nome: 'de perto' },
    medio: { raio: 2.9, alto: 1.6, olhar: 1.05, nome: 'plano médio' },
    dois: { raio: 3.8, alto: 1.75, olhar: 1.05, nome: 'dois músicos' },
    aberto: { raio: 9.5, alto: 3.4, olhar: 1, nome: 'a banda inteira' },
  };
  const NOVO_S = 4.5;          // tanto tempo de câmera para quem acabou de entrar
  const v3 = () => new THREE.Vector3();
  function escolherFoco(t, novo) {
    const p = run.plano, ativos = run.ativos;
    let a = null, b = null;
    for (const m of ativos) { if (!a || m.foco > a.foco) { b = a; a = m; } else if (!b || m.foco > b.foco) b = m; }
    if (novo) { p.a = novo; p.b = null; p.tipo = 'perto'; p.ateNovo = t + NOVO_S; return; }
    if (!a) { p.a = p.b = null; p.tipo = 'aberto'; return; }
    // perto e médio mais vezes; dois músicos quando há dois; a banda inteira de vez em quando
    const r = Math.random(), anterior = p.tipo;
    let tipo = r < 0.38 ? 'perto' : r < 0.72 ? 'medio' : r < 0.88 && b ? 'dois' : 'aberto';
    if (tipo === anterior && tipo === 'aberto') tipo = 'medio';
    p.tipo = tipo; p.a = a; p.b = tipo === 'dois' ? b : null;
  }
  function dirigir(t, dt, batidaAntes, parado) {
    const { cam, foco } = run, p = run.plano, ativos = run.ativos;
    const vivo = m => m && !m.saindo && run.musicos.has(m.chave);
    if (parado) { p.tipo = 'aberto'; p.a = p.b = null; }
    else {
      // um instrumento novo chegou: a câmera vai até ele
      if (run.novo && vivo(run.novo) && run.novo !== p.a && run.novo.vis > 0.2) { escolherFoco(t, run.novo); run.novo = null; }
      const cada = 8, virou = Math.floor(run.batida / cada) !== Math.floor(batidaAntes / cada);
      if ((p.tipo !== 'aberto' && !vivo(p.a)) || (p.tipo === 'aberto' && ativos.length && !p.a)
        || (virou && t > (p.ateNovo || 0)) || (p.b && !vivo(p.b))) escolherFoco(t, null);
    }
    // o arco: a fase anda sempre (mais rápida quando a banda está quente) e o ângulo vai e volta pela frente
    const quente = ativos.reduce((x, m) => Math.max(x, m.energia), 0);
    if (!parado) p.fase += dt * (0.22 + 0.18 * Math.min(1, quente));
    const ang = parado ? 0 : Math.sin(p.fase) * 1.05 + Math.sin(p.fase * 0.37) * 0.25;
    // o alvo: o músico em foco, o meio de dois, ou o meio da banda
    const alvo = run.alvoCam, E = ENQUADRAMENTOS[p.tipo] || ENQUADRAMENTOS.aberto;
    if (p.a && p.tipo !== 'aberto') {
      const ap = p.a.fig.g.position;
      if (p.b) { const bp = p.b.fig.g.position; alvo.set((ap.x + bp.x) / 2, E.olhar, (ap.z + bp.z) / 2); }
      else alvo.set(ap.x, E.olhar, ap.z);
    } else alvo.set(0, 1, 2.2);
    // raio, altura e alvo andam suaves (como numa grua), então trocar de músico ou de enquadramento é um deslize
    const aspecto = Math.max(1, 1.1 / cam.aspect), sm = parado ? 1 : Math.min(1, dt * 0.9);
    p.raio += (E.raio * aspecto * (p.b ? 1 + p.a.fig.g.position.distanceTo(p.b.fig.g.position) * 0.25 : 1) - p.raio) * sm;
    p.alto += (E.alto + (p.tipo === 'aberto' ? 1.5 * Math.max(0, 1 / cam.aspect - 1) + Math.sin(t * 0.12) * 0.6 : Math.sin(p.fase * 1.3) * 0.25) - p.alto) * sm;
    run.olhar.lerp(alvo, parado ? 1 : Math.min(1, dt * 1.6));
    const pos = run.posCam;
    pos.set(run.olhar.x + Math.sin(ang) * p.raio, p.alto, run.olhar.z + Math.cos(ang) * p.raio);
    // perto dos músicos a câmera fica dentro do palco: fora dele estão os objetos do cenário, que tampariam a vista
    if (p.raio < 6) {
      const dx = pos.x, dz = pos.z - 2.5, r = Math.hypot(dx, dz), max = 6.6;
      if (r > max) { pos.x = dx * max / r; pos.z = 2.5 + dz * max / r; }
    }
    cam.position.lerp(pos, parado ? 1 : Math.min(1, dt * 2.2));
    cam.lookAt(run.olhar);
    run.cena.fog.far = cam.position.distanceTo(run.olhar) + 45;     // a névoa recua com a câmera e deixa o cenário à vista
    run.cena.fog.near = run.cena.fog.far - 35;
    const a = p.tipo !== 'aberto' ? p.a : null;
    foco.target.position.copy(a ? a.fig.g.position : alvo);
    foco.intensity += ((a ? 55 : 0) - foco.intensity) * Math.min(1, dt * 3);
    const txt = a ? rotulo(a) + '|' + p.tipo : '';
    if (txt !== run.focoTxt) {
      run.focoTxt = txt;
      const el = $('sim-foco');
      el.hidden = !a;
      if (a) { el.firstChild.textContent = instDe(a); el.lastChild.textContent = `${a.nomeFamilia} · ${E.nome}`; }
    }
    run.focoEm = a?.chave ?? null;
  }

  function legenda(s) {
    const fams = [...new Set([...run.musicos.values()].filter(m => !m.saindo).map(m => m.familia))];
    const el = $('sim-legenda');
    el.replaceChildren(...fams.map(f => {
      const span = document.createElement('span'), p = document.createElement('i'), info = at.familia(f);
      p.style.background = info.cor;
      span.append(p, info.nome);
      return span;
    }));
    if (run.pv) el.prepend(Object.assign(document.createElement('b'), { textContent: `Prévia: ${run.pv.titulo}`, className: 'sim-previa' }));
    const bpm = run.pv ? Math.round(run.pv.bpm) : s?.bpm;
    if (bpm) el.append(Object.assign(document.createElement('b'), { textContent: `${bpm} bpm` }));
  }

  // ── o mapa por trás ──
  // A banda só escuta: quem decide a música é o mapa, e só quem mexe no mapa o move. A banda nunca voa, aproxima ou
  // passeia pelo mapa, nem muda o que a sonificação toca.

  function medir() {
    if (!run) return;
    const c = $('sim-canvas'), w = Math.max(1, c.clientWidth), h = Math.max(1, c.clientHeight);
    run.r.setSize(w, h, false);
    run.cam.aspect = w / h;
    run.cam.updateProjectionMatrix();
  }

  // ── abrir e fechar ──
  async function iniciar() {
    if (run || abrindo) return;
    abrindo = true;
    marcarBotao(true);
    const el = $('sim');
    el.style.setProperty('--sim-topo', `${at.camera().topo + 12}px`);
    el.hidden = false;
    aplicarCartao(lerCartao());
    try { $('sim-instrumentos').open = localStorage.getItem(CHAVE_INST) === '1'; } catch {}
    $('sim-sair').focus();
    // O som liga aqui, ainda dentro do clique: depois do import o Safari já não aceita. O Sonificar desligado volta
    // a ficar desligado ao fechar (a escolha fica salva no localStorage).
    somAntes = at.som()?.vontade ?? null;
    at.querSom(true);
    at.folgaSom?.(0.35);
    at.ouvirBanda(aoTocar);
    $('sim-status').textContent = 'Montando o palco…';
    try { THREE = THREE || await import(THREE_URL); }
    catch (err) {
      $('sim-status').textContent = 'Não foi possível carregar o 3D.';
      at.ouvirBanda(null);
      at.folgaSom?.(0.14);
      window.reportar?.('atlas', 'simulação 3D: three.js não carregou', window.descreverErro?.(err) || String(err));
      abrindo = false;
      marcarBotao(false);
      return;
    }
    if (!abrindo) return;          // Esc ou ✕ enquanto o three.js carregava: parar() já desfez tudo
    abrindo = false;
    $('sim-status').textContent = '';
    run = { musicos: new Map(), inst: new Map(), tInst: 0, fila: [], ativos: [], desordem: false, batida: 0, bpm: 100, focoEm: null, focoTxt: '', vazio: null, flash: 0,
      plano: { tipo: 'aberto', a: null, b: null, fase: 0, raio: 9.5, alto: 3.4, ateNovo: 0 }, novo: null,
      dtMedio: 1 / 60, tRes: 0, iRes: 0, iResMax: 0,
      alvoCam: new THREE.Vector3(), posCam: new THREE.Vector3(), olhar: new THREE.Vector3(0, 1, 2), ...montarCena() };
    run.ro = new ResizeObserver(medir);
    run.ro.observe($('sim-canvas'));
    medir();
    // os programas de shader compilam antes do primeiro quadro, sem travar a thread em que o som é agendado
    if (run.r.compileAsync) await run.r.compileAsync(run.cena, run.cam).catch(() => {});
    if (!run) return;
    run.raf = requestAnimationFrame(quadro);
    $('sim-sair').focus();
  }
  function parar() {
    if (abrindo) {                 // ainda carregando o three.js
      abrindo = false;
      at.ouvirBanda(null);
      at.folgaSom?.(0.14);
      $('sim').hidden = true;
      marcarBotao(false);
      if (somAntes === false) at.querSom(false);
      return;
    }
    if (!run) return;
    at.ouvirBanda(null);
    at.folgaSom?.(0.14);
    cancelAnimationFrame(run.raf);
    run.ro.disconnect();
    for (const m of [...run.musicos.values()]) removerMusico(m);
    $('sim-instrumentos-lista').replaceChildren();
    $('sim-foco').hidden = true;
    for (const c of Object.values(run.cenarios)) { c.g.traverse(o => o.geometry?.dispose()); for (const m of c.mats) m.dispose(); }
    run.r.dispose();
    run.actx?.close?.();
    run = null;
    $('sim').hidden = true;
    marcarBotao(false);
    if (somAntes === false) at.querSom(false);
  }

  // ?sim=1 pede um clique antes: sem gesto o navegador não deixa a sonificação soar, e a banda é ela.
  function convidar() {
    const el = $('sim-convite');
    el.hidden = false;
    const b = el.querySelector('button');
    const fechar = () => { el.hidden = true; document.removeEventListener('keydown', fora, true); };
    const fora = e => { if (e.key === 'Escape') fechar(); };
    b.onclick = () => { fechar(); iniciar(); };
    el.onclick = e => { if (e.target === el) fechar(); };
    document.addEventListener('keydown', fora, true);
    b.focus();
  }

  $('sim-sair')?.addEventListener('click', parar);

  // ── mover e redimensionar (desktop) ──
  // Arrastar pela faixa de cima move o cartão; o canto de baixo à direita muda largura e altura do palco. Fica dentro
  // da janela e é lembrado neste navegador (localStorage, só conveniência: sem ele o cartão volta ao lugar padrão).
  const CHAVE_CARTAO = 'tocador-atlas-sim-cartao';
  const desktop = () => matchMedia('(min-width: 721px) and (pointer: fine)').matches;
  function aplicarCartao(c) {
    const el = $('sim');
    if (!c || !desktop()) { for (const v of ['--sim-x', '--sim-y', '--sim-largo', '--sim-alto']) el.style.removeProperty(v); return; }
    const largo = Math.max(260, Math.min(c.largo, innerWidth - 24)), alto = Math.max(160, Math.min(c.alto, innerHeight - 220));
    el.style.setProperty('--sim-largo', `${largo}px`);
    el.style.setProperty('--sim-alto', `${alto}px`);
    const w = el.offsetWidth || largo, h = el.offsetHeight || alto + 120;
    el.style.setProperty('--sim-x', `${Math.max(8, Math.min(c.x, innerWidth - w - 8))}px`);
    el.style.setProperty('--sim-y', `${Math.max(8, Math.min(c.y, innerHeight - Math.min(h, 120)))}px`);
  }
  function lerCartao() { try { return JSON.parse(localStorage.getItem(CHAVE_CARTAO) || 'null'); } catch { return null; } }
  function salvarCartao(c) { try { localStorage.setItem(CHAVE_CARTAO, JSON.stringify(c)); } catch {} }
  function cartaoAtual() {
    const el = $('sim'), r = el.getBoundingClientRect(), palco = $('sim-palco').getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), largo: Math.round(r.width), alto: Math.round(palco.height) };
  }
  function arrastar(e, modo) {
    if (!desktop() || e.button !== 0) return;
    if (modo === 'mover' && e.target.closest('button')) return;
    e.preventDefault();
    const el = $('sim'), c0 = cartaoAtual(), x0 = e.clientX, y0 = e.clientY;
    el.classList.add(modo === 'mover' ? 'arrastando' : 'redimensionando');
    const mover = ev => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      aplicarCartao(modo === 'mover' ? { ...c0, x: c0.x + dx, y: c0.y + dy } : { ...c0, largo: c0.largo + dx, alto: c0.alto + dy });
    };
    const soltar = () => {
      removeEventListener('pointermove', mover);
      removeEventListener('pointerup', soltar);
      removeEventListener('pointercancel', soltar);
      el.classList.remove('arrastando', 'redimensionando');
      salvarCartao(cartaoAtual());
    };
    addEventListener('pointermove', mover);
    addEventListener('pointerup', soltar);
    addEventListener('pointercancel', soltar);
  }
  $('sim-topo')?.addEventListener('pointerdown', e => arrastar(e, 'mover'));
  $('sim-redim')?.addEventListener('pointerdown', e => arrastar(e, 'redimensionar'));
  // a janela encolheu: o cartão volta para dentro dela
  addEventListener('resize', () => { if (!$('sim').hidden) aplicarCartao(lerCartao()); });
  // duplo clique na faixa de cima: volta ao lugar e ao tamanho padrão
  $('sim-topo')?.addEventListener('dblclick', e => {
    if (e.target.closest('button') || !desktop()) return;
    try { localStorage.removeItem(CHAVE_CARTAO); } catch {}
    aplicarCartao(null);
  });
  // o botão Banda liga e desliga, como o Grafo e o Sonificar
  $('btn-sim')?.addEventListener('click', () => (run || abrindo ? parar() : iniciar()));
  // em window: a captura aí corre antes da do document, onde o tour escuta o T
  // O mapa segue navegável com a banda aberta; Esc fecha a banda quando o foco está nela (fora dela, Esc é do mapa:
  // fecha o cartão ou o grafo), e o T fica parado, porque o tour tomaria o mapa.
  addEventListener('keydown', e => {
    if (!run && !abrindo) return;
    if (e.key === 'Escape' && document.activeElement?.closest?.('#sim')) { e.preventDefault(); e.stopImmediatePropagation(); parar(); }
    else if (e.key === 't' || e.key === 'T') e.stopImmediatePropagation();
  }, true);

  const pede = new URLSearchParams(location.search).has('sim');
  at.pronto.then(() => {
    if (!pede) return;
    const q = new URLSearchParams(location.search);
    q.delete('sim');
    const qs = q.toString();
    history.replaceState(history.state, '', location.pathname + (qs ? '?' + qs : ''));
    if (!at.som() || $('btn-musica')?.disabled) iniciar();
    else convidar();
  });

  window.__atlasSim = {
    iniciar, parar,
    estado: () => run && { musicos: [...run.musicos.values()].filter(m => !m.saindo).map(m => ({ chave: m.chave, grupo: m.grupo, timbre: m.timbre, pecas: [...m.pecas], vis: +m.vis.toFixed(2), preparo: +m.preparo.toFixed(2), exotico: m.exotico, chapeu: m.chapeu })), batida: +run.batida.toFixed(2), instrumentos: [...$('sim-instrumentos-lista').children].filter(li => !li.classList.contains('ouvindo')).map(li => li.textContent), instCalculados: run.inst.size, foco: run.focoEm, plano: run.plano.tipo, previa: run.pv && { faixa: run.pv.i, vozes: run.pv.vozes.map(chaveDe), analisador: !!run.pv.an }, cam: run.cam.position.toArray().map(v => +v.toFixed(3)), fps: Math.round(1 / run.dtMedio), resolucao: RESOLUCOES[run.iRes], fila: run.fila.length, bpm: run.bpm,
      cenarios: Object.fromEntries(Object.entries(run.cenarios).filter(([, c]) => c.peso > 0.02).map(([n, c]) => [n, +c.peso.toFixed(2)])) },
    // testes: notas sem depender do áudio
    nota: e => aoTocar(e),
  };
})();
