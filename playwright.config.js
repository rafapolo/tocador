const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  // Playwright owns *.spec.js; *.test.js belongs to `bun test` (see the
  // test:unit script). Ignoring the whole pattern rather than naming one file,
  // which is how tests/proxy-s3-normalization.test.js broke this run.
  testIgnore: ['**/*.test.js'],
  timeout: 20000,
  use: {
    baseURL: 'http://localhost:3456',
    actionTimeout: 5000,
    navigationTimeout: 10000,
  },
  webServer: {
    command: 'npx serve . -p 3456',
    port: 3456,
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
    // Not run here: cdn.spec.js (live CDN, browser-independent) and radio.spec.js
    // (WebKit blocks autoplay, so radio's tap-to-listen overlay covers its controls).
    {
      name: 'webkit',
      use: { browserName: 'webkit' },
      testIgnore: ['**/*.test.js', '**/cdn.spec.js', '**/radio.spec.js'],
    },
  ],
  reporter: [['list']],
});
