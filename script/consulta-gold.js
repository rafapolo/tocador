// consulta-gold.js — mede js/consulta-pt.js contra data/qgen/gold/gold.jsonl (rótulo cego do Opus).
// Uso: bun script/consulta-gold.js [--erros tipo|generos|andamento|humor]
// Métricas: tipo (acerto), gênero/humor (F1 entre os casos em que o gold tem o campo), andamento (acerto entre os casos com andamento).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = new Function(fs.readFileSync(path.join(ROOT, 'js/util.js'), 'utf8') + '\n' + fs.readFileSync(path.join(ROOT, 'js/consulta-pt.js'), 'utf8')
  + '\nreturn { consultaLexico, consultaInterpretar };');
const { consultaLexico, consultaInterpretar } = load();
const onto = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/ontologia-musical.json'), 'utf8'));
const lex = consultaLexico(onto);
const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const gold = fs.readFileSync(path.join(ROOT, 'data/qgen/gold/gold.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const ids = new Map(onto.generos.map(g => [fold(g.id), g.id]));
const alias = new Map(); for (const g of onto.generos) { alias.set(fold(g.id), g.id); for (const a of g.apelidos || []) alias.set(fold(a), g.id); }
const humIds = new Map(onto.humores.map(h => [fold(h.id), h.id]));
const goldGen = l => (l.generos || []).map(g => alias.get(fold(g))).filter(Boolean);
const goldHum = l => (l.humor || []).map(h => humIds.get(fold(h))).filter(Boolean);

const f1 = (rows) => {
  let tp = 0, fp = 0, fn = 0;
  for (const [g, p] of rows) { const G = new Set(g), P = new Set(p); for (const x of P) G.has(x) ? tp++ : fp++; for (const x of G) if (!P.has(x)) fn++; }
  const pr = tp / (tp + fp || 1), rc = tp / (tp + fn || 1);
  return { p: pr, r: rc, f1: pr + rc ? 2 * pr * rc / (pr + rc) : 0, n: rows.length };
};

const t0 = performance.now();
const res = gold.map(({ gid, q, label }) => ({ gid, q, label, out: consultaInterpretar(q, lex) }));
const ms = (performance.now() - t0) / gold.length;

const tipoOk = res.filter(r => r.out.tipo === r.label.tipo).length;
const g = f1(res.filter(r => goldGen(r.label).length).map(r => [goldGen(r.label), r.out.generos]));
const h = f1(res.filter(r => goldHum(r.label).length).map(r => [goldHum(r.label), r.out.humor]));
const comAnd = res.filter(r => r.label.andamento);
const andOk = comAnd.filter(r => r.out.andamento === r.label.andamento).length;
const fora = res.filter(r => r.label.tipo === 'fora_do_dominio');
const foraOk = fora.filter(r => r.out.tipo === 'fora_do_dominio').length;
const pct = x => (100 * x).toFixed(1) + '%';
console.log(`tipo: ${pct(tipoOk / res.length)} (${tipoOk}/${res.length}) | recusa correta: ${pct(foraOk / fora.length)} (${foraOk}/${fora.length})`);
console.log(`gênero: F1 ${pct(g.f1)} (p ${pct(g.p)}, r ${pct(g.r)}, n=${g.n}) | humor: F1 ${pct(h.f1)} (p ${pct(h.p)}, r ${pct(h.r)}, n=${h.n}) | andamento: ${pct(andOk / comAnd.length)} (${andOk}/${comAnd.length})`);
console.log(`interpretação: ${ms.toFixed(3)} ms por pergunta`);

const mode = process.argv[process.argv.indexOf('--erros') + 1];
if (process.argv.includes('--erros')) {
  for (const r of res) {
    let bad = false, det = '';
    if (mode === 'tipo') { bad = r.out.tipo !== r.label.tipo; det = `gold ${r.label.tipo}/${r.label.categoria_fora} obtido ${r.out.tipo}/${r.out.categoria_fora}`; }
    if (mode === 'generos') { bad = JSON.stringify([...goldGen(r.label)].sort()) !== JSON.stringify([...r.out.generos].sort()) && goldGen(r.label).length; det = `gold ${goldGen(r.label)} obtido ${r.out.generos}`; }
    if (mode === 'andamento') { bad = r.label.andamento && r.out.andamento !== r.label.andamento; det = `gold ${r.label.andamento} obtido ${r.out.andamento}`; }
    if (mode === 'humor') { bad = JSON.stringify([...goldHum(r.label)].sort()) !== JSON.stringify([...r.out.humor].sort()) && goldHum(r.label).length; det = `gold ${goldHum(r.label)} obtido ${r.out.humor}`; }
    if (bad) console.log(`- "${r.q}" → ${det}`);
  }
}

// Held-out sanity check: train.jsonl was NOT used to tune the rules. Family → expected type (A,B search; C reference; D refusal).
if (process.argv.includes('--train')) {
  const rows = fs.readFileSync(path.join(ROOT, 'data/qgen/train.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const esperado = { A: 'busca', B: 'busca', C: 'referencial', D: 'fora_do_dominio' };
  const por = {};
  for (const r of rows) {
    if (r.quality === 'duvidoso' || !esperado[r.family]) continue;
    const o = consultaInterpretar(r.q, lex);
    const b = (por[r.family] ||= { ok: 0, n: 0 });
    b.n++; if (o.tipo === esperado[r.family]) b.ok++;
  }
  for (const [fam, b] of Object.entries(por)) console.log(`treino (fora do ajuste) família ${fam} → ${esperado[fam]}: ${pct(b.ok / b.n)} (${b.ok}/${b.n})`);
}
