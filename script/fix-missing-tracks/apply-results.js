#!/usr/bin/env bun
// Insert the tracks the beelink worker recovered (results.jsonl, status "ok") into the published
// homi catalog. See tasks/fix-missing-tracks.md.
//
//   bun script/fix-missing-tracks/apply-results.js data/fix-missing-tracks/results.jsonl --dry-run
//   bun script/fix-missing-tracks/apply-results.js data/fix-missing-tracks/results.jsonl
//
// Only tracks whose upload was verified (enviado / ja_existia) go in. Title, artists and number follow
// generate-albums: ID3 title (minus an "Artist - Album - NN " prefix and the album-artist prefix), else
// the file stem without its leading number; artists = ID3 artist else the album artist, split on
// ", " / "; "; number = the file name's leading number, else the ID3 track (some tags are junk). Each new track goes before the first
// existing one with a higher number. Idempotent: a file already in the album is skipped.
// Refuses to write unless every other album, every existing track, the meta, the format and every
// album-page slug stay exactly as they were.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dir, '../..');
const PUB = join(ROOT, '../hominiscanidae/data/homi-albums.json.gz');
const fmt = readFileSync(join(ROOT, 'js/acervo-format.js'), 'utf8');
const { decode, slugsOf } = new Function(fmt + '\nreturn { decode: decodeAcervo, slugsOf: albumSlugs };')();

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const [resultsPath] = args.filter(a => !a.startsWith('--'));
if (!resultsPath) { console.error('uso: apply-results.js <results.jsonl> [--dry-run]'); process.exit(1); }

const NFC = s => s.normalize('NFC');
const readRaw = p => JSON.parse(new TextDecoder().decode(Bun.gunzipSync(readFileSync(p))));
const pubRaw = readRaw(PUB), pub = decode(pubRaw);

const RE_NUM_START = /^(\d{1,3})[.\-_\s]/, RE_NUM_MID = /[-–]\s*(\d{1,3})[.\s]/;
const RE_NUM_STRIP = /^\d{1,3}[.\-_\s]+/, RE_COMP = /^[^-–]+ - [^-–]+ - \d{1,3}[.\-_\s]+(.+)$/;
const cleanText = s => (s || '').replace(/\0/g, '; ').replace(/[\x01-\x08\x0b\x0c\x0e-\x1f]/g, '').trim();
const normArtists = s => s.split('; ').flatMap(p => p.split(', ')).map(p => p.trim()).filter(Boolean).join('; ');
const fileNum = f => { const b = f.split('/').pop(); const m = b.match(RE_NUM_START) || b.match(RE_NUM_MID); return m ? +m[1] : 0; };
const effNum = t => t.num || fileNum(t.file);

function makeTrack(f, album) {
  let title = cleanText(f.id3_title);
  if (!title) {
    const stem = f.file.split('/').pop().replace(/\.[^.]+$/, '');
    const after = stem.replace(RE_NUM_STRIP, '').trim() || stem;
    title = (after.match(RE_COMP)?.[1] ?? after).trim();
  } else title = (title.match(RE_COMP)?.[1] ?? title).trim();
  const pre = album.artist.toLowerCase() + ' - ';
  while (album.artist && title.toLowerCase().startsWith(pre) && title.length > pre.length) title = title.slice(pre.length).trim();
  const artists = normArtists(cleanText(f.id3_artist) || album.artist);
  // the file name's number first: ID3 track tags are sometimes junk ("49" on every track)
  const num = fileNum(f.file) || (f.id3_track > 0 && f.id3_track < 100 ? f.id3_track : 0);
  // ID3 titles that carry the track number ("01 Meu Pé de Lírio", "02 - Precipitações", "11 A História…"),
  // but not titles that start with a number ("3 Palito", "17 Horas", "20 Ligações")
  title = title.replace(/\.(mp3|flac|m4a|ogg|wav)$/i, '').trim();
  const lead = title.match(/^(\d{1,3})(\s*[-.–]\s+|\s+)(?=\S)/);
  if (lead && (lead[1].startsWith('0') || /[-.–]/.test(lead[2]) || (lead[1].length > 1 && +lead[1] === num)))
    title = title.slice(lead[0].length).trim();
  const t = { title, file: NFC(f.file), artists, duration: f.duration || 0 };
  if (num) t.num = num;
  return t;
}

const results = readFileSync(resultsPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const okByPath = new Map();
for (const r of results) if (r.status === 'ok') okByPath.set(NFC(r.path), r); // last line wins

const novos = structuredClone(pub.albums);
const byPath = new Map(novos.map(a => [NFC(a.path), a]));
let nAlb = 0, nTr = 0;
const relatorio = [];
const stream = []; // tracks that only exist here as Bandcamp's 128 kbps preview stream
for (const [p, r] of okByPath) {
  const a = byPath.get(p);
  if (!a) { console.warn(`aviso: fora do catálogo: ${p}`); continue; }
  const have = new Set(a.tracks.map(t => NFC(t.file)));
  const ok = r.faixas.filter(f => ['enviado', 'ja_existia'].includes(f.upload) && !have.has(NFC(f.file)));
  for (const f of ok) if (f.qualidade === 'stream-128')
    stream.push({ album: a.path, file: NFC(f.file), fonte: r.usado || r.download, post: r.post });
  const add = ok.map(f => makeTrack(f, a)).sort((x, y) => (x.num || 999) - (y.num || 999));
  if (!add.length) continue;
  for (const t of add) {
    const n = t.num || 999;
    const i = a.tracks.findIndex(o => (effNum(o) || 999) > n);
    a.tracks.splice(i < 0 ? a.tracks.length : i, 0, t);
  }
  nAlb++; nTr += add.length;
  relatorio.push({ path: a.path, novas: add.map(t => `${t.num ?? '?'} ${t.title}`), arquivos: add.map(t => t.file) });
  if (dryRun || nAlb <= 5) console.log(`${a.path}\n  + ${add.map(t => `${t.num ?? '?'}. ${t.title} [${t.artists}] ${t.duration}s`).join('\n  + ')}`);
}
console.log(`${nTr} faixas em ${nAlb} álbuns`);
if (!nTr) process.exit(0);

const canon = a => JSON.stringify({ title: a.title, artist: a.artist, year: a.year || 0, path: a.path, has_cover: a.has_cover !== false,
  tracks: a.tracks.map(t => ({ title: t.title || '', num: t.num ?? null, file: t.file || '', artists: t.artists || a.artist, duration: t.duration || 0 })) });
const antes = slugsOf(pub.albums), depois = slugsOf(novos);
if (depois.some((s, i) => s !== antes[i])) { console.error('ERRO: slugs mudariam — nada foi escrito.'); process.exit(1); }
if (dryRun) { console.log('--dry-run: nada foi escrito.'); process.exit(0); }

const tmp = mkdtempSync(join(tmpdir(), 'fix-missing-'));
const v1 = join(tmp, 'v1.json.gz'), outTmp = join(tmp, 'out.json.gz');
writeFileSync(v1, Bun.gzipSync(Buffer.from(JSON.stringify({ meta: pub.meta, albums: novos })), { level: 9 }));
if (pubRaw.v === 2) {
  const r = Bun.spawnSync(['bun', join(ROOT, 'script/convert-acervo-v2.js'), v1, outTmp], { stdout: 'ignore', stderr: 'inherit' });
  if (r.exitCode) { console.error('ERRO: conversão v2 falhou'); process.exit(1); }
} else writeFileSync(outTmp, readFileSync(v1));
const outRaw = readRaw(outTmp), out = decode(outRaw);
const fail = m => { console.error(`ERRO: ${m} — nada foi escrito.`); rmSync(tmp, { recursive: true }); process.exit(1); };
if ((outRaw.v || 1) !== (pubRaw.v || 1)) fail('formato mudou');
if (JSON.stringify(out.meta) !== JSON.stringify(pub.meta)) fail('meta mudou');
if (out.albums.length !== pub.albums.length) fail('contagem de álbuns mudou');
const tocados = new Set(relatorio.map(r => NFC(r.path)));
out.albums.forEach((b, i) => {
  const a = pub.albums[i];
  if (b.path !== a.path) fail(`ordem mudou em ${a.path}`);
  if (!tocados.has(NFC(a.path))) { if (canon(a) !== canon(b)) fail(`álbum não tocado mudou: ${a.path}`); return; }
  if (canon(b) !== canon(byPath.get(NFC(a.path)))) fail(`resultado difere do pedido em ${a.path}`);
  // every old track still there, unchanged, in the same relative order
  const old = JSON.parse(canon(a)).tracks.map(t => JSON.stringify(t)), now = JSON.parse(canon(b)).tracks.map(t => JSON.stringify(t));
  let j = 0; for (const t of now) if (t === old[j]) j++;
  if (j !== old.length) fail(`faixa antiga mudou em ${a.path}`);
  const { title, artist, year } = a;
  if (b.title !== title || b.artist !== artist || b.year !== year) fail(`cabeçalho mudou em ${a.path}`);
});
if (slugsOf(out.albums).some((s, i) => s !== antes[i])) fail('slugs mudaram');
writeFileSync(PUB, readFileSync(outTmp));
rmSync(tmp, { recursive: true });
writeFileSync(join(ROOT, 'data/fix-missing-tracks/aplicado.json'), JSON.stringify(relatorio, null, 1));
// committed record of the 128 kbps tracks (stream preview, not the artist's file): tasks/faixas-128kbps.md
if (stream.length) {
  const md = ['# Faixas em 128 kbps (stream do Bandcamp)', '',
    'Faixas recuperadas em 2026-11 (tasks/fix-missing-tracks.md) que só existiam como o stream de prévia do Bandcamp',
    '(MP3 128 kbps): o álbum é pago ou não tem download grátis. Melhor 128 kbps que álbum incompleto (decisão do dono,',
    '2026-11-13). Trocar pelo arquivo original quando aparecer (mesmo nome de arquivo no S3, o catálogo não muda).', '',
    `${stream.length} faixas em ${new Set(stream.map(x => x.album)).size} álbuns.`, ''];
  let cur = null;
  for (const x of stream.sort((p, q) => p.album.localeCompare(q.album) || p.file.localeCompare(q.file))) {
    if (x.album !== cur) { md.push('', `## ${x.album}`, '', `Fonte: ${x.fonte}`, ''); cur = x.album; }
    md.push(`- ${x.file}`);
  }
  const p = join(ROOT, 'tasks/faixas-128kbps.md');
  let prev = ''; try { prev = readFileSync(p, 'utf8'); } catch {}
  // append-only across runs: keep albums already listed, add the new ones
  writeFileSync(p, prev ? prev.trimEnd() + '\n' + md.slice(md.indexOf(`${stream.length} faixas em ${new Set(stream.map(x => x.album)).size} álbuns.`) + 1).join('\n') + '\n' : md.join('\n') + '\n');
  console.log(`${stream.length} faixas em 128 kbps → tasks/faixas-128kbps.md`);
}
console.log(`✓ ${PUB}: +${nTr} faixas em ${nAlb} álbuns; o resto intacto, slugs preservados`);
