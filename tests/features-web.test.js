import { test, expect, describe } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { gunzipSync } from 'zlib';
import { encodeFeatures, catalogKeys, loadRows, CATALOGS } from '../script/build-features-web.js';

const ROOT = path.join(import.meta.dir, '..');
const { decodeFeatures, featuresFingerprint } = new Function(
  fs.readFileSync(path.join(ROOT, 'js/acervo-features.js'), 'utf8') + '\nreturn { decodeFeatures, featuresFingerprint };')();

const row = (k, o = {}) => ({
  k, bpm: 109.8, bpm_conf: 1.31, key: 'Eb', scale: 'minor', loud_db: -16.4,
  voice: 0.833, dance: 0.792, acoustic: 0.495, electronic: 0.077, happy: 0.531, sad: 0.322, relaxed: 0.779, aggressive: 0.011, party: 0.549,
  genre: [['Latin---Samba', 0.3972], ['Latin---Batucada', 0.289], ['Latin---Bolero', 0.2695], ['Latin---Porro', 0.1777]],
  inst: [['drums', 0.3661], ['bass', 0.1604], ['electricguitar', 0.1133]], ...o,
});

describe('encode → decode (sintético)', () => {
  const keys = ['a/1.mp3', 'a/2.mp3', 'b/1.mp3', 'b/2.mp3'];
  const rows = new Map([
    [keys[0], row(keys[0])],
    [keys[1], row(keys[1], { bpm: 480, key: 'F#', scale: 'major' })],          // bpm fora de 30–300: vira "sem análise"
    [keys[3], row(keys[3], { bpm: 60.4, genre: [['Rock---Punk', 0.9]], inst: [] })],
  ]);
  const { payload, stats } = encodeFeatures({ acervo: 'teste', keys, rows });
  const f = decodeFeatures(JSON.parse(JSON.stringify(payload)), keys);        // passa por JSON como na rede

  test('estatísticas e presença', () => {
    expect(stats).toEqual({ sem_analise: 1, bpm_fora: 1 });
    expect([0, 1, 2, 3].map(i => f.has(i))).toEqual([true, false, false, true]);
  });

  test('valores preservados dentro da quantização', () => {
    expect(f.bpm[0]).toBe(110);
    expect(f.bpmConf[0] / 40).toBeCloseTo(1.31, 1);
    expect(f.key(0)).toEqual({ key: 'Eb', scale: 'minor' });
    expect(-f.loud[0]).toBe(-16);
    expect(f.voice[0] / 255).toBeCloseTo(0.833, 2);
    expect(f.aggressive[0] / 255).toBeCloseTo(0.011, 2);
    expect(f.bpm[3]).toBe(60);
  });

  test('top-3 de gênero e instrumentos, com tabela local', () => {
    expect(f.genre(0).map(g => g.name)).toEqual(['Latin---Samba', 'Latin---Batucada', 'Latin---Bolero']);
    expect(f.genre(0)[0].p).toBeCloseTo(0.397, 2);
    expect(f.genre(3)).toEqual([{ name: 'Rock---Punk', p: 0.9 }].map(x => ({ ...x, p: expect.closeTo(0.9, 2) })));
    expect(f.instruments(0)).toEqual(['drums', 'bass', 'electricguitar']);
    expect(f.instruments(3)).toEqual([]);
    expect(f.genre(1)).toEqual([]);
  });

  test('catálogo trocado é detectado, não aceito', () => {
    expect(() => decodeFeatures(payload, keys.slice(0, 3))).toThrow('FEATURES_CATALOG_MISMATCH');
    expect(() => decodeFeatures(payload, [...keys.slice(0, 3), 'b/outra.mp3'])).toThrow('FEATURES_CATALOG_MISMATCH');
  });

  test('versão desconhecida falha alto', () => {
    expect(() => decodeFeatures({ ...payload, v: 99 })).toThrow('UNSUPPORTED_FEATURES_VERSION');
  });

  test('impressão digital depende da ordem', () => {
    expect(featuresFingerprint(['a', 'b'])).not.toBe(featuresFingerprint(['b', 'a']));
  });
});

// ── dados reais: só roda onde os arquivos gerados existem (data/features é ignorado pelo git) ──────────────
const decodeAcervo = new Function(fs.readFileSync(path.join(ROOT, 'js/acervo-format.js'), 'utf8') + '\nreturn decodeAcervo;')();
for (const acervo of ['homi', 'uqt']) {
  const gz = path.join(ROOT, `data/features/${acervo}-features.json.gz`);
  const cat = path.join(ROOT, CATALOGS[acervo]);
  describe.skipIf(!fs.existsSync(gz) || !fs.existsSync(cat))(`${acervo}: arquivo gerado`, () => {
    const db = decodeAcervo(JSON.parse(gunzipSync(fs.readFileSync(cat)).toString('utf8')));
    const keys = catalogKeys(db);
    const f = decodeFeatures(JSON.parse(gunzipSync(fs.readFileSync(gz)).toString('utf8')), keys);   // lança se o catálogo mudou

    test('tamanho no orçamento (≤ 1,5 MB gz por acervo; 3 MB nos dois)', () => {
      expect(fs.statSync(gz).size).toBeLessThan(1.5 * 1024 * 1024);
    });

    test('quase toda faixa do catálogo tem análise e valores plausíveis', () => {
      let ok = 0;
      for (let i = 0; i < f.n; i++) {
        if (!f.has(i)) continue;
        ok++;
        if (f.bpm[i] < 30 || f.bpm[i] > 300) throw new Error(`bpm ${f.bpm[i]} na faixa ${i}`);
      }
      expect(ok / f.n).toBeGreaterThan(0.99);
    });

    test('a faixa decodificada bate com a linha original do jsonl', () => {
      const jsonl = path.join(ROOT, `data/features/${acervo}.jsonl`);
      const { rows } = loadRows(jsonl, null);
      let checked = 0;
      for (let i = 0; i < f.n && checked < 300; i += 97) {
        const r = rows.get(keys[i]);
        if (!r || !f.has(i)) continue;
        expect(f.bpm[i]).toBe(Math.round(r.bpm));
        expect(f.voice[i] / 255).toBeCloseTo(r.voice, 2);
        expect(f.genre(i)[0].name).toBe(r.genre[0][0]);
        expect(f.key(i)?.key).toBe(r.key);
        checked++;
      }
      expect(checked).toBeGreaterThan(50);
    });
  });
}
