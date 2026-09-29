// Pure helpers shared by ui.js (classic script: globals, loaded before ui.js).

// Accent- and case-insensitive key. Runs tens of thousands of times at catalog load,
// so: plain toLowerCase() (identical to the 'pt' locale one, and several times
// faster), and no NFD pass for pure-ASCII strings.
const ASCII_ONLY = /^[\x00-\x7f]*$/;
const fold = s => {
  s = s || '';
  return ASCII_ONLY.test(s) ? s.toLowerCase() : s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
};

// One collator, reused: localeCompare(..., 'pt') builds one per call, which dominates a sort.
const PT_COLLATOR = new Intl.Collator('pt', { sensitivity: 'base' });

function parseArtists(str) {
  if (!str) return [];
  const raw = str.split(/; |, | e | & |&/).map(s => s.trim()).filter(Boolean);
  const merged = [];
  for (const p of raw) {
    // Single uppercase letter after a separator = abbreviation fragment (e.g. "S; A" → "S/A")
    if (/^[A-Z]$/.test(p) && merged.length > 0) merged[merged.length - 1] += '/' + p;
    else merged.push(p.replace(/;(?! )/g, '/'));
  }
  return merged;
}

// Catalog text (also from third-party ?acervo= URLs) is untrusted: escape it
// before it goes anywhere near innerHTML.
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function formatTime(seconds) {
  // Upper bound guards against a huge-but-finite value (e.g. a browser clamping a
  // seek to Infinity down to ~Number.MAX_VALUE) slipping past the isFinite check and
  // rendering as a bizarre "2.99e+306:08"-style string instead of a real duration.
  if (!seconds || isNaN(seconds) || !isFinite(seconds) || seconds > 1e7) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
