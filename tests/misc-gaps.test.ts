// Smaller gaps: connection setup and TLS (#11), a controller that depends on what it
// controls (#61), the transactional outbox (#39), FIFO head-of-line blocking (#38), resharding (#30).
import { describe, expect, it } from 'vitest';
import { simulate, Simulation } from '../src/engine/index.ts';
import { checkDesign, checkScenario, type ParamValue, type Scenario } from '../src/schema/design.ts';
import { design, scenario } from './helpers.ts';
import { calmAt } from '../src/learn/metrics.ts';

type Ev = NonNullable<Scenario['events']>[number];
const types = (r: ReturnType<typeof simulate>) => r.timeline.map((e) => e.type);

describe('connection setup (#11)', () => {
  const d = (edge: Record<string, unknown>) =>
    design(
      [['users', 'client'], ['api', 'service', { instances: 1, concurrency: 100, serviceMs: { mean: 1, cv: 0 } }], ['db', 'database', { connections: 200, readMs: { mean: 2, cv: 0 } }]],
      [['users', 'api'], ['api', 'db', edge]],
    );
  const run = (edge: Record<string, unknown>, rps = 200) => simulate(d(edge), scenario({ seed: 2, durationS: 20, warmupS: 0, traffic: { rps, readRatio: 1 } }));

  it('no handshake time: connections are not counted', () => {
    expect(run({}).edges['api->db'].connects).toBeUndefined();
  });

  it('keep-alive: only a few connections are opened, and later calls do not pay the handshake', () => {
    const base = run({});
    const r = run({ connectMs: 30 });
    const e = r.edges['api->db'];
    // about as many as calls in flight at once (200 rps × 3 ms ≈ 1, Poisson bursts a few more)
    expect(e.connects!).toBeGreaterThan(0);
    expect(e.connects!).toBeLessThan(20);
    expect(r.summary.latencyMs.p50).toBeLessThan(base.summary.latencyMs.p50 + 5);
  });

  it('without keep-alive every call opens a connection and pays the handshake', () => {
    const base = run({});
    const r = run({ connectMs: 30, keepAlive: 'off' });
    expect(r.edges['api->db'].connects).toBe(r.edges['api->db'].calls);
    expect(r.summary.latencyMs.p50).toBeGreaterThan(base.summary.latencyMs.p50 + 25);
  });

  it('an idle connection closes: rare calls open a new one each time', () => {
    // Poisson arrivals: a call that comes within 0.5 s of the last one still finds it open
    const slow = run({ connectMs: 30, idleS: 0.5 }, 0.5);
    expect(slow.edges['api->db'].connects!).toBeGreaterThanOrEqual(slow.edges['api->db'].calls * 0.6);
    const kept = run({ connectMs: 30, idleS: 60 }, 0.5);
    expect(kept.edges['api->db'].connects).toBe(1);
  });
});

describe('control-plane dependency (#61)', () => {
  // an autoscaled service whose autoscaler reads its numbers from a metrics service
  const scaled = (control = true) =>
    design(
      [
        ['users', 'client'],
        ['svc', 'service', {
          instances: 2, concurrency: 10, serviceMs: { mean: 50, cv: 0 }, queueLimit: 100000,
          autoscale: 'on', maxInstances: 10, targetUtil: 0.6, scaleEveryS: 5, bootS: 10, warmS: 0, scaleDownS: 0,
        }],
        ['metrics', 'service', { instances: 1, concurrency: 10, serviceMs: { mean: 1, cv: 0 } }],
      ],
      [['users', 'svc'], ...(control ? [['svc', 'metrics', { on: 'control' as const, timeoutMs: 500 }] as [string, string, { on: 'control'; timeoutMs: number }]] : [])],
    );
  const sc = (events: Ev[] = []) => scenario({ seed: 1, durationS: 120, warmupS: 0, traffic: { rps: 300 }, events: [{ type: 'spike', atS: 10, forS: 110, multiplier: 2 }, ...events] });

  it('requests do not take a control edge; each check calls it once', () => {
    const r = simulate(scaled(), sc());
    // one call per autoscaler check: every 5 s for 120 s
    expect(r.edges['svc->metrics:control'].calls).toBeGreaterThanOrEqual(22);
    expect(r.edges['svc->metrics:control'].calls).toBeLessThanOrEqual(24);
    expect(r.nodes.svc.blindChecks).toBeUndefined();
    expect(r.nodes.svc.autoscale!.launches).toBeGreaterThan(0);
  });

  it('while the metrics service is down the autoscaler is blind and does not scale', () => {
    const ev: Ev[] = [{ type: 'down', node: 'metrics', atS: 0, forS: 60 }];
    const r = simulate(scaled(), sc(ev));
    const free = simulate(scaled(false), sc(ev));
    expect(r.nodes.svc.blindChecks!).toBeGreaterThan(5);
    expect(types(r)).toContain('control_lost');
    expect(types(r)).toContain('control_back');
    const first = r.timeline.find((e) => e.node === 'svc' && e.type === 'scale_out')!;
    expect(first.t).toBeGreaterThanOrEqual(60);
    expect(free.timeline.find((e) => e.node === 'svc' && e.type === 'scale_out')!.t).toBeLessThan(30);
    expect(r.summary.latencyMs.p99).toBeGreaterThan(free.summary.latencyMs.p99);
  });

  it('database failover waits for its coordination service', () => {
    const db = (control: boolean) =>
      design(
        [['users', 'client'], ['db', 'database', { replicas: 1, failover: 'auto', failoverS: 5, connections: 256 }], ['zk', 'service', { instances: 1, concurrency: 10, serviceMs: { mean: 1, cv: 0 } }]],
        [['users', 'db'], ...(control ? [['db', 'zk', { on: 'control' as const, timeoutMs: 500 }] as [string, string, { on: 'control'; timeoutMs: number }]] : [])],
      );
    const ev: Ev[] = [{ type: 'down', node: 'db', instance: 0, atS: 10, forS: 100 }, { type: 'down', node: 'zk', atS: 10, forS: 30 }];
    const s = scenario({ seed: 1, durationS: 60, warmupS: 0, traffic: { rps: 100, readRatio: 0 }, events: ev });
    const free = simulate(db(false), s).timeline.find((e) => e.type === 'failover')!;
    const r = simulate(db(true), s);
    const blocked = r.timeline.find((e) => e.type === 'failover')!;
    expect(free.t).toBeLessThan(16);
    // zk is back at 40 s; the next look after it is at most failoverS later
    expect(blocked.t).toBeGreaterThanOrEqual(40);
    expect(blocked.t).toBeLessThan(46);
    expect(r.nodes.db.blindChecks!).toBeGreaterThan(0);
  });

  it('in a partition, a failover controller that cannot reach its coordination service does not split the brain', () => {
    const d = (control: boolean) => {
      const api = { instances: 2, concurrency: 200, serviceMs: { mean: 1, cv: 0 } };
      const x = design(
        [['users', 'client'], ['apiE', 'service', api], ['apiW', 'service', api], ['db', 'database', { replicas: 1, failover: 'auto', failoverS: 5 }], ['zk', 'service', { instances: 1, concurrency: 10, serviceMs: { mean: 1, cv: 0 } }]],
        [['users', 'apiE'], ['users', 'apiW'], ['apiE', 'db', { timeoutMs: 500 }], ['apiW', 'db', { timeoutMs: 500 }], ...(control ? [['db', 'zk', { on: 'control' as const, timeoutMs: 500 }] as [string, string, { on: 'control'; timeoutMs: number }]] : [])],
      );
      const region: Record<string, string> = { apiE: 'east', apiW: 'west', db: 'east', zk: 'west' };
      x.nodes = x.nodes.map((n) => (region[n.id] ? { ...n, region: region[n.id], ...(n.id === 'db' ? { replicaRegion: 'west' } : {}) } : n));
      return x;
    };
    const s = scenario({ seed: 1, durationS: 60, warmupS: 0, traffic: { rps: 100, readRatio: 0.5 }, events: [{ type: 'partition', atS: 10, forS: 30, regions: ['east', 'west'] }] });
    expect(simulate(d(false), s).nodes.db.failovers).toBe(1);
    const r = simulate(d(true), s);
    expect(r.nodes.db.failovers).toBe(0);
    expect(r.nodes.db.divergentWrites).toBeUndefined();
    expect(r.nodes.db.blindChecks!).toBeGreaterThan(0);
    // after the heal it stops looking: about one control call per failoverS during the cut
    expect(r.edges['db->zk:control'].calls).toBeLessThanOrEqual(8);
  });

  it('DNS health checks stop while their control edge fails', () => {
    const svc = { instances: 2, concurrency: 100, serviceMs: { mean: 2, cv: 0 } };
    const d = design(
      [['u', 'client'], ['dns', 'dns', { resolverCacheHit: 1, failover: 'on', detectS: 5, ttlS: 1 }], ['apiE', 'service', svc], ['apiW', 'service', svc], ['hc', 'service', { instances: 1, concurrency: 10, serviceMs: { mean: 1, cv: 0 } }]],
      [['u', 'dns'], ['dns', 'apiE'], ['dns', 'apiW'], ['dns', 'hc', { on: 'control', timeoutMs: 500 }]],
    );
    d.nodes = d.nodes.map((n) => (n.id === 'apiE' ? { ...n, region: 'east' } : n.id === 'apiW' ? { ...n, region: 'west' } : n));
    const s = (events: Ev[]) => scenario({ seed: 1, durationS: 60, warmupS: 0, traffic: { rps: 200, readRatio: 1 }, events });
    const ok = simulate(d, s([{ type: 'down', node: 'apiE', atS: 10, forS: 50 }]));
    const blind = simulate(d, s([{ type: 'down', node: 'apiE', atS: 10, forS: 50 }, { type: 'down', node: 'hc', atS: 5, forS: 30 }]));
    const out = (r: ReturnType<typeof simulate>) => r.timeline.find((e) => e.type === 'dns_out')!.t;
    expect(out(ok)).toBeLessThan(17);
    expect(out(blind)).toBeGreaterThanOrEqual(35);
    expect(blind.summary.ok).toBeLessThan(ok.summary.ok);
  });

  it('checks: a control edge needs a controller and a timeout, and makes no loop', () => {
    const none = design([['users', 'client'], ['svc', 'service'], ['m', 'service']], [['users', 'svc'], ['svc', 'm', { on: 'control', timeoutMs: 100 }]]);
    expect(checkDesign(none).map((i) => i.code)).toContain('control-no-controller');
    const noTimeout = design([['users', 'client'], ['svc', 'service', { autoscale: 'on' }], ['m', 'service']], [['users', 'svc'], ['svc', 'm', { on: 'control' }]]);
    const codes = checkDesign(noTimeout).map((i) => i.code);
    expect(codes).toContain('side-no-timeout');
    expect(codes).not.toContain('control-no-controller');
    // metrics that run on the service they watch: a control edge back is no request loop
    const loop = design([['users', 'client'], ['a', 'service', { autoscale: 'on' }], ['b', 'service']], [['users', 'a'], ['a', 'b', { on: 'control', timeoutMs: 100 }], ['b', 'a']]);
    expect(checkDesign(loop).map((i) => i.code)).not.toContain('cycle');
  });
});

describe('transactional outbox (#39)', () => {
  // a write saves the order in the database and sends an event to a queue for a worker
  const d = (api: Record<string, unknown> = {}) =>
    design(
      [
        ['users', 'client'],
        ['api', 'service', { instances: 2, concurrency: 100, serviceMs: { mean: 1, cv: 0 }, ...api }],
        ['db', 'database', { connections: 200, writeMs: { mean: 2, cv: 0 } }],
        ['q', 'queue'],
        ['w', 'worker', { instances: 2, concurrency: 20, serviceMs: { mean: 2, cv: 0 } }],
      ],
      [['users', 'api'], ['api', 'db'], ['api', 'q', { timeoutMs: 200 }], ['q', 'w']],
    );
  const sc = (events: Ev[] = []) => scenario({ seed: 3, durationS: 40, warmupS: 0, traffic: { rps: 100, readRatio: 0 }, events });
  const qDown: Ev[] = [{ type: 'down', node: 'q', atS: 10, forS: 10 }];

  it('a healthy run has no gaps and no retries', () => {
    const r = simulate(d(), sc());
    expect(r.nodes.api.dualWriteGaps).toBe(0);
    expect(r.nodes.api.outboxRetries).toBeUndefined();
    const o = simulate(d({ outbox: 'on' }), sc());
    expect(o.nodes.api.outboxRetries).toBe(0);
  });

  it('without an outbox, a queue outage leaves saved orders without their event', () => {
    const r = simulate(d(), sc(qDown));
    // 100 writes/s for 10 s: the database took them, the queue did not
    expect(r.nodes.api.dualWriteGaps!).toBeGreaterThan(800);
    expect(r.nodes.api.dualWriteGaps!).toBeLessThan(1200);
    // and the user saw an error for an order that was saved
    expect(r.summary.offered - r.summary.ok).toBeGreaterThan(800);
    expect(r.nodes.db.ok - r.nodes.q.asyncOk!).toBeGreaterThan(800);
  });

  it('with an outbox the user sees success and every event arrives after the outage', () => {
    const r = simulate(d({ outbox: 'on', outboxRetryMs: 1000 }), sc(qDown));
    expect(r.nodes.api.dualWriteGaps).toBe(0);
    expect(r.summary.ok).toBe(r.summary.offered);
    // each of the ~1000 messages is retried about once a second until the queue is back
    expect(r.nodes.api.outboxRetries!).toBeGreaterThan(3000);
    expect(r.nodes.q.asyncOk! + r.nodes.q.queueDepthEnd!).toBe(r.nodes.db.ok);
  });

  it('with the outbox the request does not wait for the queue', () => {
    const slowQ = (api: Record<string, unknown>) => {
      const x = d(api);
      x.edges = x.edges.map((e) => (e.to === 'q' ? { ...e, latencyMs: 50 } : e));
      return simulate(x, sc());
    };
    expect(slowQ({}).summary.latencyMs.p50).toBeGreaterThan(100);
    expect(slowQ({ outbox: 'on' }).summary.latencyMs.p50).toBeLessThan(20);
  });
});

describe('FIFO queue and head-of-line blocking (#38)', () => {
  const d = (q: Record<string, unknown> = {}, w: Record<string, unknown> = {}) =>
    design(
      [
        ['users', 'client'],
        ['api', 'service', { instances: 2, concurrency: 100, serviceMs: { mean: 1, cv: 0 } }],
        ['q', 'queue', { delivery: 'at_least_once', visibilityTimeoutMs: 2000, maxReceives: 5, ...q }],
        ['w', 'worker', { instances: 4, concurrency: 10, serviceMs: { mean: 5, cv: 0 }, ...w }],
      ],
      [['users', 'api'], ['api', 'q'], ['q', 'w']],
    );
  const sc = () => scenario({ seed: 4, durationS: 60, warmupS: 0, traffic: { rps: 200, readRatio: 0 }, keys: { count: 1000 } });

  it('a standard queue does not count blocking; a FIFO queue keeps one message per group in work', () => {
    const std = simulate(d(), sc());
    expect(std.nodes.q.holBlocked).toBeUndefined();
    const fifo = simulate(d({ ordering: 'fifo', groups: 64 }), sc());
    // 200 msg/s × 5 ms = 1 in work on average: a few wait behind their group
    expect(fifo.nodes.q.holBlocked!).toBeGreaterThan(0);
    expect(fifo.nodes.q.holBlocked!).toBeLessThan(fifo.nodes.q.asyncOk! * 0.05);
    expect(fifo.nodes.q.asyncOk!).toBeGreaterThan(std.nodes.q.asyncOk! * 0.99);
  });

  it('few groups limit how many messages are worked on at once', () => {
    // 2 groups: at most 2 messages at a time, 2 / 5 ms = 400 msg/s, enough for 200
    const two = simulate(d({ ordering: 'fifo', groups: 2 }), sc());
    expect(two.nodes.q.queueDepthEnd!).toBeLessThan(50);
    // 1 group: 200 msg/s at 5 ms one at a time fits (exactly at capacity: it queues up)
    const one = simulate(d({ ordering: 'fifo', groups: 1 }, { serviceMs: { mean: 10, cv: 0 } }), sc());
    expect(one.nodes.q.queueDepthEnd!).toBeGreaterThan(3000);
  });

  it('a poison message blocks its whole group until it goes to the DLQ', () => {
    const poison = { poisonRate: 0.002 };
    const std = simulate(d({}, poison), sc());
    const fifo = simulate(d({ ordering: 'fifo', groups: 16 }, poison), sc());
    expect(std.nodes.q.dlq).toBe(fifo.nodes.q.dlq);
    expect(fifo.nodes.q.dlq!).toBeGreaterThan(5);
    // standard: the others go around it; FIFO: its group waits 5 × 2 s for the DLQ
    expect(std.summary.asyncLatencyMs.p99).toBeLessThan(100);
    expect(fifo.summary.asyncLatencyMs.p99).toBeGreaterThan(2000);
    expect(fifo.nodes.q.holBlocked!).toBeGreaterThan(fifo.nodes.q.dlq! * 100);
    // nothing is lost: done, in the DLQ or still waiting (messages done after the end are not counted)
    expect(fifo.nodes.q.asyncOk! + fifo.nodes.q.dlq! + fifo.nodes.q.queueDepthEnd!).toBeGreaterThan((std.nodes.q.asyncOk! + std.nodes.q.dlq!) * 0.98);
  });

  it('at-most-once: a failed message is gone and its group moves on', () => {
    const fifo = simulate(d({ ordering: 'fifo', groups: 16, delivery: 'at_most_once' }, { poisonRate: 0.002 }), sc());
    expect(fifo.summary.asyncLatencyMs.p99).toBeLessThan(100);
    expect(fifo.nodes.q.queueDepthEnd!).toBeLessThan(20);
  });
});

describe('resharding (#30)', () => {
  // 2 shards of 10 connections, 4 ms per write: 2 × 10 / 4 ms = 5000 writes/s at most
  const d = () =>
    design(
      [['users', 'client'], ['db', 'sharded_db', { shards: 2, connections: 10, queueLimit: 100000, writeMs: { mean: 4, cv: 0 }, readMs: { mean: 4, cv: 0 } }]],
      [['users', 'db']],
    );
  const run = (events: Ev[], rps = 4500) => {
    const sim = new Simulation(d(), scenario({ seed: 5, durationS: 60, warmupS: 0, traffic: { rps, readRatio: 0.5 }, keys: { count: 10000 }, events }));
    const r = sim.runToEnd();
    return { r, w: sim.allWindows() };
  };
  const p99 = (w: ReturnType<typeof run>['w'], from: number, to: number) => Math.max(...w.filter((x) => x.t >= from && x.t < to).map((x) => x.latency.p99));

  it('after the cutover the keys spread over the new shards and the load per shard drops', () => {
    const { r, w } = run([{ type: 'reshard', atS: 10, forS: 10, node: 'db', toShards: 4 }]);
    expect(types(r)).toContain('reshard');
    expect(types(r)).toContain('reshard_done');
    // the new shards do nothing before the cutover and take half the keys after it
    const before = w.find((x) => x.t === 5)!.nodes.db.instUtil!;
    const after = w.find((x) => x.t === 40)!.nodes.db.instUtil!;
    expect(before.slice(2)).toEqual([0, 0]);
    for (const u of after) expect(u).toBeGreaterThan(0.35), expect(u).toBeLessThan(0.75);
    expect(Math.max(...before.slice(0, 2))).toBeGreaterThan(0.8);
  });

  it('the copy makes every shard slower while it runs: a busy database queues up', () => {
    const { w } = run([{ type: 'reshard', atS: 10, forS: 10, node: 'db', toShards: 4, copyLoad: 0.5 }]);
    // 4500 / s at 6 ms needs 27 of the 20 connections: it falls behind during the copy
    expect(p99(w, 15, 20)).toBeGreaterThan(p99(w, 2, 9) * 5);
    expect(p99(w, 40, 60)).toBeLessThan(p99(w, 2, 9));
  });

  it('checks: only a sharded database can be resharded; the scaled run keeps its shards', () => {
    const x = design([['users', 'client'], ['db', 'database']], [['users', 'db']]);
    const sc = scenario({ traffic: { rps: 10 }, events: [{ type: 'reshard', atS: 1, node: 'db', toShards: 4 }] });
    expect(checkScenario(sc, x).map((i) => i.code)).toContain('event-reshard-kind');
    expect(checkScenario(sc, d()).map((i) => i.code)).not.toContain('event-reshard-kind');
    // a scaled run cuts connections, never shards: the reshard still goes 2 → 4
    const wide = design([['users', 'client'], ['db', 'sharded_db', { shards: 2, connections: 2000, queueLimit: 100000, writeMs: { mean: 4, cv: 0 }, readMs: { mean: 4, cv: 0 } }]], [['users', 'db']]);
    const sim = new Simulation(wide, scenario({ seed: 5, durationS: 30, warmupS: 0, traffic: { rps: 200000, readRatio: 0.5 }, keys: { count: 10000 }, events: [{ type: 'reshard', atS: 5, forS: 5, node: 'db', toShards: 4 }] }));
    expect(sim.scalePlan.k).toBeGreaterThan(1);
    sim.runToEnd();
    expect(sim.allWindows().find((x) => x.t === 20)!.nodes.db.instUtil!.filter((u) => u > 0)).toHaveLength(4);
  });
});

describe('review fixes', () => {
  // a write saves the order (the database takes 100 ms) and sends an event to a queue
  const shop = (api: Record<string, unknown> = {}, dbEdge: Record<string, unknown> = {}, qEdge: Record<string, unknown> = {}) =>
    design(
      [
        ['users', 'client'],
        ['api', 'service', { instances: 2, concurrency: 100, serviceMs: { mean: 1, cv: 0 }, ...api }],
        ['db', 'database', { connections: 200, writeMs: { mean: 2, cv: 0 } }],
        ['q', 'queue'],
        ['w', 'worker', { instances: 2, concurrency: 20, serviceMs: { mean: 2, cv: 0 } }],
      ],
      [['users', 'api'], ['api', 'db', dbEdge], ['api', 'q', { timeoutMs: 200, ...qEdge }], ['q', 'w']],
    );
  const sc = (events: Ev[] = []) => scenario({ seed: 3, durationS: 20, warmupS: 0, traffic: { rps: 100, readRatio: 0 }, events });
  // the database is slow: the call times out at 50 ms, the write still commits at 100 ms
  const slowDb: Ev[] = [{ type: 'slow', node: 'db', atS: 0, multiplier: 50 }];

  it('a write that commits after its call timed out still has its outbox row: the relay sends it', () => {
    const r = simulate(shop({ outbox: 'on' }, { timeoutMs: 50 }), sc(slowDb));
    expect(r.edges['api->db'].calls).toBeGreaterThan(1500);
    // every committed write gets its event, although the caller saw a timeout
    expect(r.edges['api->q'].calls).toBeGreaterThan(1500);
  });

  it('without an outbox, a write that commits after its call timed out is a dual-write gap', () => {
    const r = simulate(shop({}, { timeoutMs: 50 }), sc(slowDb));
    // the store call failed, so the queue call was never made; the data is saved anyway
    expect(r.nodes.api.dualWriteGaps!).toBeGreaterThan(1500);
  });

  it('a fallback on the queue edge does not count as a delivered message', () => {
    const down: Ev[] = [{ type: 'down', node: 'q', atS: 5, forS: 5 }];
    const out = simulate(shop({ outbox: 'on' }, {}, { fallback: 'on' }), sc(down));
    expect(out.nodes.api.outboxRetries!).toBeGreaterThan(300);
    const dual = simulate(shop({}, {}, { fallback: 'on' }), sc(down));
    expect(dual.nodes.api.dualWriteGaps!).toBeGreaterThan(300);
  });

  it('a fallback on a control edge is no control data: the controller is blind', () => {
    const d = design(
      [
        ['users', 'client'],
        ['svc', 'service', {
          instances: 2, concurrency: 10, serviceMs: { mean: 50, cv: 0 }, queueLimit: 100000,
          autoscale: 'on', maxInstances: 10, targetUtil: 0.6, scaleEveryS: 5, bootS: 10, warmS: 0, scaleDownS: 0,
        }],
        ['metrics', 'service', { instances: 1, concurrency: 10, serviceMs: { mean: 1, cv: 0 } }],
      ],
      [['users', 'svc'], ['svc', 'metrics', { on: 'control', timeoutMs: 500, fallback: 'on' }] as never],
    );
    const r = simulate(d, scenario({ seed: 1, durationS: 60, warmupS: 0, traffic: { rps: 300 }, events: [{ type: 'spike', atS: 10, forS: 50, multiplier: 2 }, { type: 'down', node: 'metrics', atS: 0, forS: 40 }] }));
    expect(r.nodes.svc.blindChecks!).toBeGreaterThan(3);
    expect(r.timeline.find((e) => e.node === 'svc' && e.type === 'scale_out')!.t).toBeGreaterThanOrEqual(40);
  });

  it('shards that a later reshard adds take no part in failover before the cutover', () => {
    const d = design(
      [['users', 'client'], ['db', 'sharded_db', { shards: 2, replicas: 1, failover: 'auto', failoverS: 2, connections: 10, queueLimit: 100000, writeMs: { mean: 4, cv: 0 }, readMs: { mean: 4, cv: 0 } }]],
      [['users', 'db']],
    );
    const r = simulate(d, scenario({ seed: 5, durationS: 60, warmupS: 0, traffic: { rps: 200, readRatio: 0.5 }, events: [{ type: 'down', node: 'db', atS: 5, forS: 10 }, { type: 'reshard', node: 'db', atS: 40, toShards: 4, forS: 5 }] }));
    // the two serving shards have no replica up: two failovers that cannot happen, not four
    expect(r.timeline.filter((e) => e.node === 'db' && e.type.startsWith('failover'))).toHaveLength(2);
  });

  it('the end of a reshard ends its trigger', () => {
    expect(calmAt([{ t: 10, type: 'reshard', text: '' }, { t: 20, type: 'reshard_done', text: '' }] as never)).toBe(20);
  });
});

describe('review fixes', () => {
  // a write saves to a store and sends an event to a queue
  const shop = (api: Record<string, unknown>, store: [string, Record<string, ParamValue>], storeEdge: Record<string, unknown> = {}) =>
    design(
      [
        ['users', 'client'],
        ['api', 'service', { instances: 2, concurrency: 100, serviceMs: { mean: 1, cv: 0 }, ...api }],
        ['db', store[0], store[1]],
        ['q', 'queue'],
        ['w', 'worker', { instances: 2, concurrency: 20, serviceMs: { mean: 2, cv: 0 } }],
      ],
      [['users', 'api'], ['api', 'db', storeEdge], ['api', 'q', { timeoutMs: 200 }], ['q', 'w']],
    );
  const sc = (events: Ev[] = []) => scenario({ seed: 3, durationS: 20, warmupS: 0, traffic: { rps: 100, readRatio: 0 }, events });
  const s3: [string, Record<string, ParamValue>] = ['object_storage', { putMs: { mean: 5, cv: 0 } }];

  it('object storage counts as stored: the outbox sends every event, and no gap without it', () => {
    const out = simulate(shop({ outbox: 'on' }, s3), sc());
    expect(out.edges['api->q'].calls).toBe(out.edges['api->db'].calls);
    const dual = simulate(shop({}, s3), sc());
    expect(dual.nodes.api.dualWriteGaps).toBe(0);
  });

  it('a fan-out store call that misses its quorum is not stored, though one copy committed', () => {
    const db: [string, Record<string, ParamValue>] = ['database', { replicas: 2, connections: 200, writeMs: { mean: 2, cv: 0 } }];
    const quorum = { fanout: 3, quorum: 3 };
    const down: Ev[] = [{ type: 'down', node: 'db', instance: 2, atS: 0 }];
    const out = simulate(shop({ outbox: 'on' }, db, quorum), sc(down));
    expect(out.summary.ok).toBe(0);
    expect(out.edges['api->q'].calls).toBe(0);
    const dual = simulate(shop({}, db, quorum), sc(down));
    expect(dual.nodes.api.dualWriteGaps).toBe(0);
  });

  it('a shard the reshard adds, whose primary is down, fails over after the cutover', () => {
    const d = design(
      [['users', 'client'], ['db', 'sharded_db', { shards: 2, replicas: 1, failover: 'auto', failoverS: 2, connections: 100, queueLimit: 100000, writeMs: { mean: 4, cv: 0 }, readMs: { mean: 4, cv: 0 } }]],
      [['users', 'db']],
    );
    // instance 4 is shard 2's primary (two instances per shard): down before the reshard to 4 shards, never back
    const r = simulate(d, scenario({ seed: 5, durationS: 60, warmupS: 0, traffic: { rps: 200, readRatio: 0.5 }, events: [{ type: 'down', node: 'db', instance: 4, atS: 5 }, { type: 'reshard', node: 'db', atS: 20, toShards: 4, forS: 5 }] }));
    const fo = r.timeline.filter((e) => e.node === 'db' && e.type === 'failover');
    expect(fo).toHaveLength(1);
    expect(fo[0].t).toBeGreaterThanOrEqual(25);
  });
});

describe('review fixes', () => {
  const shop = (api: Record<string, unknown>, store: [string, Record<string, ParamValue>], storeEdge: Record<string, unknown> = {}) =>
    design(
      [
        ['users', 'client'],
        ['api', 'service', { instances: 2, concurrency: 100, serviceMs: { mean: 1, cv: 0 }, ...api }],
        ['db', store[0], store[1]],
        ['q', 'queue'],
        ['w', 'worker', { instances: 2, concurrency: 20, serviceMs: { mean: 2, cv: 0 } }],
      ],
      [['users', 'api'], ['api', 'db', storeEdge], ['api', 'q', { timeoutMs: 200 }], ['q', 'w']],
    );
  const sc = () => scenario({ seed: 3, durationS: 20, warmupS: 0, traffic: { rps: 100, readRatio: 0 } });

  it('a PUT that completes after its call timed out is stored: the outbox relays it, and without one it is a gap', () => {
    // the PUT takes 100 ms, the call gives up at 50 ms
    const s3: [string, Record<string, ParamValue>] = ['object_storage', { putMs: { mean: 100, cv: 0 } }];
    const out = simulate(shop({ outbox: 'on' }, s3, { timeoutMs: 50 }), sc());
    expect(out.summary.ok).toBe(0);
    expect(out.edges['api->q'].calls).toBeGreaterThan(1500);
    const dual = simulate(shop({}, s3, { timeoutMs: 50 }), sc());
    expect(dual.nodes.api.dualWriteGaps!).toBeGreaterThan(1500);
  });

  it('a fan-out to a single database needs one copy: its late commit is stored', () => {
    // no replica: the fan-out reaches one copy, and quorum 0 waits for all the copies it reached
    const db: [string, Record<string, ParamValue>] = ['database', { connections: 200, writeMs: { mean: 100, cv: 0 } }];
    const out = simulate(shop({ outbox: 'on' }, db, { fanout: 3, timeoutMs: 50 }), sc());
    expect(out.edges['api->q'].calls).toBeGreaterThan(1500);
  });

  it('a shard a later reshard merges away does not fail over', () => {
    const d = design(
      [['users', 'client'], ['db', 'sharded_db', { shards: 2, replicas: 1, failover: 'auto', failoverS: 10, connections: 100, queueLimit: 100000, writeMs: { mean: 4, cv: 0 }, readMs: { mean: 4, cv: 0 } }]],
      [['users', 'db']],
    );
    // shard 2's primary is down; 2 → 4 shards at 25 s (its failover is due at 35 s), back to 2 at 27 s
    const r = simulate(d, scenario({ seed: 5, durationS: 60, warmupS: 0, traffic: { rps: 200, readRatio: 0.5 }, events: [{ type: 'down', node: 'db', instance: 4, atS: 5 }, { type: 'reshard', node: 'db', atS: 20, toShards: 4, forS: 5 }, { type: 'reshard', node: 'db', atS: 26, toShards: 2, forS: 1 }] }));
    expect(r.timeline.filter((e) => e.type === 'reshard_done')).toHaveLength(2);
    expect(r.timeline.filter((e) => e.node === 'db' && e.type.startsWith('failover'))).toHaveLength(0);
  });
});

describe('review fixes', () => {
  it('a retried fan-out write that commits on one copy again and again has not reached its quorum: the outbox sends nothing', () => {
    const d = design(
      [
        ['users', 'client'],
        ['api', 'service', { instances: 2, concurrency: 100, serviceMs: { mean: 1, cv: 0 }, outbox: 'on' }],
        ['db', 'database', { replicas: 2, connections: 200, writeMs: { mean: 2, cv: 0 } }],
        ['q', 'queue'],
        ['w', 'worker', { instances: 2, concurrency: 20, serviceMs: { mean: 2, cv: 0 } }],
      ],
      [['users', 'api'], ['api', 'db', { fanout: 3, quorum: 2, retries: 2, timeoutMs: 50 }], ['api', 'q', { timeoutMs: 200 }], ['q', 'w']],
    );
    // both replicas down: only the primary takes the copies, so quorum 2 is never met
    const r = simulate(d, scenario({ seed: 3, durationS: 20, warmupS: 0, traffic: { rps: 100, readRatio: 0 }, events: [{ type: 'down', node: 'db', instance: 1, atS: 0 }, { type: 'down', node: 'db', instance: 2, atS: 0 }] }));
    expect(r.edges['api->db'].retries).toBeGreaterThan(1500);
    expect(r.edges['api->q'].calls).toBe(0);
  });
});
