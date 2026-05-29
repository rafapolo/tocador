#!/usr/bin/env bun

// §8 — ip concurrency tracking with hard cap
const IP_MAP_HARD_CAP = 50_000;
const ipCounts = new Map();
const ipLastSeen = new Map();

function incIp(ip) {
  if (ipCounts.size >= IP_MAP_HARD_CAP && !ipCounts.has(ip)) return false;
  ipCounts.set(ip, (ipCounts.get(ip) ?? 0) + 1);
  ipLastSeen.set(ip, Date.now());
  return true;
}
function decIp(ip) {
  const n = (ipCounts.get(ip) ?? 1) - 1;
  if (n <= 0) { ipCounts.delete(ip); ipLastSeen.delete(ip); }
  else ipCounts.set(ip, n);
}
setInterval(() => {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [ip, ts] of ipLastSeen) if (ts < cutoff) { ipCounts.delete(ip); ipLastSeen.delete(ip); }
}, 60_000).unref();

// §4 — token bucket rate limit (audio only, 30 req cap, 0.5 tokens/s refill)
const BUCKET_CAP = 30;
const BUCKET_REFILL = 0.5;
const tokenBuckets = new Map();

function take(ip) {
  const now = Date.now();
  const b = tokenBuckets.get(ip);
  if (!b) { tokenBuckets.set(ip, { tokens: BUCKET_CAP - 1, last: now }); return true; }
  const elapsed = (now - b.last) / 1000;
  b.tokens = Math.min(BUCKET_CAP, b.tokens + elapsed * BUCKET_REFILL);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [ip, b] of tokenBuckets) if (b.last < cutoff) tokenBuckets.delete(ip);
}, 5 * 60_000).unref();

// §13 — observability: event-loop lag + aggregate counters
let activeRequests = 0;
let eventLoopLag = 0;
let _lastTick = Date.now();
const counters = { ok: 0, c4xx: 0, c5xx: 0 };

setInterval(() => {
  const now = Date.now(); eventLoopLag = now - _lastTick - 1000; _lastTick = now;
}, 1000).unref();

setInterval(() => {
  if (counters.ok + counters.c4xx + counters.c5xx > 0) {
    console.log(`[stats] active=${activeRequests} 2xx=${counters.ok} 4xx=${counters.c4xx} 5xx=${counters.c5xx} lag=${eventLoopLag}ms ipmap=${ipCounts.size}`);
    counters.ok = counters.c4xx = counters.c5xx = 0;
  }
}, 10_000).unref();

function metricsBody() {
  const m = process.memoryUsage();
  return [
    `# TYPE tocador_active_requests gauge`,
    `tocador_active_requests ${activeRequests}`,
    `tocador_ip_map_size ${ipCounts.size}`,
    `tocador_event_loop_lag_ms ${eventLoopLag}`,
    `tocador_memory_rss_bytes ${m.rss}`,
    `tocador_memory_heap_used_bytes ${m.heapUsed}`,
    `tocador_requests_total{code="2xx"} ${counters.ok}`,
    `tocador_requests_total{code="4xx"} ${counters.c4xx}`,
    `tocador_requests_total{code="5xx"} ${counters.c5xx}`,
  ].join('\n') + '\n';
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
  if (k.endsWith('.gz'))
    return 'public, max-age=300, must-revalidate';
  return 'public, max-age=3600';
}

// Minimal AWS Signature V4 — used only for S3 keys Bun's client fails on (# and ?)
const S3_ENDPOINT  = process.env.S3_ENDPOINT  ?? '';
const S3_ACCESS_KEY = process.env.AWS_ACCESS_KEY_ID ?? '';
const S3_SECRET_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? '';
const S3_REGION    = 'hel1';

async function hmacSHA256(key, data) {
  const k = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data)));
}
async function sha256hex(data) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function s3GetSigned(bucket, key, rangeHeader) {
  const now = new Date();
  const amzDate  = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const encodedKey = key.split('/').map(seg => encodeURIComponent(seg)).join('/');
  const url = `${S3_ENDPOINT}/${bucket}/${encodedKey}`;
  const host = new URL(S3_ENDPOINT).host;

  const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const headers = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (rangeHeader) headers['range'] = rangeHeader;

  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.entries(headers).sort(([a], [b]) => a < b ? -1 : 1)
    .map(([k, v]) => `${k}:${v}\n`).join('');
  const canonicalUri = `/${bucket}/${encodedKey}`;
  const canonicalRequest = `GET\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const credScope = `${dateStamp}/${S3_REGION}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credScope}\n${await sha256hex(canonicalRequest)}`;

  let sigKey = await hmacSHA256(`AWS4${S3_SECRET_KEY}`, dateStamp);
  sigKey = await hmacSHA256(sigKey, S3_REGION);
  sigKey = await hmacSHA256(sigKey, 's3');
  sigKey = await hmacSHA256(sigKey, 'aws4_request');
  const sig = Array.from(await hmacSHA256(sigKey, stringToSign)).map(b => b.toString(16).padStart(2, '0')).join('');

  const auth = `AWS4-HMAC-SHA256 Credential=${S3_ACCESS_KEY}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;
  return fetch(url, { headers: { ...headers, Authorization: auth } });
}

// §1 — path traversal guard: reject .., ., NUL, backslash, empty segments
function isSafeKey(key) {
  if (key.length === 0 || key.length > 1024) return false;
  if (key.includes('\0') || key.includes('\\')) return false;
  for (const seg of key.split('/')) {
    if (seg === '..' || seg === '.' || seg === '') return false;
  }
  return true;
}

// §6 — Range header regex (hoisted to avoid per-request allocation)
const RANGE_RE = /^bytes=(\d{0,15})-(\d{0,15})$/;

// §3 — XFF trust boundary: only believe X-Forwarded-For from trusted proxies
const TRUSTED_PROXIES = new Set(
  (process.env.TRUSTED_PROXY_IPS ?? '127.0.0.1,::1').split(',').filter(Boolean)
);
function realIp(req, server) {
  const sock = server.requestIP(req);
  const remoteIp = sock?.address ?? '0.0.0.0';
  if (!TRUSTED_PROXIES.has(remoteIp)) return remoteIp;
  const xff = req.headers.get('x-forwarded-for');
  if (!xff) return remoteIp;
  return xff.split(',', 1)[0].trim().slice(0, 64) || remoteIp;
}

// §5 — hotlink protection: audio only; images (covers) are explicitly exempt
const ALLOWED_ORIGINS = new Set([
  'https://rafapolo.github.io',
  'https://cdn.tocador.cc',
  'https://radio.tocador.cc',
  'https://tocador.cc',
  'http://localhost:9001',
]);
function refererAllowed(req) {
  const ref = req.headers.get('referer') ?? req.headers.get('origin');
  if (!ref) return true;
  try {
    const u = new URL(ref);
    return ALLOWED_ORIGINS.has(`${u.protocol}//${u.host}`);
  } catch { return true; }
}

const botRegex = /scrapy|selenium(?:-webdriver)?|puppeteer|playwright|phantomjs|casperjs|headless\s*(chrome|browser)?|headlesschrome|automation\s*tool|automated\s*browser|bot\s*automation|httpclient|http\s*client|axios\/\d+|node-fetch|got\/\d+|mechanize|urllib|requests\/\d+|okhttp|retrofit|wget\/|httrack|aria2|lftp|webcopy|web\s*scraper|data\s*scraper|content\s*scraper|mass\s*(crawl|scrape|download)|bulk\s*(crawl|download|fetch)|site\s*crawler|link\s*crawler|botkit|dialogflow|rasa|botpress|datacenter\s*proxy|residential\s*proxy|rotating\s*proxy|proxy\s*rotation|proxy\s*pool|tor\s*exit|tor\s+network|jsdom|cheerio|aws\s*lambda|google\s*cloud\s*functions|azure\s*functions|python-requests|python\s*urllib|aiohttp|go-http-client|java\/\d+\.\d+|bot\s*engine|crawler\s*engine|spider\s*engine|auto\s*fetch|auto\s*scrape|auto\s*crawl/i;

const BUCKET = process.env.S3_BUCKET;
const BUCKET_MAP = Object.fromEntries(
  (process.env.S3_BUCKET_MAP ?? '').split(',').filter(Boolean)
    .map(e => { const [p, b] = e.split(':'); return [p, b]; })
);
function bucketFor(key) {
  for (const [prefix, bucket] of Object.entries(BUCKET_MAP)) {
    if (key.startsWith(prefix)) return bucket;
  }
  return BUCKET;
}

const PORT = Number(process.env.PORT) || 9001;
const MAX_CONCURRENT = 400;

const s3 = new Bun.S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: 'hel1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

// §12 — graceful shutdown: drain up to 25s on SIGTERM/SIGINT/uncaughtException
let shuttingDown = false;
let _server;

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} — draining (${activeRequests} active)`);
  _server?.stop(false);
  setTimeout(() => { console.error('[shutdown] drain timeout, forcing exit'); process.exit(1); }, 25_000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('uncaughtException',  (err) => { console.error('uncaughtException:', err);  gracefulShutdown('uncaughtException'); });
process.on('unhandledRejection', (r)   => { console.error('unhandledRejection:', r); });

_server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',   // §3 — never 0.0.0.0; only nginx on loopback connects here
  maxRequestBodySize: 8192, // §2/§10 — guards POST body upload (report-error) and slow-body attacks

  async fetch(req, server) {
    if (shuttingDown) return new Response('Service Unavailable', { status: 503, headers: corsBase });

    // §2 — reject oversized URLs before any parsing
    if (req.url.length > 1200) { counters.c4xx++; return new Response('URI Too Long', { status: 414, headers: corsBase }); }

    const url = new URL(req.url);

    if (req.headers.get('host') === 'radio.tocador.cc')
      return Response.redirect('https://rafapolo.github.io/tocador/radio.html', 301);

    // §13 — enriched health: reports saturation and event-loop lag; haloy removes node before it becomes a black hole
    if (url.pathname === '/health') {
      const degraded = shuttingDown || activeRequests >= MAX_CONCURRENT * 0.9 || eventLoopLag > 500;
      counters.ok++;
      return new Response(
        JSON.stringify({ status: degraded ? 'degraded' : 'ok', activeRequests, eventLoopLag }),
        { status: degraded ? 503 : 200, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' } }
      );
    }

    // §13 — Prometheus metrics (port 9002 is not exposed externally)
    if (url.pathname === '/metrics') {
      return new Response(metricsBody(), { headers: { 'Content-Type': 'text/plain; version=0.0.4' } });
    }

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS' } });
    }

    // POST /report-error — body size already capped by maxRequestBodySize: 8192
    if (req.method === 'POST' && url.pathname === '/report-error') {
      const token = process.env.GITHUB_TOKEN;
      if (!token) return new Response('Not configured', { status: 503, headers: corsBase });
      let payload;
      try { payload = await req.json(); }
      catch { counters.c4xx++; return new Response('Bad Request', { status: 400, headers: corsBase }); }
      const { title, body } = payload;
      if (!title || typeof title !== 'string' || typeof body !== 'string') {
        counters.c4xx++;
        return new Response('Bad Request', { status: 400, headers: corsBase });
      }
      try {
        const gh = await fetch('https://api.github.com/repos/rafapolo/tocador/issues', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'User-Agent': 'tocador-proxy',
          },
          body: JSON.stringify({ title: title.slice(0, 200), body, labels: ['bug'] }),
        });
        if (gh.ok) counters.ok++; else counters.c5xx++;
        return new Response(gh.ok ? 'Created' : 'GitHub error', { status: gh.ok ? 201 : gh.status, headers: corsBase });
      } catch (err) {
        console.error('report-error failed:', err.message);
        counters.c5xx++;
        return new Response('Bad Gateway', { status: 502, headers: corsBase });
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      counters.c4xx++;
      return new Response('Method Not Allowed', { status: 405, headers: corsBase });
    }

    const ua = req.headers.get('user-agent') ?? '';
    if (botRegex.test(ua)) {
      console.log(`[BLOCKED] bot: ${ua.slice(0, 100)}`);
      counters.c4xx++;
      return new Response('Forbidden', { status: 403, headers: corsBase });
    }

    // §1 — decode path with try/catch; malformed percent-sequences return 400 instead of crashing
    let path;
    try { path = decodeURIComponent(url.pathname.replace(/^\/+/, '')).normalize('NFC'); }
    catch { counters.c4xx++; return new Response('Bad Request', { status: 400, headers: corsBase }); }

    if (!path) return Response.redirect('https://rafapolo.github.io/uqt/3d', 301);

    // §1 — path traversal: reject .., empty segments, NUL, backslash
    if (!isSafeKey(path)) { counters.c4xx++; return new Response('Bad Request', { status: 400, headers: corsBase }); }

    const s3Key = path;

    // §6 — Range: reject malformed and multi-range (multi-range never used by audio players)
    const rangeHeader = req.headers.get('range');
    if (rangeHeader && (rangeHeader.length > 128 || !RANGE_RE.test(rangeHeader))) {
      counters.c4xx++;
      return new Response('Bad Request', { status: 400, headers: corsBase });
    }

    const isAudio = /\.(mp3|mp4|m4a)$/i.test(path);
    const isHead  = req.method === 'HEAD';

    // §5 — hotlink block for audio; radio embeds (?ctx=radio or Referer contains /radio) pass through
    const isRadioCtx = url.searchParams.get('ctx') === 'radio'
                    || (req.headers.get('referer') ?? '').includes('/radio');
    if (isAudio && !isRadioCtx && !refererAllowed(req)) {
      console.warn(`[HOTLINK] ${realIp(req, server)} ref=${req.headers.get('referer')}`);
      counters.c4xx++;
      return new Response('Forbidden', { status: 403, headers: corsBase });
    }

    // §3 — resolve client IP only for audio (images are unrestricted)
    const ip = isAudio ? realIp(req, server) : null;

    // §4 — token bucket: 30 req burst, 0.5 tokens/s sustained (30/min)
    if (ip && !take(ip)) {
      counters.c4xx++;
      return new Response('Too Many Requests', { status: 429, headers: { ...corsBase, 'Retry-After': '60' } });
    }

    // Per-IP concurrency limit (5 simultaneous audio streams per IP)
    if (ip) {
      const ipActive = ipCounts.get(ip) ?? 0;
      if (ipActive >= 5) {
        counters.c4xx++;
        return new Response('Too Many Requests', { status: 429, headers: { ...corsBase, 'Retry-After': '5' } });
      }
      if (!incIp(ip)) { counters.c5xx++; return new Response('Service Unavailable', { status: 503, headers: corsBase }); }
    }

    // Global concurrency ceiling
    if (activeRequests >= MAX_CONCURRENT) {
      if (ip) decIp(ip);
      counters.c5xx++;
      return new Response('Too Many Requests', { status: 503, headers: corsBase });
    }

    activeRequests++;
    try {
      const bucket = bucketFor(path);
      let body, status, extra = {};

      // Bun's S3Client doesn't encode # or ? in keys, causing URL fragment/query truncation.
      // For those keys we bypass it and use a manually-signed fetch instead.
      if (path.includes('#') || path.includes('?')) {
        const fetchRange = isHead ? null : rangeHeader;
        const r = await s3GetSigned(bucket, path, fetchRange);
        if (!r.ok && r.status !== 206) {
          const code = r.status >= 500 ? 500 : r.status;
          if (code >= 500) counters.c5xx++; else counters.c4xx++;
          return new Response('Error', { status: code, headers: corsBase });
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
        counters.ok++;
        return new Response(isHead ? null : r.body, { status: isHead ? 200 : r.status, headers: fwdHeaders });
      }

      const file = s3.file(s3Key, { bucket });

      if (isHead) {
        // §9 — HEAD: one S3 stat call, return headers only
        const stat = await file.stat();
        status = 200; body = null;
        extra = {
          'Content-Length': String(stat.size),
          'Accept-Ranges': 'bytes',
          'ETag': stat.etag,
          'Last-Modified': stat.lastModified?.toUTCString(),
        };
      } else if (rangeHeader) {
        const m = RANGE_RE.exec(rangeHeader);
        const start = Number(m[1]);
        const endStr = m[2];
        if (endStr !== '') {
          // Fixed range bytes=start-end: Content-Length known, no stat needed
          const end = Number(endStr);
          status = 206; body = file.slice(start, end + 1).stream();
          extra = {
            'Content-Range': `bytes ${start}-${end}/*`,
            'Content-Length': String(end - start + 1),
            'Accept-Ranges': 'bytes',
          };
        } else {
          // Open range bytes=start-: need total size for Content-Range header
          const stat = await file.stat();
          const end = stat.size - 1;
          status = 206; body = file.slice(start).stream();
          extra = {
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Content-Length': String(stat.size - start),
            'Accept-Ranges': 'bytes',
            'ETag': stat.etag,
          };
        }
      } else {
        // Full GET: stat for Content-Length so browser can show scrubber and seek
        const stat = await file.stat();
        status = 200; body = file.stream();
        extra = {
          'Content-Length': String(stat.size),
          'Accept-Ranges': 'bytes',
          'ETag': stat.etag,
          'Last-Modified': stat.lastModified?.toUTCString(),
        };
      }

      const headers = {
        ...corsHeaders,
        'Content-Type': mimeFor(path),
        'Cache-Control': cacheControlFor(path),
        ...extra,
      };
      for (const k of Object.keys(headers)) if (headers[k] == null) delete headers[k];

      counters.ok++;
      return new Response(body, { status, headers });
    } catch (err) {
      const code = err?.status ?? err?.statusCode ?? 500;
      console.error(`[${code}] ${req.method} ${path}: ${err?.message ?? err}`);
      if (code >= 500) counters.c5xx++; else counters.c4xx++;
      return new Response(err?.name ?? 'Error', { status: code, headers: corsBase });
    } finally {
      activeRequests--;
      if (ip) decIp(ip);
    }
  },

  error(err) {
    console.error('[server]', err.message);
    counters.c5xx++;
    return new Response('Internal Server Error', { status: 500, headers: corsBase });
  },
});

console.log(`Proxy listening on :${PORT} -> s3://${BUCKET}/`);
