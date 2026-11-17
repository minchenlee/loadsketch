// Lesson 3.3 (flash-sale; tenant-limits with steady traffic). Every expected answer is read from a
// run of the engine, never typed in.
import { describe, expect, it } from 'vitest';
import { judge } from '../../src/learn/lesson.ts';
import { COURSE_BY_ID } from '../../src/learn/course.ts';
import { clientFailShare } from '../../src/learn/lessonKit2.ts';
import type { RunData } from '../../src/learn/metrics.ts';
import { design, lessonRuns, runOf, setParam, SLOW, type Change } from './run.ts';

const lesson = COURSE_BY_ID['3.3'];
const { run, passed, question, challenge } = lessonRuns(lesson);
const rate = (v: number) => setParam('limiter', 'ratePerSec', v);
const tenant = (...c: Change[]) => runOf('tenant-limits', 'steady', ...c);
const grows = (r: RunData) => judge(challenge('tenant-limits/grow'), r, design('tenant-limits')).passed;
const quota = (v: number) => setParam('rl', 'ratePerSec', v);

describe('rate limiting lesson (3.3): questions', () => {
  it('the limiter turns away about half of the run; with a higher limit, fewer', () => {
    const q = question('sale-limited');
    expect(q.answer(run())).toBe('half');
    expect(q.answer(run(rate(3000)))).toBe('some');
    expect(q.answer(run(rate(100000)))).toBe('few');
    expect(q.answer(run(rate(1000)))).toBe('most');
  }, SLOW);

  it('without the limit fewer fail, but p99 more than triples (the "try" step)', () => {
    const base = run();
    const open = run(rate(100000));
    expect(open.result.summary.errorRate).toBeLessThan(base.result.summary.errorRate);
    expect(open.result.summary.latencyMs.p99).toBeGreaterThan(3 * base.result.summary.latencyMs.p99);
  }, SLOW);

  it('a quota per customer leaves the small customer alone; a shared one does not', () => {
    const q = question('tenant-small');
    const per = tenant();
    expect(q.answer(per)).toBe('none');
    expect(clientFailShare(per, 'big')).toBeGreaterThan(0.1);
    const shared = tenant(setParam('rl', 'scope', 'global'));
    expect(q.answer(shared)).toBe('same');
    expect(clientFailShare(shared, 'small')).toBeGreaterThan(0.1);
  }, SLOW);
});

describe('rate limiting lesson (3.3): challenges', () => {
  it('sell more: 3000 a second passes; the shipped limit, no limit and a big burst do not', () => {
    expect(passed(run())).toEqual([]);
    expect(passed(run(rate(3000)))).toEqual(['flash-sale/sell-more']);
    expect(passed(run(rate(2500)))).toEqual([]);
    expect(passed(run(rate(100000)))).toEqual([]);
    expect(passed(run(rate(3000), setParam('limiter', 'burst', 3000)))).toEqual([]);
  }, SLOW);

  it('a bigger plan: a quota with room above the average passes; just over the average does not', () => {
    expect(grows(tenant())).toBe(false);
    expect(grows(tenant(quota(700)))).toBe(false);
    expect(grows(tenant(quota(800)))).toBe(true);
    expect(grows(tenant(quota(900)))).toBe(false); // over the 800 cap
    expect(grows(tenant(setParam('rl', 'scope', 'global'), quota(800)))).toBe(false); // a shared quota breaks the rule
  }, SLOW);
});
