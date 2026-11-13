// /metrics today.overlapPlays / overlapRatio (lib/metrics.js §19): a play overlaps when another
// device started the same track in the 5 minutes before it. Decides whether P2P pays off
// (tasks/plans/p2p-gun-tracker.md, G0).
const { test, expect, beforeEach, afterEach, setSystemTime } = require('bun:test');
const { markPlay, metricsJSON, todayPlays, lastPlay, resetOverlap } = require('../lib/metrics.js');

const T0 = new Date('2026-11-13T15:00:00Z');
beforeEach(() => { setSystemTime(T0); todayPlays.clear(); lastPlay.clear(); resetOverlap(); });
afterEach(() => setSystemTime());
const em = (min) => setSystemTime(new Date(T0.getTime() + min * 60_000));

test('outro aparelho na mesma faixa dentro de 5 min conta como sobreposição', () => {
  markPlay('a', 'uqt/A/01.mp3');
  em(4); markPlay('b', 'uqt/A/01.mp3');
  const t = metricsJSON().today;
  expect(t.overlapPlays).toBe(1);
  expect(t.overlapRatio).toBe(0.5);
});

test('depois de 5 min não sobrepõe mais', () => {
  markPlay('a', 'uqt/A/01.mp3');
  em(6); markPlay('b', 'uqt/A/01.mp3');
  expect(metricsJSON().today.overlapPlays).toBe(0);
});

test('o mesmo aparelho repetindo a faixa não sobrepõe nem conta de novo', () => {
  markPlay('a', 'uqt/A/01.mp3');
  em(1); markPlay('a', 'uqt/A/01.mp3');
  em(2); markPlay('b', 'uqt/A/02.mp3');
  const t = metricsJSON().today;
  expect(t.overlapPlays).toBe(0);
  expect(t.plays).toBe(2);
});

test('NFD e NFC são a mesma faixa, e a rádio é contada à parte', () => {
  markPlay('a', 'uqt/Construção/01.mp3', 'radio');
  em(1); markPlay('b', 'uqt/Construção/01.mp3', 'radio');
  em(2); markPlay('c', 'uqt/B/01.mp3');
  const t = metricsJSON().today;
  expect(t.overlapPlays).toBe(1);
  expect(t.overlapPorOrigem.radio).toEqual({ plays: 1, ratio: 0.5 });
  expect(t.overlapPorOrigem.player).toEqual({ plays: 0, ratio: 0 });
});
