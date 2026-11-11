// Consistency: row-lock contention (#29), read-your-writes (#28), and a network partition
// that splits a database with automatic failover into two primaries (#64).
import { describe, expect, it } from 'vitest';
import { simulate, Simulation } from '../src/engine/index.ts';
import { checkScenario, parseDesign, parseScenario, type Design, type Scenario } from '../src/schema/design.ts';
import { design, scenario } from './helpers.ts';

type Ev = NonNullable<Scenario['events']>[number];

describe('row locks', () => {
  const db = (p: Record<string, unknown> = {}) =>
    design([['users', 'client'], ['db', 'database', { connections: 50, writeMs: { mean: 10, cv: 0 }, queueLimit: 100000, ...p }]], [['users', 'db']]);
  const sc = (rps: number, keys: { count: number; zipf?: number }) =>
    scenario({ seed: 3, durationS: 20, warmupS: 2, traffic: { rps, readRatio: 0 }, keys });

  it('writes to one row run one at a time: at most 1 / (writeMs + lockHoldMs) per second', () => {
    const free = simulate(db(), sc(300, { count: 1 }));
    const locked = simulate(db({ locks: 'row' }), sc(300, { count: 1 }));
    // 50 connections do 300 writes/s of 10 ms easily without locks
    expect(free.nodes.db.lockWaits).toBeUndefined();
    expect(free.summary.latencyMs.p99).toBeLessThan(15);
    // with a row lock: 100 writes/s at most; the rest wait and time out
    // measured after the 2 s warm-up
    const okRate = locked.nodes.db.ok / 18;
    expect(okRate).toBeLessThanOrEqual(101);
    expect(okRate).toBeGreaterThan(90);
    expect(locked.nodes.db.lockWaits!).toBeGreaterThan(1000);
    const held = simulate(db({ locks: 'row', lockHoldMs: 10 }), sc(300, { count: 1 }));
    expect(held.nodes.db.ok / 18).toBeLessThanOrEqual(51);
  });

  it('a hot key makes writes wait for its lock; spread keys hardly wait', () => {
    const hot = simulate(db({ locks: 'row' }), sc(60, { count: 1000, zipf: 1.4 }));
    const off = simulate(db(), sc(60, { count: 1000, zipf: 1.4 }));
    const flat = simulate(db({ locks: 'row' }), sc(60, { count: 100000, zipf: 0 }));
    expect(hot.nodes.db.lockWaits!).toBeGreaterThan(50);
    expect(hot.summary.latencyMs.p99).toBeGreaterThan(off.summary.latencyMs.p99 + 5);
    expect(flat.nodes.db.lockWaits!).toBeLessThan(10);
    expect(off.nodes.db.lockWaits).toBeUndefined();
  });

  it('locks off changes nothing; locks on keeps the run at full size', () => {
    const base = design([['users', 'client'], ['db', 'database', { connections: 1000 }]], [['users', 'db']]);
    const s = sc(200, { count: 50 });
    expect(JSON.stringify(simulate(db({ locks: 'off' }), s))).toBe(JSON.stringify(simulate(db(), s)));
    const big = scenario({ durationS: 600, traffic: { rps: 5000, readRatio: 0.5 } });
    expect(new Simulation(base, big).scalePlan.k).toBeGreaterThan(1);
    const lockedBase = { ...base, nodes: base.nodes.map((n) => (n.id === 'db' ? { ...n, params: { ...n.params, locks: 'row' } } : n)) };
    expect(new Simulation(lockedBase, big).scalePlan.k).toBe(1);
  });

  it('a crash frees the locks: writes after recovery do not wait for dead transactions', () => {
    const d = db({ locks: 'row' });
    const r = simulate(d, scenario({ seed: 3, durationS: 20, warmupS: 0, traffic: { rps: 50, readRatio: 0 }, keys: { count: 1 }, events: [{ type: 'down', node: 'db', atS: 5, forS: 2 }] }));
    // 50 writes/s on one row fit (100/s): after the outage they flow again
    expect(r.nodes.db.ok).toBeGreaterThan(50 * 17 * 0.9);
  });
});

describe('read-your-writes', () => {
  const db = (p: Record<string, unknown> = {}) =>
    design([['users', 'client'], ['db', 'database', { replicas: 2, replicaDelayMs: 300, ...p }]], [['users', 'db']]);
  const sc = (traffic: Partial<Scenario['traffic']> = {}) =>
    scenario({ seed: 2, durationS: 30, warmupS: 0, traffic: { rps: 200, readRatio: 0.5, followReads: 0.5, followAfterMs: 100, ...traffic } });

  it('a read soon after the user\'s own write, on a lagging replica, misses it', () => {
    const r = simulate(db(), sc()).nodes.db;
    // about 100 writes/s, half followed by a read 100 ms later, while the replica is 300 ms behind
    expect(r.rywMisses!).toBeGreaterThan(30 * 100 * 0.5 * 0.8);
    // a read after the replica caught up sees it
    const late = simulate(db(), sc({ followAfterMs: 1000 })).nodes.db;
    expect(late.rywMisses!).toBeLessThan(r.rywMisses! / 50);
  });

  it('readYourWrites=primary sends those reads to the primary: no misses, more primary reads', () => {
    const plain = simulate(db(), sc());
    const ryw = simulate(db({ readYourWrites: 'primary' }), sc());
    expect(ryw.nodes.db.rywMisses).toBe(0);
    const prim = (r: typeof plain) => r.nodes.db.instances!.find((i) => i.idx === 0)!.started;
    // the primary also serves about 50 follow-up reads per second
    expect(prim(ryw) - prim(plain)).toBeGreaterThan(30 * 50 * 0.8);
    // a window shorter than the follow-up delay does not help
    const short = simulate(db({ readYourWrites: 'primary', rywWindowMs: 50 }), sc());
    expect(short.nodes.db.rywMisses!).toBeGreaterThan(ryw.nodes.db.rywMisses! + 500);
  });

  it('followReads 0 (the default) keeps the run exactly as before', () => {
    const a = simulate(db(), sc({ followReads: 0 }));
    const b = simulate(db(), scenario({ seed: 2, durationS: 30, warmupS: 0, traffic: { rps: 200, readRatio: 0.5 } }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(b.nodes.db.rywMisses).toBeUndefined();
  });

  it('with APIs the follow-up read calls the client\'s read API; no read API, no follow-up', () => {
    const apis = [{ name: 'post', op: 'write' as const, share: 1 }, { name: 'get', op: 'read' as const, share: 1 }];
    const withRead = design([['users', 'client'], ['db', 'database', { replicas: 1, replicaDelayMs: 300 }]], [['users', 'db']], 't', apis);
    const r = simulate(withRead, sc());
    expect(r.nodes.db.rywMisses!).toBeGreaterThan(500);
    expect(r.apis!.get.offered).toBeGreaterThan(r.apis!.post.offered * 1.3);
    const writeOnly = design([['users', 'client'], ['db', 'database', { replicas: 1, replicaDelayMs: 300 }]], [['users', 'db']], 't', [apis[0]]);
    expect(simulate(writeOnly, sc()).nodes.db.rywMisses).toBe(0);
  });
});

describe('network partition', () => {
  /** Users reach an api in each region; both call one database: primary in east, its replica in west. */
  function split(db: Record<string, unknown> = {}): Design {
    const api = { instances: 2, concurrency: 200, serviceMs: { mean: 1, cv: 0 } };
    const d = design(
      [['users', 'client'], ['apiE', 'service', api], ['apiW', 'service', api], ['db', 'database', { replicas: 1, failover: 'auto', failoverS: 5, ...db }]],
      [['users', 'apiE'], ['users', 'apiW'], ['apiE', 'db', { timeoutMs: 500 }], ['apiW', 'db', { timeoutMs: 500 }]],
    );
    const region: Record<string, string> = { apiE: 'east', apiW: 'west', db: 'east' };
    d.nodes = d.nodes.map((n) => (region[n.id] ? { ...n, region: region[n.id], ...(n.id === 'db' ? { replicaRegion: 'west' } : {}) } : n));
    d.edges = d.edges.map((e) => (e.from !== 'users' ? { from: e.from, to: e.to, timeoutMs: 500 } : e));
    expect(parseDesign(d).ok).toBe(true);
    return d;
  }
  const cut: Ev = { type: 'partition', atS: 10, forS: 30, regions: ['east', 'west'] };
  const sc = (events: Ev[] = [cut]) => scenario({ seed: 4, durationS: 60, warmupS: 0, traffic: { rps: 200, readRatio: 0.5 }, events });

  it('the replicas\' side promotes a primary while the old one keeps taking writes: split brain', () => {
    const sim = new Simulation(split(), sc());
    const r = sim.runToEnd();
    expect(r.nodes.db.failovers).toBe(1);
    expect(r.nodes.db.divergentWrites!).toBeGreaterThan(25 * 50 * 0.8);
    const types = r.timeline.map((e) => e.type);
    expect(types).toContain('partition');
    expect(types).toContain('partition_end');
    expect(r.timeline.find((e) => e.type === 'divergence')!.text).toMatch(/\d+/);
    // before the failover the west side cannot write (the primary is cut off): timeouts
    const w = sim.allWindows();
    expect(w.slice(11, 14).every((x) => (x.fail.timeout ?? 0) > 20)).toBe(true);
    // after the failover both sides write again (to different primaries)
    expect(w.slice(17, 39).every((x) => (x.fail.timeout ?? 0) + (x.fail.down ?? 0) < 5)).toBe(true);
    // healed: everything flows again
    expect(w.slice(42, 59).every((x) => (x.fail.timeout ?? 0) + (x.fail.down ?? 0) === 0)).toBe(true);
  });

  it('fencing: the old primary refuses writes once the new one is up; no divergence', () => {
    const sim = new Simulation(split({ fencing: 'on' }), sc());
    const r = sim.runToEnd();
    expect(r.nodes.db.failovers).toBe(1);
    expect(r.nodes.db.divergentWrites).toBeUndefined();
    // the east side cannot write during the rest of the partition
    const w = sim.allWindows();
    expect(w.slice(17, 39).every((x) => (x.fail.down ?? 0) > 20)).toBe(true);
    expect(w.slice(42, 59).every((x) => (x.fail.down ?? 0) === 0)).toBe(true);
  });

  it('a partition shorter than failoverS causes no failover', () => {
    const r = simulate(split(), sc([{ type: 'partition', atS: 10, forS: 3, regions: ['east', 'west'] }]));
    expect(r.nodes.db.failovers).toBe(0);
    expect(r.nodes.db.divergentWrites).toBeUndefined();
  });

  it('without failover the cut side times out and nothing diverges; the scenario check wants two known regions', () => {
    const r = simulate(split({ failover: 'off' }), sc());
    expect(r.nodes.db.divergentWrites).toBeUndefined();
    expect(r.summary.fail.timeout).toBeGreaterThan(30 * 50 * 0.8);
    const d = split();
    const codes = (ev: Ev) => checkScenario(sc([ev]), d).map((i) => i.code);
    expect(codes(cut)).toEqual([]);
    expect(codes({ ...cut, regions: ['east', 'east'] })).toContain('event-partition');
    expect(codes({ ...cut, regions: ['east', 'mars'] })).toContain('event-region');
    expect(parseScenario({ ...sc(), events: [{ type: 'partition', atS: 1, regions: ['east'] }] }).ok).toBe(false);
  });
});

describe('review fixes', () => {
  const placeIn = (d: Design, region: Record<string, string>, replica?: Record<string, string>): Design => {
    d.nodes = d.nodes.map((n) => (region[n.id] ? { ...n, region: region[n.id], ...(replica?.[n.id] ? { replicaRegion: replica[n.id] } : {}) } : n));
    expect(parseDesign(d).ok).toBe(true);
    return d;
  };

  it('fencing: a write still running on the old primary when the partition heals does not commit', () => {
    // writes take 31 s: the ones started before the failover finish after the heal at 40 s
    const d = placeIn(
      design(
        [['users', 'client'], ['apiE', 'service', { instances: 2, concurrency: 5000 }], ['apiW', 'service', { instances: 2, concurrency: 5000 }],
          ['db', 'database', { replicas: 1, failover: 'auto', failoverS: 5, fencing: 'on', connections: 6000, queueLimit: 100000, writeMs: { mean: 31000, cv: 0 } }]],
        [['users', 'apiE'], ['users', 'apiW'], ['apiE', 'db'], ['apiW', 'db']],
      ),
      { apiE: 'east', apiW: 'west', db: 'east' }, { db: 'west' },
    );
    const sim = new Simulation(d, scenario({ seed: 4, durationS: 60, warmupS: 0, traffic: { rps: 200, readRatio: 0.5, clientTimeoutMs: 600000 }, events: [{ type: 'partition', atS: 10, forS: 30, regions: ['east', 'west'] }] }));
    const r = sim.runToEnd();
    // the writes started at 9–10 s commit at 40–41 s, after the heal: the old primary is a replica
    // by then and must refuse them, so the database answers only reads (about 100/s) in that second
    expect(sim.allWindows().find((w) => w.t === 41)!.nodes.db.ok).toBeLessThan(140);
    expect(r.nodes.db.divergentWrites).toBeUndefined();
  });

  it('a reply that would cross a partition that started meanwhile is lost: the caller times out', () => {
    const d = placeIn(
      design([['users', 'client'], ['api', 'service', { instances: 2, concurrency: 500 }], ['db', 'database', { connections: 500, readMs: { mean: 400, cv: 0 } }]], [['users', 'api'], ['api', 'db', { timeoutMs: 2000 }]]),
      { api: 'west', db: 'east' },
    );
    const sim = new Simulation(d, scenario({ seed: 1, durationS: 15, warmupS: 0, traffic: { rps: 100, readRatio: 1 }, events: [{ type: 'partition', atS: 10, regions: ['east', 'west'] }] }));
    sim.runToEnd();
    // reads that reached the database at 9.6–10 s finish during the cut: none succeeds after 10 s
    expect(sim.allWindows().filter((w) => w.t > 10).reduce((a, w) => a + w.ok, 0)).toBe(0);
  });

  it('a cache copy sent during a partition is dropped even when it would arrive after the heal', () => {
    const cache = () => ({ mode: 'lru', capacityKeys: 20000, ttlS: 600, instances: 2, concurrency: 64, opMs: { mean: 0.3, cv: 0 } });
    const d = placeIn(
      design(
        [['users', 'client'], ['api', 'service', { instances: 2, concurrency: 64 }], ['ce', 'cache', cache()], ['cw', 'cache', cache()], ['db', 'database', { connections: 64 }]],
        [['users', 'api'], ['api', 'ce'], ['api', 'db'], ['ce', 'cw', { latencyMs: 5000 }]],
      ),
      { api: 'east', ce: 'east', cw: 'west', db: 'east' },
    );
    // writes only: every write deletes its key in the east cache, which copies the delete west
    const r = simulate(d, scenario({ seed: 1, durationS: 30, warmupS: 0, keys: { count: 500 }, traffic: { rps: 200, readRatio: 0 }, events: [{ type: 'partition', atS: 5, forS: 10, regions: ['east', 'west'] }] }));
    // only the deletes sent from 15 s to 25 s arrive (about 2000); those sent 10–15 s are lost too
    expect(r.nodes.cw.replicationApplied!).toBeGreaterThan(1800);
    expect(r.nodes.cw.replicationApplied!).toBeLessThan(2200);
  });

  it('a scaled run multiplies the consistency and cross-region counters back', () => {
    const d = placeIn(
      design(
        [['users', 'client'], ['apiE', 'service', { instances: 2, concurrency: 256 }], ['apiW', 'service', { instances: 2, concurrency: 256 }],
          ['db', 'database', { replicas: 1, failover: 'auto', failoverS: 5, connections: 256, replicaDelayMs: 300 }]],
        [['users', 'apiE'], ['users', 'apiW'], ['apiE', 'db', { timeoutMs: 500 }], ['apiW', 'db', { timeoutMs: 500 }]],
      ),
      { apiE: 'east', apiW: 'west', db: 'east' }, { db: 'west' },
    );
    const sc = (scale: number) => scenario({ seed: 4, durationS: 40, warmupS: 0, scale, traffic: { rps: 400, readRatio: 0.5, followReads: 0.5 }, events: [{ type: 'partition', atS: 10, forS: 20, regions: ['east', 'west'] }] });
    const one = new Simulation(d, sc(1));
    const two = new Simulation(d, sc(2));
    expect(two.scalePlan.k).toBe(2);
    const a = one.runToEnd();
    const b = two.runToEnd();
    const near = (x: number, y: number) => expect(Math.abs(x - y) / y).toBeLessThan(0.25);
    near(b.nodes.db.divergentWrites!, a.nodes.db.divergentWrites!);
    near(b.nodes.db.rywMisses!, a.nodes.db.rywMisses!);
    const cross = (r: typeof a) => Object.values(r.edges).reduce((t, e) => t + (e.crossRegion ?? 0), 0);
    near(cross(b), cross(a));
  });

  it('queue deliveries to workers in another region count as cross-region traffic', () => {
    const d = placeIn(
      design([['users', 'client'], ['q', 'queue'], ['w', 'worker', { instances: 2, concurrency: 16 }]], [['users', 'q'], ['q', 'w']]),
      { q: 'east', w: 'west' },
    );
    const r = simulate(d, scenario({ seed: 1, durationS: 10, warmupS: 0, traffic: { rps: 100 } }));
    expect(r.edges['q->w'].calls).toBeGreaterThan(500);
    expect(r.edges['q->w'].crossRegion).toBe(r.edges['q->w'].calls);
  });
});

describe('review fixes', () => {
  const placeIn = (d: Design, region: Record<string, string>, replica?: Record<string, string>): Design => {
    d.nodes = d.nodes.map((n) => (region[n.id] ? { ...n, region: region[n.id], ...(replica?.[n.id] ? { replicaRegion: replica[n.id] } : {}) } : n));
    expect(parseDesign(d).ok).toBe(true);
    return d;
  };

  it('a reply already on its way back when the partition starts is lost too', () => {
    // 225 ms each way: reads done at 9.775–10 s are still travelling back at 10 s
    const d = placeIn(
      design([['users', 'client'], ['api', 'service', { instances: 2, concurrency: 500 }], ['db', 'database', { connections: 500, readMs: { mean: 1, cv: 0 } }]], [['users', 'api'], ['api', 'db', { timeoutMs: 2000, latencyMs: 225 }]]),
      { api: 'west', db: 'east' },
    );
    const sim = new Simulation(d, scenario({ seed: 1, durationS: 15, warmupS: 0, traffic: { rps: 100, readRatio: 1, arrivals: 'constant' }, events: [{ type: 'partition', atS: 10, regions: ['east', 'west'] }] }));
    sim.runToEnd();
    // a window's t is its end: the ones after 10 s
    expect(sim.allWindows().filter((w) => w.t > 10).reduce((a, w) => a + w.ok, 0)).toBe(0);
  });

  it('cache copies dropped at a partition still count as traffic between regions', () => {
    const cache = () => ({ mode: 'lru', capacityKeys: 20000, ttlS: 600, instances: 2, concurrency: 64, opMs: { mean: 0.3, cv: 0 } });
    const d = placeIn(
      design(
        [['users', 'client'], ['api', 'service', { instances: 2, concurrency: 64 }], ['ce', 'cache', cache()], ['cw', 'cache', cache()], ['db', 'database', { connections: 64 }]],
        [['users', 'api'], ['api', 'ce'], ['api', 'db'], ['ce', 'cw']],
      ),
      { api: 'east', ce: 'east', cw: 'west', db: 'east' },
    );
    const sc = (events: Ev[]) => scenario({ seed: 1, durationS: 20, warmupS: 0, keys: { count: 500 }, traffic: { rps: 200, readRatio: 0, arrivals: 'constant' }, events });
    const free = simulate(d, sc([]));
    const cut = simulate(d, sc([{ type: 'partition', atS: 5, forS: 10, regions: ['east', 'west'] }]));
    expect(cut.nodes.cw.replicationDropped!).toBeGreaterThan(1500);
    expect(cut.edges['ce->cw'].crossRegion).toBe(free.edges['ce->cw'].crossRegion);
  });

  it('writes the old primary finishes after the heal show up as divergence in the timeline', () => {
    // writes take 31 s and fencing is off: the ones started before the heal commit after it
    const d = placeIn(
      design(
        [['users', 'client'], ['apiE', 'service', { instances: 2, concurrency: 5000 }], ['apiW', 'service', { instances: 2, concurrency: 5000 }],
          ['db', 'database', { replicas: 1, failover: 'auto', failoverS: 5, connections: 6000, queueLimit: 100000, writeMs: { mean: 31000, cv: 0 } }]],
        [['users', 'apiE'], ['users', 'apiW'], ['apiE', 'db'], ['apiW', 'db']],
      ),
      { apiE: 'east', apiW: 'west', db: 'east' }, { db: 'west' },
    );
    const r = simulate(d, scenario({ seed: 4, durationS: 80, warmupS: 0, traffic: { rps: 200, readRatio: 0.5, clientTimeoutMs: 600000 }, events: [{ type: 'partition', atS: 10, forS: 30, regions: ['east', 'west'] }] }));
    expect(r.nodes.db.divergentWrites!).toBeGreaterThan(0);
    const logged = r.timeline.filter((e) => e.type === 'divergence').reduce((a, e) => a + (e.count ?? 0), 0);
    expect(logged).toBe(r.nodes.db.divergentWrites);
  });
});

describe('review fixes', () => {
  const placeIn = (d: Design, region: Record<string, string>, replica?: Record<string, string>): Design => {
    d.nodes = d.nodes.map((n) => (region[n.id] ? { ...n, region: region[n.id], ...(replica?.[n.id] ? { replicaRegion: replica[n.id] } : {}) } : n));
    expect(parseDesign(d).ok).toBe(true);
    return d;
  };

  it('fan-out copies already on their way back when the partition starts are lost too', () => {
    // 225 ms each way, 3 copies, quorum 2: replies sent at 9.775–10 s arrive after the cut
    const d = placeIn(
      design([['users', 'client'], ['api', 'service', { instances: 2, concurrency: 500 }], ['svc', 'service', { instances: 3, concurrency: 500, serviceMs: { mean: 1, cv: 0 } }]], [['users', 'api'], ['api', 'svc', { timeoutMs: 2000, latencyMs: 225, fanout: 3, quorum: 2 }]]),
      { api: 'west', svc: 'east' },
    );
    const sim = new Simulation(d, scenario({ seed: 1, durationS: 15, warmupS: 0, traffic: { rps: 100, readRatio: 1, arrivals: 'constant' }, events: [{ type: 'partition', atS: 10, regions: ['east', 'west'] }] }));
    sim.runToEnd();
    expect(sim.allWindows().filter((w) => w.t > 10).reduce((a, w) => a + w.ok, 0)).toBe(0);
    // before the cut the fan-out works, with one trip back (not two)
    const before = sim.allWindows().filter((w) => w.t > 2 && w.t <= 9);
    expect(before.reduce((a, w) => a + w.ok, 0)).toBeGreaterThan(600);
    expect(Math.max(...before.map((w) => w.latency.p99))).toBeLessThan(500);
  });

  it('a fan-out that fails before sending any copy still answers after the trip back', () => {
    // two copies of the data, quorum 3: it fails at once, and the failure comes back after 225 ms out and 225 ms back
    const d = placeIn(
      design([['users', 'client'], ['api', 'service', { instances: 2, concurrency: 500 }], ['db', 'database', { replicas: 1, connections: 500 }]], [['users', 'api'], ['api', 'db', { timeoutMs: 2000, latencyMs: 225, fanout: 3, quorum: 3 }]]),
      { api: 'west', db: 'east' }, { db: 'east' },
    );
    const sim = new Simulation(d, scenario({ seed: 1, durationS: 5, warmupS: 0, traffic: { rps: 50, readRatio: 1, arrivals: 'constant' } }));
    sim.runToEnd();
    const hops = sim.drainTraces().flatMap((x) => x.hops ?? []).filter((h) => h.edge === 'api->db' && h.tDone !== undefined);
    expect(hops.length).toBeGreaterThan(10);
    expect(hops.every((h) => !h.ok)).toBe(true);
    for (const h of hops) expect(h.tDone! - h.tSend).toBeGreaterThanOrEqual(449);
  });

  it('a fan-out trace keeps the time the callee answered, before the trip back', () => {
    const d = placeIn(
      design([['users', 'client'], ['api', 'service', { instances: 2, concurrency: 500 }], ['svc', 'service', { instances: 3, concurrency: 500, serviceMs: { mean: 1, cv: 0 } }]], [['users', 'api'], ['api', 'svc', { timeoutMs: 2000, latencyMs: 225, fanout: 3, quorum: 2 }]]),
      { api: 'west', svc: 'east' },
    );
    const sim = new Simulation(d, scenario({ seed: 1, durationS: 5, warmupS: 0, traffic: { rps: 50, readRatio: 1, arrivals: 'constant' } }));
    sim.runToEnd();
    const hops = sim.drainTraces().flatMap((x) => x.hops ?? []).filter((h) => h.edge === 'api->svc' && h.ok);
    expect(hops.length).toBeGreaterThan(10);
    for (const h of hops) expect(h.tDone! - h.tReply!).toBeGreaterThanOrEqual(224);
  });

  it('divergent writes in the last second of the run are in the timeline too', () => {
    const d = placeIn(
      design(
        [['users', 'client'], ['apiE', 'service', { instances: 2, concurrency: 5000 }], ['apiW', 'service', { instances: 2, concurrency: 5000 }],
          ['db', 'database', { replicas: 1, failover: 'auto', failoverS: 5, connections: 6000, queueLimit: 100000, writeMs: { mean: 31000, cv: 0 } }]],
        [['users', 'apiE'], ['users', 'apiW'], ['apiE', 'db'], ['apiW', 'db']],
      ),
      { apiE: 'east', apiW: 'west', db: 'east' }, { db: 'west' },
    );
    // the heal is at 40 s; late commits run until about 71 s. A short client timeout ends the run
    // (durationS + clientTimeoutMs) before the next once-a-second divergence entry is due
    const r = simulate(d, scenario({ seed: 4, durationS: 46, warmupS: 0, traffic: { rps: 200, readRatio: 0.5, clientTimeoutMs: 50 }, events: [{ type: 'partition', atS: 10, forS: 30, regions: ['east', 'west'] }] }));
    expect(r.nodes.db.divergentWrites!).toBeGreaterThan(0);
    const logged = r.timeline.filter((e) => e.type === 'divergence').reduce((a, e) => a + (e.count ?? 0), 0);
    // the timeline also has the few writes committed after durationS (the summary stops there)
    expect(logged).toBeGreaterThanOrEqual(r.nodes.db.divergentWrites!);
  });
});

