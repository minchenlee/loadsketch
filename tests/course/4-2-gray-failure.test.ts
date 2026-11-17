// Lesson 4.2 (gray-failure, gray-failure-outlier, hedged-reads on slow-instance). Every expected
// answer is read from a run of the engine, never typed in.
import { describe, expect, it } from 'vitest';
import { judge } from '../../src/learn/lesson.ts';
import { COURSE_BY_ID } from '../../src/learn/course.ts';
import type { RunData } from '../../src/learn/metrics.ts';
import { design, lessonRuns, runOf, setEdge, setParam, SLOW, type Change } from './run.ts';

const lesson = COURSE_BY_ID['4.2'];
const { run, passed, question, challenge } = lessonRuns(lesson);
const outlier = (...c: Change[]) => runOf('gray-failure-outlier', 'gray-failure', ...c);
const hedged = (...c: Change[]) => runOf('hedged-reads', 'slow-instance', ...c);
const cheaper = (r: RunData) => judge(challenge('hedged-reads/cheaper'), r, design('hedged-reads')).passed;
const policy = (p: string) => setParam('lb', 'policy', p);

describe('gray failure lesson (4.2): questions', () => {
  it('as shipped about the slow instance’s share fails; a deep check fails fewer; outlier detection almost none', () => {
    expect(question('gray-errors').answer(run())).toBe('quarter');
    expect(question('gray-errors').answer(run(setParam('lb', 'healthCheck', 'deep')))).toBe('some');
    expect(question('outlier-errors').answer(outlier())).toBe('few');
    expect(outlier().result.nodes.lb.ejections).toBeGreaterThan(0);
  }, SLOW);

  it('a short ejection time lets the slow instance back too often', () => {
    expect(outlier(setParam('lb', 'ejectS', 5)).result.summary.errorRate).toBeGreaterThan(outlier().result.summary.errorRate);
  }, SLOW);

  it('hedging at 40 ms costs some extra calls; at 25 ms many', () => {
    const q = question('hedge-cost');
    expect(q.answer(hedged())).toBe('some');
    expect(q.answer(hedged(setEdge('lb', 'api', 'hedgeMs', 25)))).toBe('many');
    expect(q.answer(hedged(setEdge('lb', 'api', 'hedgeMs', 0)))).toBe('few');
    expect(hedged().result.summary.latencyMs.p99).toBeLessThan(hedged(setEdge('lb', 'api', 'hedgeMs', 0)).result.summary.latencyMs.p99);
  }, SLOW);
});

describe('gray failure lesson (4.2): challenges', () => {
  it('without outlier detection: a policy that sees busy instances passes; a deep check or outlier detection does not', () => {
    expect(passed(run())).toEqual([]);
    expect(passed(run(policy('least_conn')))).toEqual(['gray-failure/no-outlier']);
    expect(passed(run(policy('p2c')))).toEqual(['gray-failure/no-outlier']);
    expect(passed(run(setParam('lb', 'healthCheck', 'deep')))).toEqual([]);
    expect(passed(run(setParam('lb', 'outlier', 'on')))).toEqual([]); // breaks the rule
  }, SLOW);

  it('a cheaper tail: least connections with the 40 ms hedge passes; the shipped round robin and a later hedge do not', () => {
    expect(cheaper(hedged())).toBe(false);
    expect(cheaper(hedged(policy('least_conn')))).toBe(true);
    expect(cheaper(hedged(policy('least_conn'), setEdge('lb', 'api', 'hedgeMs', 60)))).toBe(false);
    expect(cheaper(hedged(setEdge('lb', 'api', 'hedgeMs', 50)))).toBe(false);
  }, SLOW);
});
