// Lesson 2.4 (replica-lag / read-after-write). Expected answers come from engine runs.
import { describe, expect, it } from 'vitest';
import { COURSE_BY_ID } from '../../src/learn/course.ts';
import { primaryBusy, staleShare } from '../../src/learn/course/2-4-replication-lag.ts';
import { lessonRuns, setParam, SLOW } from './run.ts';

const lesson = COURSE_BY_ID['2.4'];
const { run, passed, question } = lessonRuns(lesson);
const lag = (ms: number) => setParam('db', 'maxLagMs', ms);
const delay = (ms: number) => setParam('db', 'replicaDelayMs', ms);

describe('lesson 2.4: questions', () => {
  it('many replica reads are stale; the primary is lightly loaded', () => {
    const r = run();
    expect(question('stale-share').answer(r)).toBe('many');
    expect(question('primary-busy').answer(r)).toBe('low');
  }, SLOW);

  it('a 200 ms lag limit: no stale reads, the primary more than doubles, like reading the primary only', () => {
    const base = run();
    const r = run(lag(200));
    expect(r.result.nodes.db.staleReads).toBe(0);
    expect(r.result.nodes.db.replicaReads).toBe(0);
    expect(question('primary-busy').answer(r)).toBe('mid');
    expect(primaryBusy(r)).toBeGreaterThan(2 * primaryBusy(base));
    expect(primaryBusy(run(setParam('db', 'readFrom', 'primary')))).toBeCloseTo(primaryBusy(r), 2);
  }, SLOW);

  it('a 50 ms delay: fewer stale, but not few; it takes a few ms to get under 5%', () => {
    const base = run();
    const r = run(delay(50));
    expect(staleShare(r)).toBeLessThan(staleShare(base));
    expect(question('stale-share').answer(r)).toBe('some');
    expect(question('stale-share').answer(run(delay(5)))).toBe('few');
  }, SLOW);
});

describe('lesson 2.4: challenges', () => {
  it('the example passes neither', () => {
    expect(passed(run())).toEqual([]);
  }, SLOW);

  it('a lag limit passes "no old data" only', () => {
    expect(passed(run(lag(200)))).toEqual(['replicas/no-stale']);
  }, SLOW);

  it('a short replication delay passes "keep the replicas" only; a 50 ms one does not', () => {
    expect(passed(run(delay(5)))).toEqual(['replicas/keep-replicas']);
    expect(passed(run(delay(50)))).toEqual([]);
  }, SLOW);
});
