// Lesson 3.1 (retry-storm): the first lesson of the app, now in the course. Every expected answer
// is read from a run of the engine, never typed in. tests/learn.test.ts keeps its deeper checks.
import { describe, expect, it } from 'vitest';
import { COURSE_BY_ID } from '../../src/learn/course.ts';
import { LESSONS } from '../../src/learn/lessons.ts';
import { recovery } from '../../src/learn/lessonKit2.ts';
import { peakAmp } from '../../src/learn/metrics.ts';
import { lessonRuns, setEdge, SLOW } from './run.ts';

const lesson = COURSE_BY_ID['3.1'];
const { run, passed, question } = lessonRuns(lesson);

describe('retry storm lesson (3.1)', () => {
  it('is the lesson the side panel opens on the retry-storm example', () => {
    expect(LESSONS['retry-storm']).toBe(lesson);
    expect(lesson.unit).toBe(3);
  });

  it('as shipped: the system never recovers, and the API gets more than 10 times its usual traffic', () => {
    const base = run();
    expect(recovery(base)).toBe(Infinity);
    expect(question('recover').answer(base)).toBe('never');
    expect(peakAmp(base, 'api', 20, 30)).toBeGreaterThanOrEqual(9);
    expect(question('amp').answer(base)).toBe('x10');
    expect(passed(base)).toEqual([]);
  }, SLOW);

  it('the "try" step (no retries from the load balancer) recovers right after the spike', () => {
    const r = run(setEdge('lb', 'api', 'retries', 0));
    expect(question('recover').answer(r)).toBe('fast');
    expect(question('amp').answer(r)).toBe('x3');
    expect(passed(r)).toContain('retry-storm/recover');
  }, SLOW);

  it('a retry budget on the load balancer edge keeps the retries and recovers', () => {
    const r = run(setEdge('lb', 'api', 'retryBudget', 0.1));
    expect(recovery(r)).toBeLessThanOrEqual(5);
    expect(passed(r)).toContain('retry-storm/recover');
  }, SLOW);
});
