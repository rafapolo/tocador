// atlas-grafo.js — the "Grafo" view of /atlas: artists as nodes, linked to the ones they sound like (map
// "som") or share genres with (map "rotulos"). Payload: data/atlas-artistas.json.gz, built by
// script/build-artistas-parecidos.py and fetched on first use. Classic script, loaded after atlas-data.js
// and before atlas.js. Names come from the catalogs, so they only reach the page via textContent/setAttribute.
(function (global) {
  'use strict';

  const PAYLOAD = 'data/atlas-artistas.json.gz';
  const SVG = 'http://www.w3.org/2000/svg';
  const LIMITE_GERAL = 120;   // nodes in the overview without a precomputed layout, on a screen big enough for them
  const AREA_POR_NO = 11000;  // px² each overview node needs for its label to stay readable
  const SEMENTES = 3;         // overview: top artists per macro-genre it starts from
  const VIZ_FORA = 3;         // neighbours followed from each direct neighbour of the center
  const RANK_FORA = 4;        // links drawn between nodes that aren't the center
  const DURACAO = 650;        // ms of a walk from one artist to the next
  // By distance from the center: itself, direct neighbours, the rest. Labels fade less than dots (TEXTO_MIN).
  const OPACIDADE_NO = [1, 0.72, 0.42];
  const OPACIDADE_ARESTA = [0.45, 0.4, 0.24];
  const OPACIDADE_FORTE = 0.8;
  const TEXTO_MIN = 0.4;
  // Overview with every artist, drawn on a canvas.
  const LIGACOES_TUDO = 3;     // nearest neighbours each artist is linked to
  const ROTULOS_TUDO = 220;    // names on screen at most, biggest artists first
  const ZOOM_TUDO = 16;        // the whole catalog needs more zoom than a neighbourhood (6)
  const CELULA = [16, 15];     // px of the grid that keeps those names from overlapping
  const DISTANCIA = 700;       // px from the viewer: how strong the perspective is
  const GIRO_PX = 0.008;       // radians per px dragged
  const suave = p => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
  const fmt = n => n.toLocaleString('pt-BR');

  function criarGrafoAtlas({ raiz, fetchJsonGz, mapa, acervo, corDe, rotuloGenero, capasDe, urlArtista, aoMudar, aoSair, avisar }) {
    const $ = id => document.getElementById(id);
    const camada = $('grafo'), svg = $('grafo-svg'), mundo = $('grafo-mundo');
    const gArestas = $('grafo-arestas'), gNos = $('grafo-nos'), btn = $('btn-grafo');
    const tela = $('grafo-tudo'), pincel = tela.getContext('2d');
    const reduzMovimento = matchMedia('(prefers-reduced-motion: reduce)').matches;

    let D = null, carregando = null;
    let aberto = false, centro = -1;     // centro: artist index, -1 = overview
    let nos = [], arestas = [];
    let aviso = '';                      // shown instead of the count until the view changes
    const elNo = new Map();              // artist index -> <g>
    const cena = new Map();              // artist index -> what is drawn now: { x, y, z, r, o, v } (v = fading in/out)
    const linhas = new Map();            // link key -> { el, a, b, o }
    let transicao = null, quadro = 0;    // the walk in progress and its animation frame
    let larguraFeita = 0, alturaFeita = 0, reservaFeita = 0;
    let vista = { x: 0, y: 0, k: 1 };
    let capasFeitas = '';                // whose covers are in the panel
    let yaw = 0, pitch = 0;              // rotation of the scene around `piv`; 0, 0 is the flat front view
    let piv = null, pivAlvo = { x: 0, y: 0 };
    let T = null;                        // the overview: see filtrarTudo() and montarTudo()
    let quente = -1, pintura = 0;        // artist under the mouse, pending paint

    function carregar() {
      carregando ??= (async () => {
        try { D = decodeArtistas(await fetchJsonGz(raiz + PAYLOAD)); }
        catch { D = decodeArtistas(await fetchJsonGz('https://tocador.cc/' + PAYLOAD)); }   // mirrors don't copy data/
      })().catch(err => { carregando = null; throw err; });
      return carregando;
    }

    const viz = (i, m = mapa()) => D.viz[m].subarray(i * D.k, (i + 1) * D.k);
    const indice = nome => (nome && D.indice.get(chaveArtista(nome))) ?? -1;
    // With a precomputed layout the overview shows everybody; without one (an older payload) it falls back to a
    // selection of artists in the SVG, since the force layout below is quadratic.
    const emTudo = () => centro < 0 && !!D?.pos[mapa()];

    // ── which nodes and links ──
    function escolherEgo(c) {
      const s = new Set([c]);
      const diretos = viz(c);
      for (const v of diretos) s.add(v);
      for (const v of diretos) for (const w of viz(v).subarray(0, VIZ_FORA)) s.add(w);
      return [...s];
    }

    // Top artists of each macro-genre, widened through their neighbours: the plain top-N would be all samba
    // (nomes is sorted by track count, and uqt has most of the tracks), and few of its links would land inside it.
    function escolherGeral() {
      const a = acervo(), ai = D.acervos.indexOf(a);
      const limite = Math.max(24, Math.min(LIMITE_GERAL, Math.round(camada.clientWidth * camada.clientHeight / AREA_POR_NO)));
      const sementes = limite < 60 ? 1 : SEMENTES;
      const passa = i => a === 'todos' || D.acervo[i] === ai;
      const porMacro = new Map();
      for (let i = 0; i < D.n; i++) {
        if (!passa(i)) continue;
        const m = D.generos[D.genero[i]].split('---')[0];
        const l = porMacro.get(m) || porMacro.set(m, []).get(m);
        if (l.length < sementes) l.push(i);
      }
      const s = new Set([...porMacro.values()].flat().slice(0, limite));
      const fila = [...s];
      for (let f = 0; f < fila.length && s.size < limite; f++) {
        for (const w of viz(fila[f]).subarray(0, VIZ_FORA)) {
          if (s.size < limite && passa(w) && !s.has(w)) { s.add(w); fila.push(w); }
        }
      }
      return [...s];
    }

    function ligar(lista, c) {
      const dentro = new Set(lista), vistas = new Set(), out = [];
      for (const a of lista) {
        viz(a).forEach((b, rank) => {
          if (!dentro.has(b) || (a !== c && b !== c && rank >= RANK_FORA)) return;
          const chave = a < b ? a * D.n + b : b * D.n + a;
          if (vistas.has(chave)) return;
          vistas.add(chave);
          out.push({ a, b, forte: a === c || b === c });
        });
      }
      return out;
    }

    // Height at the bottom taken by the panel and, while a preview plays over the graph, by the card.
    function reservaBaixo() {
      const cartao = $('cartao');
      const topo = Math.min($('grafo-painel').getBoundingClientRect().top, cartao.hidden ? Infinity : cartao.getBoundingClientRect().top);
      return camada.clientHeight - topo + 12;
    }
    const chaveLinha = (a, b) => (a < b ? a * D.n + b : b * D.n + a);
    function nivelDe(lista) {
      const diretos = new Set(centro >= 0 ? viz(centro) : []);
      return new Map(lista.map(i => [i, centro < 0 || i === centro ? 0 : diretos.has(i) ? 1 : 2]));
    }

    // ── layout: run once. Nodes already on screen start where they are, so a step keeps the scene's shape;
    // with nothing drawn yet, the same artist always gives the same picture. ──
    const raio = i => (i === centro ? 13 : Math.min(15, 3.5 + Math.sqrt(D.faixas[i]) * 0.5));
    const larguraRotulo = i => D.nomes[i].length * 6.3 + 8;

    // The part of the screen free for the graph.
    function areaLivre() {
      const W = camada.clientWidth, H = camada.clientHeight;
      const topo = $('controles').getBoundingClientRect().bottom + 16;
      const area = { l: 16, r: W - 16, t: topo, b: H - reservaBaixo() };
      const aw = Math.max(120, area.r - area.l), ah = Math.max(120, area.b - area.t);
      const meioX = area.l + aw / 2, meioY = area.t + ah / 2;
      pivAlvo = { x: meioX, y: meioY };
      return { area, aw, ah, meioX, meioY };
    }

    function calcular(lista, ligs, semente = new Map()) {
      const n = lista.length, pos = new Map(lista.map((v, j) => [v, j]));
      const x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n);
      const { area, aw, ah, meioX, meioY } = areaLivre();
      const L = Math.sqrt(aw * ah / Math.max(n, 1)) * 1.1;
      const [refX, refY] = semente.get(centro) || [meioX, meioY];
      lista.forEach((v, j) => {
        const r = 14 * Math.sqrt(j + 1), g = j * 2.39996, s = semente.get(v);
        x[j] = s ? s[0] - refX : r * Math.cos(g);
        y[j] = s ? s[1] - refY : r * Math.sin(g);
        z[j] = s ? s[2] : r * Math.sin(g * 1.7) * 0.6;
      });
      const fixo = lista.indexOf(centro);
      const pares = ligs.map(e => [pos.get(e.a), pos.get(e.b)]);
      const passos = 320, gravidade = 0.02;
      for (let p = 0; p < passos; p++) {
        const teto = 40 * (1 - p / passos) + 1;
        const fx = new Float64Array(n), fy = new Float64Array(n), fz = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            const dx = x[i] - x[j], dy = y[i] - y[j], dz = z[i] - z[j], d2 = Math.max(dx * dx + dy * dy + dz * dz, 1);
            const f = L * L * 0.5 / d2;
            fx[i] += dx * f; fy[i] += dy * f; fz[i] += dz * f; fx[j] -= dx * f; fy[j] -= dy * f; fz[j] -= dz * f;
          }
        }
        for (const [i, j] of pares) {
          const dx = x[j] - x[i], dy = y[j] - y[i], dz = z[j] - z[i], d = Math.hypot(dx, dy, dz) || 1, f = (d - L) * 0.12 / d;
          fx[i] += dx * f; fy[i] += dy * f; fz[i] += dz * f; fx[j] -= dx * f; fy[j] -= dy * f; fz[j] -= dz * f;
        }
        for (let i = 0; i < n; i++) {
          x[i] += Math.max(-teto, Math.min(teto, fx[i] - x[i] * gravidade));
          y[i] += Math.max(-teto, Math.min(teto, fy[i] - y[i] * gravidade * (aw / ah)));
          z[i] += Math.max(-teto, Math.min(teto, fz[i] - z[i] * gravidade));
        }
        if (fixo >= 0) { x[fixo] = 0; y[fixo] = 0; z[fixo] = 0; }
      }
      // Depth on the screen's scale: about as deep as the smaller side, around the center.
      const zMeio = fixo >= 0 ? 0 : z.reduce((a, b) => a + b, 0) / Math.max(n, 1);
      let zMax = 1;
      for (let i = 0; i < n; i++) { z[i] -= zMeio; zMax = Math.max(zMax, Math.abs(z[i])); }
      for (let i = 0; i < n; i++) z[i] *= Math.min(aw, ah) * 0.3 / zMax;
      // Fit the viewport, leaving room for the label to the right of the rightmost node.
      const folga = Math.min(110, aw * 0.22);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < n; i++) { x0 = Math.min(x0, x[i]); x1 = Math.max(x1, x[i]); y0 = Math.min(y0, y[i]); y1 = Math.max(y1, y[i]); }
      if (fixo >= 0) {
        // Each side of the center fits on its own, so the center stays exactly in the middle of the area.
        const esq = (aw / 2 - 12) / Math.max(-x0, 1), dir = Math.max(aw / 2 - folga - 12, 20) / Math.max(x1, 1);
        const cima = (ah / 2 - 12) / Math.max(-y0, 1), baixo = (ah / 2 - 12) / Math.max(y1, 1);
        const se = Math.min(esq, 2.5 * dir), sd = Math.min(dir, 2.5 * esq);    // a lopsided graph isn't stretched
        const sc = Math.min(cima, 2.5 * baixo), sb = Math.min(baixo, 2.5 * cima);
        for (let i = 0; i < n; i++) {
          x[i] = meioX + x[i] * (x[i] < 0 ? se : sd);
          y[i] = meioY + y[i] * (y[i] < 0 ? sc : sb);
        }
      } else {
        const sx = (aw - folga - 24) / Math.max(x1 - x0, 1), sy = (ah - 24) / Math.max(y1 - y0, 1);
        for (let i = 0; i < n; i++) {
          x[i] = area.l + 12 + (x[i] - x0) * sx;
          y[i] = area.t + 12 + (y[i] - y0) * sy;
        }
      }
      // Push overlapping labels apart, mostly vertically: a label is much wider than it is tall.
      for (let p = 0; p < 40; p++) {
        let mexeu = false;
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            const wa = lista[i], wb = lista[j];
            const sobreX = Math.min(x[i] + larguraRotulo(wa), x[j] + larguraRotulo(wb)) - Math.max(x[i] - raio(wa), x[j] - raio(wb));
            const sobreY = 17 - Math.abs(y[i] - y[j]);
            if (sobreX <= 0 || sobreY <= 0) continue;
            const s = y[i] <= y[j] ? -1 : 1, d = sobreY / 2 + 0.5;
            y[i] += s * d; y[j] -= s * d;
            mexeu = true;
          }
        }
        if (!mexeu) break;
      }
      // That can spill past the edges: squeeze back rather than clamp, which would pile nodes on the border.
      if (fixo >= 0) {
        const d = meioY - y[fixo];
        let acima = 0, abaixo = 0;
        for (let i = 0; i < n; i++) { y[i] += d; acima = Math.max(acima, meioY - y[i]); abaixo = Math.max(abaixo, y[i] - meioY); }
        const sa = Math.min(1, (ah / 2 - 12) / Math.max(acima, 1)), sb = Math.min(1, (ah / 2 - 12) / Math.max(abaixo, 1));
        for (let i = 0; i < n; i++) y[i] = meioY + (y[i] - meioY) * (y[i] < meioY ? sa : sb);
      } else {
        let t0 = Infinity, t1 = -Infinity;
        for (let i = 0; i < n; i++) { t0 = Math.min(t0, y[i]); t1 = Math.max(t1, y[i]); }
        const sq = Math.min(1, (ah - 24) / Math.max(t1 - t0, 1));
        for (let i = 0; i < n; i++) y[i] = area.t + 12 + (y[i] - t0) * sq;
      }
      return new Map(lista.map((v, j) => [v, [x[j], y[j], z[j]]]));
    }

    // ── overview: every artist. The SVG holds a neighbourhood, not thousands of nodes and links rewritten per frame:
    // a canvas draws them all, at the positions build-artistas-parecidos.py computed. ──
    const raioTudo = i => 1.5 + Math.sqrt(D.faixas[i]) * 0.2;

    // Who is on screen under the acervo filter. `lista` keeps nomes' order (most tracks first): that's the name priority.
    function filtrarTudo() {
      const a = acervo(), ai = D.acervos.indexOf(a), dentro = new Uint8Array(D.n), lista = [], porCor = new Map(), pares = [];
      for (let i = 0; i < D.n; i++) {
        if (a !== 'todos' && D.acervo[i] !== ai) continue;
        dentro[i] = 1;
        lista.push(i);
        const cor = corDe(D.generos[D.genero[i]]);
        (porCor.get(cor) || porCor.set(cor, []).get(cor)).push(i);
      }
      const vistas = new Set();
      for (const i of lista) {
        for (const v of viz(i).subarray(0, LIGACOES_TUDO)) {
          const c = chaveLinha(i, v);
          if (dentro[v] && !vistas.has(c)) { vistas.add(c); pares.push([i, v]); }
        }
      }
      T = { dentro, lista, porCor: [...porCor], x: T?.x, y: T?.y, z: T?.z, sx: T?.sx, sy: T?.sy, sr: T?.sr };
      nos = lista; arestas = pares;
    }

    function montarTudo() {
      const { area, aw, ah } = areaLivre(), P = D.pos[mapa()], n = D.n;
      for (const c of ['x', 'y', 'z', 'sx', 'sy', 'sr']) T[c] ??= new Float32Array(n);
      const folga = Math.min(70, aw * 0.12), profundo = Math.min(aw, ah) * 0.45;
      for (let i = 0; i < n; i++) {
        T.x[i] = area.l + 12 + (P[3 * i] / 32767 + 1) / 2 * (aw - folga - 24);
        T.y[i] = area.t + 12 + (P[3 * i + 1] / 32767 + 1) / 2 * (ah - 24);
        T.z[i] = P[3 * i + 2] / 32767 * profundo;
      }
      const dpr = Math.min(devicePixelRatio || 1, 2);
      tela.width = camada.clientWidth * dpr;
      tela.height = camada.clientHeight * dpr;
      T.dpr = dpr;
      T.css = getComputedStyle(tela);
    }

    function pedirPintura() { pintura ||= requestAnimationFrame(pintarTudo); }

    function pintarTudo() {
      pintura = 0;
      if (!T?.x) return;
      const { lista, porCor, x, y, z, sx, sy, sr, dentro, dpr, css } = T;
      const W = tela.width / dpr, H = tela.height / dpr, ponto = {}, cam = camera(), k = vista.k, rk = Math.sqrt(k);
      for (const i of lista) {
        cam(x[i], y[i], z[i], ponto);
        sx[i] = ponto.x * k + vista.x;
        sy[i] = ponto.y * k + vista.y;
        sr[i] = raioTudo(i) * ponto.f * rk;
      }
      const cor = n => css.getPropertyValue(n);
      pincel.setTransform(dpr, 0, 0, dpr, 0, 0);
      pincel.clearRect(0, 0, W, H);

      pincel.beginPath();
      for (const [a, b] of arestas) { pincel.moveTo(sx[a], sy[a]); pincel.lineTo(sx[b], sy[b]); }
      pincel.strokeStyle = cor('--text-3');
      pincel.globalAlpha = quente >= 0 ? 0.08 : 0.16;
      pincel.lineWidth = 0.6;
      pincel.stroke();

      pincel.globalAlpha = 0.9;
      for (const [c, membros] of porCor) {
        pincel.beginPath();
        for (const i of membros) {
          if (sx[i] < -9 || sy[i] < -9 || sx[i] > W + 9 || sy[i] > H + 9) continue;
          pincel.moveTo(sx[i] + sr[i], sy[i]);
          pincel.arc(sx[i], sy[i], sr[i], 0, 6.2832);
        }
        pincel.fillStyle = c;
        pincel.fill();
      }
      pincel.globalAlpha = 1;

      // Names: the biggest artists that fit, so more of them come out as the zoom opens room.
      const colunas = Math.ceil(W / CELULA[0]) + 1, livres = new Uint8Array(colunas * (Math.ceil(H / CELULA[1]) + 2));
      const reservar = (px, py, largura) => {
        const c0 = Math.max(0, Math.floor(px / CELULA[0])), c1 = Math.min(colunas - 1, Math.floor((px + largura) / CELULA[0]));
        const l0 = Math.max(0, Math.floor((py - 7) / CELULA[1])), l1 = Math.floor((py + 7) / CELULA[1]);
        for (let l = l0; l <= l1; l++) for (let c = c0; c <= c1; c++) if (livres[l * colunas + c]) return false;
        for (let l = l0; l <= l1; l++) for (let c = c0; c <= c1; c++) livres[l * colunas + c] = 1;
        return true;
      };
      const escrever = (i, destaque) => {
        const px = sx[i] + sr[i] + 4;
        pincel.font = `${destaque ? 600 : 400} ${destaque ? 13 : 11.5}px ${css.fontFamily}`;
        pincel.fillStyle = destaque ? cor('--text') : cor('--text-2');
        pincel.strokeText(D.nomes[i], px, sy[i]);
        pincel.fillText(D.nomes[i], px, sy[i]);
      };
      pincel.lineJoin = 'round';
      pincel.lineWidth = 3;
      pincel.strokeStyle = cor('--bg');
      pincel.textBaseline = 'middle';
      if (quente >= 0) {
        const perto = [...viz(quente)].filter(v => dentro[v]);
        pincel.beginPath();
        for (const v of perto) { pincel.moveTo(sx[quente], sy[quente]); pincel.lineTo(sx[v], sy[v]); }
        pincel.strokeStyle = cor('--accent');
        pincel.lineWidth = 1.2;
        pincel.stroke();
        pincel.lineWidth = 3;
        pincel.strokeStyle = cor('--bg');
        reservar(sx[quente] + sr[quente] + 4, sy[quente], larguraRotulo(quente) * 1.15);
        escrever(quente, true);
        for (const i of perto) if (reservar(sx[i] + sr[i] + 4, sy[i], larguraRotulo(i))) escrever(i, false);
      }
      let escritos = 0;
      for (const i of lista) {
        if (escritos >= ROTULOS_TUDO) break;
        if (quente >= 0 || sx[i] < 0 || sy[i] < 8 || sx[i] > W || sy[i] > H - 8) continue;
        if (!reservar(sx[i] + sr[i] + 4, sy[i], larguraRotulo(i))) continue;
        escrever(i, false);
        escritos++;
      }
    }

    function pertoDe(px, py, folga) {
      let melhor = -1, d2 = Infinity;
      for (const i of T.lista) {
        const dx = T.sx[i] - px, dy = T.sy[i] - py, d = dx * dx + dy * dy, r = T.sr[i] + folga;
        if (d <= r * r && d < d2) { d2 = d; melhor = i; }
      }
      return melhor;
    }

    // ── drawing ──
    function novoNo(i) {
      const g = document.createElementNS(SVG, 'g');
      const c = document.createElementNS(SVG, 'circle'), t = document.createElementNS(SVG, 'text');
      g.setAttribute('class', 'grafo-no');
      g.setAttribute('role', 'button');
      g.setAttribute('tabindex', '0');
      g.setAttribute('aria-label', `${D.nomes[i]}: ver artistas parecidos`);
      c.setAttribute('fill', corDe(D.generos[D.genero[i]]));
      t.textContent = D.nomes[i];
      g.append(c, t);
      g.dataset.i = i;
      return g;
    }

    // A step of the walk: what is drawn now (cena, linhas) eases towards the new layout in one loop, so nodes
    // and links move together and the clicked dot reaches the center as the scene becomes its perspective.
    function desenhar(animar = true, origem = -1) {
      parar();
      const tudo = emTudo(), deTudo = !tudo && tela.classList.contains('ligada');
      const lista = tudo ? [] : centro >= 0 ? escolherEgo(centro) : escolherGeral();
      const ligs = tudo ? [] : ligar(lista, centro);
      quente = -1;
      svg.style.cursor = '';
      if (tudo) filtrarTudo();
      else { nos = lista; arestas = ligs; }
      desenharPainel();                      // first: the layout measures the panel
      if (tudo) montarTudo();
      tela.classList.toggle('ligada', tudo);
      larguraFeita = camada.clientWidth; alturaFeita = camada.clientHeight; reservaFeita = reservaBaixo();
      const semente = new Map();
      for (const i of lista) { const c = cena.get(i); if (c?.v > 0) semente.set(i, [c.x, c.y, c.z]); }
      const pos = tudo ? new Map() : calcular(lista, ligs, semente);
      const niveis = nivelDe(lista);

      // Whatever leaves goes along with the camera, instead of staying behind as the scene moves.
      piv ??= pivAlvo;
      const antes = cena.get(centro), [nx, ny] = antes ? pos.get(centro) : [0, 0];
      const dx = antes ? nx - antes.x : 0, dy = antes ? ny - antes.y : 0;
      const nasce = cena.get(origem);
      const alvos = new Map();
      for (const i of lista) {
        const [x, y, z] = pos.get(i), o = OPACIDADE_NO[niveis.get(i)], r = raio(i);
        alvos.set(i, { x, y, z, r, o, v: 1 });
        if (!cena.has(i)) {
          elNo.set(i, novoNo(i));
          gNos.append(elNo.get(i));
          // Out of the overview, each node rises from its own dot.
          cena.set(i, deTudo ? { x: T.x[i], y: T.y[i], z: T.z[i], r, o, v: 0 }
            : { x: nasce ? nasce.x : x, y: nasce ? nasce.y : y, z: nasce ? nasce.z : z, r, o, v: 0 });
        }
      }
      for (const [i, c] of cena) {
        if (alvos.has(i)) continue;
        alvos.set(i, tudo ? { x: T.x[i], y: T.y[i], z: T.z[i], r: c.r, o: c.o, v: 0 } : { x: c.x + dx, y: c.y + dy, z: c.z, r: c.r, o: c.o, v: 0 });
      }
      for (const [i, el] of elNo) {
        const fica = pos.has(i);
        el.classList.toggle('centro', i === centro);
        el.classList.toggle('saindo', !fica);
        el.setAttribute('tabindex', fica ? '0' : '-1');
        if (fica) el.dataset.nivel = niveis.get(i);
      }

      const alvosLinha = new Map();
      for (const e of ligs) {
        const k = chaveLinha(e.a, e.b);
        if (!linhas.has(k)) {
          const el = document.createElementNS(SVG, 'line');
          el.dataset.a = e.a; el.dataset.b = e.b;
          gArestas.append(el);
          linhas.set(k, { el, a: e.a, b: e.b, o: 0 });
        }
        linhas.get(k).el.setAttribute('class', e.forte ? 'forte' : '');
        alvosLinha.set(k, e.forte ? OPACIDADE_FORTE : OPACIDADE_ARESTA[Math.max(niveis.get(e.a), niveis.get(e.b))]);
      }
      for (const k of linhas.keys()) if (!alvosLinha.has(k)) alvosLinha.set(k, 0);

      transicao = {
        alvos, alvosLinha,
        de: new Map([...cena].map(([i, c]) => [i, { ...c }])),
        deLinha: new Map([...linhas].map(([k, l]) => [k, l.o])),
        vista: { ...vista }, piv: { ...piv },
      };
      if (!animar || reduzMovimento) { encerrar(); return; }
      const t0 = performance.now();
      const passo = agora => {
        const p = Math.min(1, (agora - t0) / DURACAO);
        if (p >= 1) { encerrar(); return; }
        aplicar(suave(p));
        quadro = requestAnimationFrame(passo);
      };
      quadro = requestAnimationFrame(passo);
    }

    const entre = (a, b, p) => a + (b - a) * p;
    function aplicar(p) {
      const { alvos, alvosLinha, de, deLinha, vista: v0, piv: p0 } = transicao;
      for (const [i, c] of cena) {
        const a = de.get(i), b = alvos.get(i);
        c.x = entre(a.x, b.x, p); c.y = entre(a.y, b.y, p); c.z = entre(a.z, b.z, p); c.r = entre(a.r, b.r, p);
        c.o = entre(a.o, b.o, p); c.v = entre(a.v, b.v, p);
      }
      for (const [k, l] of linhas) {
        l.o = entre(deLinha.get(k), alvosLinha.get(k), p);
        l.el.style.setProperty('--o', l.o);
      }
      piv = { x: entre(p0.x, pivAlvo.x, p), y: entre(p0.y, pivAlvo.y, p) };
      vista = { x: entre(v0.x, 0, p), y: entre(v0.y, 0, p), k: entre(v0.k, 1, p) };
      aplicarVista();
      projetar();
    }
    // World to screen. The front view is the plain layout: the perspective fades in with the first degrees of
    // rotation, so the labels placed for that view stay put until the scene is actually turned.
    function camera() {
      const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      const peso = Math.min(1, (Math.abs(yaw) + Math.abs(pitch)) / 0.25), { x: px, y: py } = piv;
      return (x, y, z, s) => {
        const X = x - px, Y = y - py;
        const x1 = X * cy + z * sy, z1 = z * cy - X * sy;
        const y2 = Y * cp - z1 * sp, z2 = z1 * cp + Y * sp;
        s.f = Math.max(0.55, Math.min(1.6, 1 + peso * z2 / DISTANCIA));
        s.longe = Math.max(0.35, Math.min(1, 1 + peso * z2 / (DISTANCIA * 0.5)));   // the far side dims
        s.x = px + x1 * s.f; s.y = py + y2 * s.f;
      };
    }
    function projetar() {
      const cam = camera(), p = {};
      for (const [i, c] of cena) {
        cam(c.x, c.y, c.z, p);
        const { f, longe } = p;
        c.sx = p.x; c.sy = p.y;
        const el = elNo.get(i), r = c.r * f;
        el.setAttribute('transform', `translate(${c.sx} ${c.sy})`);
        el.firstChild.setAttribute('r', r);
        el.lastChild.setAttribute('x', r + 4);
        el.lastChild.setAttribute('y', 4);
        el.style.setProperty('--o', c.o * c.v * longe);
        el.style.setProperty('--t', (TEXTO_MIN + (1 - TEXTO_MIN) * c.o) * c.v * longe);   // labels stay readable far from the center
      }
      for (const l of linhas.values()) {
        const a = cena.get(l.a), b = cena.get(l.b);
        l.el.setAttribute('x1', a.sx); l.el.setAttribute('y1', a.sy);
        l.el.setAttribute('x2', b.sx); l.el.setAttribute('y2', b.sy);
      }
      if (emTudo() || transicao) pedirPintura();
    }
    function girar(dx, dy) {
      yaw += dx * GIRO_PX;
      pitch = Math.max(-1.4, Math.min(1.4, pitch + dy * GIRO_PX));
      if (!transicao) projetar();          // a walk in progress projects on its next frame
    }
    // Stops a walk where it is; the next one starts from there.
    function parar() {
      cancelAnimationFrame(quadro);
      transicao = null;
    }
    function encerrar() {
      if (!transicao) return;
      aplicar(1);
      for (const [k, o] of transicao.alvosLinha) if (!o) { linhas.get(k).el.remove(); linhas.delete(k); }
      for (const [i, a] of transicao.alvos) if (!a.v) { elNo.get(i).remove(); elNo.delete(i); cena.delete(i); }
      parar();
    }

    function desenharPainel() {
      const base = mapa() === 'rotulos' ? 'pelos rótulos de gênero' : 'pelo som das faixas';
      const nome = centro >= 0 ? D.nomes[centro] : null;
      $('grafo-titulo').textContent = nome ?? 'Artistas parecidos';
      $('grafo-genero').hidden = !nome;
      if (nome) {
        const g = D.generos[D.genero[centro]];
        $('grafo-genero').querySelector('.ponto').style.background = corDe(g);
        $('grafo-genero-nome').textContent = rotuloGenero(g);
      }
      $('grafo-detalhe').textContent = centro >= 0
        ? `${fmt(D.faixas[centro])} faixas · ligações ${base}. Arraste para girar.`
        : emTudo()
          ? `Todos os artistas com 3 ou mais faixas, ligados ${base}. Escolha um ponto para ver quem está perto; arraste para girar e role para aproximar.`
          : `Artistas ligados ${base}. Escolha um para ver quem está perto dele; arraste para girar.`;
      desenharCapas(nome);
      const noPlayer = nome && urlArtista(nome, D.acervos[D.acervo[centro]]);
      $('grafo-ouvir').hidden = !noPlayer;
      if (noPlayer) {
        $('grafo-ouvir').href = noPlayer;
        $('grafo-ouvir').setAttribute('aria-label', `Ver ${nome} no tocador`);
      }
      avisar(aviso || `${fmt(nos.length)} artistas · ${fmt(arestas.length)} ligações`);
    }

    function desenharCapas(nome) {
      const capas = nome ? capasDe(nome) : [], caixa = $('grafo-capas'), chave = `${nome}|${capas.length}`;
      if (chave === capasFeitas) return;     // redrawing would refetch and flash images already on screen
      capasFeitas = chave;
      caixa.scrollTop = caixa.scrollLeft = 0;
      caixa.replaceChildren(...capas.map(c => {
        const a = document.createElement('a'), img = document.createElement('img');
        a.href = c.href; a.target = '_blank'; a.rel = 'noopener';
        a.title = c.titulo;
        a.setAttribute('aria-label', `Abrir ${c.titulo} no tocador`);
        img.src = c.src; img.alt = ''; img.width = img.height = 56; img.loading = 'lazy';
        img.addEventListener('error', () => { a.remove(); caixa.hidden = !caixa.children.length; });
        a.append(img);
        return a;
      }));
      caixa.hidden = !capas.length;
    }

    function aplicarVista() {
      mundo.setAttribute('transform', `translate(${vista.x} ${vista.y}) scale(${vista.k})`);
      if (emTudo()) pedirPintura();
    }

    function centrar(i) {
      centro = i;
      aviso = '';
      limparFoco();
      desenhar(true, i);
      aoMudar();
    }

    // ── interaction ──
    function focar(i) {
      svg.classList.add('foco');
      for (const [j, el] of elNo) el.classList.toggle('perto', j === i);
      for (const l of gArestas.children) {
        const liga = +l.dataset.a === i || +l.dataset.b === i;
        l.classList.toggle('perto', liga);
        if (liga) elNo.get(+l.dataset.a === i ? +l.dataset.b : +l.dataset.a)?.classList.add('perto');
      }
    }
    function limparFoco() {
      svg.classList.remove('foco');
      for (const el of elNo.values()) el.classList.remove('perto');
      for (const l of gArestas.children) l.classList.remove('perto');
    }
    const noDe = t => t.closest?.('.grafo-no');
    gNos.addEventListener('pointerover', e => { const g = noDe(e.target); if (g && e.pointerType === 'mouse' && !transicao && !toques.size) focar(+g.dataset.i); });
    gNos.addEventListener('pointerout', e => { if (noDe(e.target)) limparFoco(); });
    gNos.addEventListener('focusin', e => { const g = noDe(e.target); if (g) focar(+g.dataset.i); });
    gNos.addEventListener('focusout', limparFoco);
    gNos.addEventListener('keydown', e => {
      const g = noDe(e.target);
      if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); centrar(+g.dataset.i); }
    });

    // Drag rotates, Shift + drag pans, wheel and pinch zoom; a press that barely moved is a click on whatever is under it.
    const toques = new Map();
    let arrastou = false, pinca = 0;
    function zoomEm(px, py, f) {
      const k = Math.max(0.5, Math.min(emTudo() ? ZOOM_TUDO : 6, vista.k * f)), r = k / vista.k;
      vista = { k, x: px - (px - vista.x) * r, y: py - (py - vista.y) * r };
      aplicarVista();
    }
    svg.addEventListener('wheel', e => {
      e.preventDefault();
      const b = svg.getBoundingClientRect();
      zoomEm(e.clientX - b.left, e.clientY - b.top, Math.exp(-e.deltaY * 0.002));
    }, { passive: false });
    svg.addEventListener('pointerdown', e => { toques.set(e.pointerId, [e.clientX, e.clientY]); arrastou = false; pinca = 0; });
    svg.addEventListener('pointermove', e => {
      const ant = toques.get(e.pointerId);
      if (!ant) {
        if (e.pointerType === 'mouse' && emTudo() && T?.x && !transicao) {
          const b = svg.getBoundingClientRect(), i = pertoDe(e.clientX - b.left, e.clientY - b.top, 5);
          if (i !== quente) { quente = i; svg.style.cursor = i >= 0 ? 'pointer' : ''; pedirPintura(); }
        }
        return;
      }
      const dx = e.clientX - ant[0], dy = e.clientY - ant[1];
      if (toques.size === 2) {
        toques.set(e.pointerId, [e.clientX, e.clientY]);
        const [a, b] = [...toques.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (pinca) zoomEm((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, d / pinca);
        pinca = d;
        arrastou = true;
        return;
      }
      if (!arrastou && Math.hypot(dx, dy) < 6) return;
      if (!arrastou) svg.setPointerCapture(e.pointerId);
      arrastou = true;
      toques.set(e.pointerId, [e.clientX, e.clientY]);
      if (e.shiftKey) { vista.x += dx; vista.y += dy; aplicarVista(); }
      else girar(dx, dy);
    });
    const soltar = e => {
      if (toques.delete(e.pointerId) && !arrastou && !toques.size) {
        if (e.type === 'pointerup' && emTudo() && T?.x) {
          const b = svg.getBoundingClientRect(), i = pertoDe(e.clientX - b.left, e.clientY - b.top, e.pointerType === 'mouse' ? 5 : 16);
          if (i >= 0) centrar(i);
        } else {
          const g = noDe(document.elementFromPoint(e.clientX, e.clientY) || svg);
          if (g && e.type === 'pointerup') centrar(+g.dataset.i);
        }
      }
      if (!toques.size) svg.classList.remove('arrastando');
    };
    svg.addEventListener('pointerleave', () => { if (quente >= 0) { quente = -1; svg.style.cursor = ''; pedirPintura(); } });
    svg.addEventListener('pointerup', soltar);
    svg.addEventListener('pointercancel', soltar);

    const ajustar = new ResizeObserver(() => {
      camada.style.setProperty('--cartao-alto', `${$('cartao').offsetHeight}px`);   // phones stack the panel on the card
      if (aberto && D && (camada.clientWidth !== larguraFeita || camada.clientHeight !== alturaFeita
        || Math.abs(reservaBaixo() - reservaFeita) > 1)) desenhar(false);
    });
    ajustar.observe(camada);
    ajustar.observe($('cartao'));
    ajustar.observe($('grafo-painel'));

    // ── public ──
    async function abrir(nome = null) {
      aberto = true;
      camada.hidden = false;
      document.body.classList.add('em-grafo');
      btn.setAttribute('aria-pressed', 'true');
      try { await carregar(); }
      catch (err) { console.error('[atlas]', err); avisar('grafo indisponível'); return; }
      if (!aberto) return;
      const i = indice(nome);
      centro = i;
      aviso = nome && i < 0 ? 'Artista fora do grafo' : '';
      desenhar(true, i);
      aoMudar();
    }
    // `posicionar`: leave the map on the artist the graph was centered on.
    function fechar(posicionar = true) {
      const nome = D && centro >= 0 ? D.nomes[centro] : null;
      encerrar();
      aberto = false;
      camada.hidden = true;
      document.body.classList.remove('em-grafo');
      btn.setAttribute('aria-pressed', 'false');
      aoMudar();
      if (nome && posicionar) aoSair(nome);
    }
    function buscar(q) {
      if (!aberto || !D) return;
      const c = chaveArtista(q);
      if (c.length < 2) return;
      let i = D.indice.get(c) ?? -1;
      if (i < 0) i = D.chaves.findIndex(x => x.startsWith(c));
      if (i < 0) i = D.chaves.findIndex(x => x.includes(c));
      if (i < 0) { avisar('nada encontrado'); return; }
      if (i !== centro) centrar(i);
    }
    // `qtd` neighbours of the first of `nomes` with a node, as display names; [] if none or the payload failed.
    async function parecidos(nomes, qtd) {
      try { await carregar(); } catch { return []; }
      const i = nomes.map(indice).find(x => x >= 0);
      return i === undefined ? [] : [...viz(i).subarray(0, qtd)].map(j => D.nomes[j]);
    }

    return {
      abrir, fechar, buscar, parecidos, girar,
      get aberto() { return aberto; },
      get centro() { return D && centro >= 0 ? D.nomes[centro] : null; },
      redesenhar() { if (aberto && D) desenhar(); },
      atualizarPainel() { if (aberto && D) desenharPainel(); },   // the catalogs arrive after the graph on a direct link
      estado() { return { aberto, tudo: emTudo(), centro: D && centro >= 0 ? D.nomes[centro] : null, nos: nos.map(i => D.nomes[i]), arestas: arestas.length, yaw, pitch }; },
      noTudo(nome) { const i = indice(nome); return emTudo() && T?.x && i >= 0 ? { x: T.sx[i], y: T.sy[i], r: T.sr[i] } : null; },
    };
  }

  global.criarGrafoAtlas = criarGrafoAtlas;
})(window);
