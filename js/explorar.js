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
let _exCtl = {};                  // chave -> { lo, hi, out, hist, sec, def }
let _exTimer = 0;

const EX_BINS = 24;
const EX_GRUPOS = [
  ['Ritmo', true, [
    { k: 'bpm', nome: 'Andamento', min: 40, max: 200, step: 1, un: ' bpm' },
    { k: 'dance', nome: 'Dançabilidade', min: 0, max: 100, step: 1, un: '%' },
    { k: 'party', nome: 'Festa', min: 0, max: 100, step: 1, un: '%' },
  ]],
  ['Clima', true, [
    { k: 'happy', nome: 'Alegre', min: 0, max: 100, step: 1, un: '%' },
    { k: 'sad', nome: 'Triste', min: 0, max: 100, step: 1, un: '%' },
    { k: 'relaxed', nome: 'Relaxante', min: 0, max: 100, step: 1, un: '%' },
    { k: 'aggressive', nome: 'Agressivo', min: 0, max: 100, step: 1, un: '%' },
  ]],
  ['Timbre', true, [
    { k: 'voice', nome: 'Voz', voz: true },
    { k: 'acoustic', nome: 'Acústico', min: 0, max: 100, step: 1, un: '%' },
    { k: 'electronic', nome: 'Eletrônico', min: 0, max: 100, step: 1, un: '%' },
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
  _exAtualizarRodape();
}

function _exAgendar(imediato) {
  _exAtualizarUI();
  clearTimeout(_exTimer);
  if (imediato) { _exAplicar(false); return; }
  _exAtualizarRodape();
  _exTimer = setTimeout(() => _exAplicar(true), 160);
}

// Chamado por resetFacets() quando outra faceta passa a mandar na grade.
function explorarReset() {
  clearTimeout(_exTimer);
  const tinha = !!trackFilter;
  trackFilter = null;
  if (tinha) _exRefazerFaixas();
  _exFiltros = {};
  _exVoz = 'any';
  if (_exDados) { _exSincronizar(); _exAtualizarUI(); _exAtualizarRodape(); }
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
  const head = _exEl('div', 'ex-feat-head');
  head.append(_exEl('span', 'ex-feat-nome', d.nome));
  const out = _exEl('span', 'ex-feat-out', 'qualquer');
  head.append(out);
  const hist = _exEl('div', 'ex-hist');
  hist.setAttribute('aria-hidden', 'true');
  bins.forEach(c => { const b = _exEl('i'); b.style.height = `${Math.max(4, Math.round((c / maxBin) * 100))}%`; hist.append(b); });
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
  lo.addEventListener('input', () => mudou(lo));
  hi.addEventListener('input', () => mudou(hi));
  wrap.append(_exEl('div', 'ex-track'), lo, hi);
  sec.append(head, hist, wrap);
  if (med !== null) {
    const m = _exEl('div', 'ex-feat-med', `mediana ${Math.round(med)}${d.un}`);
    sec.append(m);
  }
  _exCtl[d.k] = { lo, hi, out, hist, d };
  return sec;
}

function _exVozCtl() {
  const sec = _exEl('div', 'ex-feat');
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
  _exCtl.voice = { sec, grp };
  return sec;
}

function _exConstruir() {
  _exBody.replaceChildren();
  _exCtl = {};
  const d = _exDados;
  const cab = _exEl('div', 'ex-resumo');
  cab.textContent = `${d.analisados.toLocaleString('pt-BR')} de ${d.n.toLocaleString('pt-BR')} álbuns com análise de áudio · ` +
    `${d.faixasAnalisadas.toLocaleString('pt-BR')} faixas`;
  const chips = _exEl('div', 'ex-chips');
  chips.id = 'explorar-chips';
  _exBody.append(cab, chips);
  for (const [nome, aberto, defs] of EX_GRUPOS) {
    const det = _exEl('details', 'explorar-sec');
    det.open = aberto;
    det.dataset.grupo = nome;
    det.append(_exEl('summary', null, nome));
    for (const def of defs) det.append(def.voz ? _exVozCtl() : _exSlider(def));
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
    const pa = (a - d.min) / (d.max - d.min), pb = (b - d.min) / (d.max - d.min);
    c.lo.parentElement.style.setProperty('--a', `${pa * 100}%`);
    c.lo.parentElement.style.setProperty('--b', `${pb * 100}%`);
    [...c.hist.children].forEach((bar, i) => {
      const m = (i + 0.5) / EX_BINS;
      bar.classList.toggle('in', m >= pa && m <= pb);
    });
  }
  const chips = document.getElementById('explorar-chips');
  if (!chips) return;
  chips.replaceChildren();
  for (const d of _exAtivos()) {
    const b = _exEl('button', 'ex-chip', _exRotuloAtivo(d) + ' ✕');
    b.type = 'button';
    b.setAttribute('aria-label', `Remover filtro ${_exRotuloAtivo(d)}`);
    b.addEventListener('click', () => {
      if (d.voz) _exVoz = 'any'; else delete _exFiltros[d.k];
      _exSincronizar();
      _exAgendar(true);
    });
    chips.append(b);
  }
  if (chips.children.length) {
    const l = _exEl('button', 'ex-chip ex-chip-limpar', 'limpar tudo');
    l.type = 'button';
    l.addEventListener('click', () => { explorarLimparTudo(); });
    chips.append(l);
  }
}

function _exAtualizarRodape() {
  if (!_exApply) return;
  const ativos = _exAtivos().length;
  if (!_exDados) { _exApply.hidden = true; return; }
  _exApply.hidden = false;
  const c = !ativos ? null : _exCalcular();
  const n = c ? c.set.size : null;
  const pl = (x, um, varios) => `${x.toLocaleString('pt-BR')} ${x === 1 ? um : varios}`;
  _exApply.textContent = c ? `ver ${pl(n, 'álbum', 'álbuns')} · ${pl(c.faixas, 'faixa', 'faixas')}` : 'ver todos os álbuns';
}

function _exFiltrarGrupos() {
  const q = fold(_exQuery);
  _exBody.querySelectorAll('.explorar-sec').forEach(sec => {
    let alguma = false;
    sec.querySelectorAll('.ex-feat').forEach(f => {
      const ok = !q || fold(f.querySelector('.ex-feat-nome')?.textContent || '').includes(q);
      f.hidden = !ok;
      alguma ||= ok;
    });
    sec.hidden = !alguma;
    if (q && alguma) sec.open = true;
  });
}

async function renderExplorar() {
  if (!_exBody) return;
  const dados = await _exCarregar();
  if (!isExplorarOpen()) return;
  if (!dados) {
    _exDados = null;
    _exBody.replaceChildren(_exEl('p', 'explorar-empty', 'Este acervo ainda não tem análise de áudio publicada, então não dá para filtrar por características.'));
    _exAtualizarRodape();
    return;
  }
  if (dados !== _exDados) { _exFiltros = {}; _exVoz = 'any'; _exDados = dados; _exConstruir(); }
  _exAtualizarUI();
  _exAtualizarRodape();
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
  _exSearch?.focus();
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
});
