// Lesson 1.1 (single-server / steady). Every expected answer is read from a run of the engine.
import { describe, expect, it } from 'vitest';
import { COURSE_BY_ID } from '../../src/learn/course.ts';
import { lessonRuns, setParam, SLOW } from './run.ts';

const lesson = COURSE_BY_ID['1.1'];
const { run, passed, question } = lessonRuns(lesson);
const service = (mean: number, cv = 1) => setParam('api', 'serviceMs', { mean, cv });
const api = (r: ReturnType<typeof run>) => r.result.nodes.api;

describe('lesson 1.1: questions', () => {
  it('the example runs at about half busy, and the theory row agrees with the measured wait', () => {
    const r = run();
    expect(api(r).utilization).toBeGreaterThan(0.45);
    expect(api(r).utilization).toBeLessThan(0.55);
    expect(Math.abs(api(r).waitMs! - api(r).theory!.waitMs!)).toBeLessThan(0.1);
  }, SLOW);

  it('the answers follow the measured wait and Little\'s law', () => {
    const r = run();
    const n = api(r);
    const share = n.waitMs! / n.holdMs!;
    expect(question('wait-share').answer(r)).toBe(share < 0.03 ? 'none' : share < 0.3 ? 'some' : share <= 1 ? 'same' : 'more');
    expect(question('wait-share').answer(r)).toBe('some');
    // Little's law: rps × time inside ≈ average busy slots + queue (utilisation × 4 + average queue)
    const L = (n.rps * (n.waitMs! + n.holdMs!)) / 1000;
    expect(Math.abs(L - (n.utilization! * 4 + n.avgQueue!))).toBeLessThan(0.15);
    expect(question('inside').answer(r)).toBe('two');
  }, SLOW);

  it('at 90% busy the wait is longer than the work and p99 grows several times; the theory still matches', () => {
    const base = run();
    const r = run(service(4.5));
    expect(api(r).utilization).toBeGreaterThan(0.85);
    expect(question('wait-share').answer(r)).toBe('more');
    expect(r.result.summary.latencyMs.p99 / base.result.summary.latencyMs.p99).toBeGreaterThan(3);
    expect(Math.abs(api(r).waitMs! / api(r).theory!.waitMs! - 1)).toBeLessThan(0.15);
    // a wider spread at the same mean waits longer
    expect(api(run(service(4.5, 2))).waitMs!).toBeGreaterThan(2.5 * api(r).waitMs!);
  }, SLOW);
});

describe('lesson 1.1: challenges', () => {
  it('the example passes neither', () => {
    expect(passed(run())).toEqual([]);
  }, SLOW);

  it('a slower release needs more slots on the one server; a second server breaks "one server"', () => {
    expect(passed(run(service(4.5)))).toEqual([]);
    expect(passed(run(service(4.5), setParam('api', 'concurrency', 8)))).toContain('littles/slower-release');
    expect(passed(run(service(4.5), setParam('api', 'instances', 2)))).not.toContain('littles/slower-release');
  }, SLOW);

  it('the knee: about 84% busy holds p99 under 40 ms, 90% does not', () => {
    expect(passed(run(service(4.2)))).toEqual(['littles/knee']);
    expect(passed(run(service(4.5)))).not.toContain('littles/knee');
    // more slots would make it easy: not allowed
    expect(passed(run(service(4.5), setParam('api', 'concurrency', 5)))).not.toContain('littles/knee');
  }, SLOW);
});
