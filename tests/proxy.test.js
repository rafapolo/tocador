// Unit tests for proxy.js's pure helpers.
//
// These import the real functions from proxy.js. They used to re-declare
// sigV4Encode locally "so it can be unit-tested without spinning up the full
// proxy" — but a test that copies its subject passes forever no matter what
// the subject does, which is worthless as a regression guard. proxy.js now
// only calls Bun.serve() under `import.meta.main`, so importing it is free.
//
// Every accented string below is written with \u escapes and normalized
// explicitly. Raw literals would be at the mercy of whatever normalization the
// editor, terminal or patch tool that last touched this file happened to
// apply — and if NFD and NFC fixtures ever collapsed into the same string,
// these tests would still pass while guarding nothing.

const { test, expect, describe } = require('bun:test');
const { sigV4Encode, keyCandidates, isSafeKey } = require('../proxy.js');

// ── sigV4Encode correctness ───────────────────────────────────────────────────

test('sigV4Encode: encodes ! as %21', () => {
  expect(sigV4Encode('VICTIM!')).toBe('VICTIM%21');
});

test('sigV4Encode: encodes ( and ) as %28 and %29', () => {
  expect(sigV4Encode('(2022)')).toBe('%282022%29');
  expect(sigV4Encode('(Face 2)')).toBe('%28Face%202%29');
});

test("sigV4Encode: encodes ' as %27", () => {
  expect(sigV4Encode("it's")).toBe('it%27s');
});

test('sigV4Encode: encodes * as %2A', () => {
  expect(sigV4Encode('foo*bar')).toBe('foo%2Abar');
});

test('sigV4Encode: encodes space as %20 (not +)', () => {
  expect(sigV4Encode('hello world')).toBe('hello%20world');
});

test('sigV4Encode: encodes # as %23', () => {
  expect(sigV4Encode('Hominis Canidae #60')).toBe('Hominis%20Canidae%20%2360');
});

test('sigV4Encode: unreserved chars A-Z a-z 0-9 - _ . ~ are not encoded', () => {
  const safe = 'AbcXYZ-0_9.~';
  expect(sigV4Encode(safe)).toBe(safe);
});

test('sigV4Encode: real album path with # and !', () => {
  const seg = '2015 - VICTIM! - Hominis Canidae #60 - Maio';
  const enc = sigV4Encode(seg);
  expect(enc).toBe('2015%20-%20VICTIM%21%20-%20Hominis%20Canidae%20%2360%20-%20Maio');
  expect(enc).not.toContain('!');
});

test('sigV4Encode: real album path with # and ()', () => {
  const seg = '2022 - Jean Medeiros - Hominis Canidae #147 - Agosto (2022)';
  const enc = sigV4Encode(seg);
  expect(enc).toBe('2022%20-%20Jean%20Medeiros%20-%20Hominis%20Canidae%20%23147%20-%20Agosto%20%282022%29');
  expect(enc).not.toContain('(');
  expect(enc).not.toContain(')');
});

test('sigV4Encode: preserves NFD combining marks byte-for-byte', () => {
  const NFD_C = 'ç'; // c + COMBINING CEDILLA
  const NFC_C = 'ç';  // LATIN SMALL LETTER C WITH CEDILLA
  expect(NFD_C.normalize('NFC')).toBe(NFC_C);
  expect(sigV4Encode(NFD_C)).toBe('c%CC%A7');
  expect(sigV4Encode(NFC_C)).toBe('%C3%A7');
  // The whole outage in one line: these address two different S3 keys.
  expect(sigV4Encode(NFD_C)).not.toBe(sigV4Encode(NFC_C));
});

// ── keyCandidates: the NFD/NFC regression ─────────────────────────────────────
//
// The bug this guards: proxy.js used to run `.normalize('NFC')` on every
// incoming path before signing. S3 never normalizes — it stores exactly the
// bytes that were uploaded — and the buckets are not uniform: sambaraiz/uqt is
// mostly NFD (uploaded from macOS), indie/indie is mostly NFC, and each holds
// keys in the other form. Composing every request made each accented uqt key a
// different byte sequence than the stored one: 14,676 of 28,817 uqt tracks
// (50.9%, across 2,199 of 2,306 albums) 404'd for ~3 months.

// "Canção do Olhar Amado" — track 3 of the album that surfaced this.
const CANCAO = 'Canção do Olhar Amado';
const NFD_CANCAO = CANCAO.normalize('NFD'); // as macOS wrote it
const NFC_CANCAO = CANCAO.normalize('NFC'); // as most other tools write it

describe('keyCandidates', () => {
  test('sanity: the two fixtures really are different byte sequences', () => {
    // If this ever fails, every other test in this block is a tautology.
    expect(NFD_CANCAO).not.toBe(NFC_CANCAO);
    expect(NFD_CANCAO.normalize('NFC')).toBe(NFC_CANCAO);
    expect(NFC_CANCAO.normalize('NFD')).toBe(NFD_CANCAO);
  });

  test('always tries the requested key first, unchanged', () => {
    // Anything else costs a wasted round trip on every hit in the common case.
    expect(keyCandidates(NFD_CANCAO)[0]).toBe(NFD_CANCAO);
    expect(keyCandidates(NFC_CANCAO)[0]).toBe(NFC_CANCAO);
  });

  test('an NFD request can still reach an NFC-stored key', () => {
    expect(keyCandidates(NFD_CANCAO)).toContain(NFC_CANCAO);
  });

  test('an NFC request can still reach an NFD-stored key', () => {
    expect(keyCandidates(NFC_CANCAO)).toContain(NFD_CANCAO);
  });

  test('covers both forms whichever way the client asks', () => {
    for (const asked of [NFD_CANCAO, NFC_CANCAO]) {
      const c = keyCandidates(asked);
      expect(c).toContain(NFD_CANCAO);
      expect(c).toContain(NFC_CANCAO);
    }
  });

  test('never normalizes away the requested form', () => {
    // The shipped bug stated directly: the requested bytes must survive into
    // the candidate list rather than being replaced by one chosen form.
    expect(keyCandidates(NFD_CANCAO)).toContain(NFD_CANCAO);
    expect(keyCandidates(NFC_CANCAO)).toContain(NFC_CANCAO);
  });

  test('emits no duplicates', () => {
    for (const k of [NFD_CANCAO, NFC_CANCAO, 'plain ascii.mp3']) {
      const c = keyCandidates(k);
      expect(new Set(c).size).toBe(c.length);
    }
  });

  test('an ASCII key yields exactly one candidate — no extra round trips', () => {
    expect(keyCandidates('uqt/1965 - Forma65/01 Reza.mp3')).toEqual([
      'uqt/1965 - Forma65/01 Reza.mp3',
    ]);
  });

  test('applies to the whole key, not just the filename segment', () => {
    // Album folders carry accents too: "1974 - Beth Carvalho - Prá Seu Governo".
    const key = 'uqt/1974 - Beth Carvalho - Prá Seu Governo/2. 1800 Colinas.mp3';
    const nfd = key.normalize('NFD');
    expect(nfd).not.toBe(key.normalize('NFC'));
    expect(keyCandidates(nfd)[0]).toBe(nfd);
    expect(keyCandidates(nfd)).toContain(key.normalize('NFC'));
  });

  test('real uqt filenames that the NFC bug killed', () => {
    // Every one of these is stored NFD in sambaraiz and 404'd in production.
    const files = [
      '04 Só Tinha que Ser com Você.mp3',
      '05 História Antiga.mp3',
      '06 Pregão.mp3',
      '07 O Morro não Tem Vez.mp3',
      '08 Nanã.mp3',
      '10 Consolação.mp3',
    ];
    for (const f of files) {
      // Guard against a tautology: if a name lost its accents, say so loudly.
      expect(f.normalize('NFC')).not.toBe(f.normalize('NFD'));
      const key = `uqt/1965 - Forma65/${f}`.normalize('NFD');
      expect(keyCandidates(key)[0]).toBe(key);                     // NFD tried as stored
      expect(keyCandidates(key)).toContain(key.normalize('NFC'));  // NFC still reachable
      expect(keyCandidates(key).length).toBe(2);
    }
  });

  test('accent-free names in the same album stay single-candidate', () => {
    // These two are why the outage read as "some tracks are dead" rather than
    // "the album is dead" — no accents, so they kept working throughout.
    expect(keyCandidates('uqt/1965 - Forma65/01 Reza.mp3').length).toBe(1);
    expect(keyCandidates('uqt/1965 - Forma65/02 Batucada Surgiu.mp3').length).toBe(1);
  });
});

// ── isSafeKey: path traversal guard ───────────────────────────────────────────

describe('isSafeKey', () => {
  test('accepts ordinary keys', () => {
    expect(isSafeKey('uqt/1965 - Forma65/01 Reza.mp3')).toBe(true);
  });

  test('accepts accented keys in both normalization forms', () => {
    // The guard must not be the thing that rejects NFD.
    expect(isSafeKey(`uqt/x/${NFD_CANCAO}.mp3`)).toBe(true);
    expect(isSafeKey(`uqt/x/${NFC_CANCAO}.mp3`)).toBe(true);
  });

  test('rejects traversal, empty segments, NUL and backslash', () => {
    expect(isSafeKey('uqt/../secret')).toBe(false);
    expect(isSafeKey('uqt/./x')).toBe(false);
    expect(isSafeKey('uqt//x')).toBe(false);
    expect(isSafeKey('uqt/\0')).toBe(false);
    expect(isSafeKey('uqt\\x')).toBe(false);
  });

  test('rejects empty and over-long keys', () => {
    expect(isSafeKey('')).toBe(false);
    expect(isSafeKey('a'.repeat(1025))).toBe(false);
  });
});
