const zlib = require('zlib'), fs = require('fs');

const DRY_RUN = !process.argv.includes('--write');

const raw = fs.readFileSync('data/homi-albums.json.gz');
const data = JSON.parse(zlib.gunzipSync(raw));
let albums = data.albums;

// If any member of a fingerprint group is in SKIP_GROUP, the group is skipped entirely.
// Use this for genuinely different releases that happen to share all track titles.
const SKIP_GROUP = new Set([
  // live vs studio — different recordings
  '2020 - Nosso Querido Figueiredo - É Isto Punk (Ao Vivo)',
  '2020 - Nosso Querido Figueiredo - É Isto Punk?',
  // gudicarmas: studio (canonical) + live (different release) are both valid
  '2015 - gudicarmas - Dharma',
  '2015 - Gudicarmas - Dharma Astral (Ao Vivo)',
  // 1-track singles in different EPs — not the same release
  '2025 - Nosso Querido Figueiredo - 2025 - Nosso Querido Figueiredo - nosso-querido-figueiredo-metafora-ep',
  '2025 - Nosso Querido Figueiredo - 2025 - Nosso Querido Figueiredo - nosso-querido-figueiredo-nos-tambem-nao',
  // namöa: 1 shared track across two different albums
  '2017 - namöa - 2017 - namöa - Namoa Diastole',
  '2017 - namöa - 2017 - namöa - Namoa Terceiras Historias',
  // Pato Fu - 30 shares fingerprint with FBC Vhoor by data indexing error
  '2023 - Pato Fu - 30',
  '2021 - FBC Vhoor - BAILE',
  '2021 - FBC & Vhoor - Baile (Instrumental)',
  // Sabotage 2016 original ≠ Sabotage 50 tribute (different albums, same track names by coincidence)
  '2016 - Sabotage - Sabotage',
  '2024 - Sabotage KAMAU Zegon DemBeats Erick Jay - Sabotage 50',
  '2024 - Sombrio da Silva - Hominis Canidae #167 - Abril',
  // Akminarrah shares fingerprint with Crashkill — unrelated albums, coincidental match
  '2020 - Crashkill - Consumed by Biomechanics',
  '2018 - Akminarrah - Batuquebrada',
]);

// FORCE_REMOVE: always remove these specific paths, regardless of group logic.
// Used for slug/HC duplicates whose group is in SKIP_GROUP (so normal dedup can't catch them).
const FORCE_REMOVE = new Set([
  '2015 - gudicarmas-dharma-2015',              // slug dup of gudicarmas - Dharma
  '2020 - Crashkill - Hominis Canidae #120 - Maio',  // HC episode dup of Crashkill studio album
]);

function normalize(s) {
  return s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[-_]/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\d{4}\s*/, '')
    .replace(/\s\d{4}$/, '')
    .trim();
}

function wordSet(s) {
  return new Set(normalize(s).split(' ').filter(w => w.length > 2 && !/^\d+$/.test(w)));
}

function pathSimilarity(a, b) {
  const wa = wordSet(a), wb = wordSet(b);
  const intersection = [...wa].filter(w => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union > 0 ? intersection / union : 0;
}

// A slug has no " - " field separators in its body (after the year prefix) and is all lowercase.
// Artist names that are lowercase but use " - " separators (e.g. "weird fingers - title") are NOT slugs.
function isSlug(path) {
  const body = path.replace(/^\d{4}\s*[-–]\s*/, '').trim();
  return !/ - /.test(body) && body === body.toLowerCase();
}

function isHCEpisode(path) {
  return /hominis canidae|#\d+|#hitsbr/i.test(path);
}

function isGenericTracks(tracks) {
  return tracks.length <= 2 && tracks.every(t =>
    /^(a|b|c|d|i{1,3}v?|v?i{0,3}|intro|outro|lado [ab]|track \d+|\d+\.?)$/i.test(t.title.trim())
  );
}

function uppercaseRatio(tracks) {
  const str = tracks.map(t => t.title).join('');
  const upper = [...str].filter(c => c >= 'A' && c <= 'Z').length;
  return str.length > 0 ? upper / str.length : 0;
}

function separatorCount(path) {
  const body = path.replace(/^\d{4}\s*-\s*/, '');
  return (body.match(/ - /g) || []).length;
}

function pathScore(album) {
  let score = 0;
  score += separatorCount(album.path) * 10;  // canonical "Artist - Title" separators
  if (!isSlug(album.path)) score += 10;       // not a word-hyphenated slug
  if (!isHCEpisode(album.path)) score += 30;  // standalone release strongly preferred over podcast
  score += uppercaseRatio(album.tracks) * 10; // proper title casing in tracks
  const pathUpper = [...album.path].filter(c => c >= 'A' && c <= 'Z').length;
  score += pathUpper * 0.01;                   // tiebreak: more uppercase in path
  return score;
}

const groups = {};
albums.forEach(a => {
  const fp = a.tracks.map(t => t.title.toLowerCase().trim()).sort().join('|');
  (groups[fp] ??= []).push(a);
});

const AUTO_REMOVE = new Set(FORCE_REMOVE);
let skipped = 0;

Object.values(groups).filter(g => g.length > 1).forEach(group => {
  if (isGenericTracks(group[0].tracks)) { skipped++; return; }
  if (group.some(a => SKIP_GROUP.has(a.path))) { skipped++; return; }

  const paths = group.map(a => a.path);
  const hasSlugMember = group.some(a => isSlug(a.path));
  const hasHCMember = group.some(a => isHCEpisode(a.path));
  const maxSim = Math.max(...paths.flatMap((a, i) =>
    paths.slice(i + 1).map(b => pathSimilarity(a, b))
  ));
  if (!hasSlugMember && !hasHCMember && maxSim < 0.4) { skipped++; return; }

  group.sort((a, b) => pathScore(b) - pathScore(a));
  console.log('KEEP:   ' + group[0].path);
  group.slice(1).forEach(a => {
    console.log('REMOVE: ' + a.path);
    AUTO_REMOVE.add(a.path);
  });
  console.log();
});

// also print the force-removes that weren't caught by group logic
FORCE_REMOVE.forEach(p => {
  if (!AUTO_REMOVE.has(p) || !Array.from(AUTO_REMOVE).some(x => x === p && !FORCE_REMOVE.has(x))) {
    // it was added via FORCE_REMOVE, show it
  }
});

console.log(`Skipped ${skipped} groups (false positives / keep-both)`);
const forceCount = [...FORCE_REMOVE].filter(p => !AUTO_REMOVE.has(p) || FORCE_REMOVE.has(p)).length;
console.log(`Force-removing ${FORCE_REMOVE.size} explicitly listed paths`);
console.log(`Auto-removing ${AUTO_REMOVE.size - FORCE_REMOVE.size} paths from group logic`);
console.log(`Total to remove: ${AUTO_REMOVE.size} from ${albums.length} albums`);

if (!DRY_RUN) {
  albums = albums.filter(a => !AUTO_REMOVE.has(a.path));
  const out = JSON.stringify({ meta: data.meta, albums });
  fs.writeFileSync('data/homi-albums.json.gz', zlib.gzipSync(Buffer.from(out)));
  console.log(`Written. ${albums.length} albums remaining.`);
} else {
  console.log('(dry run — pass --write to apply)');
}
