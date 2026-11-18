#!/usr/bin/env bun
// Remove single tracks from a published acervo, by "<album path>/<file>", without the music volume.
//
//   bun script/remove-tracks.js ../uqt/data/uqt-albums.json.gz keys.json --dry-run
//   bun script/remove-tracks.js ../uqt/data/uqt-albums.json.gz keys.json
//
// keys.json is a JSON array of "<album path>/<file>" strings (NFC or NFD). The audio stays in S3.
// An album left with no track is refused (use remove-albums.js). The output keeps the published format
// (v2 via convert-acervo-v2.js) and is refused unless every other track and album decodes back unchanged and every
// album keeps its album-page slug. After it: build-features-web, build-atlas-web (see CLAUDE.md).

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dir, '..');
const fmt = readFileSync(join(ROOT, 'js/acervo-format.js'), 'utf8');
const { decode, slugsOf } = new Function(fmt + '\nreturn { decode: decodeAcervo, slugsOf: albumSlugs };')();

const nfc = s => s.normalize('NFC');
const canon = a => JSON.stringify({
  title: a.title, artist: a.artist, year: a.year || 0, path: a.path, has_cover: a.has_cover !== false,
  tracks: a.tracks.map(t => ({ title: t.title || '', num: t.num ?? null, file: t.file || '',
    artists: t.artists || a.artist, duration: t.duration || 0 })),
});

// Pure part: returns { albums, removed, missing }; albums keeps every album (and its order), minus the tracks.
export function removeTracks(albums, keys) {
  const alvo = new Set(keys.map(nfc));
  const removed = [];
  const out = albums.map(a => {
    const tracks = a.tracks.filter(t => {
      const k = nfc(`${a.path}/${t.file}`);
      if (!alvo.has(k)) return true;
      removed.push(k);
      return false;
    });
    if (!tracks.length && a.tracks.length) throw new Error(`o álbum ficaria sem faixas: ${a.path} (use remove-albums.js)`);
    return tracks.length === a.tracks.length ? a : { ...a, tracks };
  });
  const achadas = new Set(removed);
  return { albums: out, removed, missing: [...alvo].filter(k => !achadas.has(k)) };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const [pubPath, keysPath, outPath = pubPath] = args.filter(a => a !== '--dry-run');
  if (!pubPath || !keysPath) {
    console.error('uso: bun script/remove-tracks.js <publicado.json.gz> <keys.json> [saida.json.gz] [--dry-run]');
    process.exit(1);
  }
  const readRaw = p => JSON.parse(new TextDecoder().decode(Bun.gunzipSync(readFileSync(p))));
  const pubRaw = readRaw(pubPath);
  const pub = decode(pubRaw);
  const keys = JSON.parse(readFileSync(keysPath, 'utf8'));
  const nTracks = db => db.reduce((n, a) => n + a.tracks.length, 0);

  let res;
  try { res = removeTracks(pub.albums, keys); } catch (e) { console.error(`ERRO: ${e.message}`); process.exit(1); }
  const { albums: kept, removed, missing } = res;
  console.log(`publicado: ${pub.albums.length} álbuns, ${nTracks(pub.albums)} faixas (v${pubRaw.v || 1})`);
  for (const k of removed) console.log(`  - ${k}`);
  for (const k of missing) console.log(`  ? ${k} não está no catálogo`);
  if (missing.length) { console.error('ERRO: chaves ausentes — nada foi escrito.'); process.exit(1); }
  if (!removed.length) { console.log('nada a remover.'); process.exit(0); }

  const antes = slugsOf(pub.albums), depois = slugsOf(kept);
  if (depois.some((s, i) => s !== antes[i])) { console.error('ERRO: slugs mudariam — nada foi escrito.'); process.exit(1); }
  if (dryRun) { console.log(`--dry-run: ${removed.length} faixas; slugs preservados; nada foi escrito.`); process.exit(0); }

  const secs = kept.reduce((s, a) => s + a.tracks.reduce((x, t) => x + (t.duration || 0), 0), 0);
  const meta = { ...pub.meta, hours: String(Math.round(secs / 3600)) };
  const tmp = mkdtempSync(join(tmpdir(), 'remove-tracks-'));
  const v1Path = join(tmp, 'v1.json.gz'), outTmp = join(tmp, 'out.json.gz');
  writeFileSync(v1Path, Bun.gzipSync(Buffer.from(JSON.stringify({ meta, albums: kept })), { level: 9 }));
  if (pubRaw.v === 2) {
    const r = Bun.spawnSync(['bun', join(ROOT, 'script/convert-acervo-v2.js'), v1Path, outTmp], { stdout: 'inherit', stderr: 'inherit' });
    if (r.exitCode !== 0) { console.error('ERRO: conversão v2 falhou — nada foi escrito.'); process.exit(1); }
  } else writeFileSync(outTmp, readFileSync(v1Path));

  const outRaw = readRaw(outTmp), out = decode(outRaw);
  const fail = msg => { console.error(`ERRO: ${msg} — nada foi escrito.`); rmSync(tmp, { recursive: true }); process.exit(1); };
  if ((outRaw.v || 1) !== (pubRaw.v || 1)) fail('formato mudou');
  if (out.albums.length !== kept.length) fail('contagem de álbuns mudou');
  if (out.meta.base_url !== pub.meta.base_url) fail('base_url mudou');
  out.albums.forEach((b, i) => { if (canon(b) !== canon(kept[i])) fail(`álbum alterado: ${kept[i].path}`); });
  if (nTracks(out.albums) !== nTracks(pub.albums) - removed.length) fail('contagem de faixas errada');

  writeFileSync(outPath, readFileSync(outTmp));
  rmSync(tmp, { recursive: true });
  console.log(`✓ ${outPath}: ${out.albums.length} álbuns, ${nTracks(out.albums)} faixas, ${meta.hours} h (antes ${pub.meta.hours} h); o resto intacto, slugs preservados`);
}
