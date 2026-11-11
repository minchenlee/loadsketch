// P3: cache stampede protection — request coalescing (read-through), leases (cache-aside), TTL jitter.
import { describe, expect, it } from 'vitest';
import { Simulation, simulate } from '../src/engine/index.ts';
import { checkDesign, type Scenario } from '../src/schema/design.ts';
import { design, scenario } from './helpers.ts';

const DB = { readMs: { mean: 50, cv: 0 }, connections: 1000 };
/** users → cache → db (read-through). One hot key, TTL 1 s. */
const readThrough = (stampede: string) =>
  design(
    [['u', 'client'], ['c', 'cache', { mode: 'lru', capacityKeys: 1000, ttlS: 1, stampede, concurrency: 1000 }], ['db', 'database', DB]],
    [['u', 'c'], ['c', 'db']],
  );
/** users → api → (cache, db): cache-aside. */
const aside = (stampede: string, extra: Record<string, unknown> = {}) =>
  design(
    [
      ['u', 'client'],
      ['api', 'service', { concurrency: 1000, serviceMs: { mean: 1, cv: 0 } }],
      ['c', 'cache', { mode: 'lru', capacityKeys: 1000, ttlS: 1, stampede, concurrency: 1000, ...extra }],
      ['db', 'database', DB],
    ],
    [['u', 'api'], ['api', 'c'], ['api', 'db']],
  );
const hot: Partial<Scenario> = { durationS: 5, warmupS: 0, traffic: { rps: 1000, readRatio: 1, arrivals: 'constant' }, keys: { count: 1 } };
const sc = (s: Partial<Scenario> = {}) => scenario({ ...hot, ...s } as Scenario);

describe('cache stampede protection', () => {
  it('without protection, every expiry of a hot key sends ~50 concurrent misses to the database', () => {
    const r = simulate(readThrough('none'), sc());
    // 5 fills (t=0 and after each 1 s expiry) × 50 ms × 1000 rps ≈ 250 reads
    expect(r.nodes.db.arrivals).toBeGreaterThan(200);
  });

  it('coalescing (read-through): one database read per expiry; the others wait for it', () => {
    const r = simulate(readThrough('coalesce'), sc());
    expect(r.nodes.db.arrivals).toBeLessThanOrEqual(6);
    expect(r.nodes.c.coalesced).toBeGreaterThan(200);
    expect(r.summary.fail.timeout + r.summary.fail.queue_full).toBe(0);
    expect(r.summary.ok).toBe(r.summary.offered);
    // a waiter answers no later than the read it waited for
    expect(r.summary.latencyMs.max).toBeLessThan(52);
  });

  it('leases (cache-aside): the lease holder reads the database, the others ask the cache again', () => {
    const none = simulate(aside('none'), sc());
    const lease = simulate(aside('lease', { leaseWaitMs: 10 }), sc());
    expect(none.nodes.db.arrivals).toBeGreaterThan(200);
    expect(lease.nodes.db.arrivals).toBeLessThanOrEqual(6);
    expect(lease.nodes.c.leaseWaits).toBeGreaterThan(200);
    expect(lease.summary.ok).toBe(lease.summary.offered);
    // a waiter retries every 10 ms until the fill lands at ~50 ms
    expect(lease.summary.latencyMs.max).toBeGreaterThan(50);
    expect(lease.summary.latencyMs.max).toBeLessThan(65);
  });

  it('a lease that is never filled: waiters stop waiting after leaseMs and read the database themselves', () => {
    const d = aside('lease', { leaseMs: 100, leaseWaitMs: 10 });
    // the database fails every read, so no holder ever fills the key
    const r = simulate(d, sc({ durationS: 2, events: [{ type: 'errors', atS: 0, node: 'db', rate: 1 }] }));
    expect(r.unfinished).toBe(0);
    expect(r.summary.ok).toBe(0);
    // every request reads the database: the holder at once, a waiter after ~100 ms of waiting
    // (reads after the 2 s traffic window are not counted, so the last ~100 ms of arrivals are missing)
    expect(r.nodes.db.arrivals).toBeGreaterThan(r.summary.offered - 110);
    expect(r.nodes.db.arrivals).toBeLessThanOrEqual(r.summary.offered);
    expect(r.nodes.c.leaseWaits).toBeGreaterThan(1000);
  });

  it('a waiter stops waiting when the propagated deadline passes', () => {
    const d = design(
      [
        ['u', 'client', { deadline: 'propagate' }],
        ['api', 'service', { concurrency: 1000, serviceMs: { mean: 1, cv: 0 } }],
        ['c', 'cache', { mode: 'lru', capacityKeys: 1000, ttlS: 1, stampede: 'lease', leaseMs: 60000, leaseWaitMs: 10, concurrency: 1000 }],
        ['db', 'database', { readMs: { mean: 5000, cv: 0 }, connections: 1000 }],
      ],
      [['u', 'api'], ['api', 'c'], ['api', 'db']],
    );
    const r = simulate(d, sc({ durationS: 1, traffic: { rps: 100, readRatio: 1, arrivals: 'constant', clientTimeoutMs: 200 } }));
    expect(r.unfinished).toBeLessThanOrEqual(1); // only the lease holder's slow read
    expect(r.nodes.db.arrivals).toBe(1);
  });

  it('a cache crash fails the requests waiting on a coalesced fetch and starts clean after recovery', () => {
    const d = readThrough('coalesce');
    const sim = new Simulation(d, sc({ durationS: 3, events: [{ type: 'down', atS: 1.02, forS: 0.1, node: 'c' }] }));
    const r = sim.runToEnd();
    expect(r.summary.fail.down).toBeGreaterThan(10);
    expect(r.unfinished).toBe(0);
    // after recovery, misses coalesce again: about one read per fill (t=0, 1.12, 2.12) and one at the crash
    expect(r.nodes.db.arrivals).toBeLessThanOrEqual(6);
    const x = sim as unknown as { byId: Map<string, { insts: { fills: Map<number, unknown> }[] }> };
    expect(x.byId.get('c')!.insts[0].fills.size).toBe(0);
  });

  it('TTL jitter spreads expiries of keys filled together, so the database sees no periodic miss storm', () => {
    const mk = (ttlJitter: number) =>
      design(
        [['u', 'client'], ['c', 'cache', { mode: 'lru', capacityKeys: 100000, ttlS: 5, ttlJitter, concurrency: 10000 }], ['db', 'database', { readMs: { mean: 5, cv: 0 }, connections: 10000 }]],
        [['u', 'c'], ['c', 'db']],
      );
    const run = (j: number) => {
      const sim = new Simulation(mk(j), scenario({ durationS: 30, warmupS: 0, traffic: { rps: 20000, readRatio: 1 }, keys: { count: 2000, zipf: 0 } }));
      sim.runToEnd();
      const w = sim.allWindows().filter((x) => x.t > 6);
      return Math.max(...w.map((x) => x.nodes.db.arrivals));
    };
    const peakSynced = run(0);
    const peakJittered = run(0.5);
    // all 2000 keys fill in the first second, so without jitter they all expire in the same second
    expect(peakSynced).toBeGreaterThan(1500);
    expect(peakJittered).toBeLessThan(peakSynced / 2);
  }, 30000);

  it('design warnings: LRU only, coalescing needs a store behind, leases need cache-aside', () => {
    const codes = (d: ReturnType<typeof design>) => checkDesign(d).map((i) => i.code);
    const fixed = design([['u', 'client'], ['c', 'cache', { mode: 'fixed', stampede: 'coalesce' }], ['db', 'database']], [['u', 'c'], ['c', 'db']]);
    expect(codes(fixed)).toContain('cache-lru-only');
    expect(codes(aside('coalesce'))).toContain('coalesce-no-store');
    expect(codes(readThrough('lease'))).toContain('lease-read-through');
    expect(codes(readThrough('coalesce'))).not.toContain('coalesce-no-store');
    expect(codes(aside('lease'))).not.toContain('lease-read-through');
    const noTtl = design([['u', 'client'], ['c', 'cache', { mode: 'lru', ttlJitter: 0.2 }]], [['u', 'c']]);
    expect(codes(noTtl)).toContain('jitter-no-ttl');
  });
});

describe('review fixes', () => {
  it('a lease "wait" answer counts as a cache miss in the hit ratio', () => {
    const r = simulate(aside('lease', { leaseWaitMs: 10 }), sc());
    const c = r.nodes.c;
    // every wait answer is a miss, so misses (1 − hit ratio of all cache reads) ≥ wait answers
    expect((1 - c.hitRatio!) * c.arrivals).toBeGreaterThanOrEqual(c.leaseWaits! - 1);
  });

  it('stampede warnings look only at edges to a store that carry reads', () => {
    const codes = (d: ReturnType<typeof design>) => checkDesign(d).map((i) => i.code);
    const writeOnly = (stampede: string) =>
      design(
        [['u', 'client'], ['c', 'cache', { mode: 'lru', capacityKeys: 1000, ttlS: 1, stampede }], ['db', 'database', DB]],
        [['u', 'c'], ['c', 'db', { on: 'write' }]],
      );
    expect(codes(writeOnly('coalesce'))).toContain('coalesce-no-store');
    expect(codes(writeOnly('lease'))).not.toContain('lease-read-through');
    const toService = design(
      [['u', 'client'], ['c', 'cache', { mode: 'lru', stampede: 'coalesce' }], ['s', 'service']],
      [['u', 'c'], ['c', 's']],
    );
    expect(codes(toService)).toContain('coalesce-no-store');
  });
});
