// The steps of a lesson, one at a time: read, guess each question, run, see the answers, then each
// challenge. Pure: no React, no DOM.
import type { Challenge, Lesson, Question } from '../learn/lesson.ts';

export type Step =
  | { kind: 'intro'; id: 'intro' }
  | { kind: 'guess'; id: string; question: Question }
  | { kind: 'run'; id: 'run' }
  | { kind: 'answers'; id: 'answers' }
  | { kind: 'challenge'; id: string; challenge: Challenge }
  | { kind: 'done'; id: 'done' };

export function stepsOf(lesson: Lesson): Step[] {
  return [
    { kind: 'intro', id: 'intro' },
    ...lesson.questions.map((q): Step => ({ kind: 'guess', id: `guess:${q.id}`, question: q })),
    { kind: 'run', id: 'run' },
    ...(lesson.questions.length ? [{ kind: 'answers', id: 'answers' } as Step] : []),
    ...lesson.challenges.map((c): Step => ({ kind: 'challenge', id: `challenge:${c.id}`, challenge: c })),
    { kind: 'done', id: 'done' },
  ];
}

/** A saved step index that still fits the lesson (its text may have changed since). */
export function clampStep(i: number, steps: Step[]): number {
  return Number.isInteger(i) ? Math.min(Math.max(i, 0), steps.length - 1) : 0;
}
