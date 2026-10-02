// consulta-bench.js — latência da interpretação e da busca nos acervos reais (uqt, homi) + tamanho dos dados.
// Uso: bun script/consulta-bench.js   (precisa de ../uqt, ../hominiscanidae e data/features/*-features.json.gz)
// Metas (tasks/proximos-passos.md 5.1.6): interpretação < 50 ms, busca < 100 ms, features ≤ 3 MB gz no total.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
createRequire(import.meta.url)('../js/acervo-format.js');
const load = new Function(['util', 'acervo-features', 'consulta-pt'].map(f => fs.readFileSync(path.join(ROOT, `js/${f}.js`), 'utf8')).join('\n')
  + '\nreturn { consultaLexico, consultaInterpretar, consultaAgregar, consultaFiltrar, decodeFeatures, consultaPalavrasDeNome };');
const { consultaLexico, consultaInterpretar, consultaAgregar, consultaFiltrar, decodeFeatures, consultaPalavrasDeNome } = load();
const onto = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/ontologia-musical.json'), 'utf8'));
const lex = consultaLexico(onto);
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const FRASES = ['samba lento dos anos 60', 'algo calmo pra dormir', 'forro dancante anos 90', 'so instrumental, sem bateria', 'mais lento que construcao',
  'choro com bandolim', 'rock pesado de garagem', 'cartola anos 70 e 80', 'me surpreenda com algo triste', 'letra da musica X', 'jazz tranquilo', 'tira o que e samba'];
const med = a => [...a].sort((x, y) => x - y)[a.length >> 1];
let totalFeat = 0;
for (const [alias, cat, feat] of [['uqt', '../uqt/data/uqt-albums.json.gz', 'data/features/uqt-features.json.gz'], ['homi', '../hominiscanidae/data/homi-albums.json.gz', 'data/features/homi-features.json.gz']]) {
  const cp = path.join(ROOT, cat), fp = path.join(ROOT, feat);
  if (!fs.existsSync(cp) || !fs.existsSync(fp)) { console.log(`${alias}: faltam arquivos, pulei`); continue; }
  const db = globalThis.decodeAcervo(JSON.parse(zlib.gunzipSync(fs.readFileSync(cp)).toString('utf8')));
  const keys = []; for (const a of db.albums) for (const t of a.tracks) keys.push(`${a.path}/${t.file}`.normalize('NFC'));
  const albums = db.albums.map(a => ({ path: a.path, year: a.year, nameLower: fold(a.title), artistsLower: fold(a.artist), pathLower: fold(a.path), tracks: a.tracks.map(t => ({ titleLower: fold(t.title), artistsLower: fold(t.artists) })) }));
  const bytes = fs.statSync(fp).size; totalFeat += bytes;
  let t0 = performance.now();
  const f = decodeFeatures(JSON.parse(zlib.gunzipSync(fs.readFileSync(fp)).toString('utf8')), keys);
  const tDec = performance.now() - t0; t0 = performance.now();
  const agg = consultaAgregar(db, f, onto);
  const tAgg = performance.now() - t0;
  const nome = consultaPalavrasDeNome(albums).nome;
  const ti = [], tb = [];
  for (let r = 0; r < 20; r++) for (const fr of FRASES) {
    let a = performance.now(); const q = consultaInterpretar(fr, lex, () => true, nome); ti.push(performance.now() - a);
    a = performance.now(); if (q.tipo !== 'fora_do_dominio') consultaFiltrar(q, agg, albums); tb.push(performance.now() - a);
  }
  console.log(`${alias}: ${albums.length} álbuns, ${keys.length} faixas | features ${(bytes / 1048576).toFixed(2)} MB gz | decodificar ${tDec.toFixed(0)} ms, agregar ${tAgg.toFixed(0)} ms (uma vez por carga)`);
  console.log(`  interpretação: mediana ${med(ti).toFixed(2)} ms, máx ${Math.max(...ti).toFixed(2)} ms | busca: mediana ${med(tb).toFixed(1)} ms, máx ${Math.max(...tb).toFixed(1)} ms`);
}
console.log(`features no total: ${(totalFeat / 1048576).toFixed(2)} MB gz (orçamento 3 MB) | ontologia ${(fs.statSync(path.join(ROOT, 'data/ontologia-musical.json')).size / 1024).toFixed(0)} KB`);
const js = ['consulta-pt', 'acervo-features', 'chat'].map(f => [f, fs.statSync(path.join(ROOT, `js/${f}.js`)).size]);
console.log('código (fonte): ' + js.map(([f, n]) => `${f}.js ${(n / 1024).toFixed(0)} KB`).join(', '));
