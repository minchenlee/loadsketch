// The pages of a lesson on the course page: one per step of the lesson (stepsOf() in
// src/learn/lesson.ts), then a last page to finish. Each page has the run it works with: the
// example and scenario the simulator on the right shows. Pure: no React, no DOM.
import { runOf, stepsOf, type Lesson, type Step } from '../learn/lesson.ts';

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
