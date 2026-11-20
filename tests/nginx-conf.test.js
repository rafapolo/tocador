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

// Every listener reached the proxy as 172.18.0.1 (haloy's proxy on the Docker bridge), which
// made the per-IP limits global. nginx must read the client from X-Forwarded-For, trusting
// only the bridge and loopback.
test('nginx takes the client IP from X-Forwarded-For, trusting only the docker bridge', () => {
  const conf = fs.readFileSync(path.join(__dirname, '..', 'nginx.conf'), 'utf8');
  const confia = [...conf.matchAll(/^\s*set_real_ip_from\s+([^;]+);/gm)].map(m => m[1].trim());
  expect(confia).toEqual(['172.16.0.0/12', '127.0.0.1']);
  expect(conf).toMatch(/^\s*real_ip_header\s+X-Forwarded-For;/m);
  expect(conf).toMatch(/^\s*real_ip_recursive\s+on;/m);
});

// The cover cache is a haloy volume filled by aquecer-capas.js (2026-11-21): if proxy_cache_path and
// the mount drift apart, every deploy silently empties the cache and covers go back to the slow S3.
// nginx comes from the official image, pinned at or past the version that fixed every advisory then open.
test('the cover cache sits on the haloy volume and nginx is a patched release', () => {
  const raiz = path.join(__dirname, '..');
  const conf = fs.readFileSync(path.join(raiz, 'nginx.conf'), 'utf8');
  const haloy = fs.readFileSync(path.join(raiz, 'haloy.yaml'), 'utf8');
  const docker = fs.readFileSync(path.join(raiz, 'Dockerfile'), 'utf8');
  const cache = conf.match(/^\s*proxy_cache_path\s+(\S+)/m)[1];
  expect(haloy).toContain(`:${cache}"`);
  expect(conf).toMatch(/inactive=365d/);
  const [, maior, menor, patch] = docker.match(/^FROM nginx:(\d+)\.(\d+)\.(\d+)-alpine/m).map(Number);
  expect(maior * 1e6 + menor * 1e3 + patch).toBeGreaterThanOrEqual(1030007);
  expect(docker).toContain('aquecer-capas.js');
});
