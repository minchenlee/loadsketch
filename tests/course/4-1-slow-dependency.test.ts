// Lesson 4.1 (slow-dependency, bulkhead-fallback, resilience). Every expected answer is read from a
// run of the engine, never typed in.
import { describe, expect, it } from 'vitest';
import { judge } from '../../src/learn/lesson.ts';
import { COURSE_BY_ID } from '../../src/learn/course.ts';
import type { RunData } from '../../src/learn/metrics.ts';
import { design, lessonRuns, runOf, setEdge, SLOW, type Change } from './run.ts';

const lesson = COURSE_BY_ID['4.1'];
const { run, passed, question, challenge } = lessonRuns(lesson);
const bf = (...c: Change[]) => runOf('bulkhead-fallback', 'slow-dependency', ...c);
const recs = (key: string, v: unknown) => setEdge('api', 'recs', key, v);
const degradesLess = (r: RunData) => judge(challenge('bulkhead-fallback/degrade-less'), r, design('bulkhead-fallback')).passed;

describe('slow dependency lesson (4.1): questions', () => {
  it('as shipped about half of the run fails: every request while recommendations are slow', () => {
    const base = run();
    expect(question('slow-fail').answer(base)).toBe('half');
    expect(base.result.summary.fail.queue_full).toBeGreaterThan(0);
  }, SLOW);

  it('the fallback alone or the bulkhead alone does not save the page (the "try" step)', () => {
    const base = run().result.summary.errorRate;
    expect(run(recs('fallback', 'on')).result.summary.errorRate).toBeGreaterThan(0.9 * base);
    expect(run(recs('bulkhead', 4)).result.summary.errorRate).toBeGreaterThan(base);
  }, SLOW);

  it('a bulkhead of 4 degrades more than half the run, even at normal speed; a timeout degrades about half', () => {
    const q = question('degraded');
    expect(q.answer(bf())).toBe('most');
    expect(q.answer(bf(recs('bulkhead', 0), recs('timeoutMs', 100)))).toBe('half');
    expect(question('slow-fail').answer(bf())).toBe('few');
  }, SLOW);
});

describe('slow dependency lesson (4.1): the degraded share', () => {
  it('counts each user response once, even when two calls of one request fall back', () => {
    const r = bf(setEdge('api', 'db', 'fallback', 'on'), setEdge('api', 'db', 'timeoutMs', 1));
    expect(parseFloat(question('degraded').measured(r))).toBeLessThanOrEqual(100);
    const s = r.result.summary as { degraded?: number; offered: number };
    expect(s.degraded ?? 0).toBeLessThanOrEqual(s.offered);
  }, SLOW);
});

describe('slow dependency lesson (4.1): challenges', () => {
  it('keep the page up: a bulkhead or a short timeout, each with a fallback', () => {
    expect(passed(run())).toEqual([]);
    expect(passed(run(recs('bulkhead', 4), recs('fallback', 'on')))).toEqual(['slow-dependency/hold']);
    expect(passed(run(recs('timeoutMs', 100), recs('fallback', 'on')))).toEqual(['slow-dependency/hold']);
    expect(passed(run(recs('timeoutMs', 100)))).toEqual([]);
    expect(passed(run(recs('fallback', 'on')))).toEqual([]);
  }, SLOW);

  it('degrade less: a larger bulkhead with a short timeout passes; the shipped one and a larger bulkhead alone do not', () => {
    expect(degradesLess(bf())).toBe(false);
    expect(degradesLess(bf(recs('bulkhead', 16), recs('timeoutMs', 100)))).toBe(true);
    expect(degradesLess(bf(recs('bulkhead', 16)))).toBe(false); // p99 over 1 s
    expect(degradesLess(bf(recs('bulkhead', 8), recs('timeoutMs', 100)))).toBe(false); // 8 is still too small
  }, SLOW);
});
