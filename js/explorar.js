// Painel "Explorar": filtra os álbuns por características de áudio (andamento, dança, clima, timbre).
// Classic script: shares ui.js's global scope. Loaded after browse.js and acervo-features.js; everything runs at call time.
//
// As features são por faixa (<acervo>-features.json.gz). Uma faixa passa se todos os sliders a aceitam; o álbum aparece
// na grade se ao menos uma faixa passa (`activeAlbumSet`) e as demais faixas dele ficam desativadas (`trackFilter`).
// data/resumo-acervo.json só entra no cabeçalho (totais do acervo).

let _exPanel, _exLayout, _exBody, _exBtn, _exSearch, _exApply;
let _exCarga = null;              // Promise do carregamento do acervo ativo
let _exDb = null;                 // db a que a carga se refere
let _exDados = null;              // { f, n, analisados, faixasAnalisadas, resumo }
let _exFiltros = {};              // chave -> [lo, hi] (só os que estão fora do padrão)
let _exVoz = 'any';               // 'any' | 'com' | 'sem'
let _exQuery = '';
let _exCtl = {};                  // chave -> { lo, hi, out, reset, hist, d } | voice -> { grp }
let _exTimer = 0;

const EX_FECHADOS = 'tocador-explorar-fechados';   // grupos recolhidos (localStorage)

const EX_BINS = 24;
// `busca`: outras palavras que a busca do painel aceita para a característica.
const EX_GRUPOS = [
  ['Ritmo', true, [
    { k: 'bpm', nome: 'Andamento', min: 40, max: 200, step: 1, un: ' bpm', busca: 'bpm tempo velocidade rapido lento' },
    { k: 'dance', nome: 'Dançabilidade', min: 0, max: 100, step: 1, un: '%', busca: 'dancar dancante' },
    { k: 'party', nome: 'Festa', min: 0, max: 100, step: 1, un: '%', busca: 'animado' },
  ]],
  ['Clima', true, [
    { k: 'happy', nome: 'Alegre', min: 0, max: 100, step: 1, un: '%', busca: 'feliz humor' },
    { k: 'sad', nome: 'Triste', min: 0, max: 100, step: 1, un: '%', busca: 'melancolico humor' },
    { k: 'relaxed', nome: 'Relaxante', min: 0, max: 100, step: 1, un: '%', busca: 'calmo tranquilo humor' },
    { k: 'aggressive', nome: 'Agressivo', min: 0, max: 100, step: 1, un: '%', busca: 'pesado raiva humor' },
  ]],
  ['Timbre', true, [
    { k: 'voice', nome: 'Voz', voz: true, busca: 'vocal cantada instrumental' },
    { k: 'acoustic', nome: 'Acústico', min: 0, max: 100, step: 1, un: '%', busca: 'acustico' },
    { k: 'electronic', nome: 'Eletrônico', min: 0, max: 100, step: 1, un: '%', busca: 'eletronico sintetizador' },
  ]],
];
const EX_PROBS = ['voice', 'dance', 'acoustic', 'electronic', 'happy', 'sad', 'relaxed', 'aggressive', 'party'];

function isExplorarOpen() { return !!_exLayout?.classList.contains('explorar-mode'); }

async function _exBuscar(rel) {
  if (/^https?:/.test(rel)) { try { const r = await fetch(rel); return r.ok ? r : null; } catch { return null; } }
  for (const base of [APP_ROOT, `${SITE_ORIGIN}/`]) {
    try { const r = await fetch(base + rel); if (r.ok) return r; } catch { /* tenta a próxima origem */ }
  }
  return null;
}

async function _exGz(resp) {
  return JSON.parse(await new Response(resp.body.pipeThrough(new DecompressionStream('gzip'))).text());
}

const _exPl = (x, um, varios) => `${x.toLocaleString('pt-BR')} ${x === 1 ? um : varios}`;
const _exMediana = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// Nunca lança: sem features publicadas (espelhos, ?acervo=<url>) o painel só avisa.
function _exCarregar() {
  if (_exCarga && _exDb === db) return _exCarga;
  _exDb = db;
  _exCarga = (async () => {
    const key = typeof activeAcervoKey !== 'undefined' ? activeAcervoKey : null;
    const urls = [db?.meta?.features_url, key && `data/${key}-features.json.gz`].filter(Boolean);
    let f = null;
    for (const u of urls) {
      const r = await _exBuscar(u);
      if (!r) continue;
      try {
        const keys = [];
        for (const a of db.albums) for (const t of a.tracks) keys.push(`${a.path}/${t.file}`.normalize('NFC'));
        f = decodeFeatures(await _exGz(r), keys);
        break;
      } catch (e) { console.warn('features ignoradas:', e.message); }
    }
    if (!f) return null;
    // A linha de features é por faixa: marca cada faixa do catálogo com a sua (`_row`), que as faixas da
    // grade alcançam por `track.src._row`. Um álbum só vira "analisado" se tiver ao menos uma faixa analisada.
    let row = 0, analisados = 0;
    for (const a of db.albums) {
      let tem = false;
      for (const t of a.tracks) { t._row = row; if (f.has(row)) tem = true; row++; }
      if (tem) analisados++;
    }
    let faixasAnalisadas = 0;
    for (let r = 0; r < f.n; r++) if (f.has(r)) faixasAnalisadas++;
    const rr = await _exBuscar('data/resumo-acervo.json');
    let resumo = null;
    try { resumo = (await rr?.json())?.acervos?.[key]?.catalogo || null; } catch { /* cabeçalho é opcional */ }
    return { f, n: db.albums.length, analisados, faixasAnalisadas, resumo };
  })();
  return _exCarga;
}

// ── estado dos filtros ──────────────────────────────────────────────────────────────

function _exAtivos() {
  const out = [];
  for (const [grupo, , defs] of EX_GRUPOS) for (const d of defs) {
    if (d.voz) { if (_exVoz !== 'any') out.push(d); continue; }
    if (_exFiltros[d.k]) out.push(d);
  }
  return out;
}

// Valor de uma característica numa faixa (linha r): probabilidades em 0–100, andamento em bpm.
function _exValor(k, r) {
  const f = _exDados.f;
  return k === 'bpm' ? f.bpm[r] : (f[k][r] * 100) / 255;
}

// Faixa sem análise nunca passa quando há filtro.
function _exPassaFaixa(r) {
  const f = _exDados.f;
  if (r === undefined || !f.has(r)) return false;
  for (const k in _exFiltros) {
    const x = _exValor(k, r), [lo, hi] = _exFiltros[k];
    if (x < lo || x > hi) return false;
  }
  if (_exVoz !== 'any') {
    const x = _exValor('voice', r);
    if (!(_exVoz === 'com' ? x >= 50 : x < 50)) return false;
  }
  return true;
}

function _exFaixaTexto(d, lo, hi) {
  const f = x => String(x) + d.un;
  if (lo <= d.min && hi >= d.max) return 'qualquer';
  if (lo <= d.min) return `até ${f(hi)}`;
  if (hi >= d.max) return `${f(lo)}+`;
  return `${f(lo)} – ${f(hi)}`;
}

function _exRotuloAtivo(d) {
  if (d.voz) return _exVoz === 'com' ? 'Com voz' : 'Instrumental';
  const [lo, hi] = _exFiltros[d.k];
  return `${d.nome} ${_exFaixaTexto(d, lo, hi)}`;
}

// A lista de faixas do álbum aberto (e a da gaveta mobile) mostra as faixas fora do filtro desativadas.
function _exRefazerFaixas() {
  if (!selectedAlbum) return;
  renderedAlbum = null;
  renderTrackList();
  renderMobileDrawer(selectedAlbum);
}

// A contagem do rodapé acompanha o arrasto na hora; a grade só troca quando o arrasto dá uma pausa
// (e sem a animação de entrada), senão os álbuns piscam a cada passo do slider.
function _exCalcular() {
  const set = new Set();
  let faixas = 0;
  for (const a of albums) {
    let n = 0;
    for (const t of a.tracks) if (_exPassaFaixa(t.src._row)) n++;
    if (n) { set.add(a); faixas += n; }
  }
  return { set, faixas };
}

function _exAplicar(quiet) {
  clearTimeout(_exTimer);
  if (!_exDados) return;
  const ativos = _exAtivos();
  if (!ativos.length) {
    trackFilter = null;
    if (activeAlbumSet) { activeAlbumSet = null; activeAlbumSetLabel = ''; filterAlbums(quiet); }
  } else {
    resetFacets('features');
    activeAlbumSet = _exCalcular().set;
    trackFilter = t => _exPassaFaixa(t.src._row);
    activeAlbumSetLabel = ativos.length === 1 ? _exRotuloAtivo(ativos[0]) : `${ativos.length} características`;
    filterAlbums(quiet);
  }
  _exRefazerFaixas();
  const c = _exAtualizarContagem();
  _exSugerir(c);
  _exAnunciar(c);
}

function _exAgendar(imediato) {
  _exAtualizarUI();
  clearTimeout(_exTimer);
  if (imediato) { _exAplicar(false); return; }
  _exAtualizarContagem();
  _exTimer = setTimeout(() => _exAplicar(true), 160);
}

// Leitor de tela: só depois que a grade troca, para não narrar cada passo do arrasto.
function _exAnunciar(c) {
  const el = document.getElementById('explorar-anuncio');
  if (!el) return;
  el.textContent = !c ? 'Sem filtros: todos os álbuns.'
    : c.set.size ? `${_exPl(c.set.size, 'álbum', 'álbuns')} e ${_exPl(c.faixas, 'faixa', 'faixas')} passam nos filtros.`
    : 'Nenhuma faixa passa em todos os filtros.';
}

// Grade vazia: diz quanto cada filtro, se tirado, devolveria. Só depois do arrasto (custa uma passada por filtro).
function _exSugerir(c) {
  const box = document.getElementById('explorar-sugestoes');
  if (!box) return;
  box.replaceChildren();
  if (!c || c.set.size) { box.hidden = true; return; }
  const opcoes = [];
  for (const d of _exAtivos()) {
    const salvo = d.voz ? _exVoz : _exFiltros[d.k];
    if (d.voz) _exVoz = 'any'; else delete _exFiltros[d.k];
    const n = _exCalcular().set.size;
    if (d.voz) _exVoz = salvo; else _exFiltros[d.k] = salvo;
    if (n) opcoes.push([d, n]);
  }
  if (!opcoes.length) { box.hidden = true; return; }
  box.hidden = false;
  box.append(_exEl('span', null, 'Tire um filtro:'));
  for (const [d, n] of opcoes.sort((a, b) => b[1] - a[1]).slice(0, 3)) {
    const b = _exEl('button', 'ex-sugestao', `${_exRotuloAtivo(d)} → ${_exPl(n, 'álbum', 'álbuns')}`);
    b.type = 'button';
    b.setAttribute('aria-label', `Remover ${_exRotuloAtivo(d)}: ${_exPl(n, 'álbum', 'álbuns')}`);
    b.addEventListener('click', () => _exRemover(d));
    box.append(b);
  }
}

function _exRemover(d) {
  if (d.voz) _exVoz = 'any'; else delete _exFiltros[d.k];
  _exSincronizar();
  _exAgendar(true);
}

// Chamado por resetFacets() quando outra faceta passa a mandar na grade.
function explorarReset() {
  clearTimeout(_exTimer);
  const tinha = !!trackFilter;
  trackFilter = null;
  if (tinha) _exRefazerFaixas();
  _exFiltros = {};
  _exVoz = 'any';
  if (_exDados) { _exSincronizar(); _exAtualizarUI(); _exAtualizarContagem(); _exSugerir(null); }
}

function explorarLimparTudo() {
  explorarReset();
  if (activeAlbumSet) { activeAlbumSet = null; activeAlbumSetLabel = ''; filterAlbums(); }
}

// ── interface ───────────────────────────────────────────────────────────────────────

function _exEl(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}

function _exSlider(d) {
  const bins = new Array(EX_BINS).fill(0);
  const todos = [];
  for (let r = 0; r < _exDados.f.n; r++) {
    if (!_exDados.f.has(r)) continue;
    const x = _exValor(d.k, r);
    todos.push(x);
    const b = Math.floor(((Math.min(Math.max(x, d.min), d.max) - d.min) / (d.max - d.min)) * EX_BINS);
    bins[Math.min(EX_BINS - 1, b)]++;
  }
  const maxBin = Math.max(1, ...bins);
  const med = todos.length ? _exMediana(todos) : null;

  const sec = _exEl('div', 'ex-feat');
  sec.dataset.busca = `${d.nome} ${d.busca || ''}`;
  const head = _exEl('div', 'ex-feat-head');
  head.append(_exEl('span', 'ex-feat-nome', d.nome));
  const out = _exEl('span', 'ex-feat-out', 'qualquer');
  const reset = _exEl('button', 'ex-feat-reset', '✕');
  reset.type = 'button';
  reset.hidden = true;
  reset.title = 'Voltar a qualquer valor';
  reset.setAttribute('aria-label', `Limpar ${d.nome}`);
  reset.addEventListener('click', () => { _exRemover(d); lo.focus(); });
  head.append(out, reset);
  const hist = _exEl('div', 'ex-hist');
  hist.setAttribute('aria-hidden', 'true');
  bins.forEach(c => { const b = _exEl('i'); b.style.height = `${Math.max(4, Math.round((c / maxBin) * 100))}%`; hist.append(b); });
  if (med !== null) {
    const m = _exEl('b', 'ex-hist-med');
    m.style.left = `${((Math.min(Math.max(med, d.min), d.max) - d.min) / (d.max - d.min)) * 100}%`;
    hist.append(m);
  }
  const wrap = _exEl('div', 'ex-range');
  const mk = (cls, v, label) => {
    const r = _exEl('input', cls);
    r.type = 'range'; r.min = d.min; r.max = d.max; r.step = d.step; r.value = v;
    r.setAttribute('aria-label', `${d.nome}, ${label}`);
    return r;
  };
  const lo = mk('ex-lo', d.min, 'mínimo');
  const hi = mk('ex-hi', d.max, 'máximo');
  const mudou = (quem) => {
    let a = Number(lo.value), b = Number(hi.value);
    if (a > b) { if (quem === lo) { a = b; lo.value = a; } else { b = a; hi.value = b; } }
    if (a <= d.min && b >= d.max) delete _exFiltros[d.k]; else _exFiltros[d.k] = [a, b];
    _exAgendar();
  };
  // Setas andam de 1 em 1; PageUp/PageDown e Shift+seta de 10 em 10; Delete volta a "qualquer".
  const teclas = e => {
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); _exRemover(d); return; }
    const dir = { PageUp: 1, PageDown: -1 }[e.key] ??
      (e.shiftKey ? { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key] : undefined);
    if (!dir) return;
    e.preventDefault();
    const r = e.currentTarget;
    r.value = Math.min(d.max, Math.max(d.min, Number(r.value) + dir * 10 * d.step));
    mudou(r);
  };
  for (const r of [lo, hi]) { r.addEventListener('input', () => mudou(r)); r.addEventListener('keydown', teclas); }
  wrap.append(_exEl('div', 'ex-track'), lo, hi);
  sec.append(head, hist, wrap);
  if (med !== null) sec.append(_exEl('div', 'ex-feat-med', `mediana ${Math.round(med)}${d.un}`));
  _exCtl[d.k] = { lo, hi, out, reset, hist, d };
  return sec;
}

function _exVozCtl() {
  const sec = _exEl('div', 'ex-feat');
  sec.dataset.busca = 'Voz vocal cantada instrumental tanto faz';
  const head = _exEl('div', 'ex-feat-head');
  head.append(_exEl('span', 'ex-feat-nome', 'Voz'));
  sec.append(head);
  const grp = _exEl('div', 'ex-radios');
  grp.setAttribute('role', 'radiogroup');
  grp.setAttribute('aria-label', 'Voz');
  for (const [v, t] of [['any', 'tanto faz'], ['com', 'com voz'], ['sem', 'instrumental']]) {
    const lab = _exEl('label', 'ex-radio');
    const r = _exEl('input'); r.type = 'radio'; r.name = 'ex-voz'; r.value = v; r.checked = v === _exVoz;
    r.addEventListener('change', () => { _exVoz = v; _exAgendar(true); });
    lab.append(r, _exEl('span', null, t));
    grp.append(lab);
  }
  sec.append(grp);
  sec.append(_exEl('div', 'ex-feat-med', 'faixa com voz = 50% ou mais de chance de canto'));
  _exCtl.voice = { sec, grp };
  return sec;
}

function _exLerFechados() {
  try { return new Set(JSON.parse(localStorage.getItem(EX_FECHADOS) || '[]')); } catch { return new Set(); }
}

function _exGravarFechados() {
  const fechados = [..._exBody.querySelectorAll('.explorar-sec')].filter(s => !s.open).map(s => s.dataset.grupo);
  try { localStorage.setItem(EX_FECHADOS, JSON.stringify(fechados)); } catch { /* só conveniência */ }
}

function _exConstruir() {
  _exBody.replaceChildren();
  _exCtl = {};
  const d = _exDados;
  // Topo fixo: contagem viva, chips e sugestões ficam à vista enquanto os controles rolam.
  const topo = _exEl('div', 'ex-topo');
  const status = _exEl('div', 'ex-status');
  status.id = 'explorar-status';
  const anuncio = _exEl('div', 'sr-only');
  anuncio.id = 'explorar-anuncio';
  anuncio.setAttribute('role', 'status');
  const chips = _exEl('div', 'ex-chips');
  chips.id = 'explorar-chips';
  const sug = _exEl('div', 'ex-sugestoes');
  sug.id = 'explorar-sugestoes';
  sug.hidden = true;
  topo.append(status, chips, sug, anuncio);
  const ajuda = _exEl('p', 'ex-ajuda',
    'Filtra por faixa: o álbum aparece se uma faixa passar em todos os filtros; as outras ficam apagadas na lista dele.');
  const cab = _exEl('div', 'ex-resumo');
  cab.textContent = `${d.analisados.toLocaleString('pt-BR')} de ${d.n.toLocaleString('pt-BR')} álbuns com análise de áudio · ` +
    `${d.faixasAnalisadas.toLocaleString('pt-BR')} faixas`;
  const vazio = _exEl('p', 'explorar-empty ex-busca-vazia');
  vazio.id = 'explorar-busca-vazia';
  vazio.hidden = true;
  _exBody.append(topo, ajuda, cab, vazio);
  const fechados = _exLerFechados();
  for (const [nome, aberto, defs] of EX_GRUPOS) {
    const det = _exEl('details', 'explorar-sec');
    det.open = aberto && !fechados.has(nome);
    det.dataset.grupo = nome;
    const sum = _exEl('summary');
    sum.append(_exEl('span', null, nome), _exEl('span', 'ex-sec-n'));
    det.append(sum);
    for (const def of defs) det.append(def.voz ? _exVozCtl() : _exSlider(def));
    // A busca abre grupos sozinha; isso não conta como escolha do usuário.
    det.addEventListener('toggle', () => { if (!_exQuery) _exGravarFechados(); });
    _exBody.append(det);
  }
  _exSincronizar();
  _exFiltrarGrupos();
}

// Valores dos controles a partir do estado (_exFiltros/_exVoz).
function _exSincronizar() {
  for (const k in _exCtl) {
    const c = _exCtl[k];
    if (k === 'voice') { c.grp.querySelectorAll('input').forEach(r => { r.checked = r.value === _exVoz; }); continue; }
    const [a, b] = _exFiltros[k] || [c.d.min, c.d.max];
    c.lo.value = a; c.hi.value = b;
  }
}

function _exAtualizarUI() {
  for (const k in _exCtl) {
    const c = _exCtl[k];
    if (k === 'voice') continue;
    const a = Number(c.lo.value), b = Number(c.hi.value), d = c.d;
    c.out.textContent = _exFaixaTexto(d, a, b);
    c.out.classList.toggle('on', !!_exFiltros[k]);
    c.reset.hidden = !_exFiltros[k];
    c.lo.setAttribute('aria-valuetext', a <= d.min ? 'sem limite' : `${a}${d.un}`);
    c.hi.setAttribute('aria-valuetext', b >= d.max ? 'sem limite' : `${b}${d.un}`);
    // Alças juntas na ponta de cima: a de baixo vem para a frente, senão fica presa sob a outra.
    c.lo.style.zIndex = a > (d.min + d.max) / 2 ? 2 : '';
    const pa = (a - d.min) / (d.max - d.min), pb = (b - d.min) / (d.max - d.min);
    c.lo.parentElement.style.setProperty('--a', `${pa * 100}%`);
    c.lo.parentElement.style.setProperty('--b', `${pb * 100}%`);
    [...c.hist.children].forEach((bar, i) => {
      const m = (i + 0.5) / EX_BINS;
      bar.classList.toggle('in', m >= pa && m <= pb);
    });
  }
  const ativos = _exAtivos();
  _exBody.querySelectorAll('.explorar-sec').forEach(sec => {
    const grupo = EX_GRUPOS.find(g => g[0] === sec.dataset.grupo);
    const n = grupo ? grupo[2].filter(d => ativos.includes(d)).length : 0;
    const el = sec.querySelector('.ex-sec-n');
    el.textContent = n ? String(n) : '';
    el.setAttribute('aria-label', n ? `${_exPl(n, 'filtro ativo', 'filtros ativos')}` : '');
  });
  const chips = document.getElementById('explorar-chips');
  if (!chips) return;
  chips.replaceChildren();
  for (const d of ativos) {
    const b = _exEl('button', 'ex-chip', _exRotuloAtivo(d) + ' ✕');
    b.type = 'button';
    b.setAttribute('aria-label', `Remover filtro ${_exRotuloAtivo(d)}`);
    b.addEventListener('click', () => _exRemover(d));
    chips.append(b);
  }
  if (chips.children.length) {
    const l = _exEl('button', 'ex-chip ex-chip-limpar', 'limpar tudo');
    l.type = 'button';
    l.addEventListener('click', () => { explorarLimparTudo(); });
    chips.append(l);
  }
}

// Contagem viva (acompanha o arrasto): topo do painel e, no mobile, o botão do rodapé. Devolve o cálculo.
function _exAtualizarContagem() {
  if (!_exDados) { if (_exApply) _exApply.hidden = true; return null; }
  const c = _exAtivos().length ? _exCalcular() : null;
  const st = document.getElementById('explorar-status');
  if (st) {
    st.classList.toggle('vazio', !!c && !c.set.size);
    st.classList.toggle('on', !!c);
    st.textContent = !c ? `${_exPl(_exDados.n, 'álbum', 'álbuns')} · nenhum filtro`
      : c.set.size ? `${_exPl(c.set.size, 'álbum', 'álbuns')} · ${_exPl(c.faixas, 'faixa', 'faixas')} passam`
      : 'Nenhuma faixa passa em todos os filtros';
  }
  if (c?.set.size) document.getElementById('explorar-sugestoes')?.setAttribute('hidden', '');
  if (_exApply) {
    _exApply.hidden = false;
    _exApply.textContent = !c ? 'ver todos os álbuns'
      : c.set.size ? `ver ${_exPl(c.set.size, 'álbum', 'álbuns')} · ${_exPl(c.faixas, 'faixa', 'faixas')}`
      : 'nenhum álbum passa nos filtros';
  }
  return c;
}

// Busca por nome da característica, sinônimo (`busca`) ou nome do grupo. Sem busca, os grupos voltam ao estado salvo.
function _exFiltrarGrupos() {
  const q = fold(_exQuery.trim());
  const fechados = q ? null : _exLerFechados();
  let total = 0;
  _exBody.querySelectorAll('.explorar-sec').forEach(sec => {
    const doGrupo = !!q && fold(sec.dataset.grupo).includes(q);
    let alguma = false;
    sec.querySelectorAll('.ex-feat').forEach(f => {
      const ok = !q || doGrupo || fold(f.dataset.busca || '').includes(q);
      f.hidden = !ok;
      if (ok) { alguma = true; total++; }
    });
    sec.hidden = !alguma;
    if (q && alguma) sec.open = true;
    else if (fechados) sec.open = !fechados.has(sec.dataset.grupo);
  });
  const vazio = document.getElementById('explorar-busca-vazia');
  if (vazio) {
    vazio.hidden = !!total;
    vazio.textContent = total ? '' : `Nenhuma característica com “${_exQuery.trim()}”. Tente andamento, voz, alegre…`;
  }
}

async function renderExplorar() {
  if (!_exBody) return;
  if (!_exDados || _exDb !== db) {
    const p = _exEl('p', 'explorar-empty explorar-carregando', 'Carregando a análise de áudio…');
    p.setAttribute('role', 'status');
    _exBody.replaceChildren(p);
    if (_exApply) _exApply.hidden = true;
  }
  const dados = await _exCarregar();
  if (!isExplorarOpen()) return;
  if (!dados) {
    _exDados = null;
    _exBody.replaceChildren(_exEl('p', 'explorar-empty', 'Este acervo ainda não tem análise de áudio publicada, então não dá para filtrar por características.'));
    _exAtualizarContagem();
    return;
  }
  if (dados !== _exDados) { _exFiltros = {}; _exVoz = 'any'; _exDados = dados; _exConstruir(); }
  else if (!_exBody.querySelector('.ex-feat')) _exConstruir();
  _exAtualizarUI();
  _exAtualizarContagem();
}

// A faixa de abas daqui espelha a do painel de navegação (a aba Gêneros só existe com índice de gêneros).
function _exSincronizarAbas() {
  const g = document.querySelector('.browse-tab[data-tab="genres"]');
  const mine = _exPanel?.querySelector('[data-ex-tab="genres"]');
  if (g && mine) { mine.hidden = g.hidden; mine.disabled = g.disabled; }
}

function openExplorar() {
  if (!_exPanel) return;
  closeBrowseDrawer();
  _exLayout.classList.add('explorar-mode');
  _exPanel.hidden = false;
  _exSincronizarAbas();
  if (isMobile()) {
    _exPanel.classList.add('open');
    document.getElementById('browse-scrim')?.classList.add('open');
  }
  renderExplorar();
  // No mobile, focar a busca abriria o teclado virtual por cima dos controles.
  if (isMobile()) _exPanel.querySelector('.ex-tab.active')?.focus({ preventScroll: true });
  else _exSearch?.focus();
}

function closeExplorar() {
  if (!_exPanel || !isExplorarOpen()) return;
  _exLayout.classList.remove('explorar-mode');
  _exPanel.hidden = true;
  _exPanel.classList.remove('open');
  document.getElementById('browse-scrim')?.classList.remove('open');
  _exBtn?.focus();
}

function toggleExplorar() { isExplorarOpen() ? closeExplorar() : openExplorar(); }

document.addEventListener('DOMContentLoaded', () => {
  _exPanel = document.getElementById('explorar-panel');
  _exLayout = document.querySelector('.app-layout');
  _exBody = document.getElementById('explorar-body');
  _exBtn = document.getElementById('btn-explorar');
  _exSearch = document.getElementById('explorar-search');
  _exApply = document.getElementById('explorar-apply');
  _exBtn?.addEventListener('click', openExplorar);
  _exPanel?.querySelectorAll('[data-ex-tab]').forEach(b => b.addEventListener('click', () => {
    if (b.disabled) return;
    closeExplorar();
    if (isMobile()) openBrowseDrawer();
    switchBrowseTab(b.dataset.exTab);
  }));
  document.getElementById('btn-explorar-close')?.addEventListener('click', closeExplorar);
  document.getElementById('browse-scrim')?.addEventListener('click', closeExplorar);
  document.getElementById('btn-browse')?.addEventListener('click', closeExplorar);
  _exApply?.addEventListener('click', () => { if (isMobile()) closeExplorar(); else document.getElementById('main-content')?.focus(); });
  _exSearch?.addEventListener('input', () => { _exQuery = _exSearch.value; if (_exDados) _exFiltrarGrupos(); });
  document.getElementById('explorar-clear')?.addEventListener('click', () => {
    _exSearch.value = ''; _exQuery = ''; if (_exDados) _exFiltrarGrupos(); _exSearch.focus();
  });
  // Enter na busca leva ao primeiro controle que sobrou.
  _exSearch?.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    _exBody.querySelector('.ex-feat:not([hidden]) input')?.focus();
  });
});
