#!/usr/bin/env bun
// build-features-web.js — compacta data/features/<acervo>.jsonl no payload colunar que o navegador lê
// (js/acervo-features.js): data/features/<acervo>-features.json.gz. Sem embeddings. Orçamento: ≤ 3 MB gz nos dois acervos.
//
// A linha i do payload é a i-ésima faixa do catálogo publicado (decodeAcervo, na ordem dos álbuns e das faixas):
// não há chave por faixa, só `cat` (nº de faixas + impressão digital das chaves) para detectar catálogo trocado.
// Faixa sem análise (erro, órfã sem alias) fica com bpm = 0.
//
// Uso: bun script/build-features-web.js [--acervo homi|uqt] [--out <dir>]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Same decoder and fingerprint the browser uses.
const decodeAcervo = new Function(readFileSync(join(ROOT, 'js/acervo-format.js'), 'utf8') + '\nreturn decodeAcervo;')();
const F = new Function(readFileSync(join(ROOT, 'js/acervo-features.js'), 'utf8')
  + '\nreturn { FEATURES_FORMAT, FEATURE_KEYS, FEATURE_PROBS, featuresFingerprint };')();

export const CATALOGS = {
  homi: '../hominiscanidae/data/homi-albums.json.gz',
  uqt: '../uqt/data/uqt-albums.json.gz',
};

const b64 = u8 => Buffer.from(u8.buffer, u8.byteOffset, u8.length).toString('base64');
const q255 = p => Math.max(0, Math.min(255, Math.round((p || 0) * 255)));

export function catalogKeys(db) {
  const keys = [];
  for (const a of db.albums) for (const t of a.tracks) keys.push(`${a.path}/${t.file}`.normalize('NFC'));
  return keys;
}

// rows: Map<NFC key, feature row from analyze-tracks.py>; keys: catalog keys in order.
export function encodeFeatures({ acervo, keys, rows }) {
  const n = keys.length;
  const bpm = new Uint16Array(n), bpmConf = new Uint8Array(n), tom = new Uint8Array(n), loud = new Uint8Array(n);
  const probs = Object.fromEntries(F.FEATURE_PROBS.map(k => [k, new Uint8Array(n)]));
  const g = new Uint16Array(3 * n), gw = new Uint8Array(3 * n), inst = new Uint8Array(3 * n);
  const genres = [], insts = [];
  const idx = (table, name) => { let i = table.indexOf(name); if (i < 0) { i = table.length; table.push(name); } return i + 1; };
  const stats = { sem_analise: 0, bpm_fora: 0 };

  keys.forEach((k, i) => {
    const r = rows.get(k);
    if (!r || !(r.bpm >= 30 && r.bpm <= 300)) {
      if (!r) stats.sem_analise++; else stats.bpm_fora++;
      return;                                           // bpm stays 0 = no usable analysis
    }
    bpm[i] = Math.round(r.bpm);
    bpmConf[i] = Math.max(0, Math.min(255, Math.round((r.bpm_conf || 0) * 40)));
    const ki = F.FEATURE_KEYS.indexOf(r.key);
    tom[i] = ki < 0 ? 0 : 1 + ki * 2 + (r.scale === 'minor' ? 1 : 0);
    loud[i] = Math.max(0, Math.min(255, Math.round(-(r.loud_db ?? 0))));
    for (const name of F.FEATURE_PROBS) probs[name][i] = q255(r[name]);
    (r.genre || []).slice(0, 3).forEach(([name, p], j) => { g[3 * i + j] = idx(genres, name); gw[3 * i + j] = q255(p); });
    (r.inst || []).slice(0, 3).forEach(([name], j) => { inst[3 * i + j] = idx(insts, name); });
  });

  const c = { bpm: b64(new Uint8Array(bpm.buffer)), bpmConf: b64(bpmConf), tom: b64(tom), loud: b64(loud), g: b64(new Uint8Array(g.buffer)), gw: b64(gw), inst: b64(inst) };
  for (const name of F.FEATURE_PROBS) c[name] = b64(probs[name]);
  // Uint16Array -> bytes is little-endian on every platform Bun/Node run on (x86, arm64).
  return {
    payload: { v: F.FEATURES_FORMAT, acervo, cat: { n, id: F.featuresFingerprint(keys) }, genres, insts, c },
    stats,
  };
}

export function loadRows(jsonlPath, aliasesPath) {
  const rows = new Map();
  for (const line of readFileSync(jsonlPath, 'utf8').split('\n')) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.error || !r.k) continue;
    delete r.emb;
    rows.set(r.k.normalize('NFC'), r);
  }
  let aliased = 0;
  if (aliasesPath && existsSync(aliasesPath)) {      // orphan key -> catalog key (script de integridade, M0); never overrides a direct hit
    const { aliases } = JSON.parse(readFileSync(aliasesPath, 'utf8'));
    for (const [from, to] of Object.entries(aliases || {})) {
      const f = from.normalize('NFC'), t = to.normalize('NFC');
      if (rows.has(f) && !rows.has(t)) { rows.set(t, rows.get(f)); aliased++; }
    }
  }
  return { rows, aliased };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const only = opt('--acervo');
  const outDir = opt('--out') || join(ROOT, 'data/features');
  let total = 0;
  for (const acervo of only ? [only] : Object.keys(CATALOGS)) {
    const db = decodeAcervo(JSON.parse(gunzipSync(readFileSync(join(ROOT, CATALOGS[acervo]))).toString('utf8')));
    const keys = catalogKeys(db);
    const { rows, aliased } = loadRows(join(ROOT, `data/features/${acervo}.jsonl`), join(ROOT, `data/features/aliases-${acervo}.json`));
    const { payload, stats } = encodeFeatures({ acervo, keys, rows });
    const gz = gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 });
    writeFileSync(join(outDir, `${acervo}-features.json.gz`), gz);
    total += gz.length;
    console.log(`${acervo}: ${keys.length} faixas, ${stats.sem_analise} sem análise, ${stats.bpm_fora} com bpm fora de 30–300, ${aliased} ligadas por alias; `
      + `${(gz.length / 1024 / 1024).toFixed(2)} MB gz (${(gz.length / keys.length).toFixed(1)} B/faixa)`);
  }
  console.log(`total ${(total / 1024 / 1024).toFixed(2)} MB gz (orçamento: 3 MB para os dois acervos)`);
  if (!only && total > 3 * 1024 * 1024) { console.error('ESTOUROU o orçamento'); process.exit(1); }
}
