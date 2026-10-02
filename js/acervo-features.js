// Reads the compact audio-features payload that script/build-features-web.js writes (<acervo>-features.json.gz).
// Classic script, no dependencies (also loadable with `new Function`, as the tests do).
//
// The payload is columnar and has NO track keys: row i belongs to the i-th track of the catalog as
// decodeAcervo() returns it (albums in order, tracks in order). `cat` carries the catalog's track count
// and a key fingerprint, so a catalog that changed after the features were built is detected, not trusted.
//
//   const f = decodeFeatures(payload, catalogKeys);   // catalogKeys: ["<album path>/<file>", ...] in catalog order
//   f.has(i)  f.bpm[i]  f.voice[i] / 255  f.genre(i) -> [{ name: 'Latin---Samba', p: 0.39 }, ...]
//
// Probability columns are Uint8Array 0–255 (divide by 255); `bpm` is 0 when the row has no usable analysis.

const FEATURES_FORMAT = 1;
const FEATURE_KEYS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const FEATURE_PROBS = ['voice', 'dance', 'acoustic', 'electronic', 'happy', 'sad', 'relaxed', 'aggressive', 'party'];

// FNV-1a over every key, separated by NUL: cheap, stable across Bun/Node/browsers.
function featuresFingerprint(keys) {
  let h = 0x811c9dc5;
  for (const k of keys) {
    for (let i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    h ^= 0; h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function featuresB64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeFeatures(p, catalogKeys) {
  if (!p || p.v !== FEATURES_FORMAT) throw new Error('UNSUPPORTED_FEATURES_VERSION');
  if (catalogKeys) {
    if (catalogKeys.length !== p.cat.n || featuresFingerprint(catalogKeys) !== p.cat.id) {
      throw new Error('FEATURES_CATALOG_MISMATCH');
    }
  }
  const n = p.cat.n;
  const col = name => {
    const b = featuresB64(p.c[name]);
    return b;
  };
  const bpmBytes = col('bpm');                       // u16 little-endian
  const bpm = new Uint16Array(n);
  for (let i = 0; i < n; i++) bpm[i] = bpmBytes[2 * i] | (bpmBytes[2 * i + 1] << 8);
  const gBytes = col('g');                           // u16 little-endian: the genre table can pass 255 entries
  const g = new Uint16Array(3 * n);
  for (let i = 0; i < 3 * n; i++) g[i] = gBytes[2 * i] | (gBytes[2 * i + 1] << 8);
  const f = {
    n, acervo: p.acervo, bpm,
    bpmConf: col('bpmConf'),                         // /40
    tom: col('tom'),                                 // 0 none, else 1 + keyIndex * 2 + (minor ? 1 : 0)
    loud: col('loud'),                               // dB = -value
    genreNames: p.genres, instNames: p.insts,
    g, gw: col('gw'), inst: col('inst'),             // stride 3; genre/inst index + 1 (0 none), weights /255
  };
  for (const name of FEATURE_PROBS) f[name] = col(name);

  f.has = i => bpm[i] > 0;
  f.key = i => {
    const t = f.tom[i];
    return t ? { key: FEATURE_KEYS[(t - 1) >> 1], scale: (t - 1) & 1 ? 'minor' : 'major' } : null;
  };
  f.genre = i => {
    const out = [];
    for (let j = 0; j < 3; j++) {
      const idx = f.g[3 * i + j];
      if (idx) out.push({ name: f.genreNames[idx - 1], p: f.gw[3 * i + j] / 255 });
    }
    return out;
  };
  f.instruments = i => {
    const out = [];
    for (let j = 0; j < 3; j++) { const idx = f.inst[3 * i + j]; if (idx) out.push(f.instNames[idx - 1]); }
    return out;
  };
  return f;
}
