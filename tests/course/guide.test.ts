// Guidance of lessons 3.1–6.2 (wave 2 of the course guidance): what the lesson teaches and where
// each line is taught, a recap, a title on every step, and every `look` points at a component of
// the example that the step or question shows.
import { describe, expect, it } from 'vitest';
import { COURSE } from '../../src/learn/course.ts';
import type { Look } from '../../src/learn/lesson.ts';
import { design } from './run.ts';

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
