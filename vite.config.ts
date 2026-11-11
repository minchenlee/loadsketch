/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 5317, strictPort: true },
  preview: { host: '127.0.0.1', port: 5318, strictPort: true },
  worker: { format: 'es' },
  // Two pages: the intro site at / (index.html) and the simulator at /app/ (app/index.html).
  // base './' keeps every asset path relative, so the build works at any URL.
  base: './',
  build: { rollupOptions: { input: { site: 'index.html', app: 'app/index.html' } } },
  // Vitest runs the engine tests only; e2e/ belongs to Playwright.
  // testTimeout: the default 5 s fails heavy runs on a busy machine; speed budgets check CPU time
  // instead (tests/helpers.ts cpuMs). pool forks: one process per file, so CPU time is the file's own.
  test: { include: ['tests/**/*.test.ts'], testTimeout: 20_000, pool: 'forks' },
});
