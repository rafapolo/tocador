#!/usr/bin/env node
// Mede o custo de desenhar a banda do /atlas (js/atlas-sim.js): abre /atlas com os dados de teste, põe 8 músicos de
// cenários diferentes no palco, amplia o cartão e chama __atlasSim.medir(), que desenha quadros esperando a GPU.
//   npx serve . -p 3460 &   node script/bench-atlas-sim.js [--port 3460] [--gpu|--swiftshader] [--dpr 2] [--rodadas 5] [--foto a.png [--focar 0]]
// mediana_ms é o tempo de parede por quadro (na prática o custo de CPU do three.js); gpu_mediana_ms, o relógio da
// GPU (EXT_disjoint_timer_query_webgl2), o que mede o custo dos shaders e das sombras.
// --gpu usa o Chromium do Playwright com a GPU de verdade (Metal no Mac); --swiftshader, a GPU em software, um
// "aparelho fraco" que exagera o custo por pixel. Nunca abre o Chrome instalado.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const PORT = +arg('--port', 3460), DPR = +arg('--dpr', 2), RODADAS = +arg('--rodadas', 5);
const SW = process.argv.includes('--swiftshader'), FOTO = arg('--foto', null), FOCO = arg('--focar', null);
const raiz = path.join(__dirname, '..');
const fx = n => fs.readFileSync(path.join(raiz, 'tests', 'fixtures', n));
const gz = body => ({ status: 200, headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' }, body });

const VOZES = [
  { papel: 'mel', familia: 'samba', timbre: 'cavaco' }, { papel: 'pandeiro', familia: 'samba' },
  { papel: 'mel', familia: 'rock', timbre: 'dist' }, { papel: 'caixa', familia: 'rock' },
  { papel: 'baixo', familia: 'bossa', timbre: 'violao7' }, { papel: 'acorde', familia: 'house', timbre: 'pad' },
  { papel: 'mel', familia: 'forro', timbre: 'sanfona' }, { papel: 'baixo', familia: 'jazz', timbre: 'baixo' },
];

(async () => {
  const args = SW ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'];
  const b = await chromium.launch({ headless: true, args });
  try {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: DPR, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.error('[console]', m.text()); });
    page.on('pageerror', e => console.error('[erro]', e.message));
    await page.route('**/data/atlas-faixas.json.gz', r => r.fulfill(gz(fx('atlas-faixas-teste.json.gz'))));
    await page.route('**/data/atlas-artistas.json.gz', r => r.fulfill({ status: 404 }));
    await page.route('**/data/*-features.json.gz', r => r.fulfill({ status: 404 }));
    await page.route('**/uqt/data/uqt-albums.json.gz', r => r.fulfill(gz(fx('atlas-uqt.json.gz'))));
    await page.route('**/hominiscanidae/data/homi-albums.json.gz', r => r.fulfill(gz(fx('atlas-homi.json.gz'))));
    await page.route(u => !/^http:\/\/localhost/.test(u.href) && !/cdn\.jsdelivr\.net\/npm\/three@/.test(u.href), r => r.fulfill({ status: 404 }));
    await page.route('https://cdn.jsdelivr.net/npm/three@*/build/*.js', r => {
      const n = r.request().url().split('/').pop();
      r.fulfill({ status: 200, headers: { 'Content-Type': 'text/javascript' }, body: fs.readFileSync(path.join(raiz, 'node_modules', 'three', 'build', n)) });
    });
    await page.goto(`http://localhost:${PORT}/atlas`);
    await page.evaluate(() => window.__atlas.pronto);
    await page.evaluate(() => { window.__atlas.ouvirBanda = () => true; });
    await page.locator('#btn-sim').click();
    await page.waitForFunction(() => window.__atlasSim.estado());
    await page.evaluate(() => document.getElementById('sim-ampliar')?.click());
    // as notas mantêm os músicos no palco (calados por 5 s, eles saem)
    await page.evaluate(vozes => { window.__benchNotas = setInterval(() => vozes.forEach(v => window.__atlasSim.nota({ ...v, vel: 0.6, t: window.__atlas.ouvidoSom() })), 400); }, VOZES);
    await page.waitForTimeout(6000);
    const est = await page.evaluate(() => window.__atlasSim.estado());
    if (FOTO) {          // --foto arq.png [--focar <índice do músico>]: um quadro do palco, de perto se pedido
      if (FOCO != null) { await page.evaluate(i => window.__atlasSim.focar(window.__atlasSim.estado().musicos[i].chave), +FOCO); await page.waitForTimeout(2500); }
      await page.locator('#sim-canvas').screenshot({ path: FOTO });
    }
    const res = [];
    for (let i = 0; i < RODADAS; i++) { res.push(await page.evaluate(n => window.__atlasSim.medir(n), SW ? 15 : 120)); await page.waitForTimeout(500); }
    const ms = res.map(r => r.ms).sort((a, z) => a - z), gpu = res.map(r => r.gpuMs).filter(v => v != null).sort((a, z) => a - z);
    console.log(JSON.stringify({ modo: SW ? 'swiftshader' : 'gpu', gpu: res[0].gpu, tela: `${res[0].largura}×${res[0].altura}`, musicos: est.musicos.length,
      cenarios: est.cenarios, nivel: est.nivel, abertura_ms: est.medidaAbertura, mediana_ms: ms[ms.length >> 1], gpu_mediana_ms: gpu.length ? gpu[gpu.length >> 1] : null, gpu_min_ms: gpu[0] ?? null, gpu_max_ms: gpu[gpu.length - 1] ?? null, min_ms: ms[0], max_ms: ms[ms.length - 1], chamadas: res[0].chamadas, triangulos: res[0].triangulos, texturas: res[0].texturas }, null, 1));
  } finally { await b.close(); }
})();
