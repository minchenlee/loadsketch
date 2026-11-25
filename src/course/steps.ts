// The pages of a lesson on the course page: one per step of the lesson (stepsOf() in
// src/learn/lesson.ts), then a last page to finish. Each page has the run it works with: the
// example and scenario the simulator on the right shows. Pure: no React, no DOM.
import { runOf, stepsOf, type Lesson, type Look, type Step } from '../learn/lesson.ts';
import type { Design } from '../schema/design.ts';

export type Page = Step | { kind: 'done' };

export interface Ctx {
  example: string;
  scenario: string;
}

export function pagesOf(lesson: Lesson): Page[] {
  return [...stepsOf(lesson), { kind: 'done' }];
}

export const ctxKey = (c: Ctx) => `${c.example}|${c.scenario}`;

/** The run a page works with: a run or try step's own, the first question or challenge's, else the page before's. */
export function ctxOf(lesson: Lesson, pages: Page[], i: number): Ctx {
  let ctx: Ctx = runOf(lesson, {});
  for (let k = 0; k <= i && k < pages.length; k++) {
    const p = pages[k];
    if (p.kind === 'run' || p.kind === 'try') ctx = runOf(lesson, p);
    else if (p.kind === 'guess') {
      const q = lesson.questions.find((x) => x.id === p.questions[0]);
      if (q) ctx = runOf(lesson, q);
    } else if (p.kind === 'challenge') {
      const c = lesson.challenges.find((x) => x.id === p.challenges[0]);
      if (c) ctx = runOf(lesson, c);
    }
  }
  return ctx;
}

const guessedOn = (lesson: Lesson, pages: Page[], from: number, to: number, ctx: Ctx): string[] =>
  pages
    .slice(Math.max(0, from), Math.max(0, to))
    .flatMap((p) => (p.kind === 'guess' ? p.questions : []))
    .filter((id) => {
      const q = lesson.questions.find((x) => x.id === id);
      return !!q && ctxKey(runOf(lesson, q)) === ctxKey(ctx);
    });

/**
 * The questions a run started on page `i` answers: those guessed on a page before it that read
 * the run's example and scenario. A later guess on the same example (lessons 2.4, 2.5: guess what
 * a change does, then try it) waits for a run on its own page or after. When page `i` is a guess
 * page, its questions that already have a guess count too (`guesses`): the simulator has its own
 * Run button, and a run there before Next answers them; a question with no guess yet stays open.
 */
export function answerable(lesson: Lesson, pages: Page[], i: number, ctx: Ctx, guesses: Record<string, string> = {}): string[] {
  const here = guessedOn(lesson, pages, i, i + 1, ctx).filter((id) => guesses[id] !== undefined);
  return [...new Set([...guessedOn(lesson, pages, 0, i, ctx), ...here])];
}

/** Where the simulator looks: a component to select and centre, a tab of its settings panel. */
export type Focus = { node?: string; tab?: NonNullable<Look['tab']> };

const focusIn = (l: Look | undefined): Focus | null => (l?.node || l?.tab ? { ...(l.node ? { node: l.node } : {}), ...(l.tab ? { tab: l.tab } : {}) } : null);

/** Where a step (or a question, when its answer shows) points when the learner reaches it: its look, without the charts (opensCharts). */
export const lookOf = (p: Page | { look?: Look }): Focus | null => ('kind' in p && p.kind === 'done' ? null : focusIn(p.look));

/**
 * After Make this change: the step's look, else the first node the patch changes (an edge alone:
 * its caller), on its settings.
 */
export function patchFocus(p: Page): Focus | null {
  if (p.kind !== 'try' || !p.patch?.length) return null;
  const changed = p.patch.find((x) => 'node' in x);
  const node = p.look?.node ?? (changed && 'node' in changed ? changed.node : 'edge' in p.patch[0] ? p.patch[0].edge.split('->')[0] : undefined);
  return { ...(node ? { node } : {}), tab: p.look?.tab ?? 'design' };
}

/** The next page's title, for the Next button ("Next: <title>"); none on the last page or without one. */
export function nextTitle(pages: Page[], i: number): string | undefined {
  const n = pages[i + 1];
  return n && n.kind !== 'done' ? n.title : undefined;
}

/**
 * Which lines of the lesson's `learn` are ticked, once the learner has reached page `reached`:
 * each at the step learnAt gives it; without learnAt, all of them at the last page.
 */
export function learnTicks(lesson: Lesson, reached: number): boolean[] {
  const lines = lesson.learn ?? [];
  const last = stepsOf(lesson).length; // the done page
  return lines.map((_, k) => reached >= (lesson.learnAt?.[k] ?? last));
}

/** Problems with a lesson's learn and learnAt (the format test reports them): same length, each a step. */
export function learnProblems(lesson: Lesson): string[] {
  const out: string[] = [];
  const n = stepsOf(lesson).length;
  if (lesson.learnAt && !lesson.learn) out.push('learnAt without learn');
  if (lesson.learn && lesson.learnAt && lesson.learnAt.length !== lesson.learn.length) out.push(`learnAt has ${lesson.learnAt.length} entries, learn has ${lesson.learn.length}`);
  for (const k of lesson.learnAt ?? []) if (!Number.isInteger(k) || k < 0 || k >= n) out.push(`learnAt ${k} is not a step (0 to ${n - 1})`);
  return out;
}

/** The step opens the charts under the canvas when the learner reaches it (look.panel, lesson.ts). */
export const opensCharts = (p: Page): boolean => p.kind !== 'done' && p.look?.panel === 'bottom';

/**
 * A challenge judges a run only when the run started on a challenge page that lists it. A run on
 * an earlier page (a try page often runs the same example and scenario, with the lesson's fix) is
 * not the learner's answer to the challenge.
 */
export function judgedOn(pages: Page[], runPage: number, challenge: string): boolean {
  const p = pages[runPage];
  return !!p && p.kind === 'challenge' && p.challenges.includes(challenge);
}

/** The questions whose answers a run or try page shows: those guessed since the last run or try page. */
export function feedbackOf(lesson: Lesson, pages: Page[], i: number): string[] {
  const p = pages[i];
  if (!p || (p.kind !== 'run' && p.kind !== 'try')) return [];
  let from = i - 1;
  while (from >= 0 && pages[from].kind !== 'run' && pages[from].kind !== 'try') from--;
  return [...new Set(guessedOn(lesson, pages, from + 1, i, ctxOf(lesson, pages, i)))];
}

/** A saved page index that still fits the lesson (its text may have changed since). */
export function clampStep(i: number, pages: Page[]): number {
  return Number.isInteger(i) ? Math.min(Math.max(i, 0), pages.length - 1) : 0;
}

/** The runs of a lesson visit: each page's last run, with the run made just before it (on any page). */
export interface PageRuns<R> {
  last?: R;
  pages: Record<number, { run: R; before?: R }>;
}

/** Records a finished run on the page it started on. */
export const addRun = <R,>(s: PageRuns<R>, page: number, run: R): PageRuns<R> => ({ last: run, pages: { ...s.pages, [page]: { run, before: s.last } } });

/** Whether a run's design matches every patch a try step asks for (so an unpatched run does not count as its baseline). */
export function matchesStepPatch(page: Page, design: Design): boolean {
  if (page.kind !== 'try' || !page.patch?.length) return true;
  for (const p of page.patch) {
    if ('node' in p) {
      const n = design.nodes.find((x) => x.id === p.node);
      if (!n) return false;
      for (const [k, v] of Object.entries(p.params)) {
        if (JSON.stringify(n.params?.[k]) !== JSON.stringify(v)) return false;
      }
    } else {
      const e = design.edges.find((x) => `${x.from}->${x.to}` === p.edge);
      if (!e) return false;
      for (const [k, v] of Object.entries(p.set)) {
        if (JSON.stringify((e as unknown as Record<string, unknown>)[k]) !== JSON.stringify(v)) return false;
      }
    }
  }
  return true;
}
