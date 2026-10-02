import { test, expect, describe } from 'bun:test';
import fs from 'fs';
import path from 'path';

const ROOT = path.join(import.meta.dir, '..');
const O = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/ontologia-musical.json'), 'utf8'));
// fold() lives in a classic script; take the very same function instead of copying it.
const fold = new Function(fs.readFileSync(path.join(ROOT, 'js/util.js'), 'utf8') + '; return fold;')();

const goldPath = path.join(ROOT, 'data/qgen/gold/gold.jsonl');   // gitignored: skip the coverage checks without it
const gold = fs.existsSync(goldPath)
  ? fs.readFileSync(goldPath, 'utf8').trim().split('\n').map(l => JSON.parse(l).label)
  : null;

const keysOf = it => [it.id, it.nome, ...(it.apelidos || [])].filter(Boolean).map(fold);

describe('gêneros', () => {
  const ids = new Set(O.generos.map(g => g.id));

  test('ids únicos', () => expect(ids.size).toBe(O.generos.length));

  test('todo pai existe', () => {
    for (const g of O.generos) if (g.pai) expect(ids.has(g.pai), `${g.id} -> ${g.pai}`).toBe(true);
  });

  test('sem ciclos', () => {
    const pai = new Map(O.generos.map(g => [g.id, g.pai]));
    for (const id of ids) {
      const seen = new Set();
      for (let x = id; x; x = pai.get(x)) {
        expect(seen.has(x), `ciclo em ${id}`).toBe(false);
        seen.add(x);
      }
    }
  });

  test('nome e apelidos únicos após fold() (um termo, um gênero)', () => {
    const owner = new Map();
    for (const g of O.generos) {
      for (const k of new Set(keysOf(g))) {
        expect(owner.has(k) && owner.get(k) !== g.id, `"${k}" é de ${owner.get(k)} e de ${g.id}`).toBe(false);
        owner.set(k, g.id);
      }
    }
  });

  test('"instrumental" é voz, não gênero', () => {
    expect(O.generos.some(g => g.id === 'instrumental')).toBe(false);
    expect(O.traducoes['música instrumental']).toEqual({ voz: 'instrumental' });
    expect(O.voz.map(v => v.id).sort()).toEqual(['cantada', 'instrumental']);
  });
});

describe('Discogs-400', () => {
  const classes = new Set(O.discogs.classes);
  const genres = new Set(O.generos.map(g => g.id));

  test('400 classes, sem repetição', () => {
    expect(O.discogs.classes.length).toBe(400);
    expect(classes.size).toBe(400);
  });

  test('toda classe está em `mapa` ou em `ignorar`, nunca nas duas', () => {
    for (const c of classes) expect((c in O.discogs.mapa) !== O.discogs.ignorar.includes(c), c).toBe(true);
  });

  test('rótulos do mapa são classes válidas do Discogs e apontam para gêneros que existem, com peso em (0, 1]', () => {
    for (const [c, lst] of Object.entries(O.discogs.mapa)) {
      expect(classes.has(c), c).toBe(true);
      expect(lst.length, c).toBeGreaterThan(0);
      for (const { genero, peso } of lst) {
        expect(genres.has(genero), `${c} -> ${genero}`).toBe(true);
        expect(peso > 0 && peso <= 1, `${c} peso ${peso}`).toBe(true);
      }
    }
    for (const c of O.discogs.ignorar) expect(classes.has(c), c).toBe(true);
  });

  test('o que é do Brasil mapeia para o gênero certo', () => {
    const top = c => O.discogs.mapa[c].slice().sort((a, b) => b.peso - a.peso)[0].genero;
    expect(top('Latin---Samba')).toBe('samba');
    expect(top('Latin---Bossanova')).toBe('bossa nova');
    expect(top('Latin---MPB')).toBe('mpb');
    expect(top('Latin---Forró')).toBe('forró');
    expect(top('Rock---Punk')).toBe('punk');
    expect(top('Rock---Shoegaze')).toBe('shoegaze');
    expect(top('Reggae---Reggae')).toBe('reggae');
  });

  test('não-música (fala, infantil, trilha) não vira gênero', () => {
    for (const c of classes) if (/^(Non-Music|Children's|Stage & Screen)---/.test(c)) expect(c in O.discogs.mapa, c).toBe(false);
  });
});

describe('humores, instrumentos, formações, andamentos', () => {
  test('apelidos únicos após fold() em cada vocabulário', () => {
    for (const nome of ['humores', 'instrumentos', 'formacoes', 'andamentos', 'voz']) {
      const owner = new Map();
      for (const it of O[nome]) {
        for (const k of new Set(keysOf(it))) {
          expect(owner.has(k) && owner.get(k) !== it.id, `${nome}: "${k}" é de ${owner.get(k)} e de ${it.id}`).toBe(false);
          owner.set(k, it.id);
        }
      }
    }
  });

  test('sinais de humor usam só características medidas, com nível válido', () => {
    const feats = new Set(['happy', 'sad', 'relaxed', 'aggressive', 'party', 'dance', 'acoustic', 'electronic', 'voice']);
    for (const h of O.humores) {
      for (const [f, nivel] of Object.entries(h.sinais)) {
        expect(feats.has(f), `${h.id}.${f}`).toBe(true);
        expect(['alto', 'medio', 'baixo']).toContain(nivel);
      }
      expect(h.medido).toBe(Object.keys(h.sinais).length > 0);
    }
  });

  test('instrumentos medidos apontam para classes do modelo de instrumentos', () => {
    const valid = new Set(O.essentia.instrumentos);
    for (const i of O.instrumentos) {
      for (const c of i.essentia) expect(valid.has(c), `${i.id} -> ${c}`).toBe(true);
      expect(i.medido).toBe(i.essentia.length > 0);
    }
  });

  test('andamentos cobrem 0–300 BPM sem buraco nem sobreposição', () => {
    const a = O.andamentos.map(x => x.bpm);
    expect(a[0][0]).toBe(0);
    for (let i = 1; i < a.length; i++) expect(a[i][0]).toBe(a[i - 1][1]);
    expect(a.at(-1)[1]).toBe(300);
  });
});

// ── cobertura contra o gold: quanto do que o rotulador cego escreveu a ontologia resolve? ─────────────────
describe.skipIf(!gold)('cobertura do gold (data/qgen/gold/gold.jsonl)', () => {
  const lookup = items => new Set(items.flatMap(keysOf));
  const cov = (values, set) => {
    const miss = values.filter(v => !set.has(fold(v)));
    return { total: values.length, miss };
  };
  const report = (nome, { total, miss }) => {
    const pct = total ? (100 * (total - miss.length) / total).toFixed(1) : '100.0';
    console.log(`cobertura ${nome}: ${total - miss.length}/${total} (${pct}%)` + (miss.length ? `; sem id: ${[...new Set(miss)].slice(0, 12).join(' | ')}` : ''));
    return total ? (total - miss.length) / total : 1;
  };

  test('gêneros (ignorando "outro: …")', () => {
    const vals = gold.flatMap(l => l.generos || []).filter(g => !g.startsWith('outro:'));
    expect(report('generos', cov(vals, lookup(O.generos)))).toBeGreaterThanOrEqual(0.98);
  });
  test('humores', () => {
    expect(report('humor', cov(gold.flatMap(l => l.humor || []), lookup(O.humores)))).toBeGreaterThanOrEqual(0.98);
  });
  test('instrumentos', () => {
    expect(report('instrumentos', cov(gold.flatMap(l => l.instrumentos || []), lookup(O.instrumentos)))).toBeGreaterThanOrEqual(0.98);
  });
  test('andamentos', () => {
    expect(report('andamento', cov(gold.map(l => l.andamento).filter(Boolean), lookup(O.andamentos)))).toBe(1);
  });
});
