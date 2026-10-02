// Builds tests/fixtures/cenarios-albums.json.gz + cenarios-features.json.gz: a 13-album catalogue designed so each of the
// 12 chat scenarios (tests/chat-cenarios.spec.js) has one right answer. Run with `bun tests/fixtures/build-cenarios.js`.
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { encodeFeatures, catalogKeys } from '../../script/build-features-web.js';

const dir = import.meta.dir;
const base = { bpm: 100, bpm_conf: 3, key: 'C', scale: 'major', loud_db: -12, voice: 0.8, dance: 0.3, acoustic: 0.7, electronic: 0.05,
  happy: 0.3, sad: 0.3, relaxed: 0.4, aggressive: 0.02, party: 0.1, genre: [['Latin---Samba', 0.5]], inst: [['acousticguitar', 0.6], ['percussion', 0.3]] };

// [title, artist, year, features]
const A = [
  ['Samba Devagar', 'Nelson Sargento', 1962, { bpm: 66, relaxed: 0.5 }],
  ['Samba Animado', 'Zeca da Casa', 1965, { bpm: 138, dance: 0.8, happy: 0.7 }],
  ['Choro das Tardes', 'Regional do Largo', 1974, { bpm: 96, voice: 0.05, genre: [['Latin---Samba', 0.1]], inst: [['acousticguitar', 0.6], ['flute', 0.4]] }],
  ['Forró Dançante Show', 'Trio Pé de Serra', 1992, { bpm: 118, dance: 0.95, happy: 0.7, genre: [['Latin---Forró', 0.8]], inst: [['accordion', 0.7], ['percussion', 0.5]] }],
  ['Forró de Domingo', 'Os Sanfoneiros', 1995, { bpm: 90, dance: 0.2, relaxed: 0.8, genre: [['Latin---Forró', 0.8]], inst: [['accordion', 0.7]] }],
  ['São João do Sertão', 'Quadrilha Junina', 1988, { bpm: 124, dance: 0.8, genre: [['Latin---Forró', 0.6]], inst: [['accordion', 0.7]] }],
  ['Cartola', 'Cartola', 1974, { bpm: 92, sad: 0.5 }],
  ['Garagem Suja', 'Os Barulhentos', 1980, { bpm: 165, voice: 0.5, aggressive: 0.95, relaxed: 0.05, acoustic: 0.05, happy: 0.3, sad: 0.2, genre: [['Rock---Heavy Metal', 0.7]], inst: [['electricguitar', 0.7], ['drums', 0.6], ['bass', 0.4]] }],
  ['Piano Solo', 'Maria do Piano', 2001, { bpm: 80, voice: 0.05, relaxed: 0.9, genre: [['Classical---Modern', 0.5]], inst: [['piano', 0.9]] }],
  ['Quarteto de Cordas', 'Quarteto Nova', 2003, { bpm: 72, voice: 0.03, relaxed: 0.9, genre: [['Classical---Modern', 0.5]], inst: [['strings', 0.9], ['violin', 0.5]] }],
  ['Banda Instrumental', 'Os Eletricos', 1999, { bpm: 140, voice: 0.1, aggressive: 0.5, relaxed: 0.1, genre: [['Rock---Prog Rock', 0.6]], inst: [['drums', 0.7], ['bass', 0.6], ['electricguitar', 0.6]] }],
  ['Noites Tristes', 'Dolores Antiga', 1985, { bpm: 70, sad: 0.95, happy: 0.05, relaxed: 0.7, genre: [['Latin---Bolero', 0.6]] }],
  // detector pouco confiável (bpm_conf 1) e só a 1ª faixa analisada: o "por quê?" conta as duas coisas (tests/chat-cenarios.spec.js)
  ['Samba Incerto', 'Dupla da Esquina', 1996, { bpm: 70, bpm_conf: 1, soPrimeira: true }],
  ['Cantiga para Dormir', 'Vó Lalá', 1977, { bpm: 60, relaxed: 0.97, aggressive: 0.01, happy: 0.3, sad: 0.3, acoustic: 0.9, genre: [['Folk, World, & Country---Folk', 0.5]] }],
];

const album = ([title, artist, year]) => ({
  title, artist, year, path: `${year} - ${artist} - ${title}`, has_cover: false,
  tracks: [1, 2].map(n => ({ title: `Faixa ${n}`, num: n, file: `0${n} Faixa ${n}.mp3`, duration: 200 })),
});
const db = { meta: { title: 'Cenários', base_url: 'https://cdn.test/x' }, albums: A.map(album) };
const keys = catalogKeys(db);
const rows = new Map();
A.forEach(([, , , f], i) => db.albums[i].tracks.forEach((t, ti) => {
  if (f.soPrimeira && ti > 0) return;
  const k = `${db.albums[i].path}/${t.file}`.normalize('NFC');
  const { soPrimeira, ...feat } = f;
  rows.set(k, { k, ...base, ...feat });
}));
const { payload } = encodeFeatures({ acervo: 'cenarios', keys, rows });
fs.writeFileSync(path.join(dir, 'cenarios-albums.json.gz'), gzipSync(JSON.stringify(db)));
fs.writeFileSync(path.join(dir, 'cenarios-features.json.gz'), gzipSync(JSON.stringify(payload)));
console.log(`cenários: ${db.albums.length} álbuns, ${keys.length} faixas`);

// ── features for the small fixture catalogue (tests/fixtures/albums.json.gz), used by tests/chat-mensagens.spec.js (CHAT_FASE=m2) ──
const fx = JSON.parse(gunzipSync(fs.readFileSync(path.join(dir, 'albums.json.gz'))).toString('utf8'));   // the file the specs actually serve
const fxKeys = catalogKeys(fx);
const fxRows = new Map();
let n = 0;
for (const a of fx.albums) {
  const i = n++;
  for (const t of a.tracks) {
    const k = `${a.path}/${t.file}`.normalize('NFC');
    fxRows.set(k, { k, ...base, bpm: 62 + ((i * 23) % 100), dance: ((i * 37) % 100) / 100, sad: ((i * 53) % 100) / 100, happy: ((i * 29) % 100) / 100,
      relaxed: 0.3 + ((i * 17) % 70) / 100, aggressive: ((i * 11) % 60) / 100, voice: i % 4 === 3 ? 0.1 : 0.8,
      genre: [[i % 3 === 0 ? 'Latin---MPB' : i % 3 === 1 ? 'Latin---Samba' : 'Jazz---Bossa Nova', 0.5]] });
  }
}
fs.writeFileSync(path.join(dir, 'albums-features.json.gz'), gzipSync(JSON.stringify(encodeFeatures({ acervo: 'fixture', keys: fxKeys, rows: fxRows }).payload)));
console.log(`fixture: ${fx.albums.length} álbuns, ${fxKeys.length} faixas`);
