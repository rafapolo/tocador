#!/usr/bin/env bun
// amostrar-som-real.js — downloads a 30 s slice of the real tracks chosen by script/perfil-som-real.py (`--escolher`),
// for the spectrum and microtiming profiles of each /atlas music family. Read-only: authenticated Range GETs on the
// buckets (going through cdn.tocador.cc would trip the proxy's rate limit).
//
//   bun script/amostrar-som-real.js <dir>      # reads <dir>/escolhas.json, writes <dir>/<family>-<n>.mp3
import { S3Client } from 'bun';
import path from 'path';
import fs from 'fs';

const dir = process.argv[2];
const escolhas = JSON.parse(fs.readFileSync(path.join(dir, 'escolhas.json'), 'utf8'));
const conf = { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, endpoint: process.env.S3_ENDPOINT?.replace(/"/g, '') };
const clientes = { uqt: [new S3Client({ ...conf, bucket: 'sambaraiz' }), 'uqt/'], homi: [new S3Client({ ...conf, bucket: 'indie' }), 'indie/'] };

let ok = 0, falhas = 0, i = 0;
async function baixar(e) {
  const alvo = path.join(dir, e.nome);
  if (fs.existsSync(alvo)) { ok++; return; }
  const [c, pre] = clientes[e.acervo];
  for (const forma of [e.chave, e.chave.normalize('NFD'), e.chave.normalize('NFC')]) {
    try {
      const b = await c.file(pre + forma).slice(e.ini, e.ini + e.bytes).arrayBuffer();
      if (b.byteLength > 50000) { fs.writeFileSync(alvo, Buffer.from(b)); ok++; return; }
    } catch { /* the key is in the other Unicode form, or gone */ }
  }
  falhas++;
}
await Promise.all(Array.from({ length: 12 }, async () => { while (i < escolhas.length) await baixar(escolhas[i++]); }));
console.log(`${ok} trechos, ${falhas} falhas`);
