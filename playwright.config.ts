import { defineConfig } from '@playwright/test';

// Headless only: tests never open a visible window.
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5319',
    headless: true,
    viewport: { width: 1600, height: 960 },
    deviceScaleFactor: 1,
    // the existing tests check the Chinese text; the English test sets ?lang=en
    locale: 'zh-TW',
  },
  webServer: {
    // Dedicated port and reuseExistingServer: false ensure e2e never reuses a user's `npm run dev` on 5317 without builtin locale isolation.
    command: 'npx vite --port 5319 --strictPort',
    url: 'http://127.0.0.1:5319/app/',
    reuseExistingServer: false,
    timeout: 60_000,
    env: { LOADSKETCH_E2E_LOCALES: 'builtin' },
  },
});
