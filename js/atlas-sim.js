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
// alguns segundos. Cada nota agendada chega com o horário do AudioContext em que soa, e o golpe, o dedilhado ou o
// sopro acontece nesse instante, não quando o evento chega. Entre as notas os músicos balançam no andamento da banda.
// A câmera dirige como num clipe: corta na batida entre close, médio, contra-plongée, dois músicos, travelling e
// plano aberto, sempre em quem tocou mais forte. Luz de filme (tone mapping ACES, contraluz, fachos aditivos sobre cada
// músico, clarão nos golpes fortes, poeira na névoa), sombra falsa sob os pés, vinheta e grão por CSS. Por trás do
// palco o mapa continua sendo a partitura. Quem mexe no mapa conduz; parado por 25 s, o mapa voa sozinho para outro
// rótulo a cada ~20 s, e a banda muda com ele.
//
// three.js vem do jsdelivr só quando a simulação abre (import dinâmico; o resto do atlas é script clássico).
// Com movimento reduzido: câmera parada no plano aberto, ninguém dança, só as luzes respondem às notas.
// Ganchos: window.__atlas (ouvirBanda, agoraSom, familia, som, querSom, dados, camera, voar); expõe window.__atlasSim.
(() => {
  'use strict';
  const at = window.__atlas;
  if (!at) return;
  const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js';
  const reduz = matchMedia('(prefers-reduced-motion: reduce)');
  const $ = id => document.getElementById(id);
  const SOME_S = 5;            // calado por tanto tempo, o músico sai
  const MAX_MUSICOS = 8;       // no palco ao mesmo tempo; os que saem não contam
  const MAPA_CADA_S = 20;      // a câmera do mapa troca de rótulo, e com ela a banda…
  const MAPA_PARADO_S = 25;    // …quando ninguém mexe no mapa há tanto tempo

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
    const bracos = [-1, 1].map(lado => {
      const ombro = new THREE.Group();
      ombro.position.set(0.27 * lado, 0.55, 0);
      ombro.add(malha(geo('braco', () => new Cil(0.055, 0.045, 0.6, 10)), mats.roupa, 0, -0.3, 0));
      ombro.add(malha(geo('mao', () => new Esf(0.055, 10, 8)), mats.pele, 0, -0.62, 0));
      tronco.add(ombro);
      return ombro;
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

  function criarMusico(chave, familia, grupo, timbre) {
    const f = at.familia(familia);
    // a cor do macro-gênero, com um desvio de matiz por família: samba, MPB e forró são todos "Latin"
    const cor = new THREE.Color(f.cor), hsl = {};
    cor.getHSL(hsl);
    cor.setHSL((hsl.h + (hash(familia) - 0.5) * 0.22 + 1) % 1, hsl.s, Math.min(0.7, hsl.l * (0.8 + hash(familia + 'l') * 0.45)));
    const fig = criarCorpo(chave, cor);
    const m = { chave, familia, grupo, timbre, fig, nomeFamilia: f.nome, pose: 'corda', pecas: new Set(),
      vis: 0, energia: 0, foco: 0, golpe: [0, 0], lado: 0, ultimo: performance.now() / 1000, cabecaY: 0,
      alvo: new THREE.Vector3(), fase: hash(chave) * Math.PI * 2 };
    criarInstrumento(m, timbre);
    run.cena.add(fig.g);
    return m;
  }

  function rotulo(m) {
    const inst = m.grupo === 'perc' ? [...m.pecas].slice(-3).map(p => NOME_PERC[p] || p).join(', ') || NOME_GRUPO.perc : NOME_TIMBRE[m.timbre] || NOME_GRUPO[m.grupo];
    return `${inst} · ${m.nomeFamilia}`;
  }

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
        fio(-5, 5, -2.5, 4.2, 14, [0xffd27a, 0xffe7b0], 'lampada');
        const [x, z] = lugar(nome, 1, 8.5, 9.5);
        add(new Cil(0.7, 0.7, 0.08, 16), mat(0x7a4a2a), x, 0.9, z); add(new Cil(0.08, 0.08, 0.9, 6), mat(0x3a2a1c), x, 0.45, z);
        add(new Cil(0.12, 0.12, 0.3, 8), mat(0xf0c060), x + 0.2, 1.08, z);
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
        for (let j = 0; j < 4; j++) { const [x, z] = lugar(nome, j, 7.5, 9); const zz = Math.max(z, -7); add(new Caixa(1.4, 1.6, 0.8), mat(0x141414), x, 0.8, zz); add(new Caixa(1.2, 1.2, 0.05), mat(0x5a5a5a), x, 0.85, zz + 0.42); add(new Caixa(1.4, 1.2, 0.8), mat(0x141414), x, 2.2, zz); }
        for (const x of [-6, 6]) add(new Caixa(0.2, 6, 0.2), mat(0x8a8a8a, { metalness: 0.6 }), x, 3, -3);
        add(new Caixa(12.2, 0.2, 0.2), mat(0x8a8a8a, { metalness: 0.6 }), 0, 6, -3);
        for (const x of [-3, 0, 3]) { const r2 = add(new Cone(0.3, 0.6, 10), brilho(0xff3a2a), x, 5.6, -3, Math.PI); anim.push(t => { r2.material.emissiveIntensity = 0.6 + 0.8 * Math.max(0, Math.sin(t * 4 + x)); }); }
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
      if (op !== c.op) { c.op = op; for (const m of c.mats) opacidade(m, op); }
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
  function tocarNota(e, agora) {
    // Um músico por família, grupo e instrumento: quando a voz troca de instrumento (cavaquinho → flauta), quem
    // tocava o antigo sai e entra quem toca o novo.
    const grupo = grupoDe(e.papel), timbre = grupo === 'perc' ? '' : e.timbre || '';
    const chave = `${e.familia}|${grupo}${timbre ? '|' + timbre : ''}`;
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
      const n = [...run.musicos.values()].filter(x => !x.saindo).length;
      m.fig.g.position.set(0, 0, 3 + 3 + n * 0.12 + 2);       // entra pela frente do palco
      rearranjar();
    }
    if (grupo === 'perc') m.pecas.add(e.papel);
    m.ultimo = agora;
    const v = Math.min(1.2, e.vel * 2.2 + 0.15);
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
    const t = ms / 1000, dt = Math.min(0.05, t - (run.tq || t)), parado = reduz.matches;
    run.tq = t;
    if (dt > 0) ajustarResolucao(dt);
    const agoraAudio = at.agoraSom(), fila = run.fila;
    if (run.desordem) { fila.sort((a, b) => a.t - b.t); run.desordem = false; }
    let k = 0;
    while (k < fila.length && fila[k].t <= agoraAudio) tocarNota(fila[k++], t);
    if (k) fila.splice(0, k);
    if (fila.length > 2000) fila.splice(0, fila.length - 2000);

    // o andamento: lido do motor duas vezes por segundo, a fase do tempo corre entre uma leitura e outra
    if (t - (run.tBpm || 0) > 0.5) {
      run.tBpm = t;
      const s = at.som();
      if (s?.bpm) run.bpm = s.bpm;
      legenda(s);
    }
    const antes = run.batida;
    run.batida += dt * (run.bpm || 100) / 60;
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
    run.r.render(run.cena, run.cam);
    const vazio = run.musicos.size === 0;
    if (vazio !== run.vazio) { run.vazio = vazio; $('sim-vazio').hidden = !vazio; }
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

  // Braços por instrumento: o golpe é o que acabou de soar, o resto é a pose de quem segura aquilo.
  function posar(m, [esq, dir], b, parado) {
    const [ge, gd] = m.golpe, osc = parado ? 0 : Math.sin(b * 2) * 0.05;
    switch (m.pose) {
      case 'perc': esq.rotation.set(-0.9 - ge * 0.9 + osc, 0, 0.1); dir.rotation.set(-0.9 - gd * 0.9 - osc, 0, -0.1); break;
      case 'tecla': esq.rotation.set(-0.75 - ge * 0.3, 0, 0.15); dir.rotation.set(-0.75 - gd * 0.3, 0, -0.15); break;
      case 'sanfona': esq.rotation.set(-1.1, 0, -0.3 - gd * 0.4); dir.rotation.set(-1.1, 0, 0.3 + gd * 0.4); break;
      case 'voz': esq.rotation.set(-0.2 + osc - gd * 0.5, 0, 0.2 + gd * 0.3); dir.rotation.set(-1.6 - gd * 0.2, 0, -0.2); break;
      case 'sopro': esq.rotation.set(-1.7, 0, 0.3); dir.rotation.set(-1.5 - gd * 0.15, 0, -0.3); break;
      case 'contrabaixo': esq.rotation.set(-1.6, 0, -0.4); dir.rotation.set(-0.6 - gd * 0.5, 0, 0); break;
      default: esq.rotation.set(-1.2, 0, 0.7); dir.rotation.set(-0.7 - gd * 0.6, 0, -0.25);     // dedilhado
    }
  }

  // ── direção de clipe ──
  // Um plano por vez, com corte seco na batida: a cada 8 tempos (4 quando a banda está quente) a câmera troca de
  // plano e de músico, sempre o que tocou mais forte há pouco, sem repetir o tipo de plano. Dentro do plano ela anda
  // devagar (aproxima, gira, desliza). Planos: close nas mãos e no rosto, médio, contra-plongée (de baixo), dois
  // músicos, travelling lateral pela banda e o plano aberto. Movimento reduzido: só o aberto, parado.
  const PLANOS = ['close', 'medio', 'baixo', 'dois', 'travelling', 'aberto'];
  const PESO_PLANO = { close: 3, medio: 3, baixo: 2, dois: 2, travelling: 1.5, aberto: 1.5 };
  const v3 = () => new THREE.Vector3();
  function escolherPlano(t) {
    const ativos = run.ativos, p = run.plano;
    let tipo = 'aberto';
    if (ativos.length) {
      let tot = 0;
      for (const x of PLANOS) if (x !== p.tipo && (x !== 'dois' || ativos.length > 1)) tot += PESO_PLANO[x];
      let r = Math.random() * tot;
      for (const x of PLANOS) {
        if (x === p.tipo || (x === 'dois' && ativos.length < 2)) continue;
        r -= PESO_PLANO[x];
        if (r <= 0) { tipo = x; break; }
      }
    }
    // os dois que mais tocaram
    let a = null, bb = null;
    for (const m of ativos) { if (!a || m.foco > a.foco) { bb = a; a = m; } else if (!bb || m.foco > bb.foco) bb = m; }
    p.tipo = tipo; p.a = a; p.b = bb; p.t0 = t; p.lado = Math.random() < 0.5 ? -1 : 1;
    p.corte = true;
  }
  function dirigir(t, dt, batidaAntes, parado) {
    const { cam, foco } = run, p = run.plano, ativos = run.ativos;
    const quente = ativos.some(m => m.energia > 0.8);
    const cada = quente ? 4 : 8;
    const perdeu = (p.a && (p.a.saindo || !run.musicos.has(p.a.chave))) || (p.tipo !== 'aberto' && !ativos.length);
    if (parado) { if (p.tipo !== 'aberto') { p.tipo = 'aberto'; p.a = p.b = null; p.corte = true; } }
    else if (perdeu || Math.floor(run.batida / cada) !== Math.floor(batidaAntes / cada) || (p.tipo === 'aberto' && ativos.length && t - p.t0 > 3)) escolherPlano(t);
    const u = Math.min(1, (t - p.t0) / 8), alvo = run.alvoCam, pos = run.posCam, aspecto = Math.max(1, 1.1 / cam.aspect);
    const a = p.a, ap = a ? a.fig.g.position : null;
    switch (p.tipo) {
      case 'close': {        // rosto e mãos, chegando perto
        alvo.set(ap.x, 1.3, ap.z);
        const d = (1.7 - 0.5 * u) * aspecto;
        pos.set(ap.x + p.lado * 0.55, 1.45, ap.z + d);
        break;
      }
      case 'medio': {        // corpo inteiro, girando em volta
        const ang = p.lado * (0.45 - 0.35 * u);
        alvo.set(ap.x, 1.05, ap.z);
        pos.set(ap.x + Math.sin(ang) * 2.8 * aspecto, 1.5, ap.z + Math.cos(ang) * 2.8 * aspecto);
        break;
      }
      case 'baixo': {        // de baixo para cima, herói
        alvo.set(ap.x, 1.4, ap.z);
        pos.set(ap.x + p.lado * (0.7 - 0.3 * u), 0.3, ap.z + 2 * aspecto);
        break;
      }
      case 'dois': {
        const bp = p.b.fig.g.position;
        alvo.set((ap.x + bp.x) / 2, 1.1, (ap.z + bp.z) / 2);
        const d = (2.6 + ap.distanceTo(bp) * 0.9) * aspecto;
        pos.set(alvo.x + p.lado * 0.8 * (1 - u), 1.55, alvo.z + d);
        break;
      }
      case 'travelling': {   // desliza pela frente da banda
        const x = p.lado * (-4 + 8 * u);
        alvo.set(x * 0.6, 1.15, 2.4);
        pos.set(x, 1.35, 7.2 * aspecto * 0.85);
        break;
      }
      default: {             // aberto: a banda inteira, com uma grua lenta
        alvo.set(0, 1, 2.2);
        const sobe = parado ? 0 : Math.sin(t * 0.12) * 0.8;
        pos.set(parado ? 0 : Math.sin(t * 0.05) * 2, 3.4 + sobe + 1.5 * Math.max(0, 1 / cam.aspect - 1), 10.5 * Math.max(1, 1.2 / cam.aspect));
      }
    }
    if (p.corte) { cam.position.copy(pos); run.olhar.copy(alvo); p.corte = false; }     // corte seco
    else { const s = Math.min(1, dt * 2.5); run.olhar.lerp(alvo, s); cam.position.lerp(pos, s); }
    cam.lookAt(run.olhar);
    run.cena.fog.far = cam.position.distanceTo(run.olhar) + 45;     // a névoa recua com a câmera e deixa o cenário à vista
    run.cena.fog.near = run.cena.fog.far - 35;
    foco.target.position.copy(ap || alvo);
    foco.intensity += ((ap ? 55 : 0) - foco.intensity) * Math.min(1, dt * 3);
    const txt = a ? rotulo(a) : '';
    if (txt !== run.focoTxt) { run.focoTxt = txt; $('sim-foco').textContent = txt; }
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
    if (s?.bpm) el.append(Object.assign(document.createElement('b'), { textContent: `${s.bpm} bpm` }));
  }

  // ── o mapa por trás ──
  // Quem mexe no mapa conduz a banda. Parado por MAPA_PARADO_S, o mapa voa sozinho até um rótulo sorteado (os maiores
  // mais vezes), perto o bastante para a banda inteira tocar (8× o enquadramento), e de novo a cada MAPA_CADA_S.
  let ultimoMexer = 0, ultimoVoo = 0;
  const mexeu = e => { if (!e.target?.closest?.('#sim')) ultimoMexer = performance.now(); };
  for (const ev of ['pointerdown', 'wheel', 'keydown']) addEventListener(ev, mexeu, { capture: true, passive: true });
  function voarParaRotulo() {
    const D = at.dados(), c = at.camera(), marcos = D.A.marcos[c.mapa] || [];
    if (!marcos.length) return;
    let tot = 0;
    for (const mk of marcos) tot += Math.sqrt(mk[3]);
    let r = Math.random() * tot, esc = marcos[0];
    for (const mk of marcos) { r -= Math.sqrt(mk[3]); if (r <= 0) { esc = mk; break; } }
    at.voar(esc[1] / 65535, esc[2] / 65535, c.k0 * 8, reduz.matches ? 0 : 6000);
    ultimoVoo = performance.now();
  }
  function passearMapa() {
    if (!run) return;
    const agora = performance.now();
    // com busca ou gêneros desligados o passeio fica parado: um rótulo sorteado cairia fora do que está aceso
    const e = at.estado(), filtrado = e.nAtivo < e.n;
    if (!filtrado && agora - ultimoMexer > MAPA_PARADO_S * 1000 && agora - ultimoVoo > MAPA_CADA_S * 1000) voarParaRotulo();
    run.tMapa = setTimeout(passearMapa, 2000);
  }

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
    $('sim-sair').focus();
    // O som liga aqui, ainda dentro do clique: depois do import o Safari já não aceita. O Sonificar desligado volta
    // a ficar desligado ao fechar (a escolha fica salva no localStorage).
    somAntes = at.som()?.vontade ?? null;
    at.querSom(true);
    at.ouvirBanda(aoTocar);
    $('sim-status').textContent = 'Montando o palco…';
    try { THREE = THREE || await import(THREE_URL); }
    catch (err) {
      $('sim-status').textContent = 'Não foi possível carregar o 3D.';
      at.ouvirBanda(null);
      window.reportar?.('atlas', 'simulação 3D: three.js não carregou', window.descreverErro?.(err) || String(err));
      abrindo = false;
      marcarBotao(false);
      return;
    }
    if (!abrindo) return;          // Esc ou ✕ enquanto o three.js carregava: parar() já desfez tudo
    abrindo = false;
    $('sim-status').textContent = '';
    run = { musicos: new Map(), fila: [], ativos: [], desordem: false, batida: 0, bpm: 100, focoEm: null, focoTxt: '', vazio: null, flash: 0,
      plano: { tipo: 'aberto', a: null, b: null, t0: 0, lado: 1, corte: true },
      dtMedio: 1 / 60, tRes: 0, iRes: 0, iResMax: 0,
      alvoCam: new THREE.Vector3(), posCam: new THREE.Vector3(), olhar: new THREE.Vector3(0, 1, 2), ...montarCena() };
    run.ro = new ResizeObserver(medir);
    run.ro.observe($('sim-canvas'));
    medir();
    // longe demais a banda é só a base: na primeira vez o mapa se aproxima ali mesmo, onde a pessoa estava
    const c = at.camera();
    if (c.k < c.k0 * 6) { at.voar(c.cx, c.cy, c.k0 * 8, reduz.matches ? 0 : 1500); ultimoVoo = performance.now(); }
    passearMapa();
    run.raf = requestAnimationFrame(quadro);
    $('sim-sair').focus();
  }
  function parar() {
    if (abrindo) {                 // ainda carregando o three.js
      abrindo = false;
      at.ouvirBanda(null);
      $('sim').hidden = true;
      marcarBotao(false);
      if (somAntes === false) at.querSom(false);
      return;
    }
    if (!run) return;
    at.ouvirBanda(null);
    cancelAnimationFrame(run.raf);
    clearTimeout(run.tMapa);
    run.ro.disconnect();
    for (const m of [...run.musicos.values()]) removerMusico(m);
    for (const c of Object.values(run.cenarios)) { c.g.traverse(o => o.geometry?.dispose()); for (const m of c.mats) m.dispose(); }
    run.r.dispose();
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
    estado: () => run && { musicos: [...run.musicos.values()].filter(m => !m.saindo).map(m => ({ chave: m.chave, grupo: m.grupo, timbre: m.timbre, pecas: [...m.pecas], vis: +m.vis.toFixed(2) })), foco: run.focoEm, plano: run.plano.tipo, fps: Math.round(1 / run.dtMedio), resolucao: RESOLUCOES[run.iRes], fila: run.fila.length, bpm: run.bpm,
      cenarios: Object.fromEntries(Object.entries(run.cenarios).filter(([, c]) => c.peso > 0.02).map(([n, c]) => [n, +c.peso.toFixed(2)])) },
    // testes: notas sem depender do áudio
    nota: e => aoTocar(e),
  };
})();
