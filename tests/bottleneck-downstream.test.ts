import { describe, expect, it } from 'vitest';
import { simulate } from '../src/engine/index.ts';
import { simulatePeak } from '../src/engine/limit.ts';
import { design, scenario } from './helpers.ts';

describe('bottleneck attribution follows blocking wait to saturated downstream', () => {
  it('brief repro: api 2x16 (10ms) -> db 4 conns (10/20ms) attributes bottleneck to db at 300, 368, 450 rps', () => {
    const d = design(
      [
        ['u', 'client'],
        ['lb', 'load_balancer'],
        ['api', 'service', { instances: 2, concurrency: 16, queueLimit: 200, serviceMs: { mean: 10, cv: 1 } }],
        ['db', 'database', { connections: 4, readMs: { mean: 10, cv: 1 }, writeMs: { mean: 20, cv: 1 }, queueLimit: 100 }],
      ],
      [
        ['u', 'lb'],
        ['lb', 'api'],
        ['api', 'db'],
      ],
    );
    const sc = scenario({ name: 'repro', seed: 1, durationS: 60, warmupS: 10, traffic: { rps: 1, readRatio: 0.9, clientTimeoutMs: 3000 } });

    const r300 = simulatePeak(d, sc, 300);
    expect(r300.sim.bottleneck?.node).toBe('db');

    for (const rps of [368, 450]) {
      const r = simulatePeak(d, sc, rps);
      expect(r.sim.nodes.api.origin.queue_full).toBeGreaterThan(0);
      expect(r.sim.bottleneck?.node).toBe('db');
      expect(r.sim.bottleneck?.why).toContain('Database');
      expect(r.sim.bottleneck?.why).toContain('API Server');
      expect(r.sim.bottleneck?.why).toContain('排隊滿');
    }
  });

  it('keeps upstream as bottleneck when downstream is not busy', () => {
    const d = design(
      [
        ['u', 'client'],
        ['api', 'service', { instances: 1, concurrency: 4, queueLimit: 20, serviceMs: { mean: 20, cv: 0 } }],
        ['db', 'database', { connections: 20, readMs: { mean: 5, cv: 0 }, writeMs: { mean: 5, cv: 0 }, queueLimit: 100 }],
      ],
      [
        ['u', 'api'],
        ['api', 'db'],
      ],
    );
    const sc = scenario({ name: 'up', seed: 1, durationS: 30, warmupS: 5, traffic: { rps: 250, readRatio: 0.9, clientTimeoutMs: 5000 } });
    const r = simulate(d, sc);
    expect(r.nodes.api.origin.queue_full).toBeGreaterThan(0);
    expect(r.nodes.db.peakUtilization).toBeLessThan(0.7);
    expect(r.bottleneck?.node).toBe('api');
  });

  it('keeps upstream as bottleneck when downstream is busy but upstream hold is close to its own work', () => {
    const d = design(
      [
        ['u', 'client', { weight: 1 }],
        ['other', 'client', { weight: 3 }],
        ['api', 'service', { instances: 1, concurrency: 8, queueLimit: 10, serviceMs: { mean: 50, cv: 0 } }],
        ['db', 'database', { connections: 2, readMs: { mean: 3, cv: 0 }, writeMs: { mean: 3, cv: 0 }, queueLimit: 500 }],
      ],
      [
        ['u', 'api'],
        ['api', 'db'],
        ['other', 'db'],
      ],
    );
    const sc = scenario({ name: 'own', seed: 1, durationS: 30, warmupS: 5, traffic: { rps: 800, readRatio: 0.9, clientTimeoutMs: 5000 } });
    const r = simulate(d, sc);
    expect(r.nodes.api.origin.queue_full).toBeGreaterThan(0);
    expect(r.nodes.db.peakUtilization).toBeGreaterThanOrEqual(0.95);
    expect(r.nodes.api.holdMs!).toBeLessThan(50 * 3);
    expect(r.bottleneck?.node).toBe('api');
  });

  it('follows multi-hop chain a -> b -> c to saturated leaf c (even if middle node b does not saturate)', () => {
    const d1 = design(
      [
        ['u', 'client'],
        ['a', 'service', { instances: 2, concurrency: 16, queueLimit: 100, serviceMs: { mean: 10, cv: 1 } }],
        ['b', 'service', { instances: 2, concurrency: 16, queueLimit: 100, serviceMs: { mean: 10, cv: 1 } }],
        ['c', 'database', { connections: 4, readMs: { mean: 10, cv: 1 }, writeMs: { mean: 20, cv: 1 }, queueLimit: 100 }],
      ],
      [
        ['u', 'a'],
        ['a', 'b'],
        ['b', 'c'],
      ],
    );
    const r1 = simulate(d1, scenario({ name: 'chain1', seed: 1, durationS: 40, warmupS: 5, traffic: { rps: 420, readRatio: 0.9, clientTimeoutMs: 5000 } }));
    expect(r1.nodes.a.origin.queue_full).toBeGreaterThan(0);
    expect(r1.bottleneck?.node).toBe('c');

    // Middle node b has 64 slots so its utilization stays ~0.25 and it never drops requests,
    // while a (16 slots) fills up waiting on b -> c.
    const d2 = design(
      [
        ['u', 'client'],
        ['a', 'service', { instances: 1, concurrency: 16, queueLimit: 20, serviceMs: { mean: 5, cv: 0 } }],
        ['b', 'service', { instances: 2, concurrency: 32, queueLimit: 200, serviceMs: { mean: 5, cv: 0 } }],
        ['c', 'database', { connections: 2, readMs: { mean: 20, cv: 0 }, writeMs: { mean: 20, cv: 0 }, queueLimit: 200 }],
      ],
      [
        ['u', 'a'],
        ['a', 'b'],
        ['b', 'c'],
      ],
    );
    const r2 = simulate(d2, scenario({ name: 'chain2', seed: 1, durationS: 40, warmupS: 5, traffic: { rps: 150, readRatio: 1, clientTimeoutMs: 5000 } }));
    expect(r2.nodes.a.origin.queue_full).toBeGreaterThan(0);
    expect(r2.nodes.b.peakUtilization).toBeLessThan(0.95);
    expect(r2.nodes.c.peakUtilization).toBeGreaterThanOrEqual(0.95);
    expect(r2.bottleneck?.node).toBe('c');
  });

  it('with multiple busy downstreams, points to the one causing the wait rather than any busy downstream', () => {
    const d = design(
      [
        ['u', 'client', { weight: 1 }],
        ['other', 'client', { weight: 5 }],
        ['api', 'service', { instances: 2, concurrency: 16, queueLimit: 50, serviceMs: { mean: 5, cv: 0 } }],
        ['db_fast', 'database', { connections: 1, readMs: { mean: 1, cv: 0 }, writeMs: { mean: 1, cv: 0 }, queueLimit: 500 }],
        ['db_slow', 'database', { connections: 4, readMs: { mean: 30, cv: 0 }, writeMs: { mean: 30, cv: 0 }, queueLimit: 200 }],
      ],
      [
        ['u', 'api'],
        ['api', 'db_fast', { on: 'write' }],
        ['api', 'db_slow'],
        ['other', 'db_fast'],
      ],
    );
    const r = simulate(d, scenario({ name: 'multi', seed: 1, durationS: 40, warmupS: 5, traffic: { rps: 1150, readRatio: 0.9, clientTimeoutMs: 5000 } }));
    expect(r.nodes.api.origin.queue_full).toBeGreaterThan(0);
    expect(r.nodes.db_fast.peakUtilization).toBeGreaterThanOrEqual(0.95);
    expect(r.nodes.db_slow.peakUtilization).toBeGreaterThanOrEqual(0.95);
    expect(r.bottleneck?.node).toBe('db_slow');
  });

  it('stays consistent after scaleResult() when scale > 1', () => {
    const d = design(
      [
        ['u', 'client'],
        ['lb', 'load_balancer'],
        ['api', 'service', { instances: 4, concurrency: 64, queueLimit: 50, serviceMs: { mean: 10, cv: 1 } }],
        ['db', 'database', { connections: 64, readMs: { mean: 10, cv: 1 }, writeMs: { mean: 20, cv: 1 }, queueLimit: 2000 }],
      ],
      [
        ['u', 'lb'],
        ['lb', 'api'],
        ['api', 'db'],
      ],
    );
    const r = simulate(d, scenario({ name: 'scaled', seed: 1, scale: 2, durationS: 40, warmupS: 5, traffic: { rps: 6500, readRatio: 0.9, clientTimeoutMs: 3000 } }));
    expect(r.scale).toBe(2);
    expect(r.nodes.api.origin.queue_full).toBeGreaterThan(0);
    expect(r.bottleneck?.node).toBe('db');
    const qf = r.nodes.api.origin.queue_full.toLocaleString('en-US');
    expect(r.bottleneck?.why).toContain(qf);
  });

  it('does not blame a downstream that only saturates in a different time window than upstream rejections', () => {
    // Repro from review P2-1: api (4 slots) has 100 ms edge latency (so holdMs >> own),
    // drops requests in 0..20s while db is idle; traffic shifts off api at 20s and db slows at 25s.
    const d = design(
      [
        ['u', 'client'],
        ['lb', 'load_balancer'],
        ['api', 'service', { instances: 1, concurrency: 4, queueLimit: 10, serviceMs: { mean: 5, cv: 0 } }],
        ['other', 'service', { instances: 2, concurrency: 16, queueLimit: 200, serviceMs: { mean: 5, cv: 0 } }],
        ['db', 'database', { connections: 4, readMs: { mean: 5, cv: 0 }, writeMs: { mean: 5, cv: 0 }, queueLimit: 200 }],
      ],
      [
        ['u', 'lb'],
        ['lb', 'api', { weight: 100 }],
        ['lb', 'other', { weight: 0 }],
        ['api', 'db', { latencyMs: 100 }],
        ['other', 'db', { latencyMs: 0 }],
      ],
    );
    const sc = scenario({
      name: 'disjoint-windows',
      seed: 1,
      durationS: 40,
      warmupS: 0,
      traffic: { rps: 100, readRatio: 1, clientTimeoutMs: 5000 },
      events: [
        { type: 'shift', atS: 20, from: 'lb', to: 'api', weight: 0 },
        { type: 'shift', atS: 20, from: 'lb', to: 'other', weight: 100 },
        { type: 'slow', atS: 25, node: 'db', multiplier: 20 },
      ],
    });
    const r = simulate(d, sc);
    expect(r.nodes.api.origin.queue_full).toBeGreaterThan(0);
    expect(r.nodes.db.peakUtilization).toBeGreaterThanOrEqual(0.95);
    expect(r.bottleneck?.node).toBe('api');
    expect(r.bottleneck?.why).not.toContain('當時是在等');
  });

  it('keeps upstream as bottleneck when hold is inflated by high edge latency while downstream is not saturated', () => {
    const d = design(
      [
        ['u', 'client'],
        ['api', 'service', { instances: 1, concurrency: 4, queueLimit: 10, serviceMs: { mean: 5, cv: 0 } }],
        ['db', 'database', { connections: 32, readMs: { mean: 5, cv: 0 }, writeMs: { mean: 5, cv: 0 }, queueLimit: 200 }],
      ],
      [
        ['u', 'api'],
        ['api', 'db', { latencyMs: 100 }],
      ],
    );
    const r = simulate(d, scenario({ name: 'edge-lat', seed: 1, durationS: 20, warmupS: 0, traffic: { rps: 100, readRatio: 1, clientTimeoutMs: 5000 } }));
    expect(r.nodes.api.origin.queue_full).toBeGreaterThan(0);
    expect(r.nodes.api.holdMs!).toBeGreaterThan(150);
    expect(r.nodes.db.peakUtilization).toBeLessThan(0.5);
    expect(r.bottleneck?.node).toBe('api');
  });

  it('computes edge wait share within the upstream rejection windows rather than the whole run', () => {
    // 0..15s: db1 slows and causes api rejections; 15..60s: traffic drops (no api rejections) while db2
    // slows for 45s and accumulates more total wait over the whole run than db1.
    const d = design(
      [
        ['u', 'client'],
        ['api', 'service', { instances: 1, concurrency: 8, queueLimit: 10, serviceMs: { mean: 5, cv: 0 } }],
        ['db1', 'database', { connections: 2, readMs: { mean: 10, cv: 0 }, writeMs: { mean: 10, cv: 0 }, queueLimit: 200 }],
        ['db2', 'database', { connections: 2, readMs: { mean: 10, cv: 0 }, writeMs: { mean: 10, cv: 0 }, queueLimit: 200 }],
      ],
      [
        ['u', 'api'],
        ['api', 'db1'],
        ['api', 'db2'],
      ],
    );
    const sc = scenario({
      name: 'wait-share-windows',
      seed: 1,
      durationS: 60,
      warmupS: 0,
      traffic: { rps: 100, readRatio: 1, clientTimeoutMs: 10000 },
      events: [
        { type: 'slow', atS: 0, forS: 15, node: 'db1', multiplier: 20 },
        { type: 'spike', atS: 15, forS: 45, multiplier: 0.1 },
        { type: 'slow', atS: 15, forS: 45, node: 'db2', multiplier: 19.5 },
      ],
    });
    const r = simulate(d, sc);
    expect(r.nodes.api.origin.queue_full).toBeGreaterThan(0);
    expect(r.nodes.db1.peakUtilization).toBeGreaterThanOrEqual(0.95);
    expect(r.nodes.db2.peakUtilization).toBeGreaterThanOrEqual(0.95);
    expect(r.bottleneck?.node).toBe('db1');
  });

  it('P2-A: does not blame saturated downstream when upstream is slowed by a slow event rather than waiting', () => {
    // Upstream api is slowed 20x (5ms -> 100ms own work) and rejects at queue_full;
    // downstream db takes ~1ms per call and is saturated by another client.
    // Wait time is ~1% of api hold time, so api must remain the bottleneck.
    const d = design(
      [
        ['u', 'client', { weight: 1 }],
        ['other', 'client', { weight: 20 }],
        ['api', 'service', { instances: 1, concurrency: 4, queueLimit: 10, serviceMs: { mean: 5, cv: 0 } }],
        ['db', 'database', { connections: 1, readMs: { mean: 1, cv: 0 }, writeMs: { mean: 1, cv: 0 }, queueLimit: 5 }],
      ],
      [
        ['u', 'api'],
        ['api', 'db'],
        ['other', 'db'],
      ],
    );
    const sc = scenario({
      name: 'slow-upstream-busy-db',
      seed: 1,
      durationS: 30,
      warmupS: 0,
      traffic: { rps: 1050, readRatio: 1, clientTimeoutMs: 5000 },
      events: [{ type: 'slow', atS: 0, node: 'api', multiplier: 20 }],
    });
    const r = simulate(d, sc);
    expect(r.nodes.api.origin.queue_full).toBeGreaterThan(0);
    expect(r.nodes.db.peakUtilization).toBeGreaterThanOrEqual(0.95);
    expect(r.bottleneck?.node).toBe('api');
  });

  it('P2-A: does not double-count parallel edge waits when checking the waiting share of slot hold time', () => {
    // api has 5ms own work and calls two downstreams in parallel (each ~4ms), so actual waiting time
    // is ~4ms out of ~9ms slot hold (~44% < 2/3), whereas summing both edges gives ~8ms (~89% >= 2/3).
    // Even if db1 is saturated by another client, api must remain the bottleneck.
    const d = design(
      [
        ['u', 'client', { weight: 1 }],
        ['other', 'client', { weight: 10 }],
        ['api', 'service', { instances: 1, concurrency: 2, queueLimit: 5, serviceMs: { mean: 5, cv: 0 }, calls: 'parallel' }],
        ['db1', 'database', { connections: 1, readMs: { mean: 2, cv: 0 }, writeMs: { mean: 2, cv: 0 }, queueLimit: 1 }],
        ['db2', 'database', { connections: 10, readMs: { mean: 4, cv: 0 }, writeMs: { mean: 4, cv: 0 }, queueLimit: 100 }],
      ],
      [
        ['u', 'api'],
        ['api', 'db1'],
        ['api', 'db2'],
        ['other', 'db1'],
      ],
    );
    const sc = scenario({
      name: 'parallel-no-double-count',
      seed: 1,
      durationS: 30,
      warmupS: 5,
      traffic: { rps: 5500, readRatio: 1, clientTimeoutMs: 5000 },
    });
    const r = simulate(d, sc);
    expect(r.nodes.api.origin.queue_full).toBeGreaterThan(0);
    expect(r.nodes.db1.peakUtilization).toBeGreaterThanOrEqual(0.95);
    expect(r.bottleneck?.node).toBe('api');
  });

  it('P2-B: accounts cross-window downstream wait to upstream rejection windows so a slow parallel call is not ignored', () => {
    // Repro from review P2-B: api calls a (4s) and b (<=10ms) in parallel; traffic stops at 2s.
    // Calls to a take 4s so none complete within the 0..2s rejection windows; b is saturated by another client.
    const d = design(
      [
        ['u', 'client', { weight: 1 }],
        ['other', 'client', { weight: 8 }],
        ['api', 'service', { instances: 1, concurrency: 4, queueLimit: 5, serviceMs: { mean: 1, cv: 0 }, calls: 'parallel' }],
        ['a', 'service', { instances: 1, concurrency: 4, queueLimit: 200, serviceMs: { mean: 4000, cv: 0 } }],
        ['b', 'database', { connections: 1, readMs: { mean: 8, cv: 0 }, writeMs: { mean: 8, cv: 0 }, queueLimit: 2 }],
      ],
      [
        ['u', 'api'],
        ['api', 'a'],
        ['api', 'b'],
        ['other', 'b'],
      ],
    );
    const sc = scenario({
      name: 'cross-window-parallel-wait',
      seed: 1,
      durationS: 10,
      warmupS: 0,
      traffic: { rps: 450, readRatio: 1, clientTimeoutMs: 10000 },
      events: [{ type: 'spike', atS: 2, forS: 8, multiplier: 0 }],
    });
    const r = simulate(d, sc);
    expect(r.nodes.api.origin.queue_full).toBeGreaterThan(0);
    expect(r.nodes.a.peakUtilization).toBeGreaterThanOrEqual(0.95);
    expect(r.nodes.b.peakUtilization).toBeGreaterThanOrEqual(0.95);
    expect(r.bottleneck?.node).toBe('a');
  });

  it('P2-C: parallel calls only follow the longest-waiting edge and do not blame a shorter busy branch', () => {
    // Repro from review P2-C: api (4 slots, 1ms own) calls a (fixed 61ms, unsaturated) and
    // b (~15ms, queueLimit 200, running near capacity -> <=60ms, saturated) in parallel.
    // b does not extend api hold time (a dominates), so b must not be blamed.
    const d = design(
      [
        ['u', 'client', { weight: 100 }],
        ['other', 'client', { weight: 1 }],
        ['api', 'service', { instances: 1, concurrency: 4, queueLimit: 10, serviceMs: { mean: 1, cv: 0 }, calls: 'parallel' }],
        ['a', 'service', { instances: 1, concurrency: 64, queueLimit: 200, serviceMs: { mean: 61, cv: 0 } }],
        ['b', 'database', { connections: 1, readMs: { mean: 15, cv: 0.5 }, writeMs: { mean: 15, cv: 0.5 }, queueLimit: 200 }],
      ],
      [
        ['u', 'api'],
        ['api', 'a'],
        ['api', 'b'],
        ['other', 'b'],
      ],
    );
    const sc = scenario({
      name: 'parallel-second-branch-busy',
      seed: 1,
      durationS: 30,
      warmupS: 5,
      traffic: { rps: 101, readRatio: 1, clientTimeoutMs: 5000 },
    });
    const r = simulate(d, sc);
    expect(r.nodes.api.origin.queue_full).toBeGreaterThan(0);
    expect(r.nodes.a.peakUtilization).toBeLessThan(0.5);
    expect(r.nodes.b.peakUtilization).toBeGreaterThanOrEqual(0.95);
    expect(r.bottleneck?.node).toBe('api');
  });
});
