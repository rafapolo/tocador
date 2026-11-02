// Shared by the player specs: the albums fixture, a decodable silent MP3 and gotoWithFixture().
const path = require('path');
const fs = require('fs');

const fixturePath = path.join(__dirname, 'fixtures', 'albums.json.gz');
const fixtureGz = fs.readFileSync(fixturePath);
// A real, decodable 10s silence. An empty body made audio.play() reject with
// NotSupportedError, so the 'pause' event stripped the .playing class that
// playTrack() sets optimistically — a race the button-state tests lost about
// one run in three. Long enough that no test outlives it and hits 'ended'.
const fixtureMp3 = fs.readFileSync(path.join(__dirname, 'fixtures', 'silence.mp3'));

// The real CDN answers Range with 206; Chromium can't seek a plain 200 body (empty `seekable`).
function rangedMp3(route) {
  const m = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '');
  if (!m) return route.fulfill({ status: 200, headers: { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes' }, body: fixtureMp3 });
  const ini = +m[1], fim = m[2] ? Math.min(+m[2], fixtureMp3.length - 1) : fixtureMp3.length - 1;
  return route.fulfill({ status: 206, body: fixtureMp3.subarray(ini, fim + 1), headers: {
    'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${ini}-${fim}/${fixtureMp3.length}` } });
}

async function gotoWithFixture(page, url = '/', { blockAudio = false, ranges = false } = {}) {
  // Clear persisted player state so shuffle/repeat start at defaults
  await page.addInitScript(() => {
    localStorage.removeItem('uqt-shuffle');
    localStorage.removeItem('uqt-repeat');
    localStorage.removeItem('uqt-volume');
    localStorage.removeItem('homi-shuffle');
    localStorage.removeItem('homi-repeat');
    localStorage.removeItem('homi-volume');
    // Live player prefs start at defaults, once per test: a reload inside a test keeps them.
    if (!sessionStorage.getItem('pw-prefs-limpas')) {
      sessionStorage.setItem('pw-prefs-limpas', '1');
      for (const k of Object.keys(localStorage)) {
        if (/^tocador-(shuffle|repeat|volume|rate|position|ordem|sleep)/.test(k)) localStorage.removeItem(k);
      }
    }
    localStorage.setItem('tocador-browse-collapsed', 'true');
  });
  await page.route('**/uqt-albums.json.gz', route => {
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' },
      body: fixtureGz,
    });
  });
  await page.route('**/homi-albums.json.gz', route => {
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/gzip', 'Content-Encoding': 'identity' },
      body: fixtureGz,
    });
  });
  await page.route('**/*-genres.json.gz', route => route.fulfill({ status: 404 }));
  // Block audio and image network requests to keep tests fast
  await page.route('**/*.mp3', route => blockAudio
    ? route.abort()
    : ranges ? rangedMp3(route)
    : route.fulfill({ status: 200, headers: { 'Content-Type': 'audio/mpeg' }, body: fixtureMp3 }));
  await page.route('**/capa-m*.jpg', route => route.fulfill({ status: 404 }));
  await page.route('**/report-error', route => route.fulfill({ status: 204 }));
  await page.goto(url);
  // Wait for albums grid to be populated
  await page.waitForSelector('.album-item', { timeout: 8000 });
}

module.exports = { fixtureGz, fixtureMp3, rangedMp3, gotoWithFixture };
