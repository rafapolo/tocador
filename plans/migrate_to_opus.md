# MP3 → Opus migration

Convert all `.mp3` in S3 to Opus 64kbps `.ogg`. Files ~2× smaller, same perceptual quality — doubles possible listeners on the same VPS.

## What changes

| component | change |
|---|---|
| S3 | add `.ogg` alongside each `.mp3` (MP3 kept as backup) |
| `proxy.js` `mimeFor()` | add `if (k.endsWith('.ogg')) return 'audio/ogg'` |
| acervo JSON | `track.file` extension: `.mp3` → `.ogg` |
| `ui.js` | no change |

The player builds URLs as `${BASE_URL}/${album.path}/${track.file}` — changing the extension in the JSON is sufficient.

## Script: `script/transcode-to-opus.js`

Idempotent — skips `.ogg` files that already exist. Run on VPS (CPU-bound; CX11 with 2 vCPUs, `WORKERS=2` saturates CPU).

```bash
# requires ffmpeg + S3 creds in .env
S3_PREFIX=uqt/   WORKERS=2 node script/transcode-to-opus.js
S3_PREFIX=indie/ WORKERS=2 node script/transcode-to-opus.js
```

ETA: ~1.5–3h per acervo. Run with `nice -n 10` during the day; overnight is better.

## Order of execution

1. `apt-get install -y ffmpeg` on VPS
2. Add `.ogg` MIME to `proxy.js`, deploy
3. Run `transcode-to-opus.js` for each prefix (background with `nohup`)
4. Verify counts match: `aws s3 ls s3://bucket/uqt/ --recursive | grep -c '\.ogg$'`
5. Patch JSONs — re-run the Rust generator (if `.ogg` files are local) or inline replace:
   ```js
   for (const album of db.albums)
     for (const track of album.tracks)
       track.file = track.file.replace(/\.mp3$/i, '.ogg');
   ```
   Commit and push in each acervo repo.
6. Test player with a few tracks — check `Content-Type: audio/ogg` in DevTools
7. After 24h stable, delete `.mp3` from S3:
   ```bash
   aws s3 rm s3://bucket/uqt/ --recursive --exclude "*" --include "*.mp3"
   ```

## Rollback

MP3 originals remain in S3 until step 7. To revert: patch JSON back to `.mp3`, commit, push. The `.ogg` files can be deleted separately.
