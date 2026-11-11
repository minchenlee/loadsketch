// Each component does what its card says.
import { describe, expect, it } from 'vitest';
import { Simulation, simulate } from '../src/engine/index.ts';
import { checkScenario } from '../src/schema/design.ts';
import { design, scenario, within } from './helpers.ts';

const rate = (calls: number, r: { measuredS: number }) => calls / r.measuredS;

describe('cache', () => {
  for (const h of [0, 0.5, 0.9]) {
    it(`cache-aside with hit ratio ${h}: database reads drop to (1 − h)·λ`, () => {
      const d = design(
        [
          ['users', 'client'],
          ['api', 'service', { instances: 4, concurrency: 64 }],
          ['cache', 'cache', { hitRatio: h }],
          ['db', 'database', { connections: 200 }],
        ],
        [['users', 'api'], ['api', 'cache'], ['api', 'db']],
      );
      const lam = 1000;
      const r = simulate(d, scenario({ seed: 2, durationS: 120, traffic: { rps: lam, readRatio: 1 } }));
      const db = rate(r.nodes.db.arrivals, r);
      if (h === 0) expect(within(db, lam, 0.03)).toBe(true);
      else expect(within(db, (1 - h) * lam, 0.03)).toBe(true);
      // a miss also writes the value back: cache sees reads + fills
      expect(within(rate(r.nodes.cache.arrivals, r), lam * (2 - h), 0.03)).toBe(true);
      expect(r.summary.fail.timeout + r.summary.fail.queue_full).toBe(0);
    });
  }

  it('writes go to the database, then invalidate the cache', () => {
    const d = design(
      [['users', 'client'], ['api', 'service', { instances: 2, concurrency: 64 }], ['cache', 'cache'], ['db', 'database', { connections: 100 }]],
      [['users', 'api'], ['api', 'cache'], ['api', 'db']],
    );
    const r = simulate(d, scenario({ seed: 4, durationS: 60, traffic: { rps: 500, readRatio: 0 } }));
    expect(within(rate(r.nodes.db.arrivals, r), 500, 0.04)).toBe(true);
    expect(within(rate(r.nodes.cache.arrivals, r), 500, 0.04)).toBe(true); // one invalidation per write
  });

  it('LRU with uniform keys: hit ratio ≈ capacity / key count', () => {
    const d = design(
      [
        ['users', 'client'],
        ['api', 'service', { instances: 4, concurrency: 64 }],
        ['cache', 'cache', { mode: 'lru', capacityKeys: 1000 }],
        ['db', 'database', { connections: 200 }],
      ],
      [['users', 'api'], ['api', 'cache'], ['api', 'db']],
    );
    const r = simulate(d, scenario({ seed: 5, durationS: 60, warmupS: 10, traffic: { rps: 2000, readRatio: 1 }, keys: { count: 10000, zipf: 0 } }));
    expect(r.nodes.cache.hitRatio!).toBeGreaterThan(0.09);
    expect(r.nodes.cache.hitRatio!).toBeLessThan(0.11);
  });

  it('LRU with skewed keys hits far more often than with uniform keys', () => {
    const mk = () =>
      design(
        [['users', 'client'], ['api', 'service', { instances: 4, concurrency: 64 }], ['cache', 'cache', { mode: 'lru', capacityKeys: 1000 }], ['db', 'database', { connections: 200 }]],
        [['users', 'api'], ['api', 'cache'], ['api', 'db']],
      );
    const r = simulate(mk(), scenario({ seed: 5, durationS: 30, warmupS: 10, traffic: { rps: 2000, readRatio: 1 }, keys: { count: 10000, zipf: 1 } }));
    expect(r.nodes.cache.hitRatio!).toBeGreaterThan(0.5);
  });

  it('TTL: entries expire, so a key read every ~100 ms with a 50 ms TTL hits about a third of the time', () => {
    // Per key: fill, then hits for 50 ms (Poisson, rate 10/s → 0.5 hits), then the next read misses.
    // Hit ratio ≈ 0.5 / 1.5. The fill takes a few ms, which lowers it a little.
    const d = design(
      [['users', 'client'], ['api', 'service', { instances: 2, concurrency: 64 }], ['cache', 'cache', { mode: 'lru', capacityKeys: 1000, ttlS: 0.05 }], ['db', 'database', { connections: 100 }]],
      [['users', 'api'], ['api', 'cache'], ['api', 'db']],
    );
    const r = simulate(d, scenario({ seed: 6, durationS: 60, traffic: { rps: 1000, readRatio: 1 }, keys: { count: 100, zipf: 0 } }));
    expect(r.nodes.cache.hitRatio!).toBeGreaterThan(0.28);
    expect(r.nodes.cache.hitRatio!).toBeLessThan(0.36);
  });
});

describe('rate limiter', () => {
  it('passes about ratePerSec and rejects the rest with 429', () => {
    const d = design(
      [['users', 'client'], ['rl', 'rate_limiter', { ratePerSec: 100, burst: 10 }], ['api', 'service', { instances: 2, concurrency: 64 }]],
      [['users', 'rl'], ['rl', 'api']],
    );
    const r = simulate(d, scenario({ seed: 1, durationS: 60, traffic: { rps: 200, arrivals: 'constant' } }));
    expect(within(r.summary.throughputRps, 100, 0.02)).toBe(true);
    expect(within(r.summary.fail.rate_limited / r.measuredS, 100, 0.03)).toBe(true);
    expect(r.nodes.rl.origin.rate_limited).toBeGreaterThan(0);
  });

  it('lets a burst through when traffic is under the rate', () => {
    const d = design([['users', 'client'], ['rl', 'rate_limiter', { ratePerSec: 100, burst: 50 }], ['api', 'service']], [['users', 'rl'], ['rl', 'api']]);
    const r = simulate(d, scenario({ seed: 1, durationS: 30, traffic: { rps: 80 } }));
    expect(r.summary.fail.rate_limited / r.summary.offered).toBeLessThan(0.01);
  });
});

describe('timeouts and retries', () => {
  it('retries turn a 50% error rate into 12.5% failures at 1.75× the calls', () => {
    const d = design(
      [['users', 'client'], ['api', 'service', { instances: 2, concurrency: 64 }], ['pay', 'service', { instances: 2, concurrency: 64, errorRate: 0.5 }]],
      [['users', 'api'], ['api', 'pay', { retries: 2, backoffMs: 10 }]],
    );
    const lam = 500;
    const r = simulate(d, scenario({ seed: 3, durationS: 120, traffic: { rps: lam } }));
    const fail = r.summary.fail.error / r.summary.offered;
    expect(within(fail, 0.125, 0.06)).toBe(true);
    const e = r.edges['api->pay'];
    expect(within(rate(e.calls, r), lam * 1.75, 0.03)).toBe(true);
    expect(within(rate(e.retries, r), lam * 0.75, 0.04)).toBe(true);
  });

  it('a timed-out call keeps the callee busy (wasted work)', () => {
    const d = design(
      [['users', 'client'], ['api', 'service', { instances: 1, concurrency: 64 }], ['slow', 'service', { instances: 1, concurrency: 64, serviceMs: { mean: 100, cv: 0 } }]],
      [['users', 'api'], ['api', 'slow', { timeoutMs: 50 }]],
    );
    const lam = 200;
    const r = simulate(d, scenario({ seed: 1, durationS: 60, traffic: { rps: lam } }));
    expect(r.summary.ok).toBe(0);
    expect(r.summary.fail.timeout).toBe(r.summary.offered);
    // slow still works 100 ms per call: busy = λ·0.1 s / 64 slots
    expect(within(r.nodes.slow.utilization!, (lam * 0.1) / 64, 0.05)).toBe(true);
    expect(r.edges['api->slow'].late).toBeGreaterThan(0);
  });

  it('without a timeout, a slow downstream fills the caller\'s threads (blocking)', () => {
    const d = design(
      [['users', 'client'], ['api', 'service', { instances: 1, concurrency: 16, serviceMs: { mean: 1, cv: 0 } }], ['slow', 'service', { instances: 1, concurrency: 512, serviceMs: { mean: 100, cv: 0 } }]],
      [['users', 'api'], ['api', 'slow']],
    );
    const r = simulate(d, scenario({ seed: 1, durationS: 30, traffic: { rps: 300 } }));
    // each request holds an api thread for ~101 ms: 300/s × 0.101 s ≈ 30 threads wanted, 16 available
    expect(r.nodes.api.utilization!).toBeGreaterThan(0.97);
    expect(r.nodes.api.origin.queue_full + r.summary.fail.timeout).toBeGreaterThan(0);
    expect(r.nodes.slow.utilization!).toBeLessThan(0.1);
    expect(r.bottleneck?.node).toBe('api');
    expect(r.bottleneck?.why).toContain('等下游');
  });
});

describe('circuit breaker', () => {
  it('opens when the downstream fails, rejects fast while open, and closes after it recovers', () => {
    const d = design(
      [
        ['users', 'client'],
        ['api', 'service', { instances: 2, concurrency: 64 }],
        ['cb', 'circuit_breaker', { failureRatio: 0.5, minCalls: 20, windowS: 5, openMs: 2000, halfOpenCalls: 3 }],
        ['pay', 'service', { instances: 2, concurrency: 64 }],
      ],
      [['users', 'api'], ['api', 'cb'], ['cb', 'pay', { timeoutMs: 200 }]],
    );
    const r = simulate(d, scenario({ seed: 1, durationS: 40, traffic: { rps: 200 }, events: [{ type: 'errors', atS: 10, forS: 10, node: 'pay', rate: 1 }] }));
    const cb = r.timeline.filter((e) => e.node === 'cb').map((e) => [e.type, e.t] as const);
    // The 5 s window still holds ~1000 good calls when errors start at 10 s; failures reach half of
    // the window at about 12.3 s (seconds 8–12: 400 good, 500 bad).
    const firstOpen = cb.find(([t]) => t === 'cb_open');
    expect(firstOpen).toBeDefined();
    expect(firstOpen![1]).toBeGreaterThanOrEqual(12);
    expect(firstOpen![1]).toBeLessThan(13);
    const lastClose = [...cb].reverse().find(([t]) => t === 'cb_closed');
    expect(lastClose).toBeDefined();
    expect(lastClose![1]).toBeGreaterThanOrEqual(20);
    expect(lastClose![1]).toBeLessThan(23);
    expect(r.summary.fail.circuit_open).toBeGreaterThan(1000);
    // while open, pay gets almost nothing: far fewer calls than the 10 s × 200/s offered during the incident
    expect(r.nodes.pay.arrivals).toBeLessThan(r.nodes.api.arrivals - 1000);
    expect(r.nodes.cb.circuitOpens!).toBeGreaterThanOrEqual(1);
  });
});

describe('databases', () => {
  it('replicas take the reads; the primary takes writes; replicas also apply writes', () => {
    const d = design(
      [['users', 'client'], ['api', 'service', { instances: 2, concurrency: 64 }], ['db', 'database', { replicas: 2, connections: 50, replicaApplyRatio: 0.3 }]],
      [['users', 'api'], ['api', 'db']],
    );
    const lam = 1000;
    const r = simulate(d, scenario({ seed: 1, durationS: 60, traffic: { rps: lam, readRatio: 0.8 } }));
    const [p, r1, r2] = r.nodes.db.instances!;
    expect(within(rate(p.started, r), 0.2 * lam, 0.05)).toBe(true);
    // each replica: half the reads + every write applied
    expect(within(rate(r1.started, r), 0.4 * lam + 0.2 * lam, 0.05)).toBe(true);
    expect(within(rate(r2.started, r), 0.4 * lam + 0.2 * lam, 0.05)).toBe(true);
    expect(r.nodes.db.replicationApplied! / r.measuredS).toBeGreaterThan(0.38 * lam);
  });

  it('a hot key makes one shard busier than the others', () => {
    const mk = () =>
      design(
        [['users', 'client'], ['api', 'service', { instances: 4, concurrency: 64 }], ['db', 'sharded_db', { shards: 4, connections: 20 }]],
        [['users', 'api'], ['api', 'db']],
      );
    const flat = simulate(mk(), scenario({ seed: 1, durationS: 40, traffic: { rps: 2000 }, keys: { count: 100000, zipf: 0 } }));
    const hot = simulate(mk(), scenario({ seed: 1, durationS: 40, traffic: { rps: 2000 }, keys: { count: 1000, zipf: 1.3 } }));
    const skew = (x: typeof flat) => x.nodes.db.maxInstanceUtilization! / x.nodes.db.utilization!;
    expect(skew(flat)).toBeLessThan(1.1);
    expect(skew(hot)).toBeGreaterThan(1.3);
  });

  it('primary down: writes fail with "down", reads from replicas keep working', () => {
    const d = design(
      [['users', 'client'], ['api', 'service', { instances: 2, concurrency: 64 }], ['db', 'database', { replicas: 1, connections: 50 }]],
      [['users', 'api'], ['api', 'db']],
    );
    const r = simulate(d, scenario({ seed: 1, durationS: 40, traffic: { rps: 500, readRatio: 0.8 }, events: [{ type: 'down', atS: 10, forS: 10, node: 'db', instance: 0 }] }));
    // about 10 s × 100 writes/s fail
    expect(r.summary.fail.down).toBeGreaterThan(900);
    expect(r.summary.fail.down).toBeLessThan(1100);
    expect(r.summary.fail.timeout).toBe(0);
    expect(r.timeline.map((e) => e.type)).toEqual(['down', 'up']);
  });
});

describe('load balancer', () => {
  for (const policy of ['round_robin', 'least_conn', 'p2c', 'random']) {
    it(`${policy}: spreads load and skips an instance that is down`, () => {
      const d = design(
        [['users', 'client'], ['lb', 'load_balancer', { policy }], ['api', 'service', { instances: 3, concurrency: 16 }]],
        [['users', 'lb'], ['lb', 'api']],
      );
      const r = simulate(d, scenario({ seed: 1, durationS: 40, traffic: { rps: 900 }, events: [{ type: 'down', atS: 10, forS: 10, node: 'api', instance: 0 }] }));
      const st = r.nodes.api.instances!.map((i) => i.started);
      // instance 0 was down a quarter of the measured time
      expect(st[0]).toBeLessThan(st[1] * 0.85);
      expect(within(st[1], st[2], 0.08)).toBe(true);
      // only requests that were on instance 0 when it crashed fail
      expect(r.summary.fail.down).toBeLessThan(40);
    });
  }

  it('least_conn queues less than random under the same load', () => {
    const mk = (policy: string) =>
      design([['users', 'client'], ['lb', 'load_balancer', { policy }], ['api', 'service', { instances: 4, concurrency: 1, queueLimit: 10000 }]], [['users', 'lb'], ['lb', 'api', { latencyMs: 0 }]]);
    const sc = scenario({ seed: 1, durationS: 120, traffic: { rps: 300, clientTimeoutMs: 60000 } }); // ρ = 0.75
    const lc = simulate(mk('least_conn'), sc);
    const rnd = simulate(mk('random'), sc);
    expect(lc.nodes.api.waitMs!).toBeLessThan(rnd.nodes.api.waitMs! * 0.5);
  });
});

describe('queue and workers', () => {
  const mk = (workers: number) =>
    design(
      [
        ['users', 'client'],
        ['api', 'service', { instances: 2, concurrency: 64 }],
        ['q', 'queue'],
        ['w', 'worker', { instances: workers, concurrency: 4, serviceMs: { mean: 20, cv: 1 } }],
        ['db', 'database', { connections: 100 }],
      ],
      [['users', 'api'], ['api', 'q'], ['q', 'w'], ['w', 'db']],
    );

  it('the API answers right after enqueue; workers drain at their own pace', () => {
    const r = simulate(mk(2), scenario({ seed: 1, durationS: 60, traffic: { rps: 200, readRatio: 0 } }));
    // each job holds a worker slot for 20 ms of work + a 10 ms database write: 200/s × 30 ms = 6 of 8 slots
    expect(within(r.nodes.w.utilization!, 0.75, 0.05)).toBe(true);
    // users wait for the API (5 ms, exponential) and the enqueue (2 ms), not for the worker
    expect(r.summary.latencyMs.p99).toBeLessThan(40);
    expect(r.summary.asyncLatencyMs.count).toBeGreaterThan(10000);
    // the worker pool shares one queue: theory treats it as one M/G/8
    expect(r.nodes.w.theory?.servers).toBe(8);
  });

  it('too few workers: the queue grows and becomes the bottleneck, but users still get fast answers', () => {
    const r = simulate(mk(1), scenario({ seed: 1, durationS: 60, traffic: { rps: 300, readRatio: 0 } }));
    expect(r.nodes.q.queueDepthEnd!).toBeGreaterThan(5000);
    expect(r.bottleneck?.node).toBe('q');
    expect(r.summary.latencyMs.p99).toBeLessThan(40);
  });
});

describe('edge routing', () => {
  it('read-only and write-only edges split the traffic', () => {
    const d = design(
      [['users', 'client'], ['api', 'service', { instances: 2, concurrency: 64 }], ['ro', 'database', { connections: 100 }], ['rw', 'database', { connections: 100 }]],
      [['users', 'api'], ['api', 'ro', { on: 'read' }], ['api', 'rw', { on: 'write' }]],
    );
    const r = simulate(d, scenario({ seed: 1, durationS: 60, traffic: { rps: 1000, readRatio: 0.7 } }));
    expect(within(rate(r.nodes.ro.arrivals, r), 700, 0.03)).toBe(true);
    expect(within(rate(r.nodes.rw.arrivals, r), 300, 0.05)).toBe(true);
  });

  it('CDN answers hits at the edge and forwards misses and writes', () => {
    const d = design([['users', 'client'], ['cdn', 'cdn', { hitRatio: 0.8 }], ['api', 'service', { instances: 2, concurrency: 64 }]], [['users', 'cdn'], ['cdn', 'api']]);
    const r = simulate(d, scenario({ seed: 1, durationS: 60, traffic: { rps: 1000, readRatio: 0.9 } }));
    expect(within(rate(r.nodes.api.arrivals, r), 1000 * (0.9 * 0.2 + 0.1), 0.04)).toBe(true);
  });
});

describe('accounting edge cases', () => {
  it('a load balancer with no healthy target counts each failed request once', () => {
    const d = design([['u', 'client'], ['lb', 'load_balancer'], ['a', 'service']], [['u', 'lb'], ['lb', 'a']]);
    const r = simulate(d, scenario({ durationS: 10, warmupS: 0, traffic: { rps: 100, arrivals: 'constant' }, events: [{ type: 'down', node: 'a', atS: 0, forS: 100 }] }));
    const lb = r.nodes.lb;
    expect(lb.arrivals).toBeGreaterThan(900);
    expect(lb.fail).toBe(lb.arrivals);
    expect(lb.origin?.down).toBe(lb.arrivals);
    expect(r.summary.fail.down).toBe(r.summary.offered);
  });

  it('a window longer than the run is shortened, so rates are measured over the traffic time only', () => {
    const d = design([['u', 'client'], ['a', 'service', { concurrency: 100, serviceMs: 0 }]], [['u', 'a']]);
    const r = simulate(d, scenario({ durationS: 10, warmupS: 0, windowS: 60, traffic: { rps: 100, arrivals: 'constant' } }));
    expect(r.measuredS).toBe(10);
    expect(within(r.summary.throughputRps, 100, 0.01)).toBe(true);
    expect(within(r.nodes.a.rps, 100, 0.01)).toBe(true);
  });
});

describe('review fixes', () => {
  it('many large spikes outside the run do not stall the arrival generator', () => {
    const d = design([['u', 'client'], ['a', 'service', { concurrency: 100, serviceMs: 0 }]], [['u', 'a']]);
    const events = Array.from({ length: 103 }, () => ({ type: 'spike' as const, atS: 500, forS: 1, multiplier: 1000 }));
    const r = simulate(d, scenario({ durationS: 10, warmupS: 0, traffic: { rps: 100 }, events }));
    expect(within(r.summary.offered, 1000, 0.15)).toBe(true);
  });

  it('Poisson arrivals follow a spike exactly (piecewise thinning)', () => {
    const d = design([['u', 'client'], ['a', 'service', { concurrency: 1000, serviceMs: 0 }]], [['u', 'a']]);
    const sc = scenario({ seed: 3, durationS: 30, warmupS: 0, traffic: { rps: 200 }, events: [{ type: 'spike', atS: 10, forS: 10, multiplier: 3 }] });
    const r = simulate(d, sc);
    expect(within(r.summary.offered, 200 * 20 + 600 * 10, 0.03)).toBe(true);
  });

  it('a cache that crashes during a read-through fails the read and comes back empty', () => {
    const d = design(
      [['u', 'client'], ['c', 'cache', { mode: 'lru', capacityKeys: 10 }], ['db', 'database', { readMs: { mean: 100, cv: 0 } }]],
      [['u', 'c'], ['c', 'db']],
    );
    // one key; reads at 1 s, 2 s, 3 s; the cache is down from 1.001 s to 1.5 s
    const r = simulate(d, scenario({ durationS: 4, warmupS: 0, traffic: { rps: 1, arrivals: 'constant', readRatio: 1 }, keys: { count: 1, zipf: 0 }, events: [{ type: 'down', node: 'c', atS: 1.001, forS: 0.499 }] }));
    expect(r.summary.fail.down).toBe(1); // the read at 1 s
    // 1 s and 2 s miss (the crashed read filled nothing), 3 s hits. Before the fix: 2 of 3 hit.
    expect(r.nodes.c.hitRatio).toBeCloseTo(1 / 3, 3);
  });

  it('a breaker with failureRatio 0 does not trip on successes', () => {
    const d = design([['u', 'client'], ['cb', 'circuit_breaker', { failureRatio: 0, minCalls: 1 }], ['a', 'service']], [['u', 'cb'], ['cb', 'a']]);
    const r = simulate(d, scenario({ durationS: 10, warmupS: 0, traffic: { rps: 50 } }));
    expect(r.summary.fail.circuit_open).toBe(0);
    expect(r.summary.ok).toBe(r.summary.offered);
  });

  it('a reply that comes back after the caller timed out counts as late', () => {
    const d = design([['u', 'client'], ['lb', 'load_balancer'], ['a', 'service', { serviceMs: 0 }]], [['u', 'lb'], ['lb', 'a', { latencyMs: 100, timeoutMs: 150 }]]);
    const r = simulate(d, scenario({ durationS: 5, warmupS: 0, traffic: { rps: 10, arrivals: 'constant' } }));
    const e = r.edges['lb->a'];
    expect(e.calls).toBeGreaterThan(40);
    // every reply needs 200 ms and the caller waits 150 ms; the last two replies land after the run
    expect(e.late).toBeGreaterThanOrEqual(e.calls - 2);
    expect(e.ok).toBe(0);
  });

  it('a run that does not end on a window boundary counts the same requests in the summary and the nodes', () => {
    const d = design([['u', 'client'], ['a', 'service', { concurrency: 100, serviceMs: 0 }]], [['u', 'a']]);
    const r = simulate(d, scenario({ durationS: 2.5, warmupS: 0, windowS: 1, traffic: { rps: 10, arrivals: 'constant' } }));
    expect(r.measuredS).toBe(2);
    expect(r.summary.offered).toBe(r.nodes.a.arrivals);
    expect(within(r.summary.throughputRps, 10, 0.06)).toBe(true);
  });

  it('reports background work cut off at the end of the run', () => {
    const d = design(
      [['u', 'client'], ['db', 'database', { replicas: 1, writeMs: { mean: 1000, cv: 0 }, replicaApplyRatio: 1 }]],
      [['u', 'db']],
    );
    const r = simulate(d, scenario({ durationS: 2, warmupS: 0, traffic: { rps: 1, arrivals: 'constant', readRatio: 0, clientTimeoutMs: 1 } }));
    expect(r.unfinished).toBeGreaterThan(0);
  });

  it('a worker crash during queue delivery counts as a failure on the queue edge', () => {
    const d = design(
      [['u', 'client'], ['q', 'queue'], ['w', 'worker', { concurrency: 4, serviceMs: { mean: 5, cv: 0 } }]],
      [['u', 'q'], ['q', 'w', { latencyMs: 20 }]],
    );
    const r = simulate(d, scenario({ durationS: 5, warmupS: 0, traffic: { rps: 200, readRatio: 0 }, events: [{ type: 'down', node: 'w', atS: 2, forS: 1 }] }));
    expect(r.nodes.w.fail).toBeGreaterThan(0);
    expect(r.edges['q->w'].fail).toBe(r.nodes.w.fail);
  });
});

describe('review fixes', () => {
  it('the thinning bound covers the true rate everywhere, also inside a very short ramp', () => {
    const d = design([['u', 'client'], ['a', 'service']], [['u', 'a']]);
    const cases = [
      [{ type: 'ramp', atS: 0, forS: 1e-9, toMultiplier: 1000 }],
      [{ type: 'ramp', atS: 1, forS: 2, toMultiplier: 0.2 }, { type: 'spike', atS: 1.5, forS: 1, multiplier: 0.5 }],
      [{ type: 'spike', atS: 2, forS: 0.001, multiplier: 50 }, { type: 'ramp', atS: 2.0005, forS: 0.3, toMultiplier: 7 }],
    ] as const;
    for (const events of cases) {
      const sim = new Simulation(d, scenario({ durationS: 5, warmupS: 0, traffic: { rps: 1000 }, events: events as never }));
      const x = sim as unknown as { rateSegs: { t0: number; t1: number; lam: number }[]; rateAt(t: number): number };
      for (const seg of x.rateSegs) {
        for (let k = 0; k <= 64; k++) {
          const t = seg.t0 + ((seg.t1 - seg.t0) * k) / 64.0001;
          expect(x.rateAt(t)).toBeLessThanOrEqual(seg.lam * (1 + 1e-12));
        }
      }
    }
  });

  it('unfinished counts a read held by the cache while the database is still answering', () => {
    const d = design(
      [['u', 'client'], ['c', 'cache', { mode: 'lru', capacityKeys: 10 }], ['db', 'database']],
      [['u', 'c'], ['c', 'db', { latencyMs: 60000 }]],
    );
    const r = simulate(d, scenario({ durationS: 2, warmupS: 0, traffic: { rps: 1, arrivals: 'constant', readRatio: 1, clientTimeoutMs: 1 } }));
    expect(r.unfinished).toBeGreaterThanOrEqual(1); // before the fix: 0
  });

  it('unfinished is 0 when all work is done, also with retries, timeouts, queues and crashes', () => {
    const d = design(
      [
        ['u', 'client'],
        ['lb', 'load_balancer'],
        ['a', 'service', { instances: 2, concurrency: 8 }],
        ['c', 'cache', { mode: 'lru', capacityKeys: 50 }],
        ['db', 'database', { connections: 10 }],
        ['q', 'queue'],
        ['w', 'worker', { concurrency: 2 }],
      ],
      [['u', 'lb'], ['lb', 'a', { timeoutMs: 30, retries: 2 }], ['a', 'c'], ['c', 'db', { timeoutMs: 20, retries: 1 }], ['a', 'q', { on: 'write' }], ['q', 'w']],
    );
    const sc = scenario({ durationS: 6, warmupS: 0, traffic: { rps: 300, readRatio: 0.7, clientTimeoutMs: 500 }, keys: { count: 200, zipf: 1 }, events: [{ type: 'down', node: 'c', atS: 2, forS: 1 }, { type: 'slow', node: 'db', atS: 3, forS: 1, multiplier: 10 }] });
    const sim = new Simulation(d, sc);
    sim.runUntil(Infinity);
    const x = sim as unknown as { pending: number; unfinished(): number };
    // the run stops at the end time; let every scheduled event finish, then nothing may be left
    const q = (sim as unknown as { q: { peekTime(): number; pop(): { t: number; f(): void } } }).q;
    const s = sim as unknown as { now: number };
    while (q.peekTime() < Infinity) {
      const e = q.pop();
      s.now = e.t;
      e.f();
    }
    expect(x.pending).toBe(0);
    expect(x.unfinished()).toBe(0);
  });

  it('warns when the default window is shortened', () => {
    const issues = checkScenario(scenario({ durationS: 1, warmupS: 0.5, traffic: { rps: 10 } }));
    expect(issues.some((i) => i.code === 'window')).toBe(true);
  });
});

describe('retry budget', () => {
  it('caps retries at the budget share of first attempts', () => {
    const d = design(
      [['users', 'client'], ['api', 'service', { instances: 2, concurrency: 64 }], ['pay', 'service', { instances: 2, concurrency: 64, errorRate: 0.5 }]],
      [['users', 'api'], ['api', 'pay', { retries: 2, backoffMs: 10, retryBudget: 0.1 }]],
    );
    const lam = 500;
    const r = simulate(d, scenario({ seed: 3, durationS: 60, traffic: { rps: lam } }));
    const e = r.edges['api->pay'];
    const first = e.calls - e.retries;
    // without the budget retries would be 0.75 × first (see above); with it at most ~10%
    expect(e.retries / first).toBeLessThanOrEqual(0.105);
    expect(e.retries / first).toBeGreaterThan(0.08);
    expect(e.denied!).toBeGreaterThan(0);
    // first attempt fails 50%; ~10% extra attempts recover about half of those
    expect(within(r.summary.fail.error / r.summary.offered, 0.45, 0.05)).toBe(true);
  });

  it('a budget of 0 means no limit', () => {
    const d = design(
      [['users', 'client'], ['api', 'service', { instances: 2, concurrency: 64 }], ['pay', 'service', { instances: 2, concurrency: 64, errorRate: 0.5 }]],
      [['users', 'api'], ['api', 'pay', { retries: 2, backoffMs: 10, retryBudget: 0 }]],
    );
    const r = simulate(d, scenario({ seed: 3, durationS: 30, traffic: { rps: 500 } }));
    expect(r.edges['api->pay'].denied).toBeUndefined();
    expect(within(r.edges['api->pay'].retries / (r.edges['api->pay'].calls - r.edges['api->pay'].retries), 0.75, 0.05)).toBe(true);
  });
});

describe('deadline propagation', () => {
  const chain = (deadline: string, edge: Record<string, number> = {}) =>
    design(
      [['users', 'client', { deadline }], ['api', 'service', { instances: 1, concurrency: 512, serviceMs: { mean: 1, cv: 0 } }], ['slow', 'service', { instances: 1, concurrency: 512, serviceMs: { mean: 300, cv: 0 } }]],
      [['users', 'api'], ['api', 'slow', edge]],
    );
  const sc = scenario({ seed: 2, durationS: 30, traffic: { rps: 200, clientTimeoutMs: 100 } });

  it('caps a hop without its own timeout at the client deadline', () => {
    const off = simulate(chain('off'), sc);
    const on = simulate(chain('propagate'), sc);
    // without the deadline api waits the full 300 ms; with it api gives up at ~99 ms (1 ms own work)
    expect(off.nodes.api.holdMs!).toBeGreaterThan(295);
    expect(within(on.nodes.api.holdMs!, 100, 0.03)).toBe(true);
    expect(within(on.edges['api->slow'].fail, on.edges['api->slow'].calls, 0.01)).toBe(true);
    expect(on.edges['api->slow'].ok).toBe(0);
    expect(on.summary.fail.timeout).toBe(on.summary.offered);
  });

  it('does not retry after the deadline', () => {
    const d = (deadline: string) =>
      design(
        [['users', 'client', { deadline }], ['api', 'service', { instances: 1, concurrency: 512 }], ['pay', 'service', { instances: 1, concurrency: 512, errorRate: 1, serviceMs: { mean: 5, cv: 0 } }]],
        [['users', 'api'], ['api', 'pay', { retries: 5, backoffMs: 100 }]],
      );
    const s = scenario({ seed: 4, durationS: 20, traffic: { rps: 100, clientTimeoutMs: 150 } });
    const off = simulate(d('off'), s).edges['api->pay'];
    const on = simulate(d('propagate'), s).edges['api->pay'];
    const perCall = (e: typeof off) => e.retries / (e.calls - e.retries);
    expect(within(perCall(off), 5, 0.01)).toBe(true);
    // backoffs of up to 100, 200, 400 ms: only the first one or two fit in 150 ms
    expect(perCall(on)).toBeGreaterThan(0.5);
    expect(perCall(on)).toBeLessThan(2.5);
  });

  it('drops queued work whose deadline passed instead of doing it', () => {
    const d = (deadline: string) =>
      design([['users', 'client', { deadline }], ['api', 'service', { instances: 1, concurrency: 1, serviceMs: { mean: 10, cv: 0 }, queueLimit: 100000 }]], [['users', 'api']]);
    const s = scenario({ seed: 5, durationS: 30, traffic: { rps: 200, clientTimeoutMs: 300 } });
    const off = simulate(d('off'), s);
    const on = simulate(d('propagate'), s);
    expect(off.nodes.api.expired).toBeUndefined();
    expect(on.nodes.api.expired!).toBeGreaterThan(1000);
    // 100/s capacity, 200/s offered: the queue grows without bound unless expired work leaves it
    expect(off.nodes.api.maxQueue!).toBeGreaterThan(2000);
    // about 300 ms of arrivals (60 on average) wait at most
    expect(on.nodes.api.maxQueue!).toBeLessThan(150);
  });

  it('does not apply to queue messages (the producer already got its answer)', () => {
    const d = design(
      [['users', 'client', { deadline: 'propagate' }], ['q', 'queue'], ['w', 'worker', { instances: 1, concurrency: 1, serviceMs: { mean: 20, cv: 0 } }]],
      [['users', 'q'], ['q', 'w']],
    );
    const r = simulate(d, scenario({ seed: 1, durationS: 20, traffic: { rps: 60, clientTimeoutMs: 100 } }));
    expect(r.nodes.w.expired).toBeUndefined();
    expect(r.nodes.q.asyncFail).toBe(0);
  });
});

describe('autoscaling', () => {
  const auto = (extra: Record<string, number | string> = {}) =>
    design(
      [['users', 'client'], ['svc', 'service', {
        instances: 2, concurrency: 10, serviceMs: { mean: 50, cv: 0 }, queueLimit: 100000,
        autoscale: 'on', maxInstances: 10, targetUtil: 0.6, scaleEveryS: 5, bootS: 10, warmS: 0, scaleDownS: 0, ...extra,
      }]],
      [['users', 'svc']],
    );

  it('measures utilisation over provisioned instances only', () => {
    // 300/s × 50 ms = 15 busy slots on 2 × 10: 75%, not 15/100
    const sim = new Simulation(auto(), scenario({ seed: 1, durationS: 5, warmupS: 0, traffic: { rps: 300 } }));
    sim.runUntil(4000);
    const w = sim.drainWindows();
    expect(within(w[2].nodes.svc.util!, 0.75, 0.1)).toBe(true);
    expect(w[2].nodes.svc.active).toBe(2);
  });

  it('adds instances after the boot delay, then the queue drains', () => {
    const sim = new Simulation(auto(), scenario({ seed: 1, durationS: 80, warmupS: 0, traffic: { rps: 300 }, events: [{ type: 'spike', atS: 10, forS: 70, multiplier: 2 }] }));
    const r = sim.runToEnd();
    const tl = r.timeline.filter((e) => e.node === 'svc');
    const out = tl.find((e) => e.type === 'scale_out')!;
    const ready = tl.find((e) => e.type === 'scale_ready')!;
    expect(out).toBeDefined();
    expect(ready.t - out.t).toBeCloseTo(10, 6);
    // 600/s × 50 ms = 30 busy slots; at 60% that is 5 instances
    // the backlog built during the boot delay makes it overshoot a little, as real autoscalers do
    expect(r.nodes.svc.autoscale!.peakActive).toBeGreaterThanOrEqual(5);
    expect(r.nodes.svc.autoscale!.peakActive).toBeLessThanOrEqual(10);
    const windows = sim.allWindows();
    // before the first new instance is ready, capacity stays at 2 (and the queue grows) ...
    const during = windows.find((w) => w.t > out.t + 1 && w.t < ready.t)!;
    expect(during.nodes.svc.active).toBe(2);
    expect(during.nodes.svc.booting).toBeGreaterThan(0);
    // ... and at the end it is gone
    expect(windows[windows.length - 2].nodes.svc.queue!).toBeLessThan(5);
  });

  it('removes instances when traffic drops (no scale-down window)', () => {
    const r = simulate(auto({ instances: 1 }), scenario({ seed: 2, durationS: 120, traffic: { rps: 100 }, events: [{ type: 'spike', atS: 5, forS: 40, multiplier: 5 }] }));
    const a = r.nodes.svc.autoscale!;
    expect(a.launches).toBeGreaterThan(0);
    expect(a.retires).toBeGreaterThan(0);
    expect(a.endActive).toBeLessThan(a.peakActive);
    expect(a.endActive).toBeGreaterThanOrEqual(a.min);
    expect(r.nodes.svc.utilization!).toBeLessThanOrEqual(1);
  });

  it('a new instance starts slower (cold start)', () => {
    const sc = scenario({ seed: 3, durationS: 60, warmupS: 0, traffic: { rps: 300 }, events: [{ type: 'spike', atS: 5, forS: 55, multiplier: 2 }] });
    const warm = simulate(auto({ warmS: 20, coldFactor: 1 }), sc);
    const cold = simulate(auto({ warmS: 20, coldFactor: 4 }), sc);
    expect(cold.nodes.svc.holdMs!).toBeGreaterThan(warm.nodes.svc.holdMs! * 1.1);
  });

  it('a fixed node keeps the old behaviour', () => {
    const r = simulate(auto({ autoscale: 'off' }), scenario({ seed: 1, durationS: 10, traffic: { rps: 300 } }));
    expect(r.nodes.svc.autoscale).toBeUndefined();
    expect(r.nodes.svc.instances!.length).toBe(2);
  });
});

describe('review fixes: deadline, budget, autoscaling', () => {
  it('gives back a reserved retry that the deadline cancelled', () => {
    // backoff up to 1 s, deadline 150 ms: most reserved retries are never sent
    const d = design(
      [['users', 'client', { deadline: 'propagate' }], ['api', 'service', { instances: 1, concurrency: 512 }], ['pay', 'service', { instances: 1, concurrency: 512, errorRate: 1, serviceMs: { mean: 5, cv: 0 } }]],
      [['users', 'api'], ['api', 'pay', { retries: 1, backoffMs: 1000, retryBudget: 0.5 }]],
    );
    const e = simulate(d, scenario({ seed: 6, durationS: 30, traffic: { rps: 100, clientTimeoutMs: 150 } })).edges['api->pay'];
    const first = e.calls - e.retries;
    // without the refund, cancelled reservations used up the budget and about half were denied
    expect(e.denied ?? 0).toBeLessThan(first * 0.02);
    expect(e.retries).toBeLessThan(first * 0.5);
  });

  // one slot held by a 5 s job: nothing is pulled from the queue for a long time
  const busy = (deadline: string) =>
    design([['users', 'client', { deadline }], ['api', 'service', { instances: 1, concurrency: 1, serviceMs: { mean: 5000, cv: 0 }, queueLimit: 100000 }]], [['users', 'api']]);

  it('counts queued work past its deadline as expired at the end of the run', () => {
    const s = scenario({ seed: 5, durationS: 8, warmupS: 0, traffic: { rps: 20, clientTimeoutMs: 300 } });
    const off = simulate(busy('off'), s);
    const on = simulate(busy('propagate'), s);
    expect(off.unfinished).toBeGreaterThan(40);
    // only the job in the single slot is left
    expect(on.unfinished).toBeLessThanOrEqual(1);
    expect(on.nodes.api.expired).toBeGreaterThan(60);
  });

  it('counts queued work past its deadline as expired, not down, when the node crashes', () => {
    const r = simulate(busy('propagate'), scenario({ seed: 5, durationS: 8, warmupS: 0, traffic: { rps: 20, clientTimeoutMs: 300 }, events: [{ type: 'down', node: 'api', atS: 4.9, forS: 0.1 }] }));
    // at 4.9 s ~97 jobs wait behind the first one; only the ~6 sent in the last 300 ms are alive
    expect(r.nodes.api.fail).toBeLessThan(20);
  });

  const small = (extra: Record<string, number | string> = {}) =>
    design(
      [['users', 'client'], ['svc', 'service', {
        instances: 1, concurrency: 4, serviceMs: { mean: 2000, cv: 0 }, queueLimit: 100000,
        autoscale: 'on', maxInstances: 3, targetUtil: 0.6, scaleEveryS: 5, bootS: 1, warmS: 0, scaleDownS: 0, ...extra,
      }]],
      [['users', 'svc']],
    );

  it('does not launch an instance that is down', () => {
    const r = simulate(small({ maxInstances: 2 }), scenario({ seed: 1, durationS: 30, warmupS: 0, traffic: { rps: 6, clientTimeoutMs: 10000 }, events: [{ type: 'down', node: 'svc', instance: 1, atS: 0 }] }));
    expect(r.nodes.svc.autoscale!.launches).toBe(0);
    expect(r.nodes.svc.autoscale!.peakActive).toBe(1);
  });

  it('turns off a retiring instance whose work was lost in a crash', () => {
    // scale-in at 50 s retires #2 while it runs a 2 s job; #2 crashes at 50.5 s and comes back
    const sim = new Simulation(small(), scenario({ seed: 1, durationS: 60, warmupS: 0, traffic: { rps: 2, clientTimeoutMs: 10000 }, events: [{ type: 'spike', atS: 0, forS: 20, multiplier: 3 }, { type: 'down', node: 'svc', instance: 2, atS: 50.5, forS: 1 }] }));
    sim.runUntil(50001);
    expect(sim.liveState().svc.inst![2][4]).toBe(4); // retiring, with work
    sim.runUntil(52000);
    expect(sim.liveState().svc.inst![2][4]).toBe(1); // off
  });
});

describe('queue delivery semantics', () => {
  const pipe = (q: Record<string, number | string>, w: Record<string, unknown> = {}) =>
    design(
      [['users', 'client'], ['q', 'queue', { enqueueMs: { mean: 1, cv: 0 }, ...q }], ['w', 'worker', { instances: 2, concurrency: 8, serviceMs: { mean: 50, cv: 0.5 }, ...w }]],
      [['users', 'q'], ['q', 'w']],
    );
  const sc = (events: NonNullable<Parameters<typeof scenario>[0]['events']> = [], rps = 100) =>
    scenario({ seed: 1, durationS: 60, warmupS: 0, traffic: { rps }, events });
  const crash = [{ type: 'down' as const, node: 'w', instance: 0, atS: 20, forS: 10 }];

  it('at most once loses the messages a crashed worker held; at least once redelivers them', () => {
    const amo = simulate(pipe({}), sc(crash)).nodes.q;
    const alo = simulate(pipe({ delivery: 'at_least_once', visibilityTimeoutMs: 2000 }), sc(crash)).nodes.q;
    expect(amo.asyncFail!).toBeGreaterThan(0);
    expect(amo.redelivered).toBeUndefined();
    expect(alo.asyncFail).toBe(0);
    expect(alo.redelivered!).toBeGreaterThanOrEqual(amo.asyncFail!);
    expect(alo.asyncOk!).toBeGreaterThan(amo.asyncOk!);
  });

  it('a visibility timeout shorter than the work makes idle workers do it twice', () => {
    const w = { instances: 4, concurrency: 64, serviceMs: { mean: 1500, cv: 0 } };
    const short = simulate(pipe({ delivery: 'at_least_once', visibilityTimeoutMs: 1000 }, w), sc([], 20)).nodes.q;
    const long = simulate(pipe({ delivery: 'at_least_once', visibilityTimeoutMs: 5000 }, w), sc([], 20)).nodes.q;
    expect(within(short.duplicates!, short.asyncOk!, 0.05)).toBe(true);
    expect(long.duplicates).toBe(0);
    expect(long.redelivered).toBe(0);
  });

  it('poison messages cycle forever without a DLQ and stop after maxReceives with one', () => {
    const w = { poisonRate: 0.02 };
    const none = simulate(pipe({ delivery: 'at_least_once', visibilityTimeoutMs: 2000 }, w), sc()).nodes.q;
    const dlq = simulate(pipe({ delivery: 'at_least_once', visibilityTimeoutMs: 2000, maxReceives: 3 }, w), sc()).nodes.q;
    expect(none.dlq).toBe(0);
    expect(none.redelivered!).toBeGreaterThan(1000);
    // ~2% of ~6,000 messages are poison; each is received 3 times, so redelivered twice
    expect(within(dlq.dlq!, 120, 0.3)).toBe(true);
    expect(dlq.redelivered!).toBeGreaterThanOrEqual(2 * dlq.dlq!);
    expect(dlq.redelivered!).toBeLessThan(2 * dlq.dlq! + 60);
    expect(dlq.asyncFail).toBe(dlq.dlq);
  });

  it('drops messages older than the TTL', () => {
    const slow = { instances: 1, concurrency: 2 }; // 40/s capacity for 100/s
    const keep = simulate(pipe({}, slow), sc()).nodes.q;
    const ttl = simulate(pipe({ messageTtlS: 5 }, slow), sc()).nodes.q;
    expect(keep.expired).toBeUndefined();
    expect(ttl.expired!).toBeGreaterThan(1000);
    expect(ttl.asyncFail).toBe(ttl.expired);
  });
});

describe('replication lag', () => {
  const db = (p: Record<string, unknown> = {}) =>
    design([['users', 'client'], ['db', 'database', { replicas: 2, ...p }]], [['users', 'db']]);
  const sc = (events: NonNullable<Parameters<typeof scenario>[0]['events']> = []) =>
    scenario({ seed: 1, durationS: 60, warmupS: 0, traffic: { rps: 1000, readRatio: 0.9 }, events });

  it('a longer shipping delay means more replica reads return old data', () => {
    const fast = simulate(db(), sc()).nodes.db;
    const slow = simulate(db({ replicaDelayMs: 1000 }), sc()).nodes.db;
    expect(fast.replicaReads!).toBeGreaterThan(50000);
    expect(fast.staleReads!).toBeLessThan(100);
    expect(slow.replicaReads).toBe(fast.replicaReads);
    expect(slow.staleReads!).toBeGreaterThan(30 * fast.staleReads!);
    expect(slow.maxReplLagMs!).toBeGreaterThanOrEqual(1000);
    expect(slow.maxReplLagMs!).toBeLessThan(1100);
  });

  it('maxLagMs sends reads to the primary while every replica is too far behind', () => {
    const r = simulate(db({ replicaDelayMs: 1000, maxLagMs: 500 }), sc()).nodes.db;
    // only reads before the first write is a second old go to a replica
    expect(r.replicaReads!).toBeLessThan(1000);
    expect(r.staleReads!).toBeLessThan(10);
    const ok = simulate(db({ replicaDelayMs: 200, maxLagMs: 500 }), sc()).nodes.db;
    expect(ok.replicaReads!).toBeGreaterThan(50000);
  });

  it('no apply cost means no replication model: the fields are absent', () => {
    const r = simulate(db({ replicaApplyRatio: 0, replicaDelayMs: 1000 }), sc()).nodes.db;
    expect(r.replicaReads).toBeUndefined();
    expect(r.staleReads).toBeUndefined();
  });

  const lagSeries = (d: ReturnType<typeof db>, events: Parameters<typeof sc>[0] = []) => {
    const sim = new Simulation(d, sc(events));
    sim.runUntil(Infinity);
    return { windows: sim.allWindows(), r: sim.result() };
  };

  it('a busy replica falls behind: its apply queue grows and the lag with it', () => {
    // one replica, 2 connections: applying 100 writes/s × 10 ms plus 900 reads/s × 3 ms needs 3.7
    const { windows, r } = lagSeries(db({ replicas: 1, connections: 2, replicaApplyRatio: 1, queueLimit: 1000000 }));
    const lags = windows.map((w) => w.nodes.db.replLagMs ?? 0);
    expect(lags[lags.length - 1]).toBeGreaterThan(lags[5] + 5000);
    expect(r.nodes.db.staleReads!).toBeGreaterThan(r.nodes.db.replicaReads! * 0.1);
  });

  it('a crashed replica drops the writes it held, and its lag returns to normal after recovery', () => {
    const { windows, r } = lagSeries(db({ replicaDelayMs: 300 }), [{ type: 'down', node: 'db', instance: 1, atS: 20, forS: 10 }]);
    expect(r.nodes.db.replicationDropped!).toBeGreaterThan(0);
    const late = windows.filter((w) => w.t > 35).map((w) => w.nodes.db.replLagMs ?? 0);
    expect(late.length).toBeGreaterThan(10);
    expect(Math.max(...late)).toBeLessThan(400);
  });
});

describe('request classes', () => {
  const ok = (n: { ok: number; arrivals: number }) => n.ok / n.arrivals;

  it('priority shedding drops batch requests first and keeps critical ones', () => {
    const d = (shedAt: number) =>
      design(
        [['shop', 'client', { priority: 'critical' }], ['bots', 'client', { priority: 'batch' }], ['api', 'service', { instances: 2, concurrency: 8, serviceMs: { mean: 10, cv: 1 }, queueLimit: 200, shedAt }]],
        [['shop', 'api'], ['bots', 'api']],
      );
    const sc = scenario({ seed: 1, durationS: 60, warmupS: 0, traffic: { rps: 2400 } });
    const flat = simulate(d(0), sc);
    const shed = simulate(d(0.2), sc);
    // without priorities, both lose about the same share (capacity 1,600/s of 2,400/s)
    expect(Math.abs(ok(flat.nodes.shop) - ok(flat.nodes.bots))).toBeLessThan(0.02);
    expect(flat.summary.fail.shed).toBe(0);
    expect(ok(shed.nodes.shop)).toBeGreaterThan(0.99);
    expect(ok(shed.nodes.bots)).toBeLessThan(0.4);
    expect(shed.nodes.api.origin.shed).toBeGreaterThan(40000);
    expect(shed.summary.fail.queue_full).toBe(0);
  });

  it('a per-client limit keeps a big tenant from using up a small tenant’s share', () => {
    const d = (scope: string) =>
      design(
        [['big', 'client', { weight: 9 }], ['small', 'client', { weight: 1 }], ['rl', 'rate_limiter', { ratePerSec: 500, burst: 50, scope }], ['api', 'service', { instances: 4 }]],
        [['big', 'rl'], ['small', 'rl'], ['rl', 'api']],
      );
    const sc = scenario({ seed: 1, durationS: 60, warmupS: 0, traffic: { rps: 1000 } });
    const shared = simulate(d('global'), sc);
    const own = simulate(d('per_client'), sc);
    expect(ok(shared.nodes.small)).toBeLessThan(0.55);
    expect(ok(own.nodes.small)).toBeGreaterThan(0.99);
    // the big tenant gets its own 500/s of ~900/s
    expect(within(own.nodes.big.ok / 60, 500, 0.05)).toBe(true);
  });

  it('a limit for batch only lets the other requests through', () => {
    const d = design(
      [['users', 'client', { weight: 1 }], ['bots', 'client', { weight: 1, priority: 'batch' }], ['rl', 'rate_limiter', { ratePerSec: 100, burst: 10, appliesTo: 'batch' }], ['api', 'service', { instances: 4 }]],
      [['users', 'rl'], ['bots', 'rl'], ['rl', 'api']],
    );
    const r = simulate(d, scenario({ seed: 1, durationS: 60, warmupS: 0, traffic: { rps: 1000 } }));
    expect(r.nodes.users.fail).toBe(0);
    expect(within(r.nodes.bots.ok / 60, 100, 0.05)).toBe(true);
  });

  it('a concurrency limit trips when the downstream slows down; a rate limit does not', () => {
    const d = (limit: string) =>
      design(
        [['users', 'client'], ['rl', 'rate_limiter', { limit, ratePerSec: 2000, burst: 200, maxConcurrent: 40 }], ['api', 'service', { instances: 2, concurrency: 32, queueLimit: 2000 }]],
        [['users', 'rl'], ['rl', 'api']],
      );
    const sc = scenario({ seed: 1, durationS: 60, warmupS: 0, traffic: { rps: 1000 }, events: [{ type: 'slow', node: 'api', multiplier: 10, atS: 20, forS: 20 }] });
    const byRate = simulate(d('rate'), sc);
    const byConc = simulate(d('concurrency'), sc);
    expect(byRate.summary.fail.rate_limited).toBe(0);
    expect(byConc.summary.fail.rate_limited).toBeGreaterThan(1000);
    // before the slowdown about 5 requests are in flight: the cap of 40 does not trip
    const calm = simulate(d('concurrency'), scenario({ seed: 1, durationS: 20, warmupS: 0, traffic: { rps: 1000 } }));
    expect(calm.summary.fail.rate_limited).toBe(0);
  });

  it('shed requests are not retried', () => {
    const d = design(
      [['bots', 'client', { priority: 'batch' }], ['gw', 'api_gateway', { instances: 1, concurrency: 4, serviceMs: { mean: 10, cv: 0 }, queueLimit: 100, shedAt: 0.1 }]],
      [['bots', 'gw', { retries: 3 }]],
    );
    const r = simulate(d, scenario({ seed: 1, durationS: 30, warmupS: 0, traffic: { rps: 1000 } }));
    expect(r.nodes.gw.origin.shed).toBeGreaterThan(1000);
    expect(r.edges['bots->gw'].retries).toBe(0);
  });
});

describe('review fixes', () => {
  it('a message moved to the DLQ does not also count as done when a slow attempt finishes', () => {
    // each job takes 3 s; it reappears after 1 s and goes to the DLQ on its 2nd timeout
    const d = design(
      [['users', 'client'], ['q', 'queue', { delivery: 'at_least_once', visibilityTimeoutMs: 1000, maxReceives: 2 }], ['w', 'worker', { instances: 4, concurrency: 64, serviceMs: { mean: 3000, cv: 0 } }]],
      [['users', 'q'], ['q', 'w']],
    );
    const q = simulate(d, scenario({ seed: 1, durationS: 30, warmupS: 0, traffic: { rps: 5 } })).nodes.q;
    expect(q.dlq!).toBeGreaterThan(100);
    expect(q.asyncOk).toBe(0);
    expect(q.asyncFail).toBe(q.dlq);
  });

  it('an expired message does not also count as done when a slow attempt finishes', () => {
    const d = design(
      [['users', 'client'], ['q', 'queue', { delivery: 'at_least_once', visibilityTimeoutMs: 1000, messageTtlS: 1.5 }], ['w', 'worker', { instances: 4, concurrency: 64, serviceMs: { mean: 3000, cv: 0 } }]],
      [['users', 'q'], ['q', 'w']],
    );
    const q = simulate(d, scenario({ seed: 1, durationS: 30, warmupS: 0, traffic: { rps: 5 } })).nodes.q;
    expect(q.expired!).toBeGreaterThan(100);
    expect(q.asyncOk).toBe(0);
  });

  it('replication shipped after the end of the run counts as unfinished', () => {
    const d = design([['users', 'client'], ['db', 'database', { replicas: 1, replicaDelayMs: 60000 }]], [['users', 'db']]);
    const r = simulate(d, scenario({ seed: 1, durationS: 10, warmupS: 0, traffic: { rps: 100, readRatio: 0.5 } }));
    expect(r.unfinished).toBeGreaterThan(400);
  });
});

describe('function', () => {
  it('one request per environment: busy environments ≈ λ · serviceMs, made only as needed', () => {
    const d = design([['users', 'client'], ['fn', 'function', { serviceMs: { mean: 50, cv: 1 }, coldStartMs: { mean: 200, cv: 0.5 } }]], [['users', 'fn']]);
    const r = simulate(d, scenario({ seed: 7, durationS: 60, warmupS: 10, traffic: { rps: 400, readRatio: 1 } }));
    // 400 × 50 ms = 20 busy out of the limit of 1000
    expect(within(r.nodes.fn.utilization!, 0.02, 0.1)).toBe(true);
    expect(r.nodes.fn.function!.peakEnvs).toBeLessThan(400 * 0.25 + 60);
    expect(r.summary.fail.rate_limited).toBe(0);
  });
});
