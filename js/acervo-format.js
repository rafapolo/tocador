// Acervo payload format — shared by index.html, radio.html and 3d.html.
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
    if (!db || db.v !== 2) return db;
    return decodeV2(db);
  }

  global.decodeAcervo = decodeAcervo;
})(typeof globalThis !== 'undefined' ? globalThis : window);
