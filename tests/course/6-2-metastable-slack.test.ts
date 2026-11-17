// Lesson 6.2 (saas-slack). Every expected answer is read from a run of the engine, never typed in.
// Each run of this example takes tens of seconds, so the test runs few variants.
import { describe, expect, it } from 'vitest';
import { COURSE_BY_ID } from '../../src/learn/course.ts';
import type { RunData } from '../../src/learn/metrics.ts';
import { pageTries, patched } from './pageTries.ts';
import { lessonRuns, setParam, SLOW } from './run.ts';

const lesson = COURSE_BY_ID['6.2'];
const { run, passed, question } = lessonRuns(lesson);
const boot = (n: number) => [setParam('bootlimit', 'ratePerSec', n), setParam('bootlimit', 'burst', n)];
const LONG = 4 * SLOW;
const afterP99 = (r: RunData) => Math.max(0, ...r.windows.filter((w) => w.t > 70 && w.latency.count > 0).map((w) => w.latency.p99));

describe('metastable failure lesson (6.2)', () => {
  it('as shipped: the database cannot hold, and the system stays slow after the cause is gone', () => {
    const base = run();
    expect(question('db-hold').answer(base)).toBe('no');
    expect(question('after-trigger').answer(base)).toBe('no');
    expect(passed(base)).toEqual([]);
  }, LONG);

  it('a boot limit of 300 breaks the loop, but turns away too many boot queries (the "try" step)', () => {
    const r = run(...boot(300));
    expect(question('after-trigger').answer(r)).toBe('yes');
    expect(passed(r)).toEqual([]);
  }, LONG);

  it('the try steps as the page runs them: the boot limit brings p99 to about 100 ms; lease on its own, after it, helps only a little', () => {
    const [first, second] = pageTries(lesson);
    expect(afterP99(run(patched(first.stacked)))).toBeLessThan(150);
    const r = run(patched(second.stacked));
    expect(question('after-trigger').answer(r)).toBe('no');
    expect(afterP99(r)).toBeLessThan(afterP99(run()));
  }, 2 * LONG);

  it('a boot limit of 600 passes the challenge', () => {
    expect(passed(run(...boot(600)))).toEqual(['saas-slack/break-the-loop']);
  }, LONG);

  it('more database connections also hold, but break the rule', () => {
    const r = run(setParam('vitess', 'connections', 12));
    expect(question('db-hold').answer(r)).toBe('yes');
    expect(passed(r)).toEqual([]);
  }, LONG);
});
