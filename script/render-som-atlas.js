#!/usr/bin/env node
// render-som-atlas.js — renders every family of the /atlas music to WAV, for script/avaliar-som-atlas.py to score.
// Uses the real engine (js/atlas-som.js) on an OfflineAudioContext inside Playwright's bundled Chromium.
//
//   node script/render-som-atlas.js <dir> [--seg 30] [--zoom 20] [--tomadas 2] [--so samba,punk]
//   node script/render-som-atlas.js <dir> --trabalhos jobs.json   # [{ arq, nome, tomada, a }], `a` being trial adjustments
//
// Writes <dir>/<family>-<take>.wav and <dir>/rotulos.json (family -> the discogs400 labels it plays).
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const dir = args[0];
const opt = (nome, padrao) => { const i = args.indexOf(`--${nome}`); return i < 0 ? padrao : args[i + 1]; };
if (!dir || dir.startsWith('--')) { console.error('uso: node script/render-som-atlas.js <dir> [--seg 30] [--zoom 20] [--tomadas 2] [--so a,b]'); process.exit(1); }
const seg = Number(opt('seg', 30)), zoom = Number(opt('zoom', 20)), tomadas = Number(opt('tomadas', 2));
const so = opt('so', '').split(',').filter(Boolean);
const SR = 44100;

function wav(l, r) {
  const n = l.length / 2, b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) { b.writeInt16LE(l.readInt16LE(i * 2), 44 + i * 4); b.writeInt16LE(r.readInt16LE(i * 2), 46 + i * 4); }
  return b;
}

const RENDER = async ({ nome, seg, zoom, tomada, SR, a }) => {
  const R = RECEITAS_ATLAS.receita(nome), copia = { ...R };
  RECEITAS_ATLAS.ajustar(R, a);
  const ac = new OfflineAudioContext(2, seg * SR, SR), m = criarMotorSom(ac);
  m.saida.gain.value = 1;
  m.definir({ fatias: [{ nome, peso: 1 }], camadas: camadasSom(zoom), cam: filtroSom(zoom), sala: 0.3, semente: 11 + tomada * 7919 }, true);
  m.avancar(seg - 0.5);
  const buf = await ac.startRendering();
  for (const k of Object.keys(R)) delete R[k];
  Object.assign(R, copia);
  let pk = 0;
  const canal = c => {
    const d = buf.getChannelData(c), o = new Int16Array(d.length);
    for (let i = 0; i < d.length; i++) { pk = Math.max(pk, Math.abs(d[i])); o[i] = Math.max(-1, Math.min(1, d[i])) * 32767; }
    let s = '';
    const u = new Uint8Array(o.buffer);
    for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768));
    return btoa(s);
  };
  return [canal(0), canal(1), pk];
};

(async () => {
  fs.mkdirSync(dir, { recursive: true });
  const classes = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.essentia/models/genre_discogs400-discogs-effnet-1.json'), 'utf8')).classes;
  const b = await chromium.launch();
  try {
    const page = await b.newPage();
    page.on('pageerror', e => console.error('página:', e.message));
    await page.setContent('<!doctype html><title>render</title>');
    for (const f of ['atlas-receitas.js', 'atlas-som.js']) await page.addScriptTag({ path: path.join(ROOT, 'js', f) });

    const { familias, rotulos } = await page.evaluate(classes => {
      const rotulos = {};
      for (const c of classes) (rotulos[RECEITAS_ATLAS.familiaDe(c)] ||= []).push(c);
      return { familias: RECEITAS_ATLAS.familias, rotulos };
    }, classes);
    fs.writeFileSync(path.join(dir, 'rotulos.json'), JSON.stringify(rotulos));

    const render = async (nome, tomada, a, arq) => {
      const [l, r, pk] = await page.evaluate(RENDER, { nome, seg, zoom, tomada, SR, a });
      const L = Buffer.from(l, 'base64'), R = Buffer.from(r, 'base64');
      fs.writeFileSync(arq, wav(L, R));
      return pk;
    };
    const jobs = opt('trabalhos', '');
    if (jobs) {
      for (const j of JSON.parse(fs.readFileSync(jobs, 'utf8'))) await render(j.nome, j.tomada, j.a, path.join(dir, j.arq));
      return;
    }
    for (const nome of familias) {
      if (so.length && !so.includes(nome)) continue;
      for (let tomada = 0; tomada < tomadas; tomada++) {
        const pk = await render(nome, tomada, null, path.join(dir, `${nome}-${tomada}.wav`));
        console.log(`${nome}-${tomada}  pico ${pk.toFixed(3)}`);
      }
    }
  } finally {
    await b.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
