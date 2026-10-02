// Painel "Explorar": navega pelo data/resumo-acervo.json (agregado por acervo).
// Classic script: shares ui.js's global scope. Loaded after browse.js; everything runs at call time.
//
// Só o que cada álbum carrega (ano/década, artista) filtra a grade. Andamento, humor, tom e
// instrumentos vêm das features por faixa, que o resumo só agrega: ficam como leitura.

let _explorarPanel, _explorarLayout, _explorarBody, _explorarBtn, _explorarSearch;
let _resumoPromise = null;
let _explorarKey = null;
let _explorarQuery = '';

const EXPLORAR_FEATURES = [
  ['dance', 'dança'], ['happy', 'alegre'], ['sad', 'triste'], ['relaxed', 'relaxante'],
  ['acoustic', 'acústico'], ['electronic', 'eletrônico'], ['voice', 'voz'],
];

function isExplorarOpen() { return !!_explorarLayout?.classList.contains('explorar-mode'); }

function _carregarResumo() {
  if (_resumoPromise) return _resumoPromise;
  const urls = [`${APP_ROOT}data/resumo-acervo.json`, `${SITE_ORIGIN}/data/resumo-acervo.json`];
  _resumoPromise = (async () => {
    for (const u of urls) {
      try {
        const r = await fetch(u);
        if (r.ok) return await r.json();
      } catch (_) { /* tenta a próxima origem */ }
    }
    return null;
  })();
  return _resumoPromise;
}

function openExplorar() {
  if (!_explorarPanel) return;
  closeBrowseDrawer();
  _explorarLayout.classList.add('explorar-mode');
  _explorarPanel.hidden = false;
  _explorarBtn?.setAttribute('aria-pressed', 'true');
  if (isMobile()) {
    _explorarPanel.classList.add('open');
    document.getElementById('browse-scrim')?.classList.add('open');
  }
  renderExplorar();
  _explorarSearch?.focus();
}

function closeExplorar() {
  if (!_explorarPanel || !isExplorarOpen()) return;
  _explorarLayout.classList.remove('explorar-mode');
  _explorarPanel.hidden = true;
  _explorarPanel.classList.remove('open');
  document.getElementById('browse-scrim')?.classList.remove('open');
  _explorarBtn?.setAttribute('aria-pressed', 'false');
  _explorarBtn?.focus();
}

function toggleExplorar() { isExplorarOpen() ? closeExplorar() : openExplorar(); }

function _explorarEscolheu() {
  renderExplorar();
  if (isMobile()) setTimeout(closeExplorar, 180);
}

function explorarSetDecade(d) {
  const same = activeDecade === d;
  resetFacets(same ? undefined : 'decade');
  activeDecade = same ? null : d;
  document.querySelectorAll('.decade-btn').forEach(b => {
    b.classList.toggle('active', activeDecade === null ? b.dataset.decade === 'all' : b.dataset.decade === String(d));
  });
  filterAlbums();
  _explorarEscolheu();
}

function explorarSetYear(y) {
  const same = activeYear === y;
  resetFacets(same ? undefined : 'year');
  activeYear = same ? 0 : y;
  updateYearInUrl(activeYear);
  filterAlbums();
  _explorarEscolheu();
}

function explorarSetArtist(nome) {
  const same = activeArtist === nome;
  resetFacets(same ? undefined : 'artist');
  activeArtist = same ? null : nome;
  updateBrowseFilterInUrl();
  filterAlbums();
  updateBrowseSelection();
  _explorarEscolheu();
}

// Uma linha: rótulo, barra proporcional e contagem. `onClick` ausente = só leitura.
function _explorarLinha(rotulo, n, max, onClick, ativa, larga) {
  const el = document.createElement(onClick ? 'button' : 'div');
  el.className = 'explorar-row' + (onClick ? ' is-link' : '') + (ativa ? ' active' : '') + (larga ? ' wide' : '');
  if (onClick) { el.type = 'button'; el.addEventListener('click', onClick); el.setAttribute('aria-pressed', String(!!ativa)); }
  const l = document.createElement('span'); l.className = 'lbl'; l.textContent = rotulo; l.title = rotulo;
  el.append(l);
  if (!larga) {
    const b = document.createElement('span'); b.className = 'bar';
    b.style.width = `${Math.max(2, Math.round((n / max) * 100))}%`;
    el.append(b);
  }
  const c = document.createElement('span'); c.className = 'n'; c.textContent = typeof n === 'number' ? n.toLocaleString('pt-BR') : n;
  el.append(c);
  return el;
}

function _explorarSecao(titulo, sub, linhas, hint, aberta) {
  const q = fold(_explorarQuery);
  const vis = q ? linhas.filter(([rot]) => fold(rot).includes(q)) : linhas;
  if (!vis.length) return null;
  const sec = document.createElement('details');
  sec.className = 'explorar-sec';
  sec.open = !!q || aberta;
  const sm = document.createElement('summary');
  sm.textContent = titulo + ' ';
  if (sub) { const s = document.createElement('small'); s.textContent = sub; sm.append(s); }
  sec.append(sm);
  if (hint) { const h = document.createElement('p'); h.className = 'explorar-hint'; h.textContent = hint; sec.append(h); }
  for (const [, , el] of vis) sec.append(el);
  return sec;
}

function _cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

function renderExplorar() {
  if (!_explorarBody) return;
  const key = activeAcervoKey;
  _carregarResumo().then(resumo => {
    if (!isExplorarOpen()) return;
    const ac = resumo?.acervos?.[key];
    _explorarBody.replaceChildren();
    if (!ac) {
      const p = document.createElement('p');
      p.className = 'explorar-empty';
      p.textContent = resumo ? 'Este acervo ainda não tem resumo para explorar.' : 'Não foi possível carregar o resumo do acervo.';
      _explorarBody.append(p);
      return;
    }
    const cat = ac.catalogo || {};
    const maxOf = (o) => Math.max(1, ...Object.values(o));
    const secoes = [];

    const dec = cat.albuns_por_decada || {};
    const mDec = maxOf(dec);
    secoes.push(_explorarSecao('Épocas', `${cat.ano_min}–${cat.ano_max}`,
      Object.entries(dec).map(([d, n]) => [`${d}`, n, _explorarLinha(`Anos ${d}`, n, mDec, () => explorarSetDecade(Number(d)), activeDecade === Number(d))]),
      'Escolha uma década para filtrar a grade.', true));

    const ano = cat.albuns_por_ano || {};
    const mAno = maxOf(ano);
    secoes.push(_explorarSecao('Anos', `${Object.keys(ano).length}`,
      Object.entries(ano).map(([y, n]) => [y, n, _explorarLinha(y, n, mAno, () => explorarSetYear(Number(y)), activeYear === Number(y))]),
      null, false));

    const arts = cat.artistas_mais_albuns || [];
    const mArt = Math.max(1, ...arts.map(a => a.n));
    secoes.push(_explorarSecao('Mais álbuns', `${arts.length} artistas`,
      arts.map(a => [a.nome, a.n, _explorarLinha(a.nome, a.n, mArt, () => explorarSetArtist(a.nome), activeArtist === a.nome, true)]),
      'Escolha um artista para filtrar a grade.', false));

    const bpm = Object.entries(ac.bpm_histograma_10 || {});
    const mBpm = Math.max(1, ...bpm.map(x => x[1]));
    secoes.push(_explorarSecao('Andamento', 'faixas por BPM',
      bpm.map(([b, n]) => [`${b} bpm`, n, _explorarLinha(`${b}–${Number(b) + 9}`, n, mBpm)]),
      'Só leitura: o filtro por andamento depende das features por faixa.', false));

    const lista = (arr, rot) => {
      const m = Math.max(1, ...arr.map(x => x.n));
      return arr.slice(0, 20).map(x => [rot(x), x.n, _explorarLinha(rot(x), x.n, m, null, false, false)]);
    };
    secoes.push(_explorarSecao('Humor', 'Essentia', lista(ac.humores_essentia || [], x => _cap(x.nome)), null, false));
    secoes.push(_explorarSecao('Instrumentos', null, lista(ac.instrumentos || [], x => _cap(x.nome)), null, false));
    secoes.push(_explorarSecao('Tom', 'faixas por tom',
      lista(ac.tom?.por_tom || [], x => `${x.tom} ${x.modo === 'minor' ? 'menor' : 'maior'}`), null, false));

    const fpd = ac.features_por_decada || {};
    secoes.push(_explorarSecao('Perfil por década', 'médias',
      Object.entries(fpd).map(([d, f]) => {
        const txt = `${Math.round(f.bpm)} bpm · ` + EXPLORAR_FEATURES.slice(0, 4).map(([k, r]) => `${r} ${Math.round(f[k] * 100)}%`).join(' · ');
        return [`${d}`, f.faixas, _explorarLinha(`${d}: ${txt}`, `${f.faixas}`, 1, null, false, true)];
      }), 'Médias das faixas analisadas; o número à direita é a quantidade de faixas.', false));

    const frag = document.createDocumentFragment();
    secoes.filter(Boolean).forEach(s => frag.append(s));
    if (!frag.childNodes.length) {
      const p = document.createElement('p'); p.className = 'explorar-empty'; p.textContent = 'Nada encontrado.'; frag.append(p);
    }
    _explorarBody.append(frag);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  _explorarPanel = document.getElementById('explorar-panel');
  _explorarLayout = document.querySelector('.app-layout');
  _explorarBody = document.getElementById('explorar-body');
  _explorarBtn = document.getElementById('btn-explorar');
  _explorarSearch = document.getElementById('explorar-search');
  _explorarBtn?.addEventListener('click', toggleExplorar);
  document.getElementById('btn-explorar-close')?.addEventListener('click', closeExplorar);
  document.getElementById('browse-scrim')?.addEventListener('click', closeExplorar);
  document.getElementById('btn-browse')?.addEventListener('click', closeExplorar);
  _explorarSearch?.addEventListener('input', () => { _explorarQuery = _explorarSearch.value; renderExplorar(); });
  document.getElementById('explorar-clear')?.addEventListener('click', () => {
    _explorarSearch.value = ''; _explorarQuery = ''; renderExplorar(); _explorarSearch.focus();
  });
});
