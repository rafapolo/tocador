# tocador

Shared music player platform — the same player hosts multiple independent archives (acervos). Point it at any compatible `.json.gz` and it plays, with no build step.

## Architecture

### Frontend
- **index.html** — Main web app; no build step, served from GitHub Pages or any static CDN
- **js/ui.js** — All app logic: virtual grid, album/track rendering, playback, search/filter, acervo loading
- **js/acervo-format.js** — `decodeAcervo()`: accepts the v1 or v2 payload, always returns the v1 shape. Loaded before `ui.js`, and also by `radio.html` / `3d.html`
- **sw.js** / **manifest.json** — PWA: service worker (stale-while-revalidate for same-origin assets and `.json.gz` catalogs; never intercepts cdn.tocador.cc audio/covers so Range requests pass through) + installable app manifest
- **assets/player.css** — Styling
- **assets/capa.jpg** — SVG placeholder cover (data-URI embedded in `ui.js`)

The app fetches the acervo `.json.gz` asynchronously on load, decompresses via native `DecompressionStream`, then renders into a virtual scrolling grid (~30 DOM nodes regardless of library size).

### Backend / Infrastructure
- **proxy.js** — Bun reverse proxy on port 9002 (behind nginx on 9001). Uses `Bun.S3Client` (native, no npm deps). CORS, MIME, Range, security hardening (path traversal, hotlink, rate limit, graceful shutdown). Zero production npm dependencies.
- **haloy.yaml** — Deployment config; deploys proxy to `cdn.tocador.cc`
- **Dockerfile** — Packages proxy.js for haloy deployment

### Scripts (`script/`)
- **generate-albums.js** — JS version (uses ffprobe); generates `.json.gz` from MP3s in `unzips/`
- **generate-albums/** — Rust version (uses id3 crate, parallel via rayon); preferred for large archives
- **sync-to-bucket.js** — Syncs local audio files to S3 bucket
- **resize-cover-images.js** — Resizes covers to 200px and uploads to S3
- **filter-albums-by-s3.js** — Removes albums from the JSON that have no matching S3 folder
- **find-untagged.js** — Lists MP3s missing ID3 tags
- **dedup-albums.js** — Detects duplicate albums by track fingerprint
- **convert-acervo-v2.js** — Rewrites a published `.json.gz` from the v1 to the v2 columnar payload, verifying the round-trip before writing
- **build-genre-index.js** — Reads `../hominiscanidae/data/genres.json`, majority-votes top-3 genre predictions per track → outputs `../hominiscanidae/data/homi-genres.json.gz` (~147 KB)

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
cached older `ui.js` cannot read v2 and will render an empty grid.

## Data Flow

1. Browser loads `index.html` from GitHub Pages
2. `ui.js` reads `?acervo=` (alias or direct URL), fetches the `.json.gz`, decompresses, sets `BASE_URL = db.meta.base_url`
3. User clicks album → primes first track (`audio.src`, `audio.load()`) without auto-playing
4. User presses play → constructs `{BASE_URL}/{encodeURI(path)}/{encodeURI(file)}`
5. Proxy receives request, forwards to S3 with CORS + MIME headers

## Common Tasks

### Generating an acervo (Rust — preferred for large archives)

Title, subtitle, hours are read from `acervo.json` in the music dir; `base_url` from `.env` there. No flags needed. Each acervo outputs directly into its own repo:

```bash
# uqt → ../uqt repo
./script/generate-albums/target/release/generate-albums \
  /Volumes/EXTRA/bkps/UQT/sambaderaiz \
  ../uqt/data/uqt-albums.json.gz

# hominiscanidae → ../hominiscanidae repo (also writes sitemap.xml here)
./script/generate-albums/target/release/generate-albums \
  /Volumes/EXTRA/hominiscanidae/unzips \
  ../hominiscanidae/data/homi-albums.json.gz \
  --sitemap-out sitemap.xml

# then regenerate the genre index (homi only)
bun script/build-genre-index.js
```

Then commit and push in each repo (including `data/homi-genres.json.gz`). CLI flags (`--title`, `--subtitle`, `--base-url`, `--hours`, `--sitemap-url`, `--sitemap-out`) override config when passed.

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
bun script/resize-cover-images.js # resizes covers to 200px and uploads
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
- **URL encoding**: Paths and filenames encoded with `encodeURI()` in `ui.js`. Proxy forwards as-is. S3 stores with literal spaces.
- **Cover images**: `capa-min.jpg` at 200px wide (~10 KB). Generated by `resize-cover-images.js`. Missing covers show SVG placeholder (data-URI, zero network requests).
- **Virtual grid**: ~30 DOM nodes always in the grid regardless of library size. `VirtualGrid` uses absolute positioning + `ResizeObserver`.
- **Range requests**: Proxy forwards `Range` headers to S3; returns 206 for partial content — required for seek without full download.
- **S3 bucket policy**: Needs public `GetObject` on `*` and `PutObject` on `{prefix}/*` for the service account.

## Troubleshooting

**404 on audio/covers**: Check S3 path — `{prefix}/{album.path}/{file}`. Sync may be incomplete.

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
curl -sI -H "Range: bytes=0-1000" "https://cdn.tocador.cc/indie/<album>/<track>.mp3"
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
