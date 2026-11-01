// /metrics today.topTracks (lib/metrics.js §17): a track starting counts once per device per
// half hour, the list is the 15 most played, and only paths are kept.
const { test, expect } = require('bun:test');
const { markPlay, topTracks, metricsJSON, todayPlays } = require('../lib/metrics.js');

test('um aparelho conta uma vez por faixa; outro aparelho conta de novo', () => {
  todayPlays.clear();
  markPlay('a', 'uqt/Album/01 X.mp3');
  markPlay('a', 'uqt/Album/01 X.mp3');      // probe do Safari / seek de volta ao 0
  markPlay('b', 'uqt/Album/01 X.mp3');
  markPlay('a', 'indie/Outro/02 Y.mp3');
  expect(topTracks()).toEqual([
    { path: 'uqt/Album/01 X.mp3', plays: 2 },
    { path: 'indie/Outro/02 Y.mp3', plays: 1 },
  ]);
  expect(metricsJSON().today.plays).toBe(3);
});

test('a lista tem no máximo 15, das mais tocadas para as menos', () => {
  todayPlays.clear();
  for (let i = 0; i < 20; i++) for (let d = 0; d <= i; d++) markPlay(`dev${d}`, `uqt/A/${i}.mp3`);
  const top = metricsJSON().today.topTracks;
  expect(top).toHaveLength(15);
  expect(top[0]).toEqual({ path: 'uqt/A/19.mp3', plays: 20 });
  expect(top[14]).toEqual({ path: 'uqt/A/5.mp3', plays: 6 });
});

test('caminhos NFD saem em NFC', () => {
  todayPlays.clear();
  markPlay('a', 'uqt/Construção/01.mp3');
  expect(topTracks()[0].path).toBe('uqt/Construção/01.mp3');
});
