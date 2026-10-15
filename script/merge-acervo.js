#!/usr/bin/env bun
// Append the albums of a partial catalog (generate-albums run on a staging dir that
// holds only the new downloads) to a published acervo, without the music volume.
//
//   bun script/merge-acervo.js ../hominiscanidae/data/homi-albums.json.gz novos.json.gz
//   bun script/merge-acervo.js publicado.json.gz novos.json.gz saida.json.gz
//   ... --dry-run   # report what would be added/rejected, write nothing
//
// generate-albums only dedups folders it can see, so a new album is checked here against
// the whole published catalog and rejected when it repeats an existing path, the same
// (artist, title, year), or the same artist with the same tracklist (titles + durations).
// The output keeps the published format (v2 via convert-acervo-v2.js, which verifies its
// own round-trip) and is refused unless every old album decodes back unchanged and keeps
// its album-page slug (albumSlugs() numbers collisions by position, so order matters).

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dir, '..');
const fmt = readFileSync(join(ROOT, 'js/acervo-format.js'), 'utf8');
const { decode, slugsOf } = new Function(fmt + '\nreturn { decode: decodeAcervo, slugsOf: albumSlugs };')();

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const [pubPath, newPath, outPath = pubPath] = args.filter(a => a !== '--dry-run');
if (!pubPath || !newPath) {
  console.error('uso: bun script/merge-acervo.js <publicado.json.gz> <novos.json.gz> [saida.json.gz] [--dry-run]');
  process.exit(1);
}

const readRaw = p => JSON.parse(new TextDecoder().decode(Bun.gunzipSync(readFileSync(p))));
const pubRaw = readRaw(pubPath);
const pub = decode(pubRaw);
const fresh = decode(readRaw(newPath));

const norm = s => (s || '').normalize('NFC').toLowerCase().trim();
const titleKey = a => `${norm(a.artist)}\u0000${norm(a.title)}\u0000${a.year || 0}`;
const tracksKey = a => `${norm(a.artist)}\u0000` + a.tracks.map(t => `${norm(t.title)}:${t.duration || 0}`).join('|');
// Strip what decodeAcervo adds or normalises so v1 input and v2-decoded output compare.
const canon = a => JSON.stringify({
  title: a.title, artist: a.artist, year: a.year || 0, path: a.path, has_cover: a.has_cover !== false,
  tracks: a.tracks.map(t => ({ title: t.title || '', num: t.num ?? null, file: t.file || '',
    artists: t.artists || a.artist, duration: t.duration || 0 })),
});

const paths = new Set(pub.albums.map(a => norm(a.path)));
const titles = new Set(pub.albums.map(titleKey));
const lists = new Set(pub.albums.map(tracksKey));

const added = [];
const rejected = [];
for (const a of fresh.albums) {
  const why = !a.tracks.length ? 'sem faixas'
    : paths.has(norm(a.path)) ? 'path já existe'
    : titles.has(titleKey(a)) ? 'mesmo artista/título/ano'
    : lists.has(tracksKey(a)) ? 'mesmo artista e tracklist'
    : null;
  if (why) { rejected.push([a.path, why]); continue; }
  added.push(a);
  paths.add(norm(a.path)); titles.add(titleKey(a)); lists.add(tracksKey(a));
}

console.log(`publicado: ${pub.albums.length} álbuns (v${pubRaw.v || 1})`);
console.log(`novos:     ${fresh.albums.length} no catálogo parcial → ${added.length} entram, ${rejected.length} rejeitados`);
for (const a of added) console.log(`  + ${a.path}  (${a.tracks.length} faixas${a.has_cover === false ? ', sem capa' : ''})`);
for (const [p, why] of rejected) console.log(`  - ${p}  [${why}]`);

if (!added.length) { console.log('nada a acrescentar.'); process.exit(0); }
if (dryRun) { console.log('--dry-run: nada foi escrito.'); process.exit(0); }

if (fresh.meta.base_url && fresh.meta.base_url !== pub.meta.base_url) {
  console.error(`ERRO: base_url difere (${fresh.meta.base_url} ≠ ${pub.meta.base_url})`);
  process.exit(1);
}

// Decoded albums are v1-shaped; strip num where decode left it absent (it already does).
const albums = [...pub.albums, ...added];
const secs = albums.reduce((s, a) => s + a.tracks.reduce((x, t) => x + (t.duration || 0), 0), 0);
const meta = { ...pub.meta, hours: String(Math.round(secs / 3600)) };
const v1 = { meta, albums };

const tmp = mkdtempSync(join(tmpdir(), 'merge-acervo-'));
const v1Path = join(tmp, 'v1.json.gz');
const outTmp = join(tmp, 'out.json.gz');
writeFileSync(v1Path, Bun.gzipSync(Buffer.from(JSON.stringify(v1)), { level: 9 }));
if (pubRaw.v === 2) {
  const r = Bun.spawnSync(['bun', join(ROOT, 'script/convert-acervo-v2.js'), v1Path, outTmp], { stdout: 'inherit', stderr: 'inherit' });
  if (r.exitCode !== 0) { console.error('ERRO: conversão v2 falhou — nada foi escrito.'); process.exit(1); }
} else {
  writeFileSync(outTmp, readFileSync(v1Path));
}

// Verify the file that is about to be published, decoded the way the player decodes it.
const outRaw = readRaw(outTmp);
const out = decode(outRaw);
const fail = msg => { console.error(`ERRO: ${msg} — nada foi escrito.`); rmSync(tmp, { recursive: true }); process.exit(1); };
if ((outRaw.v || 1) !== (pubRaw.v || 1)) fail('formato mudou');
if (out.albums.length !== pub.albums.length + added.length) fail(`contagem ${out.albums.length} ≠ ${pub.albums.length} + ${added.length}`);
if (out.meta.base_url !== pub.meta.base_url) fail('base_url mudou');
if (out.albums.some(a => !a.tracks.length)) fail('álbum com 0 faixas');

const byPath = new Map(out.albums.map(a => [a.path, a]));
for (const a of pub.albums) {
  const b = byPath.get(a.path);
  if (!b || canon(a) !== canon(b)) fail(`álbum antigo alterado: ${a.path}`);
}
const oldSlugs = slugsOf(pub.albums);
const newSlugs = new Map(slugsOf(out.albums).map((s, i) => [out.albums[i].path, s]));
const moved = pub.albums.filter((a, i) => newSlugs.get(a.path) !== oldSlugs[i]);
if (moved.length) fail(`${moved.length} slugs antigos mudariam (ex.: ${moved[0].path})`);

writeFileSync(outPath, readFileSync(outTmp));
rmSync(tmp, { recursive: true });
console.log(`✓ ${outPath}: ${out.albums.length} álbuns, ${meta.hours} h (antes ${pub.meta.hours} h); antigos intactos, slugs preservados`);
