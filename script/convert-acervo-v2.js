#!/usr/bin/env bun
// Convert a v1 acervo .json.gz to the v2 columnar payload.
//
//   bun script/convert-acervo-v2.js ../uqt/data/uqt-albums.json.gz
//   bun script/convert-acervo-v2.js in.json.gz out.json.gz
//
// Lossless with respect to what the player reads: run with --verify (default)
// and it decodes the result back and compares against the input before writing.
//
// Exists because regenerating from source needs the music volume mounted, while
// migrating an already-published catalog needs only the catalog itself.

const FK_LITERAL = 0;
const FK_DASH = 1;
const FK_PLAIN = 2;

const pad2 = n => (n < 10 ? '0' + n : '' + n);

function encodeV2(db) {
  // Sort by artist, then year. gzip's window is 32KB, so clustering an artist's
  // albums lets repeated artist strings actually match; the player re-sorts by
  // year at load, so on-disk order is free to choose. Worth ~9% on uqt, ~2% on
  // homi (which has mostly one album per artist).
  const A = [...db.albums].sort(
    (a, b) => (a.artist || '').localeCompare(b.artist || '') || (a.year || 0) - (b.year || 0)
  );

  const aT = [], aR = [], aY = [], aP = [], aC = [], aN = [];
  const tT = [], tF = [], tK = [], tD = [], tR = [], tN = [];

  for (const a of A) {
    const year = a.year || 0;
    aT.push(a.title);
    aR.push(a.artist);
    aY.push(year);
    // Empty marks "equals the conventional folder name" — rebuilt on decode.
    aP.push(a.path === `${year} - ${a.artist} - ${a.title}` ? '' : a.path);
    aC.push(a.has_cover === false ? 0 : 1);
    aN.push(a.tracks.length);

    a.tracks.forEach((t, i) => {
      const title = t.title || '';
      const n = pad2(i + 1);
      const f = t.file || '';
      let kind = FK_LITERAL;
      if (f === `${n} - ${title}.mp3`) kind = FK_DASH;
      else if (f === `${n} ${title}.mp3`) kind = FK_PLAIN;

      tT.push(title);
      tK.push(kind);
      tF.push(kind === FK_LITERAL ? f : '');
      tD.push(t.duration || 0);
      // Track artist is usually just the album artist; store only the exceptions.
      tR.push(!t.artists || t.artists === a.artist ? '' : t.artists);
      // 0 means "the source had no track number". It must NOT mean "sequential":
      // the player numbers un-numbered tracks from their position after it
      // dedupes duplicates, so a number invented here would shift every track
      // after a duplicate. Real numbers are 1-based, so 0 is a free marker.
      tN.push(t.num == null ? 0 : t.num);
    });
  }

  return {
    meta: db.meta,
    v: 2,
    a: { t: aT, r: aR, y: aY, p: aP, c: aC, n: aN },
    t: { t: tT, f: tF, k: tK, d: tD, r: tR, n: tN },
  };
}

// Mirror of decodeAcervo() in js/acervo-format.js, used for the verify pass.
function decodeV2(d) {
  const a = d.a, t = d.t;
  const albums = [];
  let k = 0;
  for (let i = 0; i < a.t.length; i++) {
    const title = a.t[i], artist = a.r[i], year = a.y[i];
    const tracks = [];
    for (let j = 0; j < a.n[i]; j++, k++) {
      const tt = t.t[k];
      const kind = t.k[k];
      const file = kind === FK_DASH ? `${pad2(j + 1)} - ${tt}.mp3`
                 : kind === FK_PLAIN ? `${pad2(j + 1)} ${tt}.mp3`
                 : t.f[k];
      const track = { title: tt, file, artists: t.r[k] || artist, duration: t.d[k] };
      if (t.n[k]) track.num = t.n[k];
      tracks.push(track);
    }
    albums.push({ title, artist, year, path: a.p[i] || `${year} - ${artist} - ${title}`, has_cover: a.c[i] === 1, tracks });
  }
  return { meta: d.meta, albums };
}

// Compare only the fields the player actually consumes, normalized the way it
// normalizes them (absent has_cover means true, an absent track artist falls
// back to the album artist). `num` is deliberately NOT filled in here: whether
// it is absent changes how the player numbers tracks, so the check has to be
// able to see the difference.
function fingerprint(db) {
  return JSON.stringify(
    [...db.albums]
      .map(a => ({
        title: a.title,
        artist: a.artist,
        year: a.year || 0,
        path: a.path,
        has_cover: a.has_cover !== false,
        tracks: a.tracks.map(t => ({
          title: t.title || '',
          num: t.num ?? null,
          file: t.file || '',
          artists: t.artists || a.artist,
          duration: t.duration || 0,
        })),
      }))
      .sort((x, y) => x.path.localeCompare(y.path))
  );
}

const args = process.argv.slice(2).filter(x => x !== '--verify');
const input = args[0];
if (!input) {
  console.error('uso: bun script/convert-acervo-v2.js <entrada.json.gz> [saida.json.gz]');
  process.exit(1);
}
const output = args[1] || input;

const rawIn = Buffer.from(await Bun.file(input).arrayBuffer());
// Bun.gunzipSync returns a Uint8Array — .toString() on that yields comma-joined
// byte values, not text. Decode explicitly.
const decodeUtf8 = u8 => new TextDecoder().decode(u8);
const inflatedIn = decodeUtf8(Bun.gunzipSync(rawIn));
const v1 = JSON.parse(inflatedIn);
if (v1.v === 2) {
  console.error(`${input} já está no formato v2 — nada a fazer.`);
  process.exit(0);
}

const v2 = encodeV2(v1);

const before = fingerprint(v1);
const after = fingerprint(decodeV2(v2));
if (before !== after) {
  console.error('ERRO: round-trip divergiu — nada foi escrito.');
  process.exit(1);
}

const json = JSON.stringify(v2);
const gzOut = Bun.gzipSync(Buffer.from(json), { level: 9 });
await Bun.write(output, gzOut);

const pct = (a, b) => (100 - (100 * b) / a).toFixed(1);
console.log(`${input} → ${output}`);
console.log(`  álbuns    ${v1.albums.length}`);
console.log(`  transfer  ${(rawIn.length / 1024).toFixed(0)} KB → ${(gzOut.length / 1024).toFixed(0)} KB  (-${pct(rawIn.length, gzOut.length)}%)`);
console.log(`  parse     ${(inflatedIn.length / 1e6).toFixed(2)} MB → ${(json.length / 1e6).toFixed(2)} MB  (-${pct(inflatedIn.length, json.length)}%)`);
console.log('  round-trip verificado ✓');
