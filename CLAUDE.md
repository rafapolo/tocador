# tocador

Shared music player platform — the same player hosts multiple independent archives (acervos). Point it at any compatible `.json.gz` and it plays, with no build step.

## Architecture

### Frontend
- **index.html** — Main web app; no build step, served from GitHub Pages or any static CDN
- **js/ui.js** — Shared state (`let`s), data build, filtering, and the `DOMContentLoaded` init/acervo load
- **js/url-meta.js**, **js/browse.js**, **js/album-view.js**, **js/playback.js** — the rest of the app, split by concern (URL/meta/share, browse panel + shortcuts, decade buttons + album/track rendering, playback). Classic scripts loaded after `ui.js`; they share its global scope, so state stays declared at the top of `ui.js`
- **js/explorar.js**, **js/acervo-features.js** — "Pegada" panel (code name Explorar): the "Pegada" tab in `.browse-tabs` (shortcut `E`) swaps `.browse-panel` for `#explorar-panel` (a drawer on mobile) and filters albums by audio features (tempo, danceability, party, happy/sad/relaxed/aggressive, acoustic/electronic, voice): dual-handle sliders over a histogram of the acervo (dashed line = median), chips, a per-feature ✕, and a sticky top line with the live album/track count (follows the drag; the grid itself swaps after a 160 ms pause, and only then is the count announced through the `#explorar-anuncio` live region). When nothing passes, the panel lists which single filter to drop and how many albums that would bring back. Keyboard: arrows step 1, PageUp/PageDown and Shift+arrow step 10, Delete resets the feature; `aria-valuetext` reads "sem limite"/"120 bpm". Collapsed groups persist in `localStorage` (`tocador-explorar-fechados`); the panel search also matches synonyms (`busca` in `EX_GRUPOS`) and group names. On mobile the panel does not focus its search on open (the virtual keyboard would cover the controls) and the handles grow to 26 px (`--ex-thumb`). The features are per track: a track passes when every slider accepts it, an album stays on the grid when at least one of its tracks passes, and its other tracks are listed disabled (`.filtered-out`, `trackFilter` in `ui.js`; skipped by next/previous/shuffle, not clickable), under a `.track-filter-note` line ("N de M faixas passam…", with a "limpar filtro" button) drawn by `renderTrackFilterNote()` in `album-view.js` for both the desktop list and the mobile drawer. Values come from `<acervo>-features.json.gz` (`decodeFeatures()` in `js/acervo-features.js`, built by `script/build-features-web.js` from `data/features/<acervo>.jsonl`; the key fingerprint rejects a catalog that changed after the build). The result goes to the grid as `activeAlbumSet`, a sixth mutually exclusive facet (the grid side of the filter) in `resetFacets()` (picking a decade/artist/search clears it via `explorarReset()`). The features are fetched from `APP_ROOT/data/` with a `tocador.cc` fallback (mirrors don't copy `data/`); without them the panel says so. `data/resumo-acervo.json` (built by `script/build-resumo-acervo.py`) only feeds the header totals. Tests: `tests/explorar.spec.js` (`tests/fixtures/build-features-mistas.js` makes the mixed-tracks fixture; needs `serviceWorkers: 'block'` for `page.route` to apply)
- **Player extras** — `#btn-play-saved` (heart + play in `.library-stats`, desktop only, as that bar is hidden on mobile) plays the active acervo's saved albums in a row, or mixed with shuffle on (`savedQueue`, `toggleSavedQueue()` in `js/playback.js`); opening an album outside the queue leaves the mode. `.album-generos` (under `#track-list` and `#drawer-track-list`) is a collapsed accordion with the unique genres the audio model saw on the album's tracks; it only fetches the ~1 MB features when opened. A tag opens the browse panel on that genre with its row selected (`abrirGeneroNoBrowse()`, the parent when the tree lacks the sub), and those of the current track turn golden (`syncAlbumGenresTrack()`). The header stats (`#stat-hours` as "N dias/horas/min de ♪", `#mobile-stat-albums`, `#mobile-stat-artists`) count what the grid shows: `updateLibraryStats()` in `js/browse.js` runs at the end of every `filterAlbums()` (and when the async genre track filter lands), sums only tracks that pass a per-track filter, titles them "No filtro atual"/"No acervo inteiro", and with no filter shows the whole acervo. `.album-parecidos` ("Soa parecido com", under `.album-generos` in both places) lists up to 10 sound neighbours of the album's artists from `data/atlas-artistas.json.gz` (the `/atlas` graph's `viz.som`, decoded by `js/atlas-data.js`, which `index.html` now loads), fetched only when opened: an artist in this acervo filters the grid (`abrirArtistaNoBrowse()`), one only in the other acervo opens `?acervo=<other>&artista=` in a new tab. Tests: "header stats and album neighbours" in `tests/uqt.spec.js`. `#share-saved`, at the bottom of the Salvos tab, shares the active acervo's saved albums as `https://tocador.cc/share-playlist?acervo=<alias>&lista=<ids>`: `share-playlist.html` is a static, `noindex` page holding the fixed link preview (no `og:url` or canonical, which would lose the query) that forwards the query to the player. An id is `albumShareId()` in `js/acervo-format.js`, 5 base62 characters hashed from the NFC path, concatenated without a separator; never use catalog indexes, the catalog gets reordered. `?lista=` is a seventh exclusive facet (`sharedAlbums`, not `activeAlbumSet`, which Pegada clears on its own): the grid shows those albums in link order, the chip reads "Playlist (N)", and `tocador-salvos` is never touched. Opening an album keeps `lista` in the URL, any other facet drops it. Tests: "shared playlist link" in `tests/uqt.spec.js`, `tests/album-share-id.test.js` (no id collisions in the real catalogs)
- **js/util.js** — Pure helpers (`fold`, `parseArtists`, `escapeHtml`, `formatTime`, `PT_COLLATOR`). Classic script, loaded before `ui.js`
- **js/virtual-lists.js** — `VirtualGrid` (albums) and `VirtualList` (browse panel). Artist and saved rows carry a mini-cover (`capa-micro.jpg`, 96 px, ~3 KB against ~25 KB, falling back on `capa-min.jpg`), which makes them taller than genre rows. Classic script; calls `ui.js` globals only at run time
- **js/radio.js**, **js/3d.js**, **assets/radio.css**, **assets/3d.css** — the code and styles of `radio.html` / `3d.html`, kept out of the HTML so the service worker can cache them
- **atlas.html**, **js/atlas.js**, **js/atlas-data.js**, **assets/atlas.css**, **assets/atlas-og.jpg** — `/atlas` (GitHub Pages serves `atlas.html` there, like `/3d`): a WebGL 2D map of every uqt + homi track, with zoom/pan (pinch on mobile). Each point is a track placed by UMAP of its audio embedding (map "som") or of its genre labels (map "rotulos"); clicking one opens a card linking to the player. Loads `acervo-format.js`, `util.js`, `atlas-data.js`, `atlas-grafo.js`, `acervo-features.js`, `som-abas.js`, `atlas-receitas.js`, `atlas-som.js`, `atlas.js`, in that order. The payload is `data/atlas-faixas.json.gz` (committed, ~1.4 MB; `decodeAtlas()`/`atlasKeyHash()` in `js/atlas-data.js`), fetched from `APP_ROOT/data/` with a `https://tocador.cc/data/` fallback; the catalogs are the `KNOWN_ACERVOS` URLs. **Points are matched to the catalog by a hash of the track key, never by order**: an ETL that appends or reorders albums (the v2 conversion sorts by artist) keeps the old points, and new tracks have no point until the payload is regenerated. 75 uqt tracks have no point: 74 are 0-byte MP3s already empty in the source backup (four sambas-de-enredo / 1964 albums), one is ~1 s long — see `tasks/uqt-faixas-vazias.md`. The service worker caches the page best-effort (`EXTRAS`); deploy minifies `atlas-data.js`/`atlas.js` as classic scripts. Both maps are 3D (`c.somz`/`c.rotulosz` in the payload → `A.posZ[mapa]`; `__atlas.estado()` has `yaw`, `pitch`, `tem3d` for the current map): on desktop, right-drag or Shift + drag rotates the view; on any device the ⟳ toggle (`#zoom-girar`, hidden for a map without z) makes one-finger/left drag orbit instead of pan (pinch still zooms, a still tap still picks), ⌂ (`#zoom-reset`) animates the rotation back to 0, and picking while rotated is a linear projected search (the grid only serves the flat view). A map without z in the payload stays 2D. Zoomed in ≥10× the fit, the dots nearest the screen center get their track titles (`desenharFaixas()`, as many as fit without overlapping; the subgenre labels step aside). A missing `DecompressionStream` or WebGL is reported in `#carregando-status`. The player has an `#btn-atlas` link next to `#btn-shortcuts`
- **js/atlas-grafo.js** — the "Grafo" view of `/atlas` (`#btn-grafo` next to Som/Gêneros, shortcut `G`, `?grafo=1&artista=<nome>`): an SVG of artists linked to their nearest neighbours, by sound on the "som" map and by genre labels on "rotulos". Centered on an artist it shows the 8 neighbours plus 3 of each; with no center, the overview shows every artist in the payload (those with 3+ tracks) on the `#grafo-tudo` canvas, at the UMAP positions precomputed in the payload (`pos`, optional, `filtrarTudo()`/`montarTudo()`/`pintarTudo()`): SVG can't hold thousands of nodes rewritten per frame and the force layout is quadratic. Names are drawn by priority (most tracks first) on a collision grid, so zooming (up to 16×, `ZOOM_TUDO`) reveals more of them; hovering lights a dot's neighbours and clicking one walks to it, with each node of the neighbourhood rising from its own dot. A payload without `pos` falls back to the old SVG overview: top artists per macro-genre widened through their neighbours, sized to the screen. Clicking a node walks to it: one `requestAnimationFrame` loop eases nodes, links, fades and the pan/zoom together (`DURACAO`, none under reduced motion), the clicked dot ends exactly mid-area, nodes on screen seed the next layout so the scene keeps its shape, newcomers grow out of the clicked dot and a click mid-walk starts from where things are. Opacity falls with distance from the center (`OPACIDADE_NO`/`OPACIDADE_ARESTA`; labels fade less, `TEXTO_MIN`), passed to CSS as `--o`/`--t`. With nothing on screen the layout is deterministic. Every click in `/atlas` (track, close, Som/Gêneros, acervo, legend, Grafo, node, Enter in the search) is a history entry through `salvarUrl(true)`; typing only rewrites the current one, and `popstate` runs `aplicarUrl()`. The URL carries everything needed to rebuild the view (`mapa`, `acervo`, `q`, `off`, `grafo`, `artista`, `faixa=<acervo>.<hash>`), and on the map (not the graph) the camera too: `x`, `y` (world center), `z` (zoom over the whole-map fit) and, when rotated, `giro=yaw°,pitch°,pivot x,y,z`, rewritten with `replaceState` once the view settles (`camAtual()`/`cameraDaUrl()`; the whole-map view writes none). At load the URL camera wins over the selection's own framing. The layout is 3D: dragging rotates the scene around the middle of the graph area (arrow keys too), Shift + drag pans, and the front view is the plain layout, with the perspective fading in over the first degrees of rotation (`projetar()`). A playing preview survives the graph: `abrirGrafo()` keeps `#cartao` open over it (panel bottom-left on desktop, stacked on the card on phones, `reservaBaixo()` keeps nodes clear of both), `irParaFaixas()` flies without selecting, and `recalcular()` won't close the card of a playing track. Leaving a centered graph flies the map to the artist's most central dot and selects it (`irParaArtista()` in `js/atlas.js`). The payload is `data/atlas-artistas.json.gz` (committed, ~240 KB; `decodeArtistas()`/`chaveArtista()` in `js/atlas-data.js`), loaded on first use. Artists match by `chaveArtista()` (no case, accents, punctuation or "part/feat" credit), which must stay in step with `chave()` in `script/build-artistas-parecidos.py`. The `#grafo-painel` reads like `#cartao` (covers load `capa-micro.jpg` first, then `capa-min.jpg`, fading into a held slot; `#grafo-fechar` does what Esc does; `#grafo-parecidos` lists up to 6 on-screen neighbours as buttons, lighting their dot on hover and walking on click, a sliding row on phones; hovering a cover names the album in `#grafo-detalhe`), with every cover of the artist linking to its album in a new tab (`capasDe()` in `js/atlas.js`, from the album artist and the track credits) and `#grafo-ouvir` ("♪ no tocador") opening `?acervo=&artista=` (`urlArtista()`, which keeps the catalog's spelling when `fold()` would otherwise miss it). `#btn-grafo` off goes back to the whole map, Esc to the artist's dot. `#cartao` lists 4 neighbours ("Soa parecido com") and has the golden `#cartao-progresso` line for the preview; `#cartao-ouvir` ("♪ no tocador") clicked during that track's preview adds `&seg=<s>`, and the player starts the track there (`getSegFromUrl()`/`startPlaybackAt()`, dropped from the URL after load); the player's `.album-atlas` link, right of the heart, opens the map in a new tab (so the audio keeps playing) centered on the album's most central dot (`?de=<acervo>&album=<path>`, 3× the fit, `ZOOM_PONTO`)
- **js/atlas-som.js**, **js/atlas-receitas.js** — the music of `/atlas`, synthesised with Web Audio, no audio file (decisions in `tasks/generative-music-nav.md`). `atlas-receitas.js` is data: 57 genre families with their beat, bass, comp, harmony and scale, and the label → family map. `atlas-som.js` has `criarMotorSom(ac)`, which also runs on an `OfflineAudioContext`, and `criarSomAtlas()`, which decides when it sounds. The engine plays recipes like a band: per-genre microtiming (`GROOVES`), 8-bar A A B A form with fills (`forma`), voice-led chords (`vozear()`), 4-bar motif phrases (`planoFrase()`), Karplus-Strong strings baked into buffers on first use, separate drier/brighter percussion path (`camP`), short and long rooms, tape echo and kick pumping (`EFEITOS`). Tune it by measurement: `script/render-som-atlas.js` + `script/avaliar-som-atlas.py` score each family against its real tracks, and the story is at the end of `ATLAS.md` `regiaoSom()`/`miraSom()` in `js/atlas.js` feed it what the camera sees, through the picking grid; only lit points count, so filters change the music. The visible dots are the score: `leitura` is a 4×16 piano roll of them and `planoFrase()` re-reads it every beat (in the graph, the artists on screen through `grafo.pontosVisiveis()`). Up to 6 families merge into one band in `fundir()`: weighted tempo, one averaged pocket, harmony and bass taking turns by weight, each kit role with one owner, one line sung by all. One clock and one key, changing at phrase starts. `#btn-musica` (labelled "Sonificar", key M) is on by default but stays unpressed and amber (`.espera`) until the `AudioContext` has really run, because the browser allows no sound before a click or key (the wheel doesn't count); any of them starts it, the button and M included, and it is `disabled` without Web Audio. It stops a preview, is silent while `#previa` plays, and waits while another tocador tab plays. `js/atlas-visor.js` draws `#visor-som` at the bottom middle while it sounds: the engine's own `AnalyserNode` (`som.analisador()`) as 40 log-spaced bars coloured by the families' weights (each family takes the macro colour of the first label it plays), the waveform over them (off under reduced motion), and "family · family — N bpm" underneath; hidden on phones while the card is open
- **js/som-abas.js** — `BroadcastChannel('tocador-som')`: `anunciarSom(audio, aoCalar)` (player, radio, atlas preview) and `ouvirSomDasAbas()` (atlas). One sound at a time: a tab that starts playing pauses every other tab's `<audio>` (the atlas preview pauses the player and vice versa; `aoCalar` resets the preview's card). Same origin only: other apps and sites can't be detected. Tests: `tests/som-abas.spec.js`
- **js/acervo-format.js** — `decodeAcervo()`: accepts the v1 or v2 payload, always returns the v1 shape. Loaded before `ui.js`, and also by `radio.html` / `3d.html`
- **sw.js** / **manifest.json** — PWA: service worker (network-first for pages, so a page is never older than its scripts; stale-while-revalidate for same-origin assets, keyed with their `?v=<sha>`, and `.json.gz` catalogs; never intercepts cdn.tocador.cc audio/covers so Range requests pass through) + installable app manifest
- **assets/player.css** — Styling
- **assets/capa.jpg** — SVG placeholder cover (data-URI embedded in `ui.js`)

The app fetches the acervo `.json.gz` asynchronously on load, decompresses via native `DecompressionStream`, then renders into a virtual scrolling grid (~30 DOM nodes regardless of library size).

**Untrusted catalog text.** Any `?acervo=<url>` catalog is third-party input. Everything from a
catalog that goes into `innerHTML` must pass through `escapeHtml()` (`js/util.js`); `tests/security.spec.js`
covers it. Prefer `textContent` where no markup is needed.

**Adding a script or stylesheet.** `index.html`, `sw.js` (`SHELL`/`EXTRAS`) and the deploy minify step
(`deploy.yml`) all list files. The uqt/hominiscanidae Pages workflows copy `tocador/js/*.js` and
`tocador/assets/*` by glob, so new files there need no workflow change.

**tocador.cc deploy extras** (`deploy.yml`): JS/CSS are minified in place with esbuild, and `sw.js`'s
`CACHE` literal is rewritten to the commit SHA so each deploy installs a fresh worker and purges old
caches. Neither happens in the uqt/hominiscanidae mirrors, which serve the source as-is.

### Backend / Infrastructure
- **proxy.js** + **lib/** — Bun reverse proxy on port 9002 (behind nginx on 9001). `lib/s3.js` (SigV4 signing, key handling, bucket routing), `lib/access.js` (client-IP trust, hotlink allowlist, bot policy), `lib/limits.js` (token buckets, concurrency caps, device fingerprint) and `lib/metrics.js` (request counters, upstream health, radio presence, day stats; the old top-level `let` counters live on its exported `state` object) hold the logic; `proxy.js` is routing, the request handler and startup. The Dockerfile copies both, and `deploy-proxy.yml` watches `lib/**`. Uses `Bun.S3Client` (native, no npm deps). CORS, MIME, Range, security hardening (path traversal, hotlink, rate limit, graceful shutdown). Zero production npm dependencies.
- **haloy.yaml** — Deployment config; deploys proxy to `cdn.tocador.cc`
- **Dockerfile** — Packages proxy.js for haloy deployment

### Scripts (`script/`)
- **generate-albums.js** — JS version (uses ffprobe); generates `.json.gz` from MP3s in `unzips/`
- **generate-albums/** — Rust version (uses id3 crate, parallel via rayon); preferred for large archives
- **sync-to-bucket.js** — Syncs local audio files to S3 bucket
- **resize-cover-images.js** — Resizes covers to 200px and uploads to S3 (`--acervo uqt|homi`, `--dry-run`)
- **filter-albums-by-s3.js** — Removes albums from the JSON that have no matching S3 folder
- **build-micro-covers.js** — Makes the 96 px `capa-micro.jpg` from each `capa-min.jpg` already in the bucket and uploads the missing ones (`--acervo uqt|homi`, `--dry-run` first). Run after `resize-cover-images.js` on every ETL
- **find-untagged.js** — Lists MP3s missing ID3 tags
- **dedup-albums.js** — Detects duplicate albums by track fingerprint
- **merge-acervo.js** — Appends a partial catalog (generate-albums run on a staging dir holding only new albums) to a published `.json.gz`, rejecting albums whose path, (artist, title, year) or artist + tracklist already exist; keeps the published format and refuses to write unless every old album decodes unchanged and keeps its album-page slug. How albums get added now that homi's audio lives only in S3 (see *Adding albums without the music volume*)
- **convert-acervo-v2.js** — Rewrites a published `.json.gz` from the v1 to the v2 columnar payload, verifying the round-trip before writing
- **build-album-pages.js** — Builds static per-album pages, per-acervo indexes and sitemaps at deploy (see *Generating an acervo*)
- **build-3d-atlas.js** — Packs every album cover into 4096² WebP atlases + `atlas-map.json.gz` for `3d.html` and uploads them (`--acervo uqt|homi`, `--check` to compare the live atlas with the catalog, `--no-upload`). Re-run after every ETL: an album added later has no tile until then (the 3D view falls back to loading its cover individually). Aborts without uploading if any album with a cover ends up without a tile
- **build-atlas-coords.py** — UMAP over `data/features/{uqt,homi}.json.gz` + `.emb.f16` (`analyze-tracks.py --compact`): the 1280-d embedding gives the "som" map, the genre labels the "rotulos" map → `data/features/atlas-coords.json.gz` (gitignored). ~5 min; not incremental, the whole map is redrawn on every run. Each map is a 3D UMAP initialised from its 2D one, so seen from the front it looks like the 2D map; the third coordinate becomes `somz`/`rotulosz` in the payload (`--reuse-som3`/`--reuse-rotulos3` take the cached `data/features/atlas-{som,rotulos}3.npz`)
- **build-atlas-web.js** — Coords + the published catalogs → `data/atlas-faixas.json.gz` (committed), the payload `/atlas` loads; points are keyed by track-key hash
- **build-artistas-parecidos.py** — Per-artist centroid of the audio embedding and of the genre labels, minus the global mean, then the 8 nearest by cosine, plus a 3D UMAP of those vectors per map for the graph's overview (`pos`, only for drawing) → `data/atlas-artistas.json.gz`. Artists with 3+ tracks; compilation labels (`FORA`, `COLETANEA`) are out. Reads the published catalogs through `export-faixas-artistas.js`, so artists are what `parseArtists()` gives the player. `--amostra "Nome" …` prints neighbours and writes nothing. ~1 min. The neighbours don't come from the UMAP, which distorts distances
- **build-atlas-og.py** — Renders the map to `assets/atlas-og.jpg`, the `/atlas` link-preview image
- **amostrar-som-real.js**, **perfil-som-real.py**, **ajustar-som-atlas.py** — Per-family profiles from real tracks (read-only S3 Range GETs) and the coordinate search that writes the `AJUSTES` block of `js/atlas-receitas.js`, tuning on one take and validating on another. About an hour for all families
- **render-som-atlas.js**, **avaliar-som-atlas.py** — Render every `/atlas` music family to WAV with the real engine (~7 min, Playwright's Chromium) and score them with the Essentia models against the real tracks' centroids (`--antes` compares with an earlier `nota.json`). Needs `~/.essentia/models` and `data/features/{uqt,homi}.{json.gz,emb.f16}`
- **analyze-tracks.py** — Slim, resumable audio analysis (Essentia + TF, multiprocess). One JSONL line per track in `data/features/<acervo>.jsonl` (gitignored): BPM, key, loudness, genre/instrument/mood top-k, voice/dance/acoustic/happy/sad/relaxed… probabilities, and the 1280-d EffNet embedding, all from a 45 s centre clip. The JSONL *is* the checkpoint: Ctrl-C pauses, rerunning resumes, and rerunning after an ETL only does the new MP3s (key = `<album path>/<file>`, NFC). One progress bar for the whole acervo with ETA. `--acervo homi|uqt`, `--dry-run`, `--limit N`, `--retry-errors`, `--compact` → `.json.gz` + `.emb.f16` for the MCP. ~3 tracks/s on 9 workers (≈5 h homi, ≈2.5 h uqt)
- **build-genre-index.js** — `--acervo homi|uqt` (default homi). For uqt it reads only `data/features/uqt.jsonl` → `data/uqt-genres.json.gz` (committed, served at `https://tocador.cc/data/uqt-genres.json.gz`; without it the player hides the Gêneros tab for uqt). For homi it reads `data/genres/genres.json` (raw Essentia predictions, gitignored, 30 MB; `extract-genres.py` writes it), majority-votes top-3 genre predictions per track → outputs `data/homi-genres.json.gz` (~147 KB, committed here and served at `https://tocador.cc/data/homi-genres.json.gz`; the hominiscanidae repo holds no genre data)

## Acervos

Registered in `js/ui.js` → `KNOWN_ACERVOS`. Each entry has only `data` (URL to the `.json.gz`). **`base_url` is never set here** — it must be baked into the `.json.gz` via `--base-url` at generation time and is read from `db.meta.base_url` at load.

| alias | data URL | S3 prefix |
|---|---|---|
| `uqt` | `data/uqt-albums.json.gz` (GitHub raw) | `https://cdn.tocador.cc/uqt` |
| `homi` | `data/homi-albums.json.gz` (GitHub raw) | `https://cdn.tocador.cc/indie` |

Player priority for `base_url`: `db.meta.base_url` → `sessionStorage` → `''`.

External acervos work too: `?acervo=https://example.com/my-archive.json.gz`

## Acervo JSON format

```json
{
  "meta": {
    "title": "Nome do Acervo",
    "subtitle": "Subtítulo opcional",
    "hours": "705",
    "base_url": "https://cdn.tocador.cc/uqt"
  },
  "albums": [
    {
      "title": "Nome do Álbum",
      "artist": "Artista",
      "year": 1975,
      "path": "1975 - Artista - Nome do Álbum",
      "has_cover": true,
      "tracks": [
        { "title": "Faixa", "num": 1, "file": "01 Faixa.mp3", "artists": "Artista", "duration": 214 }
      ]
    }
  ]
}
```

`base_url + "/" + path + "/" + file` → audio URL  
`base_url + "/" + path + "/capa-min.jpg"` → cover URL

### v2 (columnar) payload

Marked by a top-level `"v": 2`. Same data transposed into one array per field, with
every album's tracks flattened into shared arrays and sliced apart via `a.n`:

```json
{
  "meta": { "...": "unchanged" },
  "v": 2,
  "a": { "t": ["título"], "r": ["artista"], "y": [1975], "p": [""], "c": [1], "n": [12] },
  "t": { "t": ["faixa"], "f": [""], "k": [1], "d": [214], "r": [""], "n": [0] }
}
```

Three things are elided and rebuilt on decode:

- `a.p` (path) — empty means it equals `"<year> - <artist> - <title>"`
- `t.f` (file) — empty unless `t.k` is `0`; `1` means `"NN - <title>.mp3"`, `2` means `"NN <title>.mp3"`
- `t.r` (track artist) — empty means "same as the album artist"

**`t.n` = 0 means the source had no track number — not "sequential".** The player
numbers un-numbered tracks by their position *after* deduplicating repeated titles,
so materialising a number at decode time shifts every track that follows a
duplicate (it hit 22 of 2306 uqt albums). `decodeAcervo()` leaves `num` absent for 0.

Measured: **−37% raw bytes** to `JSON.parse` on both acervos; transfer −24% on uqt,
−3% on homi (gzip already collapses repeated keys, so this is mostly a parse win —
the transfer gain comes from artist-sorted album order, which pays off only when an
archive has several albums per artist).

`decodeAcervo()` in `js/acervo-format.js` reads both versions, so v1 files and
third-party acervos keep working with no migration.

**Deploy order matters**: publish the player before publishing a v2 catalog. A
cached older `ui.js` cannot read v2 and will render an empty grid. From this version on the
player fails loudly instead: `decodeAcervo()` throws `UNSUPPORTED_ACERVO_VERSION` for a
payload newer than it knows, and `ui.js` then drops the service-worker caches and reloads once
(`sessionStorage` `tocador-stale-reload`), falling back to a "reload to update" message.

## Data Flow

1. Browser loads `index.html` (or an album page, `/<alias>/<slug>/`, which is the same player) from GitHub Pages
2. `ui.js` reads the acervo from the album-page path or `?acervo=` (alias or direct URL), fetches the `.json.gz`, decompresses, sets `BASE_URL = db.meta.base_url`
3. User clicks album → primes first track (`audio.src`, `audio.load()`) without auto-playing, and the address bar becomes `/<alias>/<slug>/` (track as `#tN`)
4. User presses play → constructs `{BASE_URL}/{encodeURIComponent(path)}/{encodeURIComponent(file)}`
5. Proxy receives request, forwards to S3 with CORS + MIME headers

## Common Tasks

### Generating an acervo (Rust — preferred for large archives)

Title, subtitle, hours are read from `acervo.json` in the music dir; `base_url` from `.env` there. No flags needed.
The generator lists each recording once: folders with the same artist, track titles and per-track
durations collapse into the best-named one (a real release over a "Hominis Canidae #NNN" post, a
`YYYY - Artist - Title` folder over a slug or separator-less one). When no naming rule can tell two
copies apart, list the wrong folder's path in `acervo.json` → `"exclude": [...]`. Each acervo outputs directly into its own repo:

```bash
# uqt → ../uqt repo
./script/generate-albums/target/release/generate-albums \
  /Volumes/EXTRA/bkps/UQT/sambaderaiz \
  ../uqt/data/uqt-albums.json.gz

# hominiscanidae → ../hominiscanidae repo
./script/generate-albums/target/release/generate-albums \
  /Volumes/EXTRA/hominiscanidae/unzips \
  ../hominiscanidae/data/homi-albums.json.gz

# then regenerate the genre index (homi only)
bun script/build-genre-index.js
```

Then commit and push in each repo, and in tocador for `data/homi-genres.json.gz`. CLI flags (`--title`, `--subtitle`, `--base-url`, `--hours`, `--s3-prefix`, `--v2`) override config when passed.
The generator writes no sitemaps: `--sitemap-url`/`--sitemap-out` were removed and now exit with an
error (a leftover `sitemap_url` key in a music dir's `acervo.json` is ignored).

**Sitemaps are built at deploy, never in the archive repos.**
`deploy.yml` downloads both catalogs and runs `script/build-album-pages.js`, which writes a page
per album at `/<alias>/<slug>/`, an `/<alias>/` index linking every album, and `sitemap.xml` →
`sitemap-albums-{uqt,homi}.xml` listing those pages. It runs on push and on a daily cron, so an
archive-only push shows up within a day. This exists because the player renders albums with JS:
Google never indexed any `?acervo=&album=` URL, and link previews (which don't run JS) showed no
cover.

**Artist links.** `?acervo=<alias>&artista=<nome>` is the filter. `#share-artist`, beside the filter chip, copies
`/<alias>/artista/<slug>/` instead: a ~4 KB static page per artist (`artistPage()`, 45 MB for ~11k artists) with the name
and a cover for link previews, `noindex`, that `location.replace()`s to the filter. Not the whole player, which would
double the Pages site. Slugs come from `artistSlugs()` in `js/acervo-format.js`, fed the player's own
`parseArtists()`/`fold()`.

**Album pages are the player.** Each is `index.html` with the album's title, description, cover
`og:image` and JSON-LD swapped into `<head>`, its header and tracklist pre-rendered into
`#album-header`/`#track-list`, root-absolute asset paths, and `<html data-album-pages>`
(`playerTemplate()` checks every cut, so an `index.html` reshuffle fails the build). On tocador.cc
the player keeps `/<alias>/<slug>/` in the address bar with the track as `#tN` — a fragment, so
crawlers never see track changes as redirects — which means any copied URL unfurls with the cover.
The uqt/hominiscanidae Pages mirrors and `?acervo=<url>` catalogs have no album pages and keep
`?album=&t=`; `ui.js` still reads those everywhere, so old links keep working. `index.html` itself
must keep *relative* asset paths because the mirrors serve it from a subdirectory; `ui.js` finds
the app root from its own script URL (`APP_ROOT`). Slugs come from `albumSlugs()` in
`js/acervo-format.js`, shared by the builder and the player, so never slugify anywhere else.

The generated `uqt/`, `homi/` and `sitemap*.xml` are gitignored here.

Add `--v2` to emit the columnar payload instead of v1. Publish the player first — see
the deploy-order note under *v2 (columnar) payload*.

Build first: `cd script/generate-albums && cargo build --release`

### Adding albums without the music volume

`/Volumes/EXTRA/hominiscanidae` is gone: homi's audio exists only in the `indie` bucket. New
posts are staged on the internal disk, pushed to S3 and merged into the published catalog, which
is now the source of truth — a full `generate-albums` run over the whole archive is no longer
possible, so generator naming fixes only reach albums added after them, and `acervo.json`'s
`exclude` list went with the drive (reject duplicates at merge time instead). Run on 2026-10-15
for 28 albums (6679 → 6707).

```bash
export HOMI_DEST=~/homi-staging            # download_all.py, unzip.py, flac_to_mp3.py read it
cd ~/Projetos/hominiscanidae
python3 scripts/scrape/scrape_posts.py --sitemap
python3 -u scripts/download/download_all.py   # only posts not yet "downloaded" in posts.json
python3 scripts/utils/unzip.py --dry-run && python3 scripts/utils/unzip.py

cd ~/Projetos/tocador
./script/generate-albums/target/release/generate-albums ~/homi-staging/unzips /tmp/homi-novos.json.gz \
  --title "Hominis Canidae" --subtitle "HOMINISCANIDAEVERSO DESDE 2009" \
  --base-url https://cdn.tocador.cc/indie --s3-prefix indie/
bun script/merge-acervo.js ../hominiscanidae/data/homi-albums.json.gz /tmp/homi-novos.json.gz --dry-run
# move any rejected folder out of ~/homi-staging/unzips before syncing, or its S3 keys get overwritten
S3_PREFIX=indie/ ARCHIVE_DIR=~/homi-staging/unzips node script/sync-to-bucket.js --dry-run  # only the new files
S3_PREFIX=indie/ ARCHIVE_DIR=~/homi-staging/unzips node script/sync-to-bucket.js
bun script/merge-acervo.js ../hominiscanidae/data/homi-albums.json.gz /tmp/homi-novos.json.gz
ARCHIVE_DIR=~/homi-staging/unzips bun script/resize-cover-images.js --acervo homi --dry-run   # ≈ one per new album
ARCHIVE_DIR=~/homi-staging/unzips bun script/resize-cover-images.js --acervo homi
bun script/build-micro-covers.js --acervo homi --dry-run   # ≈ one per new album
bun script/build-micro-covers.js --acervo homi
```

Then the audio analysis with `--dir ~/homi-staging/unzips --out ~/Projetos/tocador/data/features/homi.jsonl`
(`analyze-tracks.py` and the feature-integrity scripts live on `feat/chat-musical`), `build-genre-index.js`,
and `bun script/build-features-web.js --acervo homi --out data` — the merged catalog changes the
features fingerprint, so without this the Pegada panel rejects `homi-features.json.gz`.
Then refresh the `/atlas` map: `uv run -q --with umap-learn --with scikit-learn --with scipy --with numpy python script/build-atlas-coords.py` (UMAP, ~5 min, not incremental, the map is redrawn),
`bun script/build-atlas-web.js`, `uv run -q --with umap-learn --with numpy python script/build-artistas-parecidos.py`, then `uv run -q --with matplotlib --with numpy --with pillow python script/build-atlas-og.py`, and commit `data/atlas-faixas.json.gz`, `data/atlas-artistas.json.gz` and `assets/atlas-og.jpg`.
Until then the new tracks have no point on the map.
Publish hominiscanidae first and wait until GitHub Pages serves the new catalog (`deploy.yml` builds
the album pages from it), then push tocador, then run `build-3d-atlas.js --acervo homi`.

Gotchas from the first run: aria2 can leave a `.rar.aria2` next to a truncated archive that still
reports "OK" — `unrar t` every archive before extracting, and re-download a failing one directly.
Homebrew disabled the `rar` cask on 2026-09-01; `unrar` comes from the RARLAB tarball in
`~/.local/bin`. Checking every new track through cdn.tocador.cc trips the proxy's rate limit (429);
verify keys with authenticated S3 `HeadObject` calls instead.

### Migrating an existing acervo to v2

Converts a published `.json.gz` in place, without needing the music volume mounted.
Refuses to write unless the payload decodes back to exactly what went in:

```bash
bun script/convert-acervo-v2.js ../uqt/data/uqt-albums.json.gz
bun script/convert-acervo-v2.js ../hominiscanidae/data/homi-albums.json.gz
```

### Generating an acervo (JS — requires ffprobe)

```bash
brew install ffmpeg   # once
bun script/generate-albums.js
```

### Syncing audio to S3

```bash
bun script/sync-to-bucket.js      # uploads diff (size-based) with 20 workers
bun script/resize-cover-images.js --acervo homi --dry-run  # list what would upload, write nothing
bun script/resize-cover-images.js --acervo homi            # resizes covers to 200px and uploads
bun script/filter-albums-by-s3.js # trims JSON to albums confirmed in S3
```

Requires `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET` in `.env`.

### Running the proxy locally

```bash
bun proxy.js   # listens on :9001
curl -I http://localhost:9001/health
```

### Deploying

Automatic: pushing to `main` with changes to `proxy.js`, `package*.json`, `Dockerfile`,
or `haloy.yaml` triggers `.github/workflows/deploy-proxy.yml`, which runs `haloy deploy`
using GitHub-stored secrets and then gates on a real audio fetch through the proxy
(`/health` alone can't be trusted — see Troubleshooting) before calling the run green.
A separate scheduled workflow, `.github/workflows/cdn-health-monitor.yml`, re-checks
every 30 minutes and auto-triggers one redeploy plus a tracking GitHub issue if the CDN
is failing real fetches.

Manual (break-glass fallback only — normal deploys should go through the push above):

```bash
set -a; . .env; set +a; haloy deploy   # requires HALOY_API_TOKEN + AWS creds in .env
```

## Key Technical Notes

- **`base_url` in JSON**: If missing, the player falls back to the `uqt` default — wrong for any other acervo. Always pass `--base-url` when generating.
- **CORS / CORB**: Proxy adds `Access-Control-Allow-Origin: *` to all responses including errors. S3 direct URLs must not be used — always route through the proxy.
- **URL encoding**: Paths and filenames encoded with `encodeURIComponent()` in `ui.js` — not `encodeURI()`, which leaves `#` and `?` alone and cuts "Hominis Canidae #NNN" paths short (a `curl` check built with `encodeURI` reports those covers as 404 when they're fine). Proxy forwards as-is. S3 stores with literal spaces.
- **Cover images**: `capa-min.jpg` at 200px wide (~10 KB). Generated by `resize-cover-images.js`. Missing covers show SVG placeholder (data-URI, zero network requests).
  The generator's `has_cover` and the uploader's `findCover()` share one rule — a cover-named
  image wins, else the largest image, JPEG/PNG/WebP alike (the uploader re-encodes to JPEG); a
  part folder with no image uses its parent's. Keep them in step: when they disagreed, albums
  with `Capa.png` were promised a cover that was never uploaded. The uploader writes each
  acervo to the bucket `S3_BUCKET_MAP` in `haloy.yaml` names (uqt → `sambaraiz`, homi →
  `indie`), not `S3_BUCKET`, and checks both NFC and NFD keys before uploading — see the
  Troubleshooting note on normalization. Always `--dry-run` first; expect tens of uploads.
- **Link-preview bots and covers**: `proxy.js` 403s bot user agents, except Google
  (`goodBotRegex`) and link-preview crawlers (`previewBotRegex`: WhatsApp, Facebook, Telegram,
  Twitter, Slack, Discord…), which may fetch *images only*. The album pages' `og:image` is a
  cover on cdn.tocador.cc; before the exception, shared links showed a picture only when nginx
  happened to hold the cover cached. nginx caches only 200/404 (`proxy_cache_valid`), never
  per-requester 403/429s.
- **Album naming for odd folders** (`generate-albums`): a folder inside another folder
  ("Extras", a disc, uqt's `UQT2011_Artist-Title` wrappers) is named after its parent —
  "<parent title> (<folder>)", or just the parent title when the folder name only repeats it —
  and inherits the parent's year and cover. A URL-slug folder (`lizard-cult-lotico-split-2026`)
  takes title and artist from ID3 (album-artist tag first), year from the slug. With real names,
  the (artist, title, year) duplicate check drops nested copies of top-level albums; a second
  check drops nested copies with the same artist and tracklist. Same-depth albums with equal
  tracklists are kept (reissues, separate posts).
- **Virtual grid**: ~30 DOM nodes always in the grid regardless of library size. `VirtualGrid` uses absolute positioning + `ResizeObserver`.
- **Range requests**: Proxy forwards `Range` headers to S3; returns 206 for partial content — required for seek without full download.
- **S3 bucket policy**: Both buckets (`sambaraiz`, `indie`) are private since 2026-09-27 — the proxy signs
  every request, so nothing needs anonymous access. The policy is a single `Deny` on `s3:GetObject` +
  `s3:ListBucket` for `Principal: "*"` with `Condition: {"StringNotEquals": {"aws:username": "p2100630"}}`
  (the owner account). A plain delete of the old public-read policy is *not* enough: objects were
  uploaded with an `AllUsers` READ ACL, which the explicit Deny overrides. Hetzner's Ceph ignores
  `NotPrincipal` (the anonymous read still went through), and `{"Null": {"aws:userid": "true"}}` locks out the owner too —
  don't use either. After a policy change, one RGW node can serve the old policy for a while; check
  with repeated anonymous `curl`s against `hel1.your-objectstorage.com/<bucket>/<key>`, not just one.
  The live policies are versioned in `infra/bucket-policy-{sambaraiz,indie}.json`; re-apply with
  `infra/apply-bucket-policies.sh`.
- **Audio hotlink check**: `refererAllowed()` in `proxy.js` serves audio only when Referer (or Origin)
  is one of `ALLOWED_ORIGINS`. A request with *neither* header is refused — browsers always send at
  least the origin for a cross-origin `<audio>`, so a bare request is curl or a scraper. Anything
  fetching audio server-side must set a Referer itself: the deploy/monitor smoke tests pass
  `-e https://tocador.cc/`, and the `/report-error` playability HEAD sets one too — drop it and every
  radio report gets filed as an issue. Covers are exempt. There is no radio bypass (a `?ctx=radio`
  one existed and let anyone skip the check); the radio's hosts are simply on the allowlist.
- **Radio "listening now"**: `radio.html` POSTs `{id}` to `/radio-heartbeat` every ~15s while its `<audio>`
  is actually playing (id is per page-load, generated client-side; `{id, stop:true}` fires once on
  pause/tab-close via `sendBeacon`; `{id, track:true}` is added once per distinct track, deduped
  client-side), and proxy.js ages a listener out after 40s of silence either way. `GET /metrics` is public
  JSON, gated by HTTP Basic Auth where the password is `md5("tocador.cc/metrics")` (username ignored):
  `listeners.now` is the live count (same as the old top-level `radioListeners`), `listeners.peakToday`
  the day's high-water mark. `today.*` resets at local midnight in America/Sao_Paulo (fixed UTC-3, no
  DST since 2019) rather than rolling 24h: `uniqueListeners` (keyed by the same per-load id — a stop
  beacon still counts as "was here" and isn't removed early like it is from `listeners.now`),
  `listeningHours` (estimated from heartbeat tick count × 15s, not an exact watch-time log),
  `tracksPlayed` (from `track:true` beacons), `requests` (every HTTP request the proxy served today,
  all endpoints), `sent_MB` (response bytes sent today, audio + covers), `plays` and `topTracks` (the 15 most started tracks today, `[{path, plays}]`, from player, radio and atlas alike: an audio GET whose range starts at byte 0, counted once per device per track per 30 min so Safari's `bytes=0-1` probe and seeks back to 0 don't inflate it; paths only, NFC, `markPlay()` in `lib/metrics.js`, tests in `tests/metrics-top.test.js`). Audio nginx serves from its cache never reaches the proxy and isn't counted. Both
  endpoints are reachable at `cdn.tocador.cc` because nginx's catch-all `location /` forwards everything
  to the app; there's no separate internal-only port for them despite `proxy.js`'s comments about port
  9002 not being exposed — that's true of the raw port, not of what nginx proxies through it.

## Troubleshooting

**404 on audio/covers**: Check S3 path — `{prefix}/{album.path}/{file}`. Sync may be incomplete.

**Accented filenames 404 (and only accented ones)**: Unicode normalization mismatch.
macOS writes decomposed names (NFD) and most other sources compose them (NFC); those
are different byte sequences, so S3 sees two different keys. The buckets are *not*
uniform — `sambaraiz/uqt` is mostly NFD, `indie/indie` is mostly NFC, and each holds a
handful of keys in the other form. `proxy.js` therefore must not normalize the incoming
path to any single form: `signedPassthrough()` tries the key exactly as requested, then
falls back to NFC and NFD only on a 404 (see `keyCandidates()`). A blanket
`.normalize('NFC')` at the door was live from 2026-05-28 to 2026-08-21 and silently
404'd **50.9% of the uqt catalog** (14,676 of 28,817 tracks, touching 2,199 of 2,306
albums) while leaving homi untouched — which is why it went unnoticed for months. Tell
this apart from a missing sync by listing the prefix: if the key is *in* the bucket but
the CDN 404s it, it's normalization, not a gap. Do **not** "fix" it by re-uploading.

**CORB errors in browser**: Proxy must be running and `base_url` must point to the proxy, not directly to S3.

**Wrong `base_url`**: Regenerate the `.json.gz` with `--base-url`. Do not set it in `KNOWN_ACERVOS`.

**App shows no albums**: Check browser console for fetch errors on the `.json.gz` URL. Verify the file is valid gzip.

**Proxy not routing via haloy**: Verify `HALOY_API_TOKEN` with `haloy status`.

**Nothing plays / covers don't load (cdn.tocador.cc 502 or 503)**: `haloy status` showing
`Running` does not mean the proxy can reach S3 — `/health` only flips unhealthy after 5
consecutive upstream failures (`UPSTREAM_FAIL_THRESHOLD` in `proxy.js`), and a fresh
deploy starts that counter at zero, so a bad credential can pass CI's health check and
only surface once real traffic hits it. Verify with a real fetch, not `/health`:

```bash
curl -sI -H "Range: bytes=0-1000" -e https://tocador.cc/ "https://cdn.tocador.cc/indie/<album>/<track>.mp3"
```

If that 502s/503s: redeploy (`git push` touching `proxy.js`, or the manual fallback
above) to pick up current secrets. If it still fails after a redeploy, suspect the
secrets themselves — check `gh secret list` timestamps against `.env`'s, and note that
`gh secret set` does **not** strip quotes the way shell-sourcing `.env` does: a value
copied as `S3_ENDPOINT="https://..."` (or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`,
`S3_BUCKET` — any of the four) literally includes the quote characters as a GitHub
secret. A quoted `S3_ENDPOINT`/`S3_BUCKET` crashes `Bun.S3Client` at startup; a quoted
AWS key/secret is subtler — `Bun.S3Client`'s own signing tolerates the extra quote
characters, so ranged audio *seeking* (`file.slice().stream()`) keeps working, but the
hand-rolled `signedPassthrough()` signer in `proxy.js` does not, so first-play audio,
HEAD checks, and covers all 403 while playback-after-seek looks fine — easy to
mininterpret as a code regression rather than a credential problem (happened
2026-08-20). `deploy-proxy.yml` now fails fast on any quote-wrapped secret before
deploying, so this should surface as a red CI run instead of a live outage — but if you
still need to fix one by hand: `gh secret set S3_ENDPOINT --body "$(grep '^S3_ENDPOINT=' .env | cut -d= -f2- | tr -d '"')"`.
