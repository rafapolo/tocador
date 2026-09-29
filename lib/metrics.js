// Observability: request counters, upstream health, radio listener presence and the
// calendar-day stats behind /metrics. Split out of proxy.js.

import { deviceCounts, rawIpCounts } from './limits.js';

// §14 — radio "listening now" presence. radio.html beacons a heartbeat every
// ~15s while its <audio> element is actually playing (not merely on the page),
// keyed by a random id generated once per page load. A listener who vanishes
// without a clean stop — tab killed, phone locked, network dropped — just ages
// out here instead of needing an explicit disconnect; 40s tolerates a couple of
// missed beats before /metrics stops counting them.
export const RADIO_HEARTBEAT_TIMEOUT_MS = 40_000;
export const RADIO_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const radioListeners = new Map(); // id -> lastSeen
setInterval(() => {
  const cutoff = Date.now() - RADIO_HEARTBEAT_TIMEOUT_MS;
  for (const [id, ts] of radioListeners) if (ts < cutoff) radioListeners.delete(id);
}, 10_000).unref();

// §16 — calendar-day stats for /metrics' `today`, reset at local midnight in
// America/Sao_Paulo. Brazil dropped DST in 2019, so the offset is a fixed
// UTC-3 — no tz database needed, just shift the clock before flooring to a day.
export const DAY_MS = 24 * 60 * 60_000;
export const SP_OFFSET_MS = 3 * 60 * 60_000; // America/Sao_Paulo = UTC-3, fixed
export const dayKeyNow = () => Math.floor((Date.now() - SP_OFFSET_MS) / DAY_MS);

// Everything that used to be a top-level `let`. ES modules can't reassign an
// imported binding, so the counters live on one object every module shares.
export const state = {
  todayDayKey: dayKeyNow(),
  todayHeartbeatTicks: 0,
  todayTracksPlayed: 0,
  todayRequests: 0,
  todaySentBytes: 0,
  listenersPeakToday: 0,
  activeRequests: 0,
  eventLoopLag: 0,
  upstreamFailStreak: 0,
};


// radio.html ticks a heartbeat every 15s while actually playing (see
// HEARTBEAT_INTERVAL_MS there) plus one extra at play-start and one at stop —
// counting every accepted heartbeat as one tick and multiplying by the
// interval is an estimate of listening time, not an exact watch-time log; it
// over-counts short sessions slightly (the play-start tick doesn't represent
// a full prior interval) the same way the old last_24h counters were already
// approximate.
export const RADIO_HEARTBEAT_INTERVAL_SECONDS = 15;

export const todayListenerIds = new Set(); // ids seen today, any heartbeat (stop included)

// Rolls the `today` counters over exactly once per calendar day, lazily —
// called from anywhere that reads or writes them, so it fires on the first
// request after local midnight rather than needing its own timer.
export function ensureToday() {
  const k = dayKeyNow();
  if (k === state.todayDayKey) return;
  state.todayDayKey = k;
  todayListenerIds.clear();
  state.todayHeartbeatTicks = 0;
  state.todayTracksPlayed = 0;
  state.todayRequests = 0;
  state.todaySentBytes = 0;
  state.listenersPeakToday = radioListeners.size;
}

// §13 — observability: event-loop lag + aggregate counters
let _lastTick = Date.now();
export const counters = { ok: 0, c4xx: 0, c5xx: 0 };
// Every counted request also counts toward today.requests — one place so the
// 10s rolling window (counters) and the calendar-day total (today) can't drift.
export function markOk()   { counters.ok++;   ensureToday(); state.todayRequests++; }
export function mark4xx()  { counters.c4xx++; ensureToday(); state.todayRequests++; }
export function mark5xx()  { counters.c5xx++; ensureToday(); state.todayRequests++; }

// §13 — upstream reachability. A 404 from S3 still proves the link is alive, so
// only connection-level failures count. Tracked as a streak because a single
// blip is noise; a sustained run means every request is a black hole and the
// node must be pulled from rotation.
export const UPSTREAM_FAIL_THRESHOLD = 5;
export const markUpstreamOk = () => { state.upstreamFailStreak = 0; };
export const markUpstreamFail = () => { state.upstreamFailStreak++; };

setInterval(() => {
  const now = Date.now(); state.eventLoopLag = now - _lastTick - 1000; _lastTick = now;
}, 1000).unref();

setInterval(() => {
  if (counters.ok + counters.c4xx + counters.c5xx > 0) {
    console.log(`[stats] active=${state.activeRequests} 2xx=${counters.ok} 4xx=${counters.c4xx} 5xx=${counters.c5xx} lag=${state.eventLoopLag}ms devices=${deviceCounts.size} ips=${rawIpCounts.size}`);
    counters.ok = counters.c4xx = counters.c5xx = 0;
  }
}, 10_000).unref();

export function metricsJSON() {
  ensureToday();
  const m = process.memoryUsage();
  return {
    listeners: {
      now: radioListeners.size,
      peakToday: state.listenersPeakToday,
    },
    today: {
      uniqueListeners: todayListenerIds.size,
      // heartbeat ticks * interval — see the estimate caveat at §16 above.
      listeningHours: Math.round(state.todayHeartbeatTicks * RADIO_HEARTBEAT_INTERVAL_SECONDS / 3600 * 10) / 10,
      tracksPlayed: state.todayTracksPlayed,
      requests: state.todayRequests,
      sent_MB: Math.round(state.todaySentBytes / 1_000_000 * 10) / 10,
    },
    activeRequests: state.activeRequests,
    ipMapSize: rawIpCounts.size,
    deviceMapSize: deviceCounts.size,
    eventLoopLagMs: state.eventLoopLag,
    upstreamFailStreak: state.upstreamFailStreak,
    memory: { rssBytes: m.rss, heapUsedBytes: m.heapUsed },
    // ok/4xx/5xx are a 10s rolling window, not a running total — counters
    // reset in the [stats] log tick above.
    requestsLast10s: { ok: counters.ok, c4xx: counters.c4xx, c5xx: counters.c5xx },
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}
