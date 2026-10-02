// Painel "Explorar": filtra os álbuns por características de áudio (andamento, dança, clima, timbre, volume…).
// Classic script: shares ui.js's global scope. Loaded after browse.js and acervo-features.js; everything runs at call time.
//
// Os valores por álbum vêm das features por faixa (<acervo>-features.json.gz): média das faixas analisadas
// (mediana para o andamento). O resultado vai para a grade por `activeAlbumSet`, como uma faceta a mais.
// data/resumo-acervo.json só entra no cabeçalho (totais do acervo).

let _exPanel, _exLayout, _exBody, _exBtn, _exSearch, _exApply;
let _exCarga = null;              // Promise do carregamento do acervo ativo
let _exDb = null;                 // db a que a carga se refere
let _exDados = null;              // { n, vals: {chave: Float32Array}, idx: Map<path, i>, analisados, resumo }
let _exFiltros = {};              // chave -> [lo, hi] (só os que estão fora do padrão)
let _exVoz = 'any';               // 'any' | 'com' | 'sem'
let _exQuery = '';
let _exCtl = {};                  // chave -> { lo, hi, out, hist, sec, def }
let _exRaf = 0;

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
    { k: 'acoustic', nome: 'Acústico', min: 0, max: 100, step: 1, un: '%' },
    { k: 'electronic', nome: 'Eletrônico', min: 0, max: 100, step: 1, un: '%' },
    { k: 'voice', nome: 'Voz', voz: true },
  ]],
  ['Som', false, [
    { k: 'loud', nome: 'Volume', min: -40, max: -5, step: 1, un: ' dB' },
    { k: 'dur', nome: 'Duração da faixa', min: 1, max: 8, step: 0.5, un: ' min' },
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
    const n = db.albums.length;
    const vals = {};
    for (const k of ['bpm', 'loud', 'dur', ...EX_PROBS]) vals[k] = new Float32Array(n).fill(NaN);
    const idx = new Map();
    let row = 0, analisados = 0;
    db.albums.forEach((a, i) => {
      idx.set(a.path.normalize('NFC'), i);
      const rows = [];
      for (let k = 0; k < a.tracks.length; k++, row++) if (f.has(row)) rows.push(row);
      if (!rows.length) return;
      analisados++;
      vals.bpm[i] = _exMediana(rows.map(r => f.bpm[r]));
      vals.loud[i] = -rows.reduce((s, r) => s + f.loud[r], 0) / rows.length;
      for (const k of EX_PROBS) vals[k][i] = (rows.reduce((s, r) => s + f[k][r], 0) / rows.length / 255) * 100;
      const ds = a.tracks.map(t => t.duration).filter(d => d > 0);
      if (ds.length) vals.dur[i] = ds.reduce((s, d) => s + d, 0) / ds.length / 60;
    });
    const rr = await _exBuscar('data/resumo-acervo.json');
    let resumo = null;
    try { resumo = (await rr?.json())?.acervos?.[key]?.catalogo || null; } catch { /* cabeçalho é opcional */ }
    return { n, vals, idx, analisados, resumo };
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

function _exPassa(i) {
  const v = _exDados.vals;
  for (const k in _exFiltros) {
    const x = v[k][i], [lo, hi] = _exFiltros[k];
    if (!(x >= lo && x <= hi)) return false;      // NaN (sem análise) também cai fora
  }
  if (_exVoz !== 'any') {
    const x = v.voice[i];
    if (!(_exVoz === 'com' ? x >= 50 : x < 50)) return false;
  }
  return true;
}

function _exFaixaTexto(d, lo, hi) {
  const f = x => (d.k === 'dur' ? String(x).replace('.', ',') : String(x)) + d.un;
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

function _exAplicar() {
  _exRaf = 0;
  if (!_exDados) return;
  const ativos = _exAtivos();
  if (!ativos.length) {
    if (activeAlbumSet) { activeAlbumSet = null; activeAlbumSetLabel = ''; filterAlbums(); }
  } else {
    resetFacets('features');
    const set = new Set();
    for (const a of albums) {
      const i = _exDados.idx.get(a.path.normalize('NFC'));
      if (i !== undefined && _exPassa(i)) set.add(a);
    }
    activeAlbumSet = set;
    activeAlbumSetLabel = ativos.length === 1 ? _exRotuloAtivo(ativos[0]) : `${ativos.length} características`;
    filterAlbums();
  }
  _exAtualizarRodape();
}

function _exAgendar() {
  _exAtualizarUI();
  if (!_exRaf) _exRaf = requestAnimationFrame(_exAplicar);
}

// Chamado por resetFacets() quando outra faceta passa a mandar na grade.
function explorarReset() {
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
  const arr = _exDados.vals[d.k];
  const bins = new Array(EX_BINS).fill(0);
  const todos = [];
  for (let i = 0; i < arr.length; i++) {
    const x = arr[i];
    if (x !== x) continue;
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
    const m = _exEl('div', 'ex-feat-med', `mediana ${(d.k === 'dur' ? med.toFixed(1).replace('.', ',') : Math.round(med))}${d.un}`);
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
    r.addEventListener('change', () => { _exVoz = v; _exAgendar(); });
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
  const faixas = d.resumo?.faixas_analisadas;
  cab.textContent = `${d.analisados.toLocaleString('pt-BR')} de ${d.n.toLocaleString('pt-BR')} álbuns com análise de áudio` +
    (faixas ? ` · ${faixas.toLocaleString('pt-BR')} faixas` : '');
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
      _exAgendar();
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
  const n = activeAlbumSet ? activeAlbumSet.size : null;
  _exApply.textContent = ativos && n !== null ? `ver ${n.toLocaleString('pt-BR')} álbum${n === 1 ? '' : 's'}` : 'ver todos os álbuns';
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

function openExplorar() {
  if (!_exPanel) return;
  closeBrowseDrawer();
  _exLayout.classList.add('explorar-mode');
  _exPanel.hidden = false;
  _exBtn?.setAttribute('aria-pressed', 'true');
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
  _exBtn?.setAttribute('aria-pressed', 'false');
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
  _exBtn?.addEventListener('click', toggleExplorar);
  document.getElementById('btn-explorar-close')?.addEventListener('click', closeExplorar);
  document.getElementById('browse-scrim')?.addEventListener('click', closeExplorar);
  document.getElementById('btn-browse')?.addEventListener('click', closeExplorar);
  _exApply?.addEventListener('click', () => { if (isMobile()) closeExplorar(); else document.getElementById('main-content')?.focus(); });
  _exSearch?.addEventListener('input', () => { _exQuery = _exSearch.value; if (_exDados) _exFiltrarGrupos(); });
  document.getElementById('explorar-clear')?.addEventListener('click', () => {
    _exSearch.value = ''; _exQuery = ''; if (_exDados) _exFiltrarGrupos(); _exSearch.focus();
  });
});
