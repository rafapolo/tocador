// build-torrents.js: o infohash tem de bater com uma implementação independente (o vetor abaixo saiu de
// ~10 linhas de Python com hashlib, não deste código), senão nenhum cliente BitTorrent acha o enxame.
const { test, expect } = require('bun:test');
const { criarTorrent, bencode, PECA } = require('./build-torrents.js');

const N = 2_621_563;                                   // 2,5 MiB + 123: a última peça é parcial
const bytes = Uint8Array.from({ length: N }, (_, i) => (i * 31 + 7) & 255);

test('infohash e peças batem com o vetor independente', () => {
  const t = criarTorrent({ nome: '01 Canção.mp3', bytes, urlList: 'https://cdn.tocador.cc/uqt/A/01.mp3' });
  expect(PECA).toBe(1048576);
  expect(t.pecas).toBe(3);
  expect(t.tamanho).toBe(N);
  expect(t.infoHash).toBe('53e5949cad2d02ad4ce193397b772fc8ff0849c6');   // nome NFD vira NFC
});

test('url-list fica fora do info: trocar o CDN não muda o infohash', () => {
  const a = criarTorrent({ nome: 'x.mp3', bytes: bytes.subarray(0, 5000), urlList: 'https://a/x.mp3' });
  const b = criarTorrent({ nome: 'x.mp3', bytes: bytes.subarray(0, 5000), urlList: 'https://b/x.mp3' });
  expect(a.infoHash).toBe(b.infoHash);
  expect(a.torrent.includes('8:url-list')).toBe(true);
  expect(a.torrent.includes('announce')).toBe(false);
});

test('bencode ordena as chaves por bytes e conta bytes UTF-8', () => {
  expect(bencode({ b: 1, a: 'ç' }).toString()).toBe('d1:a2:ç1:bi1ee');
  expect(bencode(['x', 0, -3]).toString()).toBe('l1:xi0ei-3ee');
});
