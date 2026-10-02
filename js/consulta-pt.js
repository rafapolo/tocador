// Query engine v1 for the chat: reads a pt-BR request with the musical ontology (data/ontologia-musical.json)
// and filters albums by the audio features (js/acervo-features.js). No model, no network besides the two
// payloads. Classic script: needs `fold` (js/util.js) in scope; the tests load it with `new Function`.
//
//   const lex = consultaLexico(ontologia);
//   const q   = consultaInterpretar('samba lento sem bateria', lex);   // what was understood
//   const agg = consultaAgregar(db, features, ontologia);              // once per acervo, after decodeFeatures()
//   const r   = consultaFiltrar(q, agg, albums);                       // { hits, relaxados }
//   consultaEvidencias(q, agg, hits[0].a)                              // measured × inferred × cultural, with confidence
//
// Evidence kinds, said in every "por quê?": **medido** (BPM, voice/mood probabilities straight from the audio),
// **inferido** (pt-BR genre/instrument derived from Discogs/Essentia classes, with a share of confidence) and
// **cultural** (the word was only found as text — title, artist, folder, track — nothing was measured).

const CONSULTA_PRIORIDADE = ['andamento', 'voz', 'formacao', 'humor', 'instrumento', 'genero'];   // ambiguous alias: first facet wins
const CONSULTA_BPM_CONF_BAIXA = 1.5;    // Essentia confidence below this: the tempo may be half/double
const CONSULTA_GENERO_MIN = 0.25;       // share of the album's genre mass for a genre to count (top-1 always counts)
const CONSULTA_INST_MIN = 0.4;          // fraction of tracks carrying the instrument in their top-3

const CONSULTA_NEG = new Set(['sem', 'nao', 'nem', 'tira', 'tirar', 'tire', 'exceto', 'evita', 'evitar', 'menos']);
const CONSULTA_NEG_FILL = new Set(['o', 'a', 'os', 'as', 'que', 'e', 'de', 'do', 'da', 'um', 'uma', 'nada', 'quero', 'pra', 'com', 'ser', 'seja']);

// "mais lento que X": adjective -> relation (and its opposite for "menos")
const CONSULTA_COMPARATIVOS = {
  lento: 'mais_lento', lenta: 'mais_lento', devagar: 'mais_lento', calmo: 'mais_calmo', calma: 'mais_calmo',
  tranquilo: 'mais_calmo', suave: 'mais_calmo', relaxante: 'mais_calmo',
  rapido: 'mais_animado', rapida: 'mais_animado', animado: 'mais_animado', animada: 'mais_animado',
  acelerado: 'mais_animado', veloz: 'mais_animado', agitado: 'mais_animado',
  pesado: 'mais_pesado', pesada: 'mais_pesado', agressivo: 'mais_pesado', agressiva: 'mais_pesado',
  acustico: 'mais_acustico', acustica: 'mais_acustico', dancante: 'mais_dancante', dancavel: 'mais_dancante',
  triste: 'mais_triste', alegre: 'mais_alegre', feliz: 'mais_alegre',
};
const CONSULTA_OPOSTO = {
  mais_lento: 'mais_animado', mais_animado: 'mais_lento', mais_calmo: 'mais_pesado', mais_pesado: 'mais_calmo',
  mais_triste: 'mais_alegre', mais_alegre: 'mais_triste', mais_acustico: 'menos_acustico', mais_dancante: 'menos_dancante',
};

const CONSULTA_REF_RE = /\b(parecid[oa]s?|similar(?:es)?|semelhantes?|igual|iguais|lembr(?:a|am|e|em)|no estilo|na linha|tipo|mesm[oa]s? (?:pegada|clima|levada|vibe|linha|estilo|epoca|periodo)|na epoca|dessa epoca|versao instrumental|instrumental(?= d[eoa] ))\s+(?:com |a |ao |de |do |da |dos |das )?(.+)$/;
const CONSULTA_CONTRARIO_RE = /\b(?:o )?(?:contrario|oposto)\s+(?:de |do |da |dos |das )?(.+)$/;

const CONSULTA_FORA = [
  ['conversa', /^(oi|ola|eai|e ai|opa|bom dia|boa tarde|boa noite|obrigad[oa]|valeu|tudo bem|tchau|nada(\b.*)?|teste|ok|hum|kkk+|quem e voce|o que voce (faz|sabe|e)|como voce (funciona|esta)|vc e quem|desculpa)\b|\bso passando\b|\bdar um oi\b|\bapertei sem querer\b|^(esquece|beleza|tudo certo|entendi|ta bom|tah bom|nossa|obrigad)\b|\bpode me chamar\b|\bquem fez (esse|o) site\b|\bque site e esse\b|\bcomo vai a vida\b|\b(voce|vc|vcs|voces) (e|eh|esta|ta|entende|gosta|fala|sabe|consegue|me ouve|existe|ta ai|esta ai)\b(?!.*\b(samba|choro|rock|forro|jazz|mpb|bossa|album|disco|musica|faixa)\b)|\beu gosto muito de\b|\b(bom dia|boa tarde|boa noite)\b/],
  ['letra', /\b(letras? (que|d[aeo]s?|dessa|desta)|qual (e )?a letra|fala(m)? sobre|que (ela|ele) diz|o que (a|essa|esta|ela|ele) (musica|cancao|diz|fala|significa)|significado d[aoe]s?|traducao d[aoe]|que cita(m)?|que citem|cite|que repete|gritava|cantava|versos?|trecho d[aoe]|tem a frase|a frase ['\"]|conta a historia|refrao|que diz|onde o cantor diz|musica que fala|musica que diz|a que fala|a que tem ['\"]|qual (e )?a do refrao|de qual (disco|album|musica)|aquela (musica )?(em que|que))\b/],
  ['tecnica_musical', /\b(partituras?|acordes?|cifras?|tablaturas?|como tocar|dedilhado|tampo|encordoamento|afinar|afinacao|solfejo|harmonia de|escala de|como (faz|fazer) (o|um|uma) (solo|riff|dedilhado|acorde)|melhor (madeira|corda|cordas|violao|guitarra|microfone)|afino|pestana|compasso|escala|pentatonica|baqueta|metronomo|vibrato|rubato|semitom|tom e semitom|trocar as cordas|como (se )?faz\w* .{0,30}(violao|guitarra|cavaquinho|piano|bateria|ritmo)|como (estudar|aprender|segurar|usar|tocar)|diferenca entre|iniciante|cordas tem)\b/],
  ['biografia', /\b(biografia|quando (nasceu|morreu|se formou)|onde nasceu|quantos anos (tem|tinha|viveu)|casad[oa] com|nome (verdadeiro|real)|nome de batismo|casad[oa]|filhos?|morreu|morava|mora|irma|irmao|parentes?|cancer|esta vivo|ta vivo|idade|aniversario|esposa|marido|brigava|bastidores|sumiu por que|onde .{0,25} nasceu|ainda (vive|esta vivo)|faleceu|enterro|velorio|historia d[aoe]s? (banda|artista|cantor|cantora))\b/],
  ['plataforma', /\b(spotify|youtube|deezer|apple music|tidal|soundcloud|napster|last ?fm|baixar|download|netflix|comprar|camiseta|ingressos?|loja|merch|destaques da semana|ranking|top ?\d+|parada de sucessos?|num hd|em hd|app|android|iphone|ios|alexa|celular|toque do celular|assinatura|assinar|premium|pagar|cartao|login|senha|cadastro|aplicativo|radio fm|chromecast|nota fiscal|compra|offline|na radio|ligar e pedir|carro pelo|conta google)\b/],
  ['outra_midia', /\b(videos?|videoclipes?|clipes?|filmes?|series?|documentarios?|podcasts?|livros?|novelas?|programas? de tv|videogames?|jogos? de|quadrinhos?|gibis?|romances?|curtas?|teatro|peca de teatro|musical da broadway|especiais? de fim|entrevistas? d[oa]|minisserie|audiolivros?|tv)\b/],
  ['clima/esporte/outros', /\b(previsao do tempo|tempo amanha|clima (hoje|amanha|em )|futebol|placar|resultado do jogo|receita de|horoscopo|noticias?|cotacao|dolar|bitcoin|piada|loteria|quanto custa|vacina|reserva de mesa|selic|azia|bluetooth|como (limpar|fazer um|faco pra|fazer pra)|o que fazer quando|o que e bom pra|melhor [a-z]+ (ate|por)|\bqual (vacina|remedio))\b/],
  ['impossivel', /\b(do futuro|que nunca (existiu|ouvi)|ainda nao existe|ainda vai ser|que ninguem conhece|todas as musicas do mundo|a melhor musica do mundo|utero|nascimento do brasil|primeiro grito|a lua faz|quando eu nasci|ainda vai sair|ainda nao foi|nao foi gravada|depois de morrer|estivesse vivo|vou compor|cheiro|gosto de|sabor|arco iris|som do pensamento|minha planta|feita por (um )?(gato|cachorro|passaro)|nunca termine|cor (azul|vermelh|verde|amarel|roxa|lilas|turquesa)|da cor|o silencio faz)\b/],
  ['contraditorio', /\bsem (ritmo|batida)\b.*\b(danc\w+|animad\w+)\b|\b(danc\w+|animad\w+)\b.*\bsem (ritmo|batida)\b/],
  ['contraditorio', /\b(instrumental|sem voz)\b.*\b(letra|cantar junto|cantad[oa])\b|\bsilencio\b.*\b(batucada|barulho|festa)\b|\b(sem|nenhum\w*) (percussao|instrumento|bateria)\b.*\b(batucad\w*|percussiv\w*)\b|\bao vivo\b.*\b(estudio)\b|\balt[ao]\b.*\b(baixinho|sem incomodar)\b|\buma faixa e varias\b|\b(antiga|antigo)\b.*\b(esse ano|lancad\w* (agora|hoje))\b|\bde ninar\b.*\b(rave|festa|balada)\b|\b(relaxar|dormir)\b.*\b(agitad\w*|acelerad\w*)\b|\b3 segundos\b|\bsem nada eletronic\w*|\beletronic\w*.*\bsem nada eletronic\w*\b|\bsem (voz|cantor)\b.*\b(timbre|cantora|cantor)\b/],
  ['vago', /\b(algo|alguma coisa|qualquer coisa|alguma musica|uma musica)\s+(aia?|legal|boa|bom|bacana|massa|qualquer|diferente|interessante)\b|^(me )?(recomenda|indica|sugere|escolhe)( algo| alguma coisa| um| uma)?$|^musica$|^(nem sei|qualquer um|qualquer uma|tanto faz|sei la|bagun\w+|me escolhe um|legal|toca|uma boa|novo|nova|mais|hmm+|outra|outro|bom|boa|coisa diferente|aquilo|vai|musiquinha|uma qualquer( mesmo)?|diferente|tipo assim|isso|aquela|ai)$|\b(que pare o tempo|ainda vai ser classico)\b/],
];
// Unambiguous product/technique nouns: refuse even when the sentence also names a genre ("tem rádio FM de MPB?").
const CONSULTA_FORA_FORTE = [
  ['plataforma', /\b(spotify|youtube|deezer|apple music|tidal|soundcloud|napster|last ?fm|baixar|download|netflix|assinatura|assinar|premium|android|iphone|alexa|chromecast|radio fm|login|aplicativo|app|nota fiscal|ingressos?|comprar|tiktok|upload|legalmente|impressora|toque do celular|na radio|conta no)\b/],
  ['tecnica_musical', /\b(afinar|afino|afinacao|partituras?|tablaturas?|pestana|metronomo|semitom|tampo|encordoamento|trocar as cordas|escala pentatonica|compasso (2|3|4|6)\b|como (leio|transpor|afina|estudar|se faz|fazer batida|fazer o ritmo)|cifra de|quantas cordas|tirar o som certo)/],
  ['letra', /\b(qual (e )?a letra|letra d[aoe]s? (musica|cancao)|tem a frase|a frase ['"]|a que tem ['"]|qual (e )?a do refrao|refrao ['"]|(musica|cancao|aquela|a que|que|qual musica) (que )?(fala|diz|cita|conta|tem um verso)( de| do| da| sobre| que|[^a-z]| o nome))/],
  ['outra_midia', /\b(novelas?|videogames?|quadrinhos?|gibis?|programa de tv|musical da broadway|audiolivros?|minisserie)\b|\b(tem|qual|quero)\b(?!.*\btrilha\b).{0,25}\b(documentarios?|podcasts?|series?|livros?|clipes?|filmes?|videos?)\b|\bpra (assistir|ver)\b(?!.*\btrilha\b)|\bem video\b/],
  ['impossivel', /\b(depois de morrer|estivesse vivo|vou compor|ainda vai sair|que ainda nao foi gravada|nunca termine|arco iris)\b/],
];

const CONSULTA_COMANDOS = {
  pause: 'pausar', pausa: 'pausar', pausar: 'pausar', resume: 'continuar', continua: 'continuar', continuar: 'continuar', play: 'continuar',
  proxima: 'proxima', proximo: 'proxima', next: 'proxima', anterior: 'anterior', voltar: 'anterior', stop: 'pausar', parar: 'pausar',
  eta: 'status', status: 'status', rodando: 'status', progresso: 'status',
};

const _consultaNorm = s => fold(s).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

// Damerau-Levenshtein, bounded: true when a and b differ by at most `max` edits.
// A one-letter *substitution* ("tanto" -> "tango", "plano" -> "piano") is a different word more often than a typo;
// insertions, deletions and swaps are the usual slips, so substitutions only count on words of 7+ letters.
function consultaTypo(a, b) {
  if (a.length !== b.length) return true;
  if (a.length >= 7) return true;
  const d = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d.push(i);
  return d.length === 2 && d[1] === d[0] + 1 && a[d[0]] === b[d[1]] && a[d[1]] === b[d[0]];
}

function consultaWithin(a, b, max) {
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

// ── lexicon ──────────────────────────────────────────────────────────────

function consultaLexico(onto) {
  const map = new Map();
  let maxN = 1;
  const add = (frase, facet, id) => {
    const k = _consultaNorm(frase);
    if (!k) return;
    maxN = Math.max(maxN, k.split(' ').length);
    const list = map.get(k) || [];
    if (!list.some(e => e.facet === facet && e.id === id)) list.push({ facet, id });
    map.set(k, list);
  };
  for (const g of onto.generos) { add(g.id, 'genero', g.id); add(g.nome || g.id, 'genero', g.id); (g.apelidos || []).forEach(a => add(a, 'genero', g.id)); }
  for (const h of onto.humores) { add(h.id, 'humor', h.id); (h.apelidos || []).forEach(a => add(a, 'humor', h.id)); }
  for (const i of onto.instrumentos) { add(i.id, 'instrumento', i.id); (i.apelidos || []).forEach(a => add(a, 'instrumento', i.id)); }
  for (const f of onto.formacoes) { add(f.id, 'formacao', f.id); (f.apelidos || []).forEach(a => add(a, 'formacao', f.id)); }
  for (const a of onto.andamentos) { add(a.id, 'andamento', a.id); (a.apelidos || []).forEach(x => add(x, 'andamento', a.id)); }
  for (const v of onto.voz) { add(v.id, 'voz', v.id); (v.apelidos || []).forEach(x => add(x, 'voz', v.id)); }
  const fuzzy = [...map.keys()].filter(k => !k.includes(' ') && k.length >= 5);
  const rank = e => CONSULTA_PRIORIDADE.indexOf(e.facet);
  for (const list of map.values()) list.sort((x, y) => rank(x) - rank(y));
  return { map, maxN, fuzzy, onto };
}

// One concept per phrase: ambiguous aliases go to the facet that comes first in CONSULTA_PRIORIDADE.
function _consultaResolve(lex, entries) {
  let e = entries[0];
  if (e.facet === 'genero' && lex.onto.traducoes?.[e.id]?.voz) e = { facet: 'voz', id: lex.onto.traducoes[e.id].voz };
  if (e.facet === 'formacao' && e.id === 'só instrumental') e = { facet: 'voz', id: 'instrumental' };
  return e;
}

// Walk the tokens left to right, longest phrase first; typo-tolerant (1 edit) for single words of 5+ letters.
// -> [{ i, n, facet, id, neg, fuzzy }]; the tokens not covered are left for the caller.
function consultaVarrer(tokens, lex, isKnownWord) {
  const out = [];
  let neg = 0;                                   // how many more tokens a negation marker still reaches
  for (let i = 0; i < tokens.length;) {
    let hit = null;
    for (let n = Math.min(lex.maxN, tokens.length - i); n >= 1 && !hit; n--) {
      const entries = lex.map.get(tokens.slice(i, i + n).join(' '));
      if (entries) hit = { n, e: _consultaResolve(lex, entries), fuzzy: false };
    }
    if (!hit) {
      const w = tokens[i];
      if (w.length >= 5 && !isKnownWord?.(w)) {
        const near = lex.fuzzy.filter(k => consultaWithin(w, k, 1) && consultaTypo(w, k));
        if (near.length === 1) hit = { n: 1, e: _consultaResolve(lex, lex.map.get(near[0])), fuzzy: near[0] };
      }
    }
    if (hit) {
      out.push({ i, n: hit.n, facet: hit.e.facet, id: hit.e.id, neg: neg > 0, fuzzy: hit.fuzzy });
      neg = 0;
      i += hit.n;
      continue;
    }
    if (CONSULTA_NEG.has(tokens[i])) neg = 4;
    else if (neg > 0) neg = CONSULTA_NEG_FILL.has(tokens[i]) ? neg - 1 : 0;
    i++;
  }
  return out;
}

// Markers that make a named album/artist a *reference* ("que lembre X", "X, mais pesado", "mesma época do X").
const CONSULTA_MARCADOR_RE = /\b(mesm[oa]s?\s+(pegada|vibe|clima|epoca|cena|regiao|energia|onda|linha|estilo|espirito|esquema|periodo)|nesse\s+(clima|espirito|estilo|pegada|vibe|esquema|tom)|na\s+(pegada|linha|vibe)|no\s+(clima|estilo|esquema)|lembr(?:a|am|e|em)|parecid\w*|similar\w*|semelhan\w*|ao contrario|contrario|oposto|like|(?:mas|porem|so que|but)\s+(?:mais|menos|sem|so|com|bem|acustic\w*|eletric\w*|instrumental|ao vivo)|tirando|tira|desplugad\w*|so (o|a) (instrumental|vocal|voz)|nessa (pegada|linha|levada|vibe)|esse estilo|tipo|na epoca d[eoa]s?|dessa epoca|outros? (assim|nesse|desse)|mais disso|artistas d[ao]|da mesma)\b/;
const CONSULTA_INICIOS = new Set(('som quero queria procuro procurando para pra tem tenho me uma um uns umas bora gostaria preciso alguma algum algo musica musicas '
  + 'samba choro rock jazz forro bossa tropicalia funk rap punk metal blues pop mpb looking brazilian oi ola vamos vou fazer faz qual quais como onde quando mano mana cara bro velho oxe eita ei mermao').split(' '));

// Capitalised runs in the *original* text that are not common words or ontology terms: "Fire Walks With Me do Moons".
// -> folded entity text (the longest run, connectors kept) or null. The first word of a sentence only counts when
// it is ALL CAPS, or followed by another capitalised word, or a relation marker is present and it is not a usual opener.
function _consultaEntidade(raw, lex, comMarcador) {
  const toks = raw.replace(/[“”"'()[\]!?,;:]/g, ' ').split(/\s+/).filter(Boolean);
  const cap = w => /^[A-ZÁÉÍÓÚÂÊÔÃÕÇ0-9]/.test(w) && /[A-Za-zÁÉÍÓÚÂÊÔÃÕÇáéíóúâêôãõç]/.test(w);
  const ligacao = new Set(['de', 'da', 'do', 'dos', 'das', 'e', '&', 'the', 'of', 'la', 'el', 'del']);
  const runs = [];
  for (let i = 0; i < toks.length;) {
    if (!cap(toks[i])) { i++; continue; }
    let j = i + 1;
    while (j < toks.length && (cap(toks[j]) || (ligacao.has(toks[j].toLowerCase()) && j + 1 < toks.length && cap(toks[j + 1])))) j++;
    const palavras = toks.slice(i, j), f = _consultaNorm(palavras.join(' '));
    const conceito = lex.map.has(f) || palavras.every(w => lex.map.has(_consultaNorm(w)));
    let ok = !conceito;
    if (ok && i === 0) {
      const todoMaiusculo = palavras[0].length > 2 && palavras[0] === palavras[0].toUpperCase() && /[A-ZÁÉÍÓÚÂÊÔÃÕÇ]/.test(palavras[0]);
      ok = todoMaiusculo || palavras.length > 1 || (comMarcador && !CONSULTA_INICIOS.has(_consultaNorm(palavras[0])) && palavras[0].length >= 4);
    }
    if (ok) runs.push({ i, j, f });
    i = j;
  }
  if (!runs.length) return null;
  return runs.sort((x, y) => (y.j - y.i) - (x.j - x.i))[0].f;
}

const _consultaSemSequencia = (tokens, seq) => {
  if (!seq.length) return tokens;
  for (let i = 0; i + seq.length <= tokens.length; i++) {
    if (seq.every((w, k) => tokens[i + k] === w)) return [...tokens.slice(0, i), ...tokens.slice(i + seq.length)];
  }
  return tokens;
};

// ── interpretation ───────────────────────────────────────────────────────

const _consultaVazia = () => ({
  tipo: 'busca', categoria_fora: null, comando: null,
  generos: [], humor: [], andamento: null, instrumentos: [], formacoes: [], voz: null,
  excluir: { generos: [], humor: [], instrumentos: [], formacoes: [], voz: null, andamento: null },
  referencia: null, relativo: null, resto: [], consumidos: [], notas: [], conf: 1,
});

// text -> structured query. `isKnownWord(w)` (optional): words that exist in the catalogue are never "corrected".
function consultaInterpretar(raw, lex, isKnownWord, isNameWord) {
  const q = _consultaVazia();
  let t = _consultaNorm(raw);
  const all = t.split(' ').filter(Boolean);
  if (!all.length) { q.tipo = 'fora_do_dominio'; q.categoria_fora = 'vago'; q.conf = 0; return q; }

  if (all.length <= 3 && all.every(w => CONSULTA_COMANDOS[w] || w === 'a' || w === 'o')) {
    const w = all.find(x => CONSULTA_COMANDOS[x]);
    if (w) { q.tipo = 'fora_do_dominio'; q.categoria_fora = 'comando'; q.comando = CONSULTA_COMANDOS[w]; q.conf = 1; return q; }
  }

  // 1. things the archive cannot do
  const bio = /\bquem (foi|era|e) [A-ZÁÉÍÓÚÂÊÔÃÕÇ]|\b[A-ZÁÉÍÓÚÂÊÔÃÕÇ]\w+ (ainda )?(vive|viveu)\b/.test(raw);
  const decada = (t.match(/\banos? (\d{2,4})\b/) || [])[1];
  const ano = decada ? (decada.length === 4 ? +decada : +decada >= 30 ? 1900 + +decada : 2000 + +decada) : null;
  const moderno = new Set(['música eletrônica', 'noise', 'rap', 'funk carioca', 'punk', 'hardcore', 'metal', 'shoegaze', 'pós-punk', 'manguebeat', 'axé', 'indie', 'ambient', 'rock', 'rock brasileiro']);
  if (bio) { q.tipo = 'fora_do_dominio'; q.categoria_fora = 'biografia'; q.conf = 0.8; q.notas.push(['fora do alcance', 'pergunta sobre a vida de alguém; o acervo só tem áudio de álbuns', 'cultural']); return q; }
  if (ano && ano < 1960) {
    const g = consultaVarrer(all, lex, isKnownWord).filter(h => h.facet === 'genero' && !h.neg && moderno.has(h.id));
    if (g.length) {
      q.tipo = 'fora_do_dominio'; q.categoria_fora = 'impossivel'; q.conf = 0.7;
      q.notas.push(['pedido impossível', `${g[0].id} não existia em ${ano}; nenhum álbum pode cumprir`, 'cultural']);
      return q;
    }
  }
  const periodoAntes = /\b(19|20)\d{2}\b|\banos? \d|\bdecada|\bseculo\b/.test(t);
  const comConceito = periodoAntes || consultaVarrer(all, lex, isKnownWord).some(h => !(h.facet === 'humor' && h.id === 'romântico' && all.length < 3));
  const entidadeCedo = _consultaEntidade(raw, lex, true);
  // A word that names something in the catalogue (an artist, a title: "elis", "pixinguinha") makes the sentence a search.
  const nome = all.some(w => w.length >= 4 && isNameWord?.(w));
  for (const [cat, re] of [...CONSULTA_FORA_FORTE, ...(comConceito ? CONSULTA_FORA.filter(x => x[0] === 'contraditorio') : CONSULTA_FORA)]) {
    if (!re.test(t)) continue;
    if (nome && (cat === 'conversa' || cat === 'vago')) continue;
    if (cat === 'biografia' && !entidadeCedo && !/\b(biografia|quando (nasceu|morreu|se formou)|onde nasceu|nome (verdadeiro|real)|faleceu|enterro)\b/.test(t)) continue;
    if (cat === 'conversa' && (all.length > 4 || /\b(samba|choro|rock|forro|jazz|mpb|anos?)\b/.test(t)) && !/^(oi|ola|eai|e ai)\b[^a-z]*$/.test(t)) continue;
    q.tipo = 'fora_do_dominio'; q.categoria_fora = cat; q.conf = 0.8;
    q.notas.push(['fora do alcance', `parece ${cat.replace('_', ' ')} — o acervo só tem áudio de álbuns (artista, título, ano e características do som)`, 'cultural']);
    return q;
  }

  // 2. reference ("parecido com X", "o contrário de X") and comparison ("mais lento que X")
  let main = t, refTexto = null, relacao = null;
  const mc = t.match(CONSULTA_CONTRARIO_RE);
  if (mc) { refTexto = mc[1]; relacao = 'contrario'; main = t.slice(0, mc.index).trim(); }
  const toks0 = main.split(' ').filter(Boolean);
  for (let i = 0; i < toks0.length - 1 && !relacao; i++) {
    if (toks0[i] !== 'mais' && toks0[i] !== 'menos') continue;
    const adj = CONSULTA_COMPARATIVOS[toks0[i + 1]];
    if (!adj) continue;
    const rel = toks0[i] === 'menos' ? CONSULTA_OPOSTO[adj] : adj;
    const rest = toks0.slice(i + 2);
    const j = rest.findIndex(w => w === 'que' || w === 'q' || w === 'do' || w === 'da' || w === 'de');
    const ref = j >= 0 ? rest.slice(j + 1) : [];
    if (j >= 0 && !ref.length) continue;
    if (ref.length && j >= 0) { refTexto = ref.join(' '); relacao = rel; main = toks0.slice(0, i).join(' '); }
    else { q.relativo = rel; main = [...toks0.slice(0, i), ...rest].join(' '); }
    q.notas.push([`comparação: ${rel.replace('_', ' ')}`, ref.length ? `relativa a "${ref.join(' ')}"` : 'relativa ao que já estava na tela', 'medido']);
    break;
  }
  if (!relacao) {
    const mr = main.match(CONSULTA_REF_RE);
    if (mr) {
      let ref = mr[2].split(/\b(?:mas|so que|porem|e mais|com mais)\b/)[0].trim();
      const probe = consultaVarrer(ref.split(' ').filter(Boolean), lex, isKnownWord);
      const covered = probe.reduce((s, h) => s + h.n, 0);
      if (ref && covered < ref.split(' ').length && !/^(anos?|\d|decada|seculo)/.test(ref)) {      // "tipo samba" is a genre, "tipo Cartola" is a reference
        refTexto = ref; relacao = /epoca|periodo/.test(mr[1]) ? 'mesma_epoca' : /instrumental/.test(mr[1]) ? 'instrumental' : 'parecido';
        main = (main.slice(0, mr.index) + ' ' + mr[2].slice(ref.length)).trim();
      }
    }
  }
  if (relacao) {
    q.referencia = { texto: refTexto.replace(/\s+/g, ' ').trim(), relacao };
    q.tipo = 'referencial';
    q.notas.push([`referência: "${q.referencia.texto}"`, `relação "${relacao.replace('_', ' ')}"; procurada por título/artista no acervo`, 'cultural']);
  }

  // 2b. a named album/artist plus a relation marker or comparison: "Aurora do Wry mais acústico", "que lembre Belagio"
  if (!relacao) {
    const comparativo = q.relativo || /\b(mais|menos) (pra |para )?(lent|rapid|animad|calm|pesad|agressiv|acustic|dancante|danc|trist|alegr|arrastad|cima)/.test(t);
    const entidade = _consultaEntidade(raw, lex, CONSULTA_MARCADOR_RE.test(t) || !!comparativo);
    if (entidade && (CONSULTA_MARCADOR_RE.test(t) || comparativo)) {
      let rel = q.relativo;
      if (!rel) {
        const mm = t.match(/\b(mais|menos) (?:pra |para )?(lent|rapid|animad|calm|pesad|agressiv|acustic|dancante|danc|trist|alegr|arrastad|cima)\w*/);
        const adj = mm && (mm[2] === 'arrastad' ? 'lento' : mm[2] === 'cima' ? 'animado' : mm[2] === 'danc' ? 'dancante' : Object.keys(CONSULTA_COMPARATIVOS).find(k => k.startsWith(mm[2])));
        rel = adj ? (mm[1] === 'menos' ? CONSULTA_OPOSTO[CONSULTA_COMPARATIVOS[adj]] : CONSULTA_COMPARATIVOS[adj]) : null;
      }
      if (!rel) {
        if (/\bmesma epoca|mesmo periodo|\bda mesma\b/.test(t) && /epoca|periodo/.test(t)) rel = 'mesma_epoca';
        else if (/\bmesma regiao|\bartistas d[ao]\b|\bda regiao\b/.test(t)) rel = 'mesma_regiao';
        else if (/contrario|oposto/.test(t)) rel = 'contrario';
        else if (/so (o|a) (instrumental|vocal|voz)|tirando|tira |sem (o |a )?(voz|vocal)/.test(t)) rel = 'instrumental';
        else rel = 'parecido';
      }
      relacao = rel; refTexto = entidade; q.relativo = null;
      q.referencia = { texto: entidade, relacao };
      q.tipo = 'referencial';
      q.notas = q.notas.filter(n => !n[0].startsWith('comparação'));
      q.notas.push([`referência: "${entidade}"`, `relação "${relacao.replace('_', ' ')}"; procurada por título/artista no acervo`, 'cultural']);
      main = _consultaSemSequencia(main.split(' ').filter(Boolean), entidade.split(' ')).join(' ');
    }
  }

  // 3. concepts
  const tokens = main.split(' ').filter(Boolean);
  const hits = consultaVarrer(tokens, lex, isKnownWord);
  const used = new Array(tokens.length).fill(false);
  const ids = { andamento: new Set(), voz: new Set() };
  for (const h of hits) {
    for (let k = h.i; k < h.i + h.n; k++) used[k] = true;
    const fraseOriginal = tokens.slice(h.i, h.i + h.n).join(' ');
    const alvo = h.neg ? q.excluir : q;
    const por = h.fuzzy ? `"${fraseOriginal}" lido como "${h.fuzzy}" (1 letra de diferença)` : `de "${fraseOriginal}"`;
    const lista = { genero: 'generos', humor: 'humor', instrumento: 'instrumentos', formacao: 'formacoes' }[h.facet];
    if (h.facet === 'humor' && fraseOriginal === 'balada') q._balada = true;
    if (lista) { if (!alvo[lista].includes(h.id)) alvo[lista].push(h.id); }
    else if (h.facet === 'andamento') { if (h.neg) q.excluir.andamento = h.id; else { ids.andamento.add(h.id); q.andamento = h.id; } }
    else if (h.facet === 'voz') { if (h.neg) q.excluir.voz = h.id; else { ids.voz.add(h.id); q.voz = h.id; } }
    q.notas.push([`${h.neg ? 'sem ' : ''}${h.facet === 'genero' ? 'gênero' : h.facet}: ${h.id}`, por, h.fuzzy ? 'inferido' : 'medido']);
  }
  // "sem voz" negated cantada == instrumental
  if (q.excluir.voz) { q.voz = q.excluir.voz === 'cantada' ? 'instrumental' : 'cantada'; ids.voz.add(q.voz); q.excluir.voz = null; }

  // 4. contradictions
  const h = q.humor;
  const conflita = (h.includes('calmo') && h.includes('agressivo'))
    ;
  const and = [...ids.andamento];
  const lentoRapido = and.includes('lento') && (and.includes('animado') || and.includes('acelerado'));
  if (and.length > 1 && !lentoRapido) q.andamento = and.includes('acelerado') ? 'acelerado' : and.includes('animado') ? 'animado' : and[0];
  if (lentoRapido || ids.voz.size > 1 || conflita) {
    q.tipo = 'fora_do_dominio'; q.categoria_fora = 'contraditorio'; q.conf = 0.6;
    q.notas.push(['pedido contraditório', 'duas qualidades que se excluem na mesma faixa (ex.: lento e acelerado, calmo e agressivo, com e sem voz)', 'medido']);
    return q;
  }

  q.resto = tokens.filter((_, i) => !used[i]);
  q.consumidos = tokens.filter((_, i) => used[i]);
  const temConceito = q.generos.length || q.humor.length || q.andamento || q.instrumentos.length || q.formacoes.length || q.voz
    || q.excluir.generos.length || q.excluir.humor.length || q.excluir.instrumentos.length || q.excluir.formacoes.length || q.excluir.andamento;
  q.conf = temConceito || q.referencia || q.relativo ? 1 : 0;
  // Nothing musical recognised and the sentence is a question/command about something else: out of scope.
  const periodo = /\b(19|20)\d{2}\b|\banos? \d|\bdecada|\bseculo\b/.test(t);
  const musical = /\b(musicas?|album|albuns|disco|discos|faixas?|cancao|cancoes|artistas?|bandas?|cantor[a]?|cantora|som|sons|ouvir|tocar|toca|playlist|show|grupo|compositor|sambista|ritmo|batida|melodia|instrumento|gravad[oa]|acervo)\b/.test(t);
  const pergunta = /^(como|qual|quais|quem|onde|por ?que|o que|quanto|quantos|quantas|vai|me (ajuda|indica|diz|fala|conta|explica)|tem (algum|alguma|como)|da pra|posso|consigo|aceitam|preciso|quero (ver|saber|comprar|assistir|ler|fazer|aprender)|pode)\b/.test(t) || /\?\s*$/.test(raw.trim()) || /\b(quem|qual|quanto|onde|por que)\b/.test(t) || /^(dicas|ajuda|me da|me de)\b/.test(t);
  if (!q.conf && !periodo && !musical && !nome && pergunta && all.length >= 3 && q.tipo === 'busca') {
    q.tipo = 'fora_do_dominio'; q.categoria_fora = 'clima/esporte/outros'; q.conf = 0.5;
    q.notas.push(['fora do alcance', 'pergunta sobre outro assunto: nada na frase fala de música, gênero, época, andamento ou humor', 'cultural']);
    return q;
  }
  const vagas = new Set(['alguma', 'algum', 'qualquer', 'um', 'uma', 'ai', 'me', 'escolhe', 'escolha', 'nem', 'sei', 'coisa', 'algo', 'musica', 'quero', 'surpresa', 'tanto', 'faz', 'musicas', 'o', 'a']);
  if (!q.conf && !nome && q.resto.length && q.resto.length <= 4 && q.resto.every(w => vagas.has(w))) {
    q.tipo = 'fora_do_dominio'; q.categoria_fora = 'vago'; q.conf = 0.3;
    q.notas.push(['pedido vago', 'sem época, gênero, humor, andamento nem nome para filtrar', 'cultural']);
  }
  return q;
}

const consultaTemFiltro = q => !!(q.generos.length || q.humor.length || q.andamento || q.instrumentos.length || q.formacoes.length || q.voz
  || q.excluir.generos.length || q.excluir.humor.length || q.excluir.instrumentos.length || q.excluir.formacoes.length || q.excluir.andamento);

// ── aggregation: track features -> album features ───────────────────────

const _consultaMediana = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const _consultaMedia = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

// `db`: the decoded catalogue (row i of the features = i-th track of db, albums in order).
// `f`: decodeFeatures() result. Returns per-album features plus the per-acervo quantiles used for "alto/baixo".
function consultaAgregar(db, f, onto) {
  if (!f) return { porAlbum: new Map(), cortes: {}, bpmCortes: null, onto, nAnalisados: 0, generosMedidos: new Set(), semFeatures: true };
  const discogs = new Map(Object.entries(onto.discogs.mapa));
  const instMap = new Map();                                       // essentia name -> [pt-BR instrument ids]
  for (const i of onto.instrumentos) for (const e of i.essentia || []) instMap.set(e, [...(instMap.get(e) || []), i.id]);
  const pai = new Map(onto.generos.map(g => [g.id, g.pai]));
  const porAlbum = new Map();
  let row = 0;
  for (const a of db.albums) {
    const rows = [];
    for (let k = 0; k < a.tracks.length; k++, row++) if (f.has(row)) rows.push(row);
    if (!rows.length) { porAlbum.set(a.path.normalize('NFC'), { n: 0, rows }); continue; }
    const p = {};
    for (const k of ['voice', 'dance', 'acoustic', 'electronic', 'happy', 'sad', 'relaxed', 'aggressive', 'party']) p[k] = _consultaMedia(rows.map(r => f[k][r] / 255));
    const score = new Map();
    let massa = 0;
    const inst = new Map();
    for (const r of rows) {
      for (const g of f.genre(r)) {
        massa += g.p;
        for (const m of discogs.get(g.name) || []) {
          for (let id = m.genero, peso = m.peso; id; id = pai.get(id), peso = 1) score.set(id, (score.get(id) || 0) + g.p * peso);
        }
      }
      const seen = new Set();
      for (const name of f.instruments(r)) for (const id of instMap.get(name) || []) seen.add(id);
      for (const id of seen) inst.set(id, (inst.get(id) || 0) + 1 / rows.length);
    }
    const gen = new Map([...score].map(([id, s]) => [id, massa ? s / massa : 0]));
    const top = [...gen].sort((x, y) => y[1] - x[1]);
    porAlbum.set(a.path.normalize('NFC'), {
      n: rows.length, rows, p, gen, top1: top[0]?.[0] || null, inst,
      bpms: rows.map(r => f.bpm[r]), confs: rows.map(r => f.bpmConf[r] / 40),
      bpm: _consultaMediana(rows.map(r => f.bpm[r])), bpm_conf: _consultaMedia(rows.map(r => f.bpmConf[r] / 40)),
    });
  }
  const analisados = [...porAlbum.values()].filter(x => x.n);
  const cortes = {};
  for (const k of ['voice', 'dance', 'acoustic', 'electronic', 'happy', 'sad', 'relaxed', 'aggressive', 'party']) {
    const v = analisados.map(x => x.p[k]).sort((x, y) => x - y);
    cortes[k] = { baixo: Math.min(v[Math.floor(v.length * 0.3)] ?? 0, 0.5), alto: Math.max(v[Math.floor(v.length * 0.7)] ?? 1, 0.35) };
  }
  const bpms = analisados.map(x => x.bpm).sort((x, y) => x - y);
  const bpmCortes = { lento: bpms[Math.floor(bpms.length * 0.15)] ?? 0, acelerado: bpms[Math.floor(bpms.length * 0.85)] ?? 999 };
  const cobertos = new Set();                                      // genres that have at least one Discogs class
  for (const v of discogs.values()) for (const m of v) for (let id = m.genero; id; id = pai.get(id)) cobertos.add(id);
  return { porAlbum, cortes, bpmCortes, onto, nAnalisados: analisados.length, generosMedidos: cobertos };
}

const _consultaAgg = (agg, a) => agg?.porAlbum.get((a.path || '').normalize('NFC')) || null;

// ── per-facet checks: { ok, score 0..1, evid: [what, why, kind, conf] } ─────────────

function _consultaFaixaBpm(onto, id) { return onto.andamentos.find(x => x.id === id)?.bpm || null; }

// Per track: inside the band = full vote; low confidence and half/double inside the band = half a vote.
function _consultaAndamento(agg, ag, id) {
  const faixa = _consultaFaixaBpm(agg.onto, id);
  if (!faixa || !ag?.n) return null;
  const [lo, hi] = faixa;
  let votos = 0, metade = 0;
  for (let i = 0; i < ag.bpms.length; i++) {
    const b = ag.bpms[i], c = ag.confs[i];
    if (b >= lo && b < hi) votos++;
    else if (c < CONSULTA_BPM_CONF_BAIXA && ((b / 2 >= Math.max(lo, 30) && b / 2 < hi) || (b * 2 >= lo && b * 2 < Math.min(hi, 300)))) { votos += 0.5; metade++; }
  }
  const frac = votos / ag.bpms.length;
  const conf = Math.min(1, ag.bpm_conf / 3);
  // Absolute bands rarely hold in an archive whose median is ~110 BPM ("lento" < 80 is 1% of uqt): the extremes of the
  // acervo count too — the slowest/fastest 15% of albums — and the explanation says which rule applied.
  const relativo = frac < 0.5 && agg.bpmCortes && ((id === 'lento' && ag.bpm <= agg.bpmCortes.lento && ag.bpm_conf >= CONSULTA_BPM_CONF_BAIXA)
    || (id === 'acelerado' && ag.bpm >= agg.bpmCortes.acelerado && ag.bpm_conf >= CONSULTA_BPM_CONF_BAIXA));
  if (relativo) {
    return { ok: true, score: 0.6, evid: [`andamento ${id}`, `BPM mediano ${ag.bpm} (confiança ${ag.bpm_conf.toFixed(1)} de ~5): fora da faixa absoluta ${lo}–${hi}, mas entre os 15% ${id === 'lento' ? 'mais lentos' : 'mais rápidos'} deste acervo (corte ${agg.bpmCortes[id]} BPM)`, 'medido', conf * 0.8] };
  }
  return {
    ok: frac >= 0.5, score: frac,
    evid: [`andamento ${id}`, `BPM mediano ${ag.bpm} (confiança do detector ${ag.bpm_conf.toFixed(1)} de ~5)${metade ? `; ${metade} faixa(s) de baixa confiança contadas por meio/dobro de tempo` : ''}; ${Math.round(frac * 100)}% das faixas na faixa ${lo}–${hi}`, 'medido', conf],
  };
}

// Graded 0..1 where >= 0.5 means "satisfies the level": the further past the cut, the closer to 1 (ranking).
function _consultaNivel(v, corte, nivel) {
  if (nivel === 'alto') return v >= corte.alto ? 0.5 + 0.5 * (v - corte.alto) / Math.max(1 - corte.alto, 0.01) : 0.5 * Math.max(0, v / Math.max(corte.alto, 0.01));
  if (nivel === 'baixo') return v <= corte.baixo ? 0.5 + 0.5 * (corte.baixo - v) / Math.max(corte.baixo, 0.01) : 0.5 * Math.max(0, 1 - (v - corte.baixo) / Math.max(1 - corte.baixo, 0.01));
  return v >= corte.baixo && v <= corte.alto ? 0.75 : 0.25;
}

function _consultaHumor(agg, ag, id) {
  const h = agg.onto.humores.find(x => x.id === id);
  if (!h || !ag?.n || !h.medido || !Object.keys(h.sinais).length) return null;
  const graus = [];
  const det = [];
  for (const [k, nivel] of Object.entries(h.sinais)) {
    graus.push(_consultaNivel(ag.p[k], agg.cortes[k], nivel));
    det.push(`${k} ${ag.p[k].toFixed(2)} (${nivel})`);
  }
  const ok = graus.every(g => g >= 0.5);
  const score = graus.reduce((s, g) => s + g, 0) / graus.length;
  return { ok, score, evid: [`humor ${id}`, `medido nas faixas: ${det.join(', ')}; "alto/baixo" = entre os 30% mais altos/baixos do acervo, com piso absoluto`, 'medido', Math.min(1, score)] };
}

function _consultaTexto(a, palavras) {
  const termos = palavras.filter(Boolean);
  for (const w of termos) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u');
    if (re.test(a.nameLower) || re.test(a.artistsLower) || re.test(a.pathLower) || a.tracks.some(t => re.test(t.titleLower))) return w;
  }
  return null;
}

function _consultaAliases(onto, lista, id) {
  const e = onto[lista].find(x => x.id === id);
  return e ? [_consultaNorm(e.id), ...(e.apelidos || []).map(_consultaNorm)] : [_consultaNorm(id)];
}

function _consultaGenero(agg, ag, a, id) {
  let audio = null;
  if (agg.generosMedidos.has(id) && ag?.n) {
    const share = ag.gen.get(id) || 0;
    const ok = share >= CONSULTA_GENERO_MIN || ag.top1 === id;
    audio = { ok, score: Math.min(1, share / 0.5), evid: [`gênero ${id}`, `inferido das classes Discogs de ${ag.n} faixa(s): ${Math.round(share * 100)}% da massa de probabilidade${ag.top1 === id ? ' (é o gênero principal do álbum)' : ''} — não é rótulo de gravadora`, 'inferido', Math.min(1, share / 0.4)] };
    if (ok) return audio;
  }
  // The audio classes read some archives badly (samba heard as baião); a folder, title, artist or track that
  // carries the word is accepted too, and said to be cultural, not measured.
  const w = _consultaTexto(a, _consultaAliases(agg.onto, 'generos', id));
  if (w) return { ok: true, score: 0.5, evid: [`gênero ${id}`, `${audio ? 'o áudio não aponta' : 'sem classe de áudio para'} ${id}; achei "${w}" em título, artista, pasta ou faixa`, 'cultural', 0.3] };
  return audio || { ok: false, score: 0, evid: null };
}

function _consultaInstrumento(agg, ag, a, id) {
  const def = agg.onto.instrumentos.find(x => x.id === id);
  if (def?.medido && ag?.n) {
    const fr = ag.inst.get(id) || 0;
    return { ok: fr >= CONSULTA_INST_MIN, score: Math.min(1, fr / 0.8), evid: [`instrumento ${id}`, `inferido do detector de instrumentos: aparece entre os 3 mais fortes em ${Math.round(fr * 100)}% das faixas`, 'inferido', Math.min(1, fr)] };
  }
  const w = _consultaTexto(a, _consultaAliases(agg.onto, 'instrumentos', id));
  return w ? { ok: true, score: 0.5, evid: [`instrumento ${id}`, `o detector não reconhece ${id}; achei "${w}" em título, artista, pasta ou faixa`, 'cultural', 0.3] } : { ok: false, score: 0, evid: null };
}

function _consultaVoz(ag, id) {
  if (!ag?.n) return null;
  const v = ag.p.voice;
  const ok = id === 'cantada' ? v >= 0.5 : v < 0.5;
  return { ok, score: ok ? Math.min(1, Math.abs(v - 0.5) * 2 + 0.3) : 0, evid: [`voz ${id}`, `medido: probabilidade média de voz ${v.toFixed(2)} (corte 0,5)`, 'medido', Math.min(1, Math.abs(v - 0.5) * 2)] };
}

function _consultaFormacao(agg, ag, a, id) {
  if (ag?.n) {
    const i = k => ag.inst.get(k) || 0;
    if (id === 'voz e violão') { const ok = ag.p.voice >= 0.5 && i('violão') >= CONSULTA_INST_MIN && i('bateria') < 0.25; return { ok, score: ok ? 0.7 : 0, evid: [`formação ${id}`, `voz ${ag.p.voice.toFixed(2)}, violão em ${Math.round(i('violão') * 100)}% das faixas, bateria em ${Math.round(i('bateria') * 100)}%`, 'inferido', 0.5] }; }
    if (id === 'banda completa') { const ok = i('bateria') >= CONSULTA_INST_MIN && i('baixo') >= CONSULTA_INST_MIN; return { ok, score: ok ? 0.7 : 0, evid: [`formação ${id}`, `bateria e baixo juntos na maioria das faixas`, 'inferido', 0.5] }; }
    if (id === 'orquestra') { const ok = (i('cordas') >= CONSULTA_INST_MIN || i('sopros') >= CONSULTA_INST_MIN) && i('bateria') < 0.25; return { ok, score: ok ? 0.7 : 0, evid: [`formação ${id}`, `cordas/sopros sem bateria`, 'inferido', 0.4] }; }
  }
  const w = _consultaTexto(a, _consultaAliases(agg.onto, 'formacoes', id));
  return w ? { ok: true, score: 0.5, evid: [`formação ${id}`, `achei "${w}" em título, artista, pasta ou faixa`, 'cultural', 0.3] } : { ok: false, score: 0, evid: null };
}

// ── filtering ────────────────────────────────────────────────────────────

// albums: the chat's album objects (path, nameLower, artistsLower, pathLower, tracks[].titleLower). `base` (optional):
// restrict to these albums (e.g. the text/period hits). -> { hits: [{a, score, evid}], relaxados: [facet descriptions] }
function consultaFiltrar(q, agg, albums, base) {
  const pool = base || albums;
  const duros = [], moles = [];                                    // measured facets must hold; text-only ones may be relaxed
  const add = (neg, tipo, id) => {
    const medido = tipo === 'genero' ? agg.generosMedidos.has(id) : tipo === 'instrumento' ? !!agg.onto.instrumentos.find(x => x.id === id)?.medido
      : tipo === 'humor' ? !!agg.onto.humores.find(x => x.id === id)?.medido : tipo !== 'formacao';
    (neg || medido ? duros : moles).push({ neg, tipo, id });
  };
  q.generos.forEach(id => add(false, 'genero', id));
  q.humor.forEach(id => add(false, 'humor', id));
  q.instrumentos.forEach(id => add(false, 'instrumento', id));
  q.formacoes.forEach(id => add(false, 'formacao', id));
  if (q.andamento) add(false, 'andamento', q.andamento);
  if (q.voz) add(false, 'voz', q.voz);
  q.excluir.generos.forEach(id => add(true, 'genero', id));
  q.excluir.humor.forEach(id => add(true, 'humor', id));
  q.excluir.instrumentos.forEach(id => add(true, 'instrumento', id));
  q.excluir.formacoes.forEach(id => add(true, 'formacao', id));
  if (q.excluir.andamento) add(true, 'andamento', q.excluir.andamento);

  const check = (c, a) => {
    const ag = _consultaAgg(agg, a);
    let r = null;
    if (c.tipo === 'andamento') r = _consultaAndamento(agg, ag, c.id);
    else if (c.tipo === 'humor') r = _consultaHumor(agg, ag, c.id) || (() => { const w = _consultaTexto(a, _consultaAliases(agg.onto, 'humores', c.id)); return w ? { ok: true, score: 0.4, evid: [`humor ${c.id}`, `não dá para medir "${c.id}" no áudio; achei "${w}" em título, artista, pasta ou faixa`, 'cultural', 0.3] } : { ok: false, score: 0, evid: null }; })();
    else if (c.tipo === 'voz') r = _consultaVoz(ag, c.id);
    else if (c.tipo === 'genero') r = _consultaGenero(agg, ag, a, c.id);
    else if (c.tipo === 'instrumento') r = _consultaInstrumento(agg, ag, a, c.id);
    else if (c.tipo === 'formacao') r = _consultaFormacao(agg, ag, a, c.id);
    if (!r) return { ok: false, score: 0, evid: null };          // no analysis for this album: it cannot satisfy a measured facet
    if (c.neg && !ag?.n && c.tipo !== 'formacao') return { ok: false, score: 0, evid: null };   // …nor prove it lacks one
    return c.neg ? { ok: !r.ok, score: r.ok ? 0 : 0.5, evid: null } : r;
  };
  const run = conds => {
    const hits = [];
    for (const a of pool) {
      let ok = true, score = 0;
      const evid = [];
      for (const c of conds) {
        const r = check(c, a);
        if (!r.ok) { ok = false; break; }
        score += r.score;
        if (r.evid) evid.push(r.evid);
      }
      if (ok) hits.push({ a, score: conds.length ? score / conds.length : 0, evid });
    }
    return hits.sort((x, y) => y.score - x.score);
  };
  let hits = run([...duros, ...moles]);
  const relaxados = [];
  // Nothing matches all of it: drop text-only facets (largest subset that still matches), never a measured one.
  for (let size = moles.length - 1; size >= 0 && !hits.length && moles.length; size--) {
    if (size === 0 && !duros.length) break;
    const combos = [];
    const rec = (start, cur) => {
      if (cur.length === size) { combos.push([...cur]); return; }
      for (let k = start; k < moles.length; k++) { cur.push(moles[k]); rec(k + 1, cur); cur.pop(); }
    };
    rec(0, []);
    for (const combo of combos) {
      hits = run([...duros, ...combo]);
      if (hits.length) {
        for (const c of moles) if (!combo.includes(c)) relaxados.push(`${c.neg ? 'sem ' : ''}${c.tipo}: ${c.id}`);
        break;
      }
    }
  }
  return { hits, relaxados };
}

// "mais lento que X", "mais calmo que X", "parecido com X": compare each album with the reference album.
const _consultaVetor = ag => [ag.p.voice, ag.p.dance, ag.p.acoustic, ag.p.electronic, ag.p.happy, ag.p.sad, ag.p.relaxed, ag.p.aggressive, ag.p.party, ag.bpm / 200];
function consultaRelativo(relacao, refAlbum, agg, albums, base) {
  const ref = _consultaAgg(agg, refAlbum);
  if (!ref?.n) return { hits: [], motivo: 'o álbum de referência não tem análise de áudio' };
  const cmp = {
    mais_lento: ag => ref.bpm - ag.bpm, mais_animado: ag => ag.bpm - ref.bpm,
    mais_calmo: ag => ag.p.relaxed - ref.p.relaxed, mais_pesado: ag => ag.p.aggressive - ref.p.aggressive,
    mais_acustico: ag => ag.p.acoustic - ref.p.acoustic, menos_acustico: ag => ref.p.acoustic - ag.p.acoustic,
    mais_dancante: ag => ag.p.dance - ref.p.dance, menos_dancante: ag => ref.p.dance - ag.p.dance,
    mais_triste: ag => ag.p.sad - ref.p.sad, mais_alegre: ag => ag.p.happy - ref.p.happy,
  }[relacao];
  const passo = relacao.endsWith('lento') || relacao.endsWith('animado') ? 8 : 0.1;     // BPM or probability margin
  const hits = [];
  for (const a of base || albums) {
    if (a === refAlbum) continue;
    const ag = _consultaAgg(agg, a);
    if (!ag?.n) continue;
    if (cmp) {
      const d = cmp(ag);
      if (d >= passo) hits.push({ a, score: d / (passo * 4), evid: [[`${relacao.replace('_', ' ')} que "${refAlbum.name}"`, `medido: ${relacao.includes('lento') || relacao.includes('animado') ? `BPM mediano ${ag.bpm} contra ${ref.bpm} da referência` : `diferença de ${d.toFixed(2)} na probabilidade média`}`, 'medido', 0.6]] });
    } else {                                                        // parecido / contrario / mesma_epoca…
      const va = _consultaVetor(ag), vr = _consultaVetor(ref);
      const dist = Math.sqrt(va.reduce((s, x, i) => s + (x - vr[i]) ** 2, 0));
      const dentro = relacao === 'contrario' ? dist >= 0.9 : dist <= 0.35;
      if (dentro) hits.push({ a, score: relacao === 'contrario' ? dist : 1 - dist, evid: [[`${relacao === 'contrario' ? 'contrário de' : 'parecido com'} "${refAlbum.name}"`, `inferido: distância ${dist.toFixed(2)} no vetor andamento + humor + voz + acústica; aproximação sem os embeddings`, 'inferido', 0.4]] });
    }
  }
  return { hits: hits.sort((x, y) => y.score - x.score) };
}

// Evidence lines for one result, measured × inferred × cultural, each with its confidence. -> [[what, why, kind, conf]]
function consultaEvidencias(q, agg, a, pre) {
  const { hits } = consultaFiltrar(q, agg, [a]);
  const evid = hits[0]?.evid || pre || [];
  const ag = _consultaAgg(agg, a);
  const extra = ag?.n && !evid.some(e => e[0].startsWith('andamento')) ? [['andamento do álbum', `BPM mediano ${ag.bpm} (confiança ${ag.bpm_conf.toFixed(1)})`, 'medido', Math.min(1, ag.bpm_conf / 3)]] : [];
  return [...evid, ...extra];
}

const consultaRotuloConfianca = c => (c >= 0.7 ? 'alta' : c >= 0.4 ? 'média' : 'baixa');

// ── browser: load the ontology and (when published) the audio features, once, on demand ────────────

let _consultaEstado = null;       // { lex, onto, agg, f, semFeatures } once loaded; false when the ontology is unreachable
let _consultaPromessa = null;

async function _consultaBuscar(rel) {
  for (const base of [APP_ROOT, `${SITE_ORIGIN}/`]) {
    try { const r = await fetch(base + rel); if (r.ok) return r; } catch {}
  }
  return null;
}

async function _consultaGz(resp) { return JSON.parse(await new Response(resp.body.pipeThrough(new DecompressionStream('gzip'))).text()); }

// Never throws: v0 keeps working when the data is not published (mirrors, ?acervo=<url>) or does not match the catalogue.
function consultaCarregar() {
  if (_consultaPromessa) return _consultaPromessa;
  _consultaPromessa = (async () => {
    try {
      const ro = await _consultaBuscar('data/ontologia-musical.json');
      if (!ro) return (_consultaEstado = false);
      const onto = await ro.json();
      const lex = consultaLexico(onto);
      let f = null;
      const alias = typeof activeAcervoKey !== 'undefined' ? activeAcervoKey : null;
      const urls = [db?.meta?.features_url, alias && `data/${alias}-features.json.gz`, alias && `data/features/${alias}-features.json.gz`].filter(Boolean);
      for (const u of urls) {
        const r = /^https?:/.test(u) ? await fetch(u).catch(() => null) : await _consultaBuscar(u);
        if (!r?.ok) continue;
        try {
          const keys = [];
          for (const a of db.albums) for (const t of a.tracks) keys.push(`${a.path}/${t.file}`.normalize('NFC'));
          f = decodeFeatures(await _consultaGz(r), keys);
          break;
        } catch (e) { console.warn('features ignoradas:', e.message); }   // FEATURES_CATALOG_MISMATCH: catalogue changed after the build
      }
      return (_consultaEstado = { lex, onto, f, agg: consultaAgregar(db, f, onto), semFeatures: !f });
    } catch (e) {
      console.warn('consulta indisponível:', e);
      return (_consultaEstado = false);
    }
  })();
  return _consultaPromessa;
}
const consultaPronta = () => _consultaEstado || null;
