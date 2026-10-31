#!/usr/bin/env bun
// export-faixas-artistas.js — prints {"uqt": {"<album path>/<file>": ["Artista", …]}, "homi": …} from the
// published catalogs, for script/build-artistas-parecidos.py. Keys are NFC, like the audio analysis, and
// artists go through parseArtists() so a graph node is the same artist the player's browse panel lists.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOGS } from './build-features-web.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const decodeAcervo = new Function(readFileSync(join(ROOT, 'js/acervo-format.js'), 'utf8') + '\nreturn decodeAcervo;')();
const parseArtists = new Function(readFileSync(join(ROOT, 'js/util.js'), 'utf8') + '\nreturn parseArtists;')();

const out = {};
for (const [acervo, path] of Object.entries(CATALOGS)) {
  const db = decodeAcervo(JSON.parse(gunzipSync(readFileSync(join(ROOT, path))).toString('utf8')));
  const m = out[acervo] = {};
  for (const a of db.albums) {
    for (const t of a.tracks) {
      const nomes = parseArtists(t.artists || a.artist);
      if (nomes.length) m[`${a.path}/${t.file}`.normalize('NFC')] = nomes;
    }
  }
}
process.stdout.write(JSON.stringify(out));
