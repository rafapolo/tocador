# tocador

Shared music player platform — the same player hosts multiple independent archives (acervos). Point it at any compatible `.json.gz` and it plays, with no build step.

## Architecture

### Frontend
- **index.html** — Main web app; no build step, served from GitHub Pages or any static CDN
- **js/ui.js** — All app logic: virtual grid, album/track rendering, playback, search/filter, acervo loading
- **assets/player.css** / **assets/uqt.css** — Styling
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

# hominiscanidae → ../hominiscanidae repo
./script/generate-albums/target/release/generate-albums \
  /Volumes/EXTRA/hominiscanidae/unzips \
  ../hominiscanidae/data/homi-albums.json.gz

# then regenerate the genre index (homi only)
bun script/build-genre-index.js
```

Then commit and push in each repo (including `data/homi-genres.json.gz`). CLI flags (`--title`, `--subtitle`, `--base-url`, `--hours`) override config when passed.

Build first: `cd script/generate-albums && cargo build --release`

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

```bash
haloy deploy   # requires HALOY_API_TOKEN; deploys to cdn.tocador.cc
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
