import { test, expect } from 'bun:test';
import { removeTracks } from './remove-tracks.js';

const albums = () => [
  { title: 'A', artist: 'X', year: 2000, path: 'p/A', tracks: [{ file: '1.mp3' }, { file: 'Frêvo.mp3' }] },
  { title: 'B', artist: 'Y', year: 2001, path: 'p/B', tracks: [{ file: '1.mp3' }] },
];

test('remove só a faixa pedida, casando NFC e NFD', () => {
  const r = removeTracks(albums(), ['p/A/Frêvo.mp3']);
  expect(r.removed).toEqual(['p/A/Frêvo.mp3']);
  expect(r.missing).toEqual([]);
  expect(r.albums[0].tracks.map(t => t.file)).toEqual(['1.mp3']);
  expect(r.albums[1].tracks.length).toBe(1);
  expect(r.albums.length).toBe(2);
});

test('chave inexistente vai para missing', () => {
  expect(removeTracks(albums(), ['p/A/nada.mp3']).missing).toEqual(['p/A/nada.mp3']);
});

test('recusa deixar um álbum sem faixas', () => {
  expect(() => removeTracks(albums(), ['p/B/1.mp3'])).toThrow(/sem faixas/);
});
