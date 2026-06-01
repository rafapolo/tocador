# Plan: Genre & Artist Left Panel

## Context

`../hominiscanidae/genres.json` (13 MB raw / 2.1 MB gzip) contains ML-generated per-track genre predictions (469 unique "Parent---Subgenre" labels, 41 564 tracks across 6 961 albums). The player currently has no genre dimension — only free-text search and decade/year filters. Goal: add a left-side panel (same 380 px width as the existing tracks panel) with two tabs — **Artists** (default) and **Genres** — to browse and filter albums.

Not all acervos ship a genres file. The panel degrades gracefully: the **Artists** tab is always available (data derived from the album catalog); the **Genres** tab appears only when a `genres` URL is configured for the acervo and the file loads successfully.

**Existing architecture this plan must respect:**
- Layout: `.app-layout` (flex row) → `<main.main-content>` (flex:1) + `<aside.tracks-panel>` (380 px, slides to width:0 via `.hidden`).
- `filterAlbums()` is the single chokepoint that recomputes `filteredAlbums`, calls `virtualGrid.setItems()`, updates count/clear/empty-state.
- Mobile (≤768 px): `.tracks-panel` is `display:none`; track list lives in `.mobile-track-drawer` (slide-up); `.now-playing-overlay` is a full-screen bottom-sheet. These establish the mobile vocabulary we mirror.
- Design tokens: `--color-accent: #d4a574`, `--color-surface`, `--color-surface-light`, `--color-border`, `--transition` (0.3s cubic-bezier). Active pills use accent fill + gold box-shadow. Count badges use accent-tint bg.

---

## UX Design

### Mental model
Three coordinated regions: **left "Browse" panel** (Artists / Genres — who/what), **center grid** (results), **right Tracks panel** (one album's detail). Browse-panel selections, search, and decade row are three independent *stacking* filters feeding the same `filterAlbums()` pipeline. Selecting an artist and a genre is mutually exclusive within the panel, but either stacks with search + decade.

### Desktop layout (>1024 px)

```
┌──────────────┬──────────────────────────────────┬───────────────────┐
│ Browse panel │  main-content                    │  Tracks panel     │
│  300px       │   ┌ filters: [chip] search·dec. ─│   380px           │
│ [Artists|Gen]│   ├──────────────────────────────│  (slides in on    │
│ filter ▢     │   │  virtual album grid          │   album click)    │
│─────────────-│   │                              │                   │
│ Rock     142 │   │                              │                   │
│ MPB       98 │   │                              │                   │
│ …virtual…    │   │                              │                   │
│              │   └──────────────────────────────│                   │
│  ◀ collapse  │                                  │                   │
└──────────────┴──────────────────────────────────┴───────────────────┘
```

- **Width:** 300 px (narrower than 380 px tracks panel — labels need less room; keeps grid generous). `flex-shrink:0`, `border-right:1px solid var(--color-border)`.
- **Collapsible:** a `◀/▶` toggle pinned at the panel's inner edge collapses to a **44 px rail** showing a vertical "Browse" label + accent dot when filter is active. Animates `width` via the same `transition:width 0.3s ease` used by `.tracks-panel`. State persists in `localStorage('tocador-browse-collapsed')`.
- **No resize handle** — deliberate; collapse toggle is the right affordance here.
- **Tabs (segmented control):** full-width, two segments. Active: accent text + 2px accent underline (subtler than decade button fill — avoids two competing "selected" signals). Genres tab renders `disabled`+dimmed when `genreData` is null, with tooltip "Gêneros indisponíveis neste acervo" (keeps it discoverable vs hiding it entirely).
- **List item:** full-width button, name left (ellipsis) + count badge right (accent-tint pill). Hover: `background:var(--color-surface-light); transform:translateX(2px)`. Selected: 3px accent left-border + accent text + `rgba(212,165,116,0.12)` bg (mirrors `.track-item.playing`). `.zero`: `opacity:0.4`, sorted to bottom.
- **Active-filter chip:** when a panel filter is active, a dismissible chip appears in `.filters-section` above search: `Gênero: Rock ✕` or `Artista: Sue Cavalcante ✕` styled like an active decade button. Clicking `✕` clears only the panel filter (leaves search/decade intact).
- **In-panel search:** a small search input below the tabs filters the *panel list* only (which artists/genres are shown). Never touches the grid.
- **Count badges:** reflect the *other* active filters (search + decade) — numbers stay truthful. Items whose intersected count drops to 0 are dimmed + sorted to the bottom (not removed — keeps spatial stability during search typing).

### Desktop keyboard & focus
- Tab order: search → decade → browse segmented control → browse list → grid → tracks panel (source-order in HTML).
- Arrow Up/Down moves between list items when focus is inside (`role="listbox"`, roving tabindex). Enter/Space toggles.
- Left/Right switches tabs when focus is on the segmented control (`role="tablist"`).
- `Escape`: if panel filter active → clear it; if mobile drawer open → close it. Never hijacks search-box Escape.
- `b`: toggle browse panel (collapse desktop / open drawer mobile).
- `g`: switch to Genres tab (if enabled), ensure panel open.

### Mobile layout (≤768 px)

**Pattern: left slide-in drawer mirroring the right track drawer, opened by a filter button.**

Rationale: a persistent chip row steals vertical space and can't host 5 954 artists usably. A drawer gives full height for a virtualized list and matches the existing mobile vocabulary (track drawer, now-playing overlay).

- **Trigger:** a funnel/filter icon button in `.filters-section` (leading, before search). Shows an accent dot badge when a panel filter is active. Min 40×40 hit area.
- **Drawer:** `position:fixed; inset:0 auto 0 0; width:min(86vw,360px); transform:translateX(-100%)→0; transition:transform 0.3s cubic-bezier(0.4,0,0.2,1); z-index:600`. Full-height. Scrim behind (`rgba(0,0,0,0.5)`, tap-to-dismiss).
- **Auto-close:** tapping a list item filters instantly then auto-closes the drawer after a brief highlight delay (mirrors `closeMobileDrawer()` behavior).
- Browse drawer and track drawer are mutually exclusive (opening one closes the other).
- The right track drawer is unaffected.

### Scroll & transitions
- Grid resets `scrollTop=0` on filter (intentional — you want top of filtered results).
- Add brief opacity cross-fade on `.albums-grid-inner` (~150 ms, 1→0.6→1) to soften the swap. Gated by `@media (prefers-reduced-motion: no-preference)`.
- Browse list preserves its own scroll position across selection changes (only class toggles, no full rebuild).

### Loading state
- Genres tab shows inline spinner (`@keyframes spin`, already defined) while genre index is fetching. Artists tab is available immediately (local data).
- On genre fetch failure → tab transitions from spinner to disabled silently.
- Skeleton rows in list while data is loading (reuse `@keyframes shimmer` from `.skeleton-card`).

### Performance
- 5 954 unique artists → **must be virtualized**. New `VirtualList` class (single-column, fixed row height ~40 px desktop / 48 px mobile, ~30 DOM nodes). Mirrors `VirtualGrid` node-pool pattern.
- Artist/genre lists memoized (invalidated with `_cachedDecades` in `buildAlbums()`). Counts recomputed in a single O(n) pass over `filteredAlbums` via `Map<key,count>` — only when panel is open.

---

## Step 1 — Build compact genre index (new script)

**`script/build-genre-index.js`:**
- Reads `../hominiscanidae/genres.json`.
- Per track: keeps top 3 genre predictions (by score).
- Per album: majority-vote across track `top` values → single aggregated genre string.
- Output `../hominiscanidae/data/homi-genres.json.gz`: `{ "album_path": "Parent---Subgenre" }` (~6 961 entries, est. ~80–120 KB gzip).
- NFC-normalize keys to match `album.path` (the catalog uses `.normalize('NFC')`).

Run: `bun script/build-genre-index.js`, commit + push in hominiscanidae repo.
URL: `https://rafapolo.github.io/hominiscanidae/data/homi-genres.json.gz`

---

## Step 2 — Wire genre URL into KNOWN_ACERVOS (`js/ui.js` ~line 71)

```js
homi: {
  data: 'https://rafapolo.github.io/hominiscanidae/data/homi-albums.json.gz',
  genres: 'https://rafapolo.github.io/hominiscanidae/data/homi-genres.json.gz',
},
// uqt: no `genres` key → Genres tab disabled
```

---

## Step 3 — Load genre index in parallel (`js/ui.js` ~line 1008)

`Promise.all` both fetches (catalog + genre index) so genres never block first paint. Store in module-level `let genreData = null`. On any failure → `genreData = null` silently. Set `genreLoading` flag while the promise is in flight (drives the Genres tab spinner).

---

## Step 4 — Add genre fields in `buildAlbums()` (~line 442)

```js
genre:       genreData?.[raw.path] ?? null,
genreParent: genreData?.[raw.path]?.split('---')[0] ?? null, // precomputed for hot filter loop
```

---

## Step 5 — New state variables (~line 58)

```js
let activeGenre      = null;
let activeArtist     = null;
let browseTab        = 'artists';
let browsePanelQuery = '';
let browseCollapsed  = localStorage.getItem('tocador-browse-collapsed') === 'true';
let genreLoading     = false;
```

---

## Step 6 — Extend `filterAlbums()` (~line 498)

Add before the search block (cheap equality checks first):
```js
if (activeArtist && album.artists !== activeArtist) return false;
if (activeGenre  && album.genreParent !== activeGenre) return false;
```
After `virtualGrid.setItems()`: call `refreshBrowseCounts()` + update active-filter chip. Extend `isFiltered` to include `activeArtist || activeGenre`.

---

## Step 7 — DOM: browse panel in `index.html`

Insert `<aside class="browse-panel" id="browse-panel">` **before** `<main class="main-content">` (source order = focus order):

```html
<aside class="browse-panel" id="browse-panel" aria-label="Navegar por artistas e gêneros">
  <div class="browse-tabs" role="tablist">
    <button class="browse-tab active" role="tab" data-tab="artists" aria-selected="true">Artistas</button>
    <button class="browse-tab" role="tab" data-tab="genres" aria-selected="false" disabled>Gêneros</button>
  </div>
  <div class="browse-search-wrap">
    <input class="browse-search" id="browse-search" type="text"
           placeholder="Filtrar lista…" autocomplete="off" spellcheck="false" />
  </div>
  <div class="browse-list" id="browse-list" role="listbox"></div>
  <div class="browse-empty" id="browse-empty" hidden>Nenhum resultado</div>
  <button class="browse-collapse" id="browse-collapse" aria-label="Recolher painel" aria-expanded="true">◀</button>
</aside>
```

Mobile only — add inside `.filters-section`:
```html
<button id="btn-browse" class="btn-browse mobile-only" aria-label="Filtrar por artista ou gênero">
  <!-- funnel icon --> <span class="browse-badge" hidden></span>
</button>
```

Add `.browse-scrim` as sibling to `.browse-panel` (hidden by default, tap-to-dismiss on mobile).

---

## Step 8 — New functions in `js/ui.js`

| Function | Purpose |
|---|---|
| `buildArtistList()` | `Map<artists, count>` from `allAlbums` → `[{name,count}]` sorted by count desc. Memoized in `_cachedArtists`. |
| `buildGenreList()` | `Map<genreParent, count>` from `allAlbums` where genre non-null → `[{name,count}]`. Memoized in `_cachedGenres`. |
| `refreshBrowseCounts()` | O(n) pass over `filteredAlbums`, updates badge text + `.zero` class + re-sorts zeros to bottom. Skips when panel collapsed. |
| `renderBrowsePanel()` | Renders active tab's list via `VirtualList`, filtered by `browsePanelQuery`. |
| `selectBrowseItem(value)` | Toggle logic. Clears the other dimension. Calls `filterAlbums()` + `updateBrowseSelection()`. On mobile: schedules `closeBrowseDrawer()`. |
| `updateBrowseSelection()` | Toggles `aria-selected` + `.selected` class only (no rebuild — preserves scroll, mirrors `VirtualGrid.refresh()`). |
| `switchBrowseTab(tab)` | Updates tablist, clears in-panel query, cross-fades list, calls `renderBrowsePanel()`. |

Wire all handlers via delegation on `#browse-list` (rows virtualized/recycled — matches grid delegation pattern).

---

## Step 9 — `VirtualList` class (near `VirtualGrid`)

Single-column windowed list. Fixed `rowHeight` (40 px desktop / 48 px mobile). `setItems(items)` → set inner height, reset scroll, render window. `_render()` windows `scrollTop/rowHeight ± buffer`, recycled node pool. Roving `tabindex` + `aria-activedescendant` for keyboard.

---

## Step 10 — URL state (shareable filters)

Mirror existing `q`/`ano` params. Add `genero=Rock` ↔ `activeGenre` and `artista=<name>` ↔ `activeArtist`. Restore on init and on `popstate`. Mutually exclusive — only one set at a time.

---

## Step 11 — CSS (`assets/player.css`)

**Desktop:**
- `.browse-panel`: `width:300px; flex-shrink:0; background:var(--color-surface); border-right:1px solid var(--color-border); display:flex; flex-direction:column; transition:width 0.3s ease`
- `.browse-panel.collapsed`: `width:44px`
- `.browse-tabs`: segmented control; active tab: accent text + 2px underline
- `.browse-search`: reuse `.search-input` token styles
- `.browse-list`: `flex:1; overflow-y:auto; position:relative`
- `.browse-item`: flex row, name left + count badge right; hover `translateX(2px)`; `.selected`: 3px accent left-border + `rgba(212,165,116,0.12)` bg; `.zero`: `opacity:0.4`
- `.browse-count`: reuse `.music-count` look, `font-variant-numeric:tabular-nums`
- `.browse-collapse`: vertically centered handle at inner edge, accent on hover
- `.active-filter-chip`: like `.decade-btn.active` + `✕`
- Grid cross-fade: `.albums-grid-inner.swapping { opacity:0.6 }` ~150ms, gated by `prefers-reduced-motion`

**`@media (max-width:768px)`:**
- `.browse-panel`: `position:fixed; inset:0 auto 0 0; width:min(86vw,360px); transform:translateX(-100%); transition:transform 0.3s cubic-bezier(0.4,0,0.2,1); z-index:600`
- `.browse-panel.open`: `transform:translateX(0)`
- `.browse-scrim`: fixed full-screen, `opacity:0→1` when `.open`, `pointer-events:none→auto`
- `.browse-collapse`: hidden on mobile
- `.btn-browse.mobile-only`: visible, min 40×40, with `.browse-badge` accent dot when filtered

---

## Verification

1. `bun script/build-genre-index.js` → file created, keys NFC-match album paths
2. `?acervo=homi` → browse panel visible left, Artists tab active, virtualized list (~30 DOM nodes for 5 954 artists)
3. Genres tab: spinner → enables; click "Rock" → grid filters, chip "Gênero: Rock ✕" appears, row highlighted
4. Stack: Rock + decade 1970 + search → all three apply; counts reflect intersection; `.zero` items dimmed + sorted last
5. Toggle same item → clears; `✕` chip → clears panel filter only (search/decade intact)
6. Switch Artists↔Genres → cross-fade, in-panel search resets, list scroll preserved
7. Collapse panel → 44 px rail with accent dot; state persists across reload (`localStorage`)
8. `?acervo=uqt` → Genres disabled+dimmed; Artists works normally
9. Mobile: funnel button opens left drawer with scrim; tap genre → filter + auto-close; badge dot shows when filtered; browse + track drawers mutually exclusive
10. Keyboard: Tab order correct; arrows navigate list; Enter/Space toggles; Escape clears panel filter; `b`/`g` shortcuts
11. URL: `?genero=Rock` / `?artista=…` restore on load and popstate navigation
12. `prefers-reduced-motion` disables cross-fade and translate animations
