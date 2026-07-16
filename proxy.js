#!/usr/bin/env bun

// §8 — concurrency tracking with hard caps, two tiers.
// Mobile carriers put many distinct users behind one CGNAT IP, so limiting by
// raw IP alone conflates them — a handful of people listening from the same
// carrier trips a limit sized for one person. We fingerprint by IP + User-Agent
// (already sent by every browser, no client changes needed) to give each real
// listener their own budget, and keep a much looser raw-IP ceiling underneath
// as a backstop against genuine abuse (e.g. UA spoofing from a single address).
const MAP_HARD_CAP = 50_000;

const deviceCounts = new Map();
const deviceLastSeen = new Map();
function incDevice(key) {
  if (deviceCounts.size >= MAP_HARD_CAP && !deviceCounts.has(key)) return false;
  deviceCounts.set(key, (deviceCounts.get(key) ?? 0) + 1);
  deviceLastSeen.set(key, Date.now());
  return true;
}
function decDevice(key) {
  const n = (deviceCounts.get(key) ?? 1) - 1;
  if (n <= 0) { deviceCounts.delete(key); deviceLastSeen.delete(key); }
  else deviceCounts.set(key, n);
}

const rawIpCounts = new Map();
const rawIpLastSeen = new Map();
function incRawIp(ip) {
  if (rawIpCounts.size >= MAP_HARD_CAP && !rawIpCounts.has(ip)) return false;
  rawIpCounts.set(ip, (rawIpCounts.get(ip) ?? 0) + 1);
  rawIpLastSeen.set(ip, Date.now());
  return true;
}
function decRawIp(ip) {
  const n = (rawIpCounts.get(ip) ?? 1) - 1;
  if (n <= 0) { rawIpCounts.delete(ip); rawIpLastSeen.delete(ip); }
  else rawIpCounts.set(ip, n);
}
setInterval(() => {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [k, ts] of deviceLastSeen) if (ts < cutoff) { deviceCounts.delete(k); deviceLastSeen.delete(k); }
  for (const [k, ts] of rawIpLastSeen) if (ts < cutoff) { rawIpCounts.delete(k); rawIpLastSeen.delete(k); }
}, 60_000).unref();

// §4 — token bucket rate limit (audio only).
// Per-device: 30 req burst, 0.5 tokens/s refill (~30/min) — sized for one real
// listener, same numbers as before this now applies per-device instead of per-IP.
// Per-raw-IP backstop: far looser, only there to bound one address regardless
// of how many (possibly spoofed) UAs it presents.
const BUCKET_CAP = 30;
const BUCKET_REFILL = 0.5;
const deviceTokenBuckets = new Map();
const RAW_BUCKET_CAP = 300;
const RAW_BUCKET_REFILL = 5;
const rawIpTokenBuckets = new Map();
const RAW_CONCURRENCY_CAP = 50;

// /report-error rate limit: client already caps itself to 3 reports per page
// load, but a misbehaving or malicious client could otherwise spam GitHub
// issue creation indefinitely — cap per raw IP regardless.
const REPORT_BUCKET_CAP = 5;
const REPORT_BUCKET_REFILL = 1 / 60; // 1 token/min after the initial burst
const reportTokenBuckets = new Map();

function takeFrom(map, key, cap, refill) {
  const now = Date.now();
  const b = map.get(key);
  if (!b) { map.set(key, { tokens: cap - 1, last: now }); return true; }
  const elapsed = (now - b.last) / 1000;
  b.tokens = Math.min(cap, b.tokens + elapsed * refill);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, b] of deviceTokenBuckets) if (b.last < cutoff) deviceTokenBuckets.delete(k);
  for (const [k, b] of rawIpTokenBuckets) if (b.last < cutoff) rawIpTokenBuckets.delete(k);
  for (const [k, b] of reportTokenBuckets) if (b.last < cutoff) reportTokenBuckets.delete(k);
}, 5 * 60_000).unref();

// FNV-1a 32-bit — cheap, fixed-size fingerprint derived from the User-Agent.
// Only needs to separate concurrent listeners sharing a CGNAT IP, not resist
// deliberate forgery; the raw-IP backstop above covers that case.
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
function deviceKey(ip, req) {
  const ua = req.headers.get('user-agent') ?? '';
  return `${ip}#${hashString(ua.slice(0, 256))}`;
}

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
    console.log(`[stats] active=${activeRequests} 2xx=${counters.ok} 4xx=${counters.c4xx} 5xx=${counters.c5xx} lag=${eventLoopLag}ms devices=${deviceCounts.size} ips=${rawIpCounts.size}`);
    counters.ok = counters.c4xx = counters.c5xx = 0;
  }
}, 10_000).unref();

function metricsBody() {
  const m = process.memoryUsage();
  return [
    `# TYPE tocador_active_requests gauge`,
    `tocador_active_requests ${activeRequests}`,
    `tocador_ip_map_size ${rawIpCounts.size}`,
    `tocador_device_map_size ${deviceCounts.size}`,
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
// SigV4 requires encoding all chars except A-Z a-z 0-9 - _ . ~
// encodeURIComponent leaves ! ' ( ) * unencoded; add them manually
function sigV4Encode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, c =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

async function s3GetSigned(bucket, key, rangeHeader) {
  const now = new Date();
  const amzDate  = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const encodedKey = key.split('/').map(sigV4Encode).join('/');
  const url = new URL(`/${bucket}/${encodedKey}`, S3_ENDPOINT);
  const host = url.host;

  const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const headers = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (rangeHeader) headers['range'] = rangeHeader;

  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.entries(headers).sort(([a], [b]) => a < b ? -1 : 1)
    .map(([k, v]) => `${k}:${v}\n`).join('');
  const canonicalUri = url.pathname;
  const canonicalRequest = `GET\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const credScope = `${dateStamp}/${S3_REGION}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credScope}\n${await sha256hex(canonicalRequest)}`;

  let sigKey = await hmacSHA256(`AWS4${S3_SECRET_KEY}`, dateStamp);
  sigKey = await hmacSHA256(sigKey, S3_REGION);
  sigKey = await hmacSHA256(sigKey, 's3');
  sigKey = await hmacSHA256(sigKey, 'aws4_request');
  const sig = Array.from(await hmacSHA256(sigKey, stringToSign)).map(b => b.toString(16).padStart(2, '0')).join('');

  const auth = `AWS4-HMAC-SHA256 Credential=${S3_ACCESS_KEY}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;
  return fetch(url.href, { headers: { ...headers, Authorization: auth } });
}

// Forward a request to S3 via one signed fetch, passing S3's own headers
// (Content-Range with total size, Content-Length, ETag) straight through.
// Used for keys Bun's S3Client mishandles (# ?) and for open-ended Range
// requests, where it saves the separate stat() round trip.
async function signedPassthrough(bucket, path, rangeHeader, isHead) {
  const r = await s3GetSigned(bucket, path, isHead ? null : rangeHeader);
  if (!r.ok && r.status !== 206) {
    const code = r.status >= 500 ? 500 : r.status;
    if (code >= 500) counters.c5xx++; else counters.c4xx++;
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
  counters.ok++;
  return new Response(isHead ? null : r.body, { status: isHead ? 200 : r.status, headers: fwdHeaders });
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

// Legitimate crawlers we want to let through — Google indexing + og:image rendering
const goodBotRegex = /googlebot|googleother|google-inspectiontool|google-extended|adsbot-google|mediapartners-google|google-read-aloud|apis-google/i;

const botRegex = new RegExp([
  // automation & headless browsers
  'scrapy', 'selenium(?:-webdriver)?', 'puppeteer', 'playwright', 'phantomjs', 'casperjs',
  'headless\\s*(?:chrome|browser)?', 'headlesschrome',
  'automation\\s*tool', 'automated\\s*browser', 'bot\\s*automation',
  'httpclient', 'http\\s*client', 'axios\\/\\d+', 'node-fetch', 'got\\/\\d+',
  'mechanize', 'urllib', 'requests\\/\\d+', 'okhttp', 'retrofit', 'wget\\/', 'httrack', 'aria2', 'lftp', 'webcopy',
  'web\\s*scraper', 'data\\s*scraper', 'content\\s*scraper',
  'mass\\s*(?:crawl|scrape|download)', 'bulk\\s*(?:crawl|download|fetch)',
  'site\\s*crawler', 'link\\s*crawler',
  'botkit', 'dialogflow', 'rasa', 'botpress',
  'datacenter\\s*proxy', 'residential\\s*proxy', 'rotating\\s*proxy', 'proxy\\s*(?:rotation|pool)',
  'tor\\s*exit', 'tor\\s+network',
  'jsdom', 'cheerio', 'python-requests', 'python\\s*urllib', 'aiohttp', 'go-http-client', 'java\\/\\d+\\.\\d+',
  'aws\\s*lambda', 'google\\s*cloud\\s*functions', 'azure\\s*functions',
  'bot\\s*engine', 'crawler\\s*engine', 'spider\\s*engine',
  'auto\\s*fetch', 'auto\\s*scrape', 'auto\\s*crawl',
  // search engines (Google crawlers intentionally absent — we want sitemap indexing;
  // goodBotRegex still exempts them from the generic 'bot' catch-all below)
  'bingbot', 'msnbot', 'adidxbot', 'bingpreview',
  'slurp', 'duckduckbot', 'baiduspider', 'yandexbot', 'sogou', 'exabot',
  'applebot', 'petalbot', 'bytespider', 'seznambot', 'qwantify', 'mojeek', 'neevabot',
  '360spider', 'haosouspider', 'sosospider',
  // archive
  'ia_archiver', 'archive\\.org_bot',
  // social media crawlers
  'facebookexternalhit', 'facebookcatalog',
  'twitterbot', 'linkedinbot', 'discordbot', 'pinterestbot', 'slackbot', 'telegrambot', 'whatsapp',
  // SEO / analytics tools
  'semrushbot', 'ahrefsbot', 'mj12bot', 'dotbot', 'rogerbot',
  'screaming\\s*frog', 'sistrix', 'serpstat', 'similarweb', 'netcraft', 'dataforseo', 'netsystemsresearch',
  // AI / LLM crawlers
  'gptbot', 'chatgpt-user', 'openai-searchbot', 'claudebot', 'claude-web', 'anthropic-ai', 'cohere-ai', 'ccbot', 'amazonbot', 'diffbot',
  // security scanners
  'censys', 'shodan', 'masscan', 'zgrab', 'nuclei', 'nikto', 'sqlmap', 'wfuzz', 'dirbuster', 'gobuster', 'ffuf', 'nmap\\s*scripting',
  'openvas', 'qualys', 'tenable', 'acunetix', 'burpsuite', 'zap(?:\\s*proxy)?',
  // feed readers
  'feedfetcher', 'feedly', 'inoreader', 'newsblur',
  // generic catch-all
  'bot', 'crawler', 'spider',
].join('|'), 'i');

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

    if (req.headers.get('host') === 'uqt.xn--2dk.xyz')
      return Response.redirect('https://tocador.cc/', 301);

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

    // block all bots globally — /health and /metrics above are exempt (internal use)
    // goodBotRegex exceptions are let through (Google indexing + og:image crawling)
    const ua = req.headers.get('user-agent') ?? '';
    if (botRegex.test(ua) && !goodBotRegex.test(ua)) {
      console.log(`[BLOCKED] bot: ${ua.slice(0, 120)}`);
      counters.c4xx++;
      return new Response('Forbidden', { status: 403, headers: corsBase });
    }

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS' } });
    }

    // POST /report-error — body size already capped by maxRequestBodySize: 8192
    if (req.method === 'POST' && url.pathname === '/report-error') {
      const reportIp = realIp(req, server);
      if (!takeFrom(reportTokenBuckets, reportIp, REPORT_BUCKET_CAP, REPORT_BUCKET_REFILL)) {
        counters.c4xx++;
        return new Response('Too Many Requests', { status: 429, headers: { ...corsBase, 'Retry-After': '60' } });
      }
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
      const ghHeaders = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'tocador-proxy',
      };
      const normalizedTitle = title.slice(0, 200);
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
          if (cr.ok) counters.ok++; else counters.c5xx++;
          return new Response(cr.ok ? 'Commented' : 'GitHub error', { status: cr.ok ? 200 : cr.status, headers: corsBase });
        }

        const gh = await fetch('https://api.github.com/repos/rafapolo/tocador/issues', {
          method: 'POST', headers: ghHeaders,
          body: JSON.stringify({ title: normalizedTitle, body, labels: ['bug'] }),
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

    // §3 — resolve client IP + device fingerprint only for audio (images are unrestricted)
    const ip = isAudio ? realIp(req, server) : null;
    const device = ip ? deviceKey(ip, req) : null;

    // §4 — token bucket: per-device (30 req burst, 0.5 tokens/s ≈ 30/min) plus a
    // looser per-raw-IP backstop so one address can't evade the limit with spoofed UAs.
    if (device && (!takeFrom(deviceTokenBuckets, device, BUCKET_CAP, BUCKET_REFILL)
                || !takeFrom(rawIpTokenBuckets, ip, RAW_BUCKET_CAP, RAW_BUCKET_REFILL))) {
      counters.c4xx++;
      return new Response('Too Many Requests', { status: 429, headers: { ...corsBase, 'Retry-After': '60' } });
    }

    // Concurrency limits: 5 simultaneous audio streams per device, 50 per raw IP
    // (the raw-IP ceiling only matters when many devices share one CGNAT address).
    if (device) {
      const deviceActive = deviceCounts.get(device) ?? 0;
      if (deviceActive >= 5) {
        counters.c4xx++;
        return new Response('Too Many Requests', { status: 429, headers: { ...corsBase, 'Retry-After': '5' } });
      }
      const rawActive = rawIpCounts.get(ip) ?? 0;
      if (rawActive >= RAW_CONCURRENCY_CAP) {
        counters.c4xx++;
        return new Response('Too Many Requests', { status: 429, headers: { ...corsBase, 'Retry-After': '5' } });
      }
      if (!incDevice(device) || !incRawIp(ip)) { counters.c5xx++; return new Response('Service Unavailable', { status: 503, headers: corsBase }); }
    }

    // Global concurrency ceiling
    if (activeRequests >= MAX_CONCURRENT) {
      if (device) { decDevice(device); decRawIp(ip); }
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
        return await signedPassthrough(bucket, path, rangeHeader, isHead);
      }

      const file = s3.file(s3Key, { bucket });
      let stat; // reusable

      if (isHead) {
        // §9 — HEAD: one S3 stat call, return headers only
        try {
          stat = await file.stat();
        } catch (err) {
          counters.c4xx++;
          return new Response('Not Found', { status: 404, headers: corsBase });
        }
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
          // Open range bytes=start-: forward to S3 in one signed request — its 206
          // Content-Range already carries the total size, so no separate stat() needed.
          return await signedPassthrough(bucket, path, rangeHeader, false);
        }
      } else {
        // Full GET: stat for Content-Length so browser can show scrubber and seek
        try {
          stat = await file.stat();
        } catch (err) {
          counters.c4xx++;
          return new Response('Not Found', { status: 404, headers: corsBase });
        }
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
      if (device) { decDevice(device); decRawIp(ip); }
    }
  },

  error(err) {
    console.error('[server]', err.message);
    counters.c5xx++;
    return new Response('Internal Server Error', { status: 500, headers: corsBase });
  },
});

console.log(`Proxy listening on :${PORT} -> s3://${BUCKET}/`);
