const { defineConfig } = require('@playwright/test');

// Two runs at once (another session, a git worktree) must not share one static server: with
// reuseExistingServer the second run tests the first one's tree, and loses its server when the
// first run ends (dozens of ~1 s failures). Give each its own: PW_PORT=3457 npx playwright test
const PORT = Number(process.env.PW_PORT) || 3456;

module.exports = defineConfig({
  testDir: './tests',
  // Playwright owns *.spec.js; *.test.js belongs to `bun test` (see the
  // test:unit script). Ignoring the whole pattern rather than naming one file,
  // which is how tests/proxy-s3-normalization.test.js broke this run.
  testIgnore: ['**/*.test.js'],
  timeout: 20000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    actionTimeout: 5000,
    navigationTimeout: 10000,
    // page.route() can't see what a service worker fetches: once sw.js controls the page (any
    // reload), catalogs came from the real GitHub instead of the fixtures. sw.spec.js opts back in.
    serviceWorkers: 'block',
  },
  webServer: {
    command: `npx serve . -p ${PORT}`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 10000,
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
    // Safari/iOS is where a PWA audio player breaks first (background audio,
    // mediaSession, Range handling), so the playback and UI specs run on WebKit too.
    // Not run here: cdn.spec.js (live CDN, browser-independent) and radio.spec.js (whether
    // WebKit lets radio autoplay differs between macOS and Linux CI, so its initial state
    // isn't deterministic; radio has no Safari-specific code the main player doesn't share).
    {
      name: 'webkit',
      // WebKit's media loader fetches <audio> past page.route(), so unrouted tracks reached the
      // live CDN (the "Version/27.2 ref=http://localhost" hotlink refusals in /metrics, ~70 per
      // run). A dead proxy for everything but localhost makes those fail here instead.
      use: { browserName: 'webkit', proxy: { server: 'http://127.0.0.1:9', bypass: 'localhost,127.0.0.1' } },
      testIgnore: ['**/*.test.js', '**/cdn.spec.js', '**/radio.spec.js'],
    },
  ],
  reporter: [['list']],
});
