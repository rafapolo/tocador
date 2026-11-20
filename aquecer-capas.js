// Fills nginx's image cache with every cover of the published catalogs, so a grid or an album page
// never waits on the Hetzner S3. A random cold read there takes over 4 s about 4% of the time (probe on
// 2026-11-21), and half the proxy's S3 timeouts that day were covers. Runs inside the container,
// against nginx on localhost (not cdn.tocador.cc, whose limits would 429 it), shortly after start and
// then once a day so new albums get in. The cache lives on a haloy volume, so a deploy keeps it: after
// the first full pass a run is ~20k local HITs and touches S3 only for covers that are new or expired.
await import('./js/acervo-format.js');

const NGINX = process.env.AQUECER_NGINX || 'http://127.0.0.1:9001';
const CATALOGOS = (process.env.AQUECER_CATALOGOS || [
  'https://rafapolo.github.io/uqt/data/uqt-albums.json.gz',
  'https://rafapolo.github.io/hominiscanidae/data/homi-albums.json.gz',
].join(',')).split(',').filter(Boolean);
const LIMITE = Number(process.env.AQUECER_LIMITE) || Infinity; // for a local test run
const PARALELO = Number(process.env.AQUECER_PARALELO) || 4;
const ATRASO_MS = Number(process.env.AQUECER_ATRASO_MS ?? 60_000);
const INTERVALO_MS = 24 * 3600_000;
// No 'bot', 'http client' or similar: lib/access.js would answer 403, and that 403 isn't cached anyway.
const UA = 'Mozilla/5.0 (tocador; aquecimento de capas)';

async function urlsDoCatalogo(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const db = globalThis.decodeAcervo(JSON.parse(await globalThis.gunzipText(new Uint8Array(await r.arrayBuffer()))));
  const prefixo = new URL(db.meta.base_url).pathname.replace(/\/+$/, '');
  const urls = [];
  for (const a of db.albums) {
    if (!a.has_cover) continue;
    const base = `${NGINX}${prefixo}/${encodeURIComponent(a.path)}`;
    urls.push(`${base}/capa-min.jpg`, `${base}/capa-micro.jpg`);
  }
  return urls;
}

export async function aquecer() {
  const t0 = Date.now();
  const urls = [];
  for (const c of CATALOGOS) {
    try { urls.push(...await urlsDoCatalogo(c)); }
    catch (err) { console.warn(`[capas] catálogo falhou: ${err.message}`); }
  }
  urls.splice(LIMITE);
  const conta = {};
  let i = 0;
  async function trabalhador() {
    while (i < urls.length) {
      const u = urls[i++];
      let chave;
      try {
        const r = await fetch(u, { headers: { 'User-Agent': UA } });
        await r.arrayBuffer();
        chave = r.status === 200 ? (r.headers.get('x-cache-status') || '200') : String(r.status);
      } catch { chave = 'erro'; }
      conta[chave] = (conta[chave] || 0) + 1;
    }
  }
  await Promise.all(Array.from({ length: PARALELO }, trabalhador));
  const resumo = Object.entries(conta).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`[capas] ${urls.length} capas em ${Math.round((Date.now() - t0) / 1000)} s: ${resumo}`);
  return conta;
}

if (import.meta.main) {
  setTimeout(async function ciclo() {
    try { await aquecer(); } catch (err) { console.warn(`[capas] ${err.message}`); }
    setTimeout(ciclo, INTERVALO_MS);
  }, ATRASO_MS);
}
