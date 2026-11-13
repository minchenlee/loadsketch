// A component id is an id, never a field name (roadmap-next M23, review): scaling a run back to full
// size multiplied a node named `write`, `read` or `origin` as if it were a count, its utilization too;
// and a node named `constructor` or `toString` read the prototype in loadUtilization() (NaN).
import { describe, expect, it } from 'vitest';
import { loadUtilization, simulatePeak } from '../src/engine/limit.ts';
import { scaleResult, scaleWindow, type ScalePlan } from '../src/engine/scale.ts';
import type { WindowStat } from '../src/engine/sim.ts';
import { SCENARIO_SCHEMA, type Scenario } from '../src/schema/design.ts';
import { design } from './helpers.ts';

const steady: Scenario = { schema: SCENARIO_SCHEMA, name: 's', traffic: { rps: 100 } };
/** users -> <id>: 1 instance × 256 slots, 50 ms; at 4096 rps it runs scaled down (k = 3). */
const wide = (id: string) => design([['users', 'client'], [id, 'service', { instances: 1, concurrency: 256, queueLimit: 2000, serviceMs: { mean: 50, cv: 0 } }]], [['users', id, { latencyMs: 0 }]]);

describe('a component id that is also a count field name or a prototype name', () => {
  const base = simulatePeak(wide('api'), steady, 4096);

  for (const id of ['write', 'read', 'origin', 'constructor', 'toString']) {
    it(`a scaled-down run (k > 1): "${id}" has the utilization and counts of "api"`, () => {
      const run = simulatePeak(wide(id), steady, 4096);
      expect(run.sim.scale).toBeGreaterThan(1);
      expect(run.sim.scale).toBe(base.sim.scale);
      expect(run.loadUtil[id]).toBeCloseTo(base.loadUtil.api, 6);
      expect(run.loadUtil[id]).toBeLessThan(1);
      // the counts are multiplied back once, as for "api"
      expect(run.sim.nodes[id].arrivals).toBe(base.sim.nodes.api.arrivals);
      // a service has instances, so the engine gives it a utilization
      expect(base.sim.nodes.api.utilization).toBeTypeOf('number');
      expect(run.sim.nodes[id].utilization).toBeCloseTo(base.sim.nodes.api.utilization!, 6);
      const w = run.sim.summary.offered;
      expect(w).toBe(base.sim.summary.offered);
    });
  }

  it('scaleWindow: the nodes and edges maps are entries by id; their count fields are multiplied, their shares are not', () => {
    const entry = () => ({ arrivals: 2, ok: 2, fail: 0, util: 0.5, queue: 1 });
    const edge = () => ({ calls: 2, read: 1, write: 1, fail: 0, retries: 0 });
    const w = { t: 1, dt: 1, measured: true, targetRps: 2, offered: 2, ok: 2, fail: { error: 0 }, latency: { count: 2, mean: 5, p50: 5, p95: 5, p99: 5 }, asyncDone: 0, asyncP99: 0, nodes: { write: entry(), read: entry(), origin: entry(), api: entry() }, edges: { write: edge(), fail: edge(), e1: edge() } } as unknown as WindowStat;
    scaleWindow(w, 3);
    for (const id of ['write', 'read', 'origin', 'api']) expect(w.nodes[id]).toEqual({ arrivals: 6, ok: 6, fail: 0, util: 0.5, queue: 3 });
    for (const id of ['write', 'fail', 'e1']) expect(w.edges[id]).toEqual({ calls: 6, read: 3, write: 3, fail: 0, retries: 0 });
    expect(w.offered).toBe(6);
    expect(w.latency).toEqual({ count: 6, mean: 5, p50: 5, p95: 5, p99: 5 });
  });

  it('scaleResult: the edges and APIs maps are entries by id (an API named "write" is an API)', () => {
    const lat = () => ({ count: 2, mean: 5, p50: 5, p95: 5, p99: 5 });
    const api = () => ({ op: 'write', offered: 2, ok: 1, fail: 1, errorRate: 0.5, latencyMs: lat() });
    const edge = () => ({ from: 'a', to: 'b', calls: 2, rps: 2, ok: 1, fail: 1, retries: 0, late: 0 });
    const r = { summary: { offered: 2, ok: 1, fail: { error: 1 }, errorRate: 0.5, throughputRps: 1, latencyMs: lat(), asyncLatencyMs: lat() }, bottleneck: null, nodes: {}, apis: { write: api(), read: api(), checkout: api() }, edges: { origin: edge(), e1: edge() } };
    scaleResult(r, { k: 3, nodes: {} } as unknown as ScalePlan);
    for (const id of ['write', 'read', 'checkout']) expect(r.apis[id as 'write']).toEqual({ op: 'write', offered: 6, ok: 3, fail: 3, errorRate: 0.5, latencyMs: { ...lat(), count: 6 } });
    for (const id of ['origin', 'e1']) expect(r.edges[id as 'e1']).toEqual({ from: 'a', to: 'b', calls: 6, rps: 6, ok: 3, fail: 3, retries: 0, late: 0 });
  });

  it('loadUtilization: "constructor" and "toString" are nodes; a node that is not there is undefined, not the prototype', () => {
    const win = (t: number) => ({ t, dt: 1, nodes: { constructor: { arrivals: 1, ok: 1, fail: 0, util: 0.25 }, toString: { arrivals: 1, ok: 1, fail: 0, util: 0.75 } } }) as unknown as WindowStat;
    const u = loadUtilization([win(1), win(2)], 0, 2);
    expect(u.constructor).toBe(0.25);
    expect(u.toString).toBe(0.75);
    expect(Object.keys(u).sort()).toEqual(['constructor', 'toString']);
    expect((u as Record<string, unknown>).valueOf).toBeUndefined();
    expect((u as Record<string, unknown>).hasOwnProperty).toBeUndefined();
  });
});
