// M6: fan-out queries (#70, scatter-gather) and quorum (#31). One call goes to N shards or copies
// at once; it waits for all of them, or for k of them.
import { describe, expect, it } from 'vitest';
import { checkDesign, type Design } from '../src/schema/design.ts';
import { simulate } from '../src/engine/index.ts';
import { planScale } from '../src/engine/scale.ts';
import { design, scenario, type EdgeSpec } from './helpers.ts';

const reads = (extra: Record<string, unknown> = {}) =>
  scenario({ durationS: 30, warmupS: 5, seed: 7, traffic: { rps: 200, readRatio: 1, clientTimeoutMs: 10_000 }, ...extra });

/** users → api → a sharded search index with 8 shards. */
const search = (edge: EdgeSpec[2] = {}) =>
  design(
    [
      ['u', 'client'],
      ['api', 'service', { instances: 4, concurrency: 64, serviceMs: { mean: 1, cv: 0 } }],
      ['idx', 'sharded_db', { shards: 8, connections: 64, readMs: { mean: 5, cv: 1 } }],
    ],
    [['u', 'api'], ['api', 'idx', edge]],
  );

/** users → api → a database with a primary and 2 replicas (3 copies). */
const triple = (edge: EdgeSpec[2] = {}) =>
  design(
    [
      ['u', 'client'],
      ['api', 'service', { instances: 4, concurrency: 64, serviceMs: { mean: 1, cv: 0 } }],
      ['db', 'database', { replicas: 2, connections: 64, readMs: { mean: 4, cv: 0.3 }, writeMs: { mean: 8, cv: 0.3 } }],
    ],
    [['u', 'api'], ['api', 'db', edge]],
  );

describe('scatter-gather (#70): a query that asks every shard waits for the slowest', () => {
  it('8 shards: each call sends 8 copies, and latency is the slowest of 8', () => {
    const one = simulate(search(), reads());
    const all = simulate(search({ fanout: 8 }), reads());
    const e = all.edges['api->idx'];
    expect(e.copies).toBe(e.calls * 8);
    expect(all.nodes.idx.arrivals).toBe(e.calls * 8);
    expect(one.edges['api->idx'].copies).toBeUndefined();
    // the max of 8 exponentials with mean 5 has mean 5 × (1 + 1/2 + … + 1/8) ≈ 13.6
    expect(all.summary.latencyMs.p50).toBeGreaterThan(one.summary.latencyMs.p50 * 2);
    expect(all.summary.latencyMs.p99).toBeGreaterThan(one.summary.latencyMs.p99 * 1.3);
    expect(all.summary.errorRate).toBe(0);
  });

  it('one slow shard slows 1 read in 8 without fan-out, and every read with it', () => {
    const slow = { events: [{ type: 'slow' as const, atS: 0, node: 'idx', instance: 3, multiplier: 20 }] };
    const one = simulate(search(), reads(slow));
    const all = simulate(search({ fanout: 8 }), reads(slow));
    // slow reads take about 100 ms on average; without fan-out the median read does not touch shard 3
    expect(one.summary.latencyMs.p50).toBeLessThan(15);
    expect(one.summary.latencyMs.p99).toBeGreaterThan(150);
    expect(all.summary.latencyMs.p50).toBeGreaterThan(50);
  });

  it('a fan-out larger than the shards goes to every shard once', () => {
    const r = simulate(search({ fanout: 100 }), reads({ durationS: 5, warmupS: 0 }));
    expect(r.edges['api->idx'].copies).toBe(r.edges['api->idx'].calls * 8);
  });

  it('a shard that is down fails the whole query (all shards needed)', () => {
    const r = simulate(search({ fanout: 8 }), reads({ durationS: 10, warmupS: 0, events: [{ type: 'down', atS: 0, node: 'idx', instance: 5 }] }));
    expect(r.summary.errorRate).toBe(1);
    expect(r.summary.fail.down).toBeGreaterThan(0);
  });
});

describe('quorum (#31): wait for k of N copies', () => {
  const slowReplica = { events: [{ type: 'slow' as const, atS: 0, node: 'db', instance: 2, multiplier: 50 }] };

  it('3 copies, one slow: waiting for all 3 is slow, waiting for 2 is not', () => {
    const all = simulate(triple({ fanout: 3 }), reads(slowReplica));
    const two = simulate(triple({ fanout: 3, quorum: 2 }), reads(slowReplica));
    // the slow copy takes about 200 ms
    expect(all.summary.latencyMs.p50).toBeGreaterThan(150);
    expect(two.summary.latencyMs.p99).toBeLessThan(30);
    // the copies not waited for still run: same load on the database
    expect(Math.abs(two.nodes.db.arrivals - all.nodes.db.arrivals)).toBeLessThan(all.nodes.db.arrivals * 0.05);
  });

  it('quorum fails when too few copies are up; a smaller quorum still answers', () => {
    const down = { durationS: 10, warmupS: 0, events: [{ type: 'down' as const, atS: 0, node: 'db', instance: 1 }, { type: 'down' as const, atS: 0, node: 'db', instance: 2 }] };
    const two = simulate(triple({ fanout: 3, quorum: 2 }), reads(down));
    const one = simulate(triple({ fanout: 3, quorum: 1 }), reads(down));
    expect(two.summary.errorRate).toBe(1);
    expect(two.summary.fail.down).toBeGreaterThan(0);
    expect(one.summary.errorRate).toBe(0);
  });

  it('a quorum write goes to every copy itself: the copies do the write, nothing is replicated after', () => {
    const writes = scenario({ durationS: 10, warmupS: 0, seed: 3, traffic: { rps: 100, readRatio: 0, clientTimeoutMs: 10_000 } });
    const r = simulate(triple({ fanout: 3, quorum: 2 }), writes);
    const db = r.nodes.db;
    expect(r.summary.errorRate).toBe(0);
    expect(db.arrivals).toBe(r.edges['api->db'].calls * 3);
    // every instance did about a third of the writes
    for (const row of db.instances!) expect(row.started).toBeGreaterThan(db.arrivals / 3 - 30);
    expect(db.replicationApplied ?? 0).toBe(0);
    // without fan-out the primary writes and the replicas apply it
    const plain = simulate(triple(), writes);
    expect(plain.nodes.db.replicationApplied).toBeGreaterThan(0);
  });

  it('fan-out to a service sends to distinct instances', () => {
    const d = design(
      [
        ['u', 'client'],
        ['api', 'service', { instances: 2, concurrency: 64, serviceMs: { mean: 1, cv: 0 } }],
        ['leaf', 'service', { instances: 5, concurrency: 64, serviceMs: { mean: 2, cv: 0 } }],
      ],
      [['u', 'api'], ['api', 'leaf', { fanout: 3 }]],
    );
    const r = simulate(d, reads({ durationS: 5, warmupS: 0 }));
    expect(r.edges['api->leaf'].copies).toBe(r.edges['api->leaf'].calls * 3);
    // round robin over the 5 instances: each gets about 3/5 of the calls
    for (const row of r.nodes.leaf.instances!) expect(row.started).toBeGreaterThan(r.edges['api->leaf'].calls * 0.5);
  });
});

describe('fan-out: copies only go where a call can be served', () => {
  const leafy = (leaf: Record<string, unknown>, edge: EdgeSpec[2]) =>
    design(
      [
        ['u', 'client'],
        ['api', 'service', { instances: 2, concurrency: 64, serviceMs: { mean: 1, cv: 0 } }],
        ['leaf', 'service', { concurrency: 64, serviceMs: { mean: 2, cv: 0 }, ...leaf }],
      ],
      [['u', 'api'], ['api', 'leaf', edge]],
    );

  it('a quorum larger than the instances there are fails: it is not lowered to fit', () => {
    const r = simulate(leafy({ instances: 1 }, { fanout: 3, quorum: 2 }), reads({ durationS: 5, warmupS: 0 }));
    expect(r.summary.errorRate).toBe(1);
    expect(r.summary.fail.down).toBeGreaterThan(0);
    // waiting for all copies (quorum 0) still answers with the one instance
    const all = simulate(leafy({ instances: 1 }, { fanout: 3 }), reads({ durationS: 5, warmupS: 0 }));
    expect(all.summary.errorRate).toBe(0);
  });

  it('booting instances of an autoscaled target get no copies', () => {
    const d = leafy(
      { instances: 2, concurrency: 4, serviceMs: { mean: 20, cv: 0 }, queueLimit: 100000, autoscale: 'on', maxInstances: 6, targetUtil: 0.3, scaleEveryS: 1, bootS: 1000, warmS: 0, scaleDownS: 0 },
      { fanout: 6 },
    );
    const r = simulate(d, reads({ durationS: 10, warmupS: 0, traffic: { rps: 100, readRatio: 1, clientTimeoutMs: 100_000 } }));
    expect(r.timeline.some((e) => e.node === 'leaf' && e.type === 'scale_out')).toBe(true);
    const rows = r.nodes.leaf.instances!;
    expect(rows.length).toBe(6);
    for (const row of rows.slice(2)) expect(row.started ?? 0).toBe(0);
    expect(r.edges['api->leaf'].copies).toBe(r.edges['api->leaf'].calls * 2);
  });

  it('a queue or a load balancer ignores fan-out on its outgoing edge, and the check says so', () => {
    const viaQueue = design(
      [['u', 'client'], ['api', 'service', { instances: 40, concurrency: 256 }], ['q', 'queue'], ['w', 'worker', { instances: 40, concurrency: 256 }]],
      [['u', 'api'], ['api', 'q'], ['q', 'w', { fanout: 3 }]],
    );
    expect(checkDesign(viaQueue).map((i) => i.code)).toContain('fanout-queue');
    // the worker is not pinned: it can shrink with the run
    expect(planScale(viaQueue, 1e9).nodes.w.instances).toBeGreaterThan(1);
    const viaLb = design(
      [['u', 'client'], ['lb', 'load_balancer'], ['s', 'service', { instances: 4, concurrency: 64, serviceMs: { mean: 1, cv: 0 } }]],
      [['u', 'lb'], ['lb', 's', { fanout: 3 }]],
    );
    expect(checkDesign(viaLb).map((i) => i.code)).toContain('fanout-lb');
    // the quorum and hedge checks do not talk about a fan-out that has no effect
    const lbCodes = checkDesign(design([['u', 'client'], ['lb', 'load_balancer'], ['s', 'service']], [['u', 'lb'], ['lb', 's', { fanout: 3, quorum: 5, hedgeMs: 20 }]])).map((i) => i.code);
    expect(lbCodes).toContain('fanout-lb');
    for (const c of ['quorum-gt-fanout', 'fanout-hedge', 'quorum-no-fanout']) expect(lbCodes).not.toContain(c);
    const r = simulate(viaLb, reads({ durationS: 5, warmupS: 0 }));
    expect(r.edges['lb->s'].copies).toBeUndefined();
    expect(r.nodes.s.arrivals).toBe(r.edges['lb->s'].calls);
  });
});

describe('fan-out: design checks and scale', () => {
  const codes = (d: Design) => checkDesign(d).map((i) => i.code);

  it('warns when the setting cannot work', () => {
    const viaLb = design([['u', 'client'], ['lb', 'load_balancer'], ['s', 'service']], [['u', 'lb', { fanout: 3 }], ['lb', 's']]);
    expect(codes(viaLb)).toContain('fanout-target');
    expect(codes(triple({ quorum: 2 }))).toContain('quorum-no-fanout');
    expect(codes(triple({ fanout: 3, quorum: 5 }))).toContain('quorum-gt-fanout');
    expect(codes(triple({ fanout: 3, hedgeMs: 20 }))).toContain('fanout-hedge');
    expect(codes(triple({ fanout: 3, quorum: 2 }))).not.toContain('quorum-gt-fanout');
  });

  it('the target of a fan-out keeps all its instances when the run is scaled', () => {
    const d = design(
      [
        ['u', 'client'],
        ['api', 'service', { instances: 40, concurrency: 256 }],
        ['leaf', 'service', { instances: 40, concurrency: 256 }],
      ],
      [['u', 'api'], ['api', 'leaf', { fanout: 40 }]],
    );
    // leaf: only its slots may shrink (256 / 32 = 8); api alone would allow 32
    expect(planScale(d, 1e9).maxK).toBe(8);
  });
});
