#!/usr/bin/env bun
/**
 * Makes capa-micro.jpg, the 96 px cover the player's browse list shows, from each album's capa-min.jpg in the bucket.
 * The source is the bucket, not the disk: homi's archive exists only there. Run after resize-cover-images.js on every
 * ETL; only what is missing gets made.
 *
 *   bun script/build-micro-covers.js --acervo homi --dry-run   # always first: says how much is really missing
 *   bun script/build-micro-covers.js --acervo homi [--limit N]
 *
 * A listing, not HeadObject per album, gives the true scope in about one request per thousand keys. The new key keeps
 * the capa-min key's own byte form: buckets are mixed NFC/NFD, and a folder must not come to exist in both. Nothing
 * here overwrites: an album whose micro exists in either form is left alone.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const sharp = require('sharp');
const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
require('../js/acervo-format.js');

const LARGURA = 96, QUALIDADE = 72, CONCORRENCIA = 12;
const FONTE = '/capa-min.jpg', ALVO = '/capa-micro.jpg';
const ACERVOS = {     // buckets as in S3_BUCKET_MAP in haloy.yaml
  uqt: { dataFile: '../../uqt/data/uqt-albums.json.gz', prefix: 'uqt/', bucket: 'sambaraiz' },
  homi: { dataFile: '../../hominiscanidae/data/homi-albums.json.gz', prefix: 'indie/', bucket: 'indie' },
};

for (const line of fs.readFileSync(path.resolve(__dirname, '../.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*(\w+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m) process.env[m[1]] = m[2];
}

const arg = n => { const i = process.argv.indexOf(n); return i < 0 ? null : process.argv[i + 1]; };
const config = ACERVOS[arg('--acervo')];
if (!config) { console.error(`--acervo ${Object.keys(ACERVOS).join('|')}`); process.exit(1); }
const dryRun = process.argv.includes('--dry-run'), limite = Number(arg('--limit')) || Infinity;

const s3 = new S3Client({
  endpoint: 'https://hel1.your-objectstorage.com', region: 'hel1', forcePathStyle: true,
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY },
});

async function listar() {
  const fontes = new Map(), prontas = new Set();     // NFC album path -> capa-min key as stored; NFC paths done
  let ContinuationToken, n = 0;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: config.prefix, ContinuationToken }));
    for (const { Key } of r.Contents || []) {
      n++;
      const pasta = Key.slice(config.prefix.length, Key.lastIndexOf('/')).normalize('NFC');
      if (Key.endsWith(FONTE)) fontes.set(pasta, Key);
      else if (Key.endsWith(ALVO)) prontas.add(pasta);
    }
    ContinuationToken = r.NextContinuationToken;
    if (n % 20000 < 1000) process.stdout.write(`\r  ${n} chaves listadas`);
  } while (ContinuationToken);
  console.log(`\r  ${n} chaves listadas`);
  return { fontes, prontas };
}

async function fazer(chaveFonte) {
  const r = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: chaveFonte }));
  const origem = Buffer.from(await r.Body.transformToByteArray());
  const Body = await sharp(origem, { failOn: 'none' }).resize(LARGURA, null, { withoutEnlargement: true, fit: 'inside' })
    .jpeg({ quality: QUALIDADE, mozjpeg: true }).toBuffer();
  await s3.send(new PutObjectCommand({
    Bucket: config.bucket, Key: chaveFonte.slice(0, -FONTE.length) + ALVO, Body, ContentType: 'image/jpeg',
  }));
  return [origem.length, Body.length];
}

(async () => {
  const albuns = decodeAcervo(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.resolve(__dirname, config.dataFile))))).albums;
  const comCapa = albuns.filter(a => a.has_cover !== false).map(a => a.path.normalize('NFC'));
  console.log(`${arg('--acervo')}: ${albuns.length} álbuns, ${comCapa.length} com capa, bucket ${config.bucket}${dryRun ? ' (dry-run)' : ''}`);
  const { fontes, prontas } = await listar();
  const semFonte = comCapa.filter(p => !fontes.has(p));
  const faltam = [...new Set(comCapa)].filter(p => fontes.has(p) && !prontas.has(p));
  console.log(`  já têm micro: ${comCapa.length - faltam.length - semFonte.length}\n  sem capa-min no bucket: ${semFonte.length}\n  a gerar: ${faltam.length}`);
  semFonte.slice(0, 5).forEach(p => console.log(`    sem capa-min: ${p}`));
  if (dryRun) return;
  const fila = faltam.slice(0, limite);
  let feitos = 0, erros = 0, antes = 0, depois = 0, i = 0;
  await Promise.all(Array.from({ length: CONCORRENCIA }, async () => {
    while (i < fila.length) {
      const p = fila[i++];
      try {
        const [a, d] = await fazer(fontes.get(p));
        feitos++; antes += a; depois += d;
      } catch (err) { erros++; console.error(`\n  erro: ${p}: ${err.message}`); }
      if ((feitos + erros) % 200 === 0) process.stdout.write(`\r  ${feitos + erros}/${fila.length}`);
    }
  }));
  console.log(`\r  feitos ${feitos}, erros ${erros}; ${(antes / 1048576).toFixed(1)} MB → ${(depois / 1048576).toFixed(1)} MB, ${feitos ? (depois / feitos / 1024).toFixed(1) : 0} KB por capa`);
  if (erros) process.exit(1);
})().catch(err => { console.error(err); process.exit(1); });
