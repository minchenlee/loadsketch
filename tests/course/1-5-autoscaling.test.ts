// Lesson 1.5 (autoscale / flash-crowd). Every expected answer is read from a run of the engine.
import { describe, expect, it } from 'vitest';
import { COURSE_BY_ID } from '../../src/learn/course.ts';
import { failingFor } from '../../src/learn/course/1-5-autoscaling.ts';
import { lessonRuns, setParam, SLOW } from './run.ts';

const lesson = COURSE_BY_ID['1.5'];
const { run, passed, question } = lessonRuns(lesson);
const err = (r: ReturnType<typeof run>) => r.result.summary.errorRate;

describe('lesson 1.5: questions', () => {
  it('the example fails for minutes, then overshoots', () => {
    const r = run();
    expect(question('failing-for').answer(r)).toBe('minutes');
    expect(failingFor(r)).toBeGreaterThan(60);
    expect(question('overshoot').answer(r)).toBe('over');
    const a = r.result.nodes.api.autoscale!;
    expect(a.endActive).toBeLessThan(a.peakActive);
  }, SLOW);

  it('a longer boot fails longer and more; a short boot fails less but not zero', () => {
    const base = run();
    const slow = run(setParam('api', 'bootS', 300));
    const fast = run(setParam('api', 'bootS', 10));
    expect(failingFor(slow)).toBeGreaterThan(failingFor(base));
    expect(err(slow)).toBeGreaterThan(err(base) * 1.5);
    expect(err(fast)).toBeLessThan(err(base));
    expect(err(fast)).toBeGreaterThan(0.01);
  }, SLOW);
});

describe('lesson 1.5: challenges', () => {
  it('the example passes neither', () => {
    expect(passed(run())).toEqual([]);
  }, SLOW);

  it('a short boot alone is not enough; a short boot and frequent checks pass "faster"', () => {
    expect(passed(run(setParam('api', 'bootS', 10)))).toEqual([]);
    expect(passed(run(setParam('api', 'bootS', 10), setParam('api', 'scaleEveryS', 15)))).toEqual(['autoscale/faster']);
  }, SLOW);

  it('a lower target passes "headroom"', () => {
    expect(passed(run(setParam('api', 'targetUtil', 0.4)))).toEqual(['autoscale/headroom']);
  }, SLOW);
});
