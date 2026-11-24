import { defineConfig } from '@playwright/test';

// Headless only: tests never open a visible window.
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5317',
    headless: true,
    viewport: { width: 1600, height: 960 },
    deviceScaleFactor: 1,
    // the existing tests check the Chinese text; the English test sets ?lang=en
    locale: 'zh-TW',
  },
  webServer: {
    command: 'npx vite',
    url: 'http://127.0.0.1:5317/app/',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    // Restrict the main e2e server to built-in locales so extra files in src/i18n/locales/ do not break bilingual specs.
    env: { LOADSKETCH_E2E_LOCALES: 'builtin' },
  },
});
