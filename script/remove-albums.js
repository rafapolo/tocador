#!/usr/bin/env bun
// Remove albums from a published acervo, by albumShareId, without the music volume.
//
//   bun script/remove-albums.js ../hominiscanidae/data/homi-albums.json.gz ids.json --dry-run
//   bun script/remove-albums.js ../hominiscanidae/data/homi-albums.json.gz ids.json
//
// ids.json is a JSON array of albumShareId strings (or of objects with an `id` field).
// The audio stays in S3. The output keeps the published format (v2 via convert-acervo-v2.js)
// and is refused unless every kept album decodes back unchanged and keeps its album-page slug
// (albumSlugs() numbers collisions by position, so dropping an album could renumber another).
// After it: build-features-web, build-genre-index, build-atlas-web, build-artistas-parecidos.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dir, '..');
const fmt = readFileSync(join(ROOT, 'js/acervo-format.js'), 'utf8');
const { decode, slugsOf, shareId } = new Function(fmt +
  '\nreturn { decode: decodeAcervo, slugsOf: albumSlugs, shareId: albumShareId };')();

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const [pubPath, idsPath, outPath = pubPath] = args.filter(a => a !== '--dry-run');
if (!pubPath || !idsPath) {
  console.error('uso: bun script/remove-albums.js <publicado.json.gz> <ids.json> [saida.json.gz] [--dry-run]');
  process.exit(1);
}

const readRaw = p => JSON.parse(new TextDecoder().decode(Bun.gunzipSync(readFileSync(p))));
const pubRaw = readRaw(pubPath);
const pub = decode(pubRaw);
const ids = new Set(JSON.parse(readFileSync(idsPath, 'utf8')).map(x => typeof x === 'string' ? x : x.id));

const canon = a => JSON.stringify({
  title: a.title, artist: a.artist, year: a.year || 0, path: a.path, has_cover: a.has_cover !== false,
  tracks: a.tracks.map(t => ({ title: t.title || '', num: t.num ?? null, file: t.file || '',
    artists: t.artists || a.artist, duration: t.duration || 0 })),
});

const removed = pub.albums.filter(a => ids.has(shareId(a.path)));
const kept = pub.albums.filter(a => !ids.has(shareId(a.path)));
const found = new Set(removed.map(a => shareId(a.path)));
const missing = [...ids].filter(id => !found.has(id));

console.log(`publicado: ${pub.albums.length} álbuns (v${pubRaw.v || 1})`);
console.log(`remover:   ${ids.size} ids → ${removed.length} encontrados, ${missing.length} ausentes`);
for (const a of removed) console.log(`  - ${a.path}  (${a.tracks.length} faixas)`);
for (const id of missing) console.log(`  ? ${id} não está no catálogo`);

if (!removed.length) { console.log('nada a remover.'); process.exit(0); }

const oldSlugs = new Map(slugsOf(pub.albums).map((s, i) => [pub.albums[i].path, s]));
const newSlugs = slugsOf(kept);
const moved = kept.filter((a, i) => newSlugs[i] !== oldSlugs.get(a.path));
if (moved.length) {
  console.error(`ERRO: ${moved.length} slugs mudariam (ex.: ${moved[0].path}) — nada foi escrito.`);
  process.exit(1);
}
if (dryRun) { console.log('--dry-run: slugs preservados; nada foi escrito.'); process.exit(0); }

const secs = kept.reduce((s, a) => s + a.tracks.reduce((x, t) => x + (t.duration || 0), 0), 0);
const meta = { ...pub.meta, hours: String(Math.round(secs / 3600)) };

const tmp = mkdtempSync(join(tmpdir(), 'remove-albums-'));
const v1Path = join(tmp, 'v1.json.gz');
const outTmp = join(tmp, 'out.json.gz');
writeFileSync(v1Path, Bun.gzipSync(Buffer.from(JSON.stringify({ meta, albums: kept })), { level: 9 }));
if (pubRaw.v === 2) {
  const r = Bun.spawnSync(['bun', join(ROOT, 'script/convert-acervo-v2.js'), v1Path, outTmp], { stdout: 'inherit', stderr: 'inherit' });
  if (r.exitCode !== 0) { console.error('ERRO: conversão v2 falhou — nada foi escrito.'); process.exit(1); }
} else {
  writeFileSync(outTmp, readFileSync(v1Path));
}

const outRaw = readRaw(outTmp);
const out = decode(outRaw);
const fail = msg => { console.error(`ERRO: ${msg} — nada foi escrito.`); rmSync(tmp, { recursive: true }); process.exit(1); };
if ((outRaw.v || 1) !== (pubRaw.v || 1)) fail('formato mudou');
if (out.albums.length !== kept.length) fail(`contagem ${out.albums.length} ≠ ${kept.length}`);
if (out.meta.base_url !== pub.meta.base_url) fail('base_url mudou');
const byPath = new Map(out.albums.map(a => [a.path, a]));
for (const a of kept) {
  const b = byPath.get(a.path);
  if (!b || canon(a) !== canon(b)) fail(`álbum mantido alterado: ${a.path}`);
}
for (const a of removed) if (byPath.has(a.path)) fail(`ainda presente: ${a.path}`);

writeFileSync(outPath, readFileSync(outTmp));
rmSync(tmp, { recursive: true });
console.log(`✓ ${outPath}: ${out.albums.length} álbuns, ${meta.hours} h (antes ${pub.meta.hours} h); mantidos intactos, slugs preservados`);
