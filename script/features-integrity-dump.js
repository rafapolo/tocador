// Dumps every catalog track as {k: "<album path>/<file>", album, artist, year, title, num} using the player's own decodeAcervo(),
// so the key is exactly what the player builds audio URLs from. Used by script/check-features.py.
import { gunzipSync } from 'zlib';
import { readFileSync, writeFileSync } from 'fs';
const src = readFileSync(new URL('../js/acervo-format.js', import.meta.url), 'utf8');
const decodeAcervo = new Function(src + '\nreturn decodeAcervo;')();
for (const [alias, path] of [['homi', '../hominiscanidae/data/homi-albums.json.gz'], ['uqt', '../uqt/data/uqt-albums.json.gz']]) {
  const db = decodeAcervo(JSON.parse(gunzipSync(readFileSync(new URL('../' + path, import.meta.url))).toString('utf8')));
  const out = [];
  for (const a of db.albums) for (const t of a.tracks) out.push({ k: `${a.path}/${t.file}`, album: a.path, artist: a.artist, year: a.year, title: t.title, num: t.num ?? null, dur: t.duration ?? null });
  writeFileSync(new URL(`../data/features/catalog-${alias}.json`, import.meta.url), JSON.stringify(out));
  console.log(alias, db.albums.length, 'álbuns', out.length, 'faixas');
}
