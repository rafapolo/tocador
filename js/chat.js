// Chat panel: replaces the browse panel while open. v0 engine — no LLM, no model: it reads periods
// (decades, years, ranges) and plain words from the sentence, searches the catalogue, and says what it
// understood, what it set aside and why. The ontology and the text model (tasks/chat-musical.md) plug
// into chatInterpret() later. Classic script; uses ui.js / util.js globals at run time.

const CHAT_PAGE = 8;
// Words that are only politeness / filler in a request — never searched.
const CHAT_STOP = new Set(('me um uma uns umas o a os as de do da dos das no na nos nas em com sem pra para por e ou ' +
  'que qual quais tem tema ha quero queria gostaria mostre mostra mostrar indica indique busca busque procura procure ' +
  'achar acha ache ver ouvir tocar toca algo alguma algum coisa coisas musica musicas album albuns disco discos faixa ' +
  'faixas banda bandas artista artistas cantor cantora anos ano decada decadas epoca tempo dos seus suas meu minha mais ' +
  'menos muito pouco bem tipo estilo som sons favor obrigado obrigada valeu ola oi ei hey bom dia boa tarde noite ' +
  'gostaria poderia pode podes consegue sabe saber conhece conhecer existe existem quantos quantas quanto quantidade total ' +
  'voce vc eu tu ele ela eles elas ' +
  // how people actually type: q (que), pf/pfv (por favor), ai/ta (aí, tá), bora, btn, tb (também)…
  'q pf pfv plmdds pls plz ai ta bora btn tb tbm vlw blz hmm ne').split(' '));
// Qualities we cannot judge yet: said so instead of silently searching titles for them.
const CHAT_PENDING = new Set(('lento lenta devagar rapido rapida acelerado animado agitado calmo calma tranquilo ' +
  'melancolico melancolica triste alegre feliz romantico romantica dancante festivo nostalgico agressivo pesado ' +
  'instrumental cantado acustico eletronico').split(' '));
const CHAT_RANDOM = /\b(aleatori[oa]s?|surpreenda|surpreende|surpresa|sorteia|sorteie|qualquer um)\b/;

let _chatPanel, _chatLog, _chatInput, _chatForm, _chatBtn, _chatLayout;
const chatState = { terms: [], suggested: false };   // what the last successful question searched, for follow-ups like "e nos anos 70?"

function chatEl(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const chatAlbums = n => `${n} ${n === 1 ? 'álbum' : 'álbuns'}`;

function chatIsOpen() { return _chatLayout?.classList.contains('chat-mode'); }

function openChat() {
  if (!_chatPanel) return;
  _chatLayout.classList.add('chat-mode');
  _chatPanel.hidden = false;
  _chatBtn.setAttribute('aria-pressed', 'true');
  if (isMobile()) {
    _chatPanel.classList.add('open');
    document.getElementById('browse-scrim')?.classList.add('open');
  }
  if (!_chatLog.childElementCount) { if (typeof consultaCarregar === 'function') consultaCarregar().then(chatRefreshWelcome); chatWelcome(); }
  _chatInput.focus();
}

function closeChat() {
  if (!chatIsOpen()) return;
  _chatLayout.classList.remove('chat-mode');
  _chatPanel.hidden = true;
  _chatPanel.classList.remove('open');
  document.getElementById('browse-scrim')?.classList.remove('open');
  _chatBtn.setAttribute('aria-pressed', 'false');
  _chatBtn.focus();
}

// A user message scrolls to the bottom; an answer scrolls so its first line is at the top, so a long
// result list is read from its start instead of landing on its last row.
function chatAdd(node) {
  _chatLog.appendChild(node);
  if (node.classList.contains('bot') && node.offsetHeight > _chatLog.clientHeight * 0.6) {
    _chatLog.scrollTop = node.offsetTop - _chatLog.offsetTop - 8;
  } else {
    _chatLog.scrollTop = _chatLog.scrollHeight;
  }
}

function chatSay(text) { chatAdd(chatEl('div', 'chat-msg user', text)); }

function chatSuggestions(list, label) {
  const row = chatEl('div', 'chat-chips');
  if (label) row.setAttribute('aria-label', label);
  row.setAttribute('role', 'group');
  for (const s of list) {
    const text = typeof s === 'string' ? s : s.label;
    const ask = typeof s === 'string' ? s : s.ask;
    const b = chatEl('button', 'chat-chip', text);
    b.type = 'button';
    b.addEventListener('click', () => chatAsk(ask));
    row.appendChild(b);
  }
  return row;
}

// 2–3 requests that work, chosen by what just happened: a refusal category, the words/period/mood the person used,
// or nothing understood. Never the sentence just typed. Audio-based examples only when the audio data is loaded.
function chatArtistExample() {
  const a = (typeof albums !== 'undefined' && albums.length) ? albums[Math.floor(albums.length / 3)] : null;
  return a ? (parseArtists(a.artists)[0] || a.name || '').toLowerCase() : '';
}
function chatExamples({ cat, q, it, raw, zero } = {}) {
  const audio = !!consultaPronta()?.f;
  const era = it?.when?.decades?.length ? `anos ${String(it.when.decades[0]).slice(-2)}` : null;
  const artist = chatArtistExample();
  let ex;
  if (zero && (q?.generos?.length || q?.humor?.length || era)) ex = [q?.generos?.[0] || (q?.humor?.[0] && audio ? `algo ${q.humor[0]}` : null), era, 'me surpreenda'];   // the same request with less in it
  else if (q?.humor?.length && audio) ex = [`algo ${q.humor[0]} dos anos 70`, 'samba lento'];
  else if (q?.generos?.length) ex = [`${q.generos[0]} anos 70`, `${q.generos[0]} lento`];
  else if (q?.andamento && audio) ex = [`samba ${q.andamento}`, 'algo calmo'];
  else if (cat === 'letra') ex = [artist ? `${artist} anos 70` : 'anos 70', audio ? 'samba lento' : 'me surpreenda'];
  else if (cat === 'biografia') ex = [artist || 'anos 70', 'anos 70'];
  else if (cat === 'tecnica_musical') ex = audio ? ['choro com bandolim', 'violão e voz'] : [artist || 'anos 70', 'anos 70'];
  else if (cat === 'contraditorio') ex = audio ? ['algo lento', 'algo animado'] : ['anos 70', 'me surpreenda'];
  else if (cat === 'impossivel') ex = audio ? ['algo triste dos anos 70', 'samba lento'] : ['anos 70', 'me surpreenda'];
  else if (era) ex = [era, 'me surpreenda'];
  else ex = audio ? ['samba lento dos anos 60', 'algo calmo', 'me surpreenda'] : [artist || 'anos 70', 'anos 70', 'me surpreenda'];
  const seen = new Set([fold(raw || '')]);
  return ex.filter(x => x && !seen.has(fold(x)) && seen.add(fold(x))).slice(0, 3);
}
const chatTryChips = (opts) => chatSuggestions(chatExamples(opts), 'Exemplos que funcionam');

function chatWelcome() {
  const m = chatEl('div', 'chat-msg bot');
  const audio = consultaPronta()?.f;
  m.appendChild(chatEl('p', null, audio
    ? 'Oi! Peça por artista, época ou pelo som. Gênero, andamento e humor são medidos no áudio.'
    : 'Oi! Peça por artista, álbum, faixa ou época.'));
  const ex = [];
  const first = (typeof albums !== 'undefined' && albums.length) ? albums[Math.floor(albums.length / 3)] : null;
  if (audio) {
    ex.push('samba lento dos anos 60', 'algo calmo');
    const ref = first && (first.name || '').trim();
    if (ref && ref.length <= 28) ex.push(`mais lento que ${ref}`);
    ex.push('anos 70');
  } else {
    if (first) ex.push(parseArtists(first.artists)[0] || first.name);
    ex.push('anos 70', 'me surpreenda');
  }
  m.appendChild(chatSuggestions(ex.filter(Boolean), 'Exemplos que funcionam'));
  chatAdd(m);
}

// ── period ───────────────────────────────────────────────────────────────

function chatDecadeFromTwoDigits(d) { return d >= 30 ? 1900 + d : 2000 + d; }
function chatDecadeOf(n) { return n >= 100 ? Math.floor(n / 10) * 10 : chatDecadeFromTwoDigits(n); }

const chatNoWhen = () => ({ decades: [], years: [], from: null, to: null, text: [] });
const chatWhenEmpty = w => !w.decades.length && !w.years.length && w.from == null && w.to == null;

function chatWhenOk(year, w) {
  if (!year) return false;                      // unknown year satisfies no period ("antes de 1960" must not pull in undated albums)
  if (w.decades.length || w.years.length) {
    if (!(w.decades.includes(Math.floor(year / 10) * 10) || w.years.includes(year))) return false;
  }
  if (w.from != null && !(year >= w.from)) return false;
  if (w.to != null && !(year <= w.to)) return false;
  return true;
}

// Pull the period out of the folded sentence; returns the sentence without it.
function chatParseWhen(t, when, notes) {
  let m;
  const take = (re, fn) => { while ((m = t.match(re))) { fn(m); when.text.push(m[0].trim()); t = t.replace(m[0], ' '); } };

  take(/\b(?:de|entre|desde)\s*(\d{4})\s*(?:a|ate|e)\s*(\d{4})\b/, mm => {                 // "de 1960 a 1970"
    when.from = Math.min(+mm[1], +mm[2]); when.to = Math.max(+mm[1], +mm[2]);
    notes.push([`de ${when.from} a ${when.to}`, `de "${mm[0].trim()}"`]);
  });
  take(/\b(19[3-9]\d|20[0-3]\d)\s*(?:a|ate)\s*(19[3-9]\d|20[0-3]\d)\b/, mm => {                  // "1960 a 1969" (no "de")
    when.from = Math.min(+mm[1], +mm[2]); when.to = Math.max(+mm[1], +mm[2]);
    notes.push([`de ${when.from} a ${when.to}`, `de "${mm[0].trim()}"`]);
  });
  take(/\b([3-9]0|[0-2]0)s\b/, mm => {                                                      // "70s", "60s"
    const dec = chatDecadeFromTwoDigits(+mm[1]);
    if (!when.decades.includes(dec)) when.decades.push(dec);
    notes.push([`década de ${dec}`, `de "${mm[0]}" — dois dígitos: ${dec}`]);
  });
  take(/\bantes d[eo]s?\s*(?:anos?\s*)?(\d{2,4})\b/, mm => {                                  // "antes de 1980", "antes dos anos 70"
    const dec = /anos/.test(mm[0]);
    const y = dec ? chatDecadeOf(+mm[1]) : +mm[1];
    when.to = y - 1; notes.push([`até ${y - 1}`, `de "${mm[0].trim()}"`]);
  });
  take(/\bdepois d[eo]s?\s*(?:anos?\s*)?(\d{2,4})\b/, mm => {                                 // "depois de 2000", "depois dos anos 90"
    const dec = /anos/.test(mm[0]);
    const y = dec ? chatDecadeOf(+mm[1]) + 10 : +mm[1] + 1;
    when.from = y; notes.push([`a partir de ${y}`, `de "${mm[0].trim()}"`]);
  });
  take(/\ba partir d[eo]s?\s*(\d{4})\b/, mm => { when.from = +mm[1]; notes.push([`a partir de ${mm[1]}`, `de "${mm[0].trim()}"`]); });
  take(/\bate\s*(?:o\s*ano\s*)?(\d{4})\b/, mm => { when.to = +mm[1]; notes.push([`até ${mm[1]}`, `de "${mm[0].trim()}"`]); });

  // "anos 60", "anos 60 e 70", "década de 1970", "décadas de 60, 70 e 80"
  take(new RegExp('\\b(?:anos?|decadas?(?:\\s+de)?)\\s*((?:\\d{4}|\\d{2})(?:\\s+(?:e\\s+|ou\\s+)?(?:\\d{4}|\\d{2}))*)\\b'), mm => {
    for (const n of mm[1].split(/\s+(?:e\s+|ou\s+)?|\s+/).filter(Boolean)) {
      const dec = chatDecadeOf(+n);
      if (!when.decades.includes(dec)) when.decades.push(dec);
      const two = n.length === 2;
      notes.push([`década de ${dec}`, `de "${mm[0].trim()}"${two ? ` — dois dígitos: ${dec < 2000 ? '19' : '20'}${n}` : ''}`]);
    }
  });
  take(/\b(19|20)(\d)0s\b/, mm => {                                                           // "1970s"
    const dec = +(mm[1] + mm[2] + '0');
    if (!when.decades.includes(dec)) when.decades.push(dec);
    notes.push([`década de ${dec}`, `de "${mm[0]}"`]);
  });
  take(/\b(19[3-9]\d|20[0-3]\d)\b/, mm => {                                                   // "1965", "1965 e 1970"
    if (!when.years.includes(+mm[1])) when.years.push(+mm[1]);
    notes.push([`ano ${mm[1]}`, `de "${mm[0]}"`]);
  });
  return t;
}

// ── interpretation ───────────────────────────────────────────────────────

// text -> { when, terms, notes, pending, clear, random, continuation }
function chatInterpret(raw) {
  const notes = [];
  let t = fold(raw).replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const out = {
    when: chatNoWhen(), terms: [], notes, pending: [], clear: false, random: false, inherited: false,
    continuation: /^(e|so|somente|apenas|agora|mas|tambem|desses|dessas|dentre eles|entre eles)\b/.test(t.trim()),
  };

  if (/\b(limpar|limpa|zerar|resetar|tudo de novo|mostrar tudo)\b/.test(t)) { out.clear = true; return out; }
  if (CHAT_RANDOM.test(t)) { out.random = true; t = t.replace(CHAT_RANDOM, ' '); }

  t = chatParseWhen(t, out.when, notes);

  const palavras = t.split(/\s+/).filter(Boolean);
  for (const [i, w] of palavras.entries()) {
    if (i === 0 && out.continuation) continue;          // "só 1976", "agora anos 70": the marker is not a search word
    if (CHAT_STOP.has(w)) continue;
    if (w.length === 1 && !/\d/.test(w)) continue;          // stray letters ("<b>", "x") are noise, not search words
    if (CHAT_PENDING.has(w)) { out.pending.push(w); continue; }
    if (!out.terms.includes(w)) out.terms.push(w);
  }
  if (out.terms.length) notes.push([`palavras: ${out.terms.join(', ')}`, 'procuradas em título, artista, pasta e nomes de faixas; todas precisam aparecer']);
  return out;
}

// ── matching ─────────────────────────────────────────────────────────────

const _chatWordRe = new Map();
// Words of up to 3 letters ("tom", "rio") must be whole words — as substrings they hit "Phantom", "Brioso".
// Longer words stay substring matches, so "pagode" still finds "pagodeiros".
function chatHas(text, w) {
  if (w.length > 3) return text.includes(w);
  let re = _chatWordRe.get(w);
  if (!re) { re = new RegExp(`(^|[^\\p{L}\\p{N}])${w}($|[^\\p{L}\\p{N}])`, 'u'); _chatWordRe.set(w, re); }
  return re.test(text);
}

// 2 = in title/artist, 1 = in folder name or a track, 0 = nowhere. Folded text, as everywhere else.
function chatTermScore(a, w) {
  if (chatHas(a.nameLower, w) || chatHas(a.artistsLower, w)) return { score: 2 };
  if (chatHas(a.pathLower, w)) return { score: 1 };
  const tr = a.tracks.find(x => chatHas(x.titleLower, w) || chatHas(x.artistsLower, w));
  return tr ? { score: 1, track: tr } : { score: 0 };
}

// How many albums contain the word at all — rare words say more about what the person wants.
function chatTermFreq(w) { let n = 0; for (const a of albums) if (chatTermScore(a, w).score) n++; return n; }

function chatSearch(terms, when) {
  const hits = [];
  for (const a of albums) {
    if (!chatWhenEmpty(when) && !chatWhenOk(a.year, when)) continue;
    let ok = true, fromTrack = null, score = 0;
    for (const w of terms) {
      const r = chatTermScore(a, w);
      if (!r.score) { ok = false; break; }
      score += r.score;
      if (r.track) fromTrack ??= r.track;
    }
    if (ok) hits.push({ a, score, fromTrack });
  }
  hits.sort((x, y) => y.score - x.score || x.a.year - y.a.year);
  return hits;
}

// Largest subset of the words that still matches something; ties keep the rarest words.
function chatRelax(terms, when) {
  const freq = terms.map(chatTermFreq);
  const idx = terms.map((_, i) => i).sort((x, y) => freq[x] - freq[y]).slice(0, 5);   // cap the work at 2^5
  const pool = idx.filter(i => freq[i] > 0);
  if (!pool.length) return null;
  let best = null;
  for (let size = pool.length; size >= 1 && !best; size--) {
    const combos = [];
    const rec = (start, cur) => {
      if (cur.length === size) { combos.push([...cur]); return; }
      for (let k = start; k < pool.length; k++) { cur.push(pool[k]); rec(k + 1, cur); cur.pop(); }
    };
    rec(0, []);
    let bestRarity = -1;
    for (const c of combos) {
      const sub = c.map(i => terms[i]);
      const hits = chatSearch(sub, when);
      if (!hits.length) continue;
      const rarity = c.reduce((sum, i) => sum + 1 / freq[i], 0);
      if (rarity > bestRarity) { bestRarity = rarity; best = { terms: sub, hits }; }
    }
  }
  if (!best) return null;
  const ignored = terms.filter(w => !best.terms.includes(w));
  const onlyNowhere = ignored.every(w => freq[terms.indexOf(w)] === 0);
  return {
    ...best, ignored,
    why: onlyNowhere ? 'não aparecem em nenhum título, artista, pasta ou faixa do acervo'
                     : 'juntas com as outras não há resultado; mantive as palavras mais raras',
  };
}

// ── spelling: "cartolla" -> "cartola" ────────────────────────────────────

let _chatVocab = null;   // folded word -> how many albums have it (names and artists only, so it stays small)
function chatVocab() {
  if (_chatVocab) return _chatVocab;
  _chatVocab = new Map();
  for (const a of albums) {
    const seen = new Set((a.nameLower + ' ' + a.artistsLower).split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 4));
    for (const w of seen) _chatVocab.set(w, (_chatVocab.get(w) || 0) + 1);
  }
  return _chatVocab;
}

// Damerau-Levenshtein, bounded: returns true when a and b differ by at most `max` edits.
function chatWithin(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  const prev2 = [], prev = [], cur = [];
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return false;
    for (let j = 0; j <= b.length; j++) { prev2[j] = prev[j]; prev[j] = cur[j]; }
  }
  return prev[b.length] <= max;
}

// For words found nowhere: the most common catalogue word within 1 edit (2 for long words).
function chatSpelling(terms) {
  const out = [];
  for (const w of terms) {
    if (w.length < 5 || chatTermFreq(w) > 0) continue;
    const max = w.length >= 9 ? 2 : 1;
    let best = null, bestN = 0;
    for (const [v, n] of chatVocab()) {
      if (n > bestN && chatWithin(w, v, max)) { best = v; bestN = n; }
    }
    if (best) out.push({ from: w, to: best });
  }
  return out;
}

// ── answer ───────────────────────────────────────────────────────────────

function chatApplyToGrid(when, terms, set = null) {
  // The grid takes one substring, one decade and one year: apply what it can express exactly.
  const onlyDecade = when.decades.length === 1 && !when.years.length && when.from == null && when.to == null;
  const onlyYear = when.years.length === 1 && !when.decades.length && when.from == null && when.to == null;
  activeAlbumSet = set;
  activeDecade = onlyDecade ? when.decades[0] : null;
  activeYear = onlyYear ? when.years[0] : 0;
  searchQuery = terms.length === 1 ? terms[0] : '';
  if (_searchInput) _searchInput.value = searchQuery;
  filterAlbums();
  if (typeof renderDecadeButtons === 'function') renderDecadeButtons();
  return {
    periodLost: !chatWhenEmpty(when) && !onlyDecade && !onlyYear,
    wordsLost: terms.length > 1,
  };
}

function chatClear() {
  chatState.terms = [];
  chatApplyToGrid(chatNoWhen(), []);
}

function chatWhy(it, total, gridNote) {
  const d = chatEl('details', 'chat-why');
  d.appendChild(chatEl('summary', null, 'por quê?'));
  const ul = chatEl('ul');
  for (const [what, why] of it.notes) {
    const li = chatEl('li', null, what);
    li.appendChild(chatEl('span', 'tag', ` — ${why}`));
    ul.appendChild(li);
  }
  if (it.pending.length) {
    ul.appendChild(chatEl('li', null, `não entendi: ${it.pending.join(', ')} — andamento, humor e gênero dependem da ontologia e dos dados de áudio, que ainda não estão ligados a este chat`));
  }
  ul.appendChild(chatEl('li', null, `${chatAlbums(total)} ${total === 1 ? 'cumpre' : 'cumprem'} tudo o que entendi; ${it.ordem || 'ordenados por onde a palavra apareceu (título/artista antes de pasta/faixa) e depois por ano'}`));
  if (gridNote) ul.appendChild(chatEl('li', null, gridNote));
  d.appendChild(ul);
  return d;
}

function chatShowResults(box, hits, from, onPick) {
  let ul = box.querySelector('.chat-results');
  if (!ul) { ul = chatEl('ul', 'chat-results'); box.insertBefore(ul, box.querySelector('.chat-why')); }
  for (const { a, fromTrack } of hits.slice(from, from + CHAT_PAGE)) {
    const li = chatEl('li');
    const b = chatEl('button', 'chat-result');
    b.type = 'button';
    const img = chatEl('img', 'r-cover');
    img.alt = '';                      // decorative: the title next to it names the album
    img.loading = 'lazy';
    img.width = img.height = 40;
    loadCoverImage(img, a.cover);      // same loader as the grid: placeholder when the cover is missing
    b.appendChild(img);
    const text = chatEl('span', 'r-text');
    text.appendChild(chatEl('span', 'r-title', a.name || a.path));
    const sub = [a.artists, a.year || null, fromTrack ? `faixa: ${fromTrack.title}` : null].filter(Boolean).join(' · ');
    text.appendChild(chatEl('span', 'r-sub', sub));
    b.appendChild(text);
    b.addEventListener('click', () => { onPick?.(); openAlbum(a); if (isMobile()) closeChat(); });
    li.appendChild(b);
    ul.appendChild(li);
  }
}

function chatPickRandom(hits, n) {
  const pool = hits.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, n);
}

// ── player commands and "did not understand" ────────────────────────────

// Short imperatives that are not searches. Folded sentence, punctuation stripped.
const CHAT_PLAYER_CMDS = [
  ['pause', /^(pause|pausa|pausar|pare|parar|para|stop)$/],
  ['resume', /^(resume|retomar|retoma|continua|continuar|despausa|play|toca|tocar|toque)$/],
  ['next', /^(proxima|proximo|next|pula|pular|skip|avanca|avancar)( musica| faixa)?$/],
  ['prev', /^(anterior|voltar|volta|previous|prev)( musica| faixa)?$/],
];
// Status questions about the work, not the archive: said plainly that this chat does not do that.
const CHAT_NOT_SEARCH = /^(eta|rodando|rodou( tudo)?|status|ha t asks|tasks?|progresso|quanto falta|terminou|acabou)$/;

function chatCommand(raw) {
  const t = fold(raw).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\b(pf|pfv|por favor|ai|ae|agora|essa|esta)\b/g, ' ').replace(/\s+/g, ' ').trim();   // "pula essa", "pausa pf"
  for (const [cmd, re] of CHAT_PLAYER_CMDS) if (re.test(t)) return { cmd };
  if (CHAT_NOT_SEARCH.test(t)) return { cmd: 'refuse' };
  return null;
}

function chatRunCommand(c) {
  const audio = document.getElementById('audio');
  if (c.cmd === 'refuse') return 'Isso eu não faço aqui. Busco e toco música do acervo.';
  if (!currentTrack) return 'Ainda não há nada carregado no player. Escolha um álbum primeiro.';
  if (c.cmd === 'pause') {
    if (audio.paused) return 'Já está pausado.';
    document.getElementById('btn-play').click();
    return 'Pausado.';
  }
  if (c.cmd === 'resume') {
    if (!audio.paused) return 'Já está tocando.';
    document.getElementById('btn-play').click();
    return 'Tocando de novo.';
  }
  if (c.cmd === 'next') { playNext(); return 'Próxima faixa.'; }
  playPrevious();
  return 'Faixa anterior.';
}

// Counters stay in this browser (nothing is sent): how often a suggestion was opened vs. the person rephrased.
function chatCount(key) {
  try {
    const k = 'tocador-chat-sugestoes';
    const o = JSON.parse(localStorage.getItem(k) || '{}');
    o[key] = (o[key] || 0) + 1;
    localStorage.setItem(k, JSON.stringify(o));
  } catch (_) {}
}

// Nothing understood: offer 3 random albums that could be close — sharing any word typed, else the period
// asked for, else anything — and say which of the three it was. Same albums go to the grid.
function chatLookalikes(it, n = 3) {
  const words = [...it.terms, ...it.pending];
  const inWhen = a => chatWhenEmpty(it.when) || chatWhenOk(a.year, it.when);
  let pool = [], basis = 'nenhuma pista da frase bateu com o acervo; sorteei ao acaso no acervo todo';
  if (words.length) {
    pool = albums.filter(a => inWhen(a) && words.some(w => chatTermScore(a, w).score))
                 .map(a => ({ a, fromTrack: words.map(w => chatTermScore(a, w).track).find(Boolean) || null }));
    if (pool.length) basis = `sorteei entre álbuns que têm alguma de: ${words.join(', ')}`;
  }
  if (!pool.length && !chatWhenEmpty(it.when)) {
    pool = albums.filter(inWhen).map(a => ({ a, fromTrack: null }));
    if (pool.length) basis = 'sorteei entre álbuns do período pedido';
  }
  if (!pool.length) pool = albums.map(a => ({ a, fromTrack: null }));
  return { shown: chatPickRandom(pool, n), basis };
}

function chatAddLookalikes(bot, it, lead) {
  if (!albums.length) return;
  const wrap = chatEl('div', 'chat-lookalikes');
  const render = () => {
    const { shown, basis } = chatLookalikes(it);
    wrap.replaceChildren();
    wrap.appendChild(chatEl('p', 'tag', basis));
    chatShowResults(wrap, shown, 0, () => { chatCount('clicou'); chatState.suggested = false; });
    const more = chatEl('button', 'chat-chip', 'outras sugestões');
    more.type = 'button';
    more.addEventListener('click', () => { chatCount('outras'); render(); });
    const row = chatEl('div', 'chat-chips');
    row.appendChild(more);
    wrap.appendChild(row);
    chatApplyToGrid(chatNoWhen(), [], new Set(shown.map(h => h.a)));
  };
  bot.appendChild(chatEl('p', null, `Não entendi direito. ${lead ? `${lead} ` : ''}Talvez estes se pareçam:`));
  bot.appendChild(wrap);
  render();
  chatCount('mostradas');
  chatState.suggested = true;
}

// ── engine v1 (js/consulta-pt.js): ontology + audio features ─────────────

// The welcome line says what the chat can do; it is rewritten once the audio features turn out to be there.
function chatRefreshWelcome() {
  const first = _chatLog?.querySelector('.chat-msg.bot');
  if (!first || _chatLog.childElementCount !== 1 || !consultaPronta()?.f) return;
  _chatLog.replaceChildren();
  chatWelcome();
}

const CHAT_REFUSALS = {
  letra: 'Não tenho letras, só o áudio dos álbuns.',
  biografia: 'Não tenho dados sobre a vida dos artistas.',
  plataforma: 'Isso é de outro serviço. Aqui só busco e toco o acervo.',
  outra_midia: 'Só tenho áudio de álbuns, sem vídeo, filme nem livro.',
  tecnica_musical: 'Não ensino técnica musical. Busco e toco o acervo.',
  'clima/esporte/outros': 'Esse assunto está fora do acervo.',
  impossivel: 'Nenhum álbum do acervo pode atender esse pedido.',
  contraditorio: 'Esse pedido se contradiz. Tente uma das partes.',
  produto: 'Isso é sobre o chat, não sobre a música.',
  idioma: 'Entendo melhor português.',
  conversa: 'Oi! Eu busco e toco música do acervo.',
};

// One answer for a request the archive cannot do, with the engine's reasons in "por quê?".
function chatRefuse(bot, q, it, raw) {
  bot.appendChild(chatEl('p', null, CHAT_REFUSALS[q.categoria_fora] || 'Isso o acervo não faz.'));
  bot.appendChild(chatTryChips({ cat: q.categoria_fora, q, it, raw }));
  if (q.notas.length) {
    const d = chatEl('details', 'chat-why');
    d.appendChild(chatEl('summary', null, 'por quê?'));
    const ul = chatEl('ul');
    for (const [what, why] of q.notas) { const li = chatEl('li', null, what); li.appendChild(chatEl('span', 'tag', ` — ${why}`)); ul.appendChild(li); }
    d.appendChild(ul);
    bot.appendChild(d);
  }
}

const chatKind = e => `${e[2]}; confiança ${consultaRotuloConfianca(e[3])}`;

// Which album does "mais lento que X" mean? The best title/artist match for X's words.
function chatFindReference(texto) {
  const words = texto.split(' ').filter(w => w && !CHAT_STOP.has(w));
  if (!words.length) return null;
  const found = chatSearch(words, chatNoWhen());
  return found.length ? found[0].a : null;
}

// Narrow `base` (albums) with the audio facets of q. -> { hits: [{a, score, evid, fromTrack}], note }
function chatFacetHits(q, eng, base, fromTracks) {
  const withTrack = h => ({ ...h, fromTrack: fromTracks.get(h.a) || null });
  if (q.referencia || q.relativo) {
    const rel = q.referencia?.relacao || q.relativo;
    const ref = q.referencia ? chatFindReference(q.referencia.texto) : chatState.lastTop;
    if (!ref) return { hits: [], motivo: q.referencia ? `não achei "${q.referencia.texto}" no acervo` : 'não sei a que álbum se refere: peça antes um álbum ou diga "mais lento que <álbum>"' };
    if (rel === 'mesma_epoca') {
      const dec = Math.floor(ref.year / 10);
      const hits = base.filter(a => a !== ref && a.year && Math.floor(a.year / 10) === dec).map(a => ({ a, score: 1 - Math.abs(a.year - ref.year) / 10, evid: [[`da mesma época de "${ref.name}"`, `${ref.year}: mesma década`, 'cultural', 0.8]] }));
      return { hits: hits.map(withTrack), ref };
    }
    if (rel === 'mesma_regiao') return { hits: [], ref, motivo: 'ainda não sei a região dos artistas' };
    if (eng.semFeatures) return { hits: [], ref, motivo: 'comparar andamento e humor exige os dados de áudio, que não estão publicados para este acervo' };
    const r = consultaRelativo(rel === 'instrumental' ? 'parecido' : rel, ref, eng.agg, albums, base);
    return { hits: (r.hits || []).map(withTrack), ref, motivo: r.motivo };
  }
  const r = consultaFiltrar(q, eng.agg, albums, base);
  return { hits: r.hits.map(withTrack), relaxados: r.relaxados };
}

let _chatNomes = null;
function chatNameWord() {
  if (!_chatNomes || _chatNomes.albums !== albums) _chatNomes = { albums, f: consultaPalavrasDeNome(albums).nome };
  return _chatNomes.f;
}

let _chatFila = Promise.resolve();
function chatAsk(raw) {
  _chatFila = _chatFila.then(() => chatAskAsync(raw)).catch(e => console.error(e));
  return _chatFila;
}

async function chatAskAsync(raw) {
  raw = raw.trim();
  if (!raw) return;
  chatSay(raw);
  if (chatState.suggested) { chatCount('reformulou'); chatState.suggested = false; }
  const bot = chatEl('div', 'chat-msg bot');
  const cmd = chatCommand(raw);
  if (cmd) {
    bot.appendChild(chatEl('p', null, chatRunCommand(cmd)));
    chatAdd(bot);
    return;
  }
  const it = chatInterpret(raw);

  if (it.clear) {
    chatClear();
    bot.appendChild(chatEl('p', null, 'Filtros limpos. A grade voltou a mostrar o acervo inteiro.'));
    chatAdd(bot);
    return;
  }
  // Engine v1: ontology (+ audio features when published). Refuses what the archive cannot do, reads genre / tempo /
  // mood / instrument / voice / "mais lento que X"; without features the audio facets fall back to v0 below.
  let facet = null;
  const eng = typeof consultaCarregar === 'function' ? await consultaCarregar() : null;
  if (eng) {
    const q = consultaInterpretar(raw, eng.lex, w => chatTermFreq(w) > 0, chatNameWord());
    if (q.categoria_fora && q.categoria_fora !== 'comando') {
      if (q.categoria_fora === 'vago') { it.terms = []; it.pending = []; it.notes.push(...q.notas.map(n => [n[0], n[1]])); }
      else { chatRefuse(bot, q, it, raw); chatAdd(bot); return; }
    } else if (!eng.semFeatures && (consultaTemFiltro(q) || q.referencia || q.relativo)) {
      const gone = new Set([...q.consumidos, ...(q.referencia ? q.referencia.texto.split(' ') : [])]);
      it.terms = it.terms.filter(w => !gone.has(w));
      it.pending = (q.referencia || q.relativo) ? [] : it.pending.filter(w => !gone.has(w));
      it.notes = it.notes.filter(n => !(n[0].startsWith('palavras:') && !it.terms.length));
      if (it.terms.length) { const i = it.notes.findIndex(n => n[0].startsWith('palavras:')); if (i >= 0) it.notes[i] = [`palavras: ${it.terms.join(', ')}`, it.notes[i][1]]; }
      it.notes.push(...q.notas.map(n => [n[0], `${n[1]} [${n[2]}]`]));
      facet = { q, eng };
    }
  }
  // Only qualities we cannot judge ("instrumental", "triste")? An album may still be *titled* that way:
  // search them as plain words, and say so; if nothing matches, fall through to the honest "not yet".
  if (!facet && chatWhenEmpty(it.when) && !it.terms.length && !it.random && it.pending.length
      && chatSearch(it.pending, chatNoWhen()).length) {
    it.terms = it.pending;
    it.pending = [];
    it.notes.push([`palavras: ${it.terms.join(', ')}`, 'ainda não sei julgar isso como qualidade da música; procurei como palavra de título, artista ou faixa']);
  }
  if (!facet && chatWhenEmpty(it.when) && !it.terms.length && !it.random) {
    chatAddLookalikes(bot, it, it.pending.length ? `Ainda não sei filtrar por "${it.pending.join(', ')}".` : 'Não achei o que procurar nessa frase.');
    bot.appendChild(chatTryChips({ it, raw }));
    chatAdd(bot);
    return;
  }

  // Follow-up: "e nos anos 70?", "só os de 1971" — a continuation marker plus a period (and no words of
  // its own) keeps the words of the previous question. Without the marker it is a new question.
  if (it.continuation && !it.terms.length && chatState.terms.length) {
    it.terms = [...chatState.terms];
    it.inherited = true;
    it.notes.push([`palavras: ${it.terms.join(', ')}`, 'mantidas da pergunta anterior, porque esta é uma continuação ("e…", "só…")']);
  }

  // Nothing matched all the words? Set some aside — first the ones that appear nowhere in the
  // catalogue (typos, filler we did not list), then, if the rest still match nothing together, the most
  // common ones — and say so in the explanation. Never silently.
  let hits = chatSearch(it.terms, it.when);
  let facetInfo = null;
  if (facet) {
    const fromTracks = new Map(hits.map(h => [h.a, h.fromTrack]));
    const base = (it.terms.length ? hits.map(h => h.a) : albums.filter(a => chatWhenEmpty(it.when) || chatWhenOk(a.year, it.when)));
    facetInfo = chatFacetHits(facet.q, facet.eng, base, fromTracks);
    if (!facetInfo.hits.length && it.terms.length && !facetInfo.motivo) {         // words + sound filters together match nothing: drop the words, say so
      const base2 = albums.filter(a => chatWhenEmpty(it.when) || chatWhenOk(a.year, it.when));
      const again = chatFacetHits(facet.q, facet.eng, base2, new Map());
      if (again.hits.length) {
        it.notes = it.notes.filter(n => !n[0].startsWith('palavras:'));
        it.notes.push([`ignorei: ${it.terms.join(', ')}`, 'junto com os filtros de som não há nenhum álbum; mantive os filtros']);
        it.terms = []; facetInfo = again;
      }
    }
    hits = facetInfo.hits;
    it.ordem = 'ordem: medido no áudio, depois inferido, depois só texto';
    for (const r of facetInfo.relaxados || []) it.notes.push([`ignorei: ${r}`, 'o detector não mede isso; usei só o que dá para medir']);
    if (facetInfo.motivo) it.notes.push(['sem resultado', facetInfo.motivo]);
    if (hits.length) {
      // Each audio filter said against the albums returned. It replaces the engine's one-line facet notes (same facts, no repetition).
      const ex = consultaExplicarFiltros(facet.q, facet.eng.agg, hits, facetInfo.ref, facetInfo.relaxados || []);
      if (ex.length) {
        it.notes = it.notes.filter(n => !/^(sem )?(gênero|humor|andamento|instrumento|voz|formação):/.test(n[0]));
        for (const [what, why, kind] of ex) it.notes.push([what, `${why} [${kind}]`]);
      }
    }
  }
  if (!facet && !hits.length && it.terms.length > 1) {
    const relaxed = chatRelax(it.terms, it.when);
    if (relaxed) {
      const i = it.notes.findIndex(n => n[0].startsWith('palavras:'));
      if (i >= 0) it.notes[i] = [`palavras: ${relaxed.terms.join(', ')}`, it.notes[i][1]];
      it.notes.push([`ignorei: ${relaxed.ignored.join(', ')}`, relaxed.why]);
      it.terms = relaxed.terms;
      hits = relaxed.hits;
    }
  }
  const spelling = chatSpelling(chatInterpret(raw).terms);       // typos among the words as typed
  chatState.terms = it.terms;
  const lost = facet ? (chatApplyToGrid(chatNoWhen(), [], new Set(hits.map(h => h.a))), { wordsLost: false, periodLost: false }) : chatApplyToGrid(it.when, it.terms);
  const gridNotes = [];
  if (lost.wordsLost) gridNotes.push('na grade ao lado só apliquei década/ano; com mais de uma palavra, a busca da grade (um trecho contínuo) não consegue expressar o pedido');
  else if (!facet) gridNotes.push('a grade ao lado também foi filtrada');
  if (lost.periodLost) gridNotes.push('a grade só entende uma década ou um ano; este período (várias décadas, intervalo) vale só na lista do chat');
  const gridNote = gridNotes.join('; ');   // empty = no line

  if (!hits.length) {
    bot.appendChild(chatEl('p', null, facetInfo?.motivo ? `Não consegui: ${facetInfo.motivo}.` : 'Não achei nenhum álbum com tudo isso.'));
    if (spelling.length) chatAddSpelling(bot, raw, spelling);
    bot.appendChild(chatTryChips({ q: facet?.q, it, raw, zero: true }));
    bot.appendChild(chatWhy(it, 0, gridNote));
    chatAdd(bot);
    return;
  }

  let shown = hits;
  let head;
  if (it.random) {
    shown = chatPickRandom(hits, 5);
    head = `Sorteei ${shown.length} de ${chatAlbums(hits.length)}:`;
    it.notes.push(['sorteio', 'pedido de álbum aleatório; clique de novo em "me surpreenda" para outro']);
  } else {
    head = `${chatAlbums(hits.length)}${hits.length > CHAT_PAGE ? ` — mostrando ${CHAT_PAGE}` : ''}:`;
  }
  bot.appendChild(chatEl('p', null, head));
  if (spelling.length) chatAddSpelling(bot, raw, spelling);
  bot.appendChild(chatWhy(it, hits.length, gridNote));
  chatShowResults(bot, shown, 0);
  chatState.lastTop = shown[0]?.a || null;
  if (it.random) {
    bot.appendChild(chatSuggestions(['me surpreenda']));
  } else if (hits.length > CHAT_PAGE) {
    let n = CHAT_PAGE;
    const more = chatEl('button', 'chat-chip', 'mostrar mais');
    more.type = 'button';
    more.addEventListener('click', () => {
      chatShowResults(bot, hits, n); n += CHAT_PAGE;
      if (n >= hits.length) more.remove(); else more.textContent = `mostrar mais (${hits.length - n})`;
    });
    bot.appendChild(more);
  }
  chatAdd(bot);
}

function chatAddSpelling(bot, raw, spelling) {
  const p = chatEl('p', null, `Será que você quis dizer ${spelling.map(s => `"${s.to}"`).join(' e ')}?`);
  bot.appendChild(p);
  let fixed = fold(raw);
  for (const s of spelling) fixed = fixed.replace(new RegExp(`\\b${s.from}\\b`, 'g'), s.to);
  bot.appendChild(chatSuggestions([{ label: spelling.map(s => s.to).join(' + '), ask: fixed }]));
}

// ── wiring ───────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  _chatPanel = document.getElementById('chat-panel');
  _chatLog = document.getElementById('chat-log');
  _chatInput = document.getElementById('chat-input');
  _chatForm = document.getElementById('chat-form');
  _chatBtn = document.getElementById('btn-chat');
  _chatLayout = document.querySelector('.app-layout');
  if (!_chatPanel || !_chatBtn) return;

  _chatBtn.addEventListener('click', () => (chatIsOpen() ? closeChat() : openChat()));
  document.getElementById('btn-chat-close')?.addEventListener('click', closeChat);
  document.getElementById('btn-chat-new')?.addEventListener('click', () => {
    _chatLog.replaceChildren(); chatState.terms = []; chatWelcome(); _chatInput.focus();
  });
  document.getElementById('browse-scrim')?.addEventListener('click', () => { if (chatIsOpen()) closeChat(); });
  _chatPanel.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closeChat(); } });

  _chatForm.addEventListener('submit', e => {
    e.preventDefault();
    const v = _chatInput.value;
    _chatInput.value = '';
    _chatInput.style.height = '';
    chatAsk(v);
  });
  _chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); _chatForm.requestSubmit(); }
  });
  _chatInput.addEventListener('input', () => {
    _chatInput.style.height = 'auto';
    _chatInput.style.height = Math.min(_chatInput.scrollHeight, 120) + 'px';
  });
});
