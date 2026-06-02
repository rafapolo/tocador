const { test, expect } = require('bun:test');

// sigV4Encode is defined in proxy.js; copy it here so it can be unit-tested
// without spinning up the full proxy. Keep in sync with proxy.js.
function sigV4Encode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, c =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

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
  // must not contain literal ! ( )
  expect(enc).not.toContain('!');
});

test('sigV4Encode: real album path with # and ()', () => {
  const seg = '2022 - Jean Medeiros - Hominis Canidae #147 - Agosto (2022)';
  const enc = sigV4Encode(seg);
  expect(enc).toBe('2022%20-%20Jean%20Medeiros%20-%20Hominis%20Canidae%20%23147%20-%20Agosto%20%282022%29');
  expect(enc).not.toContain('(');
  expect(enc).not.toContain(')');
});
