#!/usr/bin/env bun
// build-atlas-web.js — turns data/features/atlas-coords.json.gz (script/build-atlas-coords.py) into the
// payload atlas.html reads: data/atlas-faixas.json.gz. Format in js/atlas-data.js.
//
// Keys from the analysis are matched to the published catalogs (aliases-<acervo>.json first, as
// build-features-web.js does); points whose track is no longer in a catalog are dropped. Each map is
// quantized to uint16 with one scale for both axes, so its shape is kept.
//
// Uso: bun script/build-atlas-web.js [--out <dir>]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOGS, catalogKeys } from './build-features-web.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const decodeAcervo = new Function(readFileSync(join(ROOT, 'js/acervo-format.js'), 'utf8') + '\nreturn decodeAcervo;')();
const A = new Function(readFileSync(join(ROOT, 'js/atlas-data.js'), 'utf8') + '\nreturn { ATLAS_FORMAT, atlasKeyHash, decodeAtlas };')();

const b64 = ta => Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength).toString('base64');
const median = a => { const s = Float64Array.from(a).sort(); return s.length ? s[s.length >> 1] : 0; };

// Seeded shuffle (mulberry32): points are drawn in array order, so no genre always ends on top.
function shuffle(arr, seed = 42) {
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}

export function buildAtlas(coords, catalogs, aliases = {}) {
  const pts = [];
  const stats = {};
  for (const [ai, acervo] of Object.keys(coords.acervos).entries()) {
    const c = coords.acervos[acervo];
    const inCatalog = new Set(catalogs[acervo]);
    const al = aliases[acervo] || {};
    const seen = new Map();                               // hash -> key, to catch collisions
    const st = stats[acervo] = { analise: c.keys.length, catalogo: inCatalog.size, pontos: 0, alias: 0, fora: 0, repetida: 0, colisao: 0 };
    c.keys.forEach((k0, i) => {
      let k = k0;
      if (!inCatalog.has(k) && al[k] && inCatalog.has(al[k])) { k = al[k]; st.alias++; }
      if (!inCatalog.has(k)) { st.fora++; return; }
      const h = A.atlasKeyHash(k);
      if (seen.get(h) === k) { st.repetida++; return; }    // an alias onto a track that was also analysed directly
      if (seen.has(h)) { st.colisao++; return; }            // two keys, one hash: the second goes without a point
      seen.set(h, k);
      pts.push({ a: ai, h, g: c.genre[i], som: c.som[i], rotulos: c.rotulos[i] });
      st.pontos++;
    });
    for (const [h, k] of seen) if (h !== A.atlasKeyHash(k)) throw new Error('hash instável');
  }
  shuffle(pts);

  const n = pts.length;
  const generos = [...new Set(pts.map(p => p.g))].sort();
  const gi = new Map(generos.map((g, i) => [g, i]));
  const c = { a: Uint8Array.from(pts, p => p.a), h: Uint32Array.from(pts, p => p.h), g: Uint16Array.from(pts, p => gi.get(p.g)) };
  const marcos = {};
  const minMax = a => a.reduce((r, v) => [Math.min(r[0], v), Math.max(r[1], v)], [Infinity, -Infinity]);
  for (const m of coords.mapas) {
    const xs = pts.map(p => p[m][0]), ys = pts.map(p => p[m][1]);
    const tem3d = pts[0][m].length === 3, zs = tem3d ? pts.map(p => p[m][2]) : null;
    const [x0, x1] = minMax(xs), [y0, y1] = minMax(ys), [z0, z1] = tem3d ? minMax(zs) : [0, 0];
    // One scale for every axis keeps the shape; z is centred in 0..65535 so the pivot sits mid-volume.
    const span = Math.max(x1 - x0, y1 - y0, z1 - z0) || 1;
    const q = new Uint16Array(2 * n), qz = tem3d ? new Uint16Array(n) : null;
    const zOff = tem3d ? (span - (z1 - z0)) / 2 : 0;
    for (let i = 0; i < n; i++) {
      q[2 * i] = Math.round((xs[i] - x0) / span * 65535);
      q[2 * i + 1] = Math.round((ys[i] - y0) / span * 65535);
      if (tem3d) qz[i] = Math.round((zs[i] - z0 + zOff) / span * 65535);
    }
    c[m] = q;
    if (tem3d) c[m + 'z'] = qz;
    // Label anchors: the median of each top-1 genre's points, kept only where the genre is a place
    // (most of its points near the median) rather than spread over the whole map.
    const by = new Map();
    for (let i = 0; i < n; i++) { const g = c.g[i]; if (!by.has(g)) by.set(g, []); by.get(g).push(i); }
    marcos[m] = [];
    for (const [g, idx] of by) {
      if (idx.length < 40) continue;
      const mx = median(idx.map(i => q[2 * i])), my = median(idx.map(i => q[2 * i + 1]));
      const mz = tem3d ? median(idx.map(i => qz[i])) : 32768;
      const spread = median(idx.map(i => Math.hypot(q[2 * i] - mx, q[2 * i + 1] - my, tem3d ? qz[i] - mz : 0)));
      if (spread > 0.12 * 65535) continue;
      marcos[m].push([g, Math.round(mx), Math.round(my), idx.length, Math.round(mz)]);
    }
    marcos[m].sort((a, b) => b[3] - a[3]);
  }
  const payload = {
    v: A.ATLAS_FORMAT, n, mapas: coords.mapas, acervos: Object.keys(coords.acervos), generos, marcos,
    c: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, b64(v)])),
  };
  return { payload, stats };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--out');
  const outDir = i >= 0 ? args[i + 1] : join(ROOT, 'data');
  const coords = JSON.parse(gunzipSync(readFileSync(join(ROOT, 'data/features/atlas-coords.json.gz'))).toString('utf8'));
  const catalogs = {}, aliases = {};
  for (const acervo of Object.keys(coords.acervos)) {
    const db = decodeAcervo(JSON.parse(gunzipSync(readFileSync(join(ROOT, CATALOGS[acervo]))).toString('utf8')));
    catalogs[acervo] = catalogKeys(db);
    const ap = join(ROOT, `data/features/aliases-${acervo}.json`);
    if (existsSync(ap)) {
      aliases[acervo] = Object.fromEntries(Object.entries(JSON.parse(readFileSync(ap, 'utf8')).aliases || {})
        .map(([f, t]) => [f.normalize('NFC'), t.normalize('NFC')]));
    }
  }
  const { payload, stats } = buildAtlas(coords, catalogs, aliases);
  // Round-trip through the browser decoder before writing.
  const back = A.decodeAtlas(JSON.parse(JSON.stringify(payload)));
  if (back.hash.length !== payload.n || back.pos.som.length !== 2 * payload.n) throw new Error('round-trip falhou');
  const gz = gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 });
  writeFileSync(join(outDir, 'atlas-faixas.json.gz'), gz);
  for (const [a, s] of Object.entries(stats)) {
    console.log(`${a}: ${s.pontos} pontos de ${s.catalogo} faixas no catálogo (${(100 * s.pontos / s.catalogo).toFixed(1)}%); `
      + `${s.alias} por alias, ${s.repetida} repetidas, ${s.fora} fora do catálogo, ${s.colisao} colisões de hash`);
  }
  console.log(`atlas-faixas.json.gz: ${payload.n} pontos, ${(gz.length / 1024).toFixed(0)} KB gz, `
    + `${payload.marcos.som.length}/${payload.marcos.rotulos.length} marcos`);
}
