// Gera os arquivos da página /atlas para tests/atlas.spec.js, sem rede e sem o payload real:
//   atlas-uqt.json.gz, atlas-homi.json.gz  catálogos v1 pequenos
//   atlas-faixas-teste.json.gz             payload gerado por buildAtlas() com coordenadas sintéticas (os dois mapas em 3D: x, y, z)
//   atlas-faixas-2d.json.gz                o mesmo com os dois mapas só em x, y (payload antigo, sem somz/rotulosz)
// Casos que o conjunto cobre:
//   - "Primeiro": o título "Beta" aparece duas vezes, uma cópia em subpasta (file com "/"), e "Gama" não tem num;
//   - "Recente" está no catálogo mas fora das coordenadas (álbum adicionado depois do payload);
//   - o álbum do homi com HTML no título de uma faixa (segurança).
// Uso: bun tests/fixtures/build-atlas-fixture.js
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { buildAtlas } from '../../script/build-atlas-web.js';
import { catalogKeys } from '../../script/build-features-web.js';

const dir = new URL('.', import.meta.url).pathname;
const tr = (title, file, num, artists) => ({ title, file, ...(num != null ? { num } : {}), ...(artists ? { artists } : {}), duration: 100 });

const uqt = { meta: { title: 'UQT teste', base_url: 'https://cdn.tocador.cc/uqt' }, albums: [
  { title: 'Primeiro', artist: 'Joãozinho Samba', year: 1975, path: '1975 - Joãozinho Samba - Primeiro', has_cover: false, tracks: [
    tr('Alfa', '01 Alfa.mp3', 1),
    tr('Beta', 'CD1/02 Beta.mp3'),        // cópia em subpasta: perde para a de baixo
    tr('Beta', '02 Beta.mp3'),
    tr('Gama', '03 Gama.mp3'),            // sem num: vale a posição depois da deduplicação (3, não 4)
  ] },
  { title: 'Segundo', artist: 'Banda Dois', year: 1980, path: '1980 - Banda Dois - Segundo', has_cover: false, tracks: [
    tr('Um', '01 Um.mp3', 1), tr('Dois', '02 Dois.mp3', 2),
  ] },
  { title: 'Recente', artist: 'Artista Novo', year: 2020, path: '2020 - Artista Novo - Recente', has_cover: false, tracks: [
    tr('Fresca', '01 Fresca.mp3', 1), tr('Nova', '02 Nova.mp3', 2),
  ] },
] };
const homi = { meta: { title: 'Homi teste', base_url: 'https://cdn.tocador.cc/indie' }, albums: [
  { title: 'Barulho', artist: 'Os Punks', year: 2010, path: '2010 - Os Punks - Barulho', has_cover: false, tracks: [
    tr('Grito', '01 Grito.mp3', 1), tr('Muro', '02 Muro.mp3', 2), tr('Fuga', '03 Fuga.mp3', 3),
  ] },
  { title: 'Máquinas', artist: 'Sintético', year: 2015, path: '2015 - Sintético - Máquinas', has_cover: false, tracks: [
    tr('Pulso', '01 Pulso.mp3', 1), tr('Loop', '02 Loop.mp3', 2),
  ] },
  { title: 'Perigo', artist: 'Zé Injeção', year: 2012, path: '2012 - Zé Injeção - Perigo', has_cover: false, tracks: [
    tr('<img src=x onerror="window.__xss=1">', '01 Perigo.mp3', 1),
  ] },
] };

const generos = { uqt: ['Latin---Samba'], homi: ['Rock---Punk', 'Electronic---Techno', 'Rock---Punk'] };
// Coordenadas: uma grade bem espaçada, para que um clique centralizado acerte só um ponto.
function coordsDe(acervo, db, foraDoPayload = [], z3d = true) {
  const keys = [], genre = [], som = [], rotulos = [];
  let n = acervo === 'homi' ? 20 : 0;   // acervos em faixas separadas da grade, sem pontos empilhados
  db.albums.forEach((a, ai) => {
    if (foraDoPayload.includes(a.path)) return;
    a.tracks.forEach(t => {
      keys.push(`${a.path}/${t.file}`.normalize('NFC'));
      genre.push(generos[acervo][ai % generos[acervo].length]);
      som.push(z3d ? [(n % 5) * 10, Math.floor(n / 5) * 10, ((n * 7) % 4) * 10] : [(n % 5) * 10, Math.floor(n / 5) * 10]);
      rotulos.push(z3d ? [Math.floor(n / 5) * 10 + 3, (n % 5) * 10 + 7, ((n * 5) % 4) * 10] : [Math.floor(n / 5) * 10 + 3, (n % 5) * 10 + 7]);
      n++;
    });
  });
  return { keys, genre, som, rotulos };
}
const coords = { mapas: ['som', 'rotulos'], acervos: {
  uqt: coordsDe('uqt', uqt, ['2020 - Artista Novo - Recente']),
  homi: coordsDe('homi', homi),
} };
const catalogos = { uqt: catalogKeys(uqt), homi: catalogKeys(homi) };
const { payload } = buildAtlas(coords, catalogos);
// Payload 2D antigo (sem somz): o mapa "som" com só x, y.
const coords2d = { mapas: coords.mapas, acervos: {
  uqt: coordsDe('uqt', uqt, ['2020 - Artista Novo - Recente'], false),
  homi: coordsDe('homi', homi, [], false),
} };
const { payload: payload2d } = buildAtlas(coords2d, catalogos);

const gz = o => gzipSync(Buffer.from(JSON.stringify(o)));
writeFileSync(dir + 'atlas-uqt.json.gz', gz(uqt));
writeFileSync(dir + 'atlas-homi.json.gz', gz(homi));
writeFileSync(dir + 'atlas-faixas-teste.json.gz', gz(payload));
writeFileSync(dir + 'atlas-faixas-2d.json.gz', gz(payload2d));
console.log(`atlas: ${payload.n} pontos, ${payload.generos.join(', ')}`);
