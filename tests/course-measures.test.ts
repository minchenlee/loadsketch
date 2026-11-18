// What a run or try step shows after its run (src/course/measures.ts).
import { beforeAll, describe, expect, it } from 'vitest';
import { setLang } from '../src/i18n/index.ts';
import { DEFAULT_SHOW, measureOf, readings } from '../src/course/measures.ts';
import { ALL_LESSONS } from '../src/course/catalog.ts';
import { stepsOf } from '../src/learn/lesson.ts';
import type { RunData } from '../src/learn/metrics.ts';

const lat = (p99: number, n = 100) => ({ count: n, mean: p99 / 2, p50: p99 / 3, p90: p99 * 0.8, p95: p99 * 0.9, p99, p999: p99, max: p99 });
type Extra = Record<string, Record<string, number | string>>;
const run = (p99: number, err: number, util: Record<string, number>, extra: Extra = {}): RunData =>
  ({
    design: { nodes: [], edges: [] },
    scenario: {},
    windows: [],
    result: {
      summary: { errorRate: err, throughputRps: 100, latencyMs: lat(p99), asyncLatencyMs: lat(0, 0) },
      nodes: Object.fromEntries([...new Set([...Object.keys(util), ...Object.keys(extra)])].map((id) => [id, { label: id.toUpperCase(), ...(id in util ? { utilization: util[id] } : {}), ...(extra[id] ?? {}) }])),
    },
  }) as unknown as RunData;

describe('course measures', () => {
  beforeAll(() => setLang('en'));

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
      for (const s of stepsOf(l.lesson)) if ('show' in s && s.show) for (const k of s.show) expect(measureOf(k), `${l.id} ${k}`).toBeDefined();
    }
  });
  it('recovery: seconds after the spike until every later second has fewer than 5% failed', () => {
    const w = (t: number, fail: number) => ({ t, dt: 1, measured: true, offered: 100, ok: 100 - fail, fail: { timeout: fail }, targetRps: 100, nodes: {} });
    const r = (fails: number[], spike = true) =>
      ({
        ...run(10, 0, {}),
        scenario: { durationS: fails.length, events: spike ? [{ type: 'spike', atS: 2, forS: 2, factor: 3 }] : [] },
        windows: fails.map((f, k) => w(k + 1, f)),
        result: { ...run(10, 0, {}).result, measuredFromS: 0, measuredToS: fails.length, scenario: { durationS: fails.length, warmupS: 0 }, timeline: [] },
      }) as unknown as RunData;
    // the spike ends at 4 s; the last bad second ends at 7 s: 3 s after it
    const slow = r([0, 0, 50, 50, 50, 20, 10, 0, 0, 0, 0, 0]);
    const fast = r([0, 0, 50, 50, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(readings(['recovery'], fast, slow)[0]).toMatchObject({ before: '3 s', now: '0 s', change: 'better' });
    expect(readings(['recovery'], r([0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50]))[0].now).toBe('not before the end');
    expect(readings(['recovery'], r([0, 0, 0, 0], false))).toEqual([]);
  });

  it('degraded: share of all requests answered by a fallback; absent without a fallback', () => {
    const d = run(10, 0, {});
    (d.result.summary as { degraded?: number; offered: number }).degraded = 30;
    (d.result.summary as { offered: number }).offered = 200;
    expect(readings(['degraded'], d)[0].now).toBe('15%');
    expect(readings(['degraded'], run(10, 0, {}))).toEqual([]);
  });

  it('queuePeak: the most messages waiting in the fullest queue, with its name', () => {
    const q = (n: number) => run(10, 0, { api: 0.2 }, { jobs: { queueDepthMax: n }, other: { queueDepthMax: 3 } });
    expect(readings(['queuePeak'], q(120), q(4000))[0]).toMatchObject({ before: '4000', now: '120', who: 'JOBS', change: 'better' });
    expect(readings(['queuePeak'], run(10, 0, { api: 0.2 }))).toEqual([]);
  });

  it('hedgeExtra: second copies over first calls, on the hedged connections only', () => {
    const h = run(10, 0, {});
    (h.design as { edges: unknown[] }).edges = [{ from: 'api', to: 'db', hedgeMs: 50 }, { from: 'c', to: 'api' }];
    (h.result as { edges: unknown }).edges = { a: { from: 'api', to: 'db', calls: 1100, hedges: 100 }, b: { from: 'c', to: 'api', calls: 5000 } };
    expect(readings(['hedgeExtra'], h)[0].now).toBe('10%');
    expect(readings(['hedgeExtra'], run(10, 0, {}))).toEqual([]);
  });

  it('clientFail:<id>: the failed share of one client, by its id', () => {
    const c = (fail: number) => run(10, 0, {}, { small: { kind: 'client', arrivals: 200, fail }, big: { kind: 'client', arrivals: 1000, fail: 900 } });
    const row = readings(['clientFail:small'], c(2), c(150))[0];
    expect(row).toMatchObject({ key: 'clientFail:small', before: '75%', now: '1.0%', who: 'SMALL', change: 'better' });
    expect(row.label).toBe('Failed requests of SMALL');
    expect(measureOf('clientFail:small')).toBeDefined();
    expect(measureOf('clientFail:')).toBeUndefined();
    expect(measureOf('toString')).toBeUndefined();
    // no such client in this design: left out
    expect(readings(['clientFail:nobody'], c(2))).toEqual([]);
  });
  it('busiestInstance: the busiest single instance or shard, with its name', () => {
    const r = (hot: number) =>
      run(10, 0, { db: 0.3, api: 0.5 }, { db: { maxInstanceUtilization: hot, instances: [{ idx: 0, role: 'Shard 1 Primary', utilization: 0.1 }, { idx: 1, role: 'Shard 2 Primary', utilization: hot }] as never }, api: { maxInstanceUtilization: 0.5 } });
    const row = readings(['busiestInstance'], r(0.4), r(0.98))[0];
    expect(row).toMatchObject({ before: '98%', now: '50%', change: 'better' });
    // the hot shard, not the node average (30%)
    expect(readings(['busiestInstance'], r(0.98))[0]).toMatchObject({ now: '98%', who: 'DB Shard 2 Primary' });
    expect(readings(['busiest'], r(0.98))[0]).toMatchObject({ now: '50%', who: 'API' });
    expect(readings(['busiestInstance'], run(10, 0, {}))).toEqual([]);
  });

  it('util:<id>: how busy one component was, by its id', () => {
    const r = (u: number) => run(10, 0, { primary: u, replica: 0.1 });
    const row = readings(['util:primary'], r(0.2), r(0.9))[0];
    expect(row).toMatchObject({ key: 'util:primary', before: '90%', now: '20%', who: 'PRIMARY', change: 'better' });
    expect(row.label).toBe('How busy PRIMARY was');
    expect(measureOf('util:primary')).toBeDefined();
    expect(readings(['util:nobody'], r(0.2))).toEqual([]);
  });

  it('rejected and timedOut: failed requests split into turned away at once and timed out', () => {
    const r = (fail: Record<string, number>) => {
      const x = run(10, 0, {});
      Object.assign(x.result.summary, { offered: 1000, fail: { timeout: 0, queue_full: 0, error: 0, rate_limited: 0, shed: 0, circuit_open: 0, down: 0, throttled: 0, bulkhead: 0, codel: 0, ...fail } });
      return x;
    };
    // without CoDel requests wait and time out; with it they are dropped at once
    const before = r({ timeout: 300, error: 5 });
    const after = r({ codel: 120, queue_full: 30, timeout: 10 });
    expect(readings(['rejected', 'timedOut'], after, before).map((x) => [x.key, x.before, x.now, x.change])).toEqual([
      ['rejected', '0%', '15%', 'worse'],
      ['timedOut', '30%', '1.0%', 'better'],
    ]);
  });
  // a sharded database with 1 replica per shard: instances 0..3 are shard 0 primary, shard 0 replica 1, shard 1 primary, shard 1 replica 1
  const sharded = (hotIdx: number, hot: number, roles: string[]) => {
    const r = run(10, 0, { api: 0.5 }, {
      api: { maxInstanceUtilization: 0.6, instances: [{ idx: 0, role: '#0', utilization: 0.6 }, { idx: 1, role: '#1', utilization: 0.4 }] as never },
      db: { kind: 'sharded_db', label: 'Sharded database', utilization: 0.2, maxInstanceUtilization: hot, instances: roles.map((role, idx) => ({ idx, role, utilization: idx === hotIdx ? hot : 0.05 })) as never },
    });
    (r.design as { nodes: unknown[] }).nodes = [{ id: 'db', kind: 'sharded_db', params: { shards: 2, replicas: 1 } }, { id: 'api', kind: 'api', params: {} }];
    return r;
  };
  const zhRoles = ['分片 0 主庫', '分片 0 副本 1', '分片 1 主庫', '分片 1 副本 1'];

  it('busiestInstance:<id>: the busiest instance of that component only, named like busiestInstance', () => {
    const r = sharded(2, 0.3, ['Shard 0 Primary', 'Shard 0 Replica 1', 'Shard 1 Primary', 'Shard 1 Replica 1']);
    // busiestInstance alone finds the API; the keyed one looks inside the database
    expect(readings(['busiestInstance'], r)[0]).toMatchObject({ who: 'API #0', now: '60%' });
    const row = readings(['busiestInstance:db'], r, sharded(2, 0.9, zhRoles))[0];
    expect(row).toMatchObject({ key: 'busiestInstance:db', before: '90%', now: '30%', change: 'better', who: 'Sharded database Shard 1 Primary' });
    expect(measureOf('busiestInstance:db')).toBeDefined();
    // the row names the component already: it shows only the instance
    expect(row.shown).toBe('Shard 1 Primary');
    expect(readings(['busiestInstance:nobody'], r)).toEqual([]);
    // a component with one instance: its utilization
    const one = readings(['busiestInstance:api'], run(10, 0, { api: 0.5 }, { api: { maxInstanceUtilization: 0.5 } }))[0];
    expect(one).toMatchObject({ now: '50%', who: 'API' });
    expect(one.shown).toBe('');
  });

  it('instance names are in the page language, whatever language the run was made in', () => {
    // a run made in Chinese (its roles are Chinese), shown on an English page
    const r = sharded(1, 0.95, zhRoles);
    expect(readings(['busiestInstance'], r)[0].who).toBe('Sharded database Shard 0 Replica 1');
    setLang('zh-TW');
    try {
      expect(readings(['busiestInstance'], sharded(1, 0.95, ['Shard 0 Primary', 'Shard 0 Replica 1', 'Shard 1 Primary', 'Shard 1 Replica 1']))[0].who).toBe('Sharded database 分片 0 副本 1');
    } finally {
      setLang('en');
    }
  });
});
