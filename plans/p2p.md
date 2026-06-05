# P2P Radio via WebRTC

**Goal**: broadcast a synchronized radio stream to 500+ listeners with fixed ~384 kbps VPS egress regardless of listener count.

## Problem

Without P2P: 500 listeners × 128 kbps = 64 Mbps continuous egress from VPS. CDN and server upgrade are out of budget. P2P keeps VPS egress fixed at ~384 kbps regardless of listener count.

This plan assumes a synchronized radio station — all listeners on the same timestamp. If listeners pick different albums, P2P doesn't help (CDN with cache is the answer instead).

## Topology

Fan-out-3 broadcast tree. VPS is seed #0, serves ~12 level-1 seeds directly; the rest is browser-to-browser. Fan-out 3, depth 6 → supports ~364 peers.

```
          VPS (seed #0)
         /      |      \
     Seed A  Seed B  Seed C     ← level 1: stable peers >30s
    / | \    / | \    / | \
   D  E  F  G  H  I  J  K  L   ← level 2
   ...                          ← level 3+
```

Mobile is always a leaf — iOS suspends WebRTC ~30s with screen locked; Android throttles in background. Tracker detects via User-Agent on `hello` and permanently marks mobile as leaf.

## Format

MP3 chunks cut server-side at frame boundaries (~32 KB / 2s per chunk). No transcode — the whole archive is already MP3. Server knows frame positions and only cuts at boundaries; clients receive pre-aligned chunks.

Firefox: MSE with `audio/mpeg` doesn't work — Firefox falls back to HTTP. ~5–10% of users, no VPS impact beyond their individual stream.

## Technical decisions

- **Fragment size**: 2s / ~32 KB. DataChannel handles 32 KB without fragmentation.
- **Playback buffer**: 12s (6 fragments). Playback starts after the 1st fragment (~2s audio); subsequent fragments build the buffer in background.
- **Heartbeat**: 2s interval, detection in 6s (leaves 6s to reconnect before underrun).
- **DataChannel**: `ordered: true, maxRetransmits: 3` — tolerates loss without stall.
- **Backpressure**: native DataChannel flow control (SCTP). Check `bufferedAmount > 256 KB`, await `bufferedamountlow` before sending.
- **No TURN**: peers failing ICE in 5s get `fallback-to-http` from tracker. ~5–15% of listeners (symmetric NAT, corporate) stay on HTTP.

## Components

### 1. Tracker — added to `proxy.js`

WebSocket upgrade on existing port 9001 (`/radio`). State in memory, no DB.

**Responsibilities**: assign parent to each new peer (shallowest node with a free slot), detect death by missing heartbeat (6s), promote leaf → seed when level-1 slots are empty, notify children with `need-parent` when a seed dies.

### 2. Signaling — 6 messages, tracker is authoritative

```
client → tracker:
  { t: "hello", peerId, caps: { fmp4: true } }
  { t: "need-parent" }
  { t: "heartbeat", depth: n }
  { t: "bye" }                         ← sendBeacon() on beforeunload
  { t: "signal", to: peerId, payload } ← SDP/ICE relay

tracker → client:
  { t: "welcome", parent: peerId, role: "leaf"|"seed" }
  { t: "signal", from: peerId, payload }
  { t: "need-parent" }
  { t: "promote" | "demote" }
  { t: "fallback-to-http" }
```

### 3. Source loop — `radio.js` (separate process, same container)

Reads `homi-albums.json.gz` or `uqt-albums.json.gz`, plays playlist in loop, distributes MP3 fragments to the ~12 level-1 seeds connected to VPS via DataChannel.

Buffers the last 6 fragments for late joiners. Pauses when `peers.size === 0`, resumes on first connection (keeps playlist position — does not restart from beginning).

### 4. `js/radio-client.js`

Connection flow:
1. WebSocket to `wss://cdn.tocador.cc/radio`
2. `hello` → tracker replies `welcome` with parent
3. ICE negotiation with parent (STUN: `stun.l.google.com:19302`)
4. If ICE fails in 5s → `fallback-to-http`
5. DataChannel opens → 6 buffered fragments arrive immediately
6. Append 1st fragment to SourceBuffer → playback starts
7. Each fragment received: append + relay to children

`visibilitychange → hidden`: send `{ t: "demote" }`, stop accepting children (prevents relay from throttled tab).

### 5. `js/ui.js` — minimal integration

- "Radio" button in player bar
- "Now Playing" via `meta` message from DataChannel
- Listener count via periodic tracker message

## Implementation pitfalls (must not skip)

1. **`SourceBuffer.appendBuffer` is not reentrant** — queue appends and wait for `updateend` before the next one. Silent failure.
2. **Safari requires `moov` box before any `moof`** — send init segment once on connect, before media fragments.
3. **iOS Safari suspends WebRTC in ~30s with screen locked** — treat as normal peer drop.
4. **ICE candidates before `setRemoteDescription` fail silently** — buffer candidates until remote SDP is set.
5. **`RTCPeerConnection` leak** — every failed connection must call `.close()` explicitly.
6. **`bufferedAmount` is per-channel** — backpressure must account for each DataChannel separately.

## Estimated implementation

| component | ~lines |
|---|---|
| Tracker in proxy.js | 200 |
| Source loop (radio.js) | 200 |
| radio-client.js | 400 |
| ui.js integration | 50 |
| fMP4 transcode in upload pipeline | 30 |
| **total** | **~880** |

## Out of scope for v1

- TURN server (defer until real ICE failure data exists)
- Multiple simultaneous stations
- Peer authentication
- Clock sync between peers (drift acceptable for radio)
