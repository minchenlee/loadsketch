// Lesson 2.5 (sharded / hot-keys, hot-shard). Expected answers come from engine runs.
import { describe, expect, it } from 'vitest';
import { COURSE_BY_ID } from '../../src/learn/course.ts';
import { average, hottest } from '../../src/learn/course/2-5-sharding.ts';
import { lessonRuns, runOf, setParam, SLOW, type Change } from './run.ts';

const lesson = COURSE_BY_ID['2.5'];
const { run, passed, question } = lessonRuns(lesson);
const shards = (n: number) => setParam('db', 'shards', n);
const hot = (...c: Change[]) => runOf('sharded', 'hot-shard', ...c);

describe('lesson 2.5: questions', () => {
  it('4 shards: the busiest shard is hotter than the average and close to full', () => {
    const r = run();
    expect(question('hot-ratio').answer(r)).toBe('hotter');
    expect(question('more-shards').answer(r)).toBe('same');
  }, SLOW);

  it('16 shards: the average falls to about a quarter, the busiest only to about half', () => {
    const base = run();
    const r = run(shards(16));
    expect(question('more-shards').answer(r)).toBe('half');
    expect(question('hot-ratio').answer(r)).toBe('much');
    expect(average(r)).toBeLessThan(average(base) * 0.3);
    expect(hottest(r)).toBeGreaterThan(hottest(base) * 0.4);
  }, SLOW);
});

describe('lesson 2.5: challenge', () => {
  it('the example, one replica and more shards fail; two read replicas pass', () => {
    expect(passed(hot())).toEqual([]);
    expect(passed(hot(setParam('db', 'replicas', 1), setParam('db', 'readFrom', 'replicas')))).toEqual([]);
    expect(passed(hot(shards(16)))).toEqual([]);
    expect(passed(hot(setParam('db', 'connections', 32)))).toEqual([]); // more connections: not allowed
    expect(passed(hot(setParam('db', 'replicas', 2), setParam('db', 'readFrom', 'replicas')))).toEqual(['shards/read-hot']);
  }, SLOW);
});
