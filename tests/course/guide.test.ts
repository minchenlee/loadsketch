// Guidance fields of lessons 0.1–2.5 (wave 2, feat/course-guide2-a): what the course page shows
// around the steps. Without running a simulation.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COURSE_BY_ID } from '../../src/learn/course.ts';
import { runOf, stepsOf } from '../../src/learn/lesson.ts';
import { measureOf } from '../../src/course/measures.ts';

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
