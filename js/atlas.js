// atlas.js — /atlas: every uqt + homi track as a point on a 2D map (WebGL), with zoom/pan, pinch,
// search, genre/acervo filters and a card that links to the player.
// Classic script, loaded after acervo-format.js (decodeAcervo, albumSlugs), util.js (fold) and
// atlas-data.js (decodeAtlas, atlasKeyHash), atlas-grafo.js (criarGrafoAtlas), acervo-features.js (decodeFeatures),
// atlas-som.js (criarSomAtlas). Catalog text only ever
// reaches the page via textContent.
(function () {
  'use strict';

  const ACERVOS = {
    uqt: { label: 'UQT', data: 'https://rafapolo.github.io/uqt/data/uqt-albums.json.gz' },
    homi: { label: 'Homi', data: 'https://rafapolo.github.io/hominiscanidae/data/homi-albums.json.gz' },
  };
  const APP_ROOT = new URL('../', document.currentScript.src).href;
  const PAYLOAD = 'data/atlas-faixas.json.gz';
  const ZOOM_PONTO = 3;           // × the fit, when the map is sent to an artist or album: centered, with its surroundings in view

  // Macro-genres in a fixed order: the dark categorical palette the PNG maps were validated with.
  // Color follows the genre, never its rank; everything else is "Outros".
  const MACROS = [
    ['Rock', 'Rock', '#3987e5'], ['Latin', 'Latino', '#d95926'], ['Electronic', 'Eletrônica', '#199e70'],
    ['Folk, World, & Country', 'Folk / World', '#c98500'], ['Hip Hop', 'Hip Hop', '#d55181'],
    ['Jazz', 'Jazz', '#008300'], ['Pop', 'Pop', '#9085e9'], ['Funk / Soul', 'Funk / Soul', '#e66767'],
  ];
  const OUTROS = MACROS.length;
  const COR_OUTROS = '#6b6a64';
  const PT = { Classical: 'Clássica', 'Non-Music': 'Não-música', 'Stage & Screen': 'Palco e tela', "Children's": 'Infantil', 'Brass & Military': 'Fanfarra' };
  const nomeMacro = m => (MACROS.find(x => x[0] === m) || [m, PT[m] || m])[1];

  const $ = id => document.getElementById(id);
  const canvas = $('atlas-canvas');
  const fmt = n => n.toLocaleString('pt-BR');
  const reduzMovimento = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mobile = () => matchMedia('(max-width: 720px)').matches;

  // ── state ──
  let A = null, N = 0;
  let cor = null;                 // Uint8Array: macro index per point
  let ativo = null;               // Uint8Array: 1 = passes every filter
  let nAtivo = 0;
  const filtro = { acervo: 'todos', off: new Set(), busca: null, q: '' };
  let mapa = 'som', t = 0, tAlvo = 0;   // t: 0 = "som", 1 = "rotulos"; animated between
  let W = 1, H = 1, dpr = 1;
  let cx = 0.5, cy = 0.5, k = 1, k0 = 1;  // camera: world center, CSS px per world unit
  // 3D (maps with z in the payload, desktop): right-drag orbits. Points are rotated about `piv`, then viewed
  // orthographically; cx/cy live in the rotated space. yaw = pitch = 0 is the flat map.
  let yaw = 0, pitch = 0;
  let piv = [0.5, 0.5, 0.5];
  let M = [1, 0, 0, 0, 1, 0, 0, 0, 1];   // rotation, row-major
  let sel = -1, hover = -1;
  const cat = {};                 // acervo -> { db, slugs }
  let ptAlb = null, ptTr = null;  // point -> album / track index in its catalog
  let ptFila = null;              // point -> its row in <acervo>-features.json.gz, the catalog's track order
  let textos = null;              // point -> folded search text (built on first search)
  let ligado = false;             // catalogs linked to the points

  // ── data ──
  async function fetchJsonGz(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`${resp.status} ${url}`);
    const buf = new Uint8Array(await resp.arrayBuffer());
    // GitHub Pages serves .gz as-is; some servers decode it on the way. Look at the bytes.
    const text = buf[0] === 0x1f && buf[1] === 0x8b
      ? await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
      : new TextDecoder().decode(buf);
    return JSON.parse(text);
  }
  async function carregarPayload() {
    try { return await fetchJsonGz(APP_ROOT + PAYLOAD); }
    catch { return fetchJsonGz('https://tocador.cc/' + PAYLOAD); }   // mirrors don't copy data/
  }

  function macroDe(g) { return g.split('---')[0]; }
  function subDe(g) { return g.split('---')[1] || g; }

  function preparar(p) {
    A = decodeAtlas(p);
    N = A.n;
    const corGen = A.generos.map(g => { const i = MACROS.findIndex(m => m[0] === macroDe(g)); return i < 0 ? OUTROS : i; });
    cor = new Uint8Array(N);
    for (let i = 0; i < N; i++) cor[i] = corGen[A.genero[i]];
    ativo = new Uint8Array(N).fill(1);
    nAtivo = N;
  }

  // Player numbering, as buildAlbums() in ui.js does it: dedup by lowercased title (the copy outside a
  // subfolder wins), then num ?? position. A track dropped by the dedup links to the one that stayed.
  const numsCache = new WeakMap();
  function numDaFaixa(album, ti) {
    let nums = numsCache.get(album);
    if (!nums) {
      const pos = new Map(), kept = [];
      album.tracks.forEach((tr, ci) => {
        const key = (tr.title || '').toLowerCase();
        if (!pos.has(key)) { pos.set(key, kept.length); kept.push(ci); }
        else if (!tr.file?.includes('/') && album.tracks[kept[pos.get(key)]].file?.includes('/')) kept[pos.get(key)] = ci;
      });
      const numKept = kept.map((ci, i) => album.tracks[ci].num ?? (i + 1));
      nums = album.tracks.map(tr => numKept[pos.get((tr.title || '').toLowerCase())]);
      numsCache.set(album, nums);
    }
    return nums[ti];
  }

  function urlPlayer(i) {
    const ak = A.acervos[A.acervo[i]], c = cat[ak], ai = ptAlb[i], album = c.db.albums[ai];
    const num = numDaFaixa(album, ptTr[i]);
    if (location.hostname === 'tocador.cc') {          // static album pages exist only there
      c.slugs ??= albumSlugs(c.db.albums);
      return `${APP_ROOT}${ak}/${c.slugs[ai]}/?play=1#t${num}`;
    }
    return `${APP_ROOT}?${new URLSearchParams({ acervo: ak, album: album.path, t: num, play: 1 })}`;
  }

  function urlAlbum(ak, ai) {
    const c = cat[ak];
    if (location.hostname === 'tocador.cc') {
      c.slugs ??= albumSlugs(c.db.albums);
      return `${APP_ROOT}${ak}/${c.slugs[ai]}/`;
    }
    return `${APP_ROOT}?${new URLSearchParams({ acervo: ak, album: c.db.albums[ai].path })}`;
  }

  // Artist key -> albums where they appear, on the album or on any of its tracks.
  let porArtista = null;
  function indexarArtistas() {
    const m = new Map(), chaves = new Map();
    const chavesDe = t => {
      if (!chaves.has(t)) chaves.set(t, parseArtists(t.replace(/\x00/g, '; ')).map(chaveArtista));
      return chaves.get(t);
    };
    for (const ak of Object.keys(cat)) {
      cat[ak].db.albums.forEach((album, ai) => {
        const dele = new Set(chavesDe(album.artist || ''));
        for (const tr of album.tracks) if (tr.artists) for (const c of chavesDe(tr.artists)) dele.add(c);
        for (const c of dele) { if (!m.has(c)) m.set(c, []); m.get(c).push({ ak, ai, album }); }
      });
    }
    return m;
  }
  // The graph's names lose credits and punctuation (chaveArtista), but ?artista= compares with fold(), so the link
  // carries the spelling the catalog has. `preferido`: the acervo with most of the artist's tracks. Null before the
  // catalogs arrive.
  function urlArtista(nome, preferido) {
    if (!ligado) return null;
    porArtista ??= indexarArtistas();
    const c = chaveArtista(nome), lista = porArtista.get(c);
    if (!lista) return null;
    const { ak, album } = lista.find(x => x.ak === preferido) || lista[0];
    const textos = [album.artist, ...album.tracks.map(t => t.artists)].filter(Boolean);
    const exato = textos.flatMap(t => parseArtists(t.replace(/\x00/g, '; '))).find(p => chaveArtista(p) === c);
    const artista = !exato || fold(exato) === fold(nome) ? nome : exato;
    return `${APP_ROOT}?${new URLSearchParams({ acervo: ak, artista })}`;
  }
  function albunsDe(nome) {
    if (!ligado) return 0;
    porArtista ??= indexarArtistas();
    return porArtista.get(chaveArtista(nome))?.length ?? 0;
  }
  function capasDe(nome) {
    if (!ligado) return [];
    porArtista ??= indexarArtistas();
    return (porArtista.get(chaveArtista(nome)) || []).filter(x => x.album.has_cover).sort((a, b) => (b.album.year || 0) - (a.album.year || 0))
      .map(({ ak, ai, album }) => ({
        href: urlAlbum(ak, ai),
        src: `${cat[ak].db.meta.base_url}/${encodeURIComponent(album.path)}/capa-min.jpg`,
        titulo: album.year ? `${album.title} (${album.year})` : album.title,
      }));
  }

  function infoDe(i) {
    if (!ligado || ptAlb[i] < 0) return null;
    const ak = A.acervos[A.acervo[i]], db = cat[ak].db, album = db.albums[ptAlb[i]], track = album.tracks[ptTr[i]];
    const artista = track.artists ? track.artists.replace(/\x00/g, '; ') : album.artist;
    return { ak, db, album, track, artista };
  }

  async function carregarCatalogos() {
    const res = await Promise.allSettled(A.acervos.map(ak => fetchJsonGz(ACERVOS[ak].data)));
    const porHash = A.acervos.map(() => new Map());
    for (let i = 0; i < N; i++) porHash[A.acervo[i]].set(A.hash[i], i);
    ptAlb = new Int32Array(N).fill(-1);
    ptTr = new Int32Array(N);
    ptFila = new Int32Array(N).fill(-1);
    let falhou = 0;
    res.forEach((r, ai) => {
      if (r.status !== 'fulfilled') { falhou++; return; }
      const ak = A.acervos[ai], db = decodeAcervo(r.value), m = porHash[ai];
      cat[ak] = { db, slugs: null };
      let fila = 0;
      db.albums.forEach((album, bi) => album.tracks.forEach((tr, ti) => {
        const i = m.get(atlasKeyHash(`${album.path}/${tr.file}`.normalize('NFC')));
        if (i !== undefined) { ptAlb[i] = bi; ptTr[i] = ti; ptFila[i] = fila; }
        fila++;
      }));
    });
    ligado = true;
    if (falhou === res.length) { $('contagem').textContent = 'catálogos indisponíveis'; return; }
    $('busca').disabled = false;
    if (filtro.q) { $('busca').value = filtro.q; buscar(filtro.q, false); }
    atualizarContagem();
    grafo.atualizarPainel();
    semHistorico(() => selecaoDaUrl(new URLSearchParams(location.search)));
  }

  // ── WebGL ──
  let gl, prog, loc = {}, buf = {};
  const VS = `
    precision highp float;
    attribute vec2 a_som; attribute float a_somz; attribute vec2 a_rot; attribute float a_rotz; attribute float a_cor; attribute float a_on;
    uniform float u_t; uniform vec2 u_c; uniform vec2 u_k; uniform float u_size; uniform float u_sizeOn;
    uniform vec3 u_pal[9]; uniform float u_alpha; uniform float u_dim;
    uniform mat3 u_R; uniform vec3 u_piv; uniform float u_dz;
    varying vec4 v_col;
    void main() {
      vec3 p = mix(vec3(a_som, a_somz), vec3(a_rot, a_rotz), u_t);
      vec3 q = u_R * (p - u_piv) + u_piv;
      gl_Position = vec4((q.xy - u_c) * u_k, 0.0, 1.0);
      // depth cue when tilted: nearer points (larger z) bigger and brighter
      float d = clamp(1.0 + (q.z - u_piv.z) * u_dz, 0.45, 1.8);
      bool on = a_on > 0.5;
      gl_PointSize = (on ? u_sizeOn : max(1.0, u_size * 0.6)) * d;
      vec3 c = u_pal[8];
      for (int j = 0; j < 9; j++) { if (float(j) == a_cor) c = u_pal[j]; }
      v_col = vec4(c, (on ? u_alpha : u_dim) * clamp(0.3 + 0.7 * d, 0.3, 1.0));
    }`;
  const FS = `
    precision mediump float;
    varying vec4 v_col; uniform float u_round;
    void main() {
      float a = v_col.a;
      if (u_round > 0.5) {
        vec2 d = gl_PointCoord - 0.5; float r = dot(d, d);
        if (r > 0.25) discard;
        a *= smoothstep(0.25, 0.14, r);
      }
      gl_FragColor = vec4(v_col.rgb * a, a);
    }`;

  function hex3(h) { return [1, 3, 5].map(j => parseInt(h.slice(j, j + 2), 16) / 255); }

  function iniciarGL() {
    gl = canvas.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: true });
    if (!gl) return false;
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    for (const n of ['a_som', 'a_somz', 'a_rot', 'a_rotz', 'a_cor', 'a_on']) loc[n] = gl.getAttribLocation(prog, n);
    for (const n of ['u_t', 'u_c', 'u_k', 'u_size', 'u_sizeOn', 'u_pal', 'u_alpha', 'u_dim', 'u_round', 'u_R', 'u_piv', 'u_dz']) loc[n] = gl.getUniformLocation(prog, n);
    const atrib = (nome, data, size, type, norm) => {
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, nome === 'a_on' ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc[nome]);
      gl.vertexAttribPointer(loc[nome], size, type, norm, 0, 0);
      buf[nome] = b;
    };
    atrib('a_som', A.pos.som, 2, gl.UNSIGNED_SHORT, true);
    atrib('a_somz', A.posZ.som || new Uint16Array(N).fill(32768), 1, gl.UNSIGNED_SHORT, true);
    atrib('a_rot', A.pos.rotulos, 2, gl.UNSIGNED_SHORT, true);
    atrib('a_rotz', A.posZ.rotulos || new Uint16Array(N).fill(32768), 1, gl.UNSIGNED_SHORT, true);
    atrib('a_cor', cor, 1, gl.UNSIGNED_BYTE, false);
    atrib('a_on', ativo, 1, gl.UNSIGNED_BYTE, false);
    gl.uniform3fv(loc.u_pal, new Float32Array([...MACROS.map(m => m[2]), COR_OUTROS].flatMap(hex3)));
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(15 / 255, 14 / 255, 12 / 255, 1);
    return true;
  }

  function enviarAtivo() {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf.a_on);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, ativo);
  }

  // ── camera ──
  const px = (i, m) => A.pos[m][2 * i] / 65535;
  const py = (i, m) => A.pos[m][2 * i + 1] / 65535;
  const pz = (i, m) => (A.posZ[m] ? A.posZ[m][i] / 65535 : 0.5);
  const girado = () => yaw !== 0 || pitch !== 0;
  function rotacao() {
    const a = Math.cos(yaw), b = Math.sin(yaw), c = Math.cos(pitch), d = Math.sin(pitch);
    M = [a, 0, b, d * b, c, -d * a, -c * b, d, c * a];   // Rx(pitch) · Ry(yaw)
  }
  // World point -> rotated (view) space.
  function girar(x, y, z) {
    const X = x - piv[0], Y = y - piv[1], Z = z - piv[2];
    return [M[0] * X + M[1] * Y + M[2] * Z + piv[0], M[3] * X + M[4] * Y + M[5] * Z + piv[1], M[6] * X + M[7] * Y + M[8] * Z + piv[2]];
  }
  function mundo3(i) {
    if (t === 0) return [px(i, 'som'), py(i, 'som'), pz(i, 'som')];
    if (t === 1) return [px(i, 'rotulos'), py(i, 'rotulos'), pz(i, 'rotulos')];
    return [px(i, 'som') * (1 - t) + px(i, 'rotulos') * t, py(i, 'som') * (1 - t) + py(i, 'rotulos') * t, pz(i, 'som') * (1 - t) + pz(i, 'rotulos') * t];
  }
  const vista = i => { const p = mundo3(i); return girado() ? girar(p[0], p[1], p[2]) : p; };
  const mundoX = i => vista(i)[0];
  const mundoY = i => vista(i)[1];
  // Move the pivot to the point under the screen center without moving anything on screen:
  // every rotated point shifts by (I - M)(P' - P), so the camera shifts with it.
  function pivoNoCentro() {
    const q = [cx - piv[0], cy - piv[1], 0];
    const p = [0, 1, 2].map(j => M[j] * q[0] + M[3 + j] * q[1] + M[6 + j] * q[2] + piv[j]);   // Mᵀq + P
    const dP = [p[0] - piv[0], p[1] - piv[1], p[2] - piv[2]];
    cx += dP[0] - (M[0] * dP[0] + M[1] * dP[1] + M[2] * dP[2]);
    cy += dP[1] - (M[3] * dP[0] + M[4] * dP[1] + M[5] * dP[2]);
    piv = p;
  }
  const telaX = x => W / 2 + (x - cx) * k;
  const telaY = y => H / 2 - (y - cy) * k;
  let topoBaixo = 100;            // where the top bar ends: one line or two, depending on the width
  const margemTopo = () => topoBaixo;
  const margemBase = () => (mobile() ? 60 : 30);

  function caixa(m, filtroIdx, lo = 0.003, hi = 0.997, projetar = false) {
    const xs = [], ys = [];
    for (let i = 0; i < N; i++) {
      if (filtroIdx && !filtroIdx[i]) continue;
      if (projetar && girado()) { const q = vista(i); xs.push(q[0]); ys.push(q[1]); }
      else { xs.push(px(i, m)); ys.push(py(i, m)); }
    }
    if (!xs.length) return null;
    xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
    const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(f * (arr.length - 1))))];
    return [q(xs, lo), q(ys, lo), q(xs, hi), q(ys, hi)];
  }
  const caixas = {};
  function enquadrar(b, animar = true, minSpan = 0, rot = null) {
    const bw = Math.max(b[2] - b[0], minSpan), bh = Math.max(b[3] - b[1], minSpan);
    const ah = Math.max(80, H - margemTopo() - margemBase());
    const nk = Math.min(W / bw, ah / bh) * 0.92;
    const ncx = (b[0] + b[2]) / 2, ncy = (b[1] + b[3]) / 2 + (margemTopo() - margemBase()) / 2 / nk;
    voar(ncx, ncy, nk, animar, rot);
  }
  function enquadrarTudo(animar = true) {
    caixas[mapa] ??= caixa(mapa);
    const b = caixas[mapa];
    const bw = b[2] - b[0], bh = b[3] - b[1];
    k0 = Math.min(W / bw, Math.max(80, H - margemTopo() - margemBase()) / bh) * 0.92;
    // the box is of the flat map, so the view goes back to flat; rotating about the
    // data center then keeps the front view in place
    if (girado()) pivoNoCentro();
    enquadrar(b, animar, 0, [0, 0]);
  }

  let voo = null;
  function voar(ncx, ncy, nk, animar = true, rot = null) {
    nk = limitarK(nk);
    const [yaw1, pitch1] = rot || [yaw, pitch];
    if (!animar || reduzMovimento) { cx = ncx; cy = ncy; k = nk; yaw = yaw1; pitch = pitch1; rotacao(); voo = null; pedir(); return; }
    voo = { cx0: cx, cy0: cy, k0: k, cx1: ncx, cy1: ncy, k1: nk, yaw0: yaw, yaw1, pitch0: pitch, pitch1, t0: performance.now(), ms: rot ? 650 : 450 };
    pedir();
  }
  function passoVoo(agora) {
    if (!voo) return false;
    const f = Math.min(1, (agora - voo.t0) / voo.ms), e = 1 - Math.pow(1 - f, 3);
    k = Math.exp(Math.log(voo.k0) * (1 - e) + Math.log(voo.k1) * e);
    cx = voo.cx0 + (voo.cx1 - voo.cx0) * e;
    cy = voo.cy0 + (voo.cy1 - voo.cy0) * e;
    if (voo.yaw0 !== voo.yaw1 || voo.pitch0 !== voo.pitch1) {
      yaw = voo.yaw0 + (voo.yaw1 - voo.yaw0) * e; pitch = voo.pitch0 + (voo.pitch1 - voo.pitch0) * e;
      if (f >= 1) { yaw = voo.yaw1; pitch = voo.pitch1; }
      rotacao();
    }
    if (f >= 1) voo = null;
    return !!voo;
  }
  const limitarK = v => Math.min(k0 * 600, Math.max(k0 * 0.5, v));
  function zoomEm(sx, sy, f) {
    voo = null;
    const wx = cx + (sx - W / 2) / k, wy = cy - (sy - H / 2) / k;
    k = limitarK(k * f);
    cx = wx - (sx - W / 2) / k; cy = wy + (sy - H / 2) / k;
    pedir();
  }

  // ── drawing ──
  let pendente = false, tTrans0 = 0;
  function pedir() { if (!pendente) { pendente = true; requestAnimationFrame(desenhar); } }

  function desenhar(agora) {
    pendente = false;
    let mais = passoVoo(agora);
    if (t !== tAlvo) {
      const f = reduzMovimento ? 1 : Math.min(1, (agora - tTrans0) / 900);
      const e = f < 0.5 ? 4 * f * f * f : 1 - Math.pow(-2 * f + 2, 3) / 2;
      t = tAlvo === 1 ? e : 1 - e;
      if (f >= 1) { t = tAlvo; grade = null; } else mais = true;
    }
    const z = k / k0;
    const size = Math.min(12, Math.max(1.7, 1.7 * Math.pow(z, 0.42))) * dpr;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(loc.u_t, t);
    gl.uniform2f(loc.u_c, cx, cy);
    gl.uniform2f(loc.u_k, 2 * k / W, 2 * k / H);
    gl.uniformMatrix3fv(loc.u_R, false, new Float32Array([M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]]));   // column-major
    gl.uniform3f(loc.u_piv, piv[0], piv[1], piv[2]);
    gl.uniform1f(loc.u_dz, girado() ? 1.6 : 0);
    // A narrow filter (a search, one genre) leaves few lit points in a dim cloud: draw them bigger.
    const estreito = nAtivo < N * 0.25;
    const sizeOn = estreito ? Math.max(size * 1.8, 4.5 * dpr) : size;
    gl.uniform1f(loc.u_size, size);
    gl.uniform1f(loc.u_sizeOn, sizeOn);
    gl.uniform1f(loc.u_round, sizeOn >= 3 ? 1 : 0);
    gl.uniform1f(loc.u_alpha, estreito ? 0.95 : Math.min(0.95, 0.62 + 0.09 * Math.log2(Math.max(1, z))));
    gl.uniform1f(loc.u_dim, nAtivo < N ? 0.07 : 0.6);
    gl.drawArrays(gl.POINTS, 0, N);
    posicionarAnel($('anel-sel'), sel);
    posicionarAnel($('anel-hover'), hover !== sel ? hover : -1);
    som?.mexeu();
    const comNomes = desenharFaixas();
    desenharMarcos(comNomes);
    if (mais) pedir();
  }

  function posicionarAnel(el, i) {
    if (i < 0) { el.hidden = true; return; }
    const x = telaX(mundoX(i)), y = telaY(mundoY(i));
    el.hidden = x < -20 || y < -20 || x > W + 20 || y > H + 20;
    el.style.transform = `translate(${x}px, ${y}px)`;
    if (el.id === 'anel-sel' && !el.hidden) el.style.borderColor = MACROS[cor[i]]?.[2] || 'var(--accent)';
  }

  // Subgenre labels at the median of their points; more appear as you zoom in.
  const poolMarcos = [];
  function desenharMarcos(comNomes) {
    const box = $('marcos');
    let usados = 0;
    if ((t === 0 || t === 1) && !filtro.busca && !comNomes) {
      const z = k / k0, minimo = 1200 / Math.pow(z, 1.7), limite = mobile() ? 22 : 42;
      const rects = [];
      for (const [g, qx, qy, n, qz = 32768] of A.marcos[mapa]) {
        if (usados >= limite) break;
        if (n < minimo) continue;
        const c = MACROS.findIndex(m => m[0] === macroDe(A.generos[g]));
        if (filtro.off.has(c < 0 ? OUTROS : c)) continue;
        const v = girado() ? girar(qx / 65535, qy / 65535, qz / 65535) : [qx / 65535, qy / 65535];
        const x = telaX(v[0]), y = telaY(v[1]);
        const nome = subDe(A.generos[g]), w = nome.length * 7 + 8, h = 16;
        if (x < w / 2 || x > W - w / 2 || y < margemTopo() - 10 || y > H - 10) continue;
        if (rects.some(r => Math.abs(r[0] - x) < (r[2] + w) / 2 && Math.abs(r[1] - y) < (r[3] + h) / 2)) continue;
        rects.push([x, y, w, h]);
        let el = poolMarcos[usados];
        if (!el) { el = document.createElement('span'); el.className = 'marco'; box.appendChild(el); poolMarcos.push(el); }
        if (el.textContent !== nome) el.textContent = nome;
        el.classList.toggle('menor', n < 400);
        el.style.left = x + 'px'; el.style.top = y + 'px';
        el.hidden = false;
        usados++;
      }
    }
    for (let j = usados; j < poolMarcos.length; j++) poolMarcos[j].hidden = true;
  }

  // Close up, the dots get their track titles: those nearest the screen center first, as many as fit
  // without overlapping, so zooming further in names every dot.
  const poolFaixas = [];
  function desenharFaixas() {
    let usados = 0;
    if (ligado && t === tAlvo && k / k0 >= 10) {
      const limite = mobile() ? 60 : 160, cand = [];
      const dentro = (i, q) => {
        const x = telaX(q[0]), y = telaY(q[1]);
        if (x > -4 && x < W && y > margemTopo() - 20 && y < H) cand.push([i, x, y, (x - W / 2) ** 2 + (y - H / 2) ** 2, q[2] ?? 0]);
      };
      if (girado()) {
        for (let i = 0; i < N; i++) if (ativo[i]) dentro(i, vista(i));
      } else {
        if (!grade || grade.m !== mapa) montarGrade();
        const gx0 = Math.max(0, Math.floor((cx - W / 2 / k) * G)), gx1 = Math.min(G - 1, Math.floor((cx + W / 2 / k) * G));
        const gy0 = Math.max(0, Math.floor((cy - H / 2 / k) * G)), gy1 = Math.min(G - 1, Math.floor((cy + H / 2 / k) * G));
        if ((gx1 - gx0 + 1) * (gy1 - gy0 + 1) <= 4096) {
          for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
            const c = gx * G + gy;
            for (let j = grade.cont[c]; j < grade.cont[c + 1]; j++) { const i = grade.idx[j]; if (ativo[i]) dentro(i, [px(i, mapa), py(i, mapa)]); }
          }
        }
      }
      if (cand.length && cand.length <= limite * 6) {
        cand.sort((a, b) => a[3] - b[3]);
        const box = $('faixas'), rects = [];
        for (const [i, x, y] of cand) {
          if (usados >= limite) break;
          const info = infoDe(i);
          if (!info) continue;
          let nome = info.track.title || info.track.file;
          if (nome.length > 34) nome = nome.slice(0, 32) + '…';
          const w = nome.length * 6.4 + 4, h = 14, rx = x + 6, ry = y - h / 2;
          if (rx + w > W) continue;
          if (rects.some(r => rx < r[0] + r[2] && rx + w > r[0] && ry < r[1] + r[3] && ry + h > r[1])) continue;
          rects.push([rx, ry, w, h]);
          let el = poolFaixas[usados];
          if (!el) { el = document.createElement('span'); el.className = 'nome-faixa'; box.appendChild(el); poolFaixas.push(el); }
          if (el.textContent !== nome) el.textContent = nome;
          el.style.transform = `translate(${rx}px, ${ry}px)`;
          el.hidden = false;
          usados++;
        }
      }
    }
    for (let j = usados; j < poolFaixas.length; j++) poolFaixas[j].hidden = true;
    return usados > 0;
  }

  // ── picking: uniform grid over world space, rebuilt per map ──
  const G = 256;
  let grade = null;
  function montarGrade() {
    const m = mapa, cont = new Uint32Array(G * G + 1), celula = new Uint32Array(N);
    for (let i = 0; i < N; i++) {
      const c = Math.min(G - 1, Math.floor(px(i, m) * G)) * G + Math.min(G - 1, Math.floor(py(i, m) * G));
      celula[i] = c; cont[c + 1]++;
    }
    for (let c = 0; c < G * G; c++) cont[c + 1] += cont[c];
    const idx = new Uint32Array(N), fill = cont.slice(0, G * G);
    for (let i = 0; i < N; i++) idx[fill[celula[i]]++] = i;
    grade = { m, cont, idx };
  }
  function pegar(sx, sy, raioPx) {
    if (!A || t !== tAlvo) return -1;
    if (girado()) {   // the grid is of the flat map; 80k projections per pick is still ~1 ms
      const wx = cx + (sx - W / 2) / k, wy = cy - (sy - H / 2) / k, r = raioPx / k;
      let melhor = -1, dMin = r * r, zMax = -Infinity;
      for (let i = 0; i < N; i++) {
        if (!ativo[i]) continue;
        const q = vista(i), dx = q[0] - wx, dy = q[1] - wy, d = dx * dx + dy * dy;
        if (d > r * r) continue;
        // among the points under the cursor, the nearest to the cursor; ties go to the front one
        if (d < dMin * 0.6 || (d <= dMin && q[2] > zMax)) { dMin = d; zMax = q[2]; melhor = i; }
      }
      return melhor;
    }
    if (!grade || grade.m !== mapa) montarGrade();
    const wx = cx + (sx - W / 2) / k, wy = cy - (sy - H / 2) / k, r = raioPx / k;
    const x0 = Math.max(0, Math.floor((wx - r) * G)), x1 = Math.min(G - 1, Math.floor((wx + r) * G));
    const y0 = Math.max(0, Math.floor((wy - r) * G)), y1 = Math.min(G - 1, Math.floor((wy + r) * G));
    let melhor = -1, dMin = r * r;
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
      const c = gx * G + gy;
      for (let j = grade.cont[c]; j < grade.cont[c + 1]; j++) {
        const i = grade.idx[j];
        if (!ativo[i]) continue;
        const dx = px(i, mapa) - wx, dy = py(i, mapa) - wy, d = dx * dx + dy * dy;
        if (d <= dMin) { dMin = d; melhor = i; }
      }
    }
    return melhor;
  }

  // ── what the music hears: js/atlas-som.js asks these two ──
  // Every lit point on screen, with its screen position. The grid when flat; rotated, a plain pass (no
  // allocation per point, so 80k of them every 200 ms stay well under a millisecond or two).
  function paraCadaVisivel(fn, margem = 0) {
    const m = mapa, x0 = -margem, x1 = W + margem, y0 = -margem, y1 = H + margem;
    if (girado()) {
      const P = A.pos[m], Z = A.posZ[m];
      for (let i = 0; i < N; i++) {
        if (!ativo[i]) continue;
        const X = P[2 * i] / 65535 - piv[0], Y = P[2 * i + 1] / 65535 - piv[1], Zz = (Z ? Z[i] / 65535 : 0.5) - piv[2];
        const x = telaX(M[0] * X + M[1] * Y + M[2] * Zz + piv[0]), y = telaY(M[3] * X + M[4] * Y + M[5] * Zz + piv[1]);
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) fn(i, x, y);
      }
      return;
    }
    if (!grade || grade.m !== m) montarGrade();
    const gx0 = Math.max(0, Math.floor((cx - W / 2 / k) * G)), gx1 = Math.min(G - 1, Math.floor((cx + W / 2 / k) * G));
    const gy0 = Math.max(0, Math.floor((cy - H / 2 / k) * G)), gy1 = Math.min(G - 1, Math.floor((cy + H / 2 / k) * G));
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
      const c = gx * G + gy;
      for (let j = grade.cont[c]; j < grade.cont[c + 1]; j++) {
        const i = grade.idx[j];
        if (!ativo[i]) continue;
        const x = telaX(px(i, m)), y = telaY(py(i, m));
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) fn(i, x, y);
      }
    }
  }

  // Per-track audio features, fetched only once the music starts. Rows are the catalog's tracks in order, and
  // a catalog that changed after the features were built is refused: the music then plays the plain recipes.
  const feats = [];
  async function carregarFeaturesSom() {
    await prontoP;
    await Promise.allSettled(A.acervos.map(async (ak, ai) => {
      const db = cat[ak]?.db;
      if (!db) return;
      const nome = `data/${ak}-features.json.gz`;
      const p = await fetchJsonGz(APP_ROOT + nome).catch(() => fetchJsonGz('https://tocador.cc/' + nome));
      const chaves = [];
      for (const a of db.albums) for (const tr of a.tracks) chaves.push(`${a.path}/${tr.file}`.normalize('NFC'));
      feats[ai] = decodeFeatures(p, chaves);
      for (const v of feats[ai].tom) if (v) SOM_TOM_TODAS[v - 1]++;
    }));
  }

  const SOM_BPM = new Float32Array(260), SOM_TOM = new Float32Array(24);
  const SOM_M = new Float32Array(64), SOM_Y = new Float32Array(64), SOM_H = new Float32Array(64), SOM_G = new Float32Array(64);
  // Key detection leans to a few keys, C major first, so the commonest key on screen is C nearly everywhere.
  // A region's key is the one it has more of than the whole archive does; a broad view has none, and keeps
  // the family's own.
  const SOM_TOM_TODAS = new Float32Array(24);
  function tomDaRegiao() {
    const soma = SOM_TOM.reduce((a, b) => a + b, 0), todas = SOM_TOM_TODAS.reduce((a, b) => a + b, 0);
    if (!soma || !todas) return {};
    let melhor = -1, destaque = 1.3, menor = 0, menorTodas = 0;
    for (let j = 0; j < 24; j++) {
      const parte = SOM_TOM[j] / soma, d = parte / (SOM_TOM_TODAS[j] / todas || 1);
      if (parte >= 0.06 && d > destaque) { destaque = d; melhor = j; }
      if (j & 1) { menor += SOM_TOM[j]; menorTodas += SOM_TOM_TODAS[j]; }
    }
    return { tonica: melhor < 0 ? undefined : melhor >> 1, modo: menor / soma > menorTodas / todas ? 'menor' : 'maior' };
  }
  let somG = null, somX = null, somIdx = null, somCam = null;
  // What the camera looks at: weight per genre (the nearer the center the more it counts), where each sits on
  // screen, and, with the features in, the median tempo, the commonest key and the mood of those same tracks.
  // The graph has no dots to read: each artist is a place of its own.
  const lugarDe = nome => { let h = 7; for (const c of nome || '') h = (h * 31 + c.charCodeAt(0)) % 9973; return { x: h / 317, y: h / 139, vel: 0 }; };
  function regiaoSom() {
    if (!A || t !== tAlvo) return null;
    somG ??= new Float32Array(A.generos.length);
    somX ??= new Float32Array(A.generos.length);
    somG.fill(0); somX.fill(0);
    const agora = performance.now();
    let z = k / k0, tempero = null;
    // Everything on screen goes through here, dots of the map or artists of the graph: its weight in the mix, near the
    // center, and its place in the score, a piano roll of 4 rows by 16 columns, a point shared between the two columns
    // it falls between so that dragging moves notes gradually.
    const r2 = (Math.min(W, H) * (grafo.aberto ? 0.5 : 0.25)) ** 2;     // tight on the map: the edges would outvote the sights
    const raio = Math.sqrt(r2) * 2, xi = W / 2 - raio, yi = H / 2 - raio, lado = raio * 2;
    SOM_M.fill(0); SOM_Y.fill(0); SOM_H.fill(0);
    const juntar = (x, y, g, hash, peso) => {
      const w = peso * Math.exp(-((x - W / 2) ** 2 + (y - H / 2) ** 2) / r2);
      somG[g] += w; somX[g] += w * x;
      const c = (x - xi) / lado * 15, l = Math.floor((y - yi) / lado * 4);
      if (c < 0 || c > 15 || l < 0 || l > 3) return;
      const c0 = Math.floor(c), u = c - c0, ny = (y - yi) / lado * 4 - l, h = (hash % 1024) / 1024 - 0.5;
      for (const [col, p] of [[c0, 1 - u], [Math.min(15, c0 + 1), u]]) {
        const k = l * 16 + col;
        SOM_M[k] += p * peso; SOM_Y[k] += p * peso * (l + ny); SOM_H[k] += p * peso * h;
      }
    };
    if (grafo.aberto) {
      somIdx ??= new Map(A.generos.map((g, i) => [g, i]));
      grafo.pontosVisiveis((x, y, nome, hash, peso) => { const g = somIdx.get(nome); if (g !== undefined) juntar(x, y, g, hash, peso); });
      z = grafo.centro ? 12 : 5 * grafo.zoom;            // centered, the full band; the overview opens up with its zoom
    } else {
      SOM_BPM.fill(0); SOM_TOM.fill(0);
      let somaF = 0, dance = 0, acoustic = 0, electronic = 0;
      const comFeats = feats.length > 0 && ptFila;
      paraCadaVisivel((i, x, y) => {
        juntar(x, y, A.genero[i], A.hash[i], 1);
        const w = Math.exp(-((x - W / 2) ** 2 + (y - H / 2) ** 2) / r2);
        const f = comFeats && feats[A.acervo[i]], r = f ? ptFila[i] : -1;
        if (r < 0 || !f.bpm[r]) return;
        SOM_BPM[Math.min(259, f.bpm[r])] += w;
        if (f.tom[r]) SOM_TOM[f.tom[r] - 1] += w;
        somaF += w; dance += w * (f.dance[r] + f.party[r]) / 510;
        acoustic += w * f.acoustic[r] / 255; electronic += w * f.electronic[r] / 255;
      });
      if (somaF > 0) {
        let acc = 0, bpm = 0;
        while (bpm < 259 && (acc += SOM_BPM[bpm]) < somaF / 2) bpm++;
        tempero = { bpm, ...tomDaRegiao(), densidade: 0.45 + 0.8 * dance / somaF, brilho: 1 + 0.6 * (electronic - acoustic) / somaF };
      }
    }
    // Height on screen gives the contour; the mean identity of a cell's tracks, wide when few dots share it, the detail.
    let total = 0;
    for (let k = 0; k < 64; k++) {
      const m = SOM_M[k];
      total += m;
      SOM_G[k] = m ? (2 - SOM_Y[k] / m) * 3 + (SOM_H[k] / m) * 7 : 0;
    }
    const leitura = total ? { m: SOM_M, g: SOM_G } : null;
    const antes = somCam, seg = antes ? Math.max(0.05, (agora - antes.t) / 1000) : 1;
    somCam = { t: agora, cx, cy, k, yaw, pitch };
    const velocidade = !antes ? 0 : (Math.hypot(cx - antes.cx, cy - antes.cy) * k + Math.abs(Math.log(k / antes.k)) * 800
      + (Math.abs(yaw - antes.yaw) + Math.abs(pitch - antes.pitch)) * 400) / seg / 1500;
    const l = Math.floor(Math.log2(Math.max(1, k / k0))) + 2;
    return { pesos: somG, somaX: somX, largura: W, z, giro: Math.min(1, (Math.abs(yaw % Math.PI) + Math.abs(pitch)) / 1.45), velocidade,
      semente: 1 + (Math.floor(cx * 2 ** l) * 7919 + Math.floor(cy * 2 ** l) * 104729 + l) % 2147483629, tempero, leitura,
      lugar: grafo.aberto ? lugarDe(grafo.centro) : { x: cx, y: cy, vel: Math.min(1, velocidade) } };
  }

  // Close up, each dot rings once as it crosses the sights, in the middle of the screen.
  const naMira = new Set();
  function miraSom() {
    if (!A || grafo.aberto || t !== tAlvo || k / k0 < 10) { naMira.clear(); return null; }
    const R = 26, aqui = new Set(), novos = [];
    paraCadaVisivel((i, x, y) => {
      const d = Math.hypot(x - W / 2, y - H / 2);
      if (d > R) return;
      aqui.add(i);
      if (!naMira.has(i) && novos.length < 3) novos.push([A.hash[i], A.genero[i], (x / W - 0.5) * 1.5, 0.75 - 0.35 * d / R]);
    });
    naMira.clear();
    for (const i of aqui) naMira.add(i);
    return novos;
  }

  // ── filters ──
  function recalcular() {
    const ak = filtro.acervo === 'todos' ? -1 : A.acervos.indexOf(filtro.acervo);
    let n = 0;
    for (let i = 0; i < N; i++) {
      const on = (ak < 0 || A.acervo[i] === ak) && !filtro.off.has(cor[i]) && (!filtro.busca || filtro.busca[i] === 1) ? 1 : 0;
      ativo[i] = on; n += on;
    }
    nAtivo = n;
    enviarAtivo();
    if (sel >= 0 && !ativo[sel] && audio.paused) fecharCartao();   // a playing preview outlives the filter
    atualizarContagem();
    salvarUrl();
    pedir();
  }

  function atualizarContagem() {
    if (grafo.aberto) return;      // the graph writes its own count here
    const el = $('contagem');
    if (filtro.busca) el.textContent = nAtivo ? `${fmt(nAtivo)} ${nAtivo === 1 ? 'faixa' : 'faixas'}` : 'nada encontrado';
    else el.textContent = `${fmt(nAtivo)} faixas`;
  }

  function montarTextos() {
    textos = new Array(N);
    const albumTxt = new WeakMap();
    for (let i = 0; i < N; i++) {
      const info = infoDe(i);
      if (!info) { textos[i] = ''; continue; }
      let at = albumTxt.get(info.album);
      if (at === undefined) { at = fold(`${info.album.artist} ${info.album.title} ${info.album.year || ''}`); albumTxt.set(info.album, at); }
      textos[i] = at + ' ' + fold(`${info.track.title} ${info.track.artists || ''}`);
    }
  }

  function buscar(valor, mover = true) {
    const q = fold(valor.trim());
    filtro.q = valor.trim();
    $('busca-limpar').hidden = !filtro.q;
    grafo.buscar(filtro.q);
    if (q.length < 2) { filtro.busca = null; recalcular(); return; }
    if (!textos) montarTextos();
    const termos = q.split(/\s+/);
    const res = new Uint8Array(N);
    for (let i = 0; i < N; i++) { const s = textos[i]; if (s && termos.every(x => s.includes(x))) res[i] = 1; }
    filtro.busca = res;
    recalcular();
    if (mover && nAtivo) {
      const b = caixa(mapa, ativo, nAtivo > 50 ? 0.02 : 0, nAtivo > 50 ? 0.98 : 1, true);
      if (b) enquadrar(b, true, 0.015);
    }
  }

  // ── card ──
  function selecionar(i) {
    sel = i;
    som?.tap([4]);
    const info = infoDe(i);
    const g = A.generos[A.genero[i]];
    const cartao = $('cartao');
    pararPrevia();
    cartao.querySelector('.ponto').style.background = MACROS[cor[i]]?.[2] || COR_OUTROS;
    $('cartao-genero-nome').textContent = `${subDe(g)} · ${nomeMacro(macroDe(g))} · ${ACERVOS[A.acervos[A.acervo[i]]].label}`;
    const capa = $('cartao-capa');
    if (info) {
      $('cartao-titulo').textContent = info.track.title || info.track.file;
      $('cartao-artista').textContent = info.artista;
      $('cartao-album').textContent = info.album.year ? `${info.album.title} (${info.album.year})` : info.album.title;
      $('cartao-ouvir').href = urlPlayer(i);
      $('cartao-ouvir').removeAttribute('aria-disabled');
      $('cartao-previa').hidden = false;
      mostrarParecidos(i, parseArtists(info.artista));
      const base = info.db.meta?.base_url;
      if (info.album.has_cover && base) {
        capa.hidden = false;
        capa.src = `${base}/${encodeURIComponent(info.album.path)}/capa-min.jpg`;
      } else capa.hidden = true;
    } else {
      $('cartao-titulo').textContent = ligado ? 'Faixa fora do catálogo atual' : 'Carregando…';
      $('cartao-artista').textContent = $('cartao-album').textContent = '';
      $('cartao-ouvir').removeAttribute('href');
      $('cartao-ouvir').setAttribute('aria-disabled', 'true');
      $('cartao-previa').hidden = true;
      $('cartao-parecidos').hidden = true;
      capa.hidden = true;
    }
    cartao.hidden = false;
    pedir();
  }
  async function mostrarParecidos(i, artistas) {
    $('cartao-parecidos').hidden = true;
    const nomes = await grafo.parecidos(artistas, 4);
    if (sel !== i || !nomes.length) return;
    $('cartao-parecidos-lista').replaceChildren(...nomes.map(n => {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-artista"/></svg>';
      b.append(n);
      b.addEventListener('click', () => abrirGrafo(n));
      return b;
    }));
    $('cartao-parecidos').hidden = false;
  }
  function fecharCartao() {
    sel = -1;
    $('cartao').hidden = true;
    pararPrevia();
    pedir();
  }
  $('cartao-capa').addEventListener('error', e => { e.target.hidden = true; });
  $('cartao-fechar').addEventListener('click', () => { fecharCartao(); salvarUrl(true); });

  const audio = $('previa'), progresso = $('cartao-progresso');
  audio.addEventListener('timeupdate', () => {
    if (!audio.duration) return;
    progresso.hidden = false;
    progresso.firstElementChild.style.transform = `scaleX(${audio.currentTime / audio.duration})`;
  });
  function estadoPrevia(tocando) {
    const b = $('cartao-previa');
    b.setAttribute('aria-pressed', String(tocando));
    b.querySelector('use').setAttribute('href', tocando ? '#i-pausar' : '#i-tocar');
    b.querySelector('span').textContent = tocando ? 'Pausar' : 'Prévia';
  }
  function pararPrevia() {
    audio.pause();
    audio.removeAttribute('src');
    progresso.hidden = true;
    progresso.firstElementChild.style.transform = 'scaleX(0)';
    estadoPrevia(false);
  }
  $('cartao-previa').addEventListener('click', () => {
    const info = sel >= 0 && infoDe(sel);
    if (!info) return;
    if (!audio.paused) { pararPrevia(); return; }
    const base = info.db.meta?.base_url;
    audio.src = `${base}/${encodeURIComponent(info.album.path)}/${encodeURIComponent(info.track.file)}`;
    audio.play().catch(() => pararPrevia());
    estadoPrevia(true);
  });
  audio.addEventListener('ended', pararPrevia);
  window.anunciarSom?.(audio);    // another tab of this map keeps quiet too

  // ── tooltip (mouse only) ──
  const dica = $('dica');
  function mostrarDica(i, sx, sy) {
    const info = infoDe(i);
    if (!info) { dica.hidden = true; return; }
    const b = document.createElement('b'), s = document.createElement('span');
    b.textContent = info.track.title || info.track.file;
    s.textContent = `${info.artista} · ${subDe(A.generos[A.genero[i]])}`;
    dica.replaceChildren(b, s);
    dica.hidden = false;
    const w = dica.offsetWidth, h = dica.offsetHeight;
    dica.style.left = Math.min(W - w - 8, sx + 14) + 'px';
    dica.style.top = (sy + 14 + h > H ? sy - h - 10 : sy + 14) + 'px';
  }

  // ── gestures ──
  const ptrs = new Map();
  let gesto = null, ultimoToque = null;
  const posRel = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

  function iniciarGiro(x, y, moveu) {
    pivoNoCentro();
    gesto = { tipo: 'girar', x0: x, y0: y, yaw0: yaw, pitch0: pitch, moveu };
    if (moveu) { canvas.classList.add('arrastando'); dica.hidden = true; hover = -1; }
  }
  function iniciarPinca() {
    const [a, b] = [...ptrs.values()];
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    gesto = { tipo: 'pinca', d0: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, k0: k,
      wx: cx + (mx - W / 2) / k, wy: cy - (my - H / 2) / k };
  }
  canvas.addEventListener('pointerdown', e => {
    if (!A) return;
    canvas.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, posRel(e));
    voo = null;
    sumirAjuda();
    if (ptrs.size === 1) {
      const [x, y] = posRel(e);
      const botaoGira = e.pointerType === 'mouse' && (e.button === 2 || e.shiftKey);
      if ((botaoGira || modoGirar) && A.posZ[mapa] && t === tAlvo) {
        // with ⟳ on, a press that never moves is still a tap (picks a track); the right button never taps
        iniciarGiro(x, y, botaoGira);
        return;
      }
      gesto = { tipo: 'pan', x0: x, y0: y, cx0: cx, cy0: cy, t0: performance.now(), moveu: false };
    } else if (ptrs.size === 2) iniciarPinca();
  });
  canvas.addEventListener('pointermove', e => {
    if (!A) return;
    if (!ptrs.has(e.pointerId)) { if (e.pointerType === 'mouse') pairar(e); return; }
    ptrs.set(e.pointerId, posRel(e));
    if (gesto?.tipo === 'girar') {
      const [x, y] = posRel(e);
      if (!gesto.moveu) {
        if (Math.hypot(x - gesto.x0, y - gesto.y0) <= 6) return;
        gesto.moveu = true; canvas.classList.add('arrastando'); dica.hidden = true; hover = -1;
      }
      yaw = gesto.yaw0 + (x - gesto.x0) * 0.008;
      pitch = Math.max(-1.45, Math.min(1.45, gesto.pitch0 + (y - gesto.y0) * 0.008));
      rotacao(); pedir();
    } else if (gesto?.tipo === 'pan') {
      const [x, y] = posRel(e), dx = x - gesto.x0, dy = y - gesto.y0;
      if (!gesto.moveu && Math.hypot(dx, dy) > 6) { gesto.moveu = true; canvas.classList.add('arrastando'); dica.hidden = true; }
      if (gesto.moveu) { cx = gesto.cx0 - dx / k; cy = gesto.cy0 + dy / k; pedir(); }
    } else if (gesto?.tipo === 'pinca' && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()];
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      k = limitarK(gesto.k0 * Math.hypot(a[0] - b[0], a[1] - b[1]) / gesto.d0);
      cx = gesto.wx - (mx - W / 2) / k; cy = gesto.wy + (my - H / 2) / k;
      pedir();
    }
  });
  function soltar(e) {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    canvas.classList.remove('arrastando');
    if (gesto?.tipo === 'pinca') {
      if (ptrs.size === 1) {   // one finger left: keep panning (or orbiting, with ⟳ on) from here, never a tap
        const [x, y] = [...ptrs.values()][0];
        if (modoGirar && A.posZ[mapa] && t === tAlvo) iniciarGiro(x, y, true);
        else gesto = { tipo: 'pan', x0: x, y0: y, cx0: cx, cy0: cy, t0: 0, moveu: true };
      } else if (ptrs.size === 0) gesto = null;
      return;
    }
    if ((gesto?.tipo === 'pan' || gesto?.tipo === 'girar') && !gesto.moveu && e.type === 'pointerup') tocar(e);
    if (ptrs.size === 0) gesto = null;
  }
  canvas.addEventListener('pointerup', soltar);
  canvas.addEventListener('pointercancel', soltar);
  canvas.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !ptrs.size) { hover = -1; dica.hidden = true; canvas.classList.remove('sobre'); pedir(); } });

  function tocar(e) {
    const [x, y] = posRel(e);
    const toque = e.pointerType !== 'mouse';
    const i = pegar(x, y, toque ? 22 : 10);
    if (i >= 0) { selecionar(i); salvarUrl(true); ultimoToque = null; return; }
    // double tap on empty space zooms in (dblclick doesn't fire reliably with touch-action: none)
    const agora = performance.now();
    if (toque && ultimoToque && agora - ultimoToque.t < 320 && Math.hypot(x - ultimoToque.x, y - ultimoToque.y) < 30) {
      ultimoToque = null;
      const wx = cx + (x - W / 2) / k, wy = cy - (y - H / 2) / k, nk = limitarK(k * 2.2);
      voar(wx - (x - W / 2) / nk, wy + (y - H / 2) / nk, nk);
      return;
    }
    ultimoToque = { t: agora, x, y };
    if (sel >= 0) { fecharCartao(); salvarUrl(true); }
  }
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('dblclick', e => {
    const [x, y] = posRel(e);
    if (pegar(x, y, 10) >= 0) return;
    const wx = cx + (x - W / 2) / k, wy = cy - (y - H / 2) / k, nk = limitarK(k * 2.2);
    voar(wx - (x - W / 2) / nk, wy + (y - H / 2) / nk, nk);
  });

  let pairando = null, pairandoRaf = 0;
  function pairar(e) {
    pairando = posRel(e);
    if (pairandoRaf) return;
    pairandoRaf = requestAnimationFrame(() => {
      pairandoRaf = 0;
      const [x, y] = pairando;
      const i = pegar(x, y, 10);
      canvas.classList.toggle('sobre', i >= 0);
      if (i !== hover) { hover = i; pedir(); }
      if (i >= 0) mostrarDica(i, x, y); else dica.hidden = true;
    });
  }

  canvas.addEventListener('wheel', e => {
    if (!A) return;
    e.preventDefault();
    sumirAjuda();
    const [x, y] = posRel(e);
    const d = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H : 1);
    zoomEm(x, y, Math.exp(-d * (e.ctrlKey ? 0.01 : 0.0018)));
    dica.hidden = true;
  }, { passive: false });

  // ── controls ──
  $('zoom-mais').addEventListener('click', () => voar(cx, cy, k * 1.8));
  $('zoom-menos').addEventListener('click', () => voar(cx, cy, k / 1.8));
  $('zoom-reset').addEventListener('click', () => enquadrarTudo());
  // ⟳: one-finger (or left-button) drag orbits instead of panning — the way to rotate on touch screens
  let modoGirar = false;
  const btnGirar = $('zoom-girar');
  function ligarGiro(on) {
    modoGirar = on;
    btnGirar.setAttribute('aria-pressed', String(on));
  }
  function atualizarBtnGirar() {
    btnGirar.hidden = !A.posZ[mapa];
    if (btnGirar.hidden) ligarGiro(false);
  }
  btnGirar.addEventListener('click', () => ligarGiro(!modoGirar));

  function trocarMapa(m, animar = true) {
    if (m === mapa && t === tAlvo) return;
    mapa = m; tAlvo = m === 'rotulos' ? 1 : 0; tTrans0 = performance.now();
    if (!animar) t = tAlvo;
    hover = -1; dica.hidden = true;
    document.querySelectorAll('[data-mapa]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mapa === m)));
    if (girado()) pivoNoCentro();
    atualizarBtnGirar();
    if (filtro.busca && nAtivo) {
      const b = caixa(mapa, ativo, 0.02, 0.98);
      if (b) enquadrar(b, animar, 0.015, [0, 0]);
    } else enquadrarTudo(animar);
    grafo.redesenhar();
    salvarUrl(true);
    if (!restaurando) som?.tap([0, 7], 0.5);
  }
  document.querySelectorAll('[data-mapa]').forEach(b => b.addEventListener('click', () => trocarMapa(b.dataset.mapa)));

  function trocarAcervo(a) {
    filtro.acervo = a;
    document.querySelectorAll('[data-acervo]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.acervo === a)));
    recalcular();
    grafo.redesenhar();
    salvarUrl(true);
    if (!restaurando) som?.tap([7], 0.5);
  }
  document.querySelectorAll('[data-acervo]').forEach(b => b.addEventListener('click', () => trocarAcervo(b.dataset.acervo)));

  function montarLegenda() {
    const n = new Array(OUTROS + 1).fill(0);
    for (let i = 0; i < N; i++) n[cor[i]]++;
    const itens = [...MACROS.map((m, j) => [j, m[1], m[2]]), [OUTROS, 'Outros', COR_OUTROS]];
    const lista = $('legenda-lista');
    lista.replaceChildren(...itens.map(([j, nome, c]) => {
      const li = document.createElement('li'), b = document.createElement('button'), p = document.createElement('span');
      const rot = document.createElement('span'), num = document.createElement('span');
      b.type = 'button'; b.dataset.genero = j; b.setAttribute('aria-pressed', 'true');
      b.title = 'Clique para esconder; duplo clique para ver só este';
      p.className = 'ponto'; p.style.background = c; p.style.borderColor = c;
      rot.textContent = nome; num.className = 'n'; num.textContent = fmt(n[j]);
      b.append(p, rot, num);
      b.addEventListener('click', () => {
        filtro.off.has(j) ? filtro.off.delete(j) : filtro.off.add(j);
        if (filtro.off.size === itens.length) filtro.off.clear();
        sincronizarLegenda(); recalcular(); salvarUrl(true);
        som?.tap(filtro.off.has(j) ? [0] : [7], 0.5);
      });
      b.addEventListener('dblclick', () => {
        filtro.off = new Set(itens.map(x => x[0]).filter(x => x !== j));
        sincronizarLegenda(); recalcular(); salvarUrl(true);
      });
      li.append(b);
      return li;
    }));
    if (!mobile()) $('legenda').open = true;
  }
  function sincronizarLegenda() {
    document.querySelectorAll('#legenda-lista [data-genero]').forEach(b =>
      b.setAttribute('aria-pressed', String(!filtro.off.has(Number(b.dataset.genero)))));
  }

  let tBusca = 0;
  $('busca').addEventListener('input', e => {
    clearTimeout(tBusca);
    tBusca = setTimeout(() => buscar(e.target.value), 220);
  });
  $('busca').addEventListener('keydown', e => {
    if (e.key === 'Enter') { clearTimeout(tBusca); buscar(e.target.value); salvarUrl(true); if (mobile()) e.target.blur(); }
    if (e.key === 'Escape') { e.target.value = ''; buscar(''); salvarUrl(true); e.target.blur(); }
  });
  $('busca-limpar').addEventListener('click', () => { $('busca').value = ''; buscar(''); salvarUrl(true); $('busca').focus(); });

  document.addEventListener('keydown', e => {
    if (!A || e.target.closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (grafo.aberto && e.key.startsWith('Arrow')) {
      e.preventDefault();
      grafo.girar(e.key === 'ArrowLeft' ? -30 : e.key === 'ArrowRight' ? 30 : 0, e.key === 'ArrowUp' ? -30 : e.key === 'ArrowDown' ? 30 : 0);
      return;
    }
    const passo = 90 / k;
    switch (e.key) {
      case '/': e.preventDefault(); $('busca').focus(); break;
      case 'Escape': if (grafo.aberto) grafo.fechar(); else if (sel >= 0) { fecharCartao(); salvarUrl(true); } break;
      case 'g': case 'G': alternarGrafo(); break;
      case 'm': case 'M': som?.alternar(); break;
      case '+': case '=': voar(cx, cy, k * 1.5); break;
      case '-': case '_': voar(cx, cy, k / 1.5); break;
      case '0': enquadrarTudo(); break;
      case 'ArrowLeft': if (e.target === document.body || e.target === canvas) { cx -= passo; pedir(); } break;
      case 'ArrowRight': if (e.target === document.body || e.target === canvas) { cx += passo; pedir(); } break;
      case 'ArrowUp': if (e.target === document.body || e.target === canvas) { cy += passo; pedir(); } break;
      case 'ArrowDown': if (e.target === document.body || e.target === canvas) { cy -= passo; pedir(); } break;
    }
  });

  let ajudaSumiu = false;
  function sumirAjuda() { if (!ajudaSumiu) { ajudaSumiu = true; $('ajuda').classList.add('some'); } }

  // ── URL state and history: ?mapa=rotulos&acervo=homi&q=…&off=0,3&grafo=1&artista=…&faixa=<acervo>.<hash> ──
  // Each click is a history entry (salvarUrl(true)); typing and passive changes only rewrite the current one.
  // The short delay folds one gesture's several changes into one entry, like leaving the graph, which closes
  // it and then selects the artist's dot.
  let tUrl = 0, novaEntrada = false, restaurando = 0;
  function salvarUrl(nova = false) {
    if (restaurando) return;
    novaEntrada ||= nova;
    clearTimeout(tUrl);
    tUrl = setTimeout(() => {
      const p = new URLSearchParams();
      if (mapa !== 'som') p.set('mapa', mapa);
      if (filtro.acervo !== 'todos') p.set('acervo', filtro.acervo);
      if (filtro.q) p.set('q', filtro.q);
      if (filtro.off.size) p.set('off', [...filtro.off].sort((a, b) => a - b).join(','));
      if (grafo.aberto) {
        p.set('grafo', '1');
        if (grafo.centro) p.set('artista', grafo.centro);
      }
      if (sel >= 0) p.set('faixa', `${A.acervos[A.acervo[sel]]}.${A.hash[sel]}`);
      const qs = p.toString(), alvo = location.pathname + (qs ? '?' + qs : '');
      if (alvo !== location.pathname + location.search) history[novaEntrada ? 'pushState' : 'replaceState'](null, '', alvo);
      novaEntrada = false;
    }, novaEntrada ? 60 : 300);
  }
  async function semHistorico(fn) {
    restaurando++;
    try { await fn(); } finally { restaurando--; }
  }
  const offDaUrl = q => new Set((q.get('off') || '').split(',').filter(Boolean).map(Number));
  function faixaDaUrl(valor) {
    const [ak, h] = valor.split('.'), ai = A.acervos.indexOf(ak);
    for (let i = 0; i < N; i++) if (A.acervo[i] === ai && A.hash[i] === Number(h)) return i;
    return -1;
  }
  function selecaoDaUrl(q) {
    if (!audio.paused) return;       // a playing preview keeps its card
    const f = q.get('faixa'), i = f ? faixaDaUrl(f) : -1;
    if (i >= 0) { if (i !== sel) irParaFaixas([i], Math.max(k, k0 * ZOOM_PONTO)); }
    else if (q.get('album')) irParaAlbum(q.get('de'), q.get('album'));
    else if (sel >= 0) fecharCartao();
  }
  // Back and forward: make the page match the URL again, without writing new entries.
  function aplicarUrl() {
    clearTimeout(tUrl);
    novaEntrada = false;
    const q = new URLSearchParams(location.search);
    return semHistorico(async () => {
      const m = q.get('mapa') === 'rotulos' ? 'rotulos' : 'som';
      if (m !== mapa) trocarMapa(m);
      const a = q.get('acervo') || 'todos';
      if (a !== filtro.acervo) trocarAcervo(ACERVOS[a] ? a : 'todos');
      const off = offDaUrl(q);
      if ([...off].sort().join() !== [...filtro.off].sort().join()) { filtro.off = off; sincronizarLegenda(); recalcular(); }
      const busca = q.get('q') || '';
      if (busca !== filtro.q) { $('busca').value = busca; buscar(busca); }
      if (q.get('grafo')) await grafo.abrir(q.get('artista'));
      else if (grafo.aberto) grafo.fechar(false);
      if (ligado) selecaoDaUrl(q);
    });
  }

  // ── graph ──
  const grafo = criarGrafoAtlas({
    raiz: APP_ROOT, fetchJsonGz,
    mapa: () => mapa,
    acervo: () => filtro.acervo,
    corDe: g => MACROS.find(m => m[0] === macroDe(g))?.[2] || COR_OUTROS,
    rotuloGenero: g => `${subDe(g)} · ${nomeMacro(macroDe(g))}`,
    capasDe,
    albunsDe,
    urlArtista,
    avisar: texto => { $('contagem').textContent = texto; },
    aoMudar: () => { atualizarContagem(); salvarUrl(true); if (grafo.centro) som?.momento([0, 7], 0.4); },
    aoSair: irParaArtista,
  });
  // An artist or album has no point of its own: its tracks sit in the same region of the map, so the most
  // central one (the medoid) stands in for it. Center on it, a little zoomed in, and select it.
  function irParaFaixas(lista, zoom = k0 * ZOOM_PONTO) {
    if (!lista.length) return false;
    let mx = 0, my = 0;
    for (const i of lista) { mx += mundoX(i); my += mundoY(i); }
    mx /= lista.length; my /= lista.length;
    let melhor = lista[0], menor = Infinity;
    for (const i of lista) {
      const d = (mundoX(i) - mx) ** 2 + (mundoY(i) - my) ** 2;
      if (d < menor) { menor = d; melhor = i; }
    }
    voar(mundoX(melhor), mundoY(melhor), zoom);
    if (audio.paused) selecionar(melhor);     // selecting stops the preview: its track stays the selection
    return true;
  }
  // The player's .album-atlas link: ?de=<acervo>&album=<path>.
  function irParaAlbum(ak, path) {
    const ai = A.acervos.indexOf(ak), bi = cat[ak]?.db.albums.findIndex(a => a.path === path) ?? -1;
    const dele = [];
    if (bi >= 0) for (let i = 0; i < N; i++) if (A.acervo[i] === ai && ptAlb[i] === bi) dele.push(i);
    if (!irParaFaixas(dele)) $('contagem').textContent = 'Álbum fora do mapa';
  }
  function irParaArtista(nome) {
    if (!ligado) return;
    const c = chaveArtista(nome), porTexto = new Map(), dele = [];
    for (let i = 0; i < N; i++) {
      if (ptAlb[i] < 0 || !ativo[i]) continue;
      const artista = infoDe(i).artista;
      if (!porTexto.has(artista)) porTexto.set(artista, parseArtists(artista).some(a => chaveArtista(a) === c));
      if (porTexto.get(artista)) dele.push(i);
    }
    irParaFaixas(dele);
  }
  // A playing preview goes on over the graph, with its card still there to stop it.
  function abrirGrafo(nome) {
    if (audio.paused) fecharCartao();
    grafo.abrir(nome);
    som?.momento();
  }
  function alternarGrafo() {
    if (grafo.aberto) {             // the toggle goes back to the whole map; Esc goes to the artist's dot
      grafo.fechar(false);
      if (audio.paused) fecharCartao();
      enquadrarTudo();
      return;
    }
    const info = sel >= 0 ? infoDe(sel) : null;
    abrirGrafo(info ? parseArtists(info.artista)[0] : null);
  }
  $('btn-grafo').addEventListener('click', alternarGrafo);

  // ── music ──
  let som = null;
  function iniciarSom() {
    som = criarSomAtlas({
      generos: A.generos, regiao: regiaoSom, mira: miraSom, previa: audio, pararPrevia, botao: $('btn-musica'),
      aoPrimeiroSom: () => { carregarFeaturesSom().catch(err => console.warn('[atlas] sem features para a música', err)); },
    });
  }

  // ── size ──
  function medir() {
    const r = canvas.getBoundingClientRect();
    topoBaixo = $('topo').getBoundingClientRect().bottom + 8;
    const novoW = Math.max(1, r.width), novoH = Math.max(1, r.height);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const primeiro = W === 1 && H === 1;
    W = novoW; H = novoH;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    if (A && gl) { if (primeiro) enquadrarTudo(false); else pedir(); }
  }

  // ── boot ──
  async function iniciar() {
    const status = $('carregando-status');
    const params = new URLSearchParams(location.search);
    let payload;
    if (typeof DecompressionStream === 'undefined') { status.textContent = 'Este navegador é antigo demais para o mapa.'; return; }
    try { payload = await carregarPayload(); preparar(payload); }
    catch (err) {
      console.error('[atlas]', err);
      status.textContent = 'Não foi possível carregar o mapa.';
      return;
    }
    try { if (!iniciarGL()) { status.textContent = 'Este navegador não tem WebGL, que o mapa precisa.'; return; } }
    catch (err) { console.error('[atlas]', err); status.textContent = 'Erro ao iniciar o WebGL.'; return; }
    canvas.addEventListener('webglcontextlost', e => e.preventDefault());
    canvas.addEventListener('webglcontextrestored', () => { iniciarGL(); enviarAtivo(); pedir(); });

    iniciarSom();
    montarLegenda();
    if (params.get('mapa') === 'rotulos') { mapa = 'rotulos'; t = tAlvo = 1; document.querySelectorAll('[data-mapa]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mapa === 'rotulos'))); }
    atualizarBtnGirar();
    const pa = params.get('acervo');
    if (pa && ACERVOS[pa]) trocarAcervo(pa);
    filtro.q = params.get('q') || '';
    filtro.off = offDaUrl(params);
    sincronizarLegenda();
    W = H = 1;
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(canvas);
    ro.observe($('topo'));          // the bar wraps when its count text grows, not only with the window
    atualizarContagem();
    if (params.get('grafo')) semHistorico(() => grafo.abrir(params.get('artista')));
    window.addEventListener('popstate', aplicarUrl);
    $('carregando').classList.add('pronto');
    setTimeout(() => $('carregando').hidden = true, 600);
    setTimeout(sumirAjuda, 8000);
    pronto.ligar(carregarCatalogos().catch(err => { console.error('[atlas]', err); $('contagem').textContent = 'catálogos indisponíveis'; }));
  }

  // Test hook (tests/atlas.spec.js): wait for the catalogs, find a track's point, get its screen spot.
  const pronto = {};
  const prontoP = new Promise(res => { pronto.ligar = p => Promise.resolve(p).then(res); });
  window.__atlas = {
    pronto: prontoP,
    ponto(acervo, albumPath, file) {
      const ai = A.acervos.indexOf(acervo), h = atlasKeyHash(`${albumPath}/${file}`.normalize('NFC'));
      for (let i = 0; i < N; i++) if (A.acervo[i] === ai && A.hash[i] === h) return i;
      return -1;
    },
    tela(i) { return { x: telaX(mundoX(i)), y: telaY(mundoY(i)) }; },
    focar(i, zoom = 40) { voar(mundoX(i), mundoY(i), k0 * zoom, false); },
    estado() { return { k, k0, cx, cy, mapa, t, nAtivo, n: N, sel, yaw, pitch, tem3d: !!A.posZ[mapa], girar: modoGirar }; },
    grafo: () => grafo.estado(),
    grafoTudo: nome => grafo.noTudo(nome),
    som: () => som && { ...som.estado(), features: feats.filter(Boolean).length },
  };

  iniciar();
})();
