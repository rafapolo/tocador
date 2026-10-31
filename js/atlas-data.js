// Atlas payload (data/atlas-faixas.json.gz, built by script/build-atlas-web.js) — shared by the builder
// and atlas.html. Classic script: defines globals in the browser, and the builder evals it.
//
// Points are not in catalog order: each carries a 32-bit hash of its catalog key ("<album path>/<file>",
// NFC), so the page matches them to whatever catalog it loads. An ETL that adds or reorders albums
// leaves the old points findable; new tracks simply have no point until the next build.
(function (global) {
  'use strict';

  var ATLAS_FORMAT = 1;

  // FNV-1a over UTF-16 code units — the same walk as featuresFingerprint(), one key at a time.
  function atlasKeyHash(key) {
    var h = 0x811c9dc5;
    for (var i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }

  function b64bytes(s) {
    var bin = atob(s), u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  // Little-endian typed views; a fresh buffer keeps them aligned.
  function view(Type, s) { var u8 = b64bytes(s); return new Type(u8.buffer, 0, u8.length / Type.BYTES_PER_ELEMENT); }

  function decodeAtlas(p) {
    if (!p || p.v !== ATLAS_FORMAT) {
      var err = new Error('formato do atlas não suportado: ' + (p && p.v));
      err.code = 'UNSUPPORTED_ATLAS_VERSION';
      throw err;
    }
    var pos = {}, posZ = {};
    p.mapas.forEach(function (m) {
      pos[m] = view(Uint16Array, p.c[m]);
      if (p.c[m + 'z']) posZ[m] = view(Uint16Array, p.c[m + 'z']);   // 3D maps: z on the same scale as x, y
    });
    return {
      n: p.n, mapas: p.mapas, acervos: p.acervos, generos: p.generos, marcos: p.marcos,
      acervo: b64bytes(p.c.a), hash: view(Uint32Array, p.c.h), genero: view(Uint16Array, p.c.g), pos: pos, posZ: posZ,
    };
  }

  // Same rule as chave() in script/build-artistas-parecidos.py: "alcione" = "Alcione", "BK" = "BK'",
  // and a "(part: …)" credit doesn't make a new artist.
  function chaveArtista(nome) {
    return String(nome).replace(/(?:\s*\((?:part|feat|ft|com)\b|\s+(?:part|feat|ft)\.?\s).*$/i, '').normalize('NFD')
      .replace(/\p{Mn}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  }

  // data/atlas-artistas.json.gz: nomes sorted by track count; viz[mapa] holds k neighbour indices per artist.
  function decodeArtistas(p) {
    if (!p || p.v !== 1) {
      var err = new Error('formato do grafo não suportado: ' + (p && p.v));
      err.code = 'UNSUPPORTED_ARTISTAS_VERSION';
      throw err;
    }
    var chaves = p.nomes.map(chaveArtista), indice = new Map(), viz = {};
    chaves.forEach(function (c, i) { indice.set(c, i); });
    Object.keys(p.viz).forEach(function (m) { viz[m] = view(Uint16Array, p.viz[m]); });
    return {
      n: p.nomes.length, k: p.k, nomes: p.nomes, chaves: chaves, indice: indice, generos: p.generos,
      acervos: p.acervos, faixas: p.faixas, genero: p.genero, acervo: p.acervo, viz: viz,
    };
  }

  global.ATLAS_FORMAT = ATLAS_FORMAT;
  global.chaveArtista = chaveArtista;
  global.decodeArtistas = decodeArtistas;
  global.atlasKeyHash = atlasKeyHash;
  global.decodeAtlas = decodeAtlas;
})(typeof globalThis !== 'undefined' ? globalThis : window);
