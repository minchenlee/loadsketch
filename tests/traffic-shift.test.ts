// M9 (#72, #71): a traffic shift moves the weight of an edge (at once or linearly), a load
// balancer honours edge weights, and a cache → cache edge replicates sets and deletes across
// regions so a region cutover finds a warm cache.
import { describe, expect, it } from 'vitest';
import { Simulation, type WindowStat } from '../src/engine/index.ts';
import { DESIGN_SCHEMA, SCENARIO_SCHEMA, parseDesign, parseScenario, type Design, type Scenario, type ScenarioEvent } from '../src/schema/design.ts';
import { eventEdges, newEvent, usableTypes } from '../src/app/scenarioEdit.ts';

/** Every node gets a canvas position (the file format needs one). */
function placed(d: Design): Design {
  d.nodes.forEach((n, i) => ((n as { pos?: [number, number] }).pos ??= [i * 200, 0]));
  return d;
}

function run(d: Design, s: Scenario) {
  const sim = new Simulation(d, s);
  const result = sim.runToEnd();
  return { result, windows: sim.drainWindows(), timeline: sim.drainTimeline(0) };
}

const svc = (id: string, region?: string, instances = 2): Design['nodes'][number] => ({ id, kind: 'service', pos: [0, 0], ...(region ? { region } : {}), params: { instances, concurrency: 64, serviceMs: { mean: 2, cv: 0.5 } } });

/** users → (router) → a, b; b starts with weight 0. */
function twoWay(router: 'dns' | 'load_balancer' | 'client', wa = 1, wb = 0): Design {
  const nodes: Design['nodes'] = [{ id: 'users', kind: 'client', pos: [0, 0] }, svc('a'), svc('b')];
  const edges: Design['edges'] = [];
  const src = router === 'client' ? 'users' : 'r';
  if (router !== 'client') {
    nodes.push({ id: 'r', kind: router, pos: [0, 0], ...(router === 'load_balancer' ? { params: { healthCheck: 'instant' } } : {}) });
    edges.push({ from: 'users', to: 'r' });
  }
  edges.push({ from: src, to: 'a', weight: wa }, { from: src, to: 'b', weight: wb });
  return placed({ schema: DESIGN_SCHEMA, name: 'two way', nodes, edges } as Design);
}

const scenario = (events: ScenarioEvent[], over: Partial<Scenario> = {}): Scenario =>
  ({ schema: SCENARIO_SCHEMA, name: 'shift', seed: 3, durationS: 40, warmupS: 0, traffic: { rps: 400 }, events, ...over }) as Scenario;

const share = (ws: WindowStat[], lo: number, hi: number, id: string, other: string) => {
  const sel = ws.filter((w) => w.t > lo && w.t <= hi);
  const a = sel.reduce((t, w) => t + (w.nodes[id]?.arrivals ?? 0), 0);
  const b = sel.reduce((t, w) => t + (w.nodes[other]?.arrivals ?? 0), 0);
  return a / Math.max(1, a + b);
};

describe('shift event: schema and checks', () => {
  it('a valid shift parses; an unknown edge is an error; a shift out of a service warns', () => {
    const d = twoWay('dns');
    expect(parseDesign(d).ok).toBe(true);
    expect(parseScenario(scenario([{ type: 'shift', atS: 10, forS: 5, from: 'r', to: 'b', weight: 1 }]), d).ok).toBe(true);
    const bad = parseScenario(scenario([{ type: 'shift', atS: 10, from: 'r', to: 'nope', weight: 1 }]), d);
    expect(bad.ok).toBe(false);
    expect(bad.issues.map((i) => i.code)).toContain('event-edge');
    const chain = placed({ ...d, nodes: [...d.nodes, svc('c')], edges: [...d.edges, { from: 'a', to: 'c' }] } as Design);
    const warn = parseScenario(scenario([{ type: 'shift', atS: 10, from: 'a', to: 'c', weight: 0 }]), chain);
    expect(warn.ok).toBe(true);
    expect(warn.issues.map((i) => i.code)).toContain('event-shift-kind');
    expect(parseScenario(scenario([{ type: 'shift', atS: 10, from: 'r', to: 'b', weight: -1 } as ScenarioEvent]), d).ok).toBe(false);
  });

  it('the editor offers edges out of routers only, and a new shift aims at the first', () => {
    const d = { ...twoWay('dns'), nodes: [...twoWay('dns').nodes, svc('c')], edges: [...twoWay('dns').edges, { from: 'a', to: 'c' }] } as Design;
    expect(eventEdges(d).map((e) => `${e.from}->${e.to}`)).toEqual(['users->r', 'r->a', 'r->b']);
    expect(usableTypes(d).map((s) => s.type)).toContain('shift');
    expect(newEvent('shift', d, 40)).toEqual({ type: 'shift', atS: 10, forS: 10, from: 'users', to: 'r', weight: 0 });
  });
});

describe('shift event: the engine moves traffic', () => {
  it.each(['dns', 'client'] as const)('%s: at once (no forS): all traffic moves at that second', (router) => {
    const d = twoWay(router);
    const src = router === 'client' ? 'users' : 'r';
    const { windows, timeline } = run(d, scenario([
      { type: 'shift', atS: 20, from: src, to: 'a', weight: 0 },
      { type: 'shift', atS: 20, from: src, to: 'b', weight: 1 },
    ]));
    expect(share(windows, 1, 20, 'b', 'a')).toBe(0);
    // a request sent just before second 20 can arrive just after it
    expect(share(windows, 21, 40, 'b', 'a')).toBe(1);
    expect(timeline.filter((e) => e.type === 'shift')).toHaveLength(2);
  });

  it('linear over forS: the share grows with time, then holds', () => {
    const d = twoWay('dns');
    const { windows, timeline, result } = run(d, scenario([
      { type: 'shift', atS: 10, forS: 20, from: 'r', to: 'a', weight: 0 },
      { type: 'shift', atS: 10, forS: 20, from: 'r', to: 'b', weight: 1 },
    ]));
    expect(share(windows, 1, 10, 'b', 'a')).toBe(0);
    // weights (1 − f, f): b's share is f = (t − 10) / 20
    expect(share(windows, 14, 16, 'b', 'a')).toBeCloseTo(0.25, 1);
    expect(share(windows, 19, 21, 'b', 'a')).toBeCloseTo(0.5, 1);
    expect(share(windows, 24, 26, 'b', 'a')).toBeCloseTo(0.75, 1);
    expect(share(windows, 30.5, 40, 'b', 'a')).toBe(1);
    expect(timeline.filter((e) => e.type === 'shift_end')).toHaveLength(2);
    expect(result.summary.errorRate).toBe(0);
  });

  it('a client that loses its only positive edge sends nothing on; it comes back with the weight', () => {
    const d = twoWay('client', 1, 0);
    const { windows } = run(d, scenario([
      { type: 'shift', atS: 10, from: 'users', to: 'a', weight: 0 },
      { type: 'shift', atS: 20, from: 'users', to: 'a', weight: 1 },
    ]));
    const arr = (lo: number, hi: number) => windows.filter((w) => w.t > lo && w.t <= hi).reduce((t, w) => t + (w.nodes.a?.arrivals ?? 0), 0);
    expect(arr(11, 20)).toBe(0);
    expect(arr(21, 30)).toBeGreaterThan(3000);
  });
});

describe('load balancer: edge weights', () => {
  it('unequal weights split by weight; weight 0 gets nothing', () => {
    const { windows } = run(twoWay('load_balancer', 9, 1), scenario([]));
    expect(share(windows, 1, 40, 'b', 'a')).toBeCloseTo(0.1, 1);
    const zero = run(twoWay('load_balancer', 1, 0), scenario([]));
    expect(share(zero.windows, 1, 40, 'b', 'a')).toBe(0);
  });

  it('equal weights: the same run as no weights (one pool, no extra random draw)', () => {
    const plain = twoWay('load_balancer', 1, 1);
    for (const e of plain.edges) delete e.weight;
    const a = run(plain, scenario([])).result;
    const b = run(twoWay('load_balancer', 3, 3), scenario([])).result;
    expect(b.summary).toEqual(a.summary);
    expect(b.nodes.a.arrivals).toBe(a.nodes.a.arrivals);
  });

  it('an edge with no healthy target is skipped (the canary is down: traffic stays on the rest)', () => {
    const { result } = run(twoWay('load_balancer', 1, 9), scenario([{ type: 'down', atS: 0, node: 'b' }]));
    expect(result.summary.errorRate).toBe(0);
    expect(result.nodes.b.arrivals).toBe(0);
  });

  it('a gradual canary through the load balancer', () => {
    const { windows } = run(twoWay('load_balancer', 1, 0), scenario([{ type: 'shift', atS: 10, forS: 20, from: 'r', to: 'b', weight: 1 }]));
    // weights (1, f): b's share is f / (1 + f); at t = 30 it is 1/2
    expect(share(windows, 1, 10, 'b', 'a')).toBe(0);
    expect(share(windows, 19, 21, 'b', 'a')).toBeCloseTo(0.5 / 1.5, 1);
    expect(share(windows, 31, 40, 'b', 'a')).toBeCloseTo(0.5, 1);
  });
});

describe('cross-region cache replication (#71)', () => {
  /** users → DNS → api in us-east or us-west; each has a local LRU cache; one database in us-east. */
  function regions(replicate: boolean): Design {
    const cache = (id: string, region: string) => ({ id, kind: 'cache', region, params: { mode: 'lru', capacityKeys: 20000, ttlS: 600, instances: 2, concurrency: 64, opMs: { mean: 0.3, cv: 0.5 } } });
    return placed({
      schema: DESIGN_SCHEMA,
      name: 'two regions',
      nodes: [
        { id: 'users', kind: 'client' },
        { id: 'dns', kind: 'dns' },
        svc('api_e', 'us-east', 4),
        svc('api_w', 'us-west', 4),
        cache('cache_e', 'us-east'),
        cache('cache_w', 'us-west'),
        { id: 'db', kind: 'database', region: 'us-east', params: { connections: 32, readMs: { mean: 4, cv: 0.5 }, writeMs: { mean: 4, cv: 0.5 } } },
      ],
      edges: [
        { from: 'users', to: 'dns' },
        { from: 'dns', to: 'api_e', weight: 1 },
        { from: 'dns', to: 'api_w', weight: 0 },
        { from: 'api_e', to: 'cache_e' },
        { from: 'api_e', to: 'db' },
        { from: 'api_w', to: 'cache_w' },
        { from: 'api_w', to: 'db' },
        ...(replicate ? [{ from: 'cache_e', to: 'cache_w' }, { from: 'cache_w', to: 'cache_e' }] : []),
      ],
    } as Design);
  }
  it('a cache copy still on the wire when the run stops counts as unfinished work', () => {
    const d = regions(true);
    d.edges = d.edges.map((e) => (e.from === 'cache_e' && e.to === 'cache_w' ? { ...e, latencyMs: 600000 } : e));
    const { result } = run(d, scenario([], { durationS: 10 }));
    // nothing arrived; every copy sent is still travelling
    expect(result.nodes.cache_w.replicationApplied ?? 0).toBe(0);
    expect(result.unfinished).toBeGreaterThan(100);
  });

  const cutover = scenario(
    [
      { type: 'shift', atS: 30, from: 'dns', to: 'api_e', weight: 0 },
      { type: 'shift', atS: 30, from: 'dns', to: 'api_w', weight: 1 },
    ],
    { durationS: 45, keys: { count: 5000, zipf: 0.8 }, traffic: { rps: 400, readRatio: 0.9 } },
  );
  const after = (ws: WindowStat[], id: string) => ws.filter((w) => w.t > 30 && w.t <= 33).map((w) => w.nodes[id]?.hitRatio ?? 0);
  const dbReads = (ws: WindowStat[], lo: number, hi: number) => ws.filter((w) => w.t > lo && w.t <= hi).reduce((t, w) => t + (w.nodes.db?.arrivals ?? 0), 0) / (hi - lo);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

  it('the design with cache → cache edges is valid', () => {
    expect(parseDesign(regions(true)).issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(parseScenario(cutover, regions(true)).ok).toBe(true);
  });

  it('without replication: the west cache is cold after the cutover and the database load jumps', () => {
    const { windows } = run(regions(false), cutover);
    const east = mean(windows.filter((w) => w.t > 25 && w.t <= 30).map((w) => w.nodes.cache_e?.hitRatio ?? 0));
    expect(east).toBeGreaterThan(0.6);
    expect(mean(after(windows, 'cache_w'))).toBeLessThan(east - 0.25);
    expect(dbReads(windows, 30, 33)).toBeGreaterThan(1.5 * dbReads(windows, 25, 30));
  });

  it('with replication: the west cache is warm at the cutover; the copies are counted', () => {
    const cold = run(regions(false), cutover);
    const warm = run(regions(true), cutover);
    const east = mean(warm.windows.filter((w) => w.t > 25 && w.t <= 30).map((w) => w.nodes.cache_e?.hitRatio ?? 0));
    expect(mean(after(warm.windows, 'cache_w'))).toBeGreaterThan(east - 0.1);
    expect(mean(after(warm.windows, 'cache_w'))).toBeGreaterThan(mean(after(cold.windows, 'cache_w')) + 0.2);
    expect(dbReads(warm.windows, 30, 33)).toBeLessThan(dbReads(cold.windows, 30, 33) * 0.7);
    expect(warm.result.nodes.cache_w.replicationApplied).toBeGreaterThan(0);
    // and back: the west cache's own fills are copied to the east after the cutover
    expect(warm.result.nodes.cache_e.replicationApplied).toBeGreaterThan(0);
    expect(cold.result.nodes.cache_w.replicationApplied).toBeUndefined();
  });

  it('a delete is copied too: with writes only, every invalidation in the east reaches the west', () => {
    // writes only: the caches are never filled, only invalidated (cache-aside deletes on write)
    const s = scenario([], { durationS: 20, keys: { count: 500 }, traffic: { rps: 200, readRatio: 0 } });
    const { result } = run(regions(true), s);
    const deletes = result.nodes.cache_e.arrivals;
    expect(deletes).toBeGreaterThan(2000);
    expect(result.nodes.cache_w.arrivals).toBe(0);
    // copies still on the way at the end are not counted
    expect(result.nodes.cache_w.replicationApplied).toBeGreaterThan(deletes * 0.95);
    expect(result.nodes.cache_w.replicationApplied).toBeLessThanOrEqual(deletes);
    // a copied change is not copied back
    expect(result.nodes.cache_e.replicationApplied).toBeUndefined();
  });
});

describe('shift event: one after another', () => {
  it('a shift that starts when the previous one on the same edge ends starts from its final weight', () => {
    const d = twoWay('dns');
    const s = scenario([
      { type: 'shift', atS: 5, forS: 4, from: 'r', to: 'b', weight: 1 },
      { type: 'shift', atS: 9, forS: 4, from: 'r', to: 'b', weight: 3 },
    ]);
    const sim = new Simulation(d, s);
    const weight = () => (sim as unknown as { edges: { from: { id: string }; to: { id: string }; weight: number }[] }).edges.find((e) => e.from.id === 'r' && e.to.id === 'b')!.weight;
    sim.runUntil(9_700);
    // one step (0.5 s of 4 s) from 1 towards 3
    expect(weight()).toBeCloseTo(1.25, 6);
    sim.runUntil(14_000);
    expect(weight()).toBe(3);
  });
});
