// Lesson 5.1 (async-queue with the spike scenario). Every expected answer is read from a run of the
// engine, never typed in.
import { describe, expect, it } from 'vitest';
import { COURSE_BY_ID } from '../../src/learn/course.ts';
import { lessonRuns, setParam, SLOW } from './run.ts';

const lesson = COURSE_BY_ID['5.1'];
const { run, passed, question } = lessonRuns(lesson);
const workers = (i: number, c = 4) => [setParam('thumb', 'instances', i), setParam('thumb', 'concurrency', c)];

describe('queues absorb bursts lesson (5.1): questions', () => {
  it('as shipped: the users do not see the spike, a few hundred messages wait, and the queue drains fast', () => {
    const base = run();
    expect(question('users-p99').answer(base)).toBe('same');
    expect(question('queue-peak').answer(base)).toBe('hundreds');
    expect(question('drain').answer(base)).toBe('fast');
    expect(base.result.summary.asyncLatencyMs.p99).toBeGreaterThan(5 * run(...workers(3)).result.summary.asyncLatencyMs.p99);
  }, SLOW);

  it('one worker machine (the "try" step): thousands wait and the queue never empties; the users still do not notice', () => {
    const one = run(...workers(1));
    expect(question('queue-peak').answer(one)).toBe('thousands');
    expect(question('drain').answer(one)).toBe('never');
    expect(question('users-p99').answer(one)).toBe('same');
  }, SLOW);

  it('enough workers: the queue stays short', () => {
    expect(question('queue-peak').answer(run(...workers(3)))).toBe('few');
  }, SLOW);
});

describe('queues absorb bursts lesson (5.1): challenge', () => {
  it('10 slots are enough; 8 are not; 12 are over the limit', () => {
    expect(passed(run())).toEqual([]);
    expect(passed(run(...workers(2, 5)))).toEqual(['async-queue/ready-in-1s']);
    expect(passed(run(...workers(3, 4)))).toEqual([]);
  }, SLOW);

  it('messages that expire do not count as done on time', () => {
    const r = run(...workers(2, 5), setParam('jobs', 'messageTtlS', 0.001));
    expect(r.result.nodes.jobs.asyncFail).toBeGreaterThan(0);
    expect(passed(r)).toEqual([]);
  }, SLOW);
});
