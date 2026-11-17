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

/** A saved page index that still fits the lesson (its text may have changed since). */
export function clampStep(i: number, pages: Page[]): number {
  return Number.isInteger(i) ? Math.min(Math.max(i, 0), pages.length - 1) : 0;
}
