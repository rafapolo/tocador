#!/usr/bin/env bun
// Confere os dados derivados commitados aqui (data/*) contra os catálogos publicados e diz o que
// descasou. Não corrige nada: o objetivo é registrar o problema (o workflow data-integrity.yml abre
// ou comenta uma issue com esta saída), para pensar no conserto depois.
//
//   bun script/check-data-integrity.js uqt=<catálogo.json.gz> homi=<catálogo.json.gz> [--md out.md]
//
// Sai com 1 quando algo está fora do esperado. O que é conferido:
//   - <acervo>-features.json.gz: decodeFeatures() aceita o catálogo (contagem + impressão digital).
//     Recusado, o painel Pegada some para todo mundo.
//   - <acervo>-album-genres.json.gz: álbuns do catálogo sem gênero (a aba Gêneros não os encontra).
//   - atlas-faixas.json.gz: faixas do catálogo sem ponto no /atlas, e pontos sem faixa.
//   - atlas-artistas.json.gz: decodifica.
// As faixas sem ponto conhecidas (75 do uqt, ver tasks/uqt-faixas-vazias.md) ficam abaixo da tolerância.
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const carregarScript = f => new Function(readFileSync(join(ROOT, f), 'utf8') + '\n;')();
// Os decoders são scripts clássicos: avaliados aqui, definem globais.
globalThis.atob ??= s => Buffer.from(s, 'base64').toString('binary');
carregarScript('js/acervo-format.js');
carregarScript('js/atlas-data.js');
const featSrc = readFileSync(join(ROOT, 'js/acervo-features.js'), 'utf8');
const { decodeFeatures } = new Function(featSrc + '\nreturn { decodeFeatures };')();

// Tolerâncias: acima disso é regressão (um ETL que não regenerou o dado derivado).
const MAX_FAIXAS_SEM_PONTO = 100;      // por acervo; uqt tem 75 sem áudio na origem
const MAX_ALBUNS_SEM_GENERO = 0.02;    // fração do catálogo

const args = process.argv.slice(2);
let mdOut = null;
const catalogos = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--md') { mdOut = args[++i]; continue; }
  const [k, v] = args[i].split('=');
  if (k && v) catalogos[k] = v;
}
if (!Object.keys(catalogos).length) {
  console.error('uso: bun script/check-data-integrity.js uqt=<cat.json.gz> homi=<cat.json.gz> [--md out.md]');
  process.exit(2);
}

const lerGz = p => JSON.parse(gunzipSync(readFileSync(p)).toString('utf8'));
const problemas = [];
const linhas = [];
const ok = msg => linhas.push(`- ✅ ${msg}`);
const ruim = msg => { linhas.push(`- ❌ ${msg}`); problemas.push(msg); };

const dbs = {};
for (const [ak, p] of Object.entries(catalogos)) {
  try { dbs[ak] = decodeAcervo(lerGz(p)); }
  catch (e) { ruim(`**${ak}**: catálogo não decodifica (${e.code || e.message})`); }
}

let atlas = null;
try { atlas = decodeAtlas(lerGz(join(ROOT, 'data/atlas-faixas.json.gz'))); }
catch (e) { ruim(`atlas-faixas.json.gz não decodifica (${e.code || e.message})`); }
try { decodeArtistas(lerGz(join(ROOT, 'data/atlas-artistas.json.gz'))); ok('atlas-artistas.json.gz decodifica'); }
catch (e) { ruim(`atlas-artistas.json.gz não decodifica (${e.code || e.message})`); }

for (const [ak, db] of Object.entries(dbs)) {
  const chaves = [];
  for (const a of db.albums) for (const t of a.tracks) chaves.push(`${a.path}/${t.file}`.normalize('NFC'));

  // features
  try {
    const f = decodeFeatures(lerGz(join(ROOT, `data/${ak}-features.json.gz`)), chaves);
    ok(`**${ak}** features: ${f.n} faixas batem com o catálogo`);
  } catch (e) {
    const p = (() => { try { return lerGz(join(ROOT, `data/${ak}-features.json.gz`)); } catch { return null; } })();
    const det = p?.cat ? ` (features: ${p.cat.n} faixas; catálogo: ${chaves.length})` : '';
    ruim(`**${ak}** features recusadas: ${e.message}${det} — o painel Pegada fica indisponível. Rode \`build-features-web.js --acervo ${ak}\``);
  }

  // gêneros
  try {
    const g = lerGz(join(ROOT, `data/${ak}-album-genres.json.gz`)).a;
    const sem = db.albums.filter(a => !g[a.path.normalize('NFC')]?.length).map(a => a.path);
    const frac = sem.length / db.albums.length;
    const msg = `**${ak}** gêneros: ${sem.length} de ${db.albums.length} álbuns sem gênero (${(frac * 100).toFixed(1)}%)`;
    if (frac > MAX_ALBUNS_SEM_GENERO) ruim(`${msg}; ex.: ${sem.slice(-3).map(s => `\`${s}\``).join(', ')}`);
    else ok(msg);
  } catch (e) { ruim(`**${ak}** ${ak}-album-genres.json.gz ilegível (${e.message})`); }

  // atlas
  if (atlas) {
    const ai = atlas.acervos.indexOf(ak);
    if (ai < 0) { ruim(`**${ak}** ausente do atlas-faixas.json.gz`); continue; }
    const hashes = new Set();
    for (let i = 0; i < atlas.n; i++) if (atlas.acervo[i] === ai) hashes.add(atlas.hash[i]);
    const doCat = new Set();
    const semPonto = [];
    for (const k of chaves) { const h = atlasKeyHash(k); doCat.add(h); if (!hashes.has(h)) semPonto.push(k); }
    let orfaos = 0;
    for (const h of hashes) if (!doCat.has(h)) orfaos++;
    const msg = `**${ak}** atlas: ${semPonto.length} faixas sem ponto, ${orfaos} pontos sem faixa no catálogo`;
    if (semPonto.length > MAX_FAIXAS_SEM_PONTO || orfaos > MAX_FAIXAS_SEM_PONTO) {
      ruim(`${msg}; ex.: ${semPonto.slice(-3).map(s => `\`${s}\``).join(', ')}. Regenere o mapa (ver CLAUDE.md, *Adding albums*)`);
    } else ok(msg);
  }
}

const md = [
  problemas.length ? `${problemas.length} problema(s) nos dados derivados.` : 'Tudo em ordem.',
  '',
  ...linhas,
].join('\n');
console.log(md);
if (mdOut) writeFileSync(mdOut, md + '\n');
process.exit(problemas.length ? 1 : 0);
