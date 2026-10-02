import { test, expect, describe } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { encodeFeatures } from '../script/build-features-web.js';

const ROOT = path.join(import.meta.dir, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const C = new Function(read('js/util.js') + '\n' + read('js/acervo-features.js') + '\n' + read('js/consulta-pt.js')
  + '\nreturn { consultaLexico, consultaInterpretar, consultaAgregar, consultaFiltrar, consultaRelativo, consultaEvidencias, decodeFeatures, consultaWithin };')();
const onto = JSON.parse(read('data/ontologia-musical.json'));
const lex = C.consultaLexico(onto);
const Q = s => C.consultaInterpretar(s, lex);

describe('interpretação: o que cada frase vira', () => {
  test('samba lento dos anos 60', () => {
    const q = Q('samba lento dos anos 60');
    expect(q.generos).toEqual(['samba']);
    expect(q.andamento).toBe('lento');
    expect(q.tipo).toBe('busca');
  });
  test('sem acento, abreviado e com erro de digitação', () => {
    expect(Q('forro dancante anos 90').generos).toEqual(['forró']);
    expect(Q('forro dancante anos 90').humor).toEqual(['dançante']);
    expect(Q('sabma lento').generos).toEqual(['samba']);            // troca de letras vizinhas
    expect(Q('sabma lento').notas.some(n => /1 letra/.test(n[1]))).toBe(true);
  });
  test('uma troca de letra em palavra curta não vira outra palavra (tanto ≠ tango, plano ≠ piano)', () => {
    expect(Q('tanto faz').generos).toEqual([]);
    expect(Q('plano de celular').instrumentos).toEqual([]);
  });
  test('negação: "sem bateria", "tira o que é samba"', () => {
    const q = Q('rock sem bateria');
    expect(q.generos).toEqual(['rock']);
    expect(q.excluir.instrumentos).toEqual(['bateria']);
    expect(q.instrumentos).toEqual([]);
    const r = Q('tira o que é samba');
    expect(r.excluir.generos).toEqual(['samba']);
    expect(r.generos).toEqual([]);
  });
  test('"sem voz" é voz instrumental, não instrumento excluído', () => {
    expect(Q('só instrumental, sem bateria').voz).toBe('instrumental');
    expect(Q('só instrumental, sem bateria').excluir.instrumentos).toEqual(['bateria']);
  });
  test('apelidos e frases de várias palavras', () => {
    expect(Q('algo calmo pra dormir').humor).toEqual(['calmo']);
    expect(Q('choro com bandolim').instrumentos).toEqual(['bandolim']);
    expect(Q('rock pesado de garagem').generos).toContain('metal');          // "rock pesado" é apelido de metal
    expect(Q('som pesado').humor).toContain('agressivo');
    expect(Q('me surpreenda com algo triste').humor).toEqual(['melancólico']);
  });
  test('"mais lento que X" vira referencial com relação; sem "que X" vira refinamento', () => {
    const q = Q('mais lento que Construção');
    expect(q.tipo).toBe('referencial');
    expect(q.referencia).toEqual({ texto: 'construcao', relacao: 'mais_lento' });
    const r = Q('mais lento');
    expect(r.tipo).toBe('busca');
    expect(r.relativo).toBe('mais_lento');
    expect(Q('menos agressivo que Construção').referencia.relacao).toBe('mais_calmo');
  });
  test('"parecido com X" é referência, "tipo samba" é gênero', () => {
    expect(Q('parecido com Cartola').referencia.relacao).toBe('parecido');
    expect(Q('tipo samba').generos).toEqual(['samba']);
    expect(Q('tipo samba').referencia).toBeNull();
  });
  test('recusa com categoria', () => {
    expect(Q('letra da música Construção')).toMatchObject({ tipo: 'fora_do_dominio', categoria_fora: 'letra' });
    expect(Q('quero ouvir no spotify')).toMatchObject({ tipo: 'fora_do_dominio', categoria_fora: 'plataforma' });
    expect(Q('quem foi Cartola?').categoria_fora).toBe('biografia');
    expect(Q('instrumental mas com bastante letra pra cantar junto').categoria_fora).toBe('contraditorio');
    expect(Q('samba lento e acelerado').categoria_fora).toBe('contraditorio');
    expect(Q('música eletrônica épica dos anos 40').categoria_fora).toBe('impossivel');
    expect(Q('oi')).toMatchObject({ tipo: 'fora_do_dominio', categoria_fora: 'conversa' });
  });
  test('comandos curtos viram comando, não busca', () => {
    expect(Q('pause')).toMatchObject({ categoria_fora: 'comando', comando: 'pausar' });
    expect(Q('eta?')).toMatchObject({ categoria_fora: 'comando', comando: 'status' });
  });
  test('as palavras que sobram ficam em "resto" (nome de artista, título)', () => {
    const q = Q('samba do Cartola');
    expect(q.generos).toEqual(['samba']);
    expect(q.resto).toContain('cartola');
  });
  test('rápido: milhares de frases em poucos milissegundos', () => {
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) Q('samba lento dos anos 60 sem bateria, algo calmo pra dormir');
    expect((performance.now() - t0) / 2000).toBeLessThan(2);
  });
});

// ── filtros sobre features sintéticas ────────────────────────────────────

const track = (k, o = {}) => ({
  k, bpm: 100, bpm_conf: 3, key: 'C', scale: 'major', loud_db: -12,
  voice: 0.8, dance: 0.3, acoustic: 0.8, electronic: 0.05, happy: 0.3, sad: 0.5, relaxed: 0.8, aggressive: 0.02, party: 0.1,
  genre: [['Latin---Samba', 0.5], ['Latin---Bossanova', 0.2]], inst: [['acousticguitar', 0.6], ['percussion', 0.3]], ...o,
});
const A = (path, year, title, artist, n = 2) => ({ path, year, title, artist, tracks: Array.from({ length: n }, (_, i) => ({ file: `0${i + 1}.mp3`, title: `faixa ${i}` })) });
const db = {
  albums: [
    A('1960 - X - Lento', 1960, 'Lento', 'X'), A('1970 - Y - Rapido', 1970, 'Rapido', 'Y'), A('1980 - Z - Rock', 1980, 'Rock Pesado', 'Z'),
    A('1990 - W - Duvida', 1990, 'Duvida', 'W'), A('2000 - V - Sem analise', 2000, 'Sem analise', 'V'),
  ],
};
const keys = db.albums.flatMap(a => a.tracks.map(t => `${a.path}/${t.file}`));
const rows = new Map();
const put = (album, o) => db.albums[album].tracks.forEach(t => rows.set(`${db.albums[album].path}/${t.file}`, track(`${db.albums[album].path}/${t.file}`, o)));
put(0, { bpm: 62 });
put(1, { bpm: 150, dance: 0.9, voice: 0.9 });
put(2, { bpm: 170, genre: [['Rock---Punk', 0.7]], inst: [['electricguitar', 0.6], ['drums', 0.5]], aggressive: 0.9, relaxed: 0.1, acoustic: 0.1, voice: 0.3, sad: 0.2, happy: 0.4 });
put(3, { bpm: 150, bpm_conf: 0.5 });                    // andamento duvidoso: 150 pode ser 75
// álbum 4: sem análise
const { payload } = encodeFeatures({ acervo: 'teste', keys, rows });
const feats = C.decodeFeatures(JSON.parse(JSON.stringify(payload)), keys);
const agg = C.consultaAgregar(db, feats, onto);
const albums = db.albums.map(a => ({
  ...a, name: a.title, nameLower: a.title.toLowerCase(), artistsLower: a.artist.toLowerCase(), pathLower: a.path.toLowerCase(),
  tracks: a.tracks.map(t => ({ titleLower: t.title })),
}));
const run = s => C.consultaFiltrar(Q(s), agg, albums).hits.map(h => h.a.title);

describe('filtros por features', () => {
  test('andamento: faixa de BPM, com meio/dobro de tempo só quando o detector não confia', () => {
    expect(run('lento')).toEqual(['Lento', 'Duvida']);          // 62 bpm; e 150 com confiança 0,5 conta como 75
    expect(run('acelerado')).toEqual(expect.arrayContaining(['Rapido', 'Rock Pesado']));
    expect(run('acelerado')).not.toContain('Lento');
  });
  test('gênero inferido das classes Discogs', () => {
    expect(run('samba')).toEqual(expect.arrayContaining(['Lento', 'Rapido']));
    expect(run('samba')).not.toContain('Rock Pesado');
    expect(run('punk')).toEqual(['Rock Pesado']);
  });
  test('voz e humor medidos; "alto/baixo" são relativos ao acervo', () => {
    expect(run('instrumental')).toEqual(['Rock Pesado']);
    expect(run('agressivo')).toEqual(['Rock Pesado']);
  });
  test('instrumento e exclusão', () => {
    expect(run('com bateria')).toEqual(['Rock Pesado']);
    expect(run('samba sem violão')).toEqual([]);
    expect(run('rock')).toEqual(['Rock Pesado']);
  });
  test('álbum sem análise nunca passa por filtro medido', () => {
    for (const s of ['lento', 'samba', 'instrumental', 'calmo']) expect(run(s)).not.toContain('Sem analise');
  });
  test('uma faceta que só existe como texto é relaxada, e o filtro diz qual', () => {
    const r = C.consultaFiltrar(Q('samba com bandolim'), agg, albums);
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.relaxados).toEqual(['instrumento: bandolim']);
  });
  test('evidências: medido × inferido × cultural, com confiança', () => {
    const q = Q('samba lento');
    const ev = C.consultaEvidencias(q, agg, albums[0]);
    expect(ev.map(e => e[2])).toEqual(expect.arrayContaining(['medido', 'inferido']));
    expect(ev.every(e => e[3] >= 0 && e[3] <= 1)).toBe(true);
    expect(ev.find(e => e[0].startsWith('andamento'))[1]).toContain('BPM mediano 62');
    expect(ev.find(e => e[0].startsWith('gênero'))[1]).toContain('inferido');
  });
  test('mais lento que X compara o BPM com o da referência', () => {
    const r = C.consultaRelativo('mais_lento', albums[1], agg, albums);
    expect(r.hits.map(h => h.a.title)).toEqual(expect.arrayContaining(['Lento']));
    expect(r.hits.map(h => h.a.title)).not.toContain('Rock Pesado');
  });
});

describe('contra o acervo real (se os dados estiverem na máquina)', () => {
  const real = fs.existsSync(path.join(ROOT, 'data/features/uqt-features.json.gz')) && fs.existsSync(path.join(ROOT, '../uqt/data/uqt-albums.json.gz'));
  test.skipIf(!real)('uqt: "samba lento" devolve álbuns com BPM baixo e o filtro roda em < 100 ms', () => {
    const { gunzipSync } = require('zlib');
    const decodeAcervo = new Function(read('js/acervo-format.js') + '\nreturn decodeAcervo;')();
    const dbr = decodeAcervo(JSON.parse(gunzipSync(fs.readFileSync(path.join(ROOT, '../uqt/data/uqt-albums.json.gz')))));
    const ks = dbr.albums.flatMap(a => a.tracks.map(t => `${a.path}/${t.file}`.normalize('NFC')));
    const f = C.decodeFeatures(JSON.parse(gunzipSync(fs.readFileSync(path.join(ROOT, 'data/features/uqt-features.json.gz')))), ks);
    const ag = C.consultaAgregar(dbr, f, onto);
    const lst = dbr.albums.map(a => ({ ...a, name: a.title, nameLower: a.title.toLowerCase(), artistsLower: a.artist.toLowerCase(), pathLower: a.path.toLowerCase(), tracks: a.tracks.map(t => ({ titleLower: t.title.toLowerCase() })) }));
    const t0 = performance.now();
    const r = C.consultaFiltrar(Q('samba lento'), ag, lst);
    expect(performance.now() - t0).toBeLessThan(100);
    expect(r.hits.length).toBeGreaterThan(20);
    for (const h of r.hits.slice(0, 20)) expect(ag.porAlbum.get(h.a.path.normalize('NFC')).bpm).toBeLessThan(110);
  });
});
