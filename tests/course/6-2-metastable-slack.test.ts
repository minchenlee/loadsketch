// Lesson 6.2 (saas-slack). Every expected answer is read from a run of the engine, never typed in.
// Each run of this example takes tens of seconds, so the test runs few variants.
import { describe, expect, it } from 'vitest';
import { COURSE_BY_ID } from '../../src/learn/course.ts';
import { lessonRuns, setParam, SLOW } from './run.ts';

const lesson = COURSE_BY_ID['6.2'];
const { run, passed, question } = lessonRuns(lesson);
const boot = (n: number) => [setParam('bootlimit', 'ratePerSec', n), setParam('bootlimit', 'burst', n)];
const LONG = 4 * SLOW;

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

  it('a boot limit of 600 passes the challenge', () => {
    expect(passed(run(...boot(600)))).toEqual(['saas-slack/break-the-loop']);
  }, LONG);

  it('more database connections also hold, but break the rule', () => {
    const r = run(setParam('vitess', 'connections', 12));
    expect(question('db-hold').answer(r)).toBe('yes');
    expect(passed(r)).toEqual([]);
  }, LONG);
});
