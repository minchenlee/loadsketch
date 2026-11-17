// Ways round a challenge that must not pass (review of bddad6f). Each one was found to pass before the fix.
import { describe, expect, it } from 'vitest';
import { COURSE_BY_ID } from '../../src/learn/course.ts';
import { lessonRuns, removeNode, setParam, SLOW, type Change } from './run.ts';

const L = (id: string) => lessonRuns(COURSE_BY_ID[id]);

describe('deleting a component of the example does not pass', () => {
  it('2.1: a 1000-key cache with the database deleted', () => {
    const { run, passed } = L('2.1');
    expect(passed(run(setParam('cache', 'capacityKeys', 1000), removeNode('db')))).not.toContain('cache/fiftieth');
  }, SLOW);

  it('2.2: the database deleted', () => {
    const { run, passed } = L('2.2');
    expect(passed(run(removeNode('db')))).toEqual([]);
  }, SLOW);

  it('1.3: the database deleted', () => {
    const { run, passed } = L('1.3');
    expect(passed(run(setParam('api', 'queueOrder', 'fifo'), setParam('api', 'codelTargetMs', 0), setParam('api', 'queueLimit', 10), removeNode('db')))).toEqual([]);
  }, SLOW);
});

describe('2.1: the database-share answer agrees with its option text', () => {
  it('a fixed 90% hit ratio sends about 11 of 100 to the database: not "fewer than 10"', () => {
    const { run, question } = L('2.1');
    const fixed: Change = { key: 'cache.fixed', apply: (d) => (d.nodes.find((n) => n.id === 'cache')!.params = { mode: 'fixed', hitRatio: 0.9 }) };
    const r = run(fixed);
    const share = r.result.nodes.db.arrivals / r.result.nodes.api.arrivals;
    expect(share).toBeGreaterThanOrEqual(0.1);
    expect(question('db-share').answer(r)).not.toBe('tenth');
  }, SLOW);
});

describe('autoscaling does not get round a machine limit', () => {
  it('1.1: one server as the floor, autoscaling to 4 (review of 6873782)', () => {
    const { run, passed } = L('1.1');
    const r = run(
      setParam('api', 'serviceMs', { mean: 4.5, cv: 1 }),
      setParam('api', 'autoscale', 'on'),
      setParam('api', 'scaleEveryS', 1),
      setParam('api', 'bootS', 0),
      setParam('api', 'coldFactor', 1),
      setParam('api', 'targetUtil', 0.3),
    );
    expect(passed(r)).toEqual([]);
  }, SLOW);
});

describe('turning requests away does not buy latency', () => {
  const slow: Change[] = [setParam('api', 'serviceMs', { mean: 4.5, cv: 1 })];
  it('1.1: a tiny queue on the slow release', () => {
    const { run, passed } = L('1.1');
    expect(passed(run(...slow, setParam('api', 'queueLimit', 1)))).toEqual([]);
  }, SLOW);
  it('1.1: a tiny queue at the knee', () => {
    const { run, passed } = L('1.1');
    expect(passed(run(setParam('api', 'serviceMs', { mean: 4.4, cv: 1 }), setParam('api', 'queueLimit', 1)))).toEqual([]);
  }, SLOW);
});
