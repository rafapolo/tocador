#!/usr/bin/env node
// Gera assets/3d-og.jpg (1200x630), a imagem Open Graph da página /3d.
//
// Abre a galáxia de capas (por padrão a de produção), esconde os controles,
// sobrepõe o título e fotografa. Usa o Chromium do Playwright (nunca o Chrome
// instalado) com WebGL por SwiftShader.
//
//   node script/build-3d-og.js [url]        # padrão: https://tocador.cc/3d
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { chromium } = require('playwright');

const RAIZ = path.join(__dirname, '..');
const SAIDA = path.join(RAIZ, 'assets', '3d-og.jpg');
const URL = process.argv[2] || 'https://tocador.cc/3d';

function contarAlbuns() {
  let n = 0;
  for (const f of ['../uqt/data/uqt-albums.json.gz', '../hominiscanidae/data/homi-albums.json.gz']) {
    const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(RAIZ, f))));
    n += d.v === 2 ? d.a.t.length : d.albums.length;
  }
  return n;
}

(async () => {
  const n = contarAlbuns();
  const milhar = n % 1000 >= 500 ? `quase ${Math.ceil(n / 1000)}` : `${Math.floor(n / 1000)}`;
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const p = await b.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    await p.goto(URL, { waitUntil: 'networkidle', timeout: 90000 });
    await p.waitForTimeout(15000); // texturas das capas + a entrada da câmera
    await p.addStyleTag({ content: `
      #back-link, #light-toggle, #hint, #loading { display: none !important; }
      #og { position: fixed; inset: 0; pointer-events: none; z-index: 99;
        background: linear-gradient(90deg, rgba(15,14,12,.96) 0%, rgba(15,14,12,.88) 34%, rgba(15,14,12,.35) 62%, rgba(15,14,12,0) 82%); }
      #og h1 { position: absolute; left: 74px; top: 190px; margin: 0;
        font: 400 120px/1 "Playfair Display", Baskerville, Georgia, serif; color: #f5f1ed; letter-spacing: -1px; }
      #og p { position: absolute; left: 78px; top: 336px; margin: 0;
        font: 400 30px/1.3 Baskerville, Georgia, serif; color: #b8b0a8; }
      #og small { position: absolute; left: 78px; bottom: 48px;
        font: 500 17px/1 -apple-system, "Helvetica Neue", sans-serif; color: #d4a574; letter-spacing: .5px; }
    ` });
    await p.evaluate((milhar) => {
      const d = document.createElement('div');
      d.id = 'og';
      d.innerHTML = `<h1>Universo</h1><p>${milhar[0].toUpperCase() + milhar.slice(1)} mil capas de álbuns<br>numa galáxia em 3D</p><small>tocador.cc/3d</small>`;
      document.body.appendChild(d);
    }, milhar);
    await p.waitForTimeout(500);
    await p.screenshot({ path: SAIDA, type: 'jpeg', quality: 86 });
    console.log(`${SAIDA} (${Math.round(fs.statSync(SAIDA).size / 1024)} KB, ${milhar} mil capas)`);
  } finally {
    await b.close();
  }
})();
