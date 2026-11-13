#!/usr/bin/env bun
// build-torrents.js — um .torrent por faixa, para o P2P da G0/G1 (tasks/plans/p2p-gun-tracker.md).
//
// Cada torrent tem uma única faixa, peças de 1 MiB, `url-list` = a URL da faixa no CDN (web seed, BEP 19)
// e nenhum `announce`: o tracker é o GUN. O `url-list` fica fora do `info`, então trocar o CDN não muda
// o infohash. O MP3 é lido direto do bucket (assinado, lib/s3.js), sem passar pelo proxy e seus limites.
//
// Saídas:
//   - torrents/<acervo>/<infohash>.torrent no bucket do acervo (uqt → sambaraiz, homi → indie, o mesmo
//     S3_BUCKET_MAP do proxy, que serve em GET /t/<acervo>/<infohash>.torrent);
//   - data/torrents/<acervo>.jsonl, o progresso (uma linha por faixa feita; rodar de novo retoma);
//   - data/torrents-<acervo>.json.gz, o manifest `atlasKeyHash(chave) → [infohash, bytes]`, o mesmo hash
//     de chave do /atlas, para não depender da ordem do catálogo. Duas chaves com o mesmo hash: a segunda
//     fica fora do manifest (e é contada), como em build-atlas-web.js.
//
// Uso (com o .env carregado: set -a; . ./.env; set +a):
//   bun script/build-torrents.js --acervo uqt --top --dry-run      # as mais tocadas hoje (/metrics)
//   bun script/build-torrents.js --acervo homi --keys lista.txt --limit 20
//   bun script/build-torrents.js --acervo uqt --all --limit 500     # o acervo inteiro, aos poucos
// A rádio sorteia do acervo inteiro (pickRandom() em js/radio.js), então não há "faixas da rádio" à parte:
// começa-se pelo topTracks e se avança com --all --limit.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PECA = 1 << 20;                             // 1 MiB
export const ACERVOS = {
  uqt: { prefixo: 'uqt', bucket: 'sambaraiz' },
  homi: { prefixo: 'indie', bucket: 'indie' },
};

// ── bencode (BEP 3) ─────────────────────────────────────────────────────────────
// Strings contam bytes UTF-8; as chaves de um dict vão em ordem de bytes.
export function bencode(v) {
  const partes = [];
  const enc = (x) => {
    if (typeof x === 'number') {
      if (!Number.isInteger(x)) throw new Error('bencode: só inteiros');
      partes.push(Buffer.from(`i${x}e`));
    } else if (typeof x === 'string' || Buffer.isBuffer(x) || x instanceof Uint8Array) {
      const b = typeof x === 'string' ? Buffer.from(x, 'utf8') : Buffer.from(x);
      partes.push(Buffer.from(`${b.length}:`), b);
    } else if (Array.isArray(x)) {
      partes.push(Buffer.from('l')); x.forEach(enc); partes.push(Buffer.from('e'));
    } else if (x && typeof x === 'object') {
      partes.push(Buffer.from('d'));
      const chaves = Object.keys(x).filter(k => x[k] !== undefined)
        .map(k => [Buffer.from(k, 'utf8'), k]).sort((a, b) => Buffer.compare(a[0], b[0]));
      for (const [kb, k] of chaves) { enc(kb); enc(x[k]); }
      partes.push(Buffer.from('e'));
    } else throw new Error(`bencode: tipo ${typeof x}`);
  };
  enc(v);
  return Buffer.concat(partes);
}

// Um torrent de arquivo único. `nome` vai em NFC: ele entra no infohash.
export function criarTorrent({ nome, bytes, urlList, peca = PECA, criado = 0 }) {
  const buf = Buffer.from(bytes);
  const hashes = [];
  for (let i = 0; i < buf.length; i += peca) hashes.push(createHash('sha1').update(buf.subarray(i, i + peca)).digest());
  const info = { length: buf.length, name: nome.normalize('NFC'), 'piece length': peca, pieces: Buffer.concat(hashes) };
  const infoHash = createHash('sha1').update(bencode(info)).digest('hex');
  const torrent = bencode({ info, 'url-list': urlList ? [urlList] : undefined, 'creation date': criado || undefined, 'created by': 'tocador' });
  return { torrent, infoHash, tamanho: buf.length, pecas: hashes.length };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────
function args(argv) {
  const o = { acervo: null, keys: null, top: false, all: false, limit: Infinity, dryRun: false, upload: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--acervo') o.acervo = argv[++i];
    else if (a === '--keys') o.keys = argv[++i];
    else if (a === '--top') o.top = true;
    else if (a === '--all') o.all = true;
    else if (a === '--limit') o.limit = Number(argv[++i]);
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--no-upload') o.upload = false;
    else throw new Error(`argumento desconhecido: ${a}`);
  }
  if (!ACERVOS[o.acervo]) throw new Error('--acervo uqt|homi');
  if (!o.keys && !o.top && !o.all) throw new Error('escolha --top, --keys <arquivo> ou --all');
  return o;
}

// GET /metrics today.topTracks (caminhos `<prefixo>/<álbum>/<arquivo>`, NFC) → chaves do catálogo.
async function chavesTop(prefixo) {
  const r = await fetch('https://cdn.tocador.cc/metrics', { headers: { Authorization: 'Basic ' + btoa('x:610336c3eeea7dc0347bd58b3a197473') } });
  if (!r.ok) throw new Error(`/metrics ${r.status}`);
  const { today } = await r.json();
  return (today.topTracks ?? []).map(t => t.path).filter(p => p.startsWith(prefixo + '/')).map(p => p.slice(prefixo.length + 1));
}

async function main() {
  const o = args(process.argv.slice(2));
  const { prefixo, bucket } = ACERVOS[o.acervo];
  const { CATALOGS } = await import('./build-features-web.js');
  const decodeAcervo = new Function(readFileSync(join(ROOT, 'js/acervo-format.js'), 'utf8') + '\nreturn decodeAcervo;')();
  const A = new Function(readFileSync(join(ROOT, 'js/atlas-data.js'), 'utf8') + '\nreturn { atlasKeyHash };')();
  const db = decodeAcervo(JSON.parse(gunzipSync(readFileSync(join(ROOT, CATALOGS[o.acervo]))).toString()));
  const base = db.meta.base_url;

  // chave NFC → {path, file}
  const faixas = new Map();
  for (const a of db.albums) for (const t of a.tracks) faixas.set(`${a.path}/${t.file}`.normalize('NFC'), { path: a.path, file: t.file });

  let alvo;
  if (o.all) alvo = [...faixas.keys()];
  else if (o.top) alvo = await chavesTop(prefixo);
  else alvo = readFileSync(o.keys, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  alvo = alvo.map(k => k.normalize('NFC'));
  const fora = alvo.filter(k => !faixas.has(k));
  if (fora.length) console.warn(`${fora.length} chave(s) fora do catálogo, ignoradas: ${fora.slice(0, 3).join(' | ')}`);

  const dir = join(ROOT, 'data/torrents');
  mkdirSync(dir, { recursive: true });
  const progresso = join(dir, `${o.acervo}.jsonl`);
  const feitas = new Map();
  if (existsSync(progresso)) for (const l of readFileSync(progresso, 'utf8').split('\n')) {
    try { const r = JSON.parse(l); feitas.set(r.k, r); } catch { /* linha cortada por um Ctrl-C */ }
  }
  const fila = [...new Set(alvo)].filter(k => faixas.has(k) && !feitas.has(k)).slice(0, o.limit);
  console.log(`${o.acervo}: ${feitas.size} já feitas, ${fila.length} na fila (bucket ${bucket}, peças de ${PECA / 1024} KiB)`);
  if (o.dryRun) { fila.slice(0, 10).forEach(k => console.log('  ' + k)); return; }

  const { s3GetSigned, keyCandidates } = await import('../lib/s3.js');
  const { S3Client } = await import('bun');
  const limpa = (k) => (process.env[k] ?? '').replace(/^"|"$/g, '');
  const s3 = new S3Client({ endpoint: limpa('S3_ENDPOINT'), bucket, accessKeyId: limpa('AWS_ACCESS_KEY_ID'), secretAccessKey: limpa('AWS_SECRET_ACCESS_KEY'), region: 'hel1' });

  let n = 0, erros = 0;
  for (const k of fila) {
    const { path, file } = faixas.get(k);
    try {
      let r;
      for (const chave of keyCandidates(`${prefixo}/${path}/${file}`)) {   // os buckets misturam NFD e NFC
        r = await s3GetSigned(bucket, chave, null);
        if (r.status !== 404) break;
        r.body?.cancel().catch(() => {});
      }
      if (!r.ok) throw new Error(`S3 ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      const url = `${base}/${encodeURIComponent(path)}/${encodeURIComponent(file)}`;
      const t = criarTorrent({ nome: file, bytes, urlList: url, criado: Math.floor(Date.now() / 1000) });
      if (o.upload) await s3.write(`torrents/${o.acervo}/${t.infoHash}.torrent`, t.torrent, { type: 'application/x-bittorrent' });
      appendFileSync(progresso, JSON.stringify({ k, ih: t.infoHash, len: t.tamanho }) + '\n');
      feitas.set(k, { k, ih: t.infoHash, len: t.tamanho });
      if (++n % 25 === 0) console.log(`  ${n}/${fila.length}`);
    } catch (err) {
      erros++;
      console.error(`  erro em ${k}: ${err.message}`);
    }
  }

  // manifest a partir de todo o progresso, não só desta rodada
  const h = [], ih = [], len = [];
  const vistos = new Map();
  let colisoes = 0;
  for (const [k, r] of feitas) {
    if (!faixas.has(k)) continue;                       // faixa que saiu do catálogo
    const hk = A.atlasKeyHash(k);
    if (vistos.has(hk)) { colisoes++; continue; }
    vistos.set(hk, k); h.push(hk); ih.push(r.ih); len.push(r.len);
  }
  const manifest = { v: 1, acervo: o.acervo, peca: PECA, h, ih, len };
  writeFileSync(join(ROOT, `data/torrents-${o.acervo}.json.gz`), gzipSync(JSON.stringify(manifest)));
  console.log(`feitas agora: ${n}, erros: ${erros}, no manifest: ${h.length}, colisões de hash: ${colisoes}`);
}

if (import.meta.main) main().catch(e => { console.error(e.message); process.exit(1); });
