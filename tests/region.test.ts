// Regions: a node's region, the latency of a call between regions, and a whole region failing.
import { describe, expect, it } from 'vitest';
import { simulate, Simulation } from '../src/engine/index.ts';
import { checkDesign, checkScenario, edgeLatencyMs, INTER_REGION_MS, parseDesign, regionsOf, type Design, type Scenario } from '../src/schema/design.ts';
import { diagnose } from '../src/learn/diagnose.ts';
import { design, scenario } from './helpers.ts';

type Ev = NonNullable<Scenario['events']>[number];

/** u → api → db; api in `apiRegion`, db in `dbRegion`; the api → db edge has no latency of its own. */
function twoTier(apiRegion: string, dbRegion: string, interRegionMs?: number): Design {
  const d = design(
    [['u', 'client'], ['api', 'service', { instances: 2, concurrency: 100, serviceMs: { mean: 1, cv: 0 } }], ['db', 'database', { readMs: { mean: 1, cv: 0 } }]],
    [['u', 'api'], ['api', 'db']],
  );
  const region: Record<string, string> = { api: apiRegion, db: dbRegion };
  d.nodes = d.nodes.map((n) => (region[n.id] ? { ...n, region: region[n.id] } : n));
  d.edges = d.edges.map((e) => (e.from === 'api' ? { from: e.from, to: e.to } : e));
  if (interRegionMs !== undefined) d.interRegionMs = interRegionMs;
  expect(parseDesign(d).ok).toBe(true);
  return d;
}
const sc = (events: Ev[] = []) => scenario({ durationS: 30, warmupS: 0, traffic: { rps: 200, readRatio: 1 }, events });

describe('regions', () => {
  it('an edge between two regions takes the inter-region latency; its own latencyMs wins', () => {
    expect(edgeLatencyMs({}, { kind: 'service', region: 'a' }, { region: 'b' })).toBe(INTER_REGION_MS);
    expect(edgeLatencyMs({}, { kind: 'service', region: 'a' }, { region: 'b' }, 30)).toBe(30);
    expect(edgeLatencyMs({ latencyMs: 2 }, { kind: 'service', region: 'a' }, { region: 'b' })).toBe(2);
    expect(edgeLatencyMs({}, { kind: 'service', region: 'a' }, { region: 'a' })).toBe(edgeLatencyMs({}, { kind: 'service' }));
    // no region on one side: not a cross-region call; a client is a user, not in a region
    expect(edgeLatencyMs({}, { kind: 'service', region: 'a' }, {})).toBe(edgeLatencyMs({}, { kind: 'service' }));
    expect(edgeLatencyMs({}, { kind: 'client', region: 'a' }, { region: 'b' })).toBe(edgeLatencyMs({}, { kind: 'client' }));
    expect(regionsOf({ nodes: [{}, { region: 'b' }, { region: 'a' }, { region: 'b' }] })).toEqual(['b', 'a']);
  });

  it('a database in another region adds a round trip to every request', () => {
    const same = simulate(twoTier('east', 'east'), sc());
    const far = simulate(twoTier('east', 'west'), sc());
    const near = simulate(twoTier('east', 'west', 10), sc());
    const extra = far.summary.latencyMs.p50 - same.summary.latencyMs.p50;
    expect(extra).toBeGreaterThan(2 * INTER_REGION_MS - 5);
    expect(extra).toBeLessThan(2 * INTER_REGION_MS + 5);
    expect(near.summary.latencyMs.p50 - same.summary.latencyMs.p50).toBeCloseTo(20, -1);
  });

  it('region_down takes every node of the region down for its window; clients stay up', () => {
    const sim = new Simulation(twoTier('east', 'east'), sc([{ type: 'region_down', atS: 10, forS: 5, region: 'east' }]));
    const r = sim.runToEnd();
    const failed = sim.allWindows().map((w) => w.fail.down ?? 0);
    expect(failed.slice(0, 10).every((x) => x === 0)).toBe(true);
    expect(failed.slice(10, 15).every((x) => x > 150)).toBe(true);
    expect(failed.slice(16).every((x) => x === 0)).toBe(true);
    const types = r.timeline.map((e) => e.type);
    expect(types).toContain('region_down');
    expect(types).toContain('region_up');
    // one entry for the region, not one per node
    expect(types.filter((x) => x === 'down')).toHaveLength(0);
    // a region with only the database: the api is up and its calls to the database fail
    const dbOnly = simulate(twoTier('east', 'west'), sc([{ type: 'region_down', atS: 10, forS: 5, region: 'west' }]));
    expect(dbOnly.nodes.db.fail).toBeGreaterThan(0);
    expect(dbOnly.nodes.api.arrivals).toBeGreaterThan(5500);
  });

  it('an event for a region no node is in is an error', () => {
    const d = twoTier('east', 'east');
    const issues = checkScenario(sc([{ type: 'region_down', atS: 1, region: 'mars' }]), d);
    expect(issues.some((i) => i.code === 'event-region' && i.level === 'error')).toBe(true);
    expect(checkScenario(sc([{ type: 'region_down', atS: 1, region: 'east' }]), d)).toEqual([]);
  });
});

/** u → dns → one load balancer and api per region (east, west), half the traffic each. */
function twoRegions(dns: Record<string, unknown> = {}): Design {
  const svc = { instances: 2, concurrency: 100, serviceMs: { mean: 2, cv: 0 } };
  const d = design(
    [['u', 'client'], ['dns', 'dns', { resolverCacheHit: 1, ...dns }], ['lbE', 'load_balancer'], ['apiE', 'service', svc], ['lbW', 'load_balancer'], ['apiW', 'service', svc]],
    [['u', 'dns'], ['dns', 'lbE'], ['dns', 'lbW'], ['lbE', 'apiE'], ['lbW', 'apiW']],
  );
  const region: Record<string, string> = { lbE: 'east', apiE: 'east', lbW: 'west', apiW: 'west' };
  d.nodes = d.nodes.map((n) => (region[n.id] ? { ...n, region: region[n.id] } : n));
  return d;
}
function failShares(d: Design, events: Ev[], durationS = 70) {
  const sim = new Simulation(d, scenario({ durationS, warmupS: 0, traffic: { rps: 400, readRatio: 1 }, events }));
  const r = sim.runToEnd();
  const ws = sim.allWindows();
  return { r, share: ws.map((w) => (w.fail.down ?? 0) / Math.max(1, w.offered)), east: ws.map((w) => w.nodes?.apiE?.arrivals ?? 0) };
}

describe('DNS failover', () => {
  const east: Ev = { type: 'region_down', atS: 10, forS: 30, region: 'east' };

  it('without failover, the share of traffic sent to the failed region keeps failing', () => {
    const { share } = failShares(twoRegions(), [east]);
    expect(share.slice(1, 10).every((x) => x === 0)).toBe(true);
    for (const x of share.slice(11, 39)) expect(x).toBeGreaterThan(0.4), expect(x).toBeLessThan(0.6);
  });

  it('with failover: half fails until detection, then less and less over the TTL, then none', () => {
    const { share, r } = failShares(twoRegions({ failover: 'on', detectS: 5, ttlS: 10 }), [east]);
    // detected after 5 s of checks (the check at 10 s may run before the region fails)
    for (const x of share.slice(11, 15)) expect(x).toBeGreaterThan(0.4);
    // halfway through the TTL about a quarter still goes to the old answer
    expect(share[21]).toBeGreaterThan(0.12);
    expect(share[21]).toBeLessThan(0.38);
    expect(share.slice(27, 70).every((x) => x === 0)).toBe(true);
    const types = r.timeline.map((e) => e.type);
    expect(types).toContain('dns_out');
    expect(types).toContain('dns_in');
  });

  it('the region comes back into the answer after detection and gets traffic again', () => {
    const { east: arrivals } = failShares(twoRegions({ failover: 'on', detectS: 5, ttlS: 10 }), [east]);
    expect(arrivals.slice(30, 40).every((x) => x === 0)).toBe(true);
    // back at 40 s, in the answer at about 45 s, all clients see it by about 56 s
    expect(arrivals[50]).toBeGreaterThan(0);
    const late = arrivals.slice(60, 70).reduce((a, b) => a + b, 0) / 10;
    expect(late).toBeGreaterThan(150);
    expect(late).toBeLessThan(250);
  });

  it('a request that misses the client cache gets the new answer', () => {
    const { share } = failShares(twoRegions({ failover: 'on', detectS: 3, ttlS: 600, resolverCacheHit: 0 }), [east]);
    expect(share.slice(15, 39).every((x) => x === 0)).toBe(true);
    // with most requests using the cache, a long TTL keeps sending about half × hit ratio to the failed region
    const cached = failShares(twoRegions({ failover: 'on', detectS: 3, ttlS: 600, resolverCacheHit: 0.8 }), [east]).share;
    expect(cached[20]).toBeGreaterThan(0.3);
    expect(cached[20]).toBeLessThan(0.5);
  });

  it('a TTL of 0 moves every client at once', () => {
    const { share } = failShares(twoRegions({ failover: 'on', detectS: 3, ttlS: 0 }), [east]);
    expect(share.slice(15, 39).every((x) => x === 0)).toBe(true);
  });
});

/** u → api → db (1 primary, 1 replica); half the requests are writes (100 writes/s). */
function withDb(db: Record<string, unknown>, place: { api?: string; db?: string; replicaRegion?: string } = {}): Design {
  const d = design(
    [
      ['u', 'client'],
      ['api', 'service', { instances: 2, concurrency: 200, serviceMs: { mean: 1, cv: 0 } }],
      ['db', 'database', { replicas: 1, replicaApplyRatio: 0.3, readMs: { mean: 2, cv: 0 }, writeMs: { mean: 2, cv: 0 }, failover: 'auto', failoverS: 10, ...db }],
    ],
    [['u', 'api'], ['api', 'db', { timeoutMs: 1000 }]],
  );
  d.nodes = d.nodes.map((n) => {
    if (n.id === 'api' && place.api) return { ...n, region: place.api };
    if (n.id === 'db') return { ...n, ...(place.db ? { region: place.db } : {}), ...(place.replicaRegion ? { replicaRegion: place.replicaRegion } : {}) };
    return n;
  });
  expect(parseDesign(d).ok).toBe(true);
  return d;
}
function runDb(d: Design, events: Ev[], durationS = 50) {
  const sim = new Simulation(d, scenario({ durationS, warmupS: 0, traffic: { rps: 200, readRatio: 0.5 }, events }));
  const r = sim.runToEnd();
  return { r, failed: sim.allWindows().map((w) => Object.values(w.fail).reduce((a, b) => a + b, 0)) };
}
const primaryDown: Ev = { type: 'down', atS: 10, node: 'db', instance: 0 };

describe('database failover', () => {
  it('without failover, writes fail from the crash to the end; with it, only for failoverS', () => {
    const off = runDb(withDb({ failover: 'off', replicaDelayMs: 500 }), [primaryDown]);
    expect(off.failed.slice(12, 50).every((x) => x > 60)).toBe(true); // ~100 writes/s, Poisson
    expect(off.r.nodes.db.failovers).toBeUndefined();
    const on = runDb(withDb({ replicaDelayMs: 500 }), [primaryDown]);
    expect(on.failed.slice(11, 20).every((x) => x > 60)).toBe(true);
    expect(on.failed.slice(21, 50).every((x) => x === 0)).toBe(true);
    expect(on.r.nodes.db.failovers).toBe(1);
    expect(on.r.timeline.some((e) => e.type === 'failover')).toBe(true);
    // the replica becomes the primary
    expect(on.r.nodes.db.instances?.find((i) => i.idx === 1)?.role).toBe('主庫');
  });

  it('the writes lost are those still being shipped: about writes/s × replication delay', () => {
    const slow = runDb(withDb({ replicaDelayMs: 500 }), [primaryDown]).r.nodes.db.lostWrites!;
    const fast = runDb(withDb({ replicaDelayMs: 0 }), [primaryDown]).r.nodes.db.lostWrites!;
    expect(slow).toBeGreaterThan(30); // 100 writes/s × 0.5 s = 50
    expect(slow).toBeLessThan(75);
    expect(fast).toBeLessThan(5);
  });

  it('a primary back before failoverS: no failover', () => {
    const r = runDb(withDb({}), [{ ...primaryDown, forS: 5 }]).r;
    expect(r.nodes.db.failovers).toBe(0);
    expect(r.nodes.db.lostWrites).toBe(0);
  });

  it('the old primary comes back as a replica and serves reads', () => {
    const { r, failed } = runDb(withDb({}), [{ ...primaryDown, forS: 15 }]);
    expect(r.nodes.db.failovers).toBe(1);
    expect(failed.slice(21, 50).every((x) => x === 0)).toBe(true);
    expect(r.nodes.db.instances?.find((i) => i.idx === 0)?.role).toBe('副本 1');
    expect(r.nodes.db.instances?.find((i) => i.idx === 0)?.started).toBeGreaterThan(0);
  });

  it('replicas in another region survive a region outage of the primary; replicas in the same region do not', () => {
    const outage: Ev = { type: 'region_down', atS: 10, region: 'east' };
    const far = withDb({ replicaDelayMs: 0 }, { api: 'west', db: 'east', replicaRegion: 'west' });
    far.interRegionMs = 100;
    const apart = runDb(far, [outage]);
    expect(apart.r.nodes.db.failovers).toBe(1);
    expect(apart.failed.slice(21, 50).every((x) => x === 0)).toBe(true);
    // the cross-region trip (100 ms) alone loses about 100 writes/s × 0.1 s
    expect(apart.r.nodes.db.lostWrites).toBeGreaterThan(4);
    expect(apart.r.nodes.db.lostWrites).toBeLessThan(20);
    const together = runDb(withDb({ replicaDelayMs: 0 }, { api: 'west', db: 'east' }), [outage]);
    expect(together.r.nodes.db.failovers).toBe(0);
    expect(together.r.timeline.some((e) => e.type === 'failover_none')).toBe(true);
    expect(together.failed.slice(21, 50).every((x) => x > 150)).toBe(true);
  });

  it('checks: a replica region without replicas, failover without replicas', () => {
    const d = withDb({ replicas: 0 }, { replicaRegion: 'west' });
    const codes = checkDesign(d).map((i) => i.code);
    expect(codes).toContain('replica-region');
    expect(codes).toContain('failover-no-replica');
    expect(regionsOf(d)).toEqual(['west']);
  });
});

describe('region outages', () => {
  it('a node down for longer than a region outage stays down after the region recovers', () => {
    const sim = new Simulation(
      twoTier('east', 'east'),
      sc([{ type: 'down', atS: 0, forS: 25, node: 'db' }, { type: 'region_down', atS: 10, forS: 5, region: 'east' }]),
    );
    sim.runToEnd();
    const dbFails = sim.allWindows().map((w) => w.nodes.db?.fail ?? 0);
    expect(dbFails.slice(16, 25).every((x) => x > 150)).toBe(true);
    expect(dbFails.slice(26, 30).every((x) => x === 0)).toBe(true);
  });

  it('a request inside a load balancer when its region fails is not forwarded', () => {
    // a slow load balancer in east in front of a service in west: many requests are inside it
    const d = design(
      [['u', 'client'], ['lb', 'load_balancer', { latencyMs: { mean: 200, cv: 0 } }], ['api', 'service', { instances: 2, concurrency: 100, serviceMs: { mean: 1, cv: 0 } }]],
      [['u', 'lb'], ['lb', 'api']],
    );
    d.nodes = d.nodes.map((n) => (n.id === 'lb' ? { ...n, region: 'east' } : n.id === 'api' ? { ...n, region: 'west' } : n));
    const sim = new Simulation(d, scenario({ durationS: 20, warmupS: 0, traffic: { rps: 400, readRatio: 1 }, events: [{ type: 'region_down', atS: 10, region: 'east' }] }));
    sim.runToEnd();
    const ws = sim.allWindows();
    const at = (t0: number) => ws.find((w) => Math.abs(w.t - t0) < 1e-6)!;
    expect(at(10).nodes.api.arrivals).toBeGreaterThan(300);
    // the second after the outage starts: nothing gets through
    expect(at(11).nodes.api.arrivals).toBe(0);
  });

  it('two outages of different regions both appear in the story', () => {
    const design = twoRegions();
    const sc2 = scenario({ durationS: 40, warmupS: 0, traffic: { rps: 200, readRatio: 1 }, events: [
      { type: 'region_down', atS: 10, forS: 5, region: 'east' },
      { type: 'region_down', atS: 20, forS: 5, region: 'west' },
    ] });
    const sim = new Simulation(design, sc2);
    const result = sim.runToEnd();
    const story = diagnose({ design, scenario: sc2, result, windows: sim.allWindows() });
    expect(story.filter((s) => s.text.includes('整區故障'))).toHaveLength(2);
  });
});

describe('a database in two regions', () => {
  // api in east; db primary in east, replica 1 in east (localReplicas 1), replica 2 in west
  const split = (db: Record<string, unknown> = {}) => {
    const d = withDb({ replicas: 2, localReplicas: 1, readFrom: 'replicas', replicaDelayMs: 0, ...db }, { api: 'east', db: 'east', replicaRegion: 'west' });
    // the api → db latency comes from the regions
    d.edges = d.edges.map((e) => (e.from === 'api' ? { from: e.from, to: e.to, timeoutMs: e.timeoutMs } : e));
    return d;
  };

  it("reads go to the replica in the caller's region", () => {
    const r = simulate(split(), scenario({ durationS: 20, warmupS: 0, traffic: { rps: 200, readRatio: 1 } }));
    const started = (idx: number) => r.nodes.db.instances!.find((i) => i.idx === idx)!.started;
    expect(started(1)).toBeGreaterThan(3500);
    expect(started(2)).toBe(0);
    // no cross-region trip: about the edge and service times only
    expect(r.summary.latencyMs.p50).toBeLessThan(40);
  });

  it("a caller in the replica's region reads locally and writes across", () => {
    const west = (readRatio: number) => {
      const d = split();
      d.nodes = d.nodes.map((n) => (n.id === 'api' ? { ...n, region: 'west' } : n));
      return simulate(d, scenario({ durationS: 20, warmupS: 0, traffic: { rps: 100, readRatio } }));
    };
    const reads = west(1);
    expect(reads.nodes.db.instances!.find((i) => i.idx === 2)!.started).toBeGreaterThan(1500);
    expect(reads.summary.latencyMs.p50).toBeLessThan(40);
    // writes go to the primary in east: one round trip across
    const writes = west(0).summary.latencyMs.p50;
    expect(writes).toBeGreaterThan(2 * INTER_REGION_MS);
    expect(writes).toBeLessThan(2 * INTER_REGION_MS + 40);
  });

  it('an inter-region latency below the local one never schedules in the past', () => {
    const d = split();
    d.interRegionMs = 0;
    d.nodes = d.nodes.map((n) => (n.id === 'api' ? { ...n, region: 'west' } : n));
    const sim = new Simulation(d, scenario({ durationS: 10, warmupS: 0, traffic: { rps: 100, readRatio: 0 } }));
    const at: number[] = [];
    const orig = (sim as unknown as { at: (t: number, f: () => void) => void }).at.bind(sim);
    (sim as unknown as { at: (t: number, f: () => void) => void }).at = (t, f) => {
      at.push(t - (sim as unknown as { now: number }).now);
      orig(t, f);
    };
    const r = sim.runToEnd();
    expect(r.summary.latencyMs.p50).toBeGreaterThan(0);
    expect(at.every((x) => x >= 0)).toBe(true);
  });

  it('after a failover to the far region, every write pays a round trip across regions', () => {
    const before = simulate(split(), scenario({ durationS: 40, warmupS: 0, traffic: { rps: 100, readRatio: 0 } }));
    const sim = new Simulation(split(), scenario({ durationS: 40, warmupS: 0, traffic: { rps: 100, readRatio: 0 }, events: [
      // the primary and the local replica fail; only the far replica can take over
      { type: 'down', atS: 5, forS: 20, node: 'db', instance: 0 },
      { type: 'down', atS: 5, forS: 20, node: 'db', instance: 1 },
    ] }));
    const r = sim.runToEnd();
    expect(r.nodes.db.failovers).toBe(1);
    const late = sim.allWindows().filter((w) => w.t > 25 && w.latency.count > 0);
    const p50 = late.reduce((a, w) => a + w.latency.p50, 0) / late.length;
    expect(p50 - before.summary.latencyMs.p50).toBeGreaterThan(2 * INTER_REGION_MS - 10);
  });
});

describe('failover review fixes', () => {
  it('a promoted replica drops the old replication backlog and takes writes at once', () => {
    // the replica is 4× slower until 10 s, so a backlog builds; failover is immediate at 10 s
    const d = withDb({ failoverS: 0, readFrom: 'primary', connections: 1, writeMs: { mean: 5, cv: 0 }, replicaApplyRatio: 1, queueLimit: 500 });
    const { r, failed } = runDb(d, [{ type: 'slow', atS: 0, forS: 10, node: 'db', instance: 1, multiplier: 4 }, primaryDown], 20);
    expect(r.nodes.db.failovers).toBe(1);
    // the backlog was hundreds of writes: all lost, none applied on the new primary
    expect(r.nodes.db.lostWrites).toBeGreaterThan(200);
    expect(failed.slice(11, 20).every((x) => x < 10)).toBe(true);
  });

  it('a slowdown of the whole database slows replication once, not twice', () => {
    // 1.5× slower: applying takes 7.5 ms for 100 writes/s (75 % busy), no backlog; twice would be 112 %
    const d = withDb({ failoverS: 0, readFrom: 'primary', connections: 1, writeMs: { mean: 5, cv: 0 }, replicaApplyRatio: 1, replicaDelayMs: 0, queueLimit: 500 });
    const { r } = runDb(d, [{ type: 'slow', atS: 0, node: 'db', multiplier: 1.5 }, primaryDown], 20);
    expect(r.nodes.db.failovers).toBe(1);
    expect(r.nodes.db.lostWrites).toBeLessThan(30);
  });

  it("a replica applies at its own speed, not the primary's", () => {
    // writes only, 100/s; 5 ms each is 50 % busy, 1.9× slower is 95 % busy
    const lag = (instance?: number) => {
      const d = withDb({ failover: 'off', connections: 1, writeMs: { mean: 5, cv: 0 }, replicaApplyRatio: 1, replicaDelayMs: 0, queueLimit: 5000 });
      const events: Ev[] = instance === undefined ? [] : [{ type: 'slow', atS: 0, node: 'db', instance, multiplier: 1.9 }];
      const sim = new Simulation(d, scenario({ durationS: 30, warmupS: 0, traffic: { rps: 100, readRatio: 0 }, events }));
      sim.runToEnd();
      return Math.max(...sim.allWindows().map((w) => w.nodes.db.replLagMs ?? 0));
    };
    const base = lag();
    // a slow primary: the replica still applies in 5 ms (about the base lag; 9.5 ms would double it)
    expect(lag(0)).toBeLessThan(base + 2);
    expect(lag(1)).toBeGreaterThan(20 * base);
  });

  it('a primary with a slowdown of 0 (instant) still replicates every write', () => {
    const d = withDb({ failover: 'off', replicaDelayMs: 0 });
    const sim = new Simulation(d, scenario({ durationS: 10, warmupS: 0, traffic: { rps: 200, readRatio: 0.5 }, events: [{ type: 'slow', atS: 0, node: 'db', instance: 0, multiplier: 0 }] }));
    const r = sim.runToEnd();
    // about 100 writes/s × 10 s, all applied on the replica
    expect(r.nodes.db.replicationApplied).toBeGreaterThan(900);
    expect(sim.allWindows().every((w) => Number.isFinite(w.nodes.db.replLagMs ?? 0))).toBe(true);
  });

  it('failover picks the replica missing the fewest writes, counting writes it missed while down', () => {
    const d = withDb({ replicas: 2, readFrom: 'primary' });
    const { r } = runDb(d, [{ type: 'down', atS: 0, forS: 5, node: 'db', instance: 1 }, primaryDown], 30);
    expect(r.nodes.db.instances?.find((i) => i.idx === 2)?.role).toBe('主庫');
    expect(r.nodes.db.lostWrites).toBeLessThan(10);
    // only the replica that was down: its missed writes are lost
    const one = runDb(withDb({ readFrom: 'primary' }), [{ type: 'down', atS: 0, forS: 5, node: 'db', instance: 1 }, primaryDown], 30).r;
    expect(one.nodes.db.lostWrites).toBeGreaterThan(400);
  });

  it('no replication tracking (apply cost 0): no failover, as the design check warns', () => {
    const { r, failed } = runDb(withDb({ replicaApplyRatio: 0 }), [primaryDown], 30);
    expect(r.nodes.db.failovers).toBe(0);
    expect(failed.slice(25, 30).every((x) => x > 60)).toBe(true);
  });

  it('a request inside a load balancer during a short outage fails even if the outage is over', () => {
    const d = design(
      [['u', 'client'], ['lb', 'load_balancer', { latencyMs: { mean: 200, cv: 0 } }], ['api', 'service', { instances: 2, concurrency: 100, serviceMs: { mean: 1, cv: 0 } }]],
      [['u', 'lb'], ['lb', 'api']],
    );
    d.nodes = d.nodes.map((n) => (n.id === 'lb' ? { ...n, region: 'east' } : n.id === 'api' ? { ...n, region: 'west' } : n));
    const r = simulate(d, scenario({ durationS: 20, warmupS: 0, traffic: { rps: 400, readRatio: 1 }, events: [{ type: 'region_down', atS: 10, forS: 0.1, region: 'east' }] }));
    // inside at 10 s: about 400/s × 0.2 s = 80; arriving during the outage: about 40
    expect(r.nodes.lb.fail).toBeGreaterThan(90);
  });
});
