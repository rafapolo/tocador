# Radio # track skipping — analysis & open questions

## What was investigated (2026-06-04)

### Symptom
Radio skips many tracks. Specifically tracks from "Hominis Canidae #N" monthly
compilation albums (the filter `q = 'hominis canidae'` restricts the radio to
these). All of them have `#` in their album folder path.

### What was ruled out

**Proxy**: fully confirmed working.
- All 16 CDN tests pass, including:
  - `indie/…/Hominis%20Canidae%20%23147%20…/capa-min.jpg` → 200
  - `indie/…/Hominis%20Canidae%20%23147%20…/03.%20Gorduratrans%20…mp3` → 200
- `s3GetSigned` handles `#` paths correctly (via SigV4 signing).
- Bun's `new URL()` preserves `%2C`, `%23`, `%E2%80%A2` in pathname (verified).
- Hetzner S3 signature matches for all tested `#` paths.

**URL encoding**: correct.
- Radio uses `encodeURIComponent(album.path)` → `#` → `%23`. ✓
- All 15 radio tests pass, including R13/R14/R15 which verify `%23` in `audio.src`.

**S3 file availability**: spot-checked 15 random `#` albums — ALL returned 200.
- `Matschulat, Hominis Canidae #74- Julho • 2016, Quelled` COVER returned 404,
  but tracks from #74 were not tested. Cover 404 is normal (not all albums have
  covers). The album IS in the JSON so its files are in `unzips/` and S3.

### Still unexplained

After all the above, something causes the browser audio element to skip `#`
tracks in production that passes in Playwright/Chromium tests.

Hypothesis not yet ruled out: **Safari (or some browsers) decode `%23` → `#`
in the media element URL before making the HTTP request**, treating `#` as a
URL fragment separator and truncating the request path. The test suite runs
Chromium which handles it correctly. No Safari test exists.

Evidence for this hypothesis:
- The radio's `playing` event never fires → 6s timeout fires → `next()`.
  This is consistent with the browser never actually requesting the file
  (fragment truncation = no server contact = no audio data = no `playing`).
- Alternatively, the browser contacts the proxy at a truncated path
  (e.g. `/indie/Album%20` without the `#N…` suffix) → proxy gets 404 from S3
  → audio `error` event → radio calls `next()` after 500ms.

### Fixes applied so far

- `curSrc` variable instead of `audio.src` comparison (avoids browser URL
  normalization in the comparison).
- `curSrc = ''` reset in error/timeout handlers so next pick always reloads.
- Time display swapped: elapsed left, total right (matches main player).
- Umami tracker added.

### What to investigate next

1. **Add a Safari / WebKit test** (Playwright supports `webkit` browser):
   set `audio.src` to a URL with `%23`, read back `audio.src`, verify it still
   has `%23` and not bare `#`. If WebKit decodes it, confirm the truncation.

2. **If Safari decodes `%23`**: fix requires avoiding `%23` in the audio URL
   path. Options:
   a. Add `GET /f?k=<path>` proxy route — path in query param, no `#` in URL
      path. Query param values are not treated as fragment.
   b. Fetch audio via `fetch()` + `URL.createObjectURL(blob)` for `#` albums
      (avoids media element URL parsing; expensive: buffers whole file).
   c. Encode `#` as `%2523` client-side AND add a proxy normalisation step:
      after `decodeURIComponent`, `path.replace(/%23/g, '#')`. This way Safari
      would decode `%25` → `%` and see `%23` (not `#`), never fragment-truncate.
      Requires both client and proxy changes.

3. **Check browser console on Safari** while the radio is playing to see whether
   audio `error` events fire (404) vs the 6s timeout fires (no request made).
   This distinguishes "truncated URL, proxy gets 404" from "browser never
   requests the file".
