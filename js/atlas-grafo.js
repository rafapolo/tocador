// atlas-grafo.js — the "Grafo" view of /atlas: artists as nodes, linked to the ones they sound like (map
// "som") or share genres with (map "rotulos"). Payload: data/atlas-artistas.json.gz, built by
// script/build-artistas-parecidos.py and fetched on first use. Classic script, loaded after atlas-data.js
// and before atlas.js. Names come from the catalogs, so they only reach the page via textContent/setAttribute.
(function (global) {
  'use strict';

  const PAYLOAD = 'data/atlas-artistas.json.gz';
  const SVG = 'http://www.w3.org/2000/svg';
  const LIMITE_GERAL = 120;   // nodes in the overview, on a screen big enough for them
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
  const suave = p => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
  const fmt = n => n.toLocaleString('pt-BR');

  function criarGrafoAtlas({ raiz, fetchJsonGz, mapa, acervo, corDe, rotuloGenero, aoMudar, aoVerNoMapa, aoSair, avisar }) {
    const $ = id => document.getElementById(id);
    const camada = $('grafo'), svg = $('grafo-svg'), mundo = $('grafo-mundo');
    const gArestas = $('grafo-arestas'), gNos = $('grafo-nos'), btn = $('btn-grafo');
    const reduzMovimento = matchMedia('(prefers-reduced-motion: reduce)').matches;

    let D = null, carregando = null;
    let aberto = false, centro = -1;     // centro: artist index, -1 = overview
    let nos = [], arestas = [];
    let aviso = '';                      // shown instead of the count until the view changes
    const elNo = new Map();              // artist index -> <g>
    const cena = new Map();              // artist index -> what is drawn now: { x, y, r, o, v } (v = fading in/out)
    const linhas = new Map();            // link key -> { el, a, b, o }
    let transicao = null, quadro = 0;    // the walk in progress and its animation frame
    let larguraFeita = 0, alturaFeita = 0, reservaFeita = 0;
    let vista = { x: 0, y: 0, k: 1 };

    function carregar() {
      carregando ??= (async () => {
        try { D = decodeArtistas(await fetchJsonGz(raiz + PAYLOAD)); }
        catch { D = decodeArtistas(await fetchJsonGz('https://tocador.cc/' + PAYLOAD)); }   // mirrors don't copy data/
      })().catch(err => { carregando = null; throw err; });
      return carregando;
    }

    const viz = (i, m = mapa()) => D.viz[m].subarray(i * D.k, (i + 1) * D.k);
    const indice = nome => (nome && D.indice.get(chaveArtista(nome))) ?? -1;

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

    function calcular(lista, ligs, semente = new Map()) {
      const n = lista.length, pos = new Map(lista.map((v, j) => [v, j]));
      const x = new Float64Array(n), y = new Float64Array(n);
      const W = camada.clientWidth, H = camada.clientHeight;
      const topo = $('controles').getBoundingClientRect().bottom + 16;
      const area = { l: 16, r: W - 16, t: topo, b: H - reservaBaixo() };
      const aw = Math.max(120, area.r - area.l), ah = Math.max(120, area.b - area.t);
      const L = Math.sqrt(aw * ah / Math.max(n, 1)) * 1.1;
      const meioX = area.l + aw / 2, meioY = area.t + ah / 2;
      const [refX, refY] = semente.get(centro) || [meioX, meioY];
      lista.forEach((v, j) => {
        const r = 14 * Math.sqrt(j + 1), g = j * 2.39996, s = semente.get(v);
        x[j] = s ? s[0] - refX : r * Math.cos(g);
        y[j] = s ? s[1] - refY : r * Math.sin(g);
      });
      const fixo = lista.indexOf(centro);
      const pares = ligs.map(e => [pos.get(e.a), pos.get(e.b)]);
      const passos = 320, gravidade = 0.02;
      for (let p = 0; p < passos; p++) {
        const teto = 40 * (1 - p / passos) + 1;
        const fx = new Float64Array(n), fy = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            const dx = x[i] - x[j], dy = y[i] - y[j], d2 = Math.max(dx * dx + dy * dy, 1);
            const f = L * L * 0.5 / d2;
            fx[i] += dx * f; fy[i] += dy * f; fx[j] -= dx * f; fy[j] -= dy * f;
          }
        }
        for (const [i, j] of pares) {
          const dx = x[j] - x[i], dy = y[j] - y[i], d = Math.hypot(dx, dy) || 1, f = (d - L) * 0.12 / d;
          fx[i] += dx * f; fy[i] += dy * f; fx[j] -= dx * f; fy[j] -= dy * f;
        }
        for (let i = 0; i < n; i++) {
          x[i] += Math.max(-teto, Math.min(teto, fx[i] - x[i] * gravidade));
          y[i] += Math.max(-teto, Math.min(teto, fy[i] - y[i] * gravidade * (aw / ah)));
        }
        if (fixo >= 0) { x[fixo] = 0; y[fixo] = 0; }
      }
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
      return new Map(lista.map((v, j) => [v, [x[j], y[j]]]));
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
      const lista = centro >= 0 ? escolherEgo(centro) : escolherGeral();
      const ligs = ligar(lista, centro);
      nos = lista; arestas = ligs;
      desenharPainel();                      // first: the layout measures the panel
      larguraFeita = camada.clientWidth; alturaFeita = camada.clientHeight; reservaFeita = reservaBaixo();
      const semente = new Map();
      for (const i of lista) { const c = cena.get(i); if (c?.v > 0) semente.set(i, [c.x, c.y]); }
      const pos = calcular(lista, ligs, semente);
      const niveis = nivelDe(lista);

      // Whatever leaves goes along with the camera, instead of staying behind as the scene moves.
      const antes = cena.get(centro), [nx, ny] = antes ? pos.get(centro) : [0, 0];
      const dx = antes ? nx - antes.x : 0, dy = antes ? ny - antes.y : 0;
      const nasce = cena.get(origem);
      const alvos = new Map();
      for (const i of lista) {
        const [x, y] = pos.get(i), o = OPACIDADE_NO[niveis.get(i)], r = raio(i);
        alvos.set(i, { x, y, r, o, v: 1 });
        if (!cena.has(i)) {
          elNo.set(i, novoNo(i));
          gNos.append(elNo.get(i));
          cena.set(i, { x: nasce ? nasce.x : x, y: nasce ? nasce.y : y, r, o, v: 0 });
        }
      }
      for (const [i, c] of cena) if (!alvos.has(i)) alvos.set(i, { x: c.x + dx, y: c.y + dy, r: c.r, o: c.o, v: 0 });
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
        vista: { ...vista },
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
      const { alvos, alvosLinha, de, deLinha, vista: v0 } = transicao;
      for (const [i, c] of cena) {
        const a = de.get(i), b = alvos.get(i), el = elNo.get(i);
        c.x = entre(a.x, b.x, p); c.y = entre(a.y, b.y, p); c.r = entre(a.r, b.r, p);
        c.o = entre(a.o, b.o, p); c.v = entre(a.v, b.v, p);
        el.setAttribute('transform', `translate(${c.x} ${c.y})`);
        el.firstChild.setAttribute('r', c.r);
        el.lastChild.setAttribute('x', c.r + 4);
        el.lastChild.setAttribute('y', 4);
        el.style.setProperty('--o', c.o * c.v);
        el.style.setProperty('--t', (TEXTO_MIN + (1 - TEXTO_MIN) * c.o) * c.v);   // labels stay readable far from the center
      }
      for (const [k, l] of linhas) {
        const a = cena.get(l.a), b = cena.get(l.b);
        l.o = entre(deLinha.get(k), alvosLinha.get(k), p);
        l.el.setAttribute('x1', a.x); l.el.setAttribute('y1', a.y);
        l.el.setAttribute('x2', b.x); l.el.setAttribute('y2', b.y);
        l.el.style.setProperty('--o', l.o);
      }
      vista = { x: entre(v0.x, 0, p), y: entre(v0.y, 0, p), k: entre(v0.k, 1, p) };
      aplicarVista();
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
      $('grafo-titulo').textContent = centro >= 0 ? D.nomes[centro] : 'Artistas parecidos';
      $('grafo-detalhe').textContent = centro >= 0
        ? `${rotuloGenero(D.generos[D.genero[centro]])} · ${fmt(D.faixas[centro])} faixas · ligações ${base}`
        : `Artistas ligados ${base}. Escolha um para ver quem está perto dele.`;
      $('grafo-ver-mapa').hidden = $('grafo-geral').hidden = centro < 0;
      avisar(aviso || `${fmt(nos.length)} artistas · ${fmt(arestas.length)} ligações`);
    }

    function aplicarVista() { mundo.setAttribute('transform', `translate(${vista.x} ${vista.y}) scale(${vista.k})`); }

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
    gNos.addEventListener('pointerover', e => { const g = noDe(e.target); if (g && e.pointerType === 'mouse') focar(+g.dataset.i); });
    gNos.addEventListener('pointerout', e => { if (noDe(e.target)) limparFoco(); });
    gNos.addEventListener('focusin', e => { const g = noDe(e.target); if (g) focar(+g.dataset.i); });
    gNos.addEventListener('focusout', limparFoco);
    gNos.addEventListener('keydown', e => {
      const g = noDe(e.target);
      if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); centrar(+g.dataset.i); }
    });

    // Drag pans, wheel and pinch zoom; a press that barely moved is a click on whatever is under it.
    const toques = new Map();
    let arrastou = false, pinca = 0;
    function zoomEm(px, py, f) {
      const k = Math.max(0.5, Math.min(6, vista.k * f)), r = k / vista.k;
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
      if (!ant) return;
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
      vista.x += dx; vista.y += dy;
      aplicarVista();
    });
    const soltar = e => {
      if (toques.delete(e.pointerId) && !arrastou && !toques.size) {
        const g = noDe(document.elementFromPoint(e.clientX, e.clientY) || svg);
        if (g && e.type === 'pointerup') centrar(+g.dataset.i);
      }
      if (!toques.size) svg.classList.remove('arrastando');
    };
    svg.addEventListener('pointerup', soltar);
    svg.addEventListener('pointercancel', soltar);

    $('grafo-ver-mapa').addEventListener('click', () => { const nome = D.nomes[centro]; fechar(false); aoVerNoMapa(nome); });
    $('grafo-geral').addEventListener('click', () => centrar(-1));
    const ajustar = new ResizeObserver(() => {
      camada.style.setProperty('--cartao-alto', `${$('cartao').offsetHeight}px`);   // phones stack the panel on the card
      if (aberto && D && (camada.clientWidth !== larguraFeita || camada.clientHeight !== alturaFeita
        || Math.abs(reservaBaixo() - reservaFeita) > 1)) desenhar(false);
    });
    ajustar.observe(camada);
    ajustar.observe($('cartao'));

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
      abrir, fechar, buscar, parecidos,
      get aberto() { return aberto; },
      get centro() { return D && centro >= 0 ? D.nomes[centro] : null; },
      redesenhar() { if (aberto && D) desenhar(); },
      estado() { return { aberto, centro: D && centro >= 0 ? D.nomes[centro] : null, nos: nos.map(i => D.nomes[i]), arestas: arestas.length }; },
    };
  }

  global.criarGrafoAtlas = criarGrafoAtlas;
})(window);
