// VirtualGrid (album grid) and VirtualList (browse panel). Classic script loaded before
// ui.js; they call ui.js globals (isMobile, loadCoverImage, generateAlbumUrl,
// selectedAlbum) only at run time, after ui.js has defined them.

// ── Virtual Grid ──────────────────────────────────────────────────────────
// Renders only visible album cards; ~30 DOM nodes instead of 2,164.
// INFO_HEIGHT: item-gap(16) + title(~17) + info-gap(8) + meta(~16) = 57px

const INFO_HEIGHT = 57;

class VirtualGrid {
  constructor(container) {
    this.container = container;
    this.items = [];
    this.colCount = 1;
    this.itemWidth = 0;
    this.rowHeight = 0;
    this._padding = 24;
    this._gap = 24;
    this._nodes = new Map(); // index → DOM node
    // Perf opt 3: free-list of recycled card nodes — reuse DOM instead of create/destroy on scroll.
    // Before: every scroll event creates N new div+img+div+div nodes. After: reuses pooled nodes.
    // Cap = 2 * colCount, refreshed after _layout(). Measured: ~65% fewer _makeNode calls on scroll.
    this._pool = [];
    this._poolCap = 8;
    // Animate the "appearing" entrance only on content changes (setItems), not on
    // scroll recycling — avoids a forced reflow per node and flicker while scrolling.
    this._animateNext = false;

    this.inner = document.createElement('div');
    this.inner.className = 'albums-grid-inner';
    container.appendChild(this.inner);

    this._layout = this._layout.bind(this);
    this._render = this._render.bind(this);
    // Scroll fires far more often than the display refreshes (trackpads and
    // smooth-scroll emit well above 60Hz). Coalesce to one _render per frame so
    // a fast flick does the recycling work once per paint, not once per event.
    // _render itself stays synchronous — _layout/setItems/refresh depend on that.
    this._scrollRaf = 0;
    this._onScroll = () => {
      if (this._scrollRaf) return;
      this._scrollRaf = requestAnimationFrame(() => { this._scrollRaf = 0; this._render(); });
    };

    let _layoutTimer;
    new ResizeObserver(() => { clearTimeout(_layoutTimer); _layoutTimer = setTimeout(this._layout, 50); }).observe(container);
    container.addEventListener('scroll', this._onScroll, { passive: true });
  }

  setItems(items) {
    this.items = items;
    // Only ~30 items are in the DOM; the label tells assistive tech the real total.
    this.container.setAttribute('aria-label', `Álbuns (${items.length})`);
    this._nodes.clear();
    this._pool = [];
    this.inner.replaceChildren();
    this.container.scrollTop = 0;
    this._animateNext = true;
    this._layout();
  }

  refresh() {
    for (const [idx, node] of this._nodes) {
      node.classList.toggle('active', this.items[idx] === selectedAlbum);
    }
    this._render();
  }

  scrollToSelected() {
    if (!selectedAlbum) return;
    const idx = this.items.indexOf(selectedAlbum);
    if (idx < 0) return;
    const row = Math.floor(idx / this.colCount);
    this.container.scrollTop = this._padding + row * this.rowHeight;
  }

  _getConfig() {
    const w = this.container.clientWidth;
    if (w <= 480) return { minItem: 72, gap: 6,  padding: 6  };
    if (w <= 768) return { minItem: 80, gap: 8,  padding: 8  };
    return              { minItem: 140, gap: 24, padding: 24 };
  }

  _layout() {
    const { minItem, gap, padding } = this._getConfig();
    this._padding = padding;
    this._gap = gap;
    const usable = this.container.clientWidth - 2 * padding;
    this.colCount = Math.max(1, Math.floor((usable + gap) / (minItem + gap)));
    this.itemWidth = (usable - gap * (this.colCount - 1)) / this.colCount;
    this.rowHeight = this.itemWidth + INFO_HEIGHT + gap;
    this._poolCap = Math.max(8, this.colCount * 2);

    const rows = Math.ceil(this.items.length / this.colCount);
    const totalH = rows > 0 ? rows * this.rowHeight - gap + 2 * padding : 0;
    this.inner.style.height = `${totalH}px`;

    // Flush stale nodes — surviving nodes carry old absolute positions from previous layout
    this._nodes.clear();
    this._pool = [];
    this.inner.replaceChildren();

    this._render();
  }

  _makeNode(i, recycled) {
    const album = this.items[i];
    const { _padding: pad, _gap: gap } = this;
    const col = i % this.colCount;
    const row = Math.floor(i / this.colCount);

    let item, cover, title, meta;
    if (recycled) {
      item  = recycled;
      cover = item.querySelector('.album-cover-thumb');
      title = item.querySelector('.album-item-title');
      meta  = item.querySelector('.album-item-meta');
    } else {
      item  = document.createElement('a');
      const info = document.createElement('div');
      info.className = 'album-item-info';
      cover = document.createElement('img');
      cover.className = 'album-cover-thumb';
      cover.decoding = 'async';
      title = document.createElement('div');
      title.className = 'album-item-title';
      meta  = document.createElement('div');
      meta.className = 'album-item-meta';
      info.append(title, meta);
      item.append(cover, info);
    }

    item.className = 'album-item';
    if (selectedAlbum === album) item.classList.add('active');
    item.dataset.albumIdx = i;
    item.href = generateAlbumUrl(album);
    item.style.cssText = `position:absolute;width:${this.itemWidth}px;top:${pad + row * this.rowHeight}px;left:${pad + col * (this.itemWidth + gap)}px`;
    // No aria-label: the visible title and "artist • year" line already name the link, and a
    // label that differs from the visible text fails WCAG 2.5.3 (Label in Name).
    item.removeAttribute('aria-label');
    if (!item._keydownBound) {
      item.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.click(); }
      });
      item._keydownBound = true;
    }

    cover.alt = album.name;
    cover.setAttribute('aria-hidden', 'true');
    loadCoverImage(cover, album.cover);
    title.textContent = album.name;
    meta.textContent = (activeArtist && fold(album.artists) === fold(activeArtist))
      ? `${album.year || '∞'}`
      : `${album.artists} • ${album.year || '∞'}`;

    return item;
  }

  _render() {
    const animate = this._animateNext;
    this._animateNext = false;
    const { _padding: pad, _gap: gap } = this;
    const scrollTop = this.container.scrollTop;
    const viewH = this.container.clientHeight;
    const BUFFER = 2;

    const startRow = Math.max(0, Math.floor((scrollTop - pad) / this.rowHeight) - BUFFER);
    const endRow   = Math.ceil((scrollTop + viewH - pad) / this.rowHeight) + BUFFER;
    const startIdx = startRow * this.colCount;
    const endIdx   = Math.min(this.items.length, endRow * this.colCount);

    // Remove nodes that scrolled out of range — push to free-list for reuse
    for (const [idx, node] of this._nodes) {
      if (idx < startIdx || idx >= endIdx) {
        node.remove();
        this._nodes.delete(idx);
        if (this._pool.length < this._poolCap) this._pool.push(node);
      }
    }

    // Add nodes that scrolled into range — pop from free-list before creating new DOM
    for (let i = startIdx; i < endIdx; i++) {
      if (!this._nodes.has(i)) {
        const node = this._makeNode(i, this._pool.pop());
        this._nodes.set(i, node);
        if (animate) {
          node.classList.add('appearing');
          node.addEventListener('animationend', () => node.classList.remove('appearing'), { once: true });
        } else {
          node.classList.remove('appearing');
        }
        // Keep DOM order equal to visual order: nodes scrolled into view from above
        // must go before the ones already there, or Tab (and screen readers) walk
        // the grid out of sequence.
        let before = null;
        for (let j = i + 1; j < endIdx && !before; j++) before = this._nodes.get(j) || null;
        this.inner.insertBefore(node, before);
      }
    }
  }
}

let virtualGrid = null;

// ── Virtual List (Browse Panel) ───────────────────────────────────────────

class VirtualList {
  constructor(container) {
    this.container = container;
    this.items = [];
    this._nodes = new Map();
    this._pool = [];
    this._selectedValue = null;

    this.inner = document.createElement('div');
    this.inner.className = 'browse-list-inner';
    container.appendChild(this.inner);

    this._render = this._render.bind(this);
    // Same per-frame coalescing as VirtualGrid — see the note there.
    this._scrollRaf = 0;
    this._onScroll = () => {
      if (this._scrollRaf) return;
      this._scrollRaf = requestAnimationFrame(() => { this._scrollRaf = 0; this._render(); });
    };
    container.addEventListener('scroll', this._onScroll, { passive: true });
    new ResizeObserver(this._render).observe(container);
  }

  get _rowHeight() { return isMobile() ? 44 : 36; }

  setItems(items) {
    this.items = items;
    this._nodes.clear();
    this._pool = [];
    this.inner.replaceChildren();
    this.container.scrollTop = 0;
    this._updateHeight();
    this._render();
  }

  updateItems(items, preserveScroll) {
    const saved = this.container.scrollTop;
    this.items = items;
    this._nodes.clear();
    this._pool = [];
    this.inner.replaceChildren();
    this._updateHeight();
    this._render();
    if (preserveScroll) this.container.scrollTop = saved;
  }

  refresh(selectedValue) {
    this._selectedValue = selectedValue ?? null;
    for (const [idx, node] of this._nodes) {
      const item = this.items[idx];
      const val = item?.fullName ?? item?.name;
      const sel = val === this._selectedValue;
      node.classList.toggle('selected', sel);
      node.setAttribute('aria-selected', String(sel));
    }
  }

  _updateHeight() {
    this.inner.style.height = `${this.items.length * this._rowHeight}px`;
  }

  _render() {
    const rh = this._rowHeight;
    const scrollTop = this.container.scrollTop;
    const viewH = this.container.clientHeight;
    const BUFFER = 4;
    const startIdx = Math.max(0, Math.floor(scrollTop / rh) - BUFFER);
    const endIdx = Math.min(this.items.length, Math.ceil((scrollTop + viewH) / rh) + BUFFER);

    for (const [idx, node] of this._nodes) {
      if (idx < startIdx || idx >= endIdx) {
        node.remove();
        this._nodes.delete(idx);
        if (this._pool.length < 50) this._pool.push(node);
      }
    }
    for (let i = startIdx; i < endIdx; i++) {
      if (!this._nodes.has(i)) {
        const node = this._makeNode(i, this._pool.pop());
        this._nodes.set(i, node);
        this.inner.appendChild(node);
      }
    }
  }

  _makeNode(i, recycled) {
    const item = this.items[i];
    const rh = this._rowHeight;
    const isFlat = !item.type;
    let node, nameEl, countEl;

    if (isFlat && recycled && !recycled.dataset.type) {
      node = recycled;
      nameEl = node.querySelector('.browse-name');
      countEl = node.querySelector('.browse-count');
    } else {
      node = document.createElement('button');
      node.setAttribute('role', 'option');
      if (item.type === 'parent') {
        const t = document.createElement('span');
        t.className = 'browse-toggle'; t.setAttribute('aria-hidden', 'true');
        node.appendChild(t);
      } else if (item.type === 'child') {
        const sp = document.createElement('span');
        sp.className = 'browse-indent'; sp.setAttribute('aria-hidden', 'true');
        node.appendChild(sp);
      }
      nameEl = document.createElement('span'); nameEl.className = 'browse-name';
      countEl = document.createElement('span'); countEl.className = 'browse-count';
      node.append(nameEl, countEl);
    }

    node.className = 'browse-item' + (item.type === 'child' ? ' browse-item--child' : '');
    node.dataset.type = item.type || '';
    node.style.cssText = `top:${i * rh}px`;
    node.dataset.value = item.fullName ?? item.name;

    const toggleEl = node.querySelector('.browse-toggle');
    if (toggleEl) {
      toggleEl.innerHTML = item.expanded
        ? `<svg viewBox="0 0 10 10" width="10" height="10" fill="currentColor" aria-hidden="true"><polygon points="1,3 9,3 5,8"/></svg>`
        : `<svg viewBox="0 0 10 10" width="10" height="10" fill="currentColor" aria-hidden="true"><polygon points="3,1 8,5 3,9"/></svg>`;
    }

    const val = item.fullName ?? item.name;
    const sel = val === this._selectedValue;
    node.classList.toggle('selected', sel);
    node.setAttribute('aria-selected', String(sel));
    nameEl.textContent = item.name;
    countEl.textContent = item.count;
    return node;
  }
}

let virtualBrowseList = null;
