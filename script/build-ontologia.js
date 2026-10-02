#!/usr/bin/env bun
// build-ontologia.js — escreve data/ontologia-musical.json (ontologia musical pt-BR, v0).
//
// O vocabulário é o do gold set (data/qgen/gold/prompt.md) e de script/qgen-prepare.py; o mapeamento
// Discogs-400 → gênero pt-BR é feito por regras abaixo, com peso (0–1). Toda classe do Discogs aparece
// em `discogs.mapa` ou em `discogs.ignorar` (um teste confere). "instrumental" é VOZ, não gênero.
//
// Uso: bun script/build-ontologia.js          (precisa de ~/.essentia/models/*.json para as listas de classes)
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = join(homedir(), '.essentia/models');
const classes = f => JSON.parse(readFileSync(join(MODELS, f), 'utf8')).classes;
const DISCOGS = classes('genre_discogs400-discogs-effnet-1.json');
const INSTR = classes('mtg_jamendo_instrument-discogs-effnet-1.json');

// ── gêneros: [id, nome, pai, apelidos] ──────────────────────────────────────
const G = [
  ['samba', 'samba', null, ['sambinha']],
  ['samba de raiz', 'samba de raiz', 'samba', ['samba raiz', 'samba antigo', 'samba tradicional', 'partido alto', 'samba de breque']],
  ['pagode', 'pagode', 'samba', ['pagode de mesa', 'pagodeiro']],
  ['samba-canção', 'samba-canção', 'samba', ['samba cancao', 'sambacancao']],
  ['choro', 'choro', null, ['chorinho', 'choro tradicional']],
  ['mpb', 'MPB', null, ['musica popular brasileira']],
  ['bossa nova', 'bossa nova', 'mpb', ['bossa']],
  ['tropicália', 'tropicália', 'mpb', ['tropicalia', 'tropicalismo']],
  ['canção de protesto', 'canção de protesto', 'mpb', ['musica de protesto', 'protesto']],
  ['forró', 'forró', null, ['forro', 'forro pe de serra', 'pe de serra']],
  ['baião', 'baião', 'forró', ['baiao']],
  ['xote', 'xote', 'forró', ['xote nordestino']],
  ['xaxado', 'xaxado', 'forró', []],
  ['axé', 'axé', null, ['axe', 'axe music']],
  ['frevo', 'frevo', null, ['frevo de rua']],
  ['maracatu', 'maracatu', null, ['maracatu rural', 'maracatu nacao']],
  ['manguebeat', 'manguebeat', null, ['mangue beat', 'mangue']],
  ['carimbó', 'carimbó', null, ['carimbo']],
  ['lundu', 'lundu', null, []],
  ['modinha', 'modinha', null, []],
  ['música caipira', 'música caipira', null, ['caipira', 'musica sertaneja de raiz', 'viola caipira']],
  ['sertanejo raiz', 'sertanejo raiz', 'música caipira', ['sertanejo', 'sertanejo antigo']],
  ['brega', 'brega', null, ['brega romantico', 'musica brega']],
  ['rock', 'rock', null, ['roque']],
  ['rock brasileiro', 'rock brasileiro', 'rock', ['rock nacional', 'brock', 'rock br']],
  ['jovem guarda', 'jovem guarda', 'rock', ['iê iê iê', 'ie ie ie']],
  ['punk', 'punk', 'rock', ['punk rock']],
  ['hardcore', 'hardcore', 'rock', ['hc']],
  ['indie', 'indie', 'rock', ['indie rock', 'indie pop', 'alternativo', 'rock alternativo']],
  ['psicodelia', 'psicodelia', 'rock', ['psicodelico', 'rock psicodelico', 'psych']],
  ['rock experimental', 'rock experimental', 'rock', ['pos rock', 'post rock', 'math rock', 'krautrock']],
  ['pós-punk', 'pós-punk', 'rock', ['pos punk', 'post punk', 'new wave', 'dark']],
  ['shoegaze', 'shoegaze', 'rock', ['dream pop']],
  ['metal', 'metal', 'rock', ['heavy metal', 'thrash', 'death metal', 'rock pesado']],
  ['jazz', 'jazz', null, ['jazzistico']],
  ['blues', 'blues', null, []],
  ['folk', 'folk', null, ['folk rock', 'cancao folk', 'musica folclorica']],
  ['reggae', 'reggae', null, ['ska', 'dub', 'roots reggae']],
  ['rap', 'rap', null, ['hip hop', 'hiphop', 'trap']],
  ['funk carioca', 'funk carioca', null, ['funk', 'baile funk', 'funk brasileiro', 'miami bass']],
  ['soul e funk', 'soul e funk', null, ['soul', 'funk americano', 'r&b', 'rnb', 'disco']],
  ['música eletrônica', 'música eletrônica', null, ['eletronica', 'eletronico', 'techno', 'house', 'electro']],
  ['ambient', 'ambient', 'música eletrônica', ['ambiente', 'drone', 'new age']],
  ['noise', 'noise', null, ['barulho', 'industrial', 'harsh noise']],
  ['vanguarda', 'vanguarda', null, ['experimental', 'avant garde', 'musica experimental', 'musica concreta']],
  ['pop', 'pop', null, ['musica pop', 'synthpop', 'synth pop']],
  ['música instrumental', 'música instrumental', null, ['so instrumental', 'musica so instrumental']],
  ['clássica', 'clássica', null, ['classica', 'musica classica', 'erudito', 'erudita']],
  ['latina', 'música latina', null, ['latino', 'salsa', 'cumbia', 'tango', 'bolero']],
];
// "música instrumental" estava no vocabulário do gold como gênero; aqui é só alias de voz — veja `voz`.
// Fica listado para que o rótulo do gold encontre um id, mas sem mapeamento Discogs (marcado `voz: instrumental`).
const GENRE_ID = new Set(G.map(g => g[0]));

// ── regras Discogs → [[gênero, peso], ...]; a primeira regra que casa vale ─────────────────────────────
const R = (re, ...maps) => ({ re: new RegExp(re), maps });
const RULES = [
  // Latin: o que o Brasil tem de próprio
  R('^Latin---Samba$', ['samba', 1], ['samba de raiz', 0.4]),
  R('^Latin---Batucada$', ['samba', 0.6], ['samba de raiz', 0.4], ['pagode', 0.2]),
  R('^Latin---(Bossanova)$', ['bossa nova', 1], ['mpb', 0.3]),
  R('^Jazz---Bossa Nova$', ['bossa nova', 1], ['jazz', 0.4]),
  R('^Latin---MPB$', ['mpb', 1]),
  R('^Latin---Forró$', ['forró', 1]),
  R('^Latin---Baião$', ['baião', 1], ['forró', 0.6]),     // o Discogs lê partido-alto e breque como baião: ver prior no M1 futuro
  R('^Latin---Bolero$', ['samba-canção', 0.5], ['brega', 0.3], ['latina', 0.3]),
  R('^Latin---', ['latina', 1]),
  R('^Electronic---Latin$', ['latina', 0.6], ['música eletrônica', 0.5]),
  // Rock: classes que carregam um gênero próprio da lista
  R('^Rock---(Punk|Oi|Crust|Pop Punk|Power Violence|Psychobilly)$', ['punk', 1]),
  R('^Rock---(Hardcore|Post-Hardcore|Melodic Hardcore|Noisecore)$', ['hardcore', 1]),
  R('^Rock---(Post-Punk|Coldwave|Deathrock|Goth Rock|Darkwave)$', ['pós-punk', 1]),
  R('^Electronic---(Darkwave|New Wave)$', ['pós-punk', 0.6], ['música eletrônica', 0.4]),
  R('^Rock---(New Wave)$', ['pós-punk', 0.7], ['pop', 0.3]),
  R('^Rock---(Shoegaze|Dream Pop|Ethereal)$', ['shoegaze', 1], ['indie', 0.3]),
  R('^(Rock---(Psychedelic Rock|Acid Rock|Space Rock|Stoner Rock)|Funk / Soul---Psychedelic)$', ['psicodelia', 1], ['rock brasileiro', 0.3]),
  R('^Rock---(Indie Rock|Alternative Rock|Lo-Fi|Brit Pop|Power Pop|Grunge|Emo)$', ['indie', 1], ['rock brasileiro', 0.3]),
  R('^Pop---Indie Pop$', ['indie', 0.8], ['pop', 0.4]),
  R('^Rock---(.*Metal|Thrash|Deathcore|Goregrind|Grindcore|Pornogrind|Sludge Metal|Metalcore|Nu Metal)$', ['metal', 1]),
  R('^Rock---(Experimental|Avantgarde|Math Rock|Post Rock|No Wave|Krautrock|Art Rock|Prog Rock|Noise|Industrial|Symphonic Rock)$', ['rock experimental', 1], ['vanguarda', 0.3]),
  R('^Rock---(Rock & Roll|Beat|Twist|Yé-Yé|Rockabilly|Doo Wop|Mod|Surf)$', ['jovem guarda', 0.6], ['rock brasileiro', 0.5]),
  R('^Rock---(Folk Rock|Acoustic|Neofolk|Country Rock)$', ['folk', 0.6], ['indie', 0.3], ['rock brasileiro', 0.3]),
  R('^Rock---Blues Rock$', ['blues', 0.6], ['rock brasileiro', 0.5]),
  R('^Rock---Ska$', ['reggae', 0.7], ['punk', 0.3]),
  R('^Rock---', ['rock brasileiro', 0.6], ['rock', 0.4]),
  // Jazz, blues
  R('^Jazz---', ['jazz', 1]),
  R('^Blues---', ['blues', 1]),
  // Reggae
  R('^Reggae---', ['reggae', 1]),
  // Hip hop e vizinhos do funk carioca
  R('^Hip Hop---(Miami Bass|Bass Music|Bounce)$', ['funk carioca', 0.6], ['rap', 0.5]),
  R('^Hip Hop---(Trip Hop)$', ['música eletrônica', 0.5], ['rap', 0.4]),
  R('^Hip Hop---Instrumental$', ['rap', 0.8]),
  R('^Hip Hop---', ['rap', 1]),
  R('^Electronic---Hip Hop$', ['rap', 0.7], ['música eletrônica', 0.4]),
  // Soul e funk
  R('^Funk / Soul---Afrobeat$', ['soul e funk', 0.5], ['jazz', 0.3]),
  R('^Funk / Soul---Gospel$', ['soul e funk', 0.5], ['folk', 0.3]),
  R('^Funk / Soul---Disco$', ['soul e funk', 0.6], ['pop', 0.4]),
  R('^Funk / Soul---', ['soul e funk', 1]),
  R('^Electronic---(Disco|Nu-Disco|Italo-Disco|Euro-Disco|Hi NRG)$', ['soul e funk', 0.4], ['pop', 0.4], ['música eletrônica', 0.5]),
  // Eletrônica
  R('^Electronic---(Ambient|Dark Ambient|Drone|Illbient|Dungeon Synth|Berlin-School|Chillwave)$', ['ambient', 1], ['música eletrônica', 0.3]),
  R('^Electronic---New Age$', ['ambient', 0.8]),
  R('^Electronic---(Noise|Power Electronics|Rhythmic Noise|Industrial|Musique Concrète|Sound Collage|Glitch|Breakcore)$', ['noise', 0.8], ['vanguarda', 0.5]),
  R('^Electronic---(Experimental|Abstract|Leftfield)$', ['vanguarda', 1], ['música eletrônica', 0.5]),
  R('^Electronic---(Synth-pop|Dance-pop|Synthwave|Vaporwave|Eurodance|Eurobeat)$', ['pop', 0.7], ['música eletrônica', 0.6]),
  R('^Electronic---Modern Classical$', ['clássica', 0.6], ['ambient', 0.3]),
  R('^Electronic---Neofolk$', ['folk', 0.7]),
  R('^Electronic---Acid Jazz$', ['jazz', 0.6], ['música eletrônica', 0.5], ['soul e funk', 0.3]),
  R('^Electronic---', ['música eletrônica', 1]),
  // Pop
  R('^Pop---(Ballad|Vocal|Chanson|Light Music)$', ['pop', 0.6], ['mpb', 0.3]),
  R('^Pop---', ['pop', 1]),
  // Folk, world & country
  R('^Folk, World, & Country---(Country|Bluegrass|Hillbilly|Honky Tonk|Cajun)$', ['música caipira', 0.5], ['sertanejo raiz', 0.4], ['folk', 0.4]),
  R('^Folk, World, & Country---Fado$', ['modinha', 0.4], ['folk', 0.5]),
  R('^Folk, World, & Country---Gospel$', ['folk', 0.4], ['soul e funk', 0.3]),
  R('^Folk, World, & Country---', ['folk', 0.8]),
  // Clássica
  R('^Classical---', ['clássica', 1]),
  // Metais e marchas: o mais próximo no Brasil é a banda de frevo
  R('^Brass & Military---(Brass Band|Marches)$', ['frevo', 0.3]),
];

// Classes que não são gênero de música (fala, trilha, infantil, militar): entram em `ignorar`, nunca em `mapa`.
const IGNORE = /^(Non-Music---|Children's---|Stage & Screen---|Brass & Military---Military$)/;

const mapa = {}, ignorar = [];
for (const c of DISCOGS) {
  if (IGNORE.test(c)) { ignorar.push(c); continue; }
  const rule = RULES.find(r => r.re.test(c));
  if (!rule) { ignorar.push(c); continue; }
  mapa[c] = rule.maps.map(([genero, peso]) => ({ genero, peso }));
  for (const { genero } of mapa[c]) if (!GENRE_ID.has(genero)) throw new Error(`gênero inexistente ${genero} em ${c}`);
}

// ── humores: sinais medidos (probabilidades 0–1 do modelo) e/ou marcados como culturais ──────────────
const H = [
  ['melancólico', ['melancolico', 'triste', 'tristeza', 'chorosa', 'choroso', 'tristonho', 'blue'], { sad: 'alto', happy: 'baixo' }],
  ['festivo', ['festa', 'festivo', 'pra festa', 'balada', 'animada pra festa'], { party: 'alto', happy: 'alto' }],
  ['calmo', ['calma', 'calmo', 'tranquilo', 'tranquila', 'suave', 'pra relaxar', 'pra dormir', 'sossegado'], { relaxed: 'alto', aggressive: 'baixo' }],
  ['agressivo', ['agressivo', 'agressiva', 'pesado', 'pesada', 'raivoso', 'furioso', 'raiva'], { aggressive: 'alto' }],
  ['dançante', ['dancante', 'dancavel', 'pra dancar', 'balanco', 'gingado'], { dance: 'alto' }],
  ['nostálgico', ['nostalgico', 'nostalgia', 'saudade', 'saudosista', 'memoria'], {}],
  ['romântico', ['romantico', 'romantica', 'amor', 'apaixonado', 'namorar'], {}],
  ['alegre', ['alegre', 'feliz', 'animado', 'pra cima', 'alegria', 'sorriso'], { happy: 'alto' }],
  ['sombrio', ['sombrio', 'sombria', 'escuro', 'escura', 'dark', 'tenebroso', 'soturno'], { happy: 'baixo', sad: 'alto', aggressive: 'medio' }],
  ['intimista', ['intimista', 'intimo', 'intima', 'aconchegante', 'voz e violao', 'quartinho'], { acoustic: 'alto', relaxed: 'alto' }],
  ['contemplativo', ['contemplativo', 'contemplativa', 'meditativo', 'introspectivo', 'reflexivo', 'pra pensar'], { relaxed: 'alto', dance: 'baixo' }],
  ['irônico', ['ironico', 'ironica', 'debochado', 'sarcastico', 'humor'], {}],
  ['sensual', ['sensual', 'sexy', 'sedutor', 'sedutora', 'quente'], { relaxed: 'alto', dance: 'medio' }],
  ['épico', ['epico', 'epica', 'grandioso', 'grandiosa', 'monumental', 'cinematografico'], {}],
];

// ── instrumentos: nome pt-BR → classes do modelo mtg_jamendo_instrument (vazio = não medido) ───────────
const I = [
  ['violão', ['violao', 'violao de nylon', 'violao de aco'], ['acousticguitar', 'classicalguitar', 'guitar']],
  ['violão de sete cordas', ['sete cordas', '7 cordas', 'violao 7 cordas'], []],
  ['cavaquinho', ['cavaco'], []],
  ['pandeiro', [], ['percussion']],
  ['sanfona', ['acordeao', 'acordeon', 'gaita'], ['accordion']],
  ['piano', ['pianinho', 'piano eletrico'], ['piano', 'electricpiano', 'rhodes']],
  ['guitarra elétrica', ['guitarra', 'guitarras', 'guitarra eletrica'], ['electricguitar']],
  ['bateria', ['baterias', 'batera'], ['drums']],
  ['percussão', ['percussao', 'tambores', 'atabaque', 'surdo', 'tamborim'], ['percussion', 'bongo']],
  ['flauta', ['flautas', 'flautim'], ['flute']],
  ['bandolim', [], []],
  ['violino', ['rabeca', 'violinos'], ['violin']],
  ['sopros', ['sopro', 'metais', 'saxofone', 'sax', 'trompete', 'trombone', 'clarinete'], ['saxophone', 'trumpet', 'trombone', 'brass', 'horn', 'oboe', 'clarinet']],
  ['baixo', ['contrabaixo', 'baixo eletrico'], ['bass', 'doublebass', 'acousticbassguitar']],
  ['sintetizador', ['sintetizadores', 'synth', 'teclado', 'teclados'], ['synthesizer', 'keyboard', 'pad', 'computer', 'drummachine', 'sampler']],
  ['órgão', ['orgao', 'hammond'], ['organ', 'pipeorgan']],
  ['viola caipira', ['viola'], []],
  ['cordas', ['orquestra de cordas', 'violoncelo', 'harpa'], ['strings', 'cello', 'viola', 'harp', 'orchestra']],
  ['coro', ['coral', 'vozes', 'corais'], ['voice']],
];
for (const [, , cls] of I) for (const c of cls) if (!INSTR.includes(c)) throw new Error(`classe de instrumento desconhecida: ${c}`);

const ontologia = {
  versao: 0,
  gerado_em: new Date().toISOString().slice(0, 10),
  generos: G.map(([id, nome, pai, apelidos]) => ({ id, nome, pai, apelidos })),
  humores: H.map(([id, apelidos, sinais]) => ({ id, apelidos, sinais, medido: Object.keys(sinais).length > 0 })),
  instrumentos: I.map(([id, apelidos, essentia]) => ({ id, apelidos, essentia, medido: essentia.length > 0 })),
  formacoes: [
    { id: 'voz e violão', apelidos: ['voz e violao', 'so voz e violao', 'voz violao'] },
    { id: 'banda completa', apelidos: ['banda', 'banda completa', 'conjunto de rock'] },
    { id: 'orquestra', apelidos: ['orquestral', 'orquestra'] },
    { id: 'só instrumental', apelidos: ['so instrumental', 'sem voz', 'sem cantor', 'instrumental'] },
    { id: 'conjunto regional', apelidos: ['regional', 'conjunto regional', 'regional de choro'] },
    { id: 'duo', apelidos: ['dupla', 'duo', 'dueto'] },
    { id: 'coletânea', apelidos: ['coletanea', 'compilacao', 'varios artistas'] },
    { id: 'ao vivo', apelidos: ['ao vivo', 'live', 'show gravado'] },
  ],
  andamentos: [
    { id: 'lento', bpm: [0, 80], apelidos: ['lenta', 'lentinho', 'devagar', 'arrastado', 'vagaroso'] },
    { id: 'moderado', bpm: [80, 105], apelidos: ['moderada', 'meio termo', 'médio', 'medio', 'ritmo medio'] },
    { id: 'animado', bpm: [105, 130], apelidos: ['animada', 'agitado', 'agitada', 'pra cima'] },
    { id: 'acelerado', bpm: [130, 300], apelidos: ['acelerada', 'rapido', 'rapida', 'veloz', 'ligeiro', 'frenetico'] },
  ],
  voz: [
    { id: 'cantada', apelidos: ['cantada', 'com voz', 'com letra', 'cantado'], medido: 'voice >= 0.5' },
    { id: 'instrumental', apelidos: ['instrumental', 'sem voz', 'sem letra', 'sem cantor', 'so instrumental'], medido: 'voice < 0.5' },
  ],
  // "instrumental" é voz, não gênero (decisão M1a). O id 'música instrumental' do vocabulário do gold
  // existe só para o rótulo achar um id, e o motor deve traduzi-lo para voz = instrumental.
  traducoes: { 'música instrumental': { voz: 'instrumental' } },
  discogs: { classes: DISCOGS, mapa, ignorar },
  essentia: { instrumentos: INSTR },
};

writeFileSync(join(ROOT, 'data/ontologia-musical.json'), JSON.stringify(ontologia, null, 1) + '\n');
console.log(`ontologia: ${ontologia.generos.length} gêneros, ${ontologia.humores.length} humores, ${ontologia.instrumentos.length} instrumentos;`
  + ` Discogs ${Object.keys(mapa).length} mapeadas, ${ignorar.length} ignoradas (de ${DISCOGS.length})`);
