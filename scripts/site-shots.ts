// Takes the feature screenshots of the intro site (src/site/media/), headless: each feature in
// English and Chinese, light and dark, as WebP. It needs the cwebp command (brew install webp).
// Start the dev server first, then:
//   node scripts/site-shots.ts [http://127.0.0.1:5317] [feature]
// With a feature name (for example `brief`), only that one is taken.
import { chromium, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5317';
const ONLY = process.argv[3];
const OUT = join(import.meta.dirname, '..', 'src', 'site', 'media');

const done = (p: Page) => p.waitForFunction(() => (window as unknown as { __loadsketch: { getState(): { status: string } } }).__loadsketch.getState().status === 'done', null, { timeout: 60_000 });

/** How to bring the simulator to the screen each feature shows. */
const SHOTS: Record<string, { query: string; steps: (p: Page) => Promise<void> }> = {
  oncall: {
    query: 'example=three-tier&scenario=steady',
    steps: async (p) => {
      await p.getByTestId('open-practice').click();
      await p.getByTestId('oncall-start-gray-errors').click();
      await p.getByTestId('oncall-answer').waitFor({ timeout: 30_000 });
    },
  },
  brief: {
    query: 'example=three-tier',
    steps: async (p) => {
      await p.getByTestId('open-practice').click();
      await p.getByTestId('brief-start-brief-sale').click();
      await p.getByTestId('brief-text').waitFor();
    },
  },
  constraints: {
    query: 'example=three-tier&scenario=steady',
    steps: async (p) => {
      await p.getByTestId('open-practice').click();
      await p.getByTestId('problem-start-solo-shortener').click();
      await p.getByTestId('run').click();
      await p.getByRole('button', { name: /^(Skip to end|跳到結尾)$/ }).click();
      await done(p);
      await p.getByTestId('tab-learn').click();
    },
  },
  why: {
    query: 'example=retry-storm&speed=300&autorun=1',
    steps: async (p) => {
      await done(p);
      await p.getByTestId('tab-learn').click();
    },
  },
  terraform: {
    query: '',
    steps: async (p) => {
      await p.getByTestId('file-menu').click();
      await p.getByTestId('import-terraform').click();
      await p.getByTestId('import-example-lambda-sqs-rds').click();
      await p.locator('[data-node="lambda_function_api"]').waitFor();
    },
  },
  examples: {
    query: 'example=three-tier',
    steps: async (p) => {
      await p.getByRole('button', { name: /^(Examples|範例)$/ }).click();
      await p.getByRole('dialog').waitFor();
    },
  },
};

const browser = await chromium.launch({ headless: true });
for (const [name, shot] of Object.entries(SHOTS)) {
  if (ONLY && name !== ONLY) continue;
  for (const lang of ['en', 'zh-TW']) {
    for (const theme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, reducedMotion: 'reduce' });
      const p = await ctx.newPage();
      await p.goto(`${BASE}/app/?${shot.query}&lang=${lang}&theme=${theme}`);
      await p.locator('[data-node]').first().waitFor();
      await shot.steps(p);
      await p.waitForTimeout(700);
      const file = join(OUT, `${name}-${lang === 'en' ? 'en' : 'zh'}-${theme}`);
      await p.screenshot({ path: `${file}.png` });
      execFileSync('cwebp', ['-quiet', '-q', '80', `${file}.png`, '-o', `${file}.webp`]);
      rmSync(`${file}.png`);
      await ctx.close();
    }
  }
  console.log(name);
}
await browser.close();
