// Rate limiting and concurrency caps: per-device and per-IP token buckets, in-flight
// counters and the device fingerprint. Stateless apart from its own Maps; split out of proxy.js.

// §8 — concurrency tracking with hard caps, two tiers.
// Mobile carriers put many distinct users behind one CGNAT IP, so limiting by
// raw IP alone conflates them — a handful of people listening from the same
// carrier trips a limit sized for one person. We fingerprint by IP + User-Agent
// (already sent by every browser, no client changes needed) to give each real
// listener their own budget, and keep a much looser raw-IP ceiling underneath
// as a backstop against genuine abuse (e.g. UA spoofing from a single address).
export const MAP_HARD_CAP = 50_000;

export const deviceCounts = new Map();
export const deviceLastSeen = new Map();
export function incDevice(key) {
  if (deviceCounts.size >= MAP_HARD_CAP && !deviceCounts.has(key)) return false;
  deviceCounts.set(key, (deviceCounts.get(key) ?? 0) + 1);
  deviceLastSeen.set(key, Date.now());
  return true;
}
export function decDevice(key) {
  const n = (deviceCounts.get(key) ?? 1) - 1;
  if (n <= 0) { deviceCounts.delete(key); deviceLastSeen.delete(key); }
  else deviceCounts.set(key, n);
}

export const rawIpCounts = new Map();
export const rawIpLastSeen = new Map();
export function incRawIp(ip) {
  if (rawIpCounts.size >= MAP_HARD_CAP && !rawIpCounts.has(ip)) return false;
  rawIpCounts.set(ip, (rawIpCounts.get(ip) ?? 0) + 1);
  rawIpLastSeen.set(ip, Date.now());
  return true;
}
export function decRawIp(ip) {
  const n = (rawIpCounts.get(ip) ?? 1) - 1;
  if (n <= 0) { rawIpCounts.delete(ip); rawIpLastSeen.delete(ip); }
  else rawIpCounts.set(ip, n);
}
setInterval(() => {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [k, ts] of deviceLastSeen) if (ts < cutoff) { deviceCounts.delete(k); deviceLastSeen.delete(k); }
  for (const [k, ts] of rawIpLastSeen) if (ts < cutoff) { rawIpCounts.delete(k); rawIpLastSeen.delete(k); }
}, 60_000).unref();

// Heartbeats are frequent by design (one every ~15s per real listener) but
// still per-device rate limited so a misbehaving client can't grow the map —
// cap comfortably above the real cadence rather than choking it.
export const HEARTBEAT_BUCKET_CAP = 6;
export const HEARTBEAT_BUCKET_REFILL = 1 / 10; // 1 token/10s after the initial burst
export const heartbeatTokenBuckets = new Map();

// §4 — token bucket rate limit (audio only).
// Per-device: 30 req burst, 0.5 tokens/s refill (~30/min) — sized for one real
// listener, same numbers as before this now applies per-device instead of per-IP.
// Per-raw-IP backstop: far looser, only there to bound one address regardless
// of how many (possibly spoofed) UAs it presents.
export const BUCKET_CAP = 30;
export const BUCKET_REFILL = 0.5;
export const deviceTokenBuckets = new Map();
export const RAW_BUCKET_CAP = 300;
export const RAW_BUCKET_REFILL = 5;
export const rawIpTokenBuckets = new Map();
export const RAW_CONCURRENCY_CAP = 50;

// /report-error rate limit: client already caps itself to 3 reports per page
// load, but a misbehaving or malicious client could otherwise spam GitHub
// issue creation indefinitely — cap per raw IP regardless.
export const REPORT_BUCKET_CAP = 5;
export const REPORT_BUCKET_REFILL = 1 / 60; // 1 token/min after the initial burst
export const reportTokenBuckets = new Map();

export function takeFrom(map, key, cap, refill) {
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
  for (const [k, b] of heartbeatTokenBuckets) if (b.last < cutoff) heartbeatTokenBuckets.delete(k);
}, 5 * 60_000).unref();

// FNV-1a 32-bit — cheap, fixed-size fingerprint derived from the User-Agent.
// Only needs to separate concurrent listeners sharing a CGNAT IP, not resist
// deliberate forgery; the raw-IP backstop above covers that case.
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
export function deviceKey(ip, req) {
  const ua = req.headers.get('user-agent') ?? '';
  return `${ip}#${hashString(ua.slice(0, 256))}`;
}
