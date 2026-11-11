// M8, #68: the cost model. Sample prices (Q10=A): machines per hour, managed parts per million
// requests, traffic to users per GB.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/engine/index.ts';
import { SCENARIO_SCHEMA, type Design, type Scenario } from '../src/schema/design.ts';
import { CROSS_REGION, EGRESS, HOURS_PER_MONTH, MACHINE, MANAGED, STORAGE, costOf, machines, size } from '../src/learn/cost.ts';
import { design, scenario, within } from './helpers.ts';

const example = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, '..', 'examples/designs', `${name}.json`), 'utf8')) as Design;

function run(d: Design, s: Scenario) {
  const sim = new Simulation(d, s);
  const result = sim.runToEnd();
  return { result, windows: sim.drainWindows() };
}

const item = (c: ReturnType<typeof costOf>, id: string) => c.items.find((i) => i.id === id)!;

describe('machines', () => {
  it('a machine at its default size costs the listed price; half of it grows with its slots', () => {
    expect(size({ kind: 'service', params: {} })).toBe(1);
    expect(size({ kind: 'service', params: { concurrency: 64 } })).toBe(1.5);
    expect(size({ kind: 'service', params: { concurrency: 8 } })).toBe(0.625);
    expect(size({ kind: 'database', params: { connections: 100 } })).toBe(1.5);
    expect(size({ kind: 'load_balancer', params: {} })).toBe(0);
  });

  it('counts instances, database copies and shards', () => {
    const d = design(
      [
        ['u', 'client'],
        ['api', 'service', { instances: 3 }],
        ['db', 'database', { replicas: 2 }],
        ['s', 'sharded_db', { shards: 4, replicas: 1 }],
      ],
      [['u', 'api'], ['api', 'db'], ['api', 's']],
    );
    const c = costOf(d);
    expect(item(c, 'api').perHour).toBeCloseTo(3 * MACHINE.service.perHour, 9);
    expect(item(c, 'db').perHour).toBeCloseTo(3 * MACHINE.database.perHour, 9);
    expect(item(c, 's').perHour).toBeCloseTo(8 * MACHINE.sharded_db.perHour, 9);
    expect(item(c, 'api').what).toEqual({ text: '{k} 台 × 每台每小時 {p}', vars: { k: '3', p: '$0.08' } });
    expect(c.perMonth).toBeCloseTo(c.perHour * HOURS_PER_MONTH, 6);
    // without a run there are no request prices
    expect(c.withRequests).toBe(false);
    expect(c.items.some((i) => i.id === 'egress')).toBe(false);
  });

  it('more slots cost more, but less than another machine', () => {
    const base = costOf(design([['u', 'client'], ['api', 'service', { instances: 3, concurrency: 4 }]], [['u', 'api']])).perHour;
    const wider = costOf(design([['u', 'client'], ['api', 'service', { instances: 3, concurrency: 8 }]], [['u', 'api']])).perHour;
    const more = costOf(design([['u', 'client'], ['api', 'service', { instances: 4, concurrency: 4 }]], [['u', 'api']])).perHour;
    expect(wider).toBeGreaterThan(base);
    expect(more).toBeGreaterThan(wider);
  });

  it('an autoscaled node costs its average number serving in the run', () => {
    const d = design(
      [['u', 'client'], ['svc', 'service', { instances: 2, concurrency: 10, serviceMs: { mean: 50, cv: 0 }, queueLimit: 100000, autoscale: 'on', maxInstances: 10, targetUtil: 0.6, scaleEveryS: 5, bootS: 10, warmS: 0, scaleDownS: 0 }]],
      [['u', 'svc']],
    );
    const r = run(d, scenario({ seed: 1, durationS: 80, warmupS: 0, traffic: { rps: 300 }, events: [{ type: 'spike', atS: 10, forS: 70, multiplier: 2 }] }));
    const n = machines(d.nodes[1], r);
    expect(n).toBeGreaterThan(2);
    expect(n).toBeLessThan(r.result.nodes.svc.autoscale!.peakActive);
    expect(machines(d.nodes[1])).toBe(2);
  });
});

describe('requests and traffic', () => {
  it('a load balancer and a gateway charge per million requests; users cost per GB', () => {
    const d = design([['u', 'client'], ['gw', 'api_gateway'], ['lb', 'load_balancer'], ['api', 'service', { instances: 4 }]], [['u', 'gw'], ['gw', 'lb'], ['lb', 'api']]);
    const r = run(d, scenario({ seed: 1, durationS: 20, warmupS: 0, traffic: { rps: 500 } }));
    const c = costOf(d, r);
    expect(c.withRequests).toBe(true);
    // the measured rate: arrivals over the measured seconds, in millions per hour (about 1.8 at 500/s)
    const secs = r.result.measuredToS - r.result.measuredFromS;
    const mph = (r.result.nodes.gw.arrivals / secs) * 3600 / 1e6;
    expect(within(mph, 1.8, 0.05)).toBe(true);
    expect(item(c, 'gw').perHour).toBeCloseTo(MANAGED.api_gateway.perHour + mph * MANAGED.api_gateway.perMillion, 6);
    expect(item(c, 'lb').perHour).toBeCloseTo(MANAGED.load_balancer.perHour + mph * MANAGED.load_balancer.perMillion, 6);
    const users = (r.result.summary.offered / secs) * 3600;
    expect(item(c, 'egress').perHour).toBeCloseTo(((users * EGRESS.kbPerRequest) / 1e6) * EGRESS.perGb, 6);
    expect(c.perHour).toBeCloseTo(c.items.reduce((s, i) => s + i.perHour, 0), 6);
  });

  it('traffic between regions costs per GB: calls over an edge that joins two regions, and cache copies', () => {
    const d = example('region-cutover');
    const r = run(d, JSON.parse(readFileSync(join(import.meta.dirname, '..', 'examples/scenarios/region-cutover.json'), 'utf8')) as Scenario);
    const c = costOf(d, r);
    const secs = r.result.measuredToS - r.result.measuredFromS;
    // api_w -> db goes west to east; the caches copy each other's changes
    const calls = r.result.edges['api_w->db'].calls + (r.result.nodes.cache_w.replicationApplied ?? 0) + (r.result.nodes.cache_e.replicationApplied ?? 0)
      + (r.result.nodes.cache_w.replicationDropped ?? 0) + (r.result.nodes.cache_e.replicationDropped ?? 0);
    expect(r.result.edges['api_w->db'].calls).toBeGreaterThan(0);
    const gb = (((calls / secs) * 3600) * CROSS_REGION.kbPerCall) / 1e6;
    // the engine counts the copies that arrived (a call still on the wire at the end is not one)
    expect(within(item(c, 'cross-region').perHour, gb * CROSS_REGION.perGb, 0.01)).toBe(true);
    // one region (or none): no such item
    const one = example('three-tier');
    const c1 = costOf(one, run(one, { schema: SCENARIO_SCHEMA, seed: 1, durationS: 10, traffic: { rps: 100 } } as Scenario));
    expect(c1.items.some((i) => i.id === 'cross-region')).toBe(false);
  });

  const crossGb = (c: ReturnType<typeof costOf>) => (c.items.find((i) => i.id === 'cross-region')?.perHour ?? 0) / CROSS_REGION.perGb;
  const gbOf = (calls: number, r: ReturnType<typeof run>) => (((calls / (r.result.measuredToS - r.result.measuredFromS)) * 3600) * CROSS_REGION.kbPerCall) / 1e6;

  it('a database whose replicas are in another region: the reads they serve cross regions', () => {
    const d = design(
      [['users', 'client'], ['api', 'service', { instances: 2, concurrency: 64 }], ['db', 'database', { replicas: 2 }]],
      [['users', 'api'], ['api', 'db']],
    );
    d.nodes = d.nodes.map((n) => (n.id === 'api' ? { ...n, region: 'east' } : n.id === 'db' ? { ...n, region: 'east', replicaRegion: 'west' } : n));
    d.edges = d.edges.map((e) => (e.from === 'api' ? { from: e.from, to: e.to } : e));
    const r = run(d, scenario({ seed: 1, durationS: 20, warmupS: 0, traffic: { rps: 200, readRatio: 1 } }));
    // every read goes to a replica in the west
    expect(r.result.nodes.db.replicaReads!).toBeGreaterThan(3000);
    expect(within(crossGb(costOf(d, r)), gbOf(r.result.nodes.db.replicaReads!, r), 0.03)).toBe(true);
  });

  it('a fan-out edge between regions charges every copy it sends', () => {
    const d = design(
      [['users', 'client'], ['api', 'service', { instances: 2, concurrency: 64 }], ['db', 'database', { replicas: 2, connections: 100 }]],
      [['users', 'api'], ['api', 'db', { fanout: 3 }]],
    );
    d.nodes = d.nodes.map((n) => (n.id === 'api' ? { ...n, region: 'east' } : n.id === 'db' ? { ...n, region: 'west' } : n));
    d.edges = d.edges.map((e) => (e.from === 'api' ? { from: e.from, to: e.to, fanout: 3 } : e));
    const r = run(d, scenario({ seed: 1, durationS: 20, warmupS: 0, traffic: { rps: 200, readRatio: 0 } }));
    let copies = 0;
    for (const w of r.windows) if (w.measured) copies += w.edges['api->db']?.copies ?? 0;
    expect(copies).toBeGreaterThan(3000);
    expect(within(crossGb(costOf(d, r)), gbOf(copies, r), 0.02)).toBe(true);
  });

  it('cache copies count per edge: a copy from a cache in the same region is free', () => {
    const base = example('region-cutover');
    // a second west cache, also copied into cache_w: same region
    const more: Design = {
      ...base,
      nodes: [...base.nodes, { ...base.nodes.find((n) => n.id === 'cache_w')!, id: 'cache_w2', pos: [780, 550] }],
      edges: [...base.edges, { from: 'api_w', to: 'cache_w2' }, { from: 'cache_w2', to: 'cache_w' }],
    };
    const sc = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'examples/scenarios/region-cutover.json'), 'utf8')) as Scenario;
    const r0 = run(base, sc);
    const r1 = run(more, sc);
    expect(r1.result.nodes.cache_w.replicationApplied!).toBeGreaterThan(r0.result.nodes.cache_w.replicationApplied! + 1000);
    expect(within(crossGb(costOf(more, r1)), crossGb(costOf(base, r0)), 0.03)).toBe(true);
  });

  it('object storage charges its writes and reads apart', () => {
    const d = example('async-queue');
    const r = run(d, scenario({ seed: 1, durationS: 20, warmupS: 0, traffic: { rps: 200, readRatio: 0.7 } }));
    const blob = item(costOf(d, r), 'blob');
    // api -> blob carries the writes only: 30% of 200/s = 0.216 million per hour
    expect(blob.perHour).toBeCloseTo(0.216 * STORAGE.writePerMillion, 1);
    expect(blob.what.text).toBe('每小時讀 {r}、寫 {w} 百萬次');
    expect(blob.what.vars.r).toBe('0');
  });
});
