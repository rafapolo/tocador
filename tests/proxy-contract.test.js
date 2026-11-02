// What each browser's media stack asks the CDN for, and what it must get back.
// Safari's AVFoundation opens with a fixed probe (bytes=0-1) and reads the total size from
// Content-Range: a "/*" there made iPhones stop after a few seconds (17d807f). Chrome asks
// bytes=0-, Firefox re-requests bytes=N- on every seek, and a range past the end must say
// the real size so the browser can correct itself. Desktop testing never exercises most of
// these, so they are pinned here against the real proxy (tests/fixtures/proxy-harness.js).

const { test, expect, describe, beforeAll, afterAll } = require('bun:test');
const { proxyHarness } = require('./fixtures/proxy-harness.js');
const { uaFamily } = require('../lib/metrics.js');

const UAS = {
  safari_ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  applecoremedia: 'AppleCoreMedia/1.0.0.22A3354 (iPhone; U; CPU OS 18_0 like Mac OS X; pt_br)',
  safari_mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  chrome_android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
};

const KEY = 'indie/2020 - Banda - Disco/01 Faixa.mp3';
const SIZE = 50_000;
const BODY = Buffer.alloc(SIZE, 0x42);
const h = proxyHarness();
beforeAll(async () => { await h.start(); h.reset([[KEY, BODY]]); });
afterAll(() => h.stop());

let seq = 0;
async function ask(ua, { range, method = 'GET', referer = 'https://tocador.cc/uqt/disco/' } = {}) {
  const headers = { 'User-Agent': `${ua} t${seq++}` };   // own rate-limit bucket per call
  if (range) headers.Range = range;
  if (referer) headers.Referer = referer;
  const r = await fetch(h.url(KEY), { method, headers });
  const len = method === 'HEAD' ? 0 : (await r.arrayBuffer()).byteLength;
  return { status: r.status, len, get: (n) => r.headers.get(n) };
}

function mediaHeaders(r) {
  expect(r.get('content-type')).toBe('audio/mpeg');
  expect(r.get('accept-ranges')).toBe('bytes');
  expect(r.get('access-control-allow-origin')).toBe('*');
  expect(r.get('access-control-expose-headers')).toContain('Content-Range');
}

describe.each(Object.entries(UAS))('%s', (name, ua) => {
  test('the fixed probe (Safari: bytes=0-1) gets 206 with the real total', async () => {
    const r = await ask(ua, { range: 'bytes=0-1' });
    expect(r.status).toBe(206);
    expect(r.get('content-range')).toBe(`bytes 0-1/${SIZE}`);
    expect(r.len).toBe(2);
    mediaHeaders(r);
  });

  test('an open range (Chrome: bytes=0-) gets the whole file as 206', async () => {
    const r = await ask(ua, { range: 'bytes=0-' });
    expect(r.status).toBe(206);
    expect(r.get('content-range')).toBe(`bytes 0-${SIZE - 1}/${SIZE}`);
    expect(r.len).toBe(SIZE);
    mediaHeaders(r);
  });

  test('a seek (Firefox: bytes=N-) starts where it was asked', async () => {
    const r = await ask(ua, { range: 'bytes=40000-' });
    expect(r.status).toBe(206);
    expect(r.get('content-range')).toBe(`bytes 40000-${SIZE - 1}/${SIZE}`);
    expect(r.len).toBe(SIZE - 40000);
  });

  test('HEAD and a plain GET report the size', async () => {
    const head = await ask(ua, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.get('content-length')).toBe(String(SIZE));
    mediaHeaders(head);
    const get = await ask(ua);
    expect(get.status).toBe(200);
    expect(get.len).toBe(SIZE);
  });

  test('a range past the end gets 416 with bytes */<total>', async () => {
    const r = await ask(ua, { range: `bytes=${SIZE}-` });
    expect(r.status).toBe(416);
    expect(r.get('content-range')).toBe(`bytes */${SIZE}`);
    expect(r.get('access-control-allow-origin')).toBe('*');
  });

  test('is not taken for a bot', async () => {
    expect((await ask(ua, { range: 'bytes=0-1' })).status).not.toBe(403);
  });
});

describe('cast receivers and stripped Referers', () => {
  // Item 2 of tasks/compat-navegadores-2026-11-02.md: these fetch the URL themselves, with no
  // Referer. Today that is a 403 (hotlink check); this pins the behaviour until it's decided.
  test('a Chromecast fetch with no Referer is refused, and counted as chromecast', async () => {
    const ua = 'Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 CrKey/1.56.500000';
    expect((await ask(ua, { range: 'bytes=0-', referer: null })).status).toBe(403);
    const auth = 'Basic ' + btoa(':610336c3eeea7dc0347bd58b3a197473');
    const m = await (await fetch(`http://127.0.0.1:${h.port}/metrics`, { headers: { Authorization: auth } })).json();
    expect(m.today.refused.hotlink.chromecast).toBe(1);
  });
});

test('uaFamily sorts the media stacks apart', () => {
  expect(uaFamily(UAS.safari_ios)).toBe('safari');
  expect(uaFamily(UAS.applecoremedia)).toBe('applecoremedia');
  expect(uaFamily('AppleCoreMedia/1.0.0.21J354 (Apple TV; U; CPU OS 17_0 like Mac OS X; en_us)')).toBe('airplay');
  expect(uaFamily(UAS.chrome_android)).toBe('chrome');
  expect(uaFamily(UAS.firefox)).toBe('firefox');
  expect(uaFamily(UAS.samsung)).toBe('samsung');
  expect(uaFamily(UAS.edge)).toBe('edge');
  expect(uaFamily('curl/8.7.1')).toBe('outro');
});
