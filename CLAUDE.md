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
- **proxy.js** — Node.js reverse proxy on port 9001. Forwards requests to S3, adds CORS headers, sets correct MIME types, supports `Range` for audio seeking. Clustered across all CPU cores.
- **haloy.yaml** — Deployment config; deploys proxy to `uqt.xn--2dk.xyz`
- **Dockerfile** — Packages proxy.js for haloy deployment

### Scripts (`script/`)
- **generate-albums.js** — JS version (uses ffprobe); generates `.json.gz` from MP3s in `unzips/`
- **generate-albums/** — Rust version (uses id3 crate, parallel via rayon); preferred for large archives
- **sync-to-bucket.js** — Syncs local audio files to S3 bucket
- **resize-cover-images.js** — Resizes covers to 200px and uploads to S3
- **filter-albums-by-s3.js** — Removes albums from the JSON that have no matching S3 folder
- **find-untagged.js** — Lists MP3s missing ID3 tags
- **dedup-albums.js** — Detects duplicate albums by track fingerprint

## Acervos

Registered in `js/ui.js` → `KNOWN_ACERVOS`. Each entry has only `data` (URL to the `.json.gz`). **`base_url` is never set here** — it must be baked into the `.json.gz` via `--base-url` at generation time and is read from `db.meta.base_url` at load.

| alias | data URL | S3 prefix |
|---|---|---|
| `uqt` | `js/uqt-albums.json.gz` (GitHub raw) | `https://uqt.xn--2dk.xyz/uqt` |
| `homi` | `js/homi-albums.json.gz` (GitHub raw) | `https://uqt.xn--2dk.xyz/indie` |

Player priority for `base_url`: `db.meta.base_url` → `sessionStorage` → `''`.

External acervos work too: `?acervo=https://example.com/my-archive.json.gz`

## Acervo JSON format

```json
{
  "meta": {
    "title": "Nome do Acervo",
    "subtitle": "Subtítulo opcional",
    "hours": "705",
    "base_url": "https://uqt.xn--2dk.xyz/uqt"
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

Title, subtitle, base_url and hours are read from `acervo.json` in the music dir (see `config/`). No flags needed:

```bash
# uqt
./script/generate-albums/target/release/generate-albums \
  /Volumes/EXTRA/bkps/UQT/sambaderaiz \
  js/uqt-albums.json.gz

# hominiscanidae
./script/generate-albums/target/release/generate-albums \
  /Volumes/EXTRA/hominiscanidae/unzips \
  js/homi-albums.json.gz
```

CLI flags (`--title`, `--subtitle`, `--base-url`, `--hours`) override the config file when passed.

Build first: `cd script/generate-albums && cargo build --release`

### Generating an acervo (JS — requires ffprobe)

```bash
brew install ffmpeg   # once
node script/generate-albums.js
```

### Syncing audio to S3

```bash
node script/sync-to-bucket.js      # uploads diff (size-based) with 20 workers
node script/resize-cover-images.js # resizes covers to 200px and uploads
node script/filter-albums-by-s3.js # trims JSON to albums confirmed in S3
```

Requires `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET` in `.env`.

### Running the proxy locally

```bash
node proxy.js   # listens on :9001
curl -I http://localhost:9001/health
```

### Deploying

```bash
haloy deploy   # requires HALOY_API_TOKEN; deploys to uqt.xn--2dk.xyz
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
