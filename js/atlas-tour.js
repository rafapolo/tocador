// atlas-tour.js — o tour de quase 2 minutos do /atlas (roteiro em TOUR.md). Um ponteiro desenhado clica nos controles de
// verdade, a câmera voa pelos lugares que os dados apontam (nenhum nome ou número fixo aqui: tudo é contado no
// navegador) e a trilha é a própria sonificação, que reage ao que a câmera vê. ▶ Tour ou ?tour=1 (&t=<s> pula);
// Esc ou ✕ esc encerram e devolvem mapa, filtros, grafo, seleção e câmera. Carregado depois de js/atlas.js, cujo
// window.__atlas é a única porta para o mapa.
(function () {
  'use strict';

  const at = window.__atlas;
  if (!at) return;
  const $ = id => document.getElementById(id);
  const fmt = n => Math.round(n).toLocaleString('pt-BR');
  const pct = x => Math.round(x * 100);
  const reduzMovimento = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const comPonteiro = () => matchMedia('(min-width: 981px)').matches;

  // ── dados: o que o tour mostra, contado a partir do payload ──
  // Cada marco é [gênero, x, y, n, z]: a mediana de um subgênero que forma um lugar no mapa e quantas faixas tem.
  function calcular() {
    const { A, cor, macros, nomeMacro, subDe, macroDe } = at.dados();
    const N = A.n, OUTROS = macros.length;
    const porAcervo = A.acervos.map((_, j) => { let c = 0; for (let i = 0; i < N; i++) if (A.acervo[i] === j) c++; return c; });
    const porMacro = new Array(OUTROS + 1).fill(0);
    for (let i = 0; i < N; i++) porMacro[cor[i]]++;
    const porGenero = new Array(A.generos.length).fill(0);
    for (let i = 0; i < N; i++) porGenero[A.genero[i]]++;
    const macroIdx = g => { const j = macros.findIndex(m => m[0] === macroDe(A.generos[g])); return j < 0 ? OUTROS : j; };
    const marcos = (A.marcos.som || []).map(([g, qx, qy, n]) => ({
      g, x: qx / 65535, y: qy / 65535, n, sub: subDe(A.generos[g]), macro: macroIdx(g), nomeMacro: nomeMacro(macroDe(A.generos[g])),
    }));

    // Mainstream: o marco mais povoado, e o mais povoado de outro macro-gênero, do outro lado.
    const porN = [...marcos].sort((a, b) => b.n - a.n);
    const m1 = porN[0] || null;
    const m2 = porN.find(m => m1 && m.macro !== m1.macro) || null;

    // Travessia: do lugar do macro-gênero do mainstream mais longe do outro lado (Batucada) até o lugar grande de outro
    // macro-gênero mais longe do mainstream (Punk), parando nos lugares grandes que ficam no caminho, em ordem.
    const grandes = marcos.filter(m => m.n >= 400 && m.macro !== OUTROS), pontas = grandes.filter(m => m.n >= 1000);
    const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
    const maisLonge = (lista, de) => lista.reduce((r, m) => (!r || dist(m, de) > dist(r, de) ? m : r), null);
    let trav = null;
    if (m1) {
      const fim = maisLonge(pontas.filter(m => m.macro !== m1.macro), m1);
      const ini = fim && maisLonge(pontas.filter(m => m.macro === m1.macro), fim);
      if (ini && fim) {
        const dx = fim.x - ini.x, dy = fim.y - ini.y, L2 = dx * dx + dy * dy, L = Math.sqrt(L2);
        const BINS = 4, meio = new Array(BINS).fill(null);
        for (const m of grandes) {
          if (m === ini || m === fim) continue;
          const t = ((m.x - ini.x) * dx + (m.y - ini.y) * dy) / L2;
          const lado = Math.abs((m.x - ini.x) * dy - (m.y - ini.y) * dx) / L;
          if (t <= 0.03 || t >= 0.95 || lado > 0.14 * L) continue;
          const j = Math.min(BINS - 1, Math.floor((t - 0.03) / 0.92 * BINS));
          // o mainstream, se estiver no caminho, ganha a sua parada
          const peso = x => (x === m1 ? Infinity : x.n);
          if (!meio[j] || peso(m) > peso(meio[j])) meio[j] = m;
        }
        trav = [ini, ...meio.filter(Boolean), fim];
      }
    }

    // Fusões: na vizinhança de cada marco (grade 40×40 do mapa Som), quanto há do macro dele e do outro mais forte.
    const G = 40, grade = Array.from({ length: G * G }, () => new Uint32Array(OUTROS + 1));
    const pos = A.pos.som;
    for (let i = 0; i < N; i++) {
      const gx = Math.min(G - 1, Math.floor(pos[2 * i] / 65536 * G)), gy = Math.min(G - 1, Math.floor(pos[2 * i + 1] / 65536 * G));
      grade[gy * G + gx][cor[i]]++;
    }
    const vizinhanca = m => {
      const soma = new Array(OUTROS + 1).fill(0), gx = Math.floor(m.x * G), gy = Math.floor(m.y * G);
      for (let y = gy - 1; y <= gy + 1; y++) for (let x = gx - 1; x <= gx + 1; x++) {
        if (x < 0 || y < 0 || x >= G || y >= G) continue;
        grade[y * G + x].forEach((c, j) => { soma[j] += c; });
      }
      const total = soma.slice(0, OUTROS).reduce((a, b) => a + b, 0);
      return { soma, total };
    };
    const usados = new Set([m1?.g, m2?.g, ...(trav || []).map(m => m.g)]);
    const fusoes = [];
    for (const m of marcos) {
      if (m.n < 40 || m.macro === OUTROS || usados.has(m.g)) continue;
      const { soma, total } = vizinhanca(m);
      if (total < 30) continue;
      let b = -1;
      for (let j = 0; j < OUTROS; j++) if (j !== m.macro && (b < 0 || soma[j] > soma[b])) b = j;
      const pa = soma[m.macro] / total, pb = soma[b] / total;
      if (pb < 0.2) continue;
      fusoes.push({ ...m, outro: nomeMacro(macros[b][0]), pa, pb, nota: Math.min(pa, pb) });
    }
    fusoes.sort((a, b) => b.nota - a.nota);
    const fus = [];
    for (const f of fusoes) {
      if (fus.length === 2) break;
      if (fus.some(x => [x.nomeMacro, x.outro].sort().join() === [f.nomeMacro, f.outro].sort().join())) continue;   // um par por vez, em qualquer ordem
      fus.push(f); usados.add(f.g);
    }

    // Raridades: os menores lugares (marcos com poucas faixas, mas juntas), de macro-gêneros diferentes.
    const raros = [];
    for (const m of [...marcos].sort((a, b) => a.n - b.n)) {
      if (raros.length === 2) break;
      if (m.n < 12 || usados.has(m.g) || raros.some(r => r.macro === m.macro)) continue;
      raros.push(m); usados.add(m.g);
    }
    const generosUsados = porGenero.filter(c => c > 0).length;
    const quaseSos = porGenero.filter(c => c > 0 && c < 10).length;

    return { N, porAcervo, acervos: A.acervos, porMacro, m1, m2, trav, fus, raros, generosUsados, quaseSos, OUTROS };
  }

  // Zoom (× o enquadramento do mapa inteiro) em que o rótulo de um marco com n faixas aparece: o mapa só escreve
  // os que têm n ≥ 1200 / z^1.7 (desenharMarcos() em js/atlas.js).
  const zoomDoRotulo = n => Math.min(40, Math.max(2.5, Math.pow(1200 / Math.max(1, n), 1 / 1.7) * 1.2));

  // ── estado da execução ──
  class Parou extends Error {}
  let run = null, iniciando = false;

  function espera(ms) {
    if (!run || run.parado) return Promise.reject(new Parou());
    if (run.rapido || ms <= 0) return Promise.resolve();
    return new Promise((res, rej) => {
      const p = { rej };
      p.id = setTimeout(() => { run?.pend.delete(p); res(); }, ms);
      run.pend.add(p);
    });
  }

  // A câmera voa até (x, y) no zoom z. De perto para longe, sobe um pouco antes, para o salto ler como viagem.
  async function irPara(x, y, z, ms = 2200) {
    const c = at.camera();
    if (run.rapido || reduzMovimento) { at.voar(x, y, c.k0 * z, 0); return; }
    const longe = Math.hypot(x - c.cx, y - c.cy) * c.k > c.W * 0.6;
    if (longe && c.k > c.k0 * 1.6) {
      at.voar((c.cx + x) / 2, (c.cy + y) / 2, c.k0 * 1.3, ms * 0.45);
      await espera(ms * 0.45);
      at.voar(x, y, c.k0 * z, ms * 0.55);
      await espera(ms * 0.55);
    } else {
      at.voar(x, y, c.k0 * z, ms);
      await espera(ms);
    }
  }
  // O marco fica um pouco acima do meio, longe da legenda do tour.
  const alvoY = (m, z) => { const c = at.camera(); return m.y - (c.H * 0.08) / (c.k0 * z); };

  // ── legenda, ponteiro e moldura ──
  let ui = null;
  function montarUi() {
    const capa = document.createElement('div');
    capa.id = 'tour';
    capa.innerHTML = '<div class="tour-barra tour-baixo"><div id="tour-progresso"><span></span></div></div>'
      + '<div id="tour-legenda" role="status" aria-live="polite"><p id="tour-kicker"></p><p id="tour-linha"></p></div>'
      + '<button id="tour-sair" type="button" aria-label="Encerrar o tour (Esc)">✕ esc</button>'
      + '<div id="tour-ponteiro" aria-hidden="true" hidden><svg viewBox="0 0 24 24"><path d="M5 3l14 8-6.5 1.5L9.5 19z"/></svg></div>';
    document.body.append(capa);
    capa.querySelector('#tour-sair').addEventListener('click', () => parar());
    ui = { capa, kicker: $('tour-kicker'), linha: $('tour-linha'), legenda: $('tour-legenda'), barra: $('tour-progresso').firstElementChild, ponteiro: $('tour-ponteiro') };
  }
  function legenda(kicker, linha) {
    if (run.rapido) return;
    ui.legenda.classList.remove('entra');
    void ui.legenda.offsetWidth;
    ui.kicker.textContent = kicker;
    ui.linha.textContent = linha;
    ui.legenda.classList.add('entra');
  }
  function focar(el) {
    document.querySelectorAll('.tour-foco').forEach(x => x.classList.remove('tour-foco'));
    (el?.closest('.seg, #grafo-painel') || el)?.classList.add('tour-foco');
  }
  // Leva o ponteiro até o controle e clica nele de verdade. Sem ponteiro (telas estreitas), espera o mesmo tempo.
  async function clicar(el, { clica = true } = {}) {
    if (!el) return;
    focar(el);
    if (run.rapido) { if (clica) el.click(); return; }
    if (!comPonteiro()) { await espera(900); if (clica) el.click(); return; }
    await moverPonteiro(el.getBoundingClientRect());
    if (clica) {
      ui.ponteiro.classList.remove('clica'); void ui.ponteiro.offsetWidth; ui.ponteiro.classList.add('clica');
      el.click();
    }
    await espera(350);
  }
  async function moverPonteiro(r) {
    const p = ui.ponteiro;
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (p.hidden) { p.hidden = false; p.style.transform = `translate(${innerWidth / 2}px, ${innerHeight * 0.6}px)`; void p.offsetWidth; }
    p.style.transform = `translate(${x}px, ${y}px)`;
    await espera(reduzMovimento ? 150 : 750);
  }
  function esconderPonteiro() { if (ui) ui.ponteiro.hidden = true; }

  // ── as cenas ── (tempos em TOUR.md; cada cena dura exatamente `dur` s, esperando o que faltar)
  function cenas(D) {
    const nomeAcervo = { uqt: 'UQT', homi: 'Hominis Canidae' };
    const partes = D.acervos.map((a, j) => `${fmt(D.porAcervo[j])} do ${nomeAcervo[a] || a}`);
    return [
      { id: 'abertura', dur: 5, async fn() {
        at.fecharCartao();
        at.enquadrarTudo(!run.rapido);
        legenda('atlas', `${fmt(D.N)} faixas (${partes.join(', ')}). Cada ponto é uma faixa; o que soa parecido fica perto.`);
        await espera(1200);
        const c = at.camera();
        if (!run.rapido && !reduzMovimento) at.voar(c.cx, c.cy, c.k0 * 1.15, 3800);
      } },
      { id: 'sonificar', dur: 5, async fn() {
        const s = at.som(), btn = $('btn-musica');
        if (!s || btn.disabled) {
          legenda('sonificar', 'Este navegador não toca a sonificação; o tour segue em silêncio.');
          await clicar(btn, { clica: false });
          return;
        }
        await clicar(btn, { clica: false });      // ligada em iniciar(), ainda dentro do clique em ▶ Tour
        legenda('sonificar', 'Nenhum som aqui é gravado: o que a câmera vê vira a partitura, e cada gênero na tela toca uma parte da banda.');
        await espera(1200);
        esconderPonteiro();
        focar(null);
      } },
      { id: 'travessia', dur: 60, async fn() {
        const T = D.trav, { m1 } = D;
        if (!T) {
          const zoom = m => Math.min(4, Math.max(2.5, zoomDoRotulo(m.n)));
          if (!m1) { legenda('mainstream', 'Os lugares mais povoados do mapa.'); return; }
          await irPara(m1.x, alvoY(m1, zoom(m1)), zoom(m1));
          legenda(`mainstream · ${m1.sub}`, `${fmt(m1.n)} faixas de ${m1.sub}: o lugar mais povoado do mapa.`);
          return;
        }
        // De uma ponta à outra do mapa, uma parada por lugar grande no caminho, e a câmera respira para a música se
        // ouvir: entre as paradas ela se afasta (de longe, só a cama abafada) e em cada uma aproxima até 8× (entram
        // baixo, ritmo, acordes e por fim a melodia; camadasSom() em js/atlas-som.js). A banda é a fusão do que está à
        // vista, então no caminho os dois lugares tocam juntos.
        const PERTO = 8, LONGE = 1.4;
        const ini = T[0], fim = T[T.length - 1], kicker = `de ${ini.sub} a ${fim.sub}`, trilha = [];
        const chegar = async (m, ms) => {
          const c = at.camera(), y = alvoY(m, PERTO);
          if (run.rapido || reduzMovimento) { at.voar(m.x, y, c.k0 * PERTO, 0); return; }
          at.voar(m.x, y, c.k0 * PERTO, ms);
          await espera(ms);
        };
        for (const [j, m] of T.entries()) {
          const antes = T[j - 1];
          if (antes && !run.rapido && !reduzMovimento) {
            const c = at.camera();
            at.voar((antes.x + m.x) / 2, (antes.y + m.y) / 2, c.k0 * LONGE, 3000);   // abre: as camadas saem
            legenda(kicker, `De longe, só a cama: ${antes.sub} e ${m.sub} soam juntos, abafados.`);
            await espera(3000);
          }
          await chegar(m, j ? 3500 : 4500);                                         // fecha: as camadas entram
          trilha.push(m.sub);
          legenda(kicker,
            j === 0 ? `${m.sub}, ${fmt(m.n)} faixas de ${m.nomeMacro}. De perto entram baixo, ritmo, acordes e melodia; daqui até ${fim.sub}, ouça a banda mudar.`
              : m === fim ? `${m.sub}, ${fmt(m.n)} faixas de ${m.nomeMacro}: o outro lado. ${trilha.join(' → ')}.`
                : m === m1 ? `${m.sub}: ${fmt(m.n)} faixas, o lugar mais povoado do mapa. ${pct(D.porMacro[m.macro] / D.N)}% de todas as faixas são ${m.nomeMacro}.`
                  : antes && antes.macro !== m.macro ? `${m.sub}, ${fmt(m.n)} faixas: aqui ${antes.nomeMacro} vira ${m.nomeMacro}.`
                    : `${m.sub}, ${fmt(m.n)} faixas de ${m.nomeMacro}, no caminho.`);
          if (m !== fim) await espera(j === 0 ? 4500 : 3000);
        }
      } },
      { id: 'raridades', dur: 8, async fn() {
        const [r1, r2] = D.raros;
        if (!r1) { legenda('raridades', `${fmt(D.quaseSos)} dos ${fmt(D.generosUsados)} estilos têm menos de 10 faixas no acervo inteiro.`); return; }
        const z1 = zoomDoRotulo(r1.n);
        await irPara(r1.x, alvoY(r1, z1), z1);
        legenda(`raridade · ${r1.sub}`, `Só ${fmt(r1.n)} faixas de ${r1.sub}, mas juntas: um lugar próprio no mapa.`);
        await espera(2200);
        if (!r2) return;
        const z2 = zoomDoRotulo(r2.n);
        await irPara(r2.x, alvoY(r2, z2), z2);
        legenda(`raridade · ${r2.sub}`, `${fmt(D.quaseSos)} dos ${fmt(D.generosUsados)} estilos têm menos de 10 faixas no acervo inteiro.`);
      } },
      { id: 'fusoes', dur: 8, async fn() {
        if (!D.fus.length) { legenda('fusões', 'Entre as regiões ficam as pontes, onde um gênero encosta no outro.'); return; }
        for (const [j, f] of D.fus.entries()) {
          const z = Math.min(8, zoomDoRotulo(f.n));
          await irPara(f.x, alvoY(f, z), z);
          legenda(`fusão · ${f.sub}`, `${f.sub} fica entre ${f.nomeMacro} e ${f.outro}: na vizinhança, ${pct(f.pa)}% ${f.nomeMacro} e ${pct(f.pb)}% ${f.outro}.`);
          if (j === 0) await espera(2200);
        }
      } },
      { id: 'som-generos', dur: 8, async fn() {
        at.enquadrarTudo(!run.rapido);
        await espera(500);
        await clicar(document.querySelector('[data-mapa="rotulos"]'));
        legenda('gêneros', 'No mapa Gêneros, a posição vem só dos rótulos que o modelo deu: os grupos ficam limpos, mas repetem o rótulo.');
        await espera(2000);
        await clicar(document.querySelector('[data-mapa="som"]'));
        legenda('som', 'No mapa Som, vem do áudio: o que soa parecido fica junto, tenha o rótulo que tiver.');
        esconderPonteiro(); focar(null);
        await espera(1000);
        if (!run.rapido && !reduzMovimento && at.girarVista(0.9, -0.35, 2600)) {
          legenda('3D', 'O mapa também tem profundidade: arraste com o botão direito, ou ligue o ⟳, para girar.');
        }
      } },
      { id: 'grafo', dur: 8, async fn() {
        at.fecharCartao();
        at.enquadrarTudo(false);
        await clicar($('btn-grafo'));
        legenda('grafo', 'No Grafo, cada nome é um artista, perto dos que soam como ele.');
        await espera(1500);
        const nome = D.artista;
        if (!nome) return;
        const no = at.grafoTudo(nome);
        if (no && !run.rapido && comPonteiro()) await moverPonteiro({ left: no.x, top: no.y, width: 0, height: 0 });
        await at.abrirGrafo(nome);
        focar($('grafo-painel'));
        legenda(`grafo · ${nome}`, `No centro, ${nome}; em volta, os artistas que mais soam parecido. Os mais longe ficam mais apagados.`);
        await espera(2300);
        const viz = $('grafo-parecidos-lista')?.querySelector('button');
        if (!viz) return;
        const vizinho = viz.textContent.trim();
        await clicar(viz);
        legenda(`grafo · ${vizinho}`, 'Clique num vizinho e o grafo anda até ele.');
      } },
      { id: 'fim', dur: 3, async fn() {
        if (at.grafo().aberto) await clicar($('btn-grafo'));
        else at.enquadrarTudo(!run.rapido);
        esconderPonteiro(); focar(null);
        legenda('tocador.cc/atlas', 'Arraste, aproxime e clique numa faixa para ouvir.');
      } },
    ];
  }
  const DURACAO = () => cenas({ acervos: [], porAcervo: [], fus: [], raros: [] }).reduce((s, c) => s + c.dur, 0);

  // O artista do grafo: o mais frequente perto do lugar mais povoado (precisa dos catálogos ligados).
  function artistaDoTour(D) {
    if (!D.m1) return null;
    const { A } = at.dados(), pos = A.pos.som, perto = [];
    for (let i = 0; i < A.n; i++) {
      const d = (pos[2 * i] / 65535 - D.m1.x) ** 2 + (pos[2 * i + 1] / 65535 - D.m1.y) ** 2;
      perto.push([d, i]);
    }
    perto.sort((a, b) => a[0] - b[0]);
    // Conta por nome sem caixa ("beth carvalho" = "Beth Carvalho") e mostra a grafia com maiúscula, se houver.
    const conta = new Map();
    for (const [, i] of perto.slice(0, 400)) {
      const a = at.artistaDe(i);
      if (!a) continue;
      const c = conta.get(a.toLowerCase()) || conta.set(a.toLowerCase(), { n: 0, nome: a }).get(a.toLowerCase());
      c.n++;
      if (c.nome === c.nome.toLowerCase() && a !== a.toLowerCase()) c.nome = a;
    }
    return [...conta.values()].sort((a, b) => b.n - a.n)[0]?.nome || null;
  }

  // A câmera nunca fica parada: se nada mexeu nela por DERIVA_MS (uma espera de cena, uma legenda lida), ela desliza
  // devagar, um pouco ao lado e um pouco mais perto, alternando o lado. O próximo voo da cena a substitui. Fica de fora
  // no grafo (que tem o próprio movimento), ao pular cenas e com movimento reduzido.
  const DERIVA_MS = 1500;
  function derivar(r) {
    let assinatura = '', desde = performance.now(), lado = 1;
    r.deriva = setInterval(() => {
      if (r.parado) return clearInterval(r.deriva);
      const c = at.camera(), agora = performance.now();
      const a = [c.cx, c.cy, c.k, c.yaw, c.pitch].map(v => v.toFixed(6)).join();
      if (a !== assinatura) { assinatura = a; desde = agora; return; }
      if (agora - desde < DERIVA_MS || r.rapido || reduzMovimento || at.grafo().aberto) return;
      const passo = c.W * 0.05 / c.k;
      at.voar(c.cx + lado * passo, c.cy - lado * passo * 0.4, c.k * 1.12, 4000);
      lado = -lado;
      desde = agora;
    }, 250);
  }

  // ── iniciar e parar ──
  async function iniciar(pularPara = 0) {
    if (run || iniciando) return;
    iniciando = true;
    // A trilha é a sonificação: liga já, enquanto o clique em ▶ Tour ainda vale como gesto para o navegador soar.
    const s = at.som(), musica = $('btn-musica');
    const ligouSom = !!s && !s.vontade && !musica.disabled;
    if (ligouSom) musica.click();
    try { await at.pronto; } finally { iniciando = false; }
    const D = calcular();
    D.artista = artistaDoTour(D);
    const lista = cenas(D), total = lista.reduce((s, c) => s + c.dur, 0);
    run = { parado: false, rapido: false, pend: new Set(), cena: null, t0: 0, total, ligouSom,
      antes: { busca: location.search, camera: at.camera() } };
    at.prenderUrl(true);
    // O tour começa do mapa limpo (Som, todos os acervos, sem busca, filtro, grafo ou seleção): aplica um endereço
    // vazio, sem escrevê-lo no histórico. O de antes fica em run.antes para o encerramento.
    const meu = run;
    history.replaceState(history.state, '', location.pathname);
    await at.aplicarUrl();
    if (run !== meu) return;                  // Esc enquanto o mapa se limpava
    if (!ui) montarUi();
    ui.capa.hidden = false;
    document.body.classList.add('em-tour');
    $('btn-tour')?.setAttribute('aria-pressed', 'true');
    const comeco = Math.max(0, Math.min(total - 1, pularPara));
    let inicioCena = 0;
    run.t0 = performance.now() - comeco * 1000;
    const progresso = () => {
      if (!run || run.parado) return;
      ui.barra.style.width = `${Math.min(100, (performance.now() - run.t0) / 10 / total)}%`;
      requestAnimationFrame(progresso);
    };
    requestAnimationFrame(progresso);
    derivar(run);
    try {
      for (const c of lista) {
        const fim = inicioCena + c.dur;
        run.cena = c.id;
        run.rapido = fim <= comeco;
        const t0 = performance.now();
        await c.fn();
        if (!run.rapido) await espera(c.dur * 1000 - (performance.now() - t0));
        inicioCena = fim;
        if (run.rapido) run.t0 = performance.now() - inicioCena * 1000;
      }
      run.rapido = false;
      await espera(600);
      await encerrar(false);
    } catch (e) {
      if (!(e instanceof Parou)) { console.error('[tour]', e); await encerrar(true); }
    }
  }

  // Devolve o que o tour mudou: mapa, acervo, filtros, busca, grafo e seleção (o endereço guardou tudo isso, porque
  // o tour não escreve no histórico), a sonificação se o tour a ligou, e a câmera quando foi interrompido. Visto até
  // o fim, a câmera fica no mapa inteiro, onde a última cena a deixou (ou onde a busca devolvida a levar).
  async function encerrar(interrompido) {
    if (!run) return;
    const r = run;
    r.parado = true;
    clearInterval(r.deriva);
    for (const p of r.pend) { clearTimeout(p.id); p.rej(new Parou()); }
    r.pend.clear();
    run = null;
    esconderPonteiro(); focar(null);
    if (ui) ui.capa.hidden = true;
    document.body.classList.remove('em-tour');
    $('btn-tour')?.setAttribute('aria-pressed', 'false');
    if (r.ligouSom) at.querSom(false);
    at.prenderUrl(false);
    history.replaceState(history.state, '', location.pathname + r.antes.busca);
    await at.aplicarUrl();
    if (interrompido) {
      const c = r.antes.camera;
      at.voar(c.cx, c.cy, c.k, 0, [c.yaw, c.pitch]);
    }
  }
  const parar = () => encerrar(true);

  // ── botão, teclado e ?tour=1 ──
  const btn = $('btn-tour');
  btn?.addEventListener('click', () => (run ? parar() : iniciar()));
  // Captura: enquanto o tour roda, as teclas do mapa (G, +, setas…) ficam paradas; Esc encerra, M ainda liga o som.
  document.addEventListener('keydown', e => {
    if (!run) {
      if ((e.key === 't' || e.key === 'T') && !e.target.closest?.('input, textarea') && !e.metaKey && !e.ctrlKey && !e.altKey && btn && !btn.disabled) iniciar();
      return;
    }
    if (e.key === 'm' || e.key === 'M') return;
    e.stopImmediatePropagation();
    if (e.key === 'Escape') { e.preventDefault(); parar(); }
  }, true);

  // ?tour=1 é lido já, ao carregar: até o mapa ficar pronto, o js/atlas.js reescreve o endereço (um ?acervo= vira
  // uma entrada do histórico) e levaria o pedido junto.
  const pedido = new URLSearchParams(location.search);
  const pedeTour = pedido.has('tour'), pular = parseFloat(pedido.get('t')) || 0;
  at.pronto.then(() => {
    if (btn) btn.disabled = false;
    if (!pedeTour) return;
    const q = new URLSearchParams(location.search);
    q.delete('tour'); q.delete('t');
    const qs = q.toString();
    history.replaceState(history.state, '', location.pathname + (qs ? '?' + qs : ''));
    iniciar(pular);
  });

  window.__atlasTour = {
    iniciar, parar,
    duracao: DURACAO,
    estado: () => ({ ativo: !!run, cena: run?.cena ?? null, t: run ? (performance.now() - run.t0) / 1000 : 0, total: run?.total ?? DURACAO() }),
    dados: () => { const D = calcular(); D.artista = artistaDoTour(D); return D; },
  };
})();
