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

  // the challenges: no verdict until a run on this page; the original design passes none
  await page.getByTestId('course-next').click();
  await expect(page.getByTestId('course-step')).toHaveAttribute('data-step', '4:challenge');
  await expect(page.getByTestId('course-verdict')).toHaveCount(0);
  await page.getByTestId('course-run').click();
  await expect(page.getByTestId('course-challenge-retry-storm/recover').getByTestId('course-verdict')).toBeVisible({ timeout: 60_000 });
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

test('course: runs still reach the page after the design is replaced in the simulator (open or paste)', async ({ page }) => {
  await page.goto('/learn/?lang=en&speed=300&lesson=3.1');
  const frame = page.frameLocator('[data-testid="course-frame"]');
  await expect(frame.locator('[data-node]')).toHaveCount(5, { timeout: 30_000 });
  // what the file menu's open and paste do: load() a design, which drops the example
  type S = { getState: () => { doc: unknown; example: string | null; load: (d: unknown) => void } };
  const ex = await frame.locator('body').evaluate(() => {
    const s = (window as unknown as { __loadsketch: S }).__loadsketch.getState();
    s.load(JSON.parse(JSON.stringify(s.doc)));
    return (window as unknown as { __loadsketch: S }).__loadsketch.getState().example;
  });
  expect(ex).toBeNull();
  await page.getByTestId('course-next').click();
  await page.getByTestId('course-option-recover-never').click();
  await page.getByTestId('course-next').click();
  await page.getByTestId('course-run').click();
  await expect(page.getByTestId('course-answers')).toBeVisible({ timeout: 60_000 });
});

test('course: reopening an answered lesson does not log its guesses again', async ({ page }) => {
  await page.goto('/learn/?lang=en&speed=300&lesson=3.1');
  const frame = page.frameLocator('[data-testid="course-frame"]');
  await expect(frame.locator('[data-node]')).toHaveCount(5, { timeout: 30_000 });
  await page.getByTestId('course-next').click();
  await page.getByTestId('course-option-recover-never').click();
  await page.getByTestId('course-option-amp-x3').click();
  await page.getByTestId('course-next').click();
  await page.getByTestId('course-run').click();
  await expect(page.getByTestId('course-answers')).toBeVisible({ timeout: 60_000 });
  type S = { getState: () => { guessLog: unknown[] } };
  const logged = () => frame.locator('body').evaluate(() => (window as unknown as { __loadsketch: S }).__loadsketch.getState().guessLog.length);
  await expect.poll(logged).toBeGreaterThan(0);
  const n = await logged();
  // reopen the lesson: a new simulator; run again
  await page.reload();
  await expect(frame.locator('[data-node]')).toHaveCount(5, { timeout: 30_000 });
  await expect(page.getByTestId('course-status')).toHaveAttribute('data-status', 'idle');
  await page.getByTestId('course-run').click();
  await expect(page.getByTestId('course-status')).toHaveAttribute('data-status', 'done', { timeout: 60_000 });
  await page.waitForTimeout(500);
  expect(await logged()).toBe(n);
});

test('course: two tabs do not erase each other\'s progress', async ({ page }) => {
  const b = await page.context().newPage();
  await page.goto('/learn/?lang=en&lesson=2.1');
  await b.goto('/learn/?lang=en&lesson=3.1');
  await expect(page.getByTestId('course-step')).toHaveAttribute('data-step', /^0:/);
  await expect(b.getByTestId('course-step')).toHaveAttribute('data-step', /^0:/);
  await page.getByTestId('course-next').click();
  await b.getByTestId('course-next').click();
  const saved = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('loadsketch-course') ?? '{}').lessons ?? {}).sort());
  expect(saved).toEqual(['2.1', '3.1']);
  // and the other tab shows it
  await page.getByTestId('course-home').click();
  await expect(page.getByTestId('course-lesson-3.1')).toHaveAttribute('data-state', 'started');
});

test('course: the guess log records course guesses once, with the lesson', async ({ page }) => {
  await page.goto('/learn/?lang=en&speed=300&lesson=2.1');
  const frame = page.frameLocator('[data-testid="course-frame"]');
  await expect(frame.locator('[data-node="cache"]')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('course-next').click();
  await page.getByTestId('course-option-hit-most').click();
  await page.getByTestId('course-option-db-share-quarter').click();
  await page.getByTestId('course-next').click();
  await page.getByTestId('course-run').click();
  await expect(page.getByTestId('course-answer-hit')).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(500);
  const log = () => page.evaluate(() => (JSON.parse(localStorage.getItem('loadsketch-guess-log') ?? '{"entries":[]}').entries as { lesson?: string; question: string }[]).map((e) => `${e.lesson}:${e.question}`).sort());
  expect(await log()).toEqual(['2.1:db-share', '2.1:hit']);
  // a second run does not log them again
  await page.getByTestId('course-run').click();
  await expect(page.getByTestId('course-status')).toHaveAttribute('data-status', 'done', { timeout: 60_000 });
  await page.waitForTimeout(500);
  expect(await log()).toEqual(['2.1:db-share', '2.1:hit']);
});

test('course: a second guess on the same example waits for its own run (2.4)', async ({ page }) => {
  await page.goto('/learn/?lang=en&speed=300');
  test.skip((await page.getByTestId('course-lesson-2.4').getAttribute('data-state')) === 'soon', 'lesson 2.4 is not written on this branch');
  await page.goto('/learn/?lang=en&speed=300&lesson=2.4');
  const frame = page.frameLocator('[data-testid="course-frame"]');
  await expect(frame.locator('[data-node]').first()).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('course-next').click();
  await page.getByTestId('course-option-stale-share-some').click();
  await page.getByTestId('course-next').click();
  await page.getByTestId('course-run').click();
  await expect(page.getByTestId('course-answer-stale-share')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('course-answer-primary-busy')).toHaveCount(0);
  // the second guess is still open after the first run
  await page.getByTestId('course-next').click();
  await expect(page.getByTestId('course-step')).toHaveAttribute('data-step', '3:guess');
  await expect(page.getByTestId('course-option-primary-busy-high')).toBeEnabled();
  await page.getByTestId('course-option-primary-busy-high').click();
  await page.getByTestId('course-next').click();
  await expect(page.getByTestId('course-step')).toHaveAttribute('data-step', '4:try');
  // the first run did not answer this guess: no answer until a run of this step
  await expect(page.getByTestId('course-answers')).toHaveCount(0);
  await expect(page.getByTestId('course-answer-primary-busy')).toHaveCount(0);
  await expect(page.getByTestId('course-patch')).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId('course-patch').click();
  await page.getByTestId('course-run').click();
  // the try step shows the answer to the second guess, from the run with the change
  await expect(page.getByTestId('course-answer-primary-busy')).toBeVisible({ timeout: 60_000 });
  // with the 200 ms limit every read goes to the primary: 10% to 30% busy (without the change, under 10%)
  await expect(page.getByTestId('course-answer-primary-busy')).toContainText('Answer: 10% to 30%');
});

test('course: a run again shows the answer of that run; the score keeps the first', async ({ page }) => {
  await page.goto('/learn/?lang=en&speed=300&lesson=3.1');
  const frame = page.frameLocator('[data-testid="course-frame"]');
  await expect(frame.locator('[data-node]')).toHaveCount(5, { timeout: 30_000 });
  await page.getByTestId('course-next').click();
  await page.getByTestId('course-option-recover-never').click();
  await page.getByTestId('course-option-amp-x3').click();
  await page.getByTestId('course-next').click();
  await page.getByTestId('course-run').click();
  const recover = page.getByTestId('course-answer-recover');
  await expect(recover).toContainText('Answer: It stays broken', { timeout: 60_000 });
  // fix the storm (a retry budget on every connection that retries) and run again on this page
  await frame.locator('body').evaluate(() => {
    type E = { id: string; data?: { edge: { retries?: number } } };
    const s = (window as unknown as { __loadsketch: { getState: () => { edges: E[]; updateEdge: (id: string, p: Record<string, number>) => void } } }).__loadsketch.getState();
    for (const e of s.edges) if (e.data?.edge.retries) s.updateEdge(e.id, { retryBudget: 0.1 });
  });
  await page.getByTestId('course-run').click();
  await expect(page.getByTestId('course-status')).toHaveAttribute('data-status', 'running', { timeout: 30_000 });
  await expect(page.getByTestId('course-status')).toHaveAttribute('data-status', 'done', { timeout: 60_000 });
  // the answer and its explanation follow the run shown; a note says what the score counted
  await expect(recover).not.toContainText('Answer: It stays broken');
  await expect(page.getByTestId('course-scored-recover')).toContainText('It stays broken');
  while (!(await page.getByTestId('course-finish').isVisible())) await page.getByTestId('course-next').click();
  // never was right on the first run: the score keeps it
  await expect(page.getByTestId('course-score')).toHaveAttribute('data-right', /^[12]$/);
});

test('course: pause, go back, resume: the run still answers the guesses it started with', async ({ page }) => {
  await page.goto('/learn/?lang=en&speed=100&lesson=3.1');
  const frame = page.frameLocator('[data-testid="course-frame"]');
  await expect(frame.locator('[data-node]')).toHaveCount(5, { timeout: 30_000 });
  await page.getByTestId('course-next').click();
  await page.getByTestId('course-option-recover-never').click();
  await page.getByTestId('course-option-amp-x3').click();
  await page.getByTestId('course-next').click();
  await page.getByTestId('course-run').click();
  await expect(page.getByTestId('course-status')).toHaveAttribute('data-status', 'running', { timeout: 30_000 });
  type S = { getState: () => { pause: (p: boolean) => void; status: string } };
  const app = () => frame.locator('body');
  const pause = (p: boolean) => app().evaluate((_, v) => (window as unknown as { __loadsketch: S }).__loadsketch.getState().pause(v), p);
  const status = () => app().evaluate(() => (window as unknown as { __loadsketch: S }).__loadsketch.getState().status);
  await pause(true);
  await expect.poll(status).toBe('paused');
  await page.getByTestId('course-back').click();
  await expect(page.getByTestId('course-step')).toHaveAttribute('data-step', '1:guess');
  await pause(false);
  await expect.poll(status, { timeout: 120_000 }).toBe('done');
  await page.getByTestId('course-next').click();
  await expect(page.getByTestId('course-step')).toHaveAttribute('data-step', '2:run');
  await expect(page.getByTestId('course-answer-recover')).toBeVisible({ timeout: 120_000 });
});

test('course: a run paused before the next example does not keep the new simulator from answering (3.3)', async ({ page }) => {
  await page.goto('/learn/?lang=en&speed=100');
  test.skip((await page.getByTestId('course-lesson-3.3').getAttribute('data-state')) === 'soon', 'lesson 3.3 is not written on this branch');
  await page.goto('/learn/?lang=en&speed=100&lesson=3.3');
  const frame = page.frameLocator('[data-testid="course-frame"]');
  await expect(frame.locator('[data-node]').first()).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('course-next').click();
  await page.getByTestId('course-option-sale-limited-some').click();
  await page.getByTestId('course-next').click();
  await page.getByTestId('course-run').click();
  type S = { getState: () => { pause: (p: boolean) => void; status: string } };
  const app = () => frame.locator('body');
  await expect.poll(() => app().evaluate(() => (window as unknown as { __loadsketch: S }).__loadsketch.getState().status)).toBe('running');
  await app().evaluate(() => (window as unknown as { __loadsketch: S }).__loadsketch.getState().pause(true));
  await expect(page.getByTestId('course-status')).toHaveAttribute('data-status', 'paused');
  // on to the second experiment: another example, so a new simulator
  while ((await page.getByTestId('course-step').getAttribute('data-step')) !== '5:guess') await page.getByTestId('course-next').click();
  await page.getByTestId('course-option-tenant-small-some').click();
  await page.getByTestId('course-next').click();
  await expect(page.getByTestId('course-status')).toHaveAttribute('data-status', 'idle', { timeout: 30_000 });
  await page.getByTestId('course-run').click();
  await expect(page.getByTestId('course-answer-tenant-small')).toBeVisible({ timeout: 60_000 });
});

test('course: on a phone, Find limit runs and shows its result (1.2)', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/learn/?lang=en');
  // 1.2 needs Find limit; on a branch without it, any written lesson's simulator has the same run bar
  const id = (await page.getByTestId('course-lesson-1.2').getAttribute('data-state')) === 'soon' ? '2.1' : '1.2';
  await page.goto(`/learn/?lang=en&lesson=${id}`);
  const frame = page.frameLocator('[data-testid="course-frame"]');
  await expect(frame.locator('[data-node]').first()).toBeVisible({ timeout: 30_000 });
  await frame.getByTestId('find-limit-open').click();
  const panel = frame.getByTestId('find-limit');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('find-limit-result')).toBeVisible({ timeout: 200_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await frame.locator('body').evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // the panel is inside the simulator's width
  const box = await panel.boundingBox();
  const frameBox = await page.getByTestId('course-frame').boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(frameBox!.x + frameBox!.width + 1);
});

type LS = { getState: () => { limitOpen: boolean; limit: unknown; status: string; guessLog: { lesson?: string; question: string }[] } };

test('phone: closing the drawer ends the find-limit search', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/learn/?lang=en&lesson=2.1');
  const frame = page.frameLocator('[data-testid="course-frame"]');
  await expect(frame.locator('[data-node]').first()).toBeVisible({ timeout: 30_000 });
  await frame.getByTestId('find-limit-open').click();
  await expect(frame.getByTestId('find-limit-steps').locator('li').first()).toBeVisible({ timeout: 60_000 });
  await frame.getByTestId('phone-drawer-close').click();
  // the panel is gone at once, and the search stops: no more steps mark the canvas
  await expect(frame.getByTestId('find-limit')).toHaveCount(0);
  const app = () => frame.locator('body').evaluate(() => { const s = (window as unknown as { __loadsketch: LS }).__loadsketch.getState(); return { open: s.limitOpen, limit: JSON.stringify(s.limit) }; });
  // as the panel's own close: an unfinished search leaves no marks, now or later
  await expect.poll(async () => (await app()).limit).toBe('null');
  expect((await app()).open).toBe(false);
  await page.waitForTimeout(3000);
  expect((await app()).limit).toBe('null');
  // a tab ends it the same way
  await frame.getByTestId('find-limit-open').click();
  await expect(frame.getByTestId('find-limit-steps').locator('li').first()).toBeVisible({ timeout: 60_000 });
  await frame.getByTestId('phone-tab-inspector').click();
  await expect(frame.getByTestId('find-limit')).toHaveCount(0);
  await expect.poll(async () => (await app()).limit).toBe('null');
  await page.waitForTimeout(3000);
  expect((await app()).limit).toBe('null');
});

test('phone: a find-limit panel opened on a wide window shows in the drawer when the window gets narrow', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/learn/?lang=en&lesson=2.1');
  const frame = page.frameLocator('[data-testid="course-frame"]');
  await expect(frame.locator('[data-node]').first()).toBeVisible({ timeout: 30_000 });
  await frame.getByTestId('find-limit-open').click();
  await expect(frame.getByTestId('find-limit')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(frame.getByTestId('phone-drawer').getByTestId('find-limit')).toBeVisible();
  // and it closes and opens again
  await frame.getByTestId('phone-drawer-close').click();
  await expect(frame.getByTestId('find-limit')).toHaveCount(0);
  await frame.getByTestId('find-limit-open').click();
  await expect(frame.getByTestId('phone-drawer').getByTestId('find-limit')).toBeVisible();
});

test('course: a guess made while a run goes reaches the simulator when it ends (2.4)', async ({ page }) => {
  await page.goto('/learn/?lang=en&speed=100');
  test.skip((await page.getByTestId('course-lesson-2.4').getAttribute('data-state')) === 'soon', 'lesson 2.4 is not written on this branch');
  await page.goto('/learn/?lang=en&speed=100&lesson=2.4');
  const frame = page.frameLocator('[data-testid="course-frame"]');
  await expect(frame.locator('[data-node]').first()).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('course-next').click();
  await page.getByTestId('course-option-stale-share-some').click();
  await page.getByTestId('course-next').click();
  await page.getByTestId('course-run').click();
  const app = () => frame.locator('body').evaluate(() => { const s = (window as unknown as { __loadsketch: LS }).__loadsketch.getState(); return { status: s.status, log: s.guessLog.map((e) => `${e.lesson}:${e.question}`) }; });
  await expect.poll(async () => (await app()).status).toBe('running');
  // the second guess and its try page while the first run goes
  await page.getByTestId('course-next').click();
  await page.getByTestId('course-option-primary-busy-mid').click();
  await page.getByTestId('course-next').click();
  await expect(page.getByTestId('course-step')).toHaveAttribute('data-step', '4:try');
  await expect.poll(async () => (await app()).status, { timeout: 60_000 }).toBe('done');
  // the simulator's own Run button: the run logs the second guess
  await page.getByTestId('course-patch').click();
  await frame.getByTestId('run').click();
  await expect.poll(async () => (await app()).status, { timeout: 60_000 }).toBe('done');
  await expect.poll(async () => (await app()).log, { timeout: 10_000 }).toContain('2.4:primary-busy');
  await expect(page.getByTestId('course-answer-primary-busy')).toBeVisible();
});

test('course: guesses reach the simulator again after it loads another design', async ({ page }) => {
  await page.goto('/learn/?lang=en&speed=300&lesson=2.1');
  const frame = page.frameLocator('[data-testid="course-frame"]');
  await expect(frame.locator('[data-node="cache"]')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('course-next').click();
  await page.getByTestId('course-option-hit-most').click();
  await page.getByTestId('course-option-db-share-quarter').click();
  await page.getByTestId('course-next').click();
  // the learner loads a design in the frame (it drops the guesses), then runs it there
  await frame.locator('body').evaluate(() => { const s = (window as unknown as { __loadsketch: { getState: () => { doc: unknown; load: (d: unknown) => void } } }).__loadsketch.getState(); s.load(structuredClone(s.doc)); });
  await page.waitForTimeout(300);
  await frame.getByTestId('run').click();
  await expect(page.getByTestId('course-answer-hit')).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(500);
  const log = () => page.evaluate(() => (JSON.parse(localStorage.getItem('loadsketch-guess-log') ?? '{"entries":[]}').entries as { lesson?: string; question: string }[]).map((e) => `${e.lesson}:${e.question}`).sort());
  expect(await log()).toEqual(['2.1:db-share', '2.1:hit']);
});

test('course: a run from the simulator on the guess page, before Next, logs and scores the guesses', async ({ page }) => {
  await page.goto('/learn/?lang=en&speed=300&lesson=2.1');
  const frame = page.frameLocator('[data-testid="course-frame"]');
  await expect(frame.locator('[data-node="cache"]')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('course-next').click();
  await page.getByTestId('course-option-hit-most').click();
  await page.getByTestId('course-option-db-share-quarter').click();
  await frame.getByTestId('run').click();
  const status = () => frame.locator('body').evaluate(() => (window as unknown as { __loadsketch: { getState: () => { status: string } } }).__loadsketch.getState().status);
  await expect.poll(status, { timeout: 60_000 }).toBe('done');
  await page.waitForTimeout(500);
  const log = () => page.evaluate(() => (JSON.parse(localStorage.getItem('loadsketch-guess-log') ?? '{"entries":[]}').entries as { lesson?: string; question: string }[]).map((e) => `${e.lesson}:${e.question}`).sort());
  expect(await log()).toEqual(['2.1:db-share', '2.1:hit']);
  await page.getByTestId('course-next').click();
  await expect(page.getByTestId('course-answer-hit')).toBeVisible();
  await expect(page.getByTestId('course-answer-db-share')).toBeVisible();
});

test('the simulator links to the course: the top bar on a wide window', async ({ page }) => {
  await page.goto('/app/?lang=en');
  const link = page.getByTestId('open-course');
  await expect(link).toHaveText('Course');
  await link.click();
  await expect(page).toHaveURL(/\/learn\/$/);
  await expect(page.getByTestId('course-lesson-2.1')).toBeVisible();
});

test('the simulator links to the course: the More menu on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app/?lang=zh-TW');
  await expect(page.getByTestId('open-course')).toBeHidden();
  await page.getByTestId('more-menu').click();
  await expect(page.getByTestId('course-item')).toHaveText('課程');
  await page.getByTestId('course-item').click();
  await expect(page).toHaveURL(/\/learn\/$/);
  await expect(page.getByTestId('course-lesson-2.1')).toBeVisible();
});

test('the simulator in the course frame has no course link', async ({ page }) => {
  await page.goto('/learn/?lang=en&lesson=2.1');
  const frame = page.frameLocator('[data-testid="course-frame"]');
  await expect(frame.locator('[data-node]').first()).toBeVisible({ timeout: 30_000 });
  await expect(frame.getByTestId('open-course')).toHaveCount(0);
});

test('the intro site links to the course: the nav and next to the main button', async ({ page, request }) => {
  await page.goto('/?lang=en');
  for (const id of ['site-course', 'site-course-cta']) {
    const href = await page.getByTestId(id).getAttribute('href');
    expect(href).toBeTruthy();
    const res = await request.get(new URL(href!, page.url()).toString());
    expect(res.status(), id).toBe(200);
  }
  await expect(page.getByTestId('site-course-cta')).toContainText('Start the course');
  await page.getByTestId('site-course').click();
  await expect(page).toHaveURL(/\/learn\/$/);
  await expect(page.getByTestId('course-lesson-2.1')).toBeVisible();
});

test('course: a challenge judges only runs started on its page, not an earlier run of the same example', async ({ page }) => {
  await page.goto('/learn/?lang=en&speed=300&lesson=2.1');
  const frame = page.frameLocator('[data-testid="course-frame"]');
  await expect(frame.locator('[data-node="cache"]')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('course-next').click();
  await page.getByTestId('course-option-hit-most').click();
  await page.getByTestId('course-option-db-share-quarter').click();
  await page.getByTestId('course-next').click();
  await page.getByTestId('course-run').click();
  await expect(page.getByTestId('course-answer-hit')).toBeVisible({ timeout: 60_000 });
  const card = page.locator('[data-testid^="course-challenge-"]').first();
  for (let k = 0; k < 6 && !(await card.isVisible()); k++) await page.getByTestId('course-next').click();
  await expect(card).toBeVisible();
  // the run of the run page is not this challenge's
  await expect(page.getByTestId('course-verdict')).toHaveCount(0);
  await page.getByTestId('course-run').click();
  await expect(card.getByTestId('course-verdict')).toBeVisible({ timeout: 60_000 });
});

test('course: the Charts toggle opens the charts under the canvas, and stays after a reload', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/learn/?lang=en&lesson=2.1');
  const frame = page.frameLocator('[data-testid="course-frame"]');
  await expect(frame.locator('[data-node="cache"]')).toBeVisible({ timeout: 30_000 });
  const toggle = page.getByTestId('course-charts');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(frame.getByTestId('metrics-side')).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(frame.getByTestId('metrics-side')).toBeVisible();
  // the canvas and the lesson stay usable
  const box = await frame.locator('.react-flow').boundingBox();
  expect(box!.height).toBeGreaterThan(250);
  await expect(page.getByTestId('course-step')).toBeInViewport();
  await page.reload();
  await expect(frame.locator('[data-node="cache"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('course-charts')).toHaveAttribute('aria-pressed', 'true');
  await expect(frame.getByTestId('metrics-side')).toBeVisible();
  await page.getByTestId('course-charts').click();
  await expect(frame.getByTestId('metrics-side')).toHaveCount(0);
});

test('course: on a phone the Charts toggle opens the charts drawer in the simulator', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/learn/?lang=en&lesson=2.1');
  const frame = page.frameLocator('[data-testid="course-frame"]');
  await expect(frame.locator('[data-node]').first()).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('course-charts').click();
  await expect(frame.getByTestId('phone-drawer')).toHaveAttribute('data-open', '');
  await expect(frame.getByTestId('phone-drawer')).toHaveAttribute('aria-label', 'Charts');
  await expect(page.getByTestId('course-step')).toBeVisible();
  // no sideways scroll on the course page
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByTestId('course-charts').click();
  await expect(frame.getByTestId('phone-drawer')).not.toHaveAttribute('data-open', '');
});
