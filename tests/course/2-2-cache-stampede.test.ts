// Lesson 2.2 (cache-stampede / hot-key-expiry, and cache-lease). Expected answers come from engine runs.
import { describe, expect, it } from 'vitest';
import { COURSE_BY_ID } from '../../src/learn/course.ts';
import { lessonRuns, runOf, setParam, SLOW } from './run.ts';

const lesson = COURSE_BY_ID['2.2'];
const { run, passed, question } = lessonRuns(lesson);
const lease = () => runOf('cache-lease', 'hot-key-expiry');
const err = (r: ReturnType<typeof run>) => r.result.summary.errorRate;

describe('lesson 2.2: questions', () => {
  it('a high hit ratio still fails requests, and reads wait long on a mostly idle DB', () => {
    const r = run();
    expect(r.result.nodes.redis.hitRatio!).toBeGreaterThan(0.95);
    expect(question('hit-fail').answer(r)).toBe('some');
    expect(question('db-wait').answer(r)).toBe('very');
    expect(r.result.nodes.db.utilization!).toBeLessThan(0.5);
    expect(r.result.nodes.db.peakUtilization!).toBeGreaterThan(0.9);
  }, SLOW);

  it('the lease example: nothing fails, reads barely wait, fewer DB reads', () => {
    const base = run();
    const r = lease();
    expect(question('hit-fail').answer(r)).toBe('none');
    expect(question('db-wait').answer(r)).toBe('short');
    expect(r.result.nodes.db.rps!).toBeLessThan(base.result.nodes.db.rps! / 2);
  }, SLOW);

  it('a longer TTL: higher hit ratio, fewer fail, but still some, and a longer DB wait', () => {
    const base = run();
    const r = run(setParam('redis', 'ttlS', 60));
    expect(r.result.nodes.redis.hitRatio!).toBeGreaterThan(base.result.nodes.redis.hitRatio!);
    expect(err(r)).toBeLessThan(err(base));
    expect(question('hit-fail').answer(r)).toBe('some');
    expect(r.result.nodes.db.waitMs!).toBeGreaterThan(base.result.nodes.db.waitMs!);
  }, SLOW);

  it('coalesce does nothing in cache-aside', () => {
    const base = run();
    const r = run(setParam('redis', 'stampede', 'coalesce'));
    expect(err(r)).toBe(err(base));
    expect(r.result.nodes.db.rps).toBe(base.result.nodes.db.rps);
  }, SLOW);
});

describe('lesson 2.2: challenge', () => {
  it('the example, a longer TTL and jitter alone fail; a lease passes', () => {
    expect(passed(run())).toEqual([]);
    expect(passed(run(setParam('redis', 'ttlS', 60)))).toEqual([]);
    expect(passed(run(setParam('redis', 'ttlJitter', 0.2)))).toEqual([]);
    expect(passed(run(setParam('redis', 'stampede', 'lease')))).toEqual(['stampede/no-fail']);
  }, SLOW);

  it('more DB connections is not allowed', () => {
    expect(passed(run(setParam('db', 'connections', 64)))).toEqual([]);
  }, SLOW);
});
