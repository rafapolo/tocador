// Gera albums-features-mistas.json.gz: o mesmo catálogo de albums.json.gz, mas com as faixas de cada álbum
// divergindo (índices pares a 80 bpm, ímpares a 140 bpm). O arquivo padrão tem o mesmo valor em todas as faixas
// de um álbum e não exercita "faixa desativada dentro de um álbum que continua na grade".
// Uso: bun tests/fixtures/build-features-mistas.js
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { encodeFeatures, catalogKeys } from '../../script/build-features-web.js';

const dir = new URL('.', import.meta.url).pathname;
const db = JSON.parse(gunzipSync(readFileSync(dir + 'albums.json.gz')));
const keys = catalogKeys(db);
const rows = new Map(keys.map((k, i) => [k, {
  k, bpm: i % 2 ? 140 : 80, bpm_conf: 2, key: 'C', scale: 'major', loud_db: -15,
  voice: 0.5, dance: 0.5, acoustic: 0.5, electronic: 0.5, happy: 0.5, sad: 0.5, relaxed: 0.5, aggressive: 0.5, party: 0.5,
  genre: [], inst: [],
}]));
const { payload } = encodeFeatures({ acervo: 'teste', keys, rows });
writeFileSync(dir + 'albums-features-mistas.json.gz', gzipSync(Buffer.from(JSON.stringify(payload))));
