# UQT Proxy Setup Guide

## Overview

`proxy.js` is a Bun reverse proxy that fronts the private object storage bucket (endpoint read from `S3_ENDPOINT` env var). It serves audio and cover images to the web app with correct MIME types, CORS, long-lived cache headers, and HTTP Range support for seeking. Deployed as a container via [haloy](https://haloy.ミ.xyz) at **`https://uqt.ミ.xyz`**. Storage and compute are co-located, so egress is free.

## Architecture

```
browser → nginx :9001 → bun proxy.js :9002 → S3 (~1ms RTT, same-zone)
```

| File | Role |
|---|---|
| `proxy.js` | Bun HTTP server on `:9002`. Uses `Bun.S3Client` (native, no npm deps) to fetch objects from `$S3_BUCKET`. Sets MIME types, CORS, `Cache-Control`, and forwards `Range`/`Content-Range` for audio seeking. Exposes `/health` and `/metrics`. |
| `nginx.conf` | Listens on `:9001`. Rate-limits audio (`5r/s burst=8`) and `/report-error` (`2r/s`). Caches images 30 days in `/var/cache/nginx/images`. Maintains 128 keepalive connections upstream to Bun. Sets `X-Forwarded-For $remote_addr`. |
| `Dockerfile` | `oven/bun:1-alpine` + nginx. No npm install step — proxy has zero runtime npm deps. |
| `haloy.yaml` | Deploys to `uqt.ミ.xyz`, port `9001`, health check `/health`. Injects AWS credentials and `S3_ENDPOINT` from environment. |

A request to `https://uqt.ミ.xyz/uqt/<album>/<file>` maps to S3 object `$S3_BUCKET/uqt/<album>/<file>`.

## Security features

| Feature | Detail |
|---|---|
| Path traversal | Rejects `..`, `.`, empty segments, NUL bytes, backslashes before the key reaches S3. `decodeURIComponent` is wrapped in try/catch so malformed `%XX` sequences return 400 instead of crashing. |
| URL length limit | Requests with URL > 1200 chars return 414 before any parsing. |
| POST body limit | `maxRequestBodySize: 8192` in Bun.serve() guards `/report-error` against slow-body attacks. |
| XFF trust boundary | `X-Forwarded-For` is only trusted from `TRUSTED_PROXY_IPS` (default `127.0.0.1,::1`). Bun binds to `127.0.0.1` only — never `0.0.0.0`. |
| Token bucket | Audio requests: 30 req burst, 0.5 tokens/s sustained refill per IP. Complements nginx `limit_req`. |
| Per-IP concurrency | Max 5 simultaneous audio streams per IP at the Bun layer (nginx `limit_conn perip 6` is the primary defence). |
| Hotlink protection | Audio files blocked from unknown `Referer`/`Origin`. Radio embeds (`?ctx=radio` or Referer contains `/radio`) pass through. Cover images (`*.jpg/png/webp`) are explicitly exempt — scraping thumbs is acceptable and nginx caches them for 30 days. |
| Range validation | `Range` header must match `bytes=N-M` (single range, ≤ 15-digit offsets, ≤ 128 chars). Multi-range rejected. |
| Bot blocking | User-agent regex blocks scrapers, headless browsers, automation tools. |
| Graceful shutdown | `SIGTERM/SIGINT/uncaughtException` → `server.stop(false)` (drain) → 25s hard-kill. `/health` returns 503 during drain so haloy stops routing traffic before forceful exit. |

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | `200` with `{"status":"ok","activeRequests":N,"eventLoopLag":N}`. Returns `503 degraded` when saturated (≥90% of `MAX_CONCURRENT`) or event-loop lag > 500ms. nginx handles `/health` directly and short-circuits to Bun's version for internal checks. |
| `GET /metrics` | Prometheus text format. Only reachable on `:9002` (not exposed externally). Counters: active requests, IP map size, event-loop lag, RSS, heap, 2xx/4xx/5xx totals. |
| `POST /report-error` | Creates a GitHub issue. Requires `GITHUB_TOKEN` env var. Rate-limited by nginx (`2r/s`). |

## Deploying

```bash
export HALOY_API_TOKEN=...
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...

haloy deploy
```

`haloy.yaml` reads all three from the environment and passes the AWS pair through to the running container.

## Verifying the Deployment

```bash
curl -s https://uqt.ミ.xyz/health | jq .
# {"status":"ok","activeRequests":0,"eventLoopLag":-1}

curl -I "https://uqt.ミ.xyz/uqt/<album%20path>/capa-min.jpg"
# 200 OK, Content-Type: image/jpeg, X-Cache-Status: HIT (after first request)

curl -I "https://uqt.ミ.xyz/uqt/<album%20path>/track.mp3"
# 200 OK, Content-Type: audio/mpeg, Accept-Ranges: bytes
```

Then open the app and confirm a cover renders and an MP3 plays end-to-end.

## Local Testing

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export S3_ENDPOINT=...
export S3_BUCKET=...

bun proxy.js
# Proxy listening on :9001 -> s3://$S3_BUCKET/

curl -s http://localhost:9001/health | jq .
curl -I "http://localhost:9001/uqt/<album>/<file>.mp3"
```

Without credentials the proxy starts but every S3 request fails with an auth error.

## Troubleshooting

- **`/health` 200 but object requests 5xx** — container is running without AWS credentials. Re-export and redeploy.
- **CORB or MIME errors in browser** — extension missing from `mimeFor()` in `proxy.js` (falls back to `application/octet-stream`). Add it and redeploy.
- **404 on audio or cover** — file not synced yet. Check `$S3_BUCKET/<album.path>/<file>` exists; run `script/sync-to-bucket.js`.
- **`%2520` in URLs** — double-encoding. `js/ui.js` should call `encodeURI()` exactly once per path segment.
- **haloy deploy fails** — confirm `HALOY_API_TOKEN` is set; `haloy status` surfaces auth issues.
- **403 Forbidden on audio** — hotlink protection triggered. Add the requesting origin to `ALLOWED_ORIGINS` in `proxy.js`, or pass `?ctx=radio` for embeds.

## Performance Notes

- **Zero egress**: web server and storage bucket are co-located (~1ms RTT).
- **No npm runtime deps**: `proxy.js` uses only `Bun.S3Client` and `Bun.serve()` — no `node_modules` in the container.
- **nginx image cache**: covers cached 30 days in container memory (`/var/cache/nginx/images`, 2 GB max). Audio not cached — streamed directly to client via Range.
- **Single Bun process**: Bun's event loop handles I/O-bound S3 proxying efficiently without clustering. `MAX_CONCURRENT = 400` in-flight requests before 503.
- **Aggregate logging**: request stats logged every 10s (`[stats] active=N 2xx=N 4xx=N 5xx=N lag=Nms`) instead of per-request to reduce I/O overhead under load.
