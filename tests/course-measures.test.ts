// What a run or try step shows after its run (src/course/measures.ts).
import { describe, expect, it } from 'vitest';
import { DEFAULT_SHOW, MEASURES, readings } from '../src/course/measures.ts';
import { ALL_LESSONS } from '../src/course/catalog.ts';
import { stepsOf } from '../src/learn/lesson.ts';
import type { RunData } from '../src/learn/metrics.ts';

const lat = (p99: number, n = 100) => ({ count: n, mean: p99 / 2, p50: p99 / 3, p90: p99 * 0.8, p95: p99 * 0.9, p99, p999: p99, max: p99 });
const run = (p99: number, err: number, util: Record<string, number>, extra: Record<string, Record<string, number>> = {}): RunData =>
  ({
    design: { nodes: [], edges: [] },
    scenario: {},
    windows: [],
    result: {
      summary: { errorRate: err, throughputRps: 100, latencyMs: lat(p99), asyncLatencyMs: lat(0, 0) },
      nodes: Object.fromEntries(Object.entries(util).map(([id, u]) => [id, { label: id.toUpperCase(), utilization: u, ...(extra[id] ?? {}) }])),
    },
  }) as unknown as RunData;

describe('course measures', () => {
  it('without a show: p99, failed requests and the busiest component', () => {
    const r = readings(undefined, run(1230, 0.25, { api: 0.97, db: 0.4 }));
    expect(r.map((x) => x.key)).toEqual(DEFAULT_SHOW);
    expect(r.map((x) => x.now)).toEqual(['1.23 s', '25%', '97%']);
    expect(r[2].who).toBe('API');
    expect(r.every((x) => x.before === undefined && x.change === undefined)).toBe(true);
  });

  it('compares with the run before it, by each measure\'s direction', () => {
    const r = readings(['p99', 'failRate', 'hitRatio'], run(78.3, 0, { api: 0.3, cache: 0.1 }, { cache: { hitRatio: 0.95 } }), run(1230, 0.25, { api: 0.97, cache: 0.1 }, { cache: { hitRatio: 0.8 } }));
    expect(r.map((x) => [x.before, x.now, x.change])).toEqual([
      ['1.23 s', '78.3 ms', 'better'],
      ['25%', '0%', 'better'],
      ['80%', '95%', 'better'],
    ]);
    const worse = readings(['p99'], run(500, 0, {}), run(100, 0, {}));
    expect(worse[0].change).toBe('worse');
    expect(readings(['p99'], run(100, 0, {}), run(100, 0, {}))[0].change).toBe('same');
  });

  it('leaves out unknown keys and readings the run has not', () => {
    expect(readings(['nope', 'hitRatio', 'duplicates'], run(10, 0, { api: 0.1 })).map((x) => x.key)).toEqual([]);
    expect(readings(['duplicates'], run(10, 0, { w: 0.1 }, { w: { duplicates: 173 } }), run(10, 0, { w: 0.1 }, { w: { duplicates: 0 } }))[0]).toMatchObject({ before: '0', now: '173', change: 'worse' });
  });

  it('every show key in the course lessons is a measure', () => {
    for (const l of ALL_LESSONS) {
      if (!l.lesson) continue;
      for (const s of stepsOf(l.lesson)) if ('show' in s && s.show) for (const k of s.show) expect(MEASURES[k], `${l.id} ${k}`).toBeDefined();
    }
  });
});
