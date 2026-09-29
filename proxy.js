#!/usr/bin/env bun

import { sigV4Encode, s3GetSigned, keyCandidates, isSafeKey, bucketFor, BUCKET } from './lib/s3.js';
import { MAP_HARD_CAP, deviceCounts, rawIpCounts, incDevice, decDevice, incRawIp, decRawIp, heartbeatTokenBuckets, HEARTBEAT_BUCKET_CAP, HEARTBEAT_BUCKET_REFILL,
  BUCKET_CAP, BUCKET_REFILL, deviceTokenBuckets, RAW_BUCKET_CAP, RAW_BUCKET_REFILL, rawIpTokenBuckets, RAW_CONCURRENCY_CAP,
  REPORT_BUCKET_CAP, REPORT_BUCKET_REFILL, reportTokenBuckets, takeFrom, deviceKey } from './lib/limits.js';
import { state, RADIO_ID_RE, radioListeners, todayListenerIds, ensureToday, markOk, mark4xx, mark5xx,
  UPSTREAM_FAIL_THRESHOLD, markUpstreamOk, markUpstreamFail, metricsJSON } from './lib/metrics.js';
import { realIp, refererAllowed, blockedBot, goodBotRegex } from './lib/access.js';


// §15 — public /metrics auth. The password is fixed (md5("tocador.cc/metrics")),
// not a per-user secret, so a plain string compare is fine functionally — this
// is only to avoid leaking *how many characters matched* through a timing
// side-channel, cheap insurance for near-zero cost. Username is ignored.
const METRICS_PASSWORD = '610336c3eeea7dc0347bd58b3a197473'; // md5("tocador.cc/metrics")
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function metricsAuthorized(req) {
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Basic ')) return false;
  let decoded;
  try { decoded = atob(auth.slice(6)); } catch { return false; }
  const pass = decoded.slice(decoded.indexOf(':') + 1);
  return timingSafeEqual(pass, METRICS_PASSWORD);
}

// CORS — corsBase on all responses including errors (nosniff omitted to avoid CORB on text/plain error bodies)
const corsBase = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Type, Content-Range, ETag, Accept-Ranges',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};
const corsHeaders = { ...corsBase, 'X-Content-Type-Options': 'nosniff' };

// Single-hop 301 to the canonical domain, with CORS so a redirected fetch() still works
function redirect301(location) {
  return new Response(null, { status: 301, headers: { ...corsBase, Location: location, 'Cache-Control': 'public, max-age=3600' } });
}

// robots.txt for the proxy hosts (cdn./radio.). Covers and catalogs stay crawlable
// for image indexing; audio and the error endpoint are pure crawl-budget waste.
// No Sitemap: directive here — the sitemaps belong to https://tocador.cc.
const ROBOTS_TXT = `User-agent: *
Allow: /
Disallow: /report-error
Disallow: /radio-heartbeat
Disallow: /metrics
Disallow: /*.mp3$
Disallow: /*.m4a$
Disallow: /*.mp4$
`;

function mimeFor(key) {
  const k = key.toLowerCase();
  if (k.endsWith('.mp3')) return 'audio/mpeg';
  if (k.endsWith('.mp4') || k.endsWith('.m4a')) return 'audio/mp4';
  if (k.endsWith('.jpg') || k.endsWith('.jpeg')) return 'image/jpeg';
  if (k.endsWith('.png')) return 'image/png';
  if (k.endsWith('.webp')) return 'image/webp';
  if (k.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

function cacheControlFor(key) {
  const k = key.toLowerCase();
  if (k.endsWith('.jpg') || k.endsWith('.jpeg') || k.endsWith('.png') || k.endsWith('.webp'))
    return 'public, max-age=31536000, immutable';
  if (k.endsWith('.mp3') || k.endsWith('.mp4') || k.endsWith('.m4a'))
    return 'public, max-age=31536000';
  return 'public, max-age=3600';
}

// Forward a request to S3 via one signed fetch, passing S3's own headers
// (Content-Range with total size, Content-Length, ETag) straight through.
// Used for keys Bun's S3Client mishandles (# ?) and for open-ended Range
// requests, where it saves the separate stat() round trip.
async function signedPassthrough(bucket, path, rangeHeader, isHead) {
  let r;
  for (const key of keyCandidates(path)) {
    r = await s3GetSigned(bucket, key, isHead ? null : rangeHeader);
    if (r.status !== 404) break;
    r.body?.cancel().catch(() => {}); // don't leak the socket on a retried miss
  }
  markUpstreamOk(); // S3 answered at all — the link is up, whatever the status
  if (!r.ok && r.status !== 206) {
    const code = r.status >= 500 ? 500 : r.status;
    if (code >= 500) mark5xx(); else mark4xx();
    return new Response(code === 404 ? 'Not Found' : 'Error', { status: code, headers: corsBase });
  }
  const fwdHeaders = {
    ...corsHeaders,
    'Content-Type': mimeFor(path),
    'Cache-Control': cacheControlFor(path),
    'Accept-Ranges': 'bytes',
  };
  for (const h of ['content-length', 'content-range', 'etag', 'last-modified']) {
    const v = r.headers.get(h);
    if (v) fwdHeaders[h] = v;
  }
  markOk();
  // today.sent_MB: body bytes actually queued to send (HEAD sends no body).
  // Content-Length reflects what's being sent for this request — the full
  // file on a plain GET, just the requested slice on a 206 Range response.
  if (!isHead && fwdHeaders['content-length']) {
    ensureToday();
    state.todaySentBytes += Number(fwdHeaders['content-length']);
  }
  return new Response(isHead ? null : r.body, { status: isHead ? 200 : r.status, headers: fwdHeaders });
}


// §6 — Range header regex (hoisted to avoid per-request allocation)
const RANGE_RE = /^bytes=(\d{0,15})-(\d{0,15})$/;



const PORT = Number(process.env.PORT) || 9001;
const MAX_CONCURRENT = 400;

// §12 — graceful shutdown: drain up to 25s on SIGTERM/SIGINT/uncaughtException
let shuttingDown = false;
let _server;

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} — draining (${state.activeRequests} active)`);
  _server?.stop(false);
  setTimeout(() => { console.error('[shutdown] drain timeout, forcing exit'); process.exit(1); }, 25_000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('uncaughtException',  (err) => { console.error('uncaughtException:', err);  gracefulShutdown('uncaughtException'); });
process.on('unhandledRejection', (r)   => { console.error('unhandledRejection:', r); });

// Only bind a port when run as the entrypoint (`bun proxy.js`, and the
// Dockerfile CMD). Importing this file — which the tests do, so they exercise
// the real helpers instead of copies that can silently drift from them — must
// not start a server.
if (import.meta.main) startServer();

function startServer() {
_server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',   // §3 — never 0.0.0.0; only nginx on loopback connects here
  maxRequestBodySize: 8192, // §2/§10 — guards POST body upload (report-error) and slow-body attacks

  async fetch(req, server) {
    if (shuttingDown) return new Response('Service Unavailable', { status: 503, headers: corsBase });

    // §2 — reject oversized URLs before any parsing
    if (req.url.length > 1200) { mark4xx(); return new Response('URI Too Long', { status: 414, headers: corsBase }); }

    const url = new URL(req.url);

    // robots.txt must be served on every host, never redirected — a crawler that
    // gets a cross-host redirect for robots.txt treats the whole host as unreadable
    // ("Erro de redirecionamento" in Search Console). Covers stay crawlable so the
    // <image:image> entries in sitemap-albums.xml can still be indexed.
    if (url.pathname === '/robots.txt') {
      markOk();
      return new Response(ROBOTS_TXT, {
        headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' },
      });
    }

    // Host redirects always land on the canonical domain in a single hop; chaining
    // through rafapolo.github.io (which itself 301s back to tocador.cc via CNAME)
    // made Google see a redirect chain and drop the URL.
    if (req.headers.get('host') === 'radio.tocador.cc')
      return redirect301('https://tocador.cc/radio.html');

    if (req.headers.get('host') === 'uqt.xn--2dk.xyz')
      return redirect301('https://tocador.cc/');

    // §13 — enriched health: reports saturation and event-loop lag; haloy removes node before it becomes a black hole
    if (url.pathname === '/health') {
      const upstreamDown = state.upstreamFailStreak >= UPSTREAM_FAIL_THRESHOLD;
      const degraded = shuttingDown || state.activeRequests >= MAX_CONCURRENT * 0.9 || state.eventLoopLag > 500 || upstreamDown;
      markOk();
      return new Response(
        JSON.stringify({ status: degraded ? 'degraded' : 'ok', activeRequests: state.activeRequests, eventLoopLag: state.eventLoopLag, upstreamFailStreak: state.upstreamFailStreak }),
        { status: degraded ? 503 : 200, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' } }
      );
    }

    // §13/§15 — public JSON metrics, gated by HTTP Basic Auth (password only —
    // see METRICS_PASSWORD). nginx's location / catch-all forwards this straight
    // through same as everything else, so it's reachable at cdn.tocador.cc/metrics.
    if (url.pathname === '/metrics') {
      if (!metricsAuthorized(req)) {
        mark4xx();
        return new Response('Unauthorized', {
          status: 401,
          headers: { ...corsBase, 'WWW-Authenticate': 'Basic realm="tocador metrics"' },
        });
      }
      markOk();
      return new Response(JSON.stringify(metricsJSON()), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    // block all bots globally — /health and /metrics above are exempt (health checks
    // and metrics scraping aren't real listeners; /metrics is auth-gated anyway)
    // goodBotRegex exceptions are let through (Google indexing), and link-preview
    // crawlers may fetch images (see previewBotRegex)
    const ua = req.headers.get('user-agent') ?? '';
    if (blockedBot(ua, url.pathname)) {
      console.log(`[BLOCKED] bot: ${ua.slice(0, 120)}`);
      mark4xx();
      return new Response('Forbidden', { status: 403, headers: corsBase });
    }

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS' } });
    }

    // POST /report-error — body size already capped by maxRequestBodySize: 8192
    if (req.method === 'POST' && url.pathname === '/report-error') {
      // goodBotRegex UAs (Google indexing/read-aloud etc.) are let through the
      // proxy above to fetch pages/audio, but they're not real listeners — a
      // crawler hitting a decode quirk in its own renderer isn't a bug report.
      if (goodBotRegex.test(ua)) return new Response('OK', { status: 200, headers: corsBase });
      const reportIp = realIp(req, server);
      if (!takeFrom(reportTokenBuckets, reportIp, REPORT_BUCKET_CAP, REPORT_BUCKET_REFILL)) {
        mark4xx();
        return new Response('Too Many Requests', { status: 429, headers: { ...corsBase, 'Retry-After': '60' } });
      }
      const token = process.env.GITHUB_TOKEN;
      if (!token) return new Response('Not configured', { status: 503, headers: corsBase });
      let payload;
      try { payload = await req.json(); }
      catch { mark4xx(); return new Response('Bad Request', { status: 400, headers: corsBase }); }
      const { title, body } = payload;
      if (!title || typeof title !== 'string' || typeof body !== 'string') {
        mark4xx();
        return new Response('Bad Request', { status: 400, headers: corsBase });
      }
      const ghHeaders = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'tocador-proxy',
      };
      const normalizedTitle = title.slice(0, 200);
      // Verify "not playable" reports against the real file before creating GitHub
      // noise. #578-637 was 60 issues filed in one crawl (43 of them inside a single
      // 66-minute window) — automated traffic (headless/stealth browsers with no real
      // audio decoder, or navigator.webdriver spoofed false) reporting tracks that
      // fetch fine everywhere else. Every audio src in that wave returned 200 with a
      // valid audio/mpeg body when checked directly. Client-side dedup/caps can't stop
      // this reliably (each album gets its own title, so per-title dedup doesn't
      // collapse them, and bot UAs can mimic real ones) — so confirm the file is
      // actually broken server-side, which the report can't spoof, before filing.
      if (normalizedTitle.startsWith('[radio] not playable:')) {
        const srcMatch = body.match(/\*\*Audio src:\*\* `([^`]+)`/);
        const src = srcMatch?.[1];
        if (src && /^https:\/\/cdn\.tocador\.cc\//.test(src)) {
          try {
            const check = await fetch(src, { method: 'HEAD', headers: { Referer: 'https://tocador.cc/' }, signal: AbortSignal.timeout(5000) });
            const ct = check.headers.get('content-type') || '';
            const len = Number(check.headers.get('content-length') || 0);
            if (check.ok && ct.startsWith('audio/') && len > 10_000) {
              console.log(`[report-error] skipped, file verified playable: ${src}`);
              return new Response('OK (file verified playable)', { status: 200, headers: corsBase });
            }
          } catch (err) {
            // HEAD failed/timed out — corroborates rather than contradicts the
            // report, so fall through and file it.
          }
        }
      }
      try {
        // Deduplicate: comment on existing open issue instead of creating a new one
        let existingNumber = null;
        try {
          const q = encodeURIComponent(`repo:rafapolo/tocador is:issue is:open "${normalizedTitle}"`);
          const sr = await fetch(`https://api.github.com/search/issues?q=${q}&per_page=5`, { headers: ghHeaders });
          if (sr.ok) {
            const sd = await sr.json();
            existingNumber = sd.items?.find(i => i.title === normalizedTitle)?.number ?? null;
          }
        } catch {}

        if (existingNumber != null) {
          const cr = await fetch(`https://api.github.com/repos/rafapolo/tocador/issues/${existingNumber}/comments`, {
            method: 'POST', headers: ghHeaders, body: JSON.stringify({ body }),
          });
          if (cr.ok) markOk(); else mark5xx();
          return new Response(cr.ok ? 'Commented' : 'GitHub error', { status: cr.ok ? 200 : cr.status, headers: corsBase });
        }

        const gh = await fetch('https://api.github.com/repos/rafapolo/tocador/issues', {
          method: 'POST', headers: ghHeaders,
          body: JSON.stringify({ title: normalizedTitle, body, labels: ['bug'] }),
        });
        if (gh.ok) markOk(); else mark5xx();
        return new Response(gh.ok ? 'Created' : 'GitHub error', { status: gh.ok ? 201 : gh.status, headers: corsBase });
      } catch (err) {
        console.error('report-error failed:', err.message);
        mark5xx();
        return new Response('Bad Gateway', { status: 502, headers: corsBase });
      }
    }

    // §14 — POST /radio-heartbeat: radio.html beacons this every ~15s while its
    // <audio> is actually playing, plus once on stop (pause/tab close, via
    // sendBeacon) so the count drops immediately instead of waiting out the
    // sweep's 40s timeout. Body size already capped by maxRequestBodySize: 8192.
    if (req.method === 'POST' && url.pathname === '/radio-heartbeat') {
      if (goodBotRegex.test(ua)) return new Response(null, { status: 204, headers: corsBase }); // crawlers aren't listeners
      const hbIp = realIp(req, server);
      if (!takeFrom(heartbeatTokenBuckets, hbIp, HEARTBEAT_BUCKET_CAP, HEARTBEAT_BUCKET_REFILL)) {
        mark4xx();
        return new Response('Too Many Requests', { status: 429, headers: { ...corsBase, 'Retry-After': '15' } });
      }
      let payload;
      try { payload = await req.json(); }
      catch { mark4xx(); return new Response('Bad Request', { status: 400, headers: corsBase }); }
      const id = payload?.id;
      if (typeof id !== 'string' || !RADIO_ID_RE.test(id)) {
        mark4xx();
        return new Response('Bad Request', { status: 400, headers: corsBase });
      }
      if (payload?.stop === true) radioListeners.delete(id);
      else if (radioListeners.size < MAP_HARD_CAP || radioListeners.has(id)) radioListeners.set(id, Date.now());
      ensureToday();
      if (radioListeners.size > state.listenersPeakToday) state.listenersPeakToday = radioListeners.size;
      // today.uniqueListeners: even the stop beacon proves this id was
      // listening moments ago, so it still counts — only radioListeners (the
      // "now" count) removes it early.
      if (todayListenerIds.size < MAP_HARD_CAP || todayListenerIds.has(id)) todayListenerIds.add(id);
      state.todayHeartbeatTicks++;
      if (payload?.track === true) state.todayTracksPlayed++;
      markOk();
      return new Response(null, { status: 204, headers: corsBase });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      mark4xx();
      return new Response('Method Not Allowed', { status: 405, headers: corsBase });
    }

    // §1 — decode path with try/catch; malformed percent-sequences return 400 instead of crashing
    let path;
    // Deliberately NOT normalized here — see keyCandidates(). Normalizing to a
    // single form at the door silently 404s every key stored in the other one.
    try { path = decodeURIComponent(url.pathname.replace(/^\/+/, '')); }
    catch { mark4xx(); return new Response('Bad Request', { status: 400, headers: corsBase }); }

    if (!path) return redirect301('https://tocador.cc/3d.html');

    // §1 — path traversal: reject .., empty segments, NUL, backslash
    if (!isSafeKey(path)) { mark4xx(); return new Response('Bad Request', { status: 400, headers: corsBase }); }

    // §6 — Range: reject malformed and multi-range (multi-range never used by audio players)
    const rangeHeader = req.headers.get('range');
    if (rangeHeader && (rangeHeader.length > 128 || !RANGE_RE.test(rangeHeader))) {
      mark4xx();
      return new Response('Bad Request', { status: 400, headers: corsBase });
    }

    const isAudio = /\.(mp3|mp4|m4a)$/i.test(path);
    const isHead  = req.method === 'HEAD';

    // §5 — hotlink block for audio. The radio needs no exemption: it's served from
    // radio.tocador.cc / tocador.cc, both allowlisted. (A `?ctx=radio` / "Referer contains
    // /radio" bypass used to live here and let any site or curl skip the check.)
    if (isAudio && !refererAllowed(req)) {
      console.warn(`[HOTLINK] ${realIp(req, server)} ref=${req.headers.get('referer')}`);
      mark4xx();
      return new Response('Forbidden', { status: 403, headers: corsBase });
    }

    // §3 — resolve client IP + device fingerprint only for audio (images are unrestricted)
    const ip = isAudio ? realIp(req, server) : null;
    const device = ip ? deviceKey(ip, req) : null;

    // §4 — token bucket: per-device (30 req burst, 0.5 tokens/s ≈ 30/min) plus a
    // looser per-raw-IP backstop so one address can't evade the limit with spoofed UAs.
    if (device && (!takeFrom(deviceTokenBuckets, device, BUCKET_CAP, BUCKET_REFILL)
                || !takeFrom(rawIpTokenBuckets, ip, RAW_BUCKET_CAP, RAW_BUCKET_REFILL))) {
      mark4xx();
      return new Response('Too Many Requests', { status: 429, headers: { ...corsBase, 'Retry-After': '60' } });
    }

    // Concurrency limits: 5 simultaneous audio streams per device, 50 per raw IP
    // (the raw-IP ceiling only matters when many devices share one CGNAT address).
    if (device) {
      const deviceActive = deviceCounts.get(device) ?? 0;
      if (deviceActive >= 5) {
        mark4xx();
        return new Response('Too Many Requests', { status: 429, headers: { ...corsBase, 'Retry-After': '5' } });
      }
      const rawActive = rawIpCounts.get(ip) ?? 0;
      if (rawActive >= RAW_CONCURRENCY_CAP) {
        mark4xx();
        return new Response('Too Many Requests', { status: 429, headers: { ...corsBase, 'Retry-After': '5' } });
      }
      if (!incDevice(device) || !incRawIp(ip)) { mark5xx(); return new Response('Service Unavailable', { status: 503, headers: corsBase }); }
    }

    // Global concurrency ceiling
    if (state.activeRequests >= MAX_CONCURRENT) {
      if (device) { decDevice(device); decRawIp(ip); }
      mark5xx();
      return new Response('Too Many Requests', { status: 503, headers: corsBase });
    }

    state.activeRequests++;
    try {
      const bucket = bucketFor(path);

      // Every request — HEAD, fixed range, open range, full GET — goes through one
      // signed fetch to S3. A fixed byte-range (bytes=start-end) used to be served
      // natively via Bun.S3Client's file.slice().stream(), which can't report the
      // resource's real total size and fell back to a fabricated
      // "Content-Range: bytes start-end/*". Desktop browsers request open-ended
      // ranges and never hit that path, but mobile Safari's AVFoundation opens with
      // a small *fixed* probe range to learn the total size before it will commit
      // to playback — met with "/*" it reads the file as an unbounded/live stream
      // and abandons playback within a few seconds. Signed passthrough forwards
      // S3's own Content-Range (real total included) for every branch, so this
      // also covers the '#'/'?' key-encoding workaround Bun.S3Client needed and
      // the .stat() failures from the 2026-08-20 incident — there's no longer a
      // native-client path left to fall back to.
      return await signedPassthrough(bucket, path, rangeHeader, isHead);
    } catch (err) {
      const code = err?.status ?? err?.statusCode ?? 500;
      console.error(`[${code}] ${req.method} ${path}: ${err?.message ?? err}`);
      if (code >= 500) { mark5xx(); markUpstreamFail(); } else mark4xx();
      return new Response(err?.name ?? 'Error', { status: code, headers: corsBase });
    } finally {
      state.activeRequests--;
      if (device) { decDevice(device); decRawIp(ip); }
    }
  },

  error(err) {
    console.error('[server]', err.message);
    mark5xx();
    return new Response('Internal Server Error', { status: 500, headers: corsBase });
  },
});

console.log(`Proxy listening on :${PORT} -> s3://${BUCKET}/`);
}

// Exported for tests only — see tests/proxy.test.js. The suite must import
// these rather than re-declare them; a test that copies its subject cannot
// fail when the subject changes.
export { sigV4Encode, keyCandidates, isSafeKey, bucketFor, startServer, timingSafeEqual, metricsAuthorized, blockedBot, refererAllowed, RADIO_ID_RE };
