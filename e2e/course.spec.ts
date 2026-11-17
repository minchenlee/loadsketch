// The course page (/learn/): the table of contents, one lesson step by step with the simulator in
// an iframe (?embed=1&course=1), progress kept in localStorage, and phone widths.
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const SHOTS = join(import.meta.dirname, '..', 'test-results', 'shots');
mkdirSync(SHOTS, { recursive: true });

const noSideways = async (page: Page) => {
  const [sw, w] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  expect(sw).toBeLessThanOrEqual(w);
};

test('course: the table of contents lists 7 units and 33 lessons, unwritten ones as coming soon', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/learn/?lang=en');
  await expect(page.getByTestId('course-unit')).toHaveCount(7);
  await expect(page.locator('[data-testid^="course-lesson-"]')).toHaveCount(33);
  // lessons with a course file are links
  await expect(page.getByTestId('course-lesson-2.1')).toHaveAttribute('data-state', 'ready');
  // 3.1 is written: a link; 1.4 is not yet: grey, no link
  await expect(page.getByTestId('course-lesson-3.1')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('course-lesson-3.1').locator('a')).toHaveCount(1);
  await expect(page.getByTestId('course-lesson-1.4')).toHaveAttribute('data-state', 'soon');
  await expect(page.getByTestId('course-lesson-1.4').locator('a')).toHaveCount(0);
  await expect(page.getByTestId('course-lesson-1.4')).toContainText('Coming soon');
  // the Chinese page translates the titles
  await page.getByTestId('course-lang').click();
  await expect(page.getByTestId('course-lesson-3.1')).toContainText('重試風暴');
  expect(errors).toEqual([]);
});

test('course: a lesson step by step — guess, run in the simulator, see the answers, pass a challenge, keep the progress', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // speed=300: the run in the frame ends in a few seconds
  await page.goto('/learn/?lang=en&theme=light&speed=300');
  await page.getByTestId('course-lesson-3.1').locator('a').click();
  await expect(page.getByTestId('course-lesson')).toBeVisible();
  await expect(page).toHaveURL(/lesson=3\.1/);
  const frame = page.frameLocator('[data-testid="course-frame"]');
  await expect(frame.locator('[data-node]')).toHaveCount(5, { timeout: 30_000 });
  await expect(page.getByTestId('course-step')).toHaveAttribute('data-step', '0:read');

  // the guesses
  await page.getByTestId('course-next').click();
  await expect(page.getByTestId('course-step')).toHaveAttribute('data-step', '1:guess');
  await expect(page.getByTestId('course-next')).toHaveText(/Skip/);
  await page.getByTestId('course-option-recover-never').click();
  await expect(page.getByTestId('course-option-recover-never')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('course-option-amp-x3').click();
  await expect(page.getByTestId('course-next')).toHaveText(/Next/);
  await page.getByTestId('course-next').click();
  await expect(page.getByTestId('course-step')).toHaveAttribute('data-step', '2:run');
  await page.screenshot({ path: join(SHOTS, 'course-lesson-run.png') });

  // the run happens in the frame; the answers are read from that run
  await page.getByTestId('course-run').click();
  await expect(page.getByTestId('course-answers')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('course-answer-recover')).toContainText('Measured:');
  await expect(page.getByTestId('course-answer-recover')).toHaveAttribute('data-right', 'true');
  await expect(page.getByTestId('course-answer-amp')).toContainText('Measured:');
  // the frame got the guesses too, as in the simulator (its guess log records them)
  const guesses = await frame.locator('body').evaluate(() => (window as unknown as { __loadsketch: { getState: () => { guesses: Record<string, string> } } }).__loadsketch.getState().guesses);
  expect(guesses).toEqual({ recover: 'never', amp: 'x3' });
  await page.screenshot({ path: join(SHOTS, 'course-lesson-answers.png') });
  const right = await page.locator('[data-testid^="course-answer-"][data-right]').count();
  expect(right).toBeGreaterThanOrEqual(1);

  // the try step sends its change to the frame
  await page.getByTestId('course-next').click();
  await expect(page.getByTestId('course-step')).toHaveAttribute('data-step', '3:try');
  await page.getByTestId('course-patch').click();
  await expect
    .poll(() => frame.locator('body').evaluate(() => (window as unknown as { __loadsketch: { getState: () => { edges: { id: string; data?: { edge: { retries?: number } } }[] } } }).__loadsketch.getState().edges.find((e) => e.id === 'lb->api')?.data?.edge.retries))
    .toBe(0);

  // the challenges: the original design (the run before the change) passes none
  await page.getByTestId('course-next').click();
  await expect(page.getByTestId('course-step')).toHaveAttribute('data-step', '4:challenge');
  await expect(page.getByTestId('course-challenge-retry-storm/recover').getByTestId('course-verdict')).toBeVisible();
  await expect(page.getByTestId('course-passed')).toHaveCount(0);

  // change the design in the frame (a retry budget on every connection), run again: passed
  await frame.locator('body').evaluate(() => {
    type E = { id: string; data?: { edge: { retries?: number } } };
    const s = (window as unknown as { __loadsketch: { getState: () => { edges: E[]; updateEdge: (id: string, p: Record<string, number>) => void } } }).__loadsketch.getState();
    for (const e of s.edges) if (e.data?.edge.retries) s.updateEdge(e.id, { retryBudget: 0.1 });
  });
  await page.getByTestId('course-run').click();
  await expect(page.getByTestId('course-challenge-retry-storm/recover').getByTestId('course-passed')).toBeVisible({ timeout: 60_000 });

  // the progress is kept: after a reload the lesson opens on the same step, guesses locked
  await page.reload();
  await expect(page.getByTestId('course-step')).toHaveAttribute('data-step', '4:challenge');
  await expect(page.getByTestId('course-challenge-retry-storm/recover').getByTestId('course-passed')).toBeVisible();
  for (let k = 0; k < 3; k++) await page.getByTestId('course-back').click();
  await expect(page.getByTestId('course-step')).toHaveAttribute('data-step', '1:guess');
  await expect(page.getByTestId('course-option-amp-x6')).toBeDisabled();

  // the last page; the table of contents shows the lesson as done
  for (let k = 0; k < 5; k++) await page.getByTestId('course-next').click();
  await expect(page.getByTestId('course-finish')).toBeVisible();
  // the score of the guesses is kept with the progress: no run in this visit, still counted
  await expect(page.getByTestId('course-score')).toHaveAttribute('data-right', String(right));
  await page.getByTestId('course-home').click();
  await expect(page.getByTestId('course-lesson-3.1')).toHaveAttribute('data-state', 'done');
  expect(errors).toEqual([]);
});

test('course: lesson 2.1 from its course file — guess, run, answers from the run', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/learn/?lang=en&speed=300&lesson=2.1');
  await expect(page.getByRole('heading', { name: 'Hit ratio decides the database' })).toBeVisible();
  const frame = page.frameLocator('[data-testid="course-frame"]');
  await expect(frame.locator('[data-node="cache"]')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('course-next').click();
  await page.getByTestId('course-option-hit-most').click();
  await page.getByTestId('course-next').click();
  await page.getByTestId('course-run').click();
  await expect(page.getByTestId('course-answer-hit')).toContainText('Hit ratio', { timeout: 60_000 });
  await expect(page.getByTestId('course-answer-db-share')).toContainText('Measured:');
  expect(errors).toEqual([]);
});

test('course: broken saved progress or no storage still opens the course', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('loadsketch-course', '{not json'));
  await page.goto('/learn/?lang=en&lesson=3.1');
  await expect(page.getByTestId('course-step')).toHaveAttribute('data-step', '0:read');
  await page.getByTestId('course-next').click();
  await expect(page.getByTestId('course-step')).toHaveAttribute('data-step', '1:guess');

  const page2 = await page.context().newPage();
  await page2.addInitScript(() => {
    const no = () => {
      throw new Error('storage is off');
    };
    Object.defineProperty(window, 'localStorage', { get: no });
  });
  await page2.goto('/learn/?lang=en');
  await expect(page2.locator('[data-testid^="course-lesson-"]')).toHaveCount(33);
});

for (const theme of ['light', 'dark'] as const) {
  test(`course: no sideways scroll at phone width (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/learn/?lang=en&theme=${theme}`);
    await expect(page.locator('[data-testid^="course-lesson-"]')).toHaveCount(33);
    await noSideways(page);
    await page.screenshot({ path: join(SHOTS, `course-catalog-phone-${theme}.png`) });
    await page.getByTestId('course-lesson-3.1').locator('a').click();
    await expect(page.frameLocator('[data-testid="course-frame"]').locator('[data-node]')).toHaveCount(5, { timeout: 30_000 });
    await noSideways(page);
    await page.getByTestId('course-next').click();
    await noSideways(page);
    await page.screenshot({ path: join(SHOTS, `course-lesson-phone-${theme}.png`) });
    // Chinese text is wider in places
    await page.getByTestId('course-lang').click();
    await noSideways(page);
  });
}

test('course: changing the theme or the language keeps the design in the simulator', async ({ page }) => {
  await page.goto('/learn/?lang=en&theme=light&lesson=3.1');
  const frame = page.frameLocator('[data-testid="course-frame"]');
  await expect(frame.locator('[data-node]')).toHaveCount(5, { timeout: 30_000 });
  type S = { getState: () => { lang: string; edges: { id: string; data?: { edge: { retryBudget?: number } } }[]; updateEdge: (id: string, p: Record<string, number>) => void } };
  await frame.locator('body').evaluate(() => {
    (window as unknown as { __same: boolean }).__same = true;
    (window as unknown as { __loadsketch: S }).__loadsketch.getState().updateEdge('lb->api', { retryBudget: 0.1 });
  });
  const look = () =>
    frame.locator('body').evaluate(() => {
      const s = (window as unknown as { __loadsketch: S }).__loadsketch.getState();
      return { same: (window as unknown as { __same?: boolean }).__same === true, dark: document.documentElement.classList.contains('dark'), lang: s.lang, budget: s.edges.find((e) => e.id === 'lb->api')?.data?.edge.retryBudget };
    });
  await page.getByTestId('course-theme').click();
  await expect.poll(look).toEqual({ same: true, dark: true, lang: 'en', budget: 0.1 });
  await page.getByTestId('course-lang').click();
  await expect.poll(look).toEqual({ same: true, dark: true, lang: 'zh-TW', budget: 0.1 });
});

for (const width of [470, 500, 512, 560]) {
  test(`course: the simulator's settings can be reached at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/learn/?lang=en&lesson=3.1');
    const frame = page.frameLocator('[data-testid="course-frame"]');
    await expect(frame.locator('[data-node]')).toHaveCount(5, { timeout: 30_000 });
    // the phone layout's tabs, or the desktop's settings panel: one of them is there
    await expect(frame.getByTestId('phone-tab-inspector').or(frame.getByRole('tab', { name: 'Results', exact: true }))).toBeVisible();
  });
}

test('course: the guesses lock as soon as a run starts', async ({ page }) => {
  // normal speed: the run is still going when the learner goes back
  await page.goto('/learn/?lang=en&lesson=3.1');
  const frame = page.frameLocator('[data-testid="course-frame"]');
  await expect(frame.locator('[data-node]')).toHaveCount(5, { timeout: 30_000 });
  await page.getByTestId('course-next').click();
  await page.getByTestId('course-option-recover-never').click();
  await page.getByTestId('course-next').click();
  await page.getByTestId('course-run').click();
  await expect(page.getByTestId('course-status')).toHaveAttribute('data-status', 'running');
  await page.getByTestId('course-back').click();
  await expect(page.getByTestId('course-step')).toHaveAttribute('data-step', '1:guess');
  await expect(page.getByTestId('course-option-recover-fast')).toBeDisabled();
  await expect(page.getByTestId('course-option-amp-x6')).toBeDisabled();
});

test('course: a run the simulator refuses does not lock the guesses', async ({ page }) => {
  await page.goto('/learn/?lang=en&speed=300&lesson=3.1');
  const frame = page.frameLocator('[data-testid="course-frame"]');
  await expect(frame.locator('[data-node]')).toHaveCount(5, { timeout: 30_000 });
  await page.getByTestId('course-next').click();
  await page.getByTestId('course-option-recover-never').click();
  await page.getByTestId('course-next').click();
  // a design the simulator does not run: the users have no connection out
  type S = { getState: () => { edges: { id: string; source: string }[]; onEdgesChange: (c: { type: 'remove'; id: string }[]) => void } };
  const out = await frame.locator('body').evaluate(() => {
    const s = (window as unknown as { __loadsketch: S }).__loadsketch.getState();
    const e = s.edges.filter((x) => x.source === 'users');
    s.onEdgesChange(e.map((x) => ({ type: 'remove', id: x.id })));
    return e.length;
  });
  expect(out).toBeGreaterThan(0);
  await page.getByTestId('course-run').click();
  await page.waitForTimeout(1000);
  await expect(page.getByTestId('course-status')).not.toHaveAttribute('data-status', 'running');
  await page.getByTestId('course-back').click();
  await expect(page.getByTestId('course-option-recover-fast')).toBeEnabled();
  await page.getByTestId('course-option-amp-x6').click();
  await expect(page.getByTestId('course-option-amp-x6')).toHaveAttribute('aria-checked', 'true');
});
