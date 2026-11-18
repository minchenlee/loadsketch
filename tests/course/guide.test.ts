// Guidance fields of the course lessons (wave 2): what the course page shows around the steps.
// Lessons 0.1–2.5 (feat/course-guide2-a) and 3.1–6.2 (feat/course-guide2-b) are checked apart:
// each part keeps the checks its writer gave it. Without running a simulation.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COURSE, COURSE_BY_ID } from '../../src/learn/course.ts';
import { runOf, stepsOf, type Look } from '../../src/learn/lesson.ts';
import { measureOf } from '../../src/course/measures.ts';
import { design } from './run.ts';

// ---- lessons 0.1–2.5 ----
const IDS = ['0.1', '1.1', '1.2', '1.3', '1.5', '2.1', '2.2', '2.4', '2.5'];
const root = join(import.meta.dirname, '..', '..');
const nodesOf = (example: string) => new Set((JSON.parse(readFileSync(join(root, 'examples', 'designs', `${example}.json`), 'utf8')).nodes as { id: string }[]).map((n) => n.id));

describe.each(IDS)('lesson %s guidance', (id) => {
  const l = COURSE_BY_ID[id];
  const steps = stepsOf(l);

  it('says what it teaches (3 to 5 lines, each ticked at a step) and what to remember (2 to 4 lines)', () => {
    expect(l.learn?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(l.learn!.length).toBeLessThanOrEqual(5);
    expect(l.learnAt?.length).toBe(l.learn!.length);
    for (const k of l.learnAt!) expect(k >= 0 && k < steps.length, `learnAt ${k}`).toBe(true);
    expect([...l.learnAt!]).toEqual([...l.learnAt!].sort((a, b) => a - b));
    expect(l.recap?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(l.recap!.length).toBeLessThanOrEqual(4);
  });

  it('gives every step a title, and the first read step a key idea', () => {
    for (const [k, s] of steps.entries()) expect(s.title, `step ${k} (${s.kind})`).toBeTruthy();
    const first = steps[0];
    expect(first.kind === 'read' && first.key).toBeTruthy();
  });

  it('shows only known measures, and looks only at nodes of the step’s design', () => {
    for (const [k, s] of steps.entries()) {
      if ('show' in s && s.show) for (const m of s.show) expect(measureOf(m), `step ${k}: ${m}`).toBeDefined();
      if (s.look?.node) {
        const ex = s.kind === 'run' || s.kind === 'try' ? runOf(l, s).example : l.example;
        expect(existsSync(join(root, 'examples', 'designs', `${ex}.json`))).toBe(true);
        expect(nodesOf(ex).has(s.look.node), `step ${k}: ${s.look.node}`).toBe(true);
      }
    }
  });

  it('a try step asks before the run, and does not tell its result', () => {
    for (const [k, s] of steps.entries()) if (s.kind === 'try') expect(s.text, `step ${k}`).toMatch(/\?/);
  });
});

// ---- lessons 3.1–6.2 ----
// Guidance of lessons 3.1–6.2 (wave 2 of the course guidance): what the lesson teaches and where
// each line is taught, a recap, a title on every step, and every `look` points at a component of
// the example that the step or question shows.
const MINE = ['3.1', '3.2', '3.3', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'];
const TABS = ['design', 'scenario', 'results', 'versions'];

const lookOk = (look: Look | undefined, example: string) => {
  if (!look) return true;
  if (look.tab && !TABS.includes(look.tab)) return false;
  if (look.panel && look.panel !== 'bottom') return false;
  return !look.node || design(example).nodes.some((n) => n.id === look.node);
};

describe('course guidance, lessons 3.1–6.2', () => {
  for (const l of COURSE.filter((x) => MINE.includes(x.id!))) {
    it(l.id!, () => {
      const steps = l.steps ?? [];
      expect(l.learn?.length, 'learn: 3 to 5 lines').toBeGreaterThanOrEqual(3);
      expect(l.learn!.length).toBeLessThanOrEqual(5);
      expect(l.learnAt, 'learnAt: one step for each line of learn').toHaveLength(l.learn!.length);
      for (const i of l.learnAt!) expect(i >= 0 && i < steps.length && Number.isInteger(i), `step ${i}`).toBe(true);
      expect([...l.learnAt!].sort((a, b) => a - b), 'learn in the order it is taught').toEqual(l.learnAt);
      expect(l.recap?.length, 'recap: 2 to 4 lines').toBeGreaterThanOrEqual(2);
      expect(l.recap!.length).toBeLessThanOrEqual(4);
      steps.forEach((s, i) => {
        expect(s.title, `step ${i} has a title`).toBeTruthy();
        const ex = ('example' in s && s.example) || l.example;
        expect(lookOk(s.look, ex), `step ${i} look`).toBe(true);
      });
      for (const q of l.questions) expect(lookOk(q.look, q.example ?? l.example), `question ${q.id} look`).toBe(true);
    });
  }
});
