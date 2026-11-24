// Lesson 0.0 (three-tier / steady): zero-math orientation. Every expected answer is read from a run.
import { describe, expect, it } from 'vitest';
import { COURSE_BY_ID } from '../../src/learn/course.ts';
import { lessonRuns, setParam, SLOW } from './run.ts';

const lesson = COURSE_BY_ID['0.0'];
const { run, question } = lessonRuns(lesson);
const api = (n: number) => setParam('api', 'instances', n);

describe('lesson 0.0: questions and overload contrast', () => {
  it('with 3 API servers on steady traffic, the database stays quiet and the site stays fast with zero errors', () => {
    const r = run();
    const dbQ = question('db-quiet');
    const healthQ = question('healthy-run');
    expect(dbQ.answer(r)).toBe('quiet');
    expect(r.result.nodes.db.utilization).toBeLessThan(0.2);
    expect(dbQ.measured(r)).toMatch(/\d/);

    expect(healthQ.answer(r)).toBe('healthy');
    expect(r.result.summary.latencyMs.p99).toBeLessThan(200);
    expect(r.result.summary.errorRate).toBeLessThan(0.01);
    expect(healthQ.measured(r)).toMatch(/\d/);
  }, SLOW);

  it('dropping to 1 API server causes heavy queueing, high p99, and failures; restoring 3 recovers cleanly', () => {
    const overloaded = run(api(1));
    expect(question('healthy-run').answer(overloaded)).toBe('failing');
    expect(overloaded.result.summary.errorRate).toBeGreaterThan(0.01);
    expect(overloaded.result.summary.latencyMs.p99).toBeGreaterThan(200);
    expect(overloaded.result.nodes.api.utilization).toBeGreaterThanOrEqual(0.95);

    const restored = run(api(3));
    expect(question('healthy-run').answer(restored)).toBe('healthy');
    expect(restored.result.summary.errorRate).toBeLessThan(0.01);
  }, SLOW);
});
