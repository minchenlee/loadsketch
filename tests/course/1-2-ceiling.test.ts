// Lesson 1.2 (three-tier / steady, overload). Every expected answer is read from a run of the
// engine; the ceiling claims are checked with findLimitOf, the engine behind Find limit.
import { describe, expect, it } from 'vitest';
import { COURSE_BY_ID } from '../../src/learn/course.ts';
import { findLimitOf, DEFAULT_SLO } from '../../src/engine/limit.ts';
import { judge } from '../../src/learn/lesson.ts';
import { design, lessonRuns, runOf, scenario, setParam, SLOW } from './run.ts';

const lesson = COURSE_BY_ID['1.2'];
const { run, question } = lessonRuns(lesson);
const original = design('three-tier');
const overload = (...c: Parameters<typeof setParam>[]) => runOf('three-tier', 'overload', ...c.map((x) => setParam(...x)));
const passedOverload = (r: ReturnType<typeof run>) => lesson.challenges.filter((c) => c.scenario === 'overload').filter((c) => judge(c, r, original).passed).map((c) => c.id);
describe('lesson 1.2: questions', () => {
  it('the busiest component at 800/s is the one Find limit says gives up first', () => {
    const r = run();
    const q = question('ceiling-first');
    expect(q.answer(r)).toBe(r.result.bottleneck!.node);
    const lim = findLimitOf(original, scenario('steady'));
    expect(lim.bottleneck).toBe(q.answer(r));
    expect(lim.holdsRps).toBeGreaterThan(800);
  }, 300_000);

  it('double traffic breaks the target; the answer follows the numbers', () => {
    const q = question('double');
    expect(q.scenario).toBe('overload');
    const r = overload();
    const s = r.result.summary;
    expect(q.answer(r)).toBe(s.errorRate >= DEFAULT_SLO.errorRate ? 'fails' : s.latencyMs.p99 >= DEFAULT_SLO.p99Ms ? 'slow' : 'holds');
    expect(q.answer(r)).toBe('fails');
    expect(q.answer(overload(['api', 'instances', 6]))).toBe('holds');
  }, SLOW);
});

describe('lesson 1.2: ceiling and challenge', () => {
  it('more database connections do not move the ceiling; more API servers raise it', () => {
    const base = findLimitOf(original, scenario('steady')).holdsRps!;
    const d = structuredClone(original);
    d.nodes.find((n) => n.id === 'db')!.params!.connections = 24;
    expect(findLimitOf(d, scenario('steady')).holdsRps).toBe(base);
    const a = structuredClone(original);
    a.nodes.find((n) => n.id === 'api')!.params!.instances = 6;
    expect(findLimitOf(a, scenario('steady')).holdsRps!).toBeGreaterThan(1.8 * base);
  }, 600_000);

  it('room for double: 5 API servers pass, 4 do not, 6 break the limit, the database does not help', () => {
    expect(passedOverload(overload())).toEqual([]);
    expect(passedOverload(overload(['api', 'instances', 5]))).toEqual(['ceiling/double']);
    expect(passedOverload(overload(['api', 'instances', 4]))).toEqual([]);
    expect(passedOverload(overload(['api', 'instances', 6]))).toEqual([]);
    expect(passedOverload(overload(['db', 'connections', 24]))).toEqual([]);
  }, SLOW);
});
