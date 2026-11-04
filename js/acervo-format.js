// Acervo payload format — shared by index.html, radio.html, 3d.html and atlas.html,
// plus gunzipText(), the one .json.gz decompressor they all use (see the end).
//
// v1 (original) is a plain array of album objects, each carrying its own tracks.
// v2 is the same data transposed into columns: one array per field, with the
// track arrays flattened across all albums and sliced back apart via `a.n`.
// Two things motivate v2:
//
//   * Parse cost. Repeating the key names 46k times is ~40% of the raw bytes.
//     Dropping them cuts what JSON.parse has to chew through by ~38%, which is
//     main-thread time on every cold load.
//   * Derivable fields. `path` is exactly "<year> - <artist> - <title>" for the
//     large majority of albums, and many filenames are "NN - <title>.mp3", so
//     both can be reconstructed instead of stored.
//
// Transfer size moves much less than raw size — gzip already collapses the
// repeated keys — so v2 is primarily a parse-time win, plus a real transfer win
// on archives with many albums per artist.
//
// decodeAcervo() accepts either version and always returns the v1 shape, so
// every downstream consumer is unchanged and third-party acervos keep working.

(function (global) {
  'use strict';

  // How a track's filename relates to its title. A parallel int array beats an
  // in-band sentinel string: no filename can ever be mistaken for a marker.
  var FK_LITERAL = 0; // stored verbatim in t.f
  var FK_DASH = 1;    // "NN - <title>.mp3"
  var FK_PLAIN = 2;   // "NN <title>.mp3"

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function decodeV2(d) {
    var a = d.a, t = d.t;
    var count = a.t.length;
    var albums = new Array(count);
    var k = 0;
    for (var i = 0; i < count; i++) {
      var title = a.t[i], artist = a.r[i], year = a.y[i];
      var n = a.n[i];
      var tracks = new Array(n);
      for (var j = 0; j < n; j++, k++) {
        var tt = t.t[k];
        var kind = t.k[k];
        var file = kind === FK_DASH ? pad2(j + 1) + ' - ' + tt + '.mp3'
                 : kind === FK_PLAIN ? pad2(j + 1) + ' ' + tt + '.mp3'
                 : t.f[k];
        var track = {
          title: tt,
          file: file,
          artists: t.r[k] || artist,
          duration: t.d[k],
        };
        // 0 means the source had no track number at all. That must stay absent:
        // the player numbers un-numbered tracks by their position *after* it
        // dedupes, so materialising a number here would shift every track that
        // follows a duplicate.
        if (t.n[k]) track.num = t.n[k];
        tracks[j] = track;
      }
      albums[i] = {
        title: title,
        artist: artist,
        year: year,
        // Empty means "matches the conventional folder name" — rebuild it.
        path: a.p[i] || (year + ' - ' + artist + ' - ' + title),
        has_cover: a.c[i] === 1,
        tracks: tracks,
      };
    }
    return { meta: d.meta, albums: albums };
  }

  // Returns the v1 shape regardless of input version.
  function decodeAcervo(db) {
    // A catalog newer than this decoder must fail loudly: guessing at an unknown
    // layout renders an empty grid that looks like a broken archive.
    if (db && db.v > 2) {
      var err = new Error('Unsupported acervo payload version ' + db.v);
      err.code = 'UNSUPPORTED_ACERVO_VERSION';
      throw err;
    }
    if (!db || db.v !== 2) return db;
    return decodeV2(db);
  }

  // URL slug for each album's static page (/<acervo>/<slug>/), built at deploy by
  // script/build-album-pages.js. The player computes the same slugs to point its
  // canonical and share links there, so both must go through this one function.
  // Takes the whole album list because distinct paths can fold to the same slug
  // ("Chuva - Chuva" / "Chuva Chuva"): later ones, in catalog order, get -2, -3...
  function slugify(s, vazio) {
    return String(s)
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 90)
      .replace(/-+$/, '') || vazio || 'album';
  }

  function albumSlugs(albums) {
    var used = Object.create(null);
    return albums.map(function (album) {
      var base = slugify(album.path);
      var slug = base;
      for (var i = 2; used[slug]; i++) slug = base + '-' + i;
      used[slug] = true;
      return slug;
    });
  }

  // Five base62 characters identifying an album in a shared playlist link (?lista=). Hashes the path, the key the
  // saved albums already use, so a link survives anything that reorders the catalog; an index would not. Fixed width,
  // so ids are concatenated without a separator. FNV-1a over UTF-16 code units, like atlasKeyHash().
  var BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  function albumShareId(path) {
    var s = String(path).normalize('NFC'), h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    var v = (h >>> 0) % 916132832, id = '';   // 62^5
    for (var n = 0; n < 5; n++) { id = BASE62[v % 62] + id; v = Math.floor(v / 62); }
    return id;
  }

  // fold(artist) -> slug of the artist's page, /<alias>/artista/<slug>/. Takes the raw catalog albums, and the
  // player's own parseArtists()/fold() from js/util.js, so the builder and the player can't list different artists.
  // Slugs follow the order of first appearance in the catalog, so a collision depends only on that order.
  function artistSlugs(albums, parseArtists, fold) {
    var used = Object.create(null), out = new Map();
    function add(name) {
      var key = fold(name);
      if (!key || out.has(key)) return;
      var base = slugify(name, 'artista'), slug = base;
      for (var i = 2; used[slug]; i++) slug = base + '-' + i;
      used[slug] = true;
      out.set(key, slug);
    }
    albums.forEach(function (album) {
      parseArtists(album.artist).forEach(add);
      (album.tracks || []).forEach(function (t) {
        if (t.artists) parseArtists(t.artists.replace(/\x00/g, '; ')).forEach(add);
      });
    });
    return out;
  }

  // gunzipText(src) → Promise<string>: src is a fetch Response or the bytes of a .json.gz.
  // Every page decompresses its catalogs through here. Browsers without
  // DecompressionStream (iOS < 16.4, Firefox < 113, Chrome < 80; iPhones stuck on iOS 15
  // are common in Brazil) load js/fflate-gunzip.js (~5 KB) once, from next to this file.
  // Bytes that aren't gzip pass through as text: some servers decode a .gz on the way.
  var SELF_URL = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || '';
  var _fflate = null;
  function loadFflate() {
    if (global.fflate) return Promise.resolve(global.fflate);
    if (!_fflate) {
      _fflate = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = new URL('fflate-gunzip.js', SELF_URL || document.baseURI).href;
        s.onload = function () { global.fflate ? resolve(global.fflate) : reject(new Error('fflate não carregou')); };
        s.onerror = function () { _fflate = null; reject(new Error('não foi possível carregar fflate-gunzip.js')); };
        document.head.appendChild(s);
      });
    }
    return _fflate;
  }
  function gunzipText(src) {
    var isResp = typeof Response !== 'undefined' && src instanceof Response;
    if (isResp && typeof DecompressionStream !== 'undefined') {
      return new Response(src.body.pipeThrough(new DecompressionStream('gzip'))).text();
    }
    return Promise.resolve(isResp ? src.arrayBuffer() : src).then(function (buf) {
      var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return new TextDecoder().decode(bytes);
      if (typeof DecompressionStream !== 'undefined') {
        return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
      }
      return loadFflate().then(function (f) { return new TextDecoder().decode(f.gunzipSync(bytes)); });
    });
  }

  // The number each (already de-duplicated) track gets in the player and in `#tN` links: the
  // catalog's own number, or its position when the source had none. An album whose numbers repeat
  // (two numbering schemes mixed in one folder: "02 peba" and "02. Artista - Faixa") is numbered by
  // position instead, so `#tN` names exactly one track.
  function playerTrackNums(tracks) {
    var nums = tracks.map(function (t, i) { return t.num != null ? t.num : i + 1; });
    if (new Set(nums).size === nums.length) return nums;
    return tracks.map(function (_, i) { return i + 1; });
  }

  global.playerTrackNums = playerTrackNums;
  global.gunzipText = gunzipText;
  global.decodeAcervo = decodeAcervo;
  global.albumSlugs = albumSlugs;
  global.artistSlugs = artistSlugs;
  global.albumShareId = albumShareId;
})(typeof globalThis !== 'undefined' ? globalThis : window);
