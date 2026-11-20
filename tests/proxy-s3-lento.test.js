// S3 stalling on one object (2026-11-20, #646-#657): the signed fetch had no timeout, Bun.serve's
// 10 s idleTimeout dropped the socket and nginx answered a bare 502, which the browser read as
// MediaError 4. Now only the wait for the headers is bounded (S3_HEADERS_TIMEOUT_MS, shortened here),
// with one retry, then a 504 with CORS. A body that is merely slow must still arrive whole.

const { test, expect, beforeAll, afterAll } = require('bun:test');
const { proxyHarness } = require('./fixtures/proxy-harness.js');

const KEY = 'indie/2021 - Banda - Disco #135 - Agosto/06 - Tiago Sá - Querelas.mp3';
const BODY = Buffer.alloc(20 * 1024, 0x42);
const h = proxyHarness();
beforeAll(async () => { await h.start({ S3_HEADERS_TIMEOUT_MS: '300' }); });
afterAll(() => h.stop());

let seq = 0;
const ask = (method = 'GET') => fetch(h.url(KEY), {
  method,
  headers: { 'User-Agent': `Mozilla/5.0 Firefox/140.0 lento${seq++}`, Referer: 'https://tocador.cc/', Range: 'bytes=0-' },
});

test('headers that never come: one retry, then 504 with CORS before the socket is dropped', async () => {
  h.reset([[KEY, BODY]]);
  h.stall.set(KEY, 99);
  const t = Date.now();
  const r = await ask();
  expect(r.status).toBe(504);
  expect(r.headers.get('access-control-allow-origin')).toBe('*');
  expect(Date.now() - t).toBeLessThan(2000);
  expect(h.requested.filter((q) => q.key === KEY).length).toBe(2);
  const health = await (await fetch(`http://127.0.0.1:${h.port}/health`)).json();
  expect(health.upstreamFailStreak).toBe(0);   // one slow object must not flip /health
});

test('a stall that clears on the retry still plays', async () => {
  h.reset([[KEY, BODY]]);
  h.stall.set(KEY, 1);
  const r = await ask();
  expect(r.status).toBe(206);
  expect((await r.arrayBuffer()).byteLength).toBe(BODY.length);
});

test('a body slower than the timeout is not cut: only the headers are timed', async () => {
  h.reset([[KEY, BODY]]);
  h.drip.set(KEY, 40);   // 20 chunks × 40 ms = 800 ms, well past the 300 ms header timeout
  const r = await ask();
  expect(r.status).toBe(200);   // the dripping fake ignores Range
  expect((await r.arrayBuffer()).byteLength).toBe(BODY.length);
});

test('HEAD answers with the size without streaming the file', async () => {
  h.reset([[KEY, BODY]]);
  const r = await ask('HEAD');
  expect(r.status).toBe(200);
  expect(r.headers.get('content-length')).toBe(String(BODY.length));
});
