# Plans

---

## hominiscanidae — charset fix (ongoing)

Albums had missing tracks because macOS Archive Utility and `unrar` silently drop PT-BR characters (ã, ô, ç, etc.) from Latin-1/CP850 RAR archives. `unar` handles them correctly. `scripts/download/refix_charset.py` re-downloads the original archive, extracts with `unar`, merges only the missing tracks into `unzips/<album>/`, and uploads to S3.

**State as of 2026-05-29**

| metric | count |
|---|---|
| total gap albums | 445 |
| fixed (`_charset_done.txt`) | ~327–333 |
| irrecoverable (`_charset_irrecoverable.txt`) | 77 |
| pending | ~335 |

Pending by service: mega.nz 216 (main blocker), no post match 80, artist/personal sites ~25, mediafire 10, gdrive 2, dropbox 1, archive.org 1.

**Tracking files**

| file | purpose |
|---|---|
| `/Volumes/EXTRA/hominiscanidae/_charset_done.txt` | successfully fixed — skipped on next run |
| `/Volumes/EXTRA/hominiscanidae/_charset_irrecoverable.txt` | excluded from retry |

**Resume**

```bash
# all proxies, all services
python3 scripts/download/refix_charset.py --tor >> refix_charset.log 2>&1 &

# mega only
python3 scripts/download/refix_charset.py --tor --domain=mega >> refix_charset.log 2>&1 &

# skip mega (quota exhausted)
python3 scripts/download/refix_charset.py --exclude-domain=mega >> refix_charset.log 2>&1 &
```

Proxy rotation: `local → livre → finland → tor`. SSH tunnels (`ssh -D 1080 -f -N livre`) are restarted automatically on rotation.

**After each successful run** — regenerate `homi-albums.json.gz` and push:

```bash
./script/generate-albums/target/release/generate-albums \
  /Volumes/EXTRA/hominiscanidae/unzips \
  /Users/polux/Projetos/hominiscanidae/js/homi-albums.json.gz
```
