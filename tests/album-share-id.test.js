import { test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import '../js/acervo-format.js';

test('album ids have a fixed width, ignore normalization and use only URL-safe characters', () => {
  const id = albumShareId('1971 - Chico Buarque - Construção');
  expect(id).toMatch(/^[0-9A-Za-z]{5}$/);
  expect(albumShareId('1971 - Chico Buarque - Construção'.normalize('NFD'))).toBe(id);
});

for (const [nome, arquivo] of [['uqt', '../uqt/data/uqt-albums.json.gz'], ['homi', '../hominiscanidae/data/homi-albums.json.gz']]) {
  test.skipIf(!existsSync(arquivo))(`no two ${nome} albums share an id`, () => {
    const { albums } = decodeAcervo(JSON.parse(gunzipSync(readFileSync(arquivo))));
    expect(new Set(albums.map(a => albumShareId(a.path))).size).toBe(albums.length);
  });
}
