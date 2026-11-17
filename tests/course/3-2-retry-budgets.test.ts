// Lesson 3.2 (retry-budget, adaptive-throttle, retry-storm). Every expected answer is read from a
// run of the engine, never typed in.
import { describe, expect, it } from 'vitest';
import { judge } from '../../src/learn/lesson.ts';
import { COURSE_BY_ID } from '../../src/learn/course.ts';
import { recovery } from '../../src/learn/lessonKit2.ts';
import { peakAmp, type RunData } from '../../src/learn/metrics.ts';
import { design, lessonRuns, runOf, setEdge, setParam, SLOW, type Change } from './run.ts';

const lesson = COURSE_BY_ID['3.2'];
const { run, question, challenge } = lessonRuns(lesson);
const storm = (...c: Change[]) => runOf('retry-storm', 'retry-storm', ...c);
const throttle = (...c: Change[]) => runOf('adaptive-throttle', 'retry-storm', ...c);
const allK = (k: number): Change[] => ['users->lb', 'lb->api', 'api->cache', 'api->db'].map((id) => { const [a, b] = id.split('->'); return setEdge(a, b, 'throttleK', k); });
const passes = (id: string, r: RunData) => judge(challenge(id), r, design(challenge(id).example!)).passed;

describe('retry budgets lesson (3.2): questions', () => {
  it('a 10% budget keeps the API near the 3× spike; a larger budget lets more retries through', () => {
    const base = run();
    expect(peakAmp(base, 'api', 20, 30)).toBeLessThan(4.5);
    expect(question('budget-amp').answer(base)).toBe('x3');
    const big = run(...['lb->api', 'api->cache', 'api->db'].map((id) => { const [a, b] = id.split('->'); return setEdge(a, b, 'retryBudget', 0.5); }));
    expect(peakAmp(big, 'api', 20, 30)).toBeGreaterThan(peakAmp(base, 'api', 20, 30));
    expect(question('budget-amp').answer(storm())).toBe('x10');
  }, SLOW);

  it('adaptive throttling recovers, but slowly; a small K never lets go', () => {
    const base = throttle();
    expect(recovery(base)).toBeGreaterThan(5);
    expect(recovery(base)).toBeLessThan(Infinity);
    expect(question('throttle-recover').answer(base)).toBe('slow');
    expect(question('throttle-recover').answer(throttle(...allK(1.5)))).toBe('never');
    // the budget, in comparison, recovers within a few seconds
    expect(question('throttle-recover').answer(run())).toBe('fast');
  }, SLOW);

  it('the deadline "try" step changes nothing: every hop times out long before the deadline', () => {
    const r = storm(setParam('users', 'deadline', 'propagate'));
    expect(recovery(r)).toBe(Infinity);
    expect(r.result.summary.errorRate).toBeCloseTo(storm().result.summary.errorRate, 2);
  }, SLOW);
});

describe('retry budgets lesson (3.2): challenges', () => {
  it('one connection: a budget on the load balancer edge passes; on the database edge it does not', () => {
    expect(passes('retry-budget/one-edge', storm())).toBe(false);
    expect(passes('retry-budget/one-edge', storm(setEdge('lb', 'api', 'retryBudget', 0.1)))).toBe(true);
    expect(passes('retry-budget/one-edge', storm(setEdge('api', 'db', 'retryBudget', 0.1)))).toBe(false);
  }, SLOW);

  it('one connection: changing two breaks the rule, and so does dropping the retries', () => {
    const two = judge(challenge('retry-budget/one-edge'), storm(setEdge('lb', 'api', 'retryBudget', 0.1), setEdge('api', 'db', 'retryBudget', 0.1)), design('retry-storm'));
    expect(two.passed).toBe(false);
    expect(two.broken.length).toBeGreaterThan(0);
    expect(passes('retry-budget/one-edge', storm(setEdge('lb', 'api', 'retries', 0)))).toBe(false);
  }, SLOW);

  it('let go sooner: K = 3 or a budget next to the throttle pass; K = 2 as shipped and K = 6 do not', () => {
    expect(passes('adaptive-throttle/let-go', throttle())).toBe(false);
    expect(passes('adaptive-throttle/let-go', throttle(...allK(3)))).toBe(true);
    const budget = ['lb->api', 'api->cache', 'api->db'].map((id) => { const [a, b] = id.split('->'); return setEdge(a, b, 'retryBudget', 0.1); });
    expect(passes('adaptive-throttle/let-go', throttle(...budget))).toBe(true);
    // K = 6 recovers in time but breaks "keep adaptive throttling" (it hardly rejects)
    const k6 = throttle(...allK(6));
    expect(recovery(k6)).toBeLessThanOrEqual(20);
    expect(passes('adaptive-throttle/let-go', k6)).toBe(false);
  }, SLOW);
});
