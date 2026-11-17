// Lesson 5.2 (async-reliable with the worker-crash scenario). Every expected answer is read from a
// run of the engine, never typed in.
import { describe, expect, it } from 'vitest';
import { COURSE_BY_ID } from '../../src/learn/course.ts';
import { lessonRuns, runOf, setParam, SLOW } from './run.ts';

const lesson = COURSE_BY_ID['5.2'];
const { run, passed, question } = lessonRuns(lesson);
const jobs = (k: string, v: unknown) => setParam('jobs', k, v);
const thumb = (k: string, v: unknown) => setParam('thumb', k, v);

describe('at-least-once lesson (5.2): questions', () => {
  it('as shipped: the crash makes thumbnails seconds late, only poison goes to the DLQ, no duplicates', () => {
    const base = run();
    expect(question('crash-wait').answer(base)).toBe('seconds');
    expect(question('dlq-share').answer(base)).toBe('poison');
    expect(question('duplicates').answer(base)).toBe('none');
    expect(base.result.nodes.jobs.redelivered).toBeGreaterThan(0);
  }, SLOW);

  it('without the crash the async p99 stays short', () => {
    expect(question('crash-wait').answer(runOf('async-reliable', 'steady'))).toBe('same');
  }, SLOW);

  it('a visibility timeout shorter than a job makes duplicates (the first "try" step)', () => {
    expect(question('duplicates').answer(run(jobs('visibilityTimeoutMs', 100)))).toBe('some');
  }, SLOW);

  it('no limit of tries: nothing in the DLQ, and the poison comes back (the second "try" step)', () => {
    const r = run(jobs('maxReceives', 0));
    expect(question('dlq-share').answer(r)).toBe('none');
    expect(r.result.nodes.thumb.fail).toBeGreaterThan(5 * run().result.nodes.thumb.fail);
  }, SLOW);
});

describe('at-least-once lesson (5.2): challenge', () => {
  it('a third machine (N + 1) passes; at-most-once, a short visibility timeout or too few slots do not', () => {
    expect(passed(run())).toEqual([]);
    expect(passed(run(thumb('instances', 3)))).toEqual(['async-reliable/crash-safe']);
    expect(passed(run(thumb('concurrency', 6)))).toEqual(['async-reliable/crash-safe']);
    expect(passed(run(thumb('instances', 3), jobs('visibilityTimeoutMs', 100)))).toEqual([]);
    expect(passed(run(thumb('instances', 3), jobs('delivery', 'at_most_once')))).toEqual([]);
    expect(passed(run(thumb('instances', 4)))).toEqual([]);
  }, SLOW);
});
