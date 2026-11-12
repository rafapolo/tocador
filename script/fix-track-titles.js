#!/usr/bin/env bun
// Fix track titles in a published acervo, without the music volume.
//
//   bun script/fix-track-titles.js ../hominiscanidae/data/homi-albums.json.gz edits.json --dry-run
//   bun script/fix-track-titles.js ../hominiscanidae/data/homi-albums.json.gz edits.json
//
// edits.json: [{ "path": "<album path>", "titles": ["first track", ...], "fonte": "where the names came from" }]
// `titles` has one entry per track, in catalog order (null keeps that one). Only titles change: files, numbers,
// artists, the album's own title/artist/year (and so its album-page slug), every other album, base_url and the
// published format are checked to stay exactly as they were, or nothing is written. File names are S3 keys and
// feature keys, so they never change here.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dir, '..');
const fmt = readFileSync(join(ROOT, 'js/acervo-format.js'), 'utf8');
const { decode, slugsOf } = new Function(fmt + '\nreturn { decode: decodeAcervo, slugsOf: albumSlugs };')();

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const [pubPath, editsPath, outPath = pubPath] = args.filter(a => a !== '--dry-run');
if (!pubPath || !editsPath) {
  console.error('uso: bun script/fix-track-titles.js <publicado.json.gz> <edits.json> [saida.json.gz] [--dry-run]');
  process.exit(1);
}

const readRaw = p => JSON.parse(new TextDecoder().decode(Bun.gunzipSync(readFileSync(p))));
const pubRaw = readRaw(pubPath);
const pub = decode(pubRaw);
const edits = JSON.parse(readFileSync(editsPath, 'utf8'));

const canon = (a, semTitulos = false) => JSON.stringify({
  title: a.title, artist: a.artist, year: a.year || 0, path: a.path, has_cover: a.has_cover !== false,
  tracks: a.tracks.map(t => ({ title: semTitulos ? '' : t.title || '', num: t.num ?? null, file: t.file || '',
    artists: t.artists || a.artist, duration: t.duration || 0 })),
});

const porPath = new Map(pub.albums.map(a => [a.path.normalize('NFC'), a]));
const novos = structuredClone(pub.albums);
const novoPorPath = new Map(novos.map(a => [a.path.normalize('NFC'), a]));
let mudou = 0;
for (const e of edits) {
  const a = porPath.get(e.path.normalize('NFC'));
  if (!a) { console.error(`ERRO: álbum não está no catálogo: ${e.path}`); process.exit(1); }
  if (e.titles.length !== a.tracks.length) {
    console.error(`ERRO: ${e.path}: ${e.titles.length} títulos para ${a.tracks.length} faixas`);
    process.exit(1);
  }
  const n = novoPorPath.get(e.path.normalize('NFC'));
  console.log(`${a.path}${e.fonte ? `  (fonte: ${e.fonte})` : ''}`);
  e.titles.forEach((t, i) => {
    if (t == null || t === a.tracks[i].title) return;
    console.log(`  ${String(i + 1).padStart(2)}. ${a.tracks[i].title}  →  ${t}   [${a.tracks[i].file}]`);
    n.tracks[i].title = t;
    mudou++;
  });
}
if (!mudou) { console.log('nada a mudar.'); process.exit(0); }

const antes = slugsOf(pub.albums), depois = slugsOf(novos);
const movidos = depois.filter((s, i) => s !== antes[i]);
if (movidos.length) { console.error(`ERRO: ${movidos.length} slugs mudariam — nada foi escrito.`); process.exit(1); }
if (dryRun) { console.log(`--dry-run: ${mudou} títulos; slugs preservados; nada foi escrito.`); process.exit(0); }

const tmp = mkdtempSync(join(tmpdir(), 'fix-track-titles-'));
const v1Path = join(tmp, 'v1.json.gz'), outTmp = join(tmp, 'out.json.gz');
writeFileSync(v1Path, Bun.gzipSync(Buffer.from(JSON.stringify({ meta: pub.meta, albums: novos })), { level: 9 }));
if (pubRaw.v === 2) {
  const r = Bun.spawnSync(['bun', join(ROOT, 'script/convert-acervo-v2.js'), v1Path, outTmp], { stdout: 'inherit', stderr: 'inherit' });
  if (r.exitCode !== 0) { console.error('ERRO: conversão v2 falhou — nada foi escrito.'); process.exit(1); }
} else writeFileSync(outTmp, readFileSync(v1Path));

const outRaw = readRaw(outTmp), out = decode(outRaw);
const fail = msg => { console.error(`ERRO: ${msg} — nada foi escrito.`); rmSync(tmp, { recursive: true }); process.exit(1); };
if ((outRaw.v || 1) !== (pubRaw.v || 1)) fail('formato mudou');
if (out.albums.length !== pub.albums.length) fail('contagem de álbuns mudou');
if (JSON.stringify(out.meta) !== JSON.stringify(pub.meta)) fail('meta mudou');
const editados = new Set(edits.map(e => e.path.normalize('NFC')));
out.albums.forEach((b, i) => {
  const a = pub.albums[i], k = a.path.normalize('NFC');
  if (b.path !== a.path) fail(`ordem mudou em ${a.path}`);
  if (editados.has(k)) {
    if (canon(a, true) !== canon(b, true)) fail(`mais que títulos mudou em ${a.path}`);
    if (canon(b) !== canon(novoPorPath.get(k))) fail(`títulos não ficaram como pedido em ${a.path}`);
  } else if (canon(a) !== canon(b)) fail(`álbum não editado mudou: ${a.path}`);
});

writeFileSync(outPath, readFileSync(outTmp));
rmSync(tmp, { recursive: true });
console.log(`✓ ${outPath}: ${mudou} títulos corrigidos; o resto intacto, slugs preservados`);
