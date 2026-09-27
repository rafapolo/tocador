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
