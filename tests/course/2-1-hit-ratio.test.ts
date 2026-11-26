// Lesson 2.1 (url-shortener): guess-then-run questions and challenges. Every expected answer is
// read from a run of the engine, never typed in.
import { describe, expect, it } from 'vitest';
import { judge } from '../../src/learn/lesson.ts';
import { COURSE_BY_ID } from '../../src/learn/course.ts';
import type { RunData } from '../../src/learn/metrics.ts';
import { lessonRuns, setParam, setScenario, SLOW, type Change } from './run.ts';

const lesson = COURSE_BY_ID['2.1'];
const { run, original, passed } = lessonRuns(lesson);

const cacheKeys = (k: number) => setParam('cache', 'capacityKeys', k);
const ttl = (s: number) => setParam('cache', 'ttlS', s);
const fixedHits: Change = { key: 'cache.fixed', apply: (d) => (d.nodes.find((n) => n.id === 'cache')!.params = { mode: 'fixed', hitRatio: 0.9 }) };
const dbConnections = (n: number) => setParam('db', 'connections', n);
const dbReplicas = (n: number) => setParam('db', 'replicas', n);
const apiInstances = (n: number) => setParam('api', 'instances', n);
const zipf = (z: number): Change => setScenario(`zipf=${z}`, (s) => (s.keys = { ...s.keys!, zipf: z }));

const hit = (r: RunData) => r.result.nodes.cache.hitRatio!;
const dbShare = (r: RunData) => r.result.nodes.db.arrivals / r.result.nodes.api.arrivals;

describe('cache hit-ratio lesson: questions', () => {
  const [hitQ, shareQ] = lesson.questions;

  it('the answers are read from the run, and agree with the measured numbers', () => {
    const base = run();
    expect(hitQ.answer(base)).toBe('most');
    expect(hit(base)).toBeGreaterThanOrEqual(0.65);
    expect(hit(base)).toBeLessThan(0.9);
    expect(shareQ.answer(base)).toBe('quarter');
    expect(dbShare(base)).toBeGreaterThanOrEqual(0.17);
    expect(dbShare(base)).toBeLessThan(0.4);
    expect(hitQ.measured(base)).toMatch(/\d/);
    expect(shareQ.measured(base)).toMatch(/\d/);
  }, SLOW);

  it('a tenth of the cache: the hit ratio drops to about a half, and half the requests reach the database', () => {
    const small = run(cacheKeys(2000));
    expect(hitQ.answer(small)).toBe('half');
    expect(shareQ.answer(small)).toBe('half');
    expect(hit(small)).toBeLessThan(hit(run()));
  }, SLOW);

  it('a fixed 90% hit ratio still sends 10 to 40 of 100 to the database (the writes, and the misses)', () => {
    const fixed = run(fixedHits);
    expect(hitQ.answer(fixed)).toBe('all');
    expect(dbShare(fixed)).toBeGreaterThanOrEqual(0.1);
    expect(shareQ.answer(fixed)).toBe('quarter');
  }, SLOW);

  it('spread-out clicks (a low Zipf exponent) make the same cache miss most reads', () => {
    expect(hitQ.answer(run(zipf(0.6)))).toBe('tenth');
  }, SLOW);

  it('the database load follows 1 − hit ratio', () => {
    for (const r of [run(), run(cacheKeys(2000)), run(fixedHits)]) {
      // reads are 99% of the traffic; the rest are writes, which always reach the database
      const expected = 0.99 * (1 - hit(r)) + 0.01;
      expect(Math.abs(dbShare(r) - expected)).toBeLessThan(0.05);
    }
  }, SLOW);
});

describe('cache hit-ratio lesson: challenges', () => {
  it('the example as it ships passes none: the cache is too big and never expires', () => {
    expect(passed(run())).toEqual([]);
  }, SLOW);

  it('a tenth of the cache still holds; a fifteenth does not', () => {
    expect(passed(run(cacheKeys(2000)))).toEqual(['cache/tenth']);
    expect(passed(run(cacheKeys(1500)))).toEqual([]);
  }, SLOW);

  it('a fiftieth needs database capacity: connections or replicas help, API servers do not', () => {
    expect(passed(run(cacheKeys(1000)))).toEqual([]);
    expect(passed(run(cacheKeys(1000), dbConnections(16)))).toEqual(['cache/fiftieth']);
    expect(passed(run(cacheKeys(1000), dbReplicas(2)))).toEqual(['cache/fiftieth']);
    expect(passed(run(cacheKeys(1000), apiInstances(8)))).toEqual([]);
  }, SLOW);

  it('a 3 s TTL holds; 2 s does not; a bigger cache does not make up for a short TTL', () => {
    expect(passed(run(ttl(3)))).toEqual(['cache/fresh']);
    expect(passed(run(ttl(2)))).toEqual([]);
    expect(passed(run(ttl(2), cacheKeys(200000)))).toEqual([]);
  }, SLOW);

  it('a fixed hit ratio breaks "keep LRU" on every challenge', () => {
    for (const c of lesson.challenges) {
      const v = judge(c, run(fixedHits, cacheKeys(1000)), original);
      expect(v.passed).toBe(false);
      expect(v.broken.some((b) => /LRU|fixed|固定/.test(b))).toBe(true);
    }
  }, SLOW);

  it('the limit goals read the parameter, with the kind default when it is not set', () => {
    const [tenth, , fresh] = lesson.challenges;
    const cap = tenth.goals[0];
    expect(cap.check(run(cacheKeys(2000))).ok).toBe(true);
    expect(cap.check(run()).ok).toBe(false); // 20000 as shipped
    expect(cap.check(run()).value).toBe('20000');
    const freshGoal = fresh.goals[0];
    expect(freshGoal.check(run()).ok).toBe(false); // ttlS 0 = never expires
    expect(freshGoal.check(run()).value).toMatch(/0/);
    expect(freshGoal.check(run(ttl(3))).ok).toBe(true);
    expect(freshGoal.check(run(ttl(4))).ok).toBe(false);
  }, SLOW);
});