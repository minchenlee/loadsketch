import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { readStoredZip } from '../scripts/zip.ts';
import { plan } from '../tests/import/plan-helper.ts';
import { importTerraform } from '../src/import/terraform/index.ts';

const SHOTS = join(import.meta.dirname, '..', 'test-results', 'shots');
mkdirSync(SHOTS, { recursive: true });

async function clockSeconds(page: Page): Promise<number> {
  const text = (await page.getByTestId('clock').textContent()) ?? '';
  return Number(text.split('/')[0]) || 0;
}

async function waitForClock(page: Page, s: number) {
  await expect.poll(() => clockSeconds(page), { timeout: 60_000, intervals: [250] }).toBeGreaterThan(s);
}

for (const theme of ['light', 'dark'] as const) {
  test(`three-tier design under a traffic spike (${theme})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`/app/?example=three-tier&scenario=spike&speed=3&autorun=1&theme=${theme}`);
    await expect(page.locator('[data-node]')).toHaveCount(5);
    await waitForClock(page, 26); // the spike starts at 20 s
    await page.getByTestId('pause').click();
    await page.waitForTimeout(300);
    // traffic particles are moving on the edges
    expect(Number(await page.getByTestId('edge-flow').getAttribute('data-particles'))).toBeGreaterThan(10);
    // the API servers are saturated and the metrics show failures
    await expect(page.locator('[data-node="api"]')).toContainText('100%');
    await expect(page.getByTestId('kpis')).toContainText('p99');
    expect(Number((await page.getByTestId('kpis').locator('div.num').nth(1).textContent())?.replace(/[^\d.]/g, ''))).toBeGreaterThan(0);
    await page.screenshot({ path: join(SHOTS, `three-tier-spike-${theme}.png`) });
    expect(errors).toEqual([]);
  });
}

test('slow motion shows single requests moving along their path', async ({ page }) => {
  await page.goto('/app/?example=three-tier&scenario=steady&speed=0.03&autorun=1&theme=light&select=api');
  await page.waitForTimeout(5000);
  await expect.poll(async () => Number(await page.getByTestId('edge-flow').getAttribute('data-dots')), { timeout: 15_000 }).toBeGreaterThan(0);
  await page.screenshot({ path: join(SHOTS, 'three-tier-slow-motion.png') });
});

test('jump to the end explains the bottleneck and compares with theory', async ({ page }) => {
  await page.goto('/app/?example=three-tier&scenario=spike&speed=1&autorun=1&theme=light&select=api');
  await expect(page.getByRole('button', { name: '跳到結尾' })).toBeVisible();
  await page.getByRole('button', { name: '跳到結尾' }).click();
  await expect(page.getByTestId('bottleneck')).toContainText('API 伺服器', { timeout: 30_000 });
  // the view stops where the traffic stops, so the last second still has numbers
  await expect(page.getByTestId('clock')).toContainText('60.0 / 60');
  await expect(page.getByTestId('kpis').locator('div.num').nth(2)).not.toHaveText('–');
  await expect(page.getByText('和排隊理論對照')).toBeVisible();
  await page.screenshot({ path: join(SHOTS, 'three-tier-result.png') });
});

test('a loaded example saves back to the same bytes', async ({ page }) => {
  const dir = join(import.meta.dirname, '..', 'examples', 'designs');
  for (const name of readdirSync(dir).map((f) => f.replace(/\.json$/, ''))) {
    await page.goto(`/app/?example=${name}`);
    await expect(page.locator('[data-node]').first()).toBeVisible();
    const text = await page.evaluate(() => (window as unknown as { __loadsketch: { getState: () => { exportText: () => string } } }).__loadsketch.getState().exportText());
    expect(text).toBe(readFileSync(join(import.meta.dirname, '..', 'examples', 'designs', `${name}.json`), 'utf8'));
  }
});

test('⌘B, ⌥⌘B and ⌘J hide and show the left, right and bottom panels', async ({ page }) => {
  await page.goto('/app/?example=three-tier&select=api');
  const left = page.getByRole('complementary', { name: '元件' });
  const right = page.getByRole('complementary', { name: '設定' });
  const bottom = page.getByRole('region', { name: '指標' });
  await expect(left).toBeVisible();
  await expect(right).toBeVisible();
  await expect(bottom).toBeVisible();
  await page.keyboard.press('ControlOrMeta+b');
  await expect(left).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+Alt+b');
  await expect(right).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+j');
  await expect(bottom).toHaveCount(0);
  await page.screenshot({ path: join(SHOTS, 'panels-hidden.png') });
  // the choice survives a reload
  await page.reload();
  await expect(page.locator('[data-node]').first()).toBeVisible();
  await expect(left).toHaveCount(0);
  // the top-bar buttons do the same
  await page.getByRole('button', { name: '顯示元件面板' }).click();
  await page.getByRole('button', { name: '顯示設定面板' }).click();
  await page.getByRole('button', { name: '顯示指標面板' }).click();
  await expect(left).toBeVisible();
  await expect(right).toBeVisible();
  await expect(bottom).toBeVisible();
});

test.describe('a click opens the panel (M13)', () => {
  test.beforeEach(async ({ page }) => {
    // the right panel was closed before
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('m13')) localStorage.setItem('loadsketch-panels', JSON.stringify({ left: true, right: false, bottom: true }));
      sessionStorage.setItem('m13', '1');
    });
    await page.goto('/app/?example=three-tier');
    await expect(page.locator('[data-node]')).toHaveCount(5);
  });
  const right = (page: Page) => page.getByTestId('right-panel');
  const selected = (page: Page) => page.evaluate(() => (window as unknown as { __loadsketch: { getState(): { selected: { id: string; type: string } | null } } }).__loadsketch.getState().selected);

  test('opens the panel on its settings when a component or a call is clicked; closed by hand, it stays closed until the next click', async ({ page }) => {
    await expect(right(page)).toHaveCount(0);
    await page.locator('[data-node="api"]').click();
    await expect(right(page)).toBeVisible();
    await expect(page.getByTestId('tab-design')).toHaveAttribute('aria-selected', 'true');
    expect(await selected(page)).toEqual({ id: 'api', type: 'node' });
    // the choice is saved, as with the panel button
    expect(JSON.parse((await page.evaluate(() => localStorage.getItem('loadsketch-panels')))!).right).toBe(true);
    // on another tab, a click on a component of the open panel leaves the panel open
    await page.getByTestId('tab-versions').click();
    // closed by hand: it stays closed while nothing is clicked, also when a component is selected another way
    await page.getByRole('button', { name: '隱藏設定面板' }).click();
    await expect(right(page)).toHaveCount(0);
    await page.evaluate(() => (window as unknown as { __loadsketch: { getState(): { select(s: { id: string; type: string }): void } } }).__loadsketch.getState().select({ id: 'db', type: 'node' }));
    await page.waitForTimeout(300);
    await expect(right(page)).toHaveCount(0);
    // the same component clicked again: open, on its settings (not the versions tab it had)
    await page.locator('[data-node="api"]').click();
    await expect(right(page)).toBeVisible();
    await expect(page.getByTestId('tab-design')).toHaveAttribute('aria-selected', 'true');
    // a call opens it too
    await page.getByRole('button', { name: '隱藏設定面板' }).click();
    await expect(right(page)).toHaveCount(0);
    // the call from the load balancer to the API server is a straight line between the two cards
    const lb = (await page.locator('[data-node="lb"]').boundingBox())!;
    const api = (await page.locator('[data-node="api"]').boundingBox())!;
    await page.mouse.click(lb.x + lb.width + (api.x - lb.x - lb.width) * 0.3, lb.y + lb.height / 2);
    await expect(right(page)).toBeVisible();
    await expect(page.getByTestId('tab-design')).toHaveAttribute('aria-selected', 'true');
    const edgeSel = await page.evaluate(() => {
      const st = (window as unknown as { __loadsketch: { getState(): { selected: { id: string; type: string } | null; edges: { id: string; source: string; target: string }[] } } }).__loadsketch.getState();
      const e = st.selected?.type === 'edge' ? st.edges.find((x) => x.id === st.selected!.id) : undefined;
      return e && `${e.source}>${e.target}`;
    });
    expect(edgeSel).toBe('lb>api');
  });

  test('opens the panel only on a click: a drag or a box select keeps it closed', async ({ page }) => {
    const box = (await page.locator('[data-node="api"]').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    await expect(right(page)).toHaveCount(0);
    // it moved, so this was a drag
    const after = (await page.locator('[data-node="api"]').boundingBox())!;
    expect(after.x - box.x).toBeGreaterThan(30);
    // a box select with Shift over two components
    const users = (await page.locator('[data-node="users"]').boundingBox())!;
    const lb = (await page.locator('[data-node="lb"]').boundingBox())!;
    await page.keyboard.down('Shift');
    await page.mouse.move(users.x - 30, users.y - 30);
    await page.mouse.down();
    await page.mouse.move(lb.x + lb.width + 20, lb.y + lb.height + 30, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await page.waitForTimeout(300);
    await expect(right(page)).toHaveCount(0);
    // undo (the drag above) does not open it either
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForTimeout(300);
    await expect(right(page)).toHaveCount(0);
  });
});

test('dropdowns are our own menus and work with the keyboard', async ({ page }) => {
  await page.goto('/app/?example=three-tier&scenario=steady');
  await expect(page.locator('select')).toHaveCount(0);
  await expect(page.locator('input[type="number"]')).toHaveCount(0);
  const sc = page.getByRole('button', { name: '情境' });
  await sc.click();
  await page.getByRole('option', { name: /突波/ }).click();
  await expect(sc).toContainText('突波');
  await expect(page.getByTestId('events')).toBeVisible();
  // keyboard: open the speed menu, move down, pick
  const speed = page.getByTestId('speed');
  await speed.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox', { name: '速度' })).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(speed).toContainText('3×');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  // the rps field steps with the arrow keys
  const rps = page.getByLabel('每秒請求數');
  const before = Number(await rps.inputValue());
  await rps.focus();
  await page.keyboard.press('ArrowUp');
  await expect(rps).toHaveValue(String(before + 50));
});

test('a stacked node expands to one row per instance', async ({ page }) => {
  await page.goto('/app/?example=three-tier&scenario=spike&speed=1');
  const api = page.locator('[data-node="api"]');
  await api.getByRole('button', { name: /展開 3 台實例/ }).click();
  await expect(page.locator('[data-instances="api"] [data-instance]')).toHaveCount(3);
  const db = page.locator('[data-node="db"]');
  await db.getByRole('button', { name: /展開/ }).click();
  await expect(page.locator('[data-instances="db"]')).toContainText('主庫');
  await expect(page.locator('[data-instances="db"]')).toContainText('副本 1');
  await page.getByTestId('run').click();
  await waitForClock(page, 3);
  // live numbers: busy/slots per instance
  await expect(page.locator('[data-instances="api"] [data-instance="0"]')).toContainText(/\d+\/4/);
  await page.getByTestId('pause').click();
  await page.screenshot({ path: join(SHOTS, 'expanded-instances.png') });
  await api.getByRole('button', { name: /收合/ }).click();
  await expect(page.locator('[data-instances="api"]')).toHaveCount(0);
});

test('every example opens with its own scenario and no overlapping cards', async ({ page }) => {
  const dir = join(import.meta.dirname, '..', 'examples', 'designs');
  for (const name of readdirSync(dir).map((f) => f.replace(/\.json$/, ''))) {
    await page.goto(`/app/?example=${name}`);
    await expect(page.locator('[data-node]').first()).toBeVisible();
    if (existsSync(join(dir, '..', 'scenarios', `${name}.json`))) await expect(page.getByRole('button', { name: '情境' })).not.toContainText('平穩流量');
    // the cards take their places a moment after the first one shows: wait until none overlap
    const overlaps = () => page.locator('[data-node]').evaluateAll((els) => {
      const boxes = els.map((e) => { const r = e.getBoundingClientRect(); return { id: e.getAttribute('data-node'), x: r.x, y: r.y, w: r.width, h: r.height }; });
      const out: string[] = [];
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i], b = boxes[j];
          if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) out.push(`${a.id} overlaps ${b.id}`);
        }
      }
      return out;
    });
    await expect.poll(overlaps, { message: name, timeout: 5000 }).toEqual([]);
  }
});

for (const [name, theme] of [['flash-sale', 'light'], ['hot-shard', 'dark'], ['timeline-fanout', 'light'], ['saas-stripe', 'dark'], ['saas-github', 'light'], ['saas-netflix', 'dark']] as const) {
  test(`${name} runs to the end (${theme})`, async ({ page }) => {
    await page.goto(`/app/?example=${name}&theme=${theme}&autorun=1`);
    await expect(page.getByRole('button', { name: '跳到結尾' })).toBeVisible();
    await page.getByRole('button', { name: '跳到結尾' }).click();
    await expect(page.getByTestId('run')).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) });
  });
}

test('cache-aside edges show the read order; a plain database edge does not', async ({ page }) => {
  await page.goto('/app/?example=three-tier');
  const order = page.getByTestId('aside-order');
  await expect(order).toHaveCount(2);
  await expect(order.filter({ hasText: '① 讀取先查' })).toHaveCount(1);
  await expect(order.filter({ hasText: '② 沒命中才查' })).toHaveCount(1);
  await page.goto('/app/?example=replica-lag');
  await expect(page.getByTestId('rf__node-db')).toBeVisible();
  await expect(page.getByTestId('aside-order')).toHaveCount(0);
});

test('English UI: no Chinese text, the toggle switches back, an edited design keeps its text', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/app/?example=three-tier&scenario=spike&speed=10&autorun=1&lang=en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await waitForClock(page, 25);
  await page.getByTestId('pause').click();
  // the language button names the other language on purpose ("中文")
  const cjk = await page.evaluate(() => {
    const out: string[] = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const s = n.textContent ?? '';
      if (/[一-鿿]/.test(s) && !n.parentElement?.closest('[data-testid="lang"]')) out.push(s.trim());
    }
    for (const el of document.querySelectorAll('[title],[aria-label]')) {
      for (const a of ['title', 'aria-label']) {
        const s = el.getAttribute(a) ?? '';
        if (/[一-鿿]/.test(s) && !el.closest('[data-testid="lang"]')) out.push(`${a}: ${s}`);
      }
    }
    return out;
  });
  expect(cjk).toEqual([]);
  await page.screenshot({ path: join(SHOTS, 'english.png') });

  // switch to Chinese: an unedited example comes back in Chinese
  await page.getByTestId('stop').or(page.getByRole('button', { name: 'Stop' })).first().click();
  await page.getByTestId('more-menu').click();
  await page.getByTestId('lang').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant');
  await expect(page.getByTestId('run')).toContainText('執行');
  await expect(page.locator('[data-node]').first()).toContainText(/[一-鿿]/);

  // rename a node, switch to English: the user's text stays
  await page.evaluate(() => {
    const st = (window as unknown as { __loadsketch: { getState(): { nodes: { id: string }[]; updateNode(id: string, p: { label: string }): void } } }).__loadsketch.getState();
    st.updateNode(st.nodes[0].id, { label: '我的入口' });
  });
  // zoom in; the language change must keep this view
  await page.locator('.react-flow__controls-zoomin').click();
  await page.waitForTimeout(400);
  const view = () => page.locator('.react-flow__viewport').getAttribute('style');
  const before = await view();
  await page.getByTestId('more-menu').click();
  await page.getByTestId('lang').click();
  await expect(page.getByTestId('run')).toContainText('Run');
  await expect(page.locator('[data-node]').filter({ hasText: '我的入口' })).toHaveCount(1);
  // the other, unedited labels are English again, and the edited one stays
  const labels = await page.evaluate(() => (window as unknown as { __loadsketch: { getState(): { nodes: { data: { node: { label?: string } } }[] } } }).__loadsketch.getState().nodes.map((n) => n.data.node.label ?? ''));
  expect(labels.filter((x) => /[\u4e00-\u9fff]/.test(x))).toEqual(['我的入口']);
  expect(await view()).toBe(before);
  // the example browser is in English too
  await page.getByTestId('open-examples').click();
  const browser = page.getByRole('dialog', { name: 'Examples' });
  await expect(browser).toBeVisible();
  await expect(browser).not.toContainText(/[\u4e00-\u9fff]/);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('a language change during a run: late messages from the stopped run are dropped', async ({ page }) => {
  await page.goto('/app/?example=three-tier&scenario=spike&speed=10&autorun=1&lang=en');
  await waitForClock(page, 3);
  await page.getByTestId('more-menu').click();
  await page.getByTestId('lang').click();
  await page.waitForTimeout(1500);
  const st = await page.evaluate(() => {
    const s = (window as unknown as { __loadsketch: { getState(): { status: string; result: unknown; timeline: unknown[]; windows: unknown[] } } }).__loadsketch.getState();
    return { status: s.status, result: s.result, timeline: s.timeline.length, windows: s.windows.length };
  });
  expect(st).toEqual({ status: 'idle', result: null, timeline: 0, windows: 0 });
  await expect(page.getByTestId('clock')).toContainText('尚未執行');
});

test('retry-storm lesson: guess, run, see the answer and the story, then pass a challenge', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/app/?example=retry-storm&speed=10&theme=light');
  // a lesson example opens on the lesson tab
  await expect(page.getByTestId('tab-learn')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('quiz')).toBeVisible();
  // the example's description gives the answer away, so it waits for the first run
  const panel = page.getByRole('complementary', { name: '設定' });
  await page.getByTestId('tab-design').click();
  await expect(panel).toContainText('先猜會發生什麼');
  await expect(panel).not.toContainText('再也沒有恢復');
  await expect(page.getByTestId('quiz')).toHaveCount(0);
  await page.getByTestId('tab-learn').click();
  await page.getByTestId('guess-recover-fast').click();
  await expect(page.getByTestId('guess-recover-fast')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('answer-recover')).toHaveCount(0);
  // the example as it ships: the guess "recovers fast" is wrong, the story ends stuck
  await page.getByRole('button', { name: '執行' }).click();
  await page.getByRole('button', { name: '跳到結尾' }).click();
  await expect(page.getByTestId('answer-recover')).toContainText('猜錯了', { timeout: 30_000 });
  await expect(page.getByTestId('why')).toContainText('重試');
  await expect(page.getByTestId('challenge-retry-storm/recover')).not.toContainText('過關！');
  // the guess was made before the run: it cannot be changed now
  await expect(page.getByTestId('guess-recover-never')).toBeDisabled();
  await page.screenshot({ path: join(SHOTS, 'lesson-retry-storm-stuck.png'), fullPage: true });
  await page.getByTestId('tab-design').click();
  await expect(panel).toContainText('再也沒有恢復');
  // fail fast: a short queue on the API servers passes two challenges
  await page.locator('[data-node="api"]').click();
  await page.getByRole('textbox', { name: '排隊上限' }).fill('20');
  await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } });
  await page.getByRole('button', { name: '再跑一次' }).click();
  await page.getByRole('button', { name: '跳到結尾' }).click();
  // the run ended while the settings tab was open: the lesson tab is marked, and the run is
  // already judged and saved although the lesson tab was closed
  await expect(page.getByLabel('有新的說明')).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('loadsketch-passed') ?? '[]')))
    .toEqual(['retry-storm/recover', 'retry-storm/fail-less']);
  await page.getByTestId('tab-learn').click();
  await expect(page.getByLabel('有新的說明')).toHaveCount(0);
  await expect(page.getByTestId('challenge-retry-storm/recover').getByTestId('passed')).toBeVisible();
  await expect(page.getByTestId('challenge-retry-storm/fail-less').getByTestId('passed')).toBeVisible();
  await expect(page.getByTestId('challenge-retry-storm/keep-retries')).not.toContainText('過關！');
  await expect(page.getByTestId('answer-recover')).toContainText('猜對了');
  await expect(page.getByTestId('answer-recover')).toContainText('沒讓重試堆起來');
  await page.screenshot({ path: join(SHOTS, 'lesson-retry-storm-passed.png'), fullPage: true });
  // selecting a part shows its settings
  await page.locator('[data-node="api"]').click();
  await expect(page.getByTestId('tab-design')).toHaveAttribute('aria-selected', 'true');
  // passed challenges are remembered
  await page.reload();
  await expect(page.getByTestId('challenge-retry-storm/recover')).toContainText('已過關');
  expect(errors).toEqual([]);
});

test('the example browser: categories, search, and opening an example', async ({ page }) => {
  await page.goto('/app/?example=three-tier&theme=light');
  await page.getByTestId('open-examples').click();
  const dialog = page.getByRole('dialog', { name: '範例' });
  await expect(dialog).toBeVisible();
  // it opens on the category of the current example
  await expect(dialog.getByRole('button', { name: /基礎架構/ })).toHaveAttribute('aria-current', 'true');
  await expect(dialog.getByTestId('example-three-tier')).toBeVisible();
  // two tiers (Q16=A): one mechanism per example first, then whole real systems
  await expect(dialog.getByTestId('tier-start')).toContainText('入門');
  await expect(dialog.getByTestId('tier-start').getByRole('button', { name: /基礎架構/ })).toBeVisible();
  await expect(dialog.getByTestId('tier-real')).toContainText('真實系統');
  await expect(dialog.getByTestId('tier-real').getByRole('button', { name: /真實事故重現/ })).toBeVisible();
  await expect(dialog.getByTestId('tier-real').getByRole('button', { name: /真實服務架構/ })).toBeVisible();
  // "All" shows the starter tier first, the real systems after it
  await dialog.getByRole('button', { name: /^全部/ }).click();
  const sections = dialog.locator('[data-testid^="tier-section-"]');
  await expect(sections).toHaveCount(2);
  await expect(sections.nth(0)).toHaveAttribute('data-testid', 'tier-section-start');
  await expect(sections.nth(1).getByTestId('example-saas-slack')).toBeVisible();
  await expect(sections.nth(0).getByTestId('example-saas-slack')).toHaveCount(0);
  await dialog.getByRole('navigation').getByRole('button', { name: /^快取/ }).click();
  await expect(dialog.locator('[data-testid^="example-"]')).toHaveCount(5);
  await page.screenshot({ path: join(SHOTS, 'example-browser.png') });
  // the search looks in every category
  await dialog.getByRole('textbox', { name: '搜尋範例' }).fill('重試');
  await expect(dialog.getByTestId('example-retry-storm')).toBeVisible();
  await expect(dialog.getByTestId('example-retry-storm')).toContainText('題目＋挑戰');
  // the lesson card does not give the answer away
  await expect(dialog.getByTestId('example-retry-storm')).not.toContainText('再也沒有恢復');
  await dialog.getByTestId('example-retry-storm').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '設計名稱' })).toHaveValue('重試風暴（metastable failure）');
  // Escape closes it
  await page.getByTestId('open-examples').click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('⌘Z undoes design edits and ⇧⌘Z redoes them; quick edits of one field are one step', async ({ page }) => {
  type St = { nodes: { id: string; data: { node: { params?: Record<string, unknown> } } }[]; edges: unknown[]; updateNode(id: string, p: { params: Record<string, unknown> }): void };
  const state = () => page.evaluate(() => {
    const s = (window as unknown as { __loadsketch: { getState(): St } }).__loadsketch.getState();
    return { nodes: s.nodes.length, edges: s.edges.length, instances: s.nodes.find((n) => n.id === 'api')?.data.node.params?.instances };
  });
  await page.goto('/app/?example=three-tier');
  await expect(page.locator('[data-node]')).toHaveCount(5);
  const start = await state();
  await expect(page.getByTestId('undo')).toBeDisabled();

  // delete a node with its edges: one step
  await page.locator('[data-node="cache"]').click();
  await page.keyboard.press('Backspace');
  await expect(page.locator('[data-node]')).toHaveCount(4);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('[data-node]')).toHaveCount(5);
  expect(await state()).toEqual(start);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(page.locator('[data-node]')).toHaveCount(4);
  await page.getByTestId('undo').click();
  await expect(page.locator('[data-node]')).toHaveCount(5);
  await expect(page.getByTestId('redo')).toBeEnabled();

  // typing 4, 5, 6 into one field quickly: one undo goes back to the start
  await page.evaluate(() => {
    const s = (window as unknown as { __loadsketch: { getState(): St } }).__loadsketch.getState();
    for (const v of [4, 5, 6]) s.updateNode('api', { params: { instances: v } });
  });
  expect((await state()).instances).toBe(6);
  await expect(page.getByTestId('redo')).toBeDisabled(); // a new edit clears the redo steps
  await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ControlOrMeta+z');
  expect(await state()).toEqual(start);

  // in a text field, ⌘Z belongs to the field
  await page.evaluate(() => {
    const s = (window as unknown as { __loadsketch: { getState(): St } }).__loadsketch.getState();
    s.updateNode('api', { params: { instances: 7 } });
  });
  await page.getByLabel(/設計名稱|Design name/).focus();
  await page.keyboard.press('ControlOrMeta+z');
  expect((await state()).instances).toBe(7);
});

test('design warnings show on the canvas: a count, the list, and a mark on the connection', async ({ page }) => {
  await page.goto('/app/?example=retry-storm');
  await expect(page.locator('[data-node]').first()).toBeVisible();
  await expect(page.getByTestId('checks')).toHaveCount(0);
  await page.evaluate(() => {
    type E = { source: string; target: string };
    const s = (window as unknown as { __loadsketch: { getState(): { nodes: { id: string; data: { node: { kind: string } } }[]; edges: E[]; remove(x: { type: 'node'; id: string }): void; onConnect(c: E): void } } }).__loadsketch.getState();
    const lb = s.nodes.find((n) => n.data.node.kind === 'load_balancer')!.id;
    const into = s.edges.find((e) => e.target === lb)!;
    const out = s.edges.find((e) => e.source === lb)!;
    s.remove({ type: 'node', id: lb });
    s.onConnect({ source: into.source, target: out.target });
  });
  await expect(page.getByTestId('checks')).toHaveText('設計檢查：1 個警告');
  await expect(page.locator('[data-testid^="edge-warn-"]')).toHaveCount(1);
  await page.getByTestId('checks').click();
  await expect(page.getByTestId('checks-list')).toContainText('「使用者」直接連過去');
  await page.getByTestId('checks-list').getByRole('button').first().click();
  await expect(page.getByTestId('tab-design')).toHaveAttribute('aria-selected', 'true');
});

test('a lesson run is judged with the right panel hidden', async ({ page }) => {
  await page.goto('/app/?example=retry-storm');
  await expect(page.locator('[data-node="api"]')).toBeVisible();
  await page.evaluate(() => {
    const s = (window as unknown as { __loadsketch: { getState(): { updateNode(id: string, p: { params: Record<string, unknown> }): void; panels: { right: boolean }; togglePanel(p: 'right'): void; run(): void } } }).__loadsketch.getState();
    s.updateNode('api', { params: { queueLimit: 20 } });
    if (s.panels.right) s.togglePanel('right');
    s.run();
  });
  await expect(page.getByTestId('tab-learn')).toHaveCount(0);
  await page.getByRole('button', { name: '跳到結尾' }).click();
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('loadsketch-passed') ?? '[]')), { timeout: 30_000 })
    .toEqual(['retry-storm/recover', 'retry-storm/fail-less']);
});

test('undo review fixes', async ({ page }) => {
  type St = { dirty: boolean; past: unknown[]; future: unknown[]; nodes: { id: string; selected?: boolean }[]; edges: { id: string; selected?: boolean }[]; selected: { id: string } | null; updateNode(id: string, p: { params: Record<string, unknown> }): void; undo(): void; setLang(l: string): void };
  const st = () => page.evaluate(() => {
    const s = (window as unknown as { __loadsketch: { getState(): St } }).__loadsketch.getState();
    return { dirty: s.dirty, past: s.past.length, future: s.future.length, sel: s.selected?.id ?? null, flagged: [...s.nodes, ...s.edges].filter((x) => x.selected).map((x) => x.id) };
  });
  await page.goto('/app/?example=three-tier');
  await expect(page.locator('[data-node]')).toHaveCount(5);
  // undoing back to the loaded design is clean again
  await page.evaluate(() => (window as unknown as { __loadsketch: { getState(): St } }).__loadsketch.getState().updateNode('api', { params: { instances: 9 } }));
  expect((await st()).dirty).toBe(true);
  await page.evaluate(() => (window as unknown as { __loadsketch: { getState(): St } }).__loadsketch.getState().undo());
  expect((await st()).dirty).toBe(false);
  await expect(page.getByText('未儲存')).toHaveCount(0);
  // a language change drops the history (it holds text in the old language)
  await page.evaluate(() => (window as unknown as { __loadsketch: { getState(): St } }).__loadsketch.getState().updateNode('api', { params: { instances: 8 } }));
  expect((await st()).past).toBe(1);
  await page.getByTestId('more-menu').click();
  await page.getByTestId('lang').click();
  expect((await st()).past).toBe(0);
  await expect(page.getByTestId('undo')).toBeDisabled();
});

test('undo after a save: only the saved canvas is clean', async ({ page }) => {
  type St = { dirty: boolean; updateNode(id: string, p: { params: Record<string, unknown> }): void; undo(): void; redo(): void; markSaved(): void; rename(n: string): void };
  const act = (f: string, ...args: unknown[]) => page.evaluate(([f, args]) => {
    const s = (window as unknown as { __loadsketch: { getState(): St } }).__loadsketch.getState() as unknown as Record<string, (...a: unknown[]) => void>;
    s[f as string](...(args as unknown[]));
  }, [f, args] as const);
  const dirty = () => page.evaluate(() => (window as unknown as { __loadsketch: { getState(): St } }).__loadsketch.getState().dirty);
  await page.goto('/app/?example=three-tier');
  await expect(page.locator('[data-node]')).toHaveCount(5);
  // edit, save, undo: the canvas is the loaded one, not the saved one
  await act('updateNode', 'api', { params: { instances: 9 } });
  await act('markSaved');
  expect(await dirty()).toBe(false);
  await act('undo');
  expect(await dirty()).toBe(true);
  await expect(page.getByText('未儲存')).toBeVisible();
  await act('redo');
  expect(await dirty()).toBe(false);
  // an edit of the same field right after the save is its own step: undo comes back to the saved canvas
  await act('updateNode', 'api', { params: { instances: 7 } });
  expect(await dirty()).toBe(true);
  await act('undo');
  expect(await dirty()).toBe(false);
  // a rename is not in the history: undo does not make the design clean
  await act('rename', 'x');
  await act('updateNode', 'api', { params: { instances: 6 } });
  await act('undo');
  expect(await dirty()).toBe(true);
});

test('a design check message selects its part on the canvas too; an edge error is marked red', async ({ page }) => {
  await page.goto('/app/?example=three-tier');
  await expect(page.locator('[data-node]')).toHaveCount(5);
  // a queue in front of a database: a blocking error on that connection
  await page.evaluate(() => {
    const s = (window as unknown as { __loadsketch: { getState(): { addNode(k: string, x: number, y: number): void; nodes: { id: string; data: { node: { kind: string } } }[]; onConnect(c: { source: string; target: string }): void } } }).__loadsketch.getState();
    s.addNode('queue', 0, 600);
    const q = (window as unknown as { __loadsketch: { getState(): { nodes: { id: string; data: { node: { kind: string } } }[] } } }).__loadsketch.getState().nodes.find((n) => n.data.node.kind === 'queue')!.id;
    s.onConnect({ source: 'users', target: q });
    s.onConnect({ source: q, target: 'db' });
  });
  const mark = page.locator('[data-testid^="edge-warn-"]').filter({ has: page.locator('svg.lucide-circle-x') });
  await expect(mark).toHaveCount(1);
  // select something else first, then pick the error from the list
  await page.locator('[data-node="api"]').click();
  await page.getByTestId('checks').click();
  await page.getByTestId('checks-list').getByRole('button').filter({ hasText: 'Queue 後面只能接' }).click();
  const flagged = await page.evaluate(() => {
    const s = (window as unknown as { __loadsketch: { getState(): { nodes: { id: string; selected?: boolean }[]; edges: { id: string; selected?: boolean }[] } } }).__loadsketch.getState();
    return [...s.nodes, ...s.edges].filter((x) => x.selected).map((x) => x.id);
  });
  expect(flagged).toHaveLength(1);
  expect(flagged[0]).toMatch(/->db$/);
});

test('SLA: availability against the SLO, the budget, and a changed target', async ({ page }) => {
  await page.goto('/app/?example=three-tier&scenario=steady');
  await page.getByRole('button', { name: '執行' }).click();
  await page.getByRole('button', { name: '跳到結尾' }).click();
  const card = page.getByTestId('sla-summary');
  await expect(card).toContainText('可用性');
  await expect(card).toContainText('達到 99.9%');
  await page.getByTestId('tab-learn').click();
  const sec = page.getByTestId('sla');
  await expect(sec).toContainText('錯誤預算用掉');
  await expect(sec).toContainText('SLO');
  // a tighter p99 target than the design can make: seconds fail it
  await page.getByRole('textbox', { name: 'p99 目標' }).fill('1');
  await expect(page.getByTestId('sla-windows')).toContainText('太慢');
  await expect(page.getByTestId('sla-windows')).toContainText(/^0 \/ \d+ 秒達到目標/);
  // the verdict counts the latency objective too
  await expect(page.getByTestId('sla-latency')).toContainText('延遲目標未達');
  await expect(page.getByTestId('sla-summary')).toContainText('p99 未達 1 ms');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('loadsketch-slo') ?? 'null'))).toEqual({ target: 0.999, p99Ms: 1 });
  await page.screenshot({ path: join(SHOTS, 'sla.png') });
  // English: no Chinese in the SLA texts
  await page.getByTestId('more-menu').click();
  await page.getByTestId('lang').click();
  await page.getByRole('button', { name: /^(Run|Run again)$/ }).click();
  await page.getByRole('button', { name: 'Skip to end' }).click();
  await expect(page.getByTestId('sla-summary')).toContainText('Availability');
  expect(await page.getByTestId('sla-summary').textContent()).not.toMatch(/[一-鿿]/);
});

test('a node gets a region: a tag on the card, saved in the design, cleared again', async ({ page }) => {
  await page.goto('/app/?example=three-tier');
  await expect(page.locator('[data-node]')).toHaveCount(5);
  await page.locator('[data-node="api"]').click();
  // characters outside the id rule become "-"
  await page.getByTestId('region').fill('us east');
  await expect(page.getByTestId('region')).toHaveValue('us-east');
  await expect(page.locator('[data-node="api"]').getByTestId('node-region')).toHaveText('us-east');
  const text = await page.evaluate(() => (window as unknown as { __loadsketch: { getState: () => { exportText: () => string } } }).__loadsketch.getState().exportText());
  expect(JSON.parse(text).nodes.find((n: { id: string }) => n.id === 'api').region).toBe('us-east');
  await page.getByTestId('region').fill('');
  await expect(page.locator('[data-node="api"]').getByTestId('node-region')).toHaveCount(0);
  // a database also has the region of its replicas; other kinds do not
  await expect(page.getByTestId('replica-region')).toHaveCount(0);
  await page.locator('[data-node="db"]').click();
  await page.getByTestId('replica-region').fill('us-west');
  const db = await page.evaluate(() => (window as unknown as { __loadsketch: { getState: () => { exportText: () => string } } }).__loadsketch.getState().exportText());
  expect(JSON.parse(db).nodes.find((n: { id: string }) => n.id === 'db').replicaRegion).toBe('us-west');
});

test('hovering a chart shows the values at that second; a long bottleneck text is not cut off', async ({ page }) => {
  await page.goto('/app/?example=three-tier&scenario=spike&speed=1&autorun=1&theme=dark&select=api');
  await page.getByRole('button', { name: '跳到結尾' }).click();
  await expect(page.getByTestId('bottleneck')).toContainText('API 伺服器', { timeout: 30_000 });
  const over = page.getByTestId('chart-traffic').locator('.u-over');
  const box = (await over.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  const tip = page.getByTestId('chart-traffic-tip');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('成功');
  await expect(tip).toContainText(/\d+s/);
  await page.screenshot({ path: join(SHOTS, 'chart-tooltip.png') });
  // the tooltip stays inside the chart card
  const card = (await page.getByTestId('chart-traffic').boundingBox())!;
  const tb = (await tip.boundingBox())!;
  expect(tb.x).toBeGreaterThanOrEqual(card.x);
  expect(tb.x + tb.width).toBeLessThanOrEqual(card.x + card.width + 1);
  expect(tb.y).toBeGreaterThanOrEqual(card.y);
  expect(tb.y + tb.height).toBeLessThanOrEqual(card.y + card.height + 1);
  await page.mouse.move(5, 5);
  await expect(tip).toBeHidden();
  // a resize under a still pointer hides the tooltip instead of leaving it at the old place
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await expect(tip).toBeVisible();
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(tip).toBeHidden();
  // the side column scrolls: the whole bottleneck text can be seen
  const side = page.getByTestId('metrics-side');
  await page.getByTestId('bottleneck').scrollIntoViewIfNeeded();
  const s = (await side.boundingBox())!;
  const b = (await page.getByTestId('bottleneck').boundingBox())!;
  expect(b.y + b.height).toBeLessThanOrEqual(s.y + s.height + 1);
});

test('the charts share one cursor: pointing at a time in one shows the line and the values in the others', async ({ page }) => {
  await page.goto('/app/?example=three-tier&scenario=spike&speed=1&autorun=1');
  await page.getByRole('button', { name: '跳到結尾' }).click();
  await expect(page.getByTestId('bottleneck')).toContainText('API 伺服器', { timeout: 30_000 });
  const box = (await page.getByTestId('chart-traffic').locator('.u-over').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  const at = (await page.getByTestId('chart-traffic-tip').locator('.sd-tip-t').textContent())!;
  expect(at).toMatch(/^\d+s$/);
  for (const id of ['chart-latency', 'chart-util']) {
    // the same time, and the vertical line at that time
    await expect(page.getByTestId(`${id}-tip`).locator('.sd-tip-t')).toHaveText(at);
    const over = (await page.getByTestId(id).locator('.u-over').boundingBox())!;
    const line = (await page.getByTestId(id).locator('.u-cursor-x').boundingBox())!;
    expect(Math.abs((line.x - over.x) / over.width - 0.4)).toBeLessThan(0.03);
    // no horizontal line there: it has another y axis
    await expect(page.getByTestId(id).locator('.u-cursor-y')).toBeHidden();
  }
  await page.screenshot({ path: join(SHOTS, 'chart-shared-cursor.png') });
  await page.mouse.move(5, 5);
  for (const id of ['chart-traffic', 'chart-latency', 'chart-util']) await expect(page.getByTestId(`${id}-tip`)).toBeHidden();
  // the big chart in the dialog stands alone: it does not move the cursors behind it
  await page.getByTestId('chart-util-expand').click();
  await expect(page.getByTestId('chart-util-big')).toBeVisible();
  await page.waitForFunction(() => document.getAnimations().every((a) => !String((a.effect as KeyframeEffect | null)?.pseudoElement ?? '').startsWith('::view-transition')));
  const big = (await page.getByTestId('chart-util-big').locator('.u-over').boundingBox())!;
  await page.mouse.move(big.x + big.width * 0.5, big.y + big.height * 0.5);
  await expect(page.getByTestId('chart-util-big-tip')).toBeVisible();
  await expect(page.getByTestId('chart-traffic-tip')).toBeHidden();
});

test('during a run, a resize keeps the tooltip hidden until the pointer moves', async ({ page }) => {
  await page.goto('/app/?example=three-tier&speed=1&autorun=1');
  await expect(page.getByTestId('chart-traffic').locator('canvas')).toBeVisible();
  await page.waitForTimeout(1500);
  const over = (await page.getByTestId('chart-traffic').locator('.u-over').boundingBox())!;
  await page.mouse.move(over.x + over.width * 0.3, over.y + over.height * 0.5);
  const tip = page.getByTestId('chart-traffic-tip');
  await expect(tip).toBeVisible();
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(tip).toBeHidden();
  // the chart keeps getting new data; the tooltip must not come back by itself
  await page.waitForTimeout(1200);
  await expect(tip).toBeHidden();
});

test('a tooltip with many series stays inside its chart card', async ({ page }) => {
  await page.goto('/app/?example=saas-netflix&speed=1&autorun=1');
  await page.getByRole('button', { name: '跳到結尾' }).click();
  await expect(page.getByTestId('run')).toBeVisible({ timeout: 60_000 });
  const over = page.getByTestId('chart-util').locator('.u-over');
  const box = (await over.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
  const tip = page.getByTestId('chart-util-tip');
  await expect(tip).toContainText('只列最高的');
  const card = (await page.getByTestId('chart-util').boundingBox())!;
  const tb = (await tip.boundingBox())!;
  expect(tb.y).toBeGreaterThanOrEqual(card.y);
  expect(tb.y + tb.height).toBeLessThanOrEqual(card.y + card.height + 1);
});

test('design text in the side panel: steps as a list, sources as short links', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/app/?example=saas-uber&theme=dark');
  const about = page.getByTestId('design-about');
  await expect(about.getByRole('link', { name: 'highscalability.com' })).toHaveAttribute('href', /how-uber-scales/);
  await expect(about).not.toContainText('https://');
  const tryIt = page.getByTestId('design-note').first();
  await expect(tryIt.locator('ol > li')).toHaveCount(4);
  await tryIt.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(SHOTS, 'design-text.png') });
});

test('a chart opens big in a dialog and closes again', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/app/?example=saas-uber&speed=1&autorun=1&theme=dark');
  await page.getByRole('button', { name: '跳到結尾' }).click();
  await expect(page.getByTestId('run')).toBeVisible({ timeout: 60_000 });
  const small = (await page.getByTestId('chart-util').boundingBox())!;
  // the button takes no height: the x-axis labels stay inside each card
  for (const id of ['chart-traffic', 'chart-latency', 'chart-util']) {
    const c = (await page.getByTestId(id).boundingBox())!;
    const ax = (await page.getByTestId(id).locator('.u-axis').first().boundingBox())!;
    expect(ax.y + ax.height, id).toBeLessThanOrEqual(c.y + c.height - 1);
  }
  await page.getByTestId('chart-util-expand').click();
  // only the dialog morphs: no other card is lifted above it during the transition
  const named = await page.evaluate(() => [...document.querySelectorAll('*')].filter((e) => e !== document.documentElement && getComputedStyle(e).viewTransitionName !== 'none').length);
  expect(named).toBeLessThanOrEqual(1);
  const dialog = page.getByRole('dialog', { name: /忙碌程度/ });
  await expect(dialog).toBeVisible();
  const big = page.getByTestId('chart-util-big');
  await expect(big.locator('canvas')).toBeVisible();
  const b = (await big.boundingBox())!;
  expect(b.width).toBeGreaterThan(small.width * 2);
  expect(b.height).toBeGreaterThan(small.height * 1.5);
  // the big chart has the hover values too
  const over = (await big.locator('.u-over').boundingBox())!;
  // the morph is over before the pointer reaches the page again
  await page.waitForFunction(() => document.getAnimations().every((a) => !String((a.effect as KeyframeEffect | null)?.pseudoElement ?? '').startsWith('::view-transition')));
  await page.mouse.move(over.x + over.width * 0.6, over.y + over.height * 0.5);
  await expect(page.getByTestId('chart-util-big-tip')).toBeVisible();
  // every series name fits inside the card: the legend wraps
  const lg = (await big.locator('.u-legend').boundingBox())!;
  expect(lg.x + lg.width).toBeLessThanOrEqual(b.x + b.width + 1);
  await page.screenshot({ path: join(SHOTS, 'chart-dialog.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('chart-util-expand')).toBeFocused();
  // the close button and a click on the backdrop close it as well
  await page.getByTestId('chart-traffic-expand').click();
  await page.getByRole('dialog').getByRole('button', { name: '關閉' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByTestId('chart-latency-expand').click();
  // during the morph a click lands on the transition, not on the backdrop
  await page.waitForFunction(() => document.getAnimations().every((a) => !String((a.effect as KeyframeEffect | null)?.pseudoElement ?? '').startsWith('::view-transition')));
  await page.mouse.click(8, 8);
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('in a short window the chart dialog fits and keeps the focus', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 500 });
  await page.goto('/app/?example=saas-uber&speed=1&autorun=1&theme=dark');
  await page.getByRole('button', { name: '跳到結尾' }).click();
  await expect(page.getByTestId('run')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('chart-util-expand').click();
  const dialog = page.getByRole('dialog', { name: /忙碌程度/ });
  await expect(dialog).toBeVisible();
  const close = dialog.getByRole('button', { name: '關閉' });
  await expect(close).toBeFocused();
  // the close button is inside the window
  const c = (await close.boundingBox())!;
  expect(c.y).toBeGreaterThanOrEqual(0);
  expect(c.y + c.height).toBeLessThanOrEqual(500);
  // focus stays in the dialog, both ways
  for (const key of ['Shift+Tab', 'Shift+Tab', 'Tab', 'Tab', 'Tab']) {
    await page.keyboard.press(key);
    await expect(close).toBeFocused();
  }
  // the app's shortcuts do nothing behind the dialog: ⌘J would hide the charts and close it
  await page.keyboard.press('ControlOrMeta+j');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('chart-util-expand')).toBeAttached();
  // …and the browser does not take the key either (Ctrl+J opens Downloads on Windows/Linux)
  const prevented = await page.evaluate(() => {
    const mac = /Mac/.test(navigator.platform);
    const e = new KeyboardEvent('keydown', { code: 'KeyJ', key: 'j', ctrlKey: !mac, metaKey: mac, bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(e);
    return e.defaultPrevented;
  });
  expect(prevented).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('chart-util-expand')).toBeFocused();
});

test('the scenario menu offers the ones made for this design, then general ones', async ({ page }) => {
  await page.goto('/app/?example=three-tier');
  const sc = page.getByRole('button', { name: '情境' });
  await sc.click();
  const menu = page.getByRole('listbox', { name: '情境' });
  await expect(menu.locator('.sd-menu-group')).toHaveText(['這個設計', '通用']);
  await expect(menu.getByRole('option', { name: /突波/ })).toBeVisible();
  await expect(menu.getByRole('option', { name: /平穩流量/ })).toBeVisible();
  // other examples' scenarios aim at parts three-tier does not have
  await expect(menu.getByRole('option', { name: /memcache/ })).toHaveCount(0);
  await expect(menu.getByRole('option', { name: /付款服務/ })).toHaveCount(0);
  // a service example's own scenario stays with it, even when it names no part
  await expect(menu.getByRole('option', { name: /開賣/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.goto('/app/?example=cache-cold-restart');
  await page.getByRole('button', { name: '情境' }).click();
  await expect(page.getByRole('listbox', { name: '情境' }).getByRole('option').first()).toContainText('memcache');
  await page.screenshot({ path: join(SHOTS, 'scenario-menu.png') });
});

test('a design with APIs: edges show their APIs, and the results are per API', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/app/?example=saas-instagram&speed=1&autorun=1');
  // one Django; each of its edges says which APIs take it
  await expect(page.getByTestId('edge-apis-label').filter({ hasText: /^search$/ })).toHaveCount(1);
  await expect(page.getByTestId('api-mix')).toContainText('4');
  const editor = page.getByTestId('api-editor');
  await expect(editor.getByRole('textbox', { name: 'API 名稱' })).toHaveCount(4);
  await page.getByRole('button', { name: '跳到結尾' }).click();
  await expect(page.getByTestId('run')).toBeVisible({ timeout: 60_000 });
  const rows = page.getByTestId('api-results').locator('tbody tr');
  await expect(rows).toHaveCount(4);
  await expect(rows.filter({ hasText: 'photo' })).toContainText('0%');
  await page.getByTestId('api-results').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(SHOTS, 'api-results.png') });
  // renaming an API renames it on its edges too
  const name = editor.getByRole('textbox', { name: 'API 名稱' }).nth(1);
  await name.fill('geo');
  await name.press('Enter');
  await expect(page.getByTestId('edge-apis-label').filter({ hasText: /^geo$/ })).toHaveCount(1);
  await expect(page.getByTestId('edge-apis-label').filter({ hasText: /^search$/ })).toHaveCount(0);
  // a name the design file would refuse is not taken
  await name.fill('geo/v2');
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await name.press('Enter');
  await expect(name).toHaveValue('geo');
  // a cache-aside edge shows its APIs next to its order
  // django → memcached (cache-aside) and django → redis both carry only feed
  await expect(page.getByTestId('edge-apis-label').filter({ hasText: /^feed$/ })).toHaveCount(2);
});

test('settings panel: groups, switches for "0 means off", percents, range errors and short help', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/app/?example=three-tier');
  await expect(page.locator('[data-node]')).toHaveCount(5);
  type Sel = { getState(): { select(s: { type: string; id: string }): void; edges: { id: string; data: { edge: Record<string, unknown> } }[]; nodes: { id: string; data: { node: { params?: Record<string, unknown> } } }[] } };
  const store = (fn: (s: ReturnType<Sel['getState']>) => unknown) => page.evaluate(`(${fn.toString()})(window.__loadsketch.getState())`);
  await store((s) => s.select({ type: 'edge', id: s.edges.find((e) => e.id.startsWith('api->cache'))!.id }));
  const panel = page.getByTestId('group-network').locator('..');
  // retries and protection are folded and say they are off
  for (const k of ['retry', 'protect']) {
    await expect(page.getByTestId(`group-${k}`).getByRole('button').first()).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId(`group-${k}`)).toContainText('關');
  }
  // labels carry no unit: the unit is in the field
  await expect(panel).not.toContainText('（ms）');
  // the timeout is a switch; on, it starts at 1000 ms
  const timeout = page.getByTestId('param-timeoutMs');
  await expect(timeout.getByRole('textbox')).toHaveCount(0);
  await timeout.getByRole('switch', { name: '逾時' }).click();
  const tbox = timeout.getByRole('textbox');
  await expect(tbox).toHaveValue('1000');
  await expect(timeout).toContainText('ms');
  // a value out of range is not taken: the field says the range and keeps what was typed
  await tbox.fill('0');
  await expect(tbox).toHaveAttribute('aria-invalid', 'true');
  await expect(timeout.getByTestId('range-error')).toContainText('600000');
  await page.getByTestId('param-latencyMs').getByRole('textbox').click();
  await expect(tbox).toHaveValue('0');
  expect(await store((s) => s.edges.find((e) => e.id.startsWith('api->cache'))!.data.edge.timeoutMs)).toBe(1000);
  await tbox.press('Escape');
  await expect(tbox).toHaveValue('1000');
  // retries: backoff and budget show only when retries are on; the budget is a percent
  await page.getByTestId('group-retry').getByRole('button').first().click();
  await expect(page.getByTestId('param-backoffMs')).toHaveCount(0);
  await page.getByTestId('param-retries').getByRole('textbox').fill('2');
  await expect(page.getByTestId('param-backoffMs')).toBeVisible();
  await page.getByTestId('param-retryBudget').getByRole('switch').click();
  await expect(page.getByTestId('param-retryBudget').getByRole('textbox')).toHaveValue('10');
  await expect(page.getByTestId('param-retryBudget')).toContainText('%');
  // help: the first sentence, the rest behind "more"
  const help = page.getByTestId('param-retries');
  await expect(help).not.toContainText('429');
  await help.getByRole('button', { name: '更多' }).click();
  await expect(help).toContainText('429');
  await page.screenshot({ path: join(SHOTS, 'settings-edge.png') });
  // a component: an error rate of 0.1% can be typed
  await page.locator('[data-node="api"]').click();
  await page.getByTestId('group-fault').getByRole('button').first().click();
  await page.getByRole('textbox', { name: '錯誤率（百分比）' }).fill('0.1');
  expect(await store((s) => s.nodes.find((n) => n.id === 'api')!.data.node.params?.errorRate)).toBe(0.001);
  await expect(page.getByTestId('group-scale')).toContainText('關');
  await page.screenshot({ path: join(SHOTS, 'settings-node.png') });
});

test('a 30-minute scenario plays at 300× and its charts count in minutes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/app/?example=autoscale&speed=300&autorun=1');
  await expect(page.getByTestId('clock')).toContainText('/ 30:00');
  await expect(page.getByTestId('clock')).toContainText('30:00 / 30:00', { timeout: 60_000 });
  // the axis labels are drawn on a canvas: the minute labels are checked in tests/timescale.test.ts
  await page.screenshot({ path: join(SHOTS, 'long-run.png') });
});

test('scenario editor: traffic, user patience, key heat, and events added, changed and deleted; charts mark event times', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/app/?example=three-tier&scenario=steady');
  await expect(page.locator('[data-node]')).toHaveCount(5);
  type St = { scenario: { name?: string; durationS?: number; traffic: { rps: number; clientTimeoutMs?: number }; keys?: { zipf?: number }; events?: Record<string, unknown>[] } };
  const sc = () => page.evaluate(() => (window as unknown as { __loadsketch: { getState(): St } }).__loadsketch.getState().scenario) as Promise<St['scenario']>;
  await page.getByTestId('tab-scenario').click();
  const ed = page.getByTestId('scenario-editor');
  await expect(ed).toBeVisible();
  // traffic, how long users wait, key heat
  await ed.getByRole('textbox', { name: '每秒請求數' }).fill('800');
  await ed.getByRole('textbox', { name: '使用者放棄時間' }).fill('1500');
  await ed.getByRole('textbox', { name: '熱門程度（Zipf）' }).fill('1.2');
  await ed.getByRole('textbox', { name: '總時長' }).fill('20');
  await expect.poll(async () => (await sc()).traffic.rps).toBe(800);
  const s1 = await sc();
  expect(s1.traffic.clientTimeoutMs).toBe(1500);
  expect(s1.keys?.zipf).toBe(1.2);
  expect(s1.name).toBe('自訂');
  // read-your-writes traffic: the follow-up delay shows once follow-up reads are on
  await expect(ed.getByRole('textbox', { name: '寫完多久後讀' })).toHaveCount(0);
  await ed.getByRole('textbox', { name: '寫後讀' }).fill('20');
  await expect(ed.getByRole('textbox', { name: '寫完多久後讀' })).toHaveValue('100');
  await ed.getByRole('textbox', { name: '寫完多久後讀' }).fill('250');
  await expect.poll(async () => (await sc()).traffic).toMatchObject({ followReads: 0.2, followAfterMs: 250 });
  // the run bar shows the same traffic
  await expect(page.getByRole('toolbar', { name: '執行' }).getByRole('textbox', { name: '每秒請求數' })).toHaveValue('800');
  // add an outage, aim it at the API servers, then change it into a slowdown
  await expect(ed.getByTestId('event-row')).toHaveCount(0);
  await ed.getByTestId('add-event').click();
  await page.getByRole('option', { name: /^故障/ }).click();
  const row = ed.getByTestId('event-row');
  await expect(row).toHaveCount(1);
  await row.getByTestId('event-node').click();
  await page.getByRole('option', { name: 'API 伺服器' }).click();
  await row.getByRole('textbox', { name: '開始' }).fill('4');
  await expect.poll(async () => (await sc()).events?.[0]).toMatchObject({ type: 'down', atS: 4, node: 'api' });
  // one instance only
  await row.getByTestId('event-instance').click();
  await page.getByRole('option', { name: '第 2 台' }).click();
  await expect.poll(async () => (await sc()).events?.[0]?.instance).toBe(1);
  await row.getByTestId('event-type').click();
  await page.getByRole('option', { name: /^變慢/ }).click();
  await expect(row.getByRole('textbox', { name: '倍數' })).toHaveValue('5');
  await expect.poll(async () => (await sc()).events?.[0]).toMatchObject({ type: 'slow', atS: 4, node: 'api', multiplier: 5 });
  // "until the end": the switch drops the length
  await row.getByRole('switch', { name: '有結束時間' }).click();
  await expect(row).toContainText('直到結束');
  await expect.poll(async () => (await sc()).events?.[0]?.forS).toBeUndefined();
  // delete it; add a spike instead
  await row.getByTestId('event-delete').click();
  await expect(ed.getByTestId('event-row')).toHaveCount(0);
  await ed.getByTestId('add-event').click();
  await page.getByRole('option', { name: /^突波/ }).click();
  await expect.poll(async () => (await sc()).events).toEqual([{ type: 'spike', atS: 5, forS: 5, multiplier: 3 }]);
  // run it: the charts mark the spike at 5 s
  await page.getByTestId('run').click();
  await page.getByRole('button', { name: '跳到結尾' }).click();
  await expect(page.getByTestId('run')).toContainText('再跑一次', { timeout: 30_000 });
  const mark = page.getByTestId('chart-traffic').locator('[data-testid="event-mark"]');
  await expect(mark).toHaveCount(1);
  await expect(mark).toHaveAttribute('data-t', '5');
  await expect(mark).toHaveAttribute('aria-label', /突波/);
  await page.screenshot({ path: join(SHOTS, 'scenario-editor.png') });
  expect(errors).toEqual([]);
});

test('traffic shift: the region cutover example, an edge picked in the editor, a gradual move, and a run', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/app/?example=region-cutover');
  await expect(page.locator('[data-node]')).toHaveCount(7);
  type St = { scenario: { events?: Record<string, unknown>[] }; result: { nodes: Record<string, { arrivals: number; replicationApplied?: number }> } | null };
  const st = () => page.evaluate(() => (window as unknown as { __loadsketch: { getState(): St } }).__loadsketch.getState()) as Promise<St>;
  await page.getByTestId('tab-scenario').click();
  const ed = page.getByTestId('scenario-editor');
  const rows = ed.getByTestId('event-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).getByTestId('event-edge')).toContainText('DNS → API（東區）');
  await expect(rows.nth(1).getByTestId('event-edge')).toContainText('DNS → API（西區）');
  await expect(rows.nth(0)).toContainText('立刻');
  // make the move gradual: 10 s
  await rows.nth(1).getByRole('switch', { name: '移轉時間' }).click();
  await rows.nth(1).getByRole('textbox', { name: '移轉時間' }).fill('10');
  await expect.poll(async () => (await st()).scenario.events?.[1]).toMatchObject({ type: 'shift', atS: 30, forS: 10, from: 'dns', to: 'api_w', weight: 1 });
  // a new shift aims at an edge out of a router; the edge can be changed
  await ed.getByTestId('add-event').click();
  await page.getByRole('option', { name: /^流量移轉/ }).click();
  await expect(rows).toHaveCount(3);
  await rows.nth(2).getByTestId('event-edge').click();
  await page.getByRole('option', { name: 'DNS → API（西區）' }).click();
  await expect.poll(async () => (await st()).scenario.events?.[2]).toMatchObject({ type: 'shift', from: 'dns', to: 'api_w', weight: 0 });
  await rows.nth(2).getByTestId('event-delete').click();
  // run: both regions served, and the caches copied each other's changes
  await page.getByTestId('run').click();
  await page.getByRole('button', { name: '跳到結尾' }).click();
  await expect(page.getByTestId('run')).toContainText('再跑一次', { timeout: 30_000 });
  const r = (await st()).result!;
  expect(r.nodes.api_e.arrivals).toBeGreaterThan(0);
  expect(r.nodes.api_w.arrivals).toBeGreaterThan(0);
  expect(r.nodes.cache_w.replicationApplied).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('settings panel: an integer field does not take a fraction', async ({ page }) => {
  await page.goto('/app/?example=three-tier&select=api');
  await expect(page.locator('[data-node]')).toHaveCount(5);
  const inst = page.getByTestId('param-instances').getByRole('textbox');
  const before = await inst.inputValue();
  await inst.fill('2.4');
  await expect(inst).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('param-instances').getByTestId('range-error')).toContainText('整數');
  const stored = await page.evaluate(() => (window as unknown as { __loadsketch: { getState(): { nodes: { id: string; data: { node: { params?: Record<string, unknown> } } }[] } } }).__loadsketch.getState().nodes.find((n) => n.id === 'api')!.data.node.params?.instances);
  expect(String(stored)).toBe(before);
  await inst.fill('5');
  await expect(inst).toHaveAttribute('aria-invalid', 'false');
});

test('guess log: guesses are kept with what the run measured, survive a reload, and go out and back as JSON', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/app/?example=retry-storm');
  await page.evaluate(() => localStorage.removeItem('loadsketch-guess-log'));
  await page.reload();
  await expect(page.getByTestId('quiz')).toBeVisible();
  // the guess log is in the practice dialog
  const log = page.getByTestId('guess-log');
  const openLog = () => page.getByTestId('open-practice').click();
  const closeLog = async () => {
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('practice')).toHaveCount(0);
  };
  await openLog();
  await expect(log).toContainText('還沒有紀錄');
  await closeLog();
  await page.getByTestId('guess-recover-fast').click();
  await page.getByTestId('guess-amp-x3').click();
  await page.getByTestId('run').click();
  await page.getByRole('button', { name: '跳到結尾' }).click();
  await expect(page.getByTestId('answer-amp')).toBeVisible({ timeout: 30_000 });
  await openLog();
  await expect(log.getByTestId('guess-summary')).toContainText('猜了 2 次，猜對 0 次');
  await expect(log.getByTestId('guess-topics')).toContainText('重試放大');
  await closeLog();
  // a second run of the same guesses is not logged again
  await page.getByTestId('run').click();
  await page.getByRole('button', { name: '跳到結尾' }).click();
  await expect(page.getByTestId('run')).toContainText('再跑一次', { timeout: 30_000 });
  await openLog();
  await expect(log.getByTestId('guess-summary')).toContainText('猜了 2 次');
  // every guess, with what was measured and how far off it was
  await log.getByRole('button', { name: '看每次的紀錄' }).click();
  await expect(log.getByTestId('guess-entry')).toHaveCount(2);
  await expect(log.getByTestId('guess-entries')).toContainText('低估 2 格');
  // kept in this browser
  await page.reload();
  await openLog();
  await expect(page.getByTestId('guess-log').getByTestId('guess-summary')).toContainText('猜了 2 次');
  // export, clear, import back
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('guess-export').click()]);
  const path = join(SHOTS, 'guess-log.json');
  await dl.saveAs(path);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  expect(saved.schema).toBe('loadsketch/guess-log@1');
  expect(saved.entries).toHaveLength(2);
  await page.getByTestId('guess-clear').click();
  await page.getByTestId('guess-clear-confirm').click();
  await expect(page.getByTestId('guess-log')).toContainText('還沒有紀錄');
  await page.getByTestId('guess-file').setInputFiles(path);
  await expect(page.getByTestId('guess-log').getByRole('status')).toContainText('匯入 2 筆，新增 2 筆');
  await expect(page.getByTestId('guess-log').getByTestId('guess-summary')).toContainText('猜了 2 次');
  // a file that is not a guess log is refused
  await page.getByTestId('guess-file').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"schema":"x"}') });
  await expect(page.getByTestId('guess-log').getByRole('status')).toContainText('不是先猜紀錄檔');
  await page.getByTestId('guess-log').screenshot({ path: join(SHOTS, 'guess-log.png') });
  expect(errors).toEqual([]);
});

test('fan-out: the edge says how many copies it sends and waits for; the result counts the copies', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/app/?example=scatter-gather');
  await expect(page.getByTestId('edge-fanout')).toHaveText('扇出 16');
  type Sel = { getState(): { select(s: { type: string; id: string }): void; edges: { id: string; data: { edge: Record<string, unknown> } }[] } };
  const store = (fn: (s: ReturnType<Sel['getState']>) => unknown) => page.evaluate(`(${fn.toString()})(window.__loadsketch.getState())`);
  await store((s) => s.select({ type: 'edge', id: s.edges.find((e) => e.id.startsWith('api->index'))!.id }));
  // the group is open because the fan-out is set; the quorum is a switch, off = wait for all
  const group = page.getByTestId('group-fanout');
  await expect(group.getByRole('button').first()).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('param-fanout').getByRole('textbox')).toHaveValue('16');
  const quorum = page.getByTestId('param-quorum');
  await quorum.getByRole('switch').click();
  await quorum.getByRole('textbox').fill('15');
  await quorum.getByRole('textbox').press('Enter');
  await expect(page.getByTestId('edge-fanout')).toHaveText('扇出 16，等 15');
  expect(await store((s) => s.edges.find((e) => e.id.startsWith('api->index'))!.data.edge.quorum)).toBe(15);
  // an edge without a fan-out: the group is folded and the quorum does not show
  await store((s) => s.select({ type: 'edge', id: s.edges.find((e) => e.id.startsWith('lb->api'))!.id }));
  await expect(group.getByRole('button').first()).toHaveAttribute('aria-expanded', 'false');
  await group.getByRole('button').first().click();
  await expect(page.getByTestId('param-fanout')).toBeVisible();
  await expect(quorum).toHaveCount(0);
  await page.getByRole('button', { name: '執行' }).click();
  await page.getByRole('button', { name: '跳到結尾' }).click();
  await expect(page.getByTestId('run')).toBeVisible({ timeout: 60_000 });
  await store((s) => s.select({ type: 'edge', id: s.edges.find((e) => e.id.startsWith('api->index'))!.id }));
  await expect(page.getByText('扇出送出的份數')).toBeVisible();
  await page.screenshot({ path: join(SHOTS, 'fanout-edge.png') });
});

test('on-call: a hidden fault, paid metrics, an answer with a score, then a fix on the canvas', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/app/?example=three-tier&scenario=steady');
  type St = { getState(): { status: string; scenario: { name?: string; events?: unknown[] }; updateNode(id: string, p: { params: Record<string, unknown> }): void; loadExample(n: string): void } };
  const store = (fn: (s: ReturnType<St['getState']>) => unknown) => page.evaluate(`(${fn.toString()})(window.__loadsketch.getState())`);
  // practice opens from the top bar; a started incident closes it and stays on the canvas
  await page.getByTestId('open-practice').click();
  await page.getByTestId('oncall-start-gray-errors').click();
  await expect(page.getByTestId('practice')).toHaveCount(0);
  await expect(page.getByTestId('practice-overlay').getByTestId('oncall-card')).toBeVisible();
  // the canvas shows the system on call, without its name, description or fault
  expect(await store((s) => (s as unknown as { doc: { name: string; description?: string } }).doc.name)).toBe('值班中的系統');
  expect(await store((s) => (s as unknown as { doc: { description?: string } }).doc.description)).toBeUndefined();
  // the scenario has the fault (a canvas run shows the same incident), hidden until the answer
  expect(await store((s) => s.scenario.name)).toBe('值班中的情境');
  expect(((await store((s) => s.scenario.events)) as unknown[]).length).toBeGreaterThan(0);
  await expect(page.locator('[data-node="lb"]')).toBeVisible();
  await page.getByTestId('tab-scenario').click();
  await expect(page.getByTestId('events-hidden')).toBeVisible();
  await page.getByTestId('tab-learn').click();
  await expect(page.getByTestId('oncall-page')).toContainText('三分之一');
  // the system's name can tell the cause: hidden until the answer
  await expect(page.getByTestId('oncall-page')).not.toContainText('系統：');
  await expect(page.getByTestId('oncall-errors')).toBeVisible();
  await expect(page.getByTestId('oncall-p99')).toBeVisible();
  // the incident runs on its own: the canvas did not run (its scenario has the fault, hidden)
  expect(await store((s) => s.status)).toBe('idle');
  // component metrics are closed until opened: the first 2 are free, then −10 each
  await expect(page.getByTestId('oncall-score-rule')).toContainText('前 2 個元件的指標免費；第 3 個起，每打開一個扣 10 分。 已打開 0 個。');
  await expect(page.getByTestId('oncall-metrics-api')).toHaveCount(0);
  await expect(page.getByTestId('oncall-open-api')).toHaveText('打開指標（免費）');
  await page.getByTestId('oncall-open-api').click();
  await expect(page.getByTestId('oncall-metrics-api')).toBeVisible();
  await expect(page.getByTestId('oncall-open-api')).toHaveCount(0);
  await page.getByTestId('oncall-open-cache').click();
  await expect(page.getByTestId('oncall-score-rule')).toContainText('已打開 2 個。');
  await expect(page.getByTestId('oncall-open-lb')).toHaveText('打開指標（−10 分）');
  await page.getByTestId('oncall-open-lb').click();
  await expect(page.getByTestId('oncall-score-rule')).toContainText('已打開 3 個。');
  await expect(page.getByTestId('oncall-answer')).toBeDisabled();
  await page.screenshot({ path: join(SHOTS, 'oncall-watch.png') });
  await page.getByTestId('oncall-node-api').click();
  await page.getByTestId('oncall-fault-gray').click();
  await page.getByTestId('oncall-answer').click();
  // 40 + 30 − 10 (3 components opened, 2 free)
  await expect(page.getByTestId('oncall-score')).toHaveText('得分：60');
  await expect(page.getByTestId('oncall-reveal')).toContainText('打開 3 個元件（前 2 個免費）-10');
  await expect(page.getByTestId('oncall-page')).toContainText('系統：');
  await expect(page.getByTestId('oncall-reveal')).toContainText('outlier detection');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('loadsketch-oncall') ?? '{}'))).toEqual({ 'gray-errors': 60 });
  await page.screenshot({ path: join(SHOTS, 'oncall-reveal.png') });
  // fix it on the canvas: the incident's design and scenario load; a run that meets the goal adds 30
  await page.getByTestId('oncall-fix').click();
  expect(await store((s) => s.scenario.name)).toBe('值班：失敗三分之一');
  await store((s) => s.updateNode('lb', { params: { outlier: 'on' } }));
  await page.getByRole('button', { name: '執行' }).click();
  await page.getByRole('button', { name: '跳到結尾' }).click();
  await expect(page.getByTestId('run')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('tab-learn').click();
  await expect(page.getByTestId('oncall-fixed')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('oncall-score')).toHaveText('得分：90');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('loadsketch-oncall') ?? '{}'))).toEqual({ 'gray-errors': 90 });
  // another design loaded after the fix: the incident ends, and the earned score stays in the list
  await store((s) => s.loadExample('three-tier'));
  await expect(page.getByTestId('oncall-card')).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('loadsketch-oncall') ?? '{}'))).toEqual({ 'gray-errors': 90 });
  await page.getByTestId('open-practice').click();
  await expect(page.getByTestId('oncall-start-gray-errors')).toContainText('最高 90 分');
  expect(errors).toEqual([]);
});

test('constraints: cost of a run, then a problem judged on limits; a passed run scores and is kept', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/app/?example=three-tier&scenario=steady');
  type St = { getState(): { scenario: { name?: string }; doc: { name: string }; updateNode(id: string, p: { params: Record<string, unknown> }): void } };
  const store = (fn: (s: ReturnType<St['getState']>) => unknown) => page.evaluate(`(${fn.toString()})(window.__loadsketch.getState())`);
  const runToEnd = async () => {
    await page.getByRole('button', { name: /^(執行|再跑一次)$/ }).click();
    await page.getByRole('button', { name: '跳到結尾' }).click();
    await expect(page.getByTestId('run')).toBeVisible({ timeout: 60_000 });
  };
  // every finished run shows what it costs
  await runToEnd();
  await page.getByTestId('tab-learn').click();
  await expect(page.getByTestId('cost-month')).toHaveText(/^\$[\d,.]+\/月$/);
  await page.getByTestId('cost').getByText('明細').click();
  await expect(page.getByTestId('cost-items')).toContainText('台 × 每台每小時');
  await expect(page.getByTestId('cost-items')).toContainText('送給使用者的流量');
  // a problem loads its design and scenario; the starting design fails. Its goals show on the canvas
  await page.getByTestId('open-practice').click();
  await page.getByTestId('problem-start-solo-shortener').click();
  await expect(page.getByTestId('practice')).toHaveCount(0);
  await expect(page.getByTestId('practice-overlay').getByTestId('problem-solo-shortener')).toBeVisible();
  await expect(page.getByTestId('check-errors')).not.toHaveAttribute('data-ok');
  expect(await store((s) => s.scenario.name)).toBe('限制：每秒 4000');
  expect(await store((s) => s.doc.name)).toBe('一個人顧的短網址');
  await runToEnd();
  await page.getByTestId('tab-learn').click();
  const box = page.getByTestId('problem-solo-shortener');
  await expect(box.getByTestId('check-errors')).toHaveAttribute('data-ok', 'false');
  await expect(box.getByTestId('check-points')).toHaveAttribute('data-ok', 'false');
  await expect(box.getByTestId('problem-score')).toHaveText('還沒過關');
  // no replica, a bigger primary: every limit is met
  await store((s) => s.updateNode('db', { params: { replicas: 0, connections: 32 } }));
  await runToEnd();
  await page.getByTestId('tab-learn').click();
  for (const c of ['errors', 'p99', 'budget', 'points']) await expect(box.getByTestId(`check-${c}`)).toHaveAttribute('data-ok', 'true');
  await expect(box.getByTestId('problem-score')).toHaveText(/^過關！得分 \d+/);
  const best = (await page.evaluate(() => JSON.parse(localStorage.getItem('loadsketch-constraints') ?? '{}'))) as Record<string, number>;
  expect(best['solo-shortener']).toBeGreaterThanOrEqual(50);
  await box.getByTestId('problem-details-toggle').click();
  await box.getByText('成本和複雜度明細').click();
  await expect(box.getByTestId('problem-points')).toContainText('點');
  await page.screenshot({ path: join(SHOTS, 'constraints.png') });
  await box.getByTestId('problem-quit').click();
  await expect(box).toHaveCount(0);
  await page.getByTestId('open-practice').click();
  await expect(page.getByTestId('problem-start-solo-shortener')).toContainText(`最高 ${best['solo-shortener']} 分`);
  // a language change translates the problem's design too
  await page.getByTestId('problem-start-solo-shortener').click();
  await page.getByTestId('more-menu').click();
  await page.getByTestId('lang').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(await store((s) => s.doc.name)).toBe('A URL shortener run by one person');
  await page.getByTestId('more-menu').click();
  await page.getByTestId('lang').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant');
  expect(await store((s) => s.doc.name)).toBe('一個人顧的短網址');
  // another design loaded: the problem is over
  await page.getByTestId('tab-learn').click();
  await expect(page.getByTestId('problem-solo-shortener')).toBeVisible();
  await page.evaluate(() => (window as unknown as { __loadsketch: { getState(): { loadExample(n: string): void } } }).__loadsketch.getState().loadExample('three-tier'));
  await expect(page.getByTestId('problem-solo-shortener')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('share link: the design and the scenario open from the URL alone', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/app/?example=retry-storm&theme=light');
  await page.getByRole('textbox', { name: '設計名稱' }).fill('分享測試');
  // a scenario change that is not in any example
  await page.evaluate(() => {
    const st = (window as unknown as { __loadsketch: { getState(): { scenario: { traffic: { rps: number } }; setScenario(s: unknown): void } } }).__loadsketch.getState();
    st.setScenario({ ...st.scenario, name: '分享的情境', traffic: { ...st.scenario.traffic, rps: 1234 } });
  });
  const state = () =>
    page.evaluate(() => {
      const st = (window as unknown as { __loadsketch: { getState(): { design(): unknown; scenario: unknown } } }).__loadsketch.getState();
      return JSON.stringify({ design: st.design(), scenario: st.scenario });
    });
  const before = await state();
  await page.getByTestId('share').click();
  await expect(page.getByTestId('share')).toContainText('已複製連結');
  const url = await page.evaluate(() => navigator.clipboard.readText());
  expect(url).toMatch(/#s=1\.[A-Za-z0-9_-]+$/);
  // a fresh tab with only the link: same design, same scenario
  const other = await context.newPage();
  await other.goto(url);
  await expect(other.getByRole('textbox', { name: '設計名稱' })).toHaveValue('分享測試');
  const after = await other.evaluate(() => {
    const st = (window as unknown as { __loadsketch: { getState(): { design(): unknown; scenario: unknown } } }).__loadsketch.getState();
    return JSON.stringify({ design: st.design(), scenario: st.scenario });
  });
  expect(after).toBe(before);
  // a damaged link says so and leaves a working app
  await other.goto(url.slice(0, url.length - 40));
  await expect(other.getByText(/打不開分享連結/)).toBeVisible();
  await other.close();
  expect(errors).toEqual([]);
});

test('metrics charts keep their width and scroll sideways; the right panel can be resized', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  // the autoscaling example has a fourth chart (instances)
  await page.goto('/app/?example=autoscale&speed=10&autorun=1&theme=dark');
  await expect(page.getByTestId('chart-instances')).toBeVisible({ timeout: 15_000 });
  const charts = page.getByTestId('charts');
  for (const id of ['chart-traffic', 'chart-latency', 'chart-util', 'chart-instances']) {
    expect((await page.getByTestId(id).boundingBox())!.width).toBeGreaterThanOrEqual(359);
  }
  const scroll = await charts.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(scroll.sw).toBeGreaterThan(scroll.cw);
  await charts.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
  await expect(page.getByTestId('chart-instances')).toBeInViewport();
  await page.screenshot({ path: join(SHOTS, 'charts-scroll.png') });

  // drag the panel's left edge 200 px to the left: 340 → 540
  const panel = page.getByTestId('right-panel');
  expect(Math.round((await panel.boundingBox())!.width)).toBe(340);
  const h = (await page.getByTestId('right-resize').boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + 200);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 - 100, h.y + 200, { steps: 4 });
  await page.mouse.move(h.x + h.width / 2 - 200, h.y + 200, { steps: 4 });
  await page.mouse.up();
  expect(Math.round((await panel.boundingBox())!.width)).toBe(540);
  await page.screenshot({ path: join(SHOTS, 'right-panel-wide.png') });
  // kept after a reload; never wider than 60% of the window
  await page.reload();
  await expect(panel).toBeVisible();
  expect(Math.round((await panel.boundingBox())!.width)).toBe(540);
  await page.getByTestId('right-resize').focus();
  for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowLeft');
  expect(Math.round((await panel.boundingBox())!.width)).toBe(864);
  // a double click goes back to the default
  await page.getByTestId('right-resize').dblclick();
  expect(Math.round((await panel.boundingBox())!.width)).toBe(340);
  // a narrow window: the panel shrinks to 60% of it (at least 280 px), and grows back with the window
  const vp = page.viewportSize()!;
  await page.setViewportSize({ width: 500, height: vp.height });
  await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBe(300);
  // widening there, already at the window's limit, keeps the wider stored width (340, not 300 + 16)
  await page.getByTestId('right-resize').focus();
  await page.keyboard.press('ArrowLeft');
  expect(await page.evaluate(() => localStorage.getItem('loadsketch-right-width'))).toBe('340');
  // so does a drag to the left there
  const hn = (await page.getByTestId('right-resize').boundingBox())!;
  await page.mouse.move(hn.x + hn.width / 2, hn.y + hn.height / 2);
  await page.mouse.down();
  await page.mouse.move(hn.x + hn.width / 2 - 16, hn.y + hn.height / 2, { steps: 4 });
  await page.mouse.up();
  expect(await page.evaluate(() => localStorage.getItem('loadsketch-right-width'))).toBe('340');
  // a double click there keeps the default asked for, not the narrow window's 300 px
  await page.getByTestId('right-resize').dblclick();
  expect(await page.evaluate(() => localStorage.getItem('loadsketch-right-width'))).toBe('340');
  await page.setViewportSize(vp);
  await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBe(340);
  expect(errors).toEqual([]);
});

test('on-call: a run on the canvas shows the same incident, hides the cause until the answer, and counts as opening every component', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/app/?example=three-tier&scenario=steady');
  await page.getByTestId('open-practice').click();
  await page.getByTestId('oncall-start-gray-errors').click();
  await expect(page.getByTestId('oncall-answer')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('oncall-canvas-note')).toBeVisible();
  await page.getByTestId('run').click();
  await page.getByRole('button', { name: '跳到結尾' }).click();
  await expect(page.getByTestId('run')).toContainText('再跑一次', { timeout: 60_000 });
  // the same incident: about a third of requests fail after 20 s
  const err = (await page.evaluate(() => (window as unknown as { __loadsketch: { getState(): { result: { summary: { errorRate: number } } } } }).__loadsketch.getState().result.summary.errorRate)) as number;
  expect(err).toBeGreaterThan(0.1);
  await expect(page.getByTestId('timeline-hidden')).toBeVisible();
  await expect(page.getByTestId('bottleneck')).toHaveCount(0);
  // the events' tooltip and the failure reasons would name the fault
  await expect(page.getByTestId('events')).toHaveCount(0);
  await expect(page.getByTestId('run-summary')).not.toContainText('元件錯誤');
  await page.getByTestId('tab-learn').click();
  await expect(page.getByTestId('why-hidden')).toBeVisible();
  // every component counts as opened: no open button is left
  await expect(page.locator('[data-testid^="oncall-open-"]')).toHaveCount(0);
  await page.getByTestId('oncall-node-api').click();
  await page.getByTestId('oncall-fault-gray').click();
  await page.getByTestId('oncall-answer').click();
  await expect(page.getByTestId('oncall-reveal')).toContainText('打開');
  // answered: the cause shows
  await expect(page.getByTestId('timeline-hidden')).toHaveCount(0);
  await expect(page.getByTestId('why-hidden')).toHaveCount(0);
  await expect(page.getByTestId('events')).toBeVisible();
  await expect(page.getByTestId('run-summary')).toContainText('元件錯誤');
  await page.getByTestId('tab-scenario').click();
  await expect(page.getByTestId('events-hidden')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('design brief: starts from the requirements and the given nodes; a design built by hand is judged on limits, needs and givens', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/app/');
  type Node = { id: string; data: { node: { kind: string } } };
  type S = { nodes: Node[]; edges: unknown[]; scenario: { name?: string }; addNode(kind: string, x: number, y: number): void; onConnect(c: { source: string; target: string }): void; updateNode(id: string, p: { params: Record<string, unknown> }): void };
  const store = <T,>(fn: (s: S, arg: never) => T, arg?: unknown) => page.evaluate(`(${fn.toString()})(window.__loadsketch.getState(), ${JSON.stringify(arg ?? null)})`) as Promise<T>;
  const runToEnd = async () => {
    await page.getByRole('button', { name: /^(執行|再跑一次)$/ }).click();
    await page.getByRole('button', { name: '跳到結尾' }).click();
    await expect(page.getByTestId('run')).toBeVisible({ timeout: 60_000 });
  };
  await page.getByTestId('open-practice').click();
  await expect(page.getByTestId('briefs')).toContainText('從需求開始設計');
  await page.getByTestId('brief-start-brief-notify').click();
  await expect(page.getByTestId('practice')).toHaveCount(0);
  // the canvas holds what the brief gives and nothing else; the card opens with the requirements
  const box = page.getByTestId('problem-brief-notify');
  await expect(box).toHaveAttribute('data-open', '');
  for (const part of ['功能需求', '流量', '已知條件', '不在範圍內']) await expect(box.getByTestId('brief-text')).toContainText(part);
  expect(await store((s) => s.nodes.map((n) => n.id).sort())).toEqual(['sms', 'users']);
  expect(await store((s) => s.edges.length)).toBe(0);
  expect(await store((s) => s.scenario.name)).toBe('需求：簡訊通知');
  await expect(box.getByTestId('need-finished')).not.toHaveAttribute('data-ok');
  // build it: an API, a queue and a worker that calls the provider. The worker is too small.
  const add = async (kind: string, x: number) => {
    await store((s, a: { kind: string; x: number }) => s.addNode(a.kind, a.x, 200), { kind, x });
    return store((s, k: string) => s.nodes.filter((n) => n.data.node.kind === k && n.id !== 'sms').at(-1)!.id, kind);
  };
  const api = await add('service', 300);
  const queue = await add('queue', 600);
  const worker = await add('worker', 900);
  for (const [source, target] of [['users', api], [api, queue], [queue, worker], [worker, 'sms']]) await store((s, c: { source: string; target: string }) => s.onConnect(c), { source, target });
  await runToEnd();
  // every request was accepted, but the messages wait: not passed
  await expect(box.getByTestId('check-errors')).toHaveAttribute('data-ok', 'true');
  await expect(box.getByTestId('need-finished')).toHaveAttribute('data-ok', 'false');
  await expect(box.getByTestId('problem-score')).toHaveText('還沒過關');
  // enough workers: passed, and the score is kept
  await store((s, id: string) => s.updateNode(id, { params: { instances: 4, concurrency: 32, serviceMs: { mean: 2, cv: 1 } } }), worker);
  await runToEnd();
  for (const c of ['errors', 'p99', 'budget', 'points']) await expect(box.getByTestId(`check-${c}`)).toHaveAttribute('data-ok', 'true');
  for (const n of ['reaches-sms', 'finished', 'not-degraded']) await expect(box.getByTestId(`need-${n}`)).toHaveAttribute('data-ok', 'true');
  await expect(box.getByTestId('problem-score')).toHaveText(/^過關！得分 \d+/);
  // just enough workers: the queue empties after the traffic ends, and that work counts
  await store((s, id: string) => s.updateNode(id, { params: { instances: 2, concurrency: 49, serviceMs: { mean: 2, cv: 1 } } }), worker);
  await runToEnd();
  for (const n of ['reaches-sms', 'finished']) await expect(box.getByTestId(`need-${n}`)).toHaveAttribute('data-ok', 'true');
  await expect(box.getByTestId('problem-score')).toHaveText(/^過關！得分 \d+/);
  const best = () => page.evaluate(() => (JSON.parse(localStorage.getItem('loadsketch-constraints') ?? '{}') as Record<string, number>)['brief-notify']);
  const kept = await best();
  expect(kept).toBeGreaterThanOrEqual(50);
  await page.screenshot({ path: join(SHOTS, 'brief.png') });
  // a given part made faster: every number is fine, and it does not pass
  await store((s) => s.updateNode('sms', { params: { serviceMs: { mean: 1, cv: 0.5 } } }));
  await runToEnd();
  await expect(box.getByTestId('brief-broken')).toContainText('不能改設定');
  await expect(box.getByTestId('problem-score')).toHaveText('還沒過關');
  // the reference design: the brief goes on (closed, so the design shows), judged without a score
  await box.getByTestId('brief-reference').click();
  await expect(box).not.toHaveAttribute('data-open');
  expect(await store((s) => s.nodes.length)).toBe(6);
  await runToEnd();
  await expect(box.getByTestId('problem-score')).toHaveText('參考設計過關（不計分）');
  expect(await best()).toBe(kept);
  await box.getByTestId('problem-quit').click();
  await expect(box).toHaveCount(0);
  await page.getByTestId('open-practice').click();
  await expect(page.getByTestId('brief-start-brief-notify')).toContainText(`最高 ${kept} 分`);
  // picked again: back to the start
  await page.getByTestId('brief-start-brief-notify').click();
  expect(await store((s) => s.nodes.map((n) => n.id).sort())).toEqual(['sms', 'users']);
  expect(errors).toEqual([]);
});

test('design briefs: in the browser every reference design passes, and none keeps a score', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/app/');
  await page.getByTestId('open-practice').click();
  const ids = await page.getByTestId('briefs').locator('[data-testid^="brief-start-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('brief-start-', '')));
  expect(ids.length).toBeGreaterThanOrEqual(6);
  await page.screenshot({ path: join(SHOTS, 'briefs-list.png') });
  for (const id of ids) {
    if (!(await page.getByTestId('briefs').isVisible().catch(() => false))) await page.getByTestId('open-practice').click();
    await page.getByTestId(`brief-start-${id}`).click();
    const box = page.getByTestId(`problem-${id}`);
    await expect(box.getByTestId('brief-text')).toBeVisible();
    await box.getByTestId('brief-reference').click();
    await page.getByRole('button', { name: /^(執行|再跑一次)$/ }).click();
    await page.getByRole('button', { name: '跳到結尾' }).click();
    await expect(page.getByTestId('run')).toBeVisible({ timeout: 90_000 });
    await expect(box.getByTestId('problem-score'), id).toHaveText('參考設計過關（不計分）');
    await box.getByTestId('problem-quit').click();
  }
  expect(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('loadsketch-constraints') ?? '{}')).filter((k) => k.startsWith('brief-')))).toEqual([]);
  expect(errors).toEqual([]);
});

test('practice: the dialog holds the keyboard; the problem in progress resumes; an incident ends by its button or another load', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/app/?example=three-tier&scenario=steady');
  type S = { panels: { left: boolean }; doc: { name: string }; updateNode(id: string, p: { label: string }): void; loadExample(n: string): void; nodes: { id: string; data: { node: { label?: string } } }[] };
  const st = <T,>(fn: (s: S) => T) => page.evaluate(`(${fn.toString()})(window.__loadsketch.getState())`) as Promise<T>;
  // while the dialog is open the app behind takes no shortcuts
  const toggle = process.platform === 'darwin' ? 'Meta+b' : 'Control+b';
  const left = await st((s) => s.panels.left);
  // the key does reach the app without the dialog (so the check below means something)
  await page.keyboard.press(toggle);
  expect(await st((s) => s.panels.left)).toBe(!left);
  await page.keyboard.press(toggle);
  expect(await st((s) => s.panels.left)).toBe(left);
  await page.getByTestId('open-practice').click();
  await page.keyboard.press(toggle);
  expect(await st((s) => s.panels.left)).toBe(left);
  // Tab goes round every visible control and back to the first (the hidden file input is skipped)
  const first = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  let back = false;
  for (let i = 0; i < 80 && !back; i++) {
    await page.keyboard.press('Tab');
    const at = await page.evaluate(() => ({ label: document.activeElement?.getAttribute('aria-label'), hidden: document.activeElement?.getClientRects().length === 0, inside: !!document.activeElement?.closest('[data-testid="practice"]') }));
    expect(at.hidden).toBe(false);
    expect(at.inside).toBe(true);
    back = i > 0 && at.label === first;
  }
  expect(back).toBe(true);
  // a problem in progress: picking it again goes back to it without reloading (edits kept)
  await page.getByTestId('problem-start-solo-shortener').click();
  await st((s) => s.updateNode('db', { label: 'mine' }));
  await page.getByTestId('open-practice').click();
  await expect(page.getByTestId('problem-start-solo-shortener')).toContainText('進行中');
  await page.getByTestId('problem-start-solo-shortener').click();
  await expect(page.getByTestId('practice')).toHaveCount(0);
  expect(await st((s) => s.nodes.find((n) => n.id === 'db')!.data.node.label)).toBe('mine');
  // an incident: its card closes with its button
  await page.getByTestId('open-practice').click();
  await page.getByTestId('oncall-start-gray-errors').click();
  await expect(page.getByTestId('oncall-card')).toBeVisible();
  await page.getByTestId('oncall-close').click();
  await expect(page.getByTestId('oncall-card')).toHaveCount(0);
  // and ends when another design loads
  await page.getByTestId('open-practice').click();
  await page.getByTestId('oncall-start-gray-errors').click();
  await expect(page.getByTestId('oncall-card')).toBeVisible();
  await st((s) => s.loadExample('url-shortener'));
  await expect(page.getByTestId('oncall-card')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('on-call: quitting before the answer clears what names the cause; a changed scenario ends the incident', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/app/?example=three-tier&scenario=steady');
  type S = { scenario: { events?: unknown[]; traffic: { rps: number } }; result: unknown; setScenario(s: unknown): void };
  const st = <T,>(fn: (s: S) => T) => page.evaluate(`(${fn.toString()})(window.__loadsketch.getState())`) as Promise<T>;
  await page.getByTestId('open-practice').click();
  await page.getByTestId('oncall-start-gray-errors').click();
  await expect(page.getByTestId('oncall-answer')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('run').click();
  await page.getByRole('button', { name: '跳到結尾' }).click();
  await expect(page.getByTestId('run')).toContainText('再跑一次', { timeout: 60_000 });
  // quit before the answer: no events, no run, no failure reasons are left to read
  await page.getByTestId('oncall-close').click();
  await expect(page.getByTestId('oncall-card')).toHaveCount(0);
  expect(await st((s) => s.scenario.events?.length ?? 0)).toBe(0);
  expect(await st((s) => s.result)).toBeNull();
  await expect(page.getByTestId('events')).toHaveCount(0);
  // a changed scenario before the answer ends the incident the same way
  await page.getByTestId('open-practice').click();
  await page.getByTestId('oncall-start-gray-errors').click();
  await expect(page.getByTestId('oncall-card')).toBeVisible();
  await st((s) => s.setScenario({ ...s.scenario, traffic: { ...s.scenario.traffic, rps: s.scenario.traffic.rps + 1 } }));
  await expect(page.getByTestId('oncall-card')).toHaveCount(0);
  expect(await st((s) => s.scenario.events?.length ?? 0)).toBe(0);
  // a preset picked while on call ends it too, and keeps the preset's own events
  await page.getByTestId('open-practice').click();
  await page.getByTestId('oncall-start-gray-errors').click();
  await expect(page.getByTestId('oncall-card')).toBeVisible();
  // its events include two copies of the incident's own fault: equal values, not the incident's objects
  await st((s) => s.setScenario({ ...s.scenario, name: 'p', events: [{ type: 'spike', atS: 5, forS: 5, multiplier: 2 }, structuredClone(s.scenario.events![0]), structuredClone(s.scenario.events![0])] }));
  await expect(page.getByTestId('oncall-card')).toHaveCount(0);
  expect(await st((s) => s.scenario.events?.length ?? 0)).toBe(3);
  expect(errors).toEqual([]);
});

test('terraform import: pick a plan, see the sources, edit, undo, reset to default', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/app/');
  await page.getByTestId('import-terraform-file').setInputFiles(join(import.meta.dirname, '..', 'tests', 'import', 'fixtures', 'ecs-rds.plan.json'));
  // the design is on the canvas; the service has guessed performance values: a dashed frame
  const api = page.locator('[data-node="ecs_service_api"]');
  await expect(api).toBeVisible();
  await expect(api).toHaveAttribute('data-guessed', 'true');
  await expect(api).toHaveCSS('border-top-style', 'dashed');
  await expect(page.locator('[data-node="lb_web"]')).not.toHaveAttribute('data-guessed', 'true');
  // the checks tab opens with the findings of the import
  await expect(page.getByTestId('tab-checks')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('import-finding').first()).toBeVisible();
  expect(await page.getByTestId('import-finding').count()).toBeGreaterThan(0);
  await page.screenshot({ path: join(SHOTS, 'terraform-import-checks.png') });

  // the settings panel shows where each value came from
  await api.click();
  const origin = page.getByTestId('origin-concurrency');
  await expect(origin).toHaveAttribute('data-evidence', 'estimate');
  await expect(origin).toHaveText('猜的');
  await expect(page.getByTestId('origin-instances')).toHaveAttribute('data-evidence', 'iac');
  const field = page.getByTestId('param-concurrency').getByRole('textbox');
  await expect(field).toHaveValue('8');
  await page.screenshot({ path: join(SHOTS, 'terraform-import-sources.png') });

  // a value typed in the panel is the user's
  await field.fill('16');
  await expect(origin).toHaveAttribute('data-evidence', 'answer');
  await expect(origin).toHaveText('使用者填');
  // undo brings the value and its source back
  await page.getByTestId('undo').click();
  await api.click(); // undo shows the snapshot with nothing selected
  await expect(field).toHaveValue('8');
  await expect(origin).toHaveAttribute('data-evidence', 'estimate');
  // "use default": the kind's default, marked so
  await page.getByTestId('param-concurrency').getByRole('button', { name: '用預設' }).click();
  await expect(origin).toHaveAttribute('data-evidence', 'loadsketch-default');
  await expect(origin).toHaveText('預設值');
  await expect(api).toHaveAttribute('data-guessed', 'true');

  // the real values typed in: no guess left, the canvas redraws the frame solid
  await field.fill('16');
  await page.getByTestId('param-serviceMs').getByRole('textbox').fill('20');
  await expect(page.getByTestId('origin-serviceMs')).toHaveAttribute('data-evidence', 'answer');
  await expect(api).not.toHaveAttribute('data-guessed', 'true');
  await expect(api).toHaveCSS('border-top-style', 'solid');
  // the checks tab stays with this design, and goes away when another one loads
  await expect(page.getByTestId('tab-checks')).toBeVisible();
  await page.getByTestId('file-menu').click();
  await page.getByTestId('new-design').click();
  await expect(page.getByTestId('tab-checks')).toHaveCount(0);
  // the panel goes back to a tab that is there
  await expect(page.getByTestId('tab-design')).toHaveAttribute('aria-selected', 'true');
  expect(errors).toEqual([]);
});

test('terraform import: the dialog says which file to pick, and an example plan imports in one click', async ({ page }) => {
  await page.goto('/app/');
  await page.getByTestId('file-menu').click();
  await page.getByTestId('import-terraform').click();
  const dialog = page.getByTestId('import-terraform-dialog');
  await expect(dialog).toContainText('不是 .tf 原始檔');
  await expect(dialog).toContainText('terraform show -json plan.out > plan.json');
  await page.getByTestId('import-example-lambda-sqs-rds').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-node="lambda_function_api"]')).toBeVisible();
  await expect(page.getByTestId('tab-checks')).toHaveAttribute('aria-selected', 'true');
});

test('terraform import: a .tf file says how to make the plan JSON', async ({ page }) => {
  await page.goto('/app/');
  await page.getByTestId('import-terraform-file').setInputFiles({ name: 'main.tf', mimeType: 'text/plain', buffer: Buffer.from('resource "aws_lb" "web" {}') });
  await expect(page.getByText(/不能匯入 main\.tf：這是 Terraform 原始檔/)).toBeVisible();
});

test('terraform import: a file that is not a plan shows why', async ({ page }) => {
  await page.goto('/app/');
  await page.getByTestId('import-terraform-file').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"schema":"x"}') });
  await expect(page.getByText(/不能匯入 x\.json/)).toBeVisible();
  await expect(page.getByTestId('tab-checks')).toHaveCount(0);
});

test('terraform import: a good import clears the last error; a scenario for the old design does not stay', async ({ page }) => {
  // the 跨年夜 scenario slows down `geo`, a node the imported design does not have
  await page.goto('/app/?example=saas-uber');
  await expect(page.locator('[data-node="geo"]')).toBeVisible();
  await page.getByTestId('import-terraform-file').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"schema":"x"}') });
  await expect(page.getByText(/不能匯入 x\.json/)).toBeVisible();
  await page.getByTestId('import-terraform-file').setInputFiles(join(import.meta.dirname, '..', 'tests', 'import', 'fixtures', 'lambda-sqs-rds.plan.json'));
  await expect(page.locator('[data-node="lambda_function_api"]')).toBeVisible();
  await expect(page.getByText(/不能匯入/)).toHaveCount(0);
  await page.getByRole('button', { name: '執行' }).click();
  await expect(page.getByText(/情境有錯誤/)).toHaveCount(0);
  await expect(page.getByText('尚未執行')).toHaveCount(0);
});

test('terraform import: a new design while the checks tab is open goes back to settings', async ({ page }) => {
  await page.goto('/app/');
  await page.getByTestId('import-terraform-file').setInputFiles(join(import.meta.dirname, '..', 'tests', 'import', 'fixtures', 'ecs-rds.plan.json'));
  await expect(page.getByTestId('tab-checks')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('file-menu').click();
  await page.getByTestId('new-design').click();
  await expect(page.getByTestId('tab-checks')).toHaveCount(0);
  await expect(page.getByTestId('tab-design')).toHaveAttribute('aria-selected', 'true');
});

test('terraform import: a finding runs its scenario in one click', async ({ page }) => {
  await page.goto('/app/');
  await page.getByTestId('import-terraform-file').setInputFiles(join(import.meta.dirname, '..', 'tests', 'import', 'fixtures', 'ecs-rds.plan.json'));
  const card = page.locator('[data-testid="import-finding"][data-check="C3"]');
  await expect(card).toContainText('db_instance_main 在第 20 秒故障，持續 60 秒');
  await card.getByTestId('import-finding-simulate').click();
  // the run starts and the results tab opens
  await expect(page.getByTestId('tab-learn')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('pause')).toBeVisible();
  // the scenario is the finding's: half of what the DB can do (8 / 3.7 ms × 0.5 = 1081 rps)
  await page.getByTestId('pause').click();
  await page.getByTestId('tab-scenario').click();
  await expect(page.getByTestId('scenario-editor').locator('input').first()).toHaveValue('1081');
});

test('terraform import: a resource name over the 60-character label limit is cut and loads', async ({ page }) => {
  // Before #44 (75bf14c) this design failed the schema and was not loaded. The
  // importer now cuts labels to 60, so a plan gives no design the schema rejects; TopBar still checks.
  await page.goto('/app/?example=three-tier');
  await expect(page.locator('[data-node]')).toHaveCount(5);
  const long = plan([{ address: `aws_lb.${'x'.repeat(61)}`, values: { internal: false, load_balancer_type: 'application' } }]);
  await page.getByTestId('import-terraform-file').setInputFiles({ name: 'long.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(long)) });
  await expect(page.getByTestId('tab-checks')).toBeVisible();
  await expect(page.getByText(/不能匯入/)).toHaveCount(0);
  await expect(page.getByText('x'.repeat(61))).toHaveCount(0);
});

test('intro site: it opens the simulator, and its live panels are the simulator itself', async ({ page }) => {
  await page.goto('/?lang=en&theme=light');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sketch a system. Send traffic. See what breaks first.');
  await expect(page.getByTestId('site-open')).toHaveAttribute('href', './app/');
  // the first live panel is the app in embed mode: a canvas that runs, with no top bar or component list
  const live = page.frameLocator('iframe').first();
  await expect(live.locator('[data-node]').first()).toBeVisible();
  await expect(live.getByTestId('clock')).not.toHaveText('Not run yet');
  await expect(live.getByTestId('file-menu')).toHaveCount(0);
  // the feature carousel: the next button shows the next screenshot, in the page's language and theme
  const carousel = page.getByTestId('site-carousel');
  await expect(carousel.getByText('1 / 6')).toBeVisible();
  await carousel.getByRole('button', { name: 'Next' }).click();
  await expect(carousel.getByText('2 / 6')).toBeVisible();
  await expect(carousel.getByRole('heading', { name: 'Design from requirements' })).toBeVisible();
  await expect(carousel.getByRole('img', { name: 'Design from requirements' })).toHaveAttribute('src', /brief-en-light/);
  // the current screenshot opens large, and Escape closes it
  await carousel.getByRole('button', { name: 'Enlarge' }).click();
  await expect(page.getByTestId('site-zoom').getByRole('img')).toHaveAttribute('src', /brief-en-light/);
  // a modal dialog: the page behind it takes no focus, and Tab stays on the dialog's button
  expect(await page.evaluate(() => document.getElementById('root')!.inert)).toBe(true);
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.closest('[data-testid="site-zoom"]') !== null)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('site-zoom')).toHaveCount(0);
  expect(await page.evaluate(() => document.getElementById('root')!.inert)).toBe(false);
  // the language button changes the page text
  await page.getByTestId('site-lang').click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('畫出系統 灌流量 看哪裡先壞');
  await expect(carousel.getByRole('img', { name: '從需求開始設計' })).toHaveAttribute('src', /brief-zh-light/);
  // the page does not scroll sideways on a phone
  await page.setViewportSize({ width: 390, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // the footer can be broken and fixed; its availability drops while it is down
  const footer = page.getByTestId('site-footer');
  await expect(footer).toContainText('頁尾運作正常');
  await expect(page.getByTestId('site-footer-availability')).toHaveText('可用性 100.00%');
  await page.getByTestId('site-footer-break').click();
  await expect(footer).toHaveAttribute('data-broken');
  await expect(footer).toContainText('頁尾壞了');
  await expect(page.getByTestId('site-footer-availability')).not.toHaveText('可用性 100.00%');
  // the incident log tells what happened, line by line
  await expect(footer).toHaveAttribute('data-fault', 'drop');
  await expect(page.getByTestId('site-footer-log')).toContainText('三個連結一個接一個掉下去');
  await page.getByTestId('site-footer-break').click();
  await expect(footer).toContainText('頁尾運作正常');
  await expect(page.getByTestId('site-footer-log')).toContainText('修好了');
  // the next break is another fault
  await page.getByTestId('site-footer-break').click();
  await expect(footer).toHaveAttribute('data-fault', 'storm');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('embed mode: only the canvas and the chosen panels; a finished run starts again', async ({ page }) => {
  await page.goto('/app/?embed=1&example=three-tier&autorun=1&loop=1&speed=300&lang=en');
  await expect(page.locator('[data-node]').first()).toBeVisible();
  await expect(page.getByTestId('file-menu')).toHaveCount(0);
  await expect(page.getByTestId('clock')).toBeVisible();
  // the run ends, then starts again by itself
  await page.waitForFunction(() => (window as any).__loadsketch.getState().status === 'done');
  await page.waitForFunction(() => (window as any).__loadsketch.getState().status === 'running');
  await page.goto('/app/?embed=1&bar=0&example=three-tier&lang=en');
  await expect(page.locator('[data-node]').first()).toBeVisible();
  await expect(page.getByTestId('clock')).toHaveCount(0);
});

test('intro site: a share link on the root address opens in the simulator', async ({ page }) => {
  await page.goto('/?lang=en#s=1.x');
  await expect(page).toHaveURL(/\/app\/\?lang=en#s=1\.x$/);
});

test.describe('phone layout', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the canvas fills the screen; the panels open as drawers', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/app/?example=three-tier&lang=en');
    await expect(page.locator('[data-node]')).toHaveCount(5);
    const drawer = page.getByTestId('phone-drawer');
    await expect(drawer).not.toHaveAttribute('data-open');
    // the canvas has the whole width, and the page does not scroll sideways
    expect((await page.locator('.react-flow').boundingBox())?.width).toBe(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

    // the first view is large enough to read, and starts where the traffic starts; the rest is a swipe away
    const card = (await page.locator('[data-node="users"]').boundingBox())!;
    expect(card.width).toBeGreaterThan(100);
    expect(card.x).toBeGreaterThanOrEqual(0);
    expect(card.x + card.width).toBeLessThan(390);

    // a tap on a component opens its settings
    await page.locator('[data-node="users"]').tap();
    await expect(drawer).toHaveAttribute('data-open');
    await expect(page.getByTestId('phone-tab-inspector')).toHaveAttribute('aria-pressed', 'true');
    await expect(drawer.getByTestId('tab-design')).toBeVisible();
    await page.getByTestId('phone-drawer-close').tap();
    await expect(drawer).not.toHaveAttribute('data-open');

    // a drag down on the drawer's top edge closes it
    await page.getByTestId('phone-tab-inspector').tap();
    await expect(drawer).toHaveAttribute('data-open');
    await page.waitForTimeout(600); // the drawer has stopped moving
    const grip = (await page.getByTestId('phone-drawer-grip').boundingBox())!;
    await page.mouse.move(grip.x + 60, grip.y + 10);
    await page.mouse.down();
    await page.mouse.move(grip.x + 60, grip.y + 60, { steps: 3 });
    // the run card above the drawer moves with it
    expect(await page.locator('main').evaluate((m) => m.style.getPropertyValue('--drawer-drag'))).toBe('50px');
    await page.mouse.move(grip.x + 60, grip.y + 160, { steps: 3 });
    await page.mouse.up();
    await expect(drawer).not.toHaveAttribute('data-open');

    // the palette adds a component and gets out of the way
    await page.getByTestId('phone-tab-palette').tap();
    await drawer.locator('[data-kind="queue"]').tap();
    await expect(page.locator('[data-node]')).toHaveCount(6);
    await expect(drawer).not.toHaveAttribute('data-open');

    // a run, then the charts
    await page.getByTestId('run').tap();
    await page.getByRole('button', { name: 'Skip to end' }).tap();
    await expect(page.getByTestId('run')).toContainText('Run again', { timeout: 60_000 });
    await page.getByTestId('phone-tab-metrics').tap();
    await expect(drawer.getByTestId('kpis')).toContainText('p99');
    // the same tab again closes the drawer
    await page.getByTestId('phone-tab-metrics').tap();
    await expect(drawer).not.toHaveAttribute('data-open');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    expect(errors).toEqual([]);
  });

  test('a tapped component shows its settings in a lesson too; the panel shortcuts open the drawers', async ({ page }) => {
    await page.goto('/app/?example=retry-storm&lang=en');
    const drawer = page.getByTestId('phone-drawer');
    // the first time the settings drawer opens, with a component already selected
    await page.locator('[data-node]').first().tap();
    await expect(drawer.getByTestId('tab-design')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('phone-drawer-close').tap();
    const before = await page.evaluate(() => JSON.stringify((window as unknown as { __loadsketch: { getState(): { panels: unknown } } }).__loadsketch.getState().panels));
    await page.keyboard.press('ControlOrMeta+j');
    await expect(page.getByTestId('phone-tab-metrics')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('ControlOrMeta+b');
    await expect(page.getByTestId('phone-tab-palette')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('ControlOrMeta+b');
    await expect(drawer).not.toHaveAttribute('data-open');
    // the desktop layout's saved panels are not changed
    expect(await page.evaluate(() => JSON.stringify((window as unknown as { __loadsketch: { getState(): { panels: unknown } } }).__loadsketch.getState().panels))).toBe(before);
  });

  test('intro site: on a phone the live frames show the phone layout', async ({ page }) => {
    await page.goto('/?lang=en');
    const frame = page.locator('.site-live iframe').first();
    await expect(frame).toHaveAttribute('src', /embed=1.*phone=1/);
    const app = page.frameLocator('.site-live iframe').first();
    await expect(app.getByTestId('phone-tab-palette')).toBeVisible();
    await expect(app.getByTestId('pause')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    // the phone turned on its side: the frame goes back to the wide layout, with its own height
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(frame).not.toHaveAttribute('src', /phone=1/);
    expect((await frame.boundingBox())!.height).toBeGreaterThan(300);
  });

  test('the examples dialog fits: categories in one row, cards in one column', async ({ page }) => {
    await page.goto('/app/?lang=en');
    await page.getByTestId('open-examples').tap();
    const box = (await page.getByTestId('example-browser').boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    const cards = page.getByTestId('example-browser').locator('.card');
    const [a, b] = [(await cards.nth(0).boundingBox())!, (await cards.nth(1).boundingBox())!];
    expect(a.width).toBeGreaterThan(300);
    expect(b.y).toBeGreaterThan(a.y);
  });

  test('read-through hint on a phone: above the run card, and still in view with a drawer open', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/app/?example=three-tier');
    await expect(page.locator('[data-node]')).toHaveCount(5);
    await page.evaluate(() => (window as unknown as { __loadsketch: { getState(): { onConnect(c: { source: string; target: string }): void } } }).__loadsketch.getState().onConnect({ source: 'cache', target: 'db' }));
    const hint = page.getByTestId('edge-through-hint');
    await expect(hint).toBeVisible();
    // nothing overlaps it, and what is on top at each corner of the text is the hint itself
    const clear = async () => {
      const h = (await hint.boundingBox())!;
      expect(h.y).toBeGreaterThanOrEqual(0);
      for (const other of [page.locator('.sd-runcard'), page.getByTestId('phone-drawer')]) {
        if (!(await other.isVisible())) continue;
        const o = (await other.boundingBox())!;
        expect(h.y + h.height <= o.y || o.y + o.height <= h.y, 'overlaps').toBe(true);
      }
      const onTop = await hint.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return [[r.left + 8, r.top + 8], [r.right - 8, r.bottom - 8], [r.left + r.width / 2, r.top + r.height / 2]].every(([x, y]) => el.contains(document.elementFromPoint(x, y)));
      });
      expect(onTop).toBe(true);
    };
    await page.waitForTimeout(600); // the run card and the canvas have stopped moving
    await clear();
    await page.screenshot({ path: join(SHOTS, 'phone-read-through.png') });
    // a drawer open: the hint stays in view
    await page.getByTestId('phone-tab-inspector').tap();
    await expect(page.getByTestId('phone-drawer')).toHaveAttribute('data-open');
    await page.waitForTimeout(600); // the drawer has stopped moving
    await expect(hint).toBeVisible();
    await clear();
    await page.screenshot({ path: join(SHOTS, 'phone-read-through-drawer.png') });
    await hint.getByTestId('edge-through-hint-close').tap();
    await expect(hint).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('read-through hint on a phone: opening the design-check list closes it, so the list can be tapped', async ({ page }) => {
    await page.goto('/app/?example=three-tier');
    await expect(page.locator('[data-node]')).toHaveCount(5);
    type S = { addNode(kind: string, x: number, y: number): void; onConnect(c: { source: string; target: string }): void; setDrawer(d: null): void; selected: unknown };
    const st = <T,>(fn: (s: S) => T) => page.evaluate(`(${fn.toString()})(window.__loadsketch.getState())`) as Promise<T>;
    // a component on its own: the design check has something to list
    await st((s) => s.addNode('queue', 40, 40));
    await st((s) => s.onConnect({ source: 'cache', target: 'db' }));
    await st((s) => s.setDrawer(null));
    const hint = page.getByTestId('edge-through-hint');
    await expect(hint).toBeVisible();
    await page.getByTestId('checks').tap();
    const list = page.getByTestId('checks-list');
    await expect(list).toBeVisible();
    await expect(hint).toHaveCount(0);
    // what is on top over the list is the list: its links take the tap
    const onTop = await list.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return [[r.left + 8, r.top + 8], [r.right - 8, r.bottom - 8], [r.left + r.width / 2, r.top + r.height / 2]].every(([x, y]) => el.contains(document.elementFromPoint(x, y)));
    });
    expect(onTop).toBe(true);
    await page.screenshot({ path: join(SHOTS, 'phone-read-through-checks.png') });
    await list.locator('button:not([disabled])').first().tap();
    await expect.poll(() => st((s) => s.selected)).not.toBeNull();
    // the line keeps its label
    await expect(page.getByTestId('edge-through-label')).toHaveCount(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Versions and compare (roadmap-next M1–M3)

type Store = { getState(): Record<string, unknown> & { run(): void; finish(): void; status: string; updateNode(id: string, p: { params: Record<string, unknown> }): void } };
/** Runs the design on the canvas to the end and waits for the result. */
async function runToEnd(page: Page) {
  await page.evaluate(() => {
    const st = (window as unknown as { __loadsketch: Store }).__loadsketch.getState();
    st.run();
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => (window as unknown as { __loadsketch: Store }).__loadsketch.getState().finish());
  await expect.poll(() => page.evaluate(() => (window as unknown as { __loadsketch: Store }).__loadsketch.getState().status), { timeout: 60_000 }).toBe('done');
}

test('versions: every run leaves one; rename, pin, delete, load back, keep after a reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/app/?example=three-tier&scenario=steady&theme=light');
  await expect(page.locator('[data-node]')).toHaveCount(5);
  await page.getByTestId('tab-versions').click();
  await expect(page.getByTestId('versions-empty')).toBeVisible();

  await runToEnd(page);
  const rows = page.getByTestId('version');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().getByTestId('version-numbers')).toContainText('p99');
  // the same design and scenario again: the same result, so no second version
  await runToEnd(page);
  await expect(rows).toHaveCount(1);

  // one more API server: a new version at the top
  await page.evaluate(() => (window as unknown as { __loadsketch: Store }).__loadsketch.getState().updateNode('api', { params: { instances: 4 } }));
  await runToEnd(page);
  await expect(rows).toHaveCount(2);

  // rename and pin the older one
  const older = rows.nth(1);
  await older.getByTestId('version-name').fill('3 台');
  await older.getByTestId('version-pin').click();
  await expect(older).toHaveAttribute('data-pinned', 'true');
  await page.screenshot({ path: join(SHOTS, 'versions-light.png') });

  // load it back: the canvas has 3 API servers again
  await older.getByTestId('version-load').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __loadsketch: { getState(): { design(): { nodes: { id: string; params?: { instances?: number } }[] } } } }).__loadsketch.getState().design().nodes.find((n) => n.id === 'api')?.params?.instances)).toBe(3);

  // delete the newer one
  await page.getByTestId('tab-versions').click();
  await rows.nth(0).getByTestId('version-delete').click();
  await expect(rows).toHaveCount(1);

  // still there after a reload
  await page.reload();
  await page.getByTestId('tab-versions').click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first().getByTestId('version-name')).toHaveValue('3 台');
  await expect(rows.first()).toHaveAttribute('data-pinned', 'true');
  expect(errors).toEqual([]);
});

test('versions: export to a file and import it again', async ({ page }) => {
  await page.goto('/app/?example=three-tier&scenario=steady&theme=dark');
  await expect(page.locator('[data-node]')).toHaveCount(5);
  await runToEnd(page);
  await page.getByTestId('tab-versions').click();
  await expect(page.getByTestId('version')).toHaveCount(1);
  await page.screenshot({ path: join(SHOTS, 'versions-dark.png') });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('versions-export').click()]);
  const path = await download.path();
  const text = readFileSync(path!, 'utf8');
  expect(JSON.parse(text).schema).toBe('loadsketch/versions@1');
  // empty the list, then import the file
  await page.getByTestId('version-delete').click();
  await expect(page.getByTestId('version')).toHaveCount(0);
  await page.getByTestId('versions-import-file').setInputFiles({ name: 'v.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await expect(page.getByTestId('version')).toHaveCount(1);
  // a file that is not a version file: an error, the list stays
  await page.getByTestId('versions-import-file').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"a":1}') });
  await expect(page.getByText('不是 loadsketch 匯出的版本檔')).toBeVisible();
  await expect(page.getByTestId('version')).toHaveCount(1);
});

test('versions: two tabs do not overwrite each other', async ({ context }) => {
  const a = await context.newPage();
  await a.goto('/app/?example=three-tier&scenario=steady');
  await expect(a.locator('[data-node]')).toHaveCount(5);
  await runToEnd(a);
  const b = await context.newPage();
  await b.goto('/app/?example=three-tier&scenario=steady');
  await expect(b.locator('[data-node]')).toHaveCount(5);
  // tab A pins its version; tab B, opened before, then finishes another run
  await a.getByTestId('tab-versions').click();
  await a.getByTestId('version-pin').click();
  await b.evaluate(() => (window as unknown as { __loadsketch: Store }).__loadsketch.getState().updateNode('api', { params: { instances: 4 } }));
  await runToEnd(b);
  await b.getByTestId('tab-versions').click();
  await expect(b.getByTestId('version')).toHaveCount(2);
  await expect(b.locator('[data-testid="version"][data-pinned]')).toHaveCount(1);
  // tab A shows tab B's run without a reload
  await expect(a.getByTestId('version')).toHaveCount(2);
  await expect(a.locator('[data-testid="version"][data-pinned]')).toHaveCount(1);
});

/** Three versions of three-tier: as it is, with 4 API servers, and under a spike. */
async function threeVersions(page: Page) {
  await page.goto('/app/?example=three-tier&scenario=steady');
  await expect(page.locator('[data-node]')).toHaveCount(5);
  await runToEnd(page);
  await page.evaluate(() => (window as unknown as { __loadsketch: Store }).__loadsketch.getState().updateNode('api', { params: { instances: 4 } }));
  await runToEnd(page);
  await page.evaluate(() => {
    const st = (window as unknown as { __loadsketch: { getState(): { scenario: { traffic: { rps: number } }; setScenario(s: unknown): void } } }).__loadsketch.getState();
    st.setScenario({ ...st.scenario, name: 'spike-ish', traffic: { ...st.scenario.traffic, rps: 1600 } });
  });
  await runToEnd(page);
}

for (const theme of ['light', 'dark'] as const) {
  test(`compare: versions side by side with a baseline (${theme})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await threeVersions(page);
    if (theme === 'dark') await page.evaluate(() => (window as unknown as { __loadsketch: { getState(): { setTheme(t: string): void } } }).__loadsketch.getState().setTheme('dark'));
    await page.getByTestId('tab-versions').click();
    await expect(page.getByTestId('version')).toHaveCount(3);
    const compareBtn = page.getByTestId('versions-compare');
    await expect(compareBtn).toBeDisabled();
    const picks = page.getByTestId('version-pick');
    for (let i = 0; i < 3; i++) await picks.nth(i).check();
    await compareBtn.click();

    const dlg = page.getByTestId('compare');
    await expect(dlg.getByTestId('compare-col')).toHaveCount(3);
    // the oldest is the baseline: the others show how much they differ
    await expect(dlg.getByTestId('compare-col').first().getByTestId('compare-base')).toBeVisible();
    await expect(dlg.getByTestId('compare-row-p99').locator('[data-tone]')).toHaveCount(2);
    // more servers cost more
    await expect(dlg.getByTestId('compare-row-costPerMonth').locator('[data-tone]').first()).toHaveAttribute('data-tone', 'worse');
    // what changed in each, and the warning for the other scenario
    await expect(dlg.getByTestId('compare-diff').first()).toContainText('「B · ');
    await expect(dlg.getByTestId('compare-diff').first()).toContainText('「API 伺服器」的實例數：3 → 4');
    await expect(dlg.getByTestId('compare-diff').nth(1)).toContainText('情境的每秒請求：800 → 1600');
    await expect(dlg.getByTestId('compare-mixed')).toBeVisible();
    // the charts come from running each version again
    await expect(dlg.getByTestId('compare-running')).toHaveCount(0, { timeout: 60_000 });
    await expect(dlg.getByTestId('compare-chart-p99')).toBeVisible();
    await expect(dlg.getByTestId('compare-stale')).toHaveCount(0);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, `compare-${theme}.png`) });

    // another baseline: the deltas follow it
    await dlg.getByTestId('compare-set-base').first().click();
    await expect(dlg.getByTestId('compare-col').nth(1).getByTestId('compare-base')).toBeVisible();
    await expect(dlg.getByTestId('compare-diff').first()).toContainText('「API 伺服器」的實例數：4 → 3');
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('compare: at most 4 versions; a version compared with the same scenario shows no warning', async ({ page }) => {
  await page.goto('/app/?example=three-tier&scenario=steady');
  await expect(page.locator('[data-node]')).toHaveCount(5);
  for (const n of [2, 3, 4, 5, 6]) {
    await page.evaluate((k) => (window as unknown as { __loadsketch: Store }).__loadsketch.getState().updateNode('api', { params: { instances: k } }), n);
    await runToEnd(page);
  }
  await page.getByTestId('tab-versions').click();
  const picks = page.getByTestId('version-pick');
  await expect(picks).toHaveCount(5);
  for (let i = 0; i < 4; i++) await picks.nth(i).check();
  await expect(picks.nth(4)).toBeDisabled();
  await picks.nth(3).uncheck();
  await page.getByTestId('versions-compare').click();
  await expect(page.getByTestId('compare-col')).toHaveCount(3);
  await expect(page.getByTestId('compare-mixed')).toHaveCount(0);
  // a share link holds 2 runs at most (Q9=A)
  await expect(page.getByTestId('compare-share')).toBeDisabled();
});

test.describe('compare runs less (M14)', () => {
  test.beforeEach(async ({ page }) => {
    // count the compare workers and the most alive at once (the dev build's StrictMode starts the
    // effect twice: the first set is stopped at once), and note if "running each version again" shows
    await page.addInitScript(() => {
      const w = window as unknown as { __cw: number; __cwEnd: number; __cwMax: number; __cwDone: number; __sawRunning: boolean };
      Object.assign(w, { __cw: 0, __cwEnd: 0, __cwMax: 0, __cwDone: 0, __sawRunning: false });
      const Real = window.Worker;
      window.Worker = class extends Real {
        private ended = false;
        private compare = false;
        constructor(url: string | URL, opts?: WorkerOptions) {
          super(url, opts);
          this.compare = String(url).includes('compare.worker');
          if (!this.compare) return;
          w.__cw++;
          w.__cwMax = Math.max(w.__cwMax, w.__cw - w.__cwEnd);
          this.addEventListener('message', () => w.__cwDone++);
        }
        terminate() {
          if (this.compare && !this.ended) w.__cwEnd++;
          this.ended = true;
          super.terminate();
        }
      };
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="compare-running"]')) w.__sawRunning = true;
      }).observe(document, { childList: true, subtree: true });
    });
  });
  const counts = (page: Page) => page.evaluate(() => {
    const w = window as unknown as { __cw: number; __cwEnd: number; __cwMax: number; __cwDone: number; __sawRunning: boolean };
    return { workers: w.__cw, alive: w.__cw - w.__cwEnd, most: w.__cwMax, replies: w.__cwDone, sawRunning: w.__sawRunning };
  });
  const openTwo = (page: Page) => page.evaluate(() => {
    const st = (window as unknown as { __loadsketch: { getState(): { versions: { id: string; name: string; at: number; design: unknown; scenario: unknown; summary: unknown }[]; openCompare(i: unknown[]): void } } }).__loadsketch.getState();
    st.openCompare(st.versions.slice(0, 2).reverse().map((v) => ({ key: v.id, name: v.name, at: v.at, design: v.design, scenario: v.scenario, summary: v.summary })));
  });

  test('compare: two versions just run show their charts at once, with no run again; after a reload they run again, side by side', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/app/?example=three-tier&scenario=steady');
    await expect(page.locator('[data-node]')).toHaveCount(5);
    await runToEnd(page);
    await page.evaluate(() => (window as unknown as { __loadsketch: Store }).__loadsketch.getState().updateNode('api', { params: { instances: 4 } }));
    await runToEnd(page);

    await openTwo(page);
    const dlg = page.getByTestId('compare');
    await expect(dlg.getByTestId('compare-chart-p99')).toBeVisible();
    await expect(dlg.getByTestId('compare-chart-fail')).toBeVisible();
    await expect(dlg.getByTestId('compare-col')).toHaveCount(2);
    await page.waitForTimeout(300);
    expect(await counts(page)).toEqual({ workers: 0, alive: 0, most: 0, replies: 0, sawRunning: false });
    await expect(dlg.getByTestId('compare-stale')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);

    // a reload keeps the versions, not the curves: both run again, each in a worker of its own
    await page.reload();
    await expect(page.locator('[data-node]')).toHaveCount(5);
    await openTwo(page);
    await expect(dlg.getByTestId('compare-col')).toHaveCount(2);
    await expect(dlg.getByTestId('compare-running')).toHaveCount(0, { timeout: 60_000 });
    await expect(dlg.getByTestId('compare-chart-p99')).toBeVisible();
    // the two ran at the same time; each worker stops after its answer
    expect(await counts(page)).toMatchObject({ most: 2, alive: 0, replies: 2, sawRunning: true });
    // the same design, scenario and seed: the run again gives the numbers the versions have
    await expect(dlg.getByTestId('compare-stale')).toHaveCount(0);
    await expect(dlg.getByText('重跑失敗')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('compare: a deleted version run again keeps a new curve under its new id', async ({ page }) => {
    await page.goto('/app/?example=three-tier&scenario=steady');
    await expect(page.locator('[data-node]')).toHaveCount(5);
    await runToEnd(page);
    await page.evaluate(() => (window as unknown as { __loadsketch: Store }).__loadsketch.getState().updateNode('api', { params: { instances: 4 } }));
    await runToEnd(page);
    // delete the newer version, then run that design again: a new version, and a curve for it again
    const ids = () => page.evaluate(() => (window as unknown as { __loadsketch: { getState(): { versions: { id: string }[] } } }).__loadsketch.getState().versions.map((v) => v.id));
    const [newer] = await ids();
    await page.evaluate((id) => (window as unknown as { __loadsketch: { getState(): { removeVersion(id: string): void } } }).__loadsketch.getState().removeVersion(id), newer);
    expect(await ids()).toHaveLength(1);
    await runToEnd(page);
    expect(await ids()).toHaveLength(2);
    await openTwo(page);
    await expect(page.getByTestId('compare').getByTestId('compare-chart-p99')).toBeVisible();
    await page.waitForTimeout(300);
    expect((await counts(page)).workers).toBe(0);
  });
});

test.describe('compare on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test('the table and the changes, no charts', async ({ page }) => {
    await threeVersions(page);
    await page.evaluate(() => {
      const st = (window as unknown as { __loadsketch: { getState(): { versions: { id: string; name: string; at: number; design: unknown; scenario: unknown; summary: unknown }[]; openCompare(i: unknown[]): void } } }).__loadsketch.getState();
      st.openCompare(st.versions.slice(0, 2).reverse().map((v) => ({ key: v.id, name: v.name, at: v.at, design: v.design, scenario: v.scenario, summary: v.summary })));
    });
    const dlg = page.getByTestId('compare');
    await expect(dlg.getByTestId('compare-table')).toBeVisible();
    await expect(dlg.getByTestId('compare-diff')).toHaveCount(1);
    await expect(dlg.getByTestId('compare-charts')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.waitForTimeout(400); // the dialog's entrance
    await page.screenshot({ path: join(SHOTS, 'compare-phone.png') });
  });
});

test('versions: a browser that stores nothing says so on the versions tab, whatever else it shows', async ({ page }) => {
  // every write of the versions throws, as in a browser that blocks site data
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k: string, v: string) {
      if (k === 'loadsketch-versions') throw new DOMException('blocked', 'SecurityError');
      return set.call(this, k, v);
    };
  });
  await page.goto('/app/?example=three-tier&scenario=steady');
  await expect(page.locator('[data-node]')).toHaveCount(5);
  await page.getByTestId('tab-versions').click();
  await expect(page.getByTestId('versions-memory-only')).toHaveCount(0);
  // the first change is an import with a damaged version: its message and the note both show
  const good = await page.evaluate(() => ({ id: 'v1', at: 1, name: 'ok', pinned: false, design: { schema: 'loadsketch/design@1', name: 'd', nodes: [], edges: [] }, scenario: { schema: 'loadsketch/scenario@1', traffic: { rps: 1 } }, summary: { offered: 1, ok: 1, errorRate: 0, throughputRps: 1, p50: 1, p99: 1, fail: {}, costPerMonth: 0, complexity: 0, bottleneck: null } }));
  const file = JSON.stringify({ schema: 'loadsketch/versions@1', versions: [good, { id: 'bad' }] });
  await page.getByTestId('versions-import-file').setInputFiles({ name: 'v.json', mimeType: 'application/json', buffer: Buffer.from(file) });
  await expect(page.getByTestId('version')).toHaveCount(1);
  await expect(page.getByText('有 1 個版本格式不對')).toBeVisible();
  await expect(page.getByTestId('versions-memory-only')).toBeVisible();
  // and it stays after more changes
  await runToEnd(page);
  await page.getByTestId('tab-versions').click();
  await expect(page.getByTestId('version')).toHaveCount(2);
  await expect(page.getByTestId('versions-memory-only')).toBeVisible();
});

// a share link made before comparison links (the same one as tests/share.test.ts)
const OLD_LINK_BODY = 'dY-xDsIwDER_BXmORApMmfgHRsQQJW5rNU2qJEVCVf4dBwp0YTzf8529gMVEnQe1QDI9jhoUuKBtGjCbfv92zw0I8HpENoOzO0d-qJPANqjrAmTZmRPGxOOBfJXGEfrMegoVkkLeilhRPdEP5LU7GfySh9OLvQlA260FbQzjpiKHNaRwJh-OXkcK_574-Ns3UkZtH6ztHHWm4C-gjpKTo25bMjUqTtzdSFlKeQI';

// the link a share button put on the clipboard
async function catchClipboard(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (s: string) => void ((window as unknown as { __copied: string }).__copied = s) } });
  });
}

test.describe('compare examples', () => {
  test('a paired example compares with its pair in one click; the link opens the same comparison', async ({ page, browser }) => {
    await catchClipboard(page);
    await page.goto('/app/?lang=en');
    await page.getByTestId('open-examples').click();
    await page.getByLabel('Search examples').fill('retry');
    // only the examples in a pair have the button
    await expect(page.getByTestId('example-retry-storm')).toBeVisible();
    await expect(page.getByTestId('pair-compare-adaptive-throttle')).toHaveCount(0);
    await expect(page.getByTestId('pair-compare-retry-storm')).toContainText('Retry budget');
    await page.waitForTimeout(400); // the dialog's entrance
    await page.getByTestId('example-browser').screenshot({ path: join(SHOTS, 'example-pairs.png') });
    await page.getByTestId('pair-compare-retry-budget').click();
    await expect(page.getByTestId('example-browser')).toHaveCount(0);
    const dlg = page.getByTestId('compare');
    await expect(dlg.getByTestId('compare-col')).toHaveCount(2);
    // the problem is the baseline, the fix is B; the clicked example is on the canvas
    await expect(dlg.getByTestId('compare-col').nth(0)).toContainText('A · Retry storm');
    await expect(dlg.getByTestId('compare-col').nth(0).getByTestId('compare-base')).toBeVisible();
    await expect(dlg.getByTestId('compare-col').nth(1)).toContainText('B · Retry budget');
    expect(await page.evaluate(() => (window as unknown as { __loadsketch: Store }).__loadsketch.getState().example)).toBe('retry-budget');
    // the same scenario: no warning; the fix fails less
    await expect(dlg.getByTestId('compare-mixed')).toHaveCount(0);
    await expect(dlg.getByTestId('compare-row-errorRate').locator('[data-tone]')).toHaveAttribute('data-tone', 'better', { timeout: 60_000 });
    await expect(dlg.getByTestId('compare-diff')).toHaveCount(1);
    const changes = await dlg.getByTestId('compare-diff').locator('li').count();
    expect(changes).toBeGreaterThan(0);

    await dlg.getByTestId('compare-share').click();
    await expect(dlg.getByTestId('compare-share')).toContainText('Copied');
    const url = await page.evaluate(() => (window as unknown as { __copied: string }).__copied);
    expect(url).toMatch(/\/app\/#c=1\.[A-Za-z0-9_-]+$/);

    // a new tab opens the comparison: the baseline on the canvas, the same columns and changes
    const other = await browser.newPage();
    await other.goto(url.replace(/^https?:\/\/[^/]+/, '') .replace('/app/#', '/app/?lang=en#'));
    const dlg2 = other.getByTestId('compare');
    await expect(dlg2.getByTestId('compare-col')).toHaveCount(2);
    await expect(dlg2.getByTestId('compare-col').nth(0)).toContainText('A · Retry storm');
    await expect(dlg2.getByTestId('compare-col').nth(0).getByTestId('compare-base')).toBeVisible();
    await expect(dlg2.getByTestId('compare-col').nth(1)).toContainText('B · Retry budget');
    await expect(dlg2.getByTestId('compare-diff').locator('li')).toHaveCount(changes);
    await expect(dlg2.getByTestId('compare-row-errorRate').locator('[data-tone]')).toHaveAttribute('data-tone', 'better', { timeout: 60_000 });
    const docName = await other.evaluate(() => ((window as unknown as { __loadsketch: Store }).__loadsketch.getState().doc as { name: string }).name);
    const baseName = await page.evaluate(() => (window as unknown as { __loadsketch: { getState(): { compare: { design: { name: string } }[] } } }).__loadsketch.getState().compare[0].design.name);
    expect(docName).toBe(baseName);
    await other.close();
  });

  test('the baseline chosen goes first in the link', async ({ page }) => {
    await catchClipboard(page);
    await page.goto('/app/?lang=en');
    await page.getByTestId('open-examples').click();
    await page.getByLabel('Search examples').fill('cache-stampede');
    await page.getByTestId('pair-compare-cache-stampede').click();
    const dlg = page.getByTestId('compare');
    await dlg.getByTestId('compare-set-base').click();
    await dlg.getByTestId('compare-share').click();
    await expect(dlg.getByTestId('compare-share')).toContainText('Copied');
    const url = await page.evaluate(() => (window as unknown as { __copied: string }).__copied);
    await page.goto('/app/?lang=en');
    await page.goto(url.replace(/^https?:\/\/[^/]+/, '').replace('/app/#', '/app/?lang=en#'));
    const cols = page.getByTestId('compare').getByTestId('compare-col');
    await expect(cols).toHaveCount(2);
    await expect(cols.nth(0).getByTestId('compare-base')).toBeVisible();
    await expect(cols.nth(0)).toContainText('lease');
  });

  test('an old share link still opens one design, with no comparison', async ({ page }) => {
    await page.goto('/app/?lang=en#s=1.' + OLD_LINK_BODY);
    await expect(page.locator('[data-node]')).toHaveCount(2);
    await expect(page.getByTestId('compare')).toHaveCount(0);
  });
});

test('compare: a chart made big over the compare view closes alone; the app stays inert until both close', async ({ page }) => {
  await page.goto('/app/?lang=en');
  await page.getByTestId('open-examples').click();
  await page.getByLabel('Search examples').fill('gray-failure');
  await page.getByTestId('pair-compare-gray-failure').click();
  const dlg = page.getByTestId('compare');
  await expect(dlg.getByTestId('compare-col')).toHaveCount(2);
  const inert = () => page.evaluate(() => !!document.getElementById('root')!.inert);
  expect(await inert()).toBe(true);

  // Esc closes the big chart only
  await dlg.getByTestId('compare-chart-p99-expand').click();
  await expect(page.getByTestId('compare-chart-p99-big')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('compare-chart-p99-big')).toHaveCount(0);
  await expect(dlg).toBeVisible();
  expect(await inert()).toBe(true);

  // the close button: the same
  await dlg.getByTestId('compare-chart-fail-expand').click();
  await expect(page.getByTestId('compare-chart-fail-big')).toBeVisible();
  await page.getByTestId('compare-chart-fail-big').getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('compare-chart-fail-big')).toHaveCount(0);
  await expect(dlg).toBeVisible();
  expect(await inert()).toBe(true);

  // then Esc closes the compare view, and the app works again
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  expect(await inert()).toBe(false);
});

test.describe('compare examples: links and the clipboard', () => {
  test('another comparison link in the same tab starts afresh: its own baseline and runs', async ({ page }) => {
    await catchClipboard(page);
    await page.goto('/app/?lang=en');
    // two links: the retry pair and the cache pair
    const linkOf = async (search: string, card: string) => {
      await page.getByTestId('open-examples').click();
      await page.getByLabel('Search examples').fill(search);
      await page.getByTestId(card).click();
      const dlg = page.getByTestId('compare');
      await dlg.getByTestId('compare-share').click();
      await expect(dlg.getByTestId('compare-share')).toContainText('Copied');
      const url = await page.evaluate(() => (window as unknown as { __copied: string }).__copied);
      await page.keyboard.press('Escape');
      await expect(dlg).toHaveCount(0);
      return url.slice(url.indexOf('#'));
    };
    const retry = await linkOf('retry', 'pair-compare-retry-storm');
    const cache = await linkOf('cache-stampede', 'pair-compare-cache-stampede');

    await page.evaluate((h) => (location.hash = h), retry);
    const dlg = page.getByTestId('compare');
    await expect(dlg.getByTestId('compare-col').nth(1)).toContainText('Retry budget');
    await expect(dlg.getByTestId('compare-row-errorRate').locator('[data-tone]')).toHaveCount(1, { timeout: 60_000 });
    // B as the baseline in this one
    await dlg.getByTestId('compare-set-base').click();
    await expect(dlg.getByTestId('compare-col').nth(1).getByTestId('compare-base')).toBeVisible();

    // the next link, in the same tab: A is its baseline, and no number of the last one is shown
    await page.evaluate((h) => (location.hash = h), cache);
    await expect(dlg.getByTestId('compare-col').nth(1)).toContainText('lease');
    await expect(dlg.getByTestId('compare-col').nth(0).getByTestId('compare-base')).toBeVisible();
    await expect(dlg.getByTestId('compare-col').nth(1).getByTestId('compare-base')).toHaveCount(0);
    await expect(dlg.getByTestId('compare-row-errorRate').locator('td').nth(1)).toContainText('…');
  });

  test('a clipboard that refuses: no "Copied"; the link shows in the dialog to copy by hand', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new DOMException('denied', 'NotAllowedError'); } } });
    });
    await page.goto('/app/?lang=en');
    await page.getByTestId('open-examples').click();
    await page.getByLabel('Search examples').fill('retry');
    await page.getByTestId('pair-compare-retry-storm').click();
    const dlg = page.getByTestId('compare');
    await dlg.getByTestId('compare-share').click();
    await expect(dlg.getByTestId('compare-share-note')).toContainText('Cannot write to the clipboard');
    await expect(dlg.getByTestId('compare-share-link')).toHaveValue(/#c=1\.[A-Za-z0-9_-]+$/);
    await expect(dlg.getByTestId('compare-share-link')).toBeFocused();
    await expect(dlg.getByTestId('compare-share')).not.toContainText('Copied');
    await page.waitForTimeout(2100);
    await expect(dlg.getByTestId('compare-share')).not.toContainText('Copied');
  });
});

test('a cache connected straight to a database: the edge says it is read-through / write-through', async ({ page }) => {
  await page.goto('/app/?example=three-tier');
  await expect(page.locator('[data-node]')).toHaveCount(5);
  const id = await page.evaluate(() => {
    const st = (window as unknown as { __loadsketch: { getState(): { onConnect(c: { source: string; target: string }): void; edges: { id: string; source: string; target: string }[] } } }).__loadsketch;
    st.getState().onConnect({ source: 'cache', target: 'db' });
    return st.getState().edges.find((e) => e.source === 'cache' && e.target === 'db')!.id;
  });
  await page.evaluate((id) => (window as unknown as { __loadsketch: { setState(s: unknown): void } }).__loadsketch.setState({ selected: { type: 'edge', id } }), id);
  await expect(page.getByTestId('edge-through-note')).toContainText('read-through／write-through');
  // another edge does not say it
  await page.evaluate(() => {
    const st = (window as unknown as { __loadsketch: { getState(): { edges: { id: string; source: string; target: string }[] }; setState(s: unknown): void } }).__loadsketch;
    st.setState({ selected: { type: 'edge', id: st.getState().edges.find((e) => e.source === 'api' && e.target === 'db')!.id } });
  });
  await expect(page.getByTestId('edge-through-note')).toHaveCount(0);
});

test('read-through: a cache wired to a database says so on the canvas line, with the full text on hover and a hint once', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/app/?example=three-tier');
  await expect(page.locator('[data-node]')).toHaveCount(5);
  // no cache-to-database line yet: no label, no hint
  await expect(page.getByTestId('edge-through-label')).toHaveCount(0);
  await expect(page.getByTestId('edge-through-hint')).toHaveCount(0);
  type S = { onConnect(c: { source: string; target: string }): void; edges: { id: string; source: string; target: string }[]; selected: { type: string; id: string } | null };
  const st = <T,>(fn: (s: S) => T) => page.evaluate(`(${fn.toString()})(window.__loadsketch.getState())`) as Promise<T>;
  await st((s) => s.onConnect({ source: 'cache', target: 'db' }));
  const label = page.getByTestId('edge-through-label');
  await expect(label).toHaveCount(1);
  await expect(label).toContainText('read-through');
  await expect(label).toHaveAttribute('title', /讀取沒命中時，由快取自己去資料庫讀/);
  // the hint shows when the line is connected, and closes
  const hint = page.getByTestId('edge-through-hint');
  await expect(hint).toBeVisible();
  await expect(hint).toContainText('read-through');
  await page.screenshot({ path: join(SHOTS, 'edge-read-through.png') });
  await hint.getByTestId('edge-through-hint-close').click();
  await expect(hint).toHaveCount(0);
  // a click on the label opens the line in the inspector, where the paragraph stays
  await label.click();
  const id = await st((s) => s.edges.find((e) => e.source === 'cache' && e.target === 'db')!.id);
  expect(await st((s) => s.selected)).toEqual({ type: 'edge', id });
  await expect(page.getByTestId('edge-through-note')).toContainText('read-through／write-through');
  // a design that already has the line shows the label, but not the hint
  const design = await page.evaluate(() => (window as unknown as { __loadsketch: { getState(): { design(): unknown } } }).__loadsketch.getState().design());
  await page.evaluate((d) => (window as unknown as { __loadsketch: { getState(): { load(d: unknown): void } } }).__loadsketch.getState().load(d), design);
  await expect(page.getByTestId('edge-through-label')).toHaveCount(1);
  await expect(page.getByTestId('edge-through-hint')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('checkout brief: the brief gives two APIs, and only checkout goes to the payment provider', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/app/');
  type S = { doc: { apis?: { name: string; op: string; share?: number }[] }; edges: { id: string; target: string; data: { edge: { apis?: string[] } } }[]; setState?: never };
  const st = <T,>(fn: (s: S) => T) => page.evaluate(`(${fn.toString()})(window.__loadsketch.getState())`) as Promise<T>;
  await page.getByTestId('open-practice').click();
  await page.getByTestId('brief-start-brief-checkout').click();
  const box = page.getByTestId('problem-brief-checkout');
  await expect(box.getByTestId('brief-text')).toContainText('只有結帳這支 API 會呼叫外部的金流供應商');
  await expect(box.getByTestId('brief-text')).not.toContainText('模型只分讀取和寫入');
  expect(await st((s) => s.doc.apis)).toEqual([
    { name: 'browse', op: 'read', share: 0.8 },
    { name: 'checkout', op: 'write', share: 0.2 },
  ]);
  // the reference: the line to the provider carries checkout only
  await box.getByTestId('brief-reference').click();
  expect(await st((s) => s.edges.find((e) => e.target === 'pay')!.data.edge.apis)).toEqual(['checkout']);
  const payEdge = await st((s) => s.edges.find((e) => e.target === 'pay')!.id);
  await page.evaluate((id) => (window as unknown as { __loadsketch: { setState(s: unknown): void } }).__loadsketch.setState({ selected: { type: 'edge', id } }), payEdge);
  const chips = page.getByTestId('edge-apis');
  await expect(chips.getByRole('button', { name: 'checkout' })).toHaveAttribute('aria-pressed', 'true');
  await expect(chips.getByRole('button', { name: 'browse' })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('edge-apis-label')).toContainText('checkout');
  await page.getByRole('button', { name: /^(執行|再跑一次)$/ }).click();
  await page.getByRole('button', { name: '跳到結尾' }).click();
  await expect(page.getByTestId('run')).toBeVisible({ timeout: 90_000 });
  await expect(box.getByTestId('problem-score')).toHaveText('參考設計過關（不計分）');
  expect(errors).toEqual([]);
});

test.describe('paste design', () => {
  test('JSON with slips is explained in plain words; a good design shows its changes and replaces the canvas only on a click', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await catchClipboard(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/app/?example=three-tier');
    await expect(page.locator('[data-node]')).toHaveCount(5);
    type S = { design(): { name: string; nodes: { id: string; params?: Record<string, unknown> }[] }; exportText(): string };
    const st = <T,>(fn: (s: S) => T) => page.evaluate(`(${fn.toString()})(window.__loadsketch.getState())`) as Promise<T>;
    const before = await st((s) => s.exportText());

    await page.getByTestId('file-menu').click();
    await page.getByTestId('paste-design-open').click();
    const dlg = page.getByTestId('paste-design');
    const box = dlg.getByTestId('paste-design-text');
    await expect(box).toBeFocused();
    const apply = dlg.getByTestId('paste-design-apply');
    await expect(apply).toBeDisabled();

    // copy the current design (to give to an AI)
    await dlg.getByTestId('paste-design-copy').click();
    await expect(dlg.getByTestId('paste-design-copy')).toContainText('已複製');
    expect(await page.evaluate(() => (window as unknown as { __copied: string }).__copied)).toBe(before);

    // a JSON slip: where it is, and the usual cause
    await box.fill('{\n  "name": "x",\n}');
    await expect(dlg.getByTestId('paste-design-problems')).toContainText('第 3 行第 1 個字附近有問題');
    await expect(dlg.getByTestId('paste-design-problems')).toContainText('多了逗號');
    await expect(apply).toBeDisabled();

    // format slips: the component by its id, the field, what is there and what is expected
    const d = JSON.parse(before);
    d.nodes.find((n: { id: string }) => n.id === 'api').params.instances = '6';
    d.nodes.find((n: { id: string }) => n.id === 'lb').kind = 'loadbalancer';
    await box.fill(JSON.stringify(d, null, 2));
    const problems = dlg.getByTestId('paste-design-problems');
    await expect(problems).toContainText('元件「api」（第 3 個）的設定「instances」要是數字，現在是文字 "6"。');
    await expect(problems).toContainText('是不是 "load_balancer"？');
    await expect(apply).toBeDisabled();
    await page.waitForTimeout(300); // the dialog's entrance
    await dlg.screenshot({ path: join(SHOTS, 'paste-design-problems.png') });

    // fixed, as an AI answers it (in a code fence): the changes against the canvas
    d.nodes.find((n: { id: string }) => n.id === 'api').params.instances = 6;
    d.nodes.find((n: { id: string }) => n.id === 'lb').kind = 'load_balancer';
    d.nodes.push({ id: 'audit', kind: 'queue', pos: [900, 500] });
    d.name = 'AI 改過的三層式網站';
    await box.fill('```json\n' + JSON.stringify(d, null, 2) + '\n```');
    const diff = dlg.getByTestId('paste-design-diff');
    await expect(diff).toContainText('「AI 改過的三層式網站」和畫布有 2 處不同');
    await expect(diff).toContainText('新增元件「Queue」');
    await expect(diff).toContainText('3 → 6');
    // a lone queue is allowed, with a warning
    await expect(dlg.getByTestId('paste-design-warnings')).toContainText('audit');
    await dlg.screenshot({ path: join(SHOTS, 'paste-design-diff.png') });
    // nothing changes before the click
    expect(await st((s) => s.exportText())).toBe(before);
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect(dlg).toHaveCount(0);
    expect(await st((s) => s.design().name)).toBe('AI 改過的三層式網站');
    expect(await st((s) => s.design().nodes.find((n) => n.id === 'api')!.params!.instances)).toBe(6);
    await expect(page.locator('[data-node]')).toHaveCount(6);

    // Escape closes without a change
    await page.getByTestId('file-menu').click();
    await page.getByTestId('paste-design-open').click();
    await dlg.getByTestId('paste-design-text').fill(before);
    await expect(dlg.getByTestId('paste-design-diff')).toContainText('2 處不同');
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    expect(await st((s) => s.design().name)).toBe('AI 改過的三層式網站');
    expect(errors).toEqual([]);
  });

  test('ai guide: the prompt for an AI holds the format guide and the current design; the guide is served at /llms-full.txt, its index at /llms.txt', async ({ page }) => {
    await catchClipboard(page);
    await page.goto('/app/?example=three-tier');
    await expect(page.locator('[data-node]')).toHaveCount(5);
    await page.getByTestId('file-menu').click();
    await page.getByTestId('paste-design-open').click();
    const dlg = page.getByTestId('paste-design');
    await dlg.getByTestId('paste-design-prompt').click();
    await expect(dlg.getByTestId('paste-design-prompt')).toContainText('已複製');
    const prompt = await page.evaluate(() => (window as unknown as { __copied: string }).__copied);
    expect(prompt).toContain('# loadsketch design format');
    expect(prompt).toContain('/llms-full.txt');
    const design = await page.evaluate(() => (window as unknown as { __loadsketch: { getState(): { design(): unknown } } }).__loadsketch.getState().design());
    const blocks = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]);
    expect(JSON.parse(blocks.at(-1)!)).toEqual(design);
    // the link is the same guide, served by the site
    const href = await dlg.getByTestId('paste-design-guide').getAttribute('href');
    expect(new URL(href!).pathname).toBe('/llms-full.txt');
    const res = await page.request.get(href!);
    expect(res.status()).toBe(200);
    expect(prompt).toContain(await res.text());
    // /llms.txt is a short index that links to the full guide
    const index = await page.request.get(new URL('/llms.txt', href!).href);
    expect(index.status()).toBe(200);
    const indexText = await index.text();
    expect(indexText.startsWith('# loadsketch\n\n> ')).toBe(true);
    expect(indexText).toContain('/llms-full.txt)');
    expect(indexText.length).toBeLessThan(4000);
    await page.waitForTimeout(300); // the dialog's entrance
    await dlg.screenshot({ path: join(SHOTS, 'paste-design-ai.png') });
  });

  test('skill: a zip with SKILL.md and reference.md downloads next to the prompt, with a line on where to unpack it; each file has its own address', async ({ page }) => {
    await page.goto('/app/?example=three-tier');
    await expect(page.locator('[data-node]')).toHaveCount(5);
    await page.getByTestId('file-menu').click();
    await page.getByTestId('paste-design-open').click();
    const dlg = page.getByTestId('paste-design');
    const link = dlg.getByTestId('paste-design-skill');
    await expect(link).toContainText('下載 skill（zip）');
    await expect(dlg.getByTestId('paste-design-step1')).toContainText('複製給 AI 的提示');
    await expect(dlg.getByTestId('paste-design-skill-hint')).toContainText('~/.claude/skills/');
    await expect(dlg.getByTestId('paste-design-skill-hint')).toContainText('loadsketch');
    const href = await link.getAttribute('href');
    expect(new URL(href!).pathname).toBe('/skills/loadsketch.zip');
    expect(await link.getAttribute('download')).toBe('loadsketch.zip');
    // the two files, each at its own address
    const get = async (path: string) => {
      const res = await page.request.get(new URL(path, href!).href);
      expect(res.status(), path).toBe(200);
      return res.text();
    };
    const skill = await get('/skills/loadsketch/SKILL.md');
    const reference = await get('/skills/loadsketch/reference.md');
    expect(skill.startsWith('---\nname: loadsketch\ndescription: ')).toBe(true);
    expect(skill.split('\n').length).toBeLessThanOrEqual(150);
    expect(skill).toContain('reference.md');
    expect(reference).toContain('## `cache` — ');
    // the full guide holds every section of reference.md
    const full = await get('/llms-full.txt');
    const sections = reference.slice(reference.indexOf('\n## `') + 1);
    expect(full).toContain(`#${sections.replaceAll('\n## `', '\n### `').trimEnd()}`);
    // a click saves the zip: loadsketch/SKILL.md and loadsketch/reference.md, the same as served
    const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
    expect(download.suggestedFilename()).toBe('loadsketch.zip');
    const entries = readStoredZip(readFileSync((await download.path())!));
    expect([...entries.keys()]).toEqual(['loadsketch/SKILL.md', 'loadsketch/reference.md']);
    expect(entries.get('loadsketch/SKILL.md')!.toString('utf8')).toBe(skill);
    expect(entries.get('loadsketch/reference.md')!.toString('utf8')).toBe(reference);
    await expect(dlg).toBeVisible();
  });

  test('unsaved changes are named before replacing; a copy the clipboard refuses says so', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('denied'); } } });
    });
    await page.goto('/app/?example=three-tier&lang=en');
    await expect(page.locator('[data-node]')).toHaveCount(5);
    type S = { updateNode(id: string, p: { params: Record<string, unknown> }): void; exportText(): string };
    const text = await page.evaluate(() => (window as unknown as { __loadsketch: { getState(): S } }).__loadsketch.getState().exportText());
    await page.evaluate(() => (window as unknown as { __loadsketch: { getState(): S } }).__loadsketch.getState().updateNode('api', { params: { instances: 4 } }));
    await page.getByTestId('file-menu').click();
    await page.getByTestId('paste-design-open').click();
    const dlg = page.getByTestId('paste-design');
    await dlg.getByTestId('paste-design-copy').click();
    await expect(dlg.getByTestId('paste-design-copy-failed')).toContainText('Cannot write to the clipboard');
    await expect(dlg.getByTestId('paste-design-copy')).not.toContainText('Copied');
    await dlg.getByTestId('paste-design-text').fill(text);
    await expect(dlg.getByTestId('paste-design-diff')).toContainText('differs from the canvas in 1 places');
    await expect(dlg.getByTestId('paste-design-unsaved')).toContainText('not saved');
  });

  test('sources from the Terraform import: an answer that left them out gets them back, and the dialog says so (M5 review P2)', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/app/?example=three-tier');
    await expect(page.locator('[data-node]')).toHaveCount(5);
    const imported = importTerraform(JSON.parse(readFileSync(join(import.meta.dirname, '..', 'tests/import/fixtures/ecs-rds.plan.json'), 'utf8'))).design;
    type S = { load(d: unknown): void; design(): { nodes: { id: string; source?: { params?: Record<string, { evidence: string }> } }[]; edges: { source?: unknown }[] } };
    await page.evaluate((d) => (window as unknown as { __loadsketch: { getState(): S } }).__loadsketch.getState().load(d), imported);
    await expect(page.locator('[data-node]')).toHaveCount(imported.nodes.length);
    const sourced = imported.nodes.filter((n) => n.source).length + imported.edges.filter((e) => e.source).length;
    // the model's answer: every source gone, one imported value changed (ECS desired_count 3 → 9)
    const answer = JSON.parse(JSON.stringify(imported, (k, v) => (k === 'source' ? undefined : v)));
    answer.nodes.find((n: { id: string }) => n.id === 'ecs_service_api').params.instances = 9;

    await page.getByTestId('file-menu').click();
    await page.getByTestId('paste-design-open').click();
    const dlg = page.getByTestId('paste-design');
    await dlg.getByTestId('paste-design-text').fill(JSON.stringify(answer, null, 2));
    const note = dlg.getByTestId('paste-design-sources');
    await expect(note).toContainText(`貼上的 JSON 少了 ${sourced} 個元件或線的匯入來源`);
    await expect(note).toContainText('已經從畫布補回');
    await expect(note).toContainText('有 1 個匯入的值改過了：來源改標成「使用者填」');
    await dlg.getByTestId('paste-design-apply').click();
    await expect(dlg).toHaveCount(0);
    const after = await page.evaluate(() => {
      const d = (window as unknown as { __loadsketch: { getState(): S } }).__loadsketch.getState().design();
      const api = d.nodes.find((n) => n.id === 'ecs_service_api')!;
      return { nodes: d.nodes.filter((n) => n.source).length, edges: d.edges.filter((e) => e.source).length, instances: api.source?.params?.instances?.evidence, max: api.source?.params?.maxInstances?.evidence };
    });
    expect(after.nodes + after.edges).toBe(sourced);
    // the changed value is the user's now; the others still come from Terraform
    expect(after.instances).toBe('answer');
    expect(after.max).toBe('iac');
    expect(errors).toEqual([]);
  });
});

test('custom service: in the palette, with the icon its user picks; not offered in a practice problem (M7)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/app/?example=custom-search');
  await expect(page.locator('[data-node]')).toHaveCount(5);
  // the example's search is a custom service: its card shows the search icon, not the default box
  const card = page.locator('[data-node="search"]');
  await expect(card).toContainText('搜尋（Elasticsearch）');
  await expect(card.locator('svg.lucide-search').first()).toBeVisible();
  // a new one from the palette: the box icon, then the icon picked in the inspector
  await expect(page.locator('.sd-pal[data-kind="custom"]')).toContainText('自訂服務');
  await page.locator('.sd-pal[data-kind="custom"]').click();
  await expect(page.locator('[data-node]')).toHaveCount(6);
  type S = { nodes: { id: string; data: { node: { kind: string; params?: Record<string, unknown> } } }[]; updateNode(id: string, p: { params: Record<string, unknown> }): void };
  const id = await page.evaluate(() => (window as unknown as { __loadsketch: { getState(): S } }).__loadsketch.getState().nodes.find((n) => n.data.node.kind === 'custom' && n.id !== 'search')!.id);
  await expect(page.locator(`[data-node="${id}"] svg.lucide-box`).first()).toBeVisible();
  await page.evaluate((nid) => (window as unknown as { __loadsketch: { getState(): S } }).__loadsketch.getState().updateNode(nid, { params: { icon: 'Bot' } }), id);
  await expect(page.locator(`[data-node="${id}"] svg.lucide-bot`).first()).toBeVisible();
  await page.screenshot({ path: join(SHOTS, 'custom-service.png') });
  // a practice problem: not in the palette
  await page.getByTestId('open-practice').click();
  await page.getByTestId('brief-start-brief-notify').click();
  await expect(page.getByTestId('problem-brief-notify')).toBeVisible();
  await expect(page.locator('.sd-pal[data-kind="service"]')).toHaveCount(1);
  await expect(page.locator('.sd-pal[data-kind="custom"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('presets: save a component with its settings, add it from the palette by click or drag, kept after a reload, exported and imported (M8)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/app/?example=three-tier');
  await page.evaluate(() => localStorage.removeItem('loadsketch-presets'));
  await page.reload();
  await expect(page.locator('[data-node]')).toHaveCount(5);
  await expect(page.getByTestId('presets')).toContainText('存成樣板');
  await expect(page.getByTestId('presets-export')).toBeDisabled();
  type N = { id: string; data: { node: { kind: string; label?: string; params?: Record<string, unknown> } } };
  type S = { nodes: N[]; updateNode(id: string, p: { params: Record<string, unknown> }): void };
  const state = () => page.evaluate(() => (window as unknown as { __loadsketch: { getState(): S } }).__loadsketch.getState().nodes.map((n) => ({ id: n.id, ...n.data.node })));
  await page.evaluate(() => (window as unknown as { __loadsketch: { getState(): S } }).__loadsketch.getState().updateNode('api', { params: { instances: 7, serviceMs: { mean: 200, cv: 0.5 } } }));
  // save from the inspector: the name starts as the component's name
  await page.locator('[data-node="api"]').click();
  await page.getByTestId('preset-save').click();
  await expect(page.getByTestId('preset-name')).toHaveValue('API 伺服器');
  await page.getByTestId('preset-name').fill('金流商 200 ms');
  await page.getByTestId('preset-save-confirm').click();
  await expect(page.getByTestId('preset-saved')).toContainText('金流商 200 ms');
  const item = page.getByTestId('preset-item');
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('金流商 200 ms');
  // a click adds a component with the preset's name and settings
  await item.click();
  await expect(page.locator('[data-node]')).toHaveCount(6);
  const added = (await state()).filter((n) => n.label === '金流商 200 ms');
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ kind: 'service', params: { instances: 7, serviceMs: { mean: 200, cv: 0.5 } } });
  expect(added[0].id).not.toBe('api');
  // a drag onto the canvas does too, where it is dropped
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await item.dispatchEvent('dragstart', { dataTransfer: dt });
  const box = (await page.locator('.react-flow').boundingBox())!;
  await page.locator('.react-flow__pane').dispatchEvent('drop', { dataTransfer: dt, clientX: box.x + 200, clientY: box.y + box.height - 150 });
  await expect(page.locator('[data-node]')).toHaveCount(7);
  expect((await state()).filter((n) => n.label === '金流商 200 ms')).toHaveLength(2);
  await page.screenshot({ path: join(SHOTS, 'presets.png') });
  // kept in this browser
  await page.reload();
  await expect(page.getByTestId('preset-item')).toContainText('金流商 200 ms');
  // export, delete, import back
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('presets-export').click()]);
  const path = join(SHOTS, 'presets.json');
  await dl.saveAs(path);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  expect(saved.schema).toBe('loadsketch/presets@1');
  expect(saved.presets).toEqual([expect.objectContaining({ name: '金流商 200 ms', kind: 'service' })]);
  await page.getByTestId('preset-remove').click();
  await expect(page.getByTestId('preset-item')).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('loadsketch-presets') ?? '{}').presets)).toEqual([]);
  await page.getByTestId('presets-import-file').setInputFiles(path);
  await expect(page.getByTestId('preset-item')).toContainText('金流商 200 ms');
  // importing the same file again adds nothing
  await page.getByTestId('presets-import-file').setInputFiles(path);
  await expect(page.getByTestId('preset-item')).toHaveCount(1);
  // a file that is not a preset file is refused
  await page.getByTestId('presets-import-file').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"schema":"x"}') });
  await expect(page.locator('.sd-run-error')).toContainText('不是 loadsketch 匯出的樣板檔');
  await page.getByTestId('presets').screenshot({ path: join(SHOTS, 'presets-palette.png') });
  expect(errors).toEqual([]);
});

test('presets: two tabs open at once keep each other\'s presets, and one tab shows what the other saved (M8 review P2)', async ({ context }) => {
  const a = await context.newPage();
  await a.setViewportSize({ width: 1440, height: 1000 });
  await a.goto('/app/?example=three-tier');
  await a.evaluate(() => localStorage.removeItem('loadsketch-presets'));
  const b = await context.newPage();
  await b.setViewportSize({ width: 1440, height: 1000 });
  await b.goto('/app/?example=three-tier');
  await a.reload();
  for (const [page, node, name] of [[a, 'api', 'API'], [b, 'cache', 'Redis']] as const) {
    await page.locator(`[data-node="${node}"]`).click();
    await page.getByTestId('preset-save').click();
    await page.getByTestId('preset-name').fill(name);
    await page.getByTestId('preset-save-confirm').click();
  }
  const names = (p: typeof a) => p.evaluate(() => (JSON.parse(localStorage.getItem('loadsketch-presets') ?? '{}').presets ?? []).map((x: { name: string }) => x.name));
  expect(await names(b)).toEqual(['API', 'Redis']);
  // the first tab shows the preset the second one saved
  await expect(a.getByTestId('preset-item')).toHaveText(['API', 'Redis']);
  await expect(b.getByTestId('preset-item')).toHaveText(['API', 'Redis']);
});

test.describe('phone layout: presets', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('presets: a preset tapped in the palette drawer adds the component and closes the drawer (M8 review P2)', async ({ page }) => {
    await page.goto('/app/?example=three-tier');
    await page.evaluate(() => localStorage.setItem('loadsketch-presets', JSON.stringify({ schema: 'loadsketch/presets@1', presets: [{ id: 'p1', name: '金流商', kind: 'service', params: { instances: 3 } }] })));
    await page.reload();
    await expect(page.locator('[data-node]')).toHaveCount(5);
    const drawer = page.getByTestId('phone-drawer');
    await page.getByTestId('phone-tab-palette').tap();
    await expect(drawer).toHaveAttribute('data-open');
    await drawer.getByTestId('preset-item').tap();
    await expect(page.locator('[data-node]')).toHaveCount(6);
    await expect(drawer).not.toHaveAttribute('data-open');
    // the remove button leaves the drawer open
    await page.getByTestId('phone-tab-palette').tap();
    await expect(drawer).toHaveAttribute('data-open');
    await drawer.getByTestId('preset-remove').tap();
    await expect(drawer.getByTestId('preset-item')).toHaveCount(0);
    await expect(drawer).toHaveAttribute('data-open');
  });
});
