import { test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';

// nginx caches by URI alone, so a cached response is served to everyone. proxy.js
// answers some requests per requester (403 to bot user agents, 429 when rate
// limited); caching those under `any` handed one bot's 403 to real browsers.
test('nginx caches only responses that depend on the file, not the requester', () => {
  const conf = fs.readFileSync(path.join(__dirname, '..', 'nginx.conf'), 'utf8');
  const valid = [...conf.matchAll(/^\s*proxy_cache_valid\s+([^;]+);/gm)].map(m => m[1].trim().split(/\s+/));
  expect(valid.length).toBeGreaterThan(0);
  for (const parts of valid) {
    const codes = parts.slice(0, -1);
    expect(codes.length).toBeGreaterThan(0); // a bare time means 200/301/302
    for (const code of codes) expect(['200', '404']).toContain(code);
  }
});

// nginx's own rate limits answer 429 with CORS and Retry-After, not a bare 503: a 503 reads as
// the CDN being down, and without Access-Control-Allow-Origin the radio's HEAD check (js/radio.js)
// can't see the status at all, so it never backs off.
test('nginx limits answer 429 that a cross-origin fetch can read', () => {
  const conf = fs.readFileSync(path.join(__dirname, '..', 'nginx.conf'), 'utf8');
  expect(conf).toMatch(/^\s*limit_req_status\s+429;/m);
  expect(conf).toMatch(/^\s*limit_conn_status\s+429;/m);
  expect(conf).toMatch(/^\s*error_page\s+429\s*=\s*@limitado;/m);
  const bloco = conf.slice(conf.indexOf('location @limitado'));
  expect(bloco.slice(0, bloco.indexOf('}'))).toMatch(/Access-Control-Allow-Origin "\*" always/);
  expect(conf).not.toMatch(/proxy_intercept_errors\s+on/);   // would add a second ACAO to proxied 429s
});
