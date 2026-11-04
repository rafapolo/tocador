import { test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import '../js/acervo-format.js';

test('catalog numbers are kept, missing ones become the position', () => {
  expect(playerTrackNums([{ num: 1 }, { num: 3 }, { num: 7 }])).toEqual([1, 3, 7]);
  expect(playerTrackNums([{}, {}, {}])).toEqual([1, 2, 3]);
});

test('repeated numbers fall back to positions, so #tN names one track', () => {
  // Hominis Canidae #175: "rés - peba - 01 reviravolta", "02. TRIsE vs …" (no tag), "rés - peba - 02 peba"…
  expect(playerTrackNums([{}, {}, { num: 2 }, { num: 3 }, { num: 4 }, { num: 4 }])).toEqual([1, 2, 3, 4, 5, 6]);
});

for (const [nome, arquivo] of [['uqt', '../uqt/data/uqt-albums.json.gz'], ['homi', '../hominiscanidae/data/homi-albums.json.gz']]) {
  test.skipIf(!existsSync(arquivo))(`every ${nome} track has its own number within the album`, () => {
    const { albums } = decodeAcervo(JSON.parse(gunzipSync(readFileSync(arquivo))));
    for (const a of albums) {
      const nums = playerTrackNums(a.tracks);
      expect(new Set(nums).size).toBe(nums.length);
    }
  });
}
