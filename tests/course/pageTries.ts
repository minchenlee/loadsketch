// What a try step's page really runs. The course page keeps one simulator frame while the example
// and scenario stay the same (src/course/steps.ts ctxOf), and a try's patch goes onto the design in
// that frame. So the tries of one frame stack: a later try runs with every earlier try's patch too.
import { runOf as runOfLesson, stepsOf, type Lesson } from '../../src/learn/lesson.ts';
import { applyPatches, type Patch } from '../../src/learn/oncall.ts';
import type { Change } from './run.ts';

export type PageTry = { step: number; text: string; example: string; scenario: string; own: Patch[]; stacked: Patch[] };

export function pageTries(lesson: Lesson): PageTry[] {
  const out: PageTry[] = [];
  let key = '';
  let stacked: Patch[] = [];
  stepsOf(lesson).forEach((s, step) => {
    const first = s.kind === 'guess' ? lesson.questions.find((q) => q.id === s.questions[0]) : s.kind === 'challenge' ? lesson.challenges.find((c) => c.id === s.challenges[0]) : undefined;
    const ctx = s.kind === 'run' || s.kind === 'try' ? runOfLesson(lesson, s) : first ? runOfLesson(lesson, first) : undefined;
    if (!ctx) return;
    const k = ctx.example + '|' + ctx.scenario;
    if (k !== key) {
      key = k;
      stacked = [];
    }
    if (s.kind !== 'try') return;
    stacked = [...stacked, ...(s.patch ?? [])];
    out.push({ step, text: s.text, example: ctx.example, scenario: ctx.scenario, own: s.patch ?? [], stacked });
  });
  return out;
}

/** A Change for tests/course/run.ts that puts these patches on the design. */
export const patched = (patches: Patch[]): Change => ({
  key: 'patch:' + JSON.stringify(patches),
  apply: (d) => {
    const x = applyPatches(d, patches);
    d.nodes = x.nodes;
    d.edges = x.edges;
  },
});
