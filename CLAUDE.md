# tocador

Shared music player platform — the same player hosts multiple independent archives (acervos). Point it at any compatible `.json.gz` and it plays, with no build step.

## Architecture

### Frontend
- **index.html** — Main web app; no build step, served from GitHub Pages or any static CDN
- **js/ui.js** — Shared state (`let`s), data build, filtering, and the `DOMContentLoaded` init/acervo load
- **js/url-meta.js**, **js/browse.js**, **js/album-view.js**, **js/playback.js** — the rest of the app, split by concern (URL/meta/share, browse panel + shortcuts, decade buttons + album/track rendering, playback). Classic scripts loaded after `ui.js`; they share its global scope, so state stays declared at the top of `ui.js`
- **js/util.js** — Pure helpers (`fold`, `parseArtists`, `escapeHtml`, `formatTime`, `PT_COLLATOR`). Classic script, loaded before `ui.js`
- **js/virtual-lists.js** — `VirtualGrid` (albums) and `VirtualList` (browse panel). Classic script; calls `ui.js` globals only at run time
- **js/radio.js**, **js/3d.js**, **assets/radio.css**, **assets/3d.css** — the code and styles of `radio.html` / `3d.html`, kept out of the HTML so the service worker can cache them
- **js/chat.js** — Chat panel: the header button after `#btn-radio` swaps `.browse-panel` for `#chat-panel` (a drawer on mobile). v0 engine, no LLM: `interpret()` reads periods (decades, years, ranges, "antes de 1980") and plain words; `chatSearch()` ANDs the words over title/artist/folder/tracks (words ≤3 letters match whole words only); words that match nothing together are set aside, never silently (`chatRelax`); typos get a "quis dizer" chip (`chatSpelling`); every answer has a **por quê?** block saying what was understood, ignored and applied to the grid. Opening a result goes through `openAlbum()` in `ui.js` (same path as a grid click). Tests: `tests/chat.spec.js`. The ontology/text-model plan is in `tasks/` (gitignored)
- **js/acervo-format.js** — `decodeAcervo()`: accepts the v1 or v2 payload, always returns the v1 shape. Loaded before `ui.js`, and also by `radio.html` / `3d.html`
- **sw.js** / **manifest.json** — PWA: service worker (stale-while-revalidate for same-origin assets and `.json.gz` catalogs; never intercepts cdn.tocador.cc audio/covers so Range requests pass through) + installable app manifest
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
- **find-untagged.js** — Lists MP3s missing ID3 tags
- **dedup-albums.js** — Detects duplicate albums by track fingerprint
- **convert-acervo-v2.js** — Rewrites a published `.json.gz` from the v1 to the v2 columnar payload, verifying the round-trip before writing
- **build-album-pages.js** — Builds static per-album pages, per-acervo indexes and sitemaps at deploy (see *Generating an acervo*)
- **build-3d-atlas.js** — Packs every album cover into 4096² WebP atlases + `atlas-map.json.gz` for `3d.html` and uploads them (`--acervo uqt|homi`, `--check` to compare the live atlas with the catalog, `--no-upload`). Re-run after every ETL: an album added later has no tile until then (the 3D view falls back to loading its cover individually). Aborts without uploading if any album with a cover ends up without a tile
- **analyze-tracks.py** — Slim, resumable audio analysis (Essentia + TF, multiprocess). One JSONL line per track in `data/features/<acervo>.jsonl` (gitignored): BPM, key, loudness, genre/instrument/mood top-k, voice/dance/acoustic/happy/sad/relaxed… probabilities, and the 1280-d EffNet embedding, all from a 45 s centre clip. The JSONL *is* the checkpoint: Ctrl-C pauses, rerunning resumes, and rerunning after an ETL only does the new MP3s (key = `<album path>/<file>`, NFC). One progress bar for the whole acervo with ETA. `--acervo homi|uqt`, `--dry-run`, `--limit N`, `--retry-errors`, `--compact` → `.json.gz` + `.emb.f16` for the MCP. A lock file (`<out>.lock`) keeps two runs off the same output; a paused run exits 130 so chained jobs stop. ~3 tracks/s on 9 workers (≈5 h homi, ≈2.5 h uqt)
- **build-genre-index.js** — Reads `data/features/homi.jsonl` (from `analyze-tracks.py`) first and falls back to `data/genres/genres.json` (older raw Essentia predictions, gitignored, 30 MB; `extract-genres.py` writes it) for albums not analyzed yet, majority-votes top-3 genre predictions per track → outputs `data/homi-genres.json.gz` (~147 KB, committed here and served at `https://tocador.cc/data/homi-genres.json.gz`; the hominiscanidae repo holds no genre data)

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
  all endpoints), and `sent_MB` (response bytes sent today, audio + covers). Both
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
