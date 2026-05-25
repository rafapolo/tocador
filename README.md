# Tocador

A generic music archive player. Point it at any compatible `.json.gz` archive and it plays.

## Usage

```
https://your-tocador-host/?acervo=https://example.com/my-archive.json.gz
```

Once an archive URL is loaded it persists for the browser session — reloading the page without the `?acervo=` param keeps the same archive.

## Archive format

The archive is a gzipped JSON file with this shape:

```json
{
  "meta": {
    "title": "My Collection",
    "subtitle": "Some subtitle",
    "hours": "42",
    "base_url": "https://cdn.example.com/music"
  },
  "albums": [
    {
      "title": "Album Name",
      "artist": "Artist Name",
      "year": 1975,
      "path": "1975 - Artist Name - Album Name",
      "has_cover": true,
      "tracks": [
        {
          "title": "Track Title",
          "num": 1,
          "file": "01 Track Title.mp3",
          "artists": "Track artist (optional, falls back to album artist)",
          "duration": 214.5
        }
      ]
    }
  ]
}
```

`meta` is optional but strongly recommended:

| field | description |
|---|---|
| `title` | Shown in the header and browser tab |
| `subtitle` | Shown below the title |
| `hours` | Shown as a stat pill (e.g. `"42"` renders as `42 horas`) |
| `base_url` | Root URL for audio and cover files |

Audio files are resolved as `{base_url}/{encoded_album_path}/{encoded_track_file}`.  
Cover images are resolved as `{base_url}/{encoded_album_path}/capa-min.jpg`.

## Features

- Virtual scrolling grid — renders only visible album cards (handles thousands of albums)
- Full playback controls: play/pause, prev/next, seek bar, volume
- Shuffle — random track across the whole archive, weighted by album size
- Repeat — off / repeat one / repeat all
- Decade filter buttons — auto-generated from archive data
- Search — filters by album title, artist, path, and track titles/artists
- Deep links — `?album=`, `?t=`, `?q=`, `?ano=`, `?play=1` params preserved in URL
- Mobile responsive — compact header, slide-up track drawer, full-screen now-playing overlay
- Media Session API — lock screen / headphone controls
- Keyboard shortcuts: `Space` play/pause, `←/→` seek 10s, `n` next, `p` prev, `/` focus search
- Lazy cover images with SVG placeholder on error
- Singleton player across tabs via BroadcastChannel

## Files

```
index.html          — app shell
js/ui.js            — all app logic
assets/player.css   — styles
assets/capa.jpg     — fallback cover placeholder
```

No build step. No bundler. Serve the directory statically.
