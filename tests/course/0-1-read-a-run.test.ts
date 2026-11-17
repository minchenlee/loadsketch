// Lesson 0.1 (three-tier / spike). Every expected answer is read from a run of the engine.
import { describe, expect, it } from 'vitest';
import { COURSE_BY_ID } from '../../src/learn/course.ts';
import { lessonRuns, runOf, setParam, SLOW } from './run.ts';

const lesson = COURSE_BY_ID['0.1'];
const { run, passed, question } = lessonRuns(lesson);
const api = (n: number) => setParam('api', 'instances', n);
const wait = (r: ReturnType<typeof run>) => ({ sim: r.result.nodes.api.waitMs!, theory: r.result.nodes.api.theory!.waitMs ?? 0 });

describe('lesson 0.1: questions', () => {
  it('the component that fills first is the one the bottleneck note names, and it is full at its peak', () => {
    const r = run();
    const q = question('first-full');
    expect(q.answer(r)).toBe(r.result.bottleneck!.node);
    expect(r.result.nodes[q.answer(r)].peakUtilization).toBeGreaterThanOrEqual(0.95);
    // every other layer stays well below it
    for (const id of ['cache', 'db']) expect(r.result.nodes[id].peakUtilization!).toBeLessThan(r.result.nodes[q.answer(r)].peakUtilization!);
    expect(q.measured(r)).toMatch(/\d/);
  }, SLOW);

  it('with the spike, the measured wait is far above the theory row; the answer agrees with the numbers', () => {
    const r = run();
    const w = wait(r);
    expect(question('theory-gap').answer(r)).toBe('far');
    expect(w.sim).toBeGreaterThan(10 * w.theory);
  }, SLOW);

  it('with room for the spike, or without the spike, the measured wait is not above the theory', () => {
    const q = question('theory-gap');
    for (const r of [run(api(6)), runOf('three-tier', 'steady')]) {
      expect(['lower', 'close']).toContain(q.answer(r));
      const w = wait(r);
      expect(w.sim).toBeLessThanOrEqual(Math.max(1, 2 * w.theory));
    }
  }, SLOW);
});

describe('lesson 0.1: challenge', () => {
  it('the example as it ships fails; enough API servers pass; more than 5 break the limit', () => {
    expect(passed(run())).toEqual([]);
    expect(run().result.summary.errorRate).toBeGreaterThan(0.01);
    expect(passed(run(api(5)))).toEqual(['read-run/hold-spike']);
    expect(passed(run(api(6)))).toEqual([]);
    expect(run(api(6)).result.summary.errorRate).toBeLessThan(0.01);
  }, SLOW);

  it('one server short still queues during the spike', () => {
    const r = run(api(4));
    expect(passed(r)).toEqual([]);
    expect(r.result.summary.latencyMs.p99).toBeGreaterThanOrEqual(100);
  }, SLOW);
});
