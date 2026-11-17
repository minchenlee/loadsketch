// Lesson 1.3 (lifo-codel / overload). Every expected answer is read from a run of the engine.
import { describe, expect, it } from 'vitest';
import { COURSE_BY_ID } from '../../src/learn/course.ts';
import { stepsOf } from '../../src/learn/lesson.ts';
import { lessonRuns, setParam, SLOW, type Change } from './run.ts';

const lesson = COURSE_BY_ID['1.3'];
const { run, passed, question } = lessonRuns(lesson);
const fifo: Change[] = [setParam('api', 'queueOrder', 'fifo'), setParam('api', 'codelTargetMs', 0)];
const limit = (n: number) => setParam('api', 'queueLimit', n);
const fails = (r: ReturnType<typeof run>) => r.result.summary.fail;

describe('lesson 1.3: questions', () => {
  it('LIFO + CoDel: about the part above capacity fails, and at once', () => {
    const r = run();
    const e = r.result.summary.errorRate;
    expect(question('overload-fail').answer(r)).toBe('excess');
    // 2000 asked during 40 of 80 s, about 1600 served: the excess is a share of the whole run
    expect(e).toBeGreaterThan(0.1);
    expect(e).toBeLessThan(0.4);
    expect(question('fail-how').answer(r)).toBe('fast');
    expect(fails(r).codel + fails(r).queue_full).toBeGreaterThan(fails(r).timeout);
  }, SLOW);

  it('a long FIFO queue without CoDel: most fail, by timeout, with the servers just as busy', () => {
    const base = run();
    const r = run(...fifo);
    expect(question('overload-fail').answer(r)).toBe('most');
    expect(question('fail-how').answer(r)).toBe('slow');
    expect(r.result.nodes.api.utilization).toBeGreaterThanOrEqual(base.result.nodes.api.utilization! - 0.02);
  }, SLOW);

  it('the queue limit trades waiting for rejection: the error rate stays, p99 grows with the limit', () => {
    const [a, b, c] = [10, 100, 300].map((n) => run(...fifo, limit(n)));
    for (const r of [a, b, c]) expect(question('fail-how').answer(r)).toBe('fast');
    expect(Math.abs(a.result.summary.errorRate - c.result.summary.errorRate)).toBeLessThan(0.02);
    expect(a.result.summary.latencyMs.p99).toBeLessThan(b.result.summary.latencyMs.p99);
    expect(b.result.summary.latencyMs.p99).toBeLessThan(c.result.summary.latencyMs.p99);
  }, SLOW);

  it('a looser CoDel target lets more requests time out', () => {
    const r = run(setParam('api', 'codelTargetMs', 50));
    expect(fails(r).timeout).toBeGreaterThan(fails(run()).timeout);
  }, SLOW);
});

describe('lesson 1.3: the tries stack (the page keeps the design between tries)', () => {
  it('the CoDel 50 ms try, after FIFO and a queue limit of 300, still shows fewer CoDel drops and more timeouts', () => {
    const tries = stepsOf(lesson).filter((s) => s.kind === 'try');
    const last = tries[tries.length - 1];
    const patch: Change[] = ('patch' in last ? last.patch ?? [] : []).flatMap((p) => ('node' in p ? Object.entries(p.params).map(([k, v]) => setParam(p.node, k, v)) : []));
    const base = run();
    const r = run(...fifo, limit(300), ...patch);
    expect(fails(r).codel).toBeLessThan(fails(base).codel);
    expect(fails(r).timeout).toBeGreaterThan(fails(base).timeout);
  }, SLOW);
});

describe('lesson 1.3: challenge', () => {
  it('the example and the long FIFO queue fail it; a short FIFO queue passes; a long one does not', () => {
    expect(passed(run())).toEqual([]); // LIFO + CoDel: not a plain FIFO queue
    expect(passed(run(...fifo))).toEqual([]);
    expect(passed(run(...fifo, limit(10)))).toEqual(['queues/bounded-fifo']);
    expect(passed(run(...fifo, limit(300)))).toEqual([]);
  }, SLOW);
});
