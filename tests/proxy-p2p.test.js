// P2P routes of the proxy (tasks/plans/p2p-gun-tracker.md, G0 §0.5), against the real proxy and
// the fake S3 in tests/fixtures/proxy-harness.js: the .torrent route, the play beacon, and what
// a web seed fetching 1 MiB piece-aligned Ranges gets from today's per-device limits.
const { test, expect, describe, beforeAll, afterAll } = require('bun:test');
const { proxyHarness } = require('./fixtures/proxy-harness.js');

const IH = 'ab'.repeat(20);
const TORRENT = Buffer.from('d4:infod6:lengthi1eee');
const MIB = 1 << 20;
const TRACK = 'indie/2020 - Banda - Disco/01 Faixa.mp3';
const TRACK_SIZE = 7 * MIB + 12345;                     // a ~7 MB track: 8 pieces
const h = proxyHarness();
beforeAll(async () => {
  await h.start();
  h.reset([[`torrents/homi/${IH}.torrent`, TORRENT], [TRACK, Buffer.alloc(TRACK_SIZE, 7)]]);
});
afterAll(() => h.stop());

let seq = 0;
const base = () => `http://127.0.0.1:${h.port}`;
const hdr = (extra = {}) => ({ 'User-Agent': `Mozilla/5.0 Chrome/140 p${seq++}`, Referer: 'https://tocador.cc/radio.html', ...extra });

describe('GET /t/<acervo>/<infohash>.torrent', () => {
  test('serves the torrent from the acervo bucket, cached for good', async () => {
    const r = await fetch(`${base()}/t/homi/${IH}.torrent`, { headers: hdr() });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/x-bittorrent');
    expect(r.headers.get('cache-control')).toContain('immutable');
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(Buffer.from(await r.arrayBuffer())).toEqual(TORRENT);
  });
  test('404 for a torrent that does not exist', async () => {
    const r = await fetch(`${base()}/t/uqt/${'cd'.repeat(20)}.torrent`, { headers: hdr() });
    expect(r.status).toBe(404);
  });
  test('rejects unknown acervos, bad hashes and other paths under /t/ without asking S3', async () => {
    h.requested = [];
    for (const p of ['/t/outro/' + IH + '.torrent', '/t/homi/' + IH.toUpperCase() + '.torrent', '/t/homi/abc.torrent', '/t/homi/../x']) {
      expect((await fetch(base() + p, { headers: hdr() })).status).toBe(404);
    }
    expect(h.requested).toHaveLength(0);
  });
  test('same hotlink rule as audio', async () => {
    const r = await fetch(`${base()}/t/homi/${IH}.torrent`, { headers: hdr({ Referer: 'https://example.com/' }) });
    expect(r.status).toBe(403);
  });
});

describe('POST /play-beacon', () => {
  const post = (body, extra) => fetch(`${base()}/play-beacon`, { method: 'POST', headers: hdr(extra), body: JSON.stringify(body) });
  const auth = { Authorization: 'Basic ' + btoa('x:610336c3eeea7dc0347bd58b3a197473') };
  const today = async () => (await (await fetch(`${base()}/metrics`, { headers: auth })).json()).today;

  test('a p2p play counts in plays/topTracks under the audio path; a cdn play only adds bytes', async () => {
    const antes = await today();
    expect((await post({ acervo: 'homi', path: '2020 - Banda - Disco/02 Outra.mp3', fonte: 'p2p', bytesPeers: 3_000_000, bytesSeed: 1_000_000 })).status).toBe(204);
    expect((await post({ acervo: 'homi', path: '2020 - Banda - Disco/03 Mais.mp3', fonte: 'cdn', bytesPeers: 0, bytesSeed: 2_000_000 })).status).toBe(204);
    const t = await today();
    expect(t.plays).toBe(antes.plays + 1);
    expect(t.topTracks.map(x => x.path)).toContain('indie/2020 - Banda - Disco/02 Outra.mp3');
    expect(t.p2p.beacons).toBe(antes.p2p.beacons + 2);
    expect(t.p2p.peers_MB).toBeCloseTo(antes.p2p.peers_MB + 3, 1);
    expect(t.p2p.seed_MB).toBeCloseTo(antes.p2p.seed_MB + 3, 1);
  });
  test("the CDN monitor's curl probes are not plays", async () => {
    const antes = (await today()).plays;
    const r = await fetch(h.url(TRACK), { headers: { 'User-Agent': 'curl/8.5.0', Referer: 'https://tocador.cc/', Range: 'bytes=0-1000' } });
    expect(r.status).toBe(206); await r.arrayBuffer();
    const b = await fetch(h.url(TRACK), { headers: { ...hdr(), Range: 'bytes=0-1000' } });
    expect(b.status).toBe(206); await b.arrayBuffer();
    expect((await today()).plays).toBe(antes + 1);
  });
  test('rejects malformed beacons', async () => {
    const bad = [
      { acervo: 'outro', path: 'a/b.mp3', fonte: 'p2p' },
      { acervo: 'homi', path: '../x.mp3', fonte: 'p2p' },
      { acervo: 'homi', path: 'a/capa.jpg', fonte: 'p2p' },
      { acervo: 'homi', path: 'a/b.mp3', fonte: 'torrent' },
      { acervo: 'homi', path: 'a/b.mp3', fonte: 'p2p', bytesPeers: -1 },
      { acervo: 'homi', path: 'a/b.mp3', fonte: 'p2p', bytesSeed: 1.5 },
    ];
    for (const b of bad) expect((await post(b)).status).toBe(400);
    expect((await fetch(`${base()}/play-beacon`, { method: 'POST', headers: hdr(), body: '{' })).status).toBe(400);
  });
  test('needs one of our pages as Referer', async () => {
    expect((await post({ acervo: 'homi', path: 'a/b.mp3', fonte: 'p2p' }, { Referer: 'https://example.com/' })).status).toBe(403);
  });
});

// A web seed (BEP 19) asks for each 1 MiB piece as its own Range. These pin what today's
// limits give one device; the real WebTorrent pattern is measured in G1.
describe('web seed: 1 MiB piece Ranges from one device', () => {
  const piece = (ua, i) => fetch(h.url(TRACK), { headers: { 'User-Agent': ua, Referer: 'https://tocador.cc/radio.html',
    Range: `bytes=${i * MIB}-${Math.min((i + 1) * MIB, TRACK_SIZE) - 1}` } });

  test('the whole ~7 MB track, piece by piece, fits the per-device bucket', async () => {
    const ua = `Mozilla/5.0 Chrome/140 seed${seq++}`;
    let total = 0;
    for (let i = 0; i < 8; i++) {
      const r = await piece(ua, i);
      expect(r.status).toBe(206);
      total += (await r.arrayBuffer()).byteLength;
    }
    expect(total).toBe(TRACK_SIZE);
  });

  // A slot frees once its body is handed to the socket, so how many of 8 parallel pieces get
  // through depends on timing; at least the 5 slots do, the rest get 429 with Retry-After and
  // succeed when asked again. WebTorrent must keep ≤ 4 web-seed requests in flight (G1).
  test('8 pieces at once: at least 5 pass, the refused ones pass on retry', async () => {
    const ua = `Mozilla/5.0 Chrome/140 seed${seq++}`;
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => piece(ua, i)));
    const st = rs.map(r => r.status);
    expect(st.every(s => s === 206 || s === 429)).toBe(true);
    expect(st.filter(s => s === 206).length).toBeGreaterThanOrEqual(5);
    for (const r of rs) if (r.status === 429) expect(r.headers.get('retry-after')).toBe('5');
    await Promise.all(rs.map(r => r.arrayBuffer()));
    for (const [i, s] of st.entries()) if (s === 429) expect((await piece(ua, i)).status).toBe(206);
  });
});
