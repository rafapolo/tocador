// End-to-end regression test for the Unicode-normalization outage.
//
// tests/proxy.test.js unit-tests keyCandidates(), but a unit test could never
// have caught the actual bug: the offending `.normalize('NFC')` lived in the
// request handler, nowhere near the helper. The only thing that catches it is
// driving the real proxy process against an S3 that stores keys byte-exactly
// and refuses to be helpful about it — which is precisely how S3 behaves.
//
// Boots proxy.js as a subprocess pointed at a fake origin, so the full path is
// exercised: URL decode → isSafeKey → keyCandidates → sigV4Encode → signed
// fetch → response passthrough.

const { test, expect, describe, beforeAll, afterAll } = require('bun:test');

// ── fixtures ──────────────────────────────────────────────────────────────────
// Built by explicit normalization, never trusted to source-file bytes.

const ALBUM = '1965 - Forma65';
const TRACK = 'Canção do Olhar Amado.mp3';
const PLAIN = '01 Reza.mp3'; // no accents — worked all through the outage

const nfd = s => s.normalize('NFD');
const nfc = s => s.normalize('NFC');

const KEY_NFD = nfd(`uqt/${ALBUM}/03 ${TRACK}`);
const KEY_NFC = nfc(`uqt/${ALBUM}/03 ${TRACK}`);
const KEY_PLAIN = `uqt/${ALBUM}/${PLAIN}`;

// An album folder whose *directory* name carries the accent, not the file.
const DIR_NFD = nfd('uqt/1974 - Beth Carvalho - Prá Seu Governo/2. 1800 Colinas.mp3');
const DIR_NFC = nfc('uqt/1974 - Beth Carvalho - Prá Seu Governo/2. 1800 Colinas.mp3');

const BODY = Buffer.alloc(4096, 0x42);

// ── fake S3 ───────────────────────────────────────────────────────────────────

let s3, proxy, proxyPort;
let stored = new Map(); // exact key bytes -> body
let requestedKeys = []; // every key the proxy actually asked for, in order

function startFakeS3() {
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const u = new URL(req.url);
      // Strip the leading "/<bucket>/" and decode per segment, exactly as S3
      // would. No normalization anywhere — that is the whole point.
      const segs = u.pathname.replace(/^\/+/, '').split('/');
      segs.shift(); // bucket
      const key = segs.map(decodeURIComponent).join('/');
      requestedKeys.push(key);

      const body = stored.get(key);
      if (!body) return new Response('<Error>NoSuchKey</Error>', { status: 404 });

      const range = req.headers.get('range');
      if (range) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(range);
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : body.length - 1;
        return new Response(body.subarray(start, end + 1), {
          status: 206,
          headers: {
            'Content-Range': `bytes ${start}-${end}/${body.length}`,
            'Content-Length': String(end - start + 1),
            'ETag': '"fake"',
          },
        });
      }
      return new Response(body, {
        status: 200,
        headers: { 'Content-Length': String(body.length), 'ETag': '"fake"' },
      });
    },
  });
}

async function waitForPort(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`);
      return;
    } catch {
      await Bun.sleep(50);
    }
  }
  throw new Error(`proxy did not come up on :${port}`);
}

beforeAll(async () => {
  s3 = startFakeS3();
  proxyPort = 20000 + Math.floor(Math.random() * 20000);
  proxy = Bun.spawn(['bun', `${import.meta.dir}/../proxy.js`], {
    env: {
      ...process.env,
      PORT: String(proxyPort),
      S3_ENDPOINT: `http://127.0.0.1:${s3.port}`,
      S3_BUCKET: 'testbucket',
      S3_BUCKET_MAP: '',
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  await waitForPort(proxyPort);
});

afterAll(() => {
  proxy?.kill();
  s3?.stop(true);
});

// Unique UA per call: the proxy rate-limits by IP+User-Agent (30-request
// burst), and every request in this file comes from 127.0.0.1.
let seq = 0;
async function get(key, { range = 'bytes=0-99' } = {}) {
  const url = `http://127.0.0.1:${proxyPort}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const r = await fetch(url, {
    headers: { Range: range, 'User-Agent': `Mozilla/5.0 test-${seq++}` },
  });
  const buf = await r.arrayBuffer();
  return { status: r.status, len: buf.byteLength, headers: r.headers };
}

function reset(entries) {
  stored = new Map(entries);
  requestedKeys = [];
}

// ── the regression ────────────────────────────────────────────────────────────

describe('S3 stores NFD (the uqt/sambaraiz case)', () => {
  test('an NFD request reaches an NFD-stored key', async () => {
    // This is the one the shipped bug broke: the client asked in exactly the
    // form S3 held, and the proxy composed it into a different key.
    reset([[KEY_NFD, BODY]]);
    const r = await get(KEY_NFD);
    expect(r.status).toBe(206);
    expect(r.len).toBe(100);
  });

  test('an NFC request still reaches an NFD-stored key', async () => {
    reset([[KEY_NFD, BODY]]);
    expect((await get(KEY_NFC)).status).toBe(206);
  });

  test('the accented directory segment resolves too', async () => {
    reset([[DIR_NFD, BODY]]);
    expect((await get(DIR_NFD)).status).toBe(206);
    reset([[DIR_NFD, BODY]]);
    expect((await get(DIR_NFC)).status).toBe(206);
  });
});

describe('S3 stores NFC (the indie case)', () => {
  test('an NFC request reaches an NFC-stored key', async () => {
    reset([[KEY_NFC, BODY]]);
    expect((await get(KEY_NFC)).status).toBe(206);
  });

  test('an NFD request still reaches an NFC-stored key', async () => {
    reset([[KEY_NFC, BODY]]);
    expect((await get(KEY_NFD)).status).toBe(206);
  });

  test('both directions work without the buckets being uniform', async () => {
    // Mirrors reality: one bucket holds keys in both forms at once.
    reset([[KEY_NFD, BODY], [DIR_NFC, BODY]]);
    expect((await get(KEY_NFC)).status).toBe(206);
    expect((await get(DIR_NFD)).status).toBe(206);
  });
});

describe('cost and correctness of the fallback', () => {
  test('a key that exists as requested costs exactly one upstream request', async () => {
    reset([[KEY_NFD, BODY]]);
    await get(KEY_NFD);
    expect(requestedKeys).toEqual([KEY_NFD]);
  });

  test('an ASCII key never triggers a retry', async () => {
    reset([[KEY_PLAIN, BODY]]);
    await get(KEY_PLAIN);
    expect(requestedKeys).toEqual([KEY_PLAIN]);
  });

  test('the fallback tries the requested form first, then the other', async () => {
    reset([[KEY_NFD, BODY]]);
    await get(KEY_NFC);
    expect(requestedKeys[0]).toBe(KEY_NFC); // as asked
    expect(requestedKeys).toContain(KEY_NFD); // then the stored form
  });

  test('a genuinely absent key still 404s, and is not retried forever', async () => {
    reset([]);
    const r = await get(KEY_NFD);
    expect(r.status).toBe(404);
    // Both forms tried, nothing more.
    expect(requestedKeys.length).toBe(2);
    expect(new Set(requestedKeys).size).toBe(2);
  });

  test('an absent ASCII key costs a single 404', async () => {
    reset([]);
    expect((await get(KEY_PLAIN)).status).toBe(404);
    expect(requestedKeys).toEqual([KEY_PLAIN]);
  });
});

describe('range passthrough survives the retry', () => {
  test("S3's real Content-Range total is forwarded on a fallback hit", async () => {
    // Mobile Safari abandons playback if the total is "*" — see the comment in
    // proxy.js. The retry path must not lose that header.
    reset([[KEY_NFD, BODY]]);
    const r = await get(KEY_NFC, { range: 'bytes=0-1023' });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe(`bytes 0-1023/${BODY.length}`);
    expect(r.len).toBe(1024);
  });

  test('CORS headers are present on a fallback hit', async () => {
    reset([[KEY_NFD, BODY]]);
    const r = await get(KEY_NFC);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.headers.get('content-type')).toBe('audio/mpeg');
  });
});
