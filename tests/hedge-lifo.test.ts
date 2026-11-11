// P3: hedged requests (tail latency) and LIFO / CoDel queues (overload).
import { describe, expect, it } from 'vitest';
import { Simulation, simulate } from '../src/engine/index.ts';
import { edgeFailShare } from '../src/engine/index.ts';
import type { Scenario } from '../src/schema/design.ts';
import { design, scenario, within } from './helpers.ts';

type Ev = NonNullable<Scenario['events']>[number];

/** users → lb → 4 instances of a 10 ms service; one call per request. */
const fleet = (edge: Record<string, unknown> = {}, instances = 4) =>
  design(
    [['u', 'client'], ['lb', 'load_balancer', { policy: 'round_robin' }], ['a', 'service', { instances, concurrency: 50, serviceMs: { mean: 10, cv: 0 } }]],
    [['u', 'lb'], ['lb', 'a', { timeoutMs: 500, ...edge }]],
  );
const slowOne: Ev[] = [{ type: 'slow', atS: 0, node: 'a', instance: 1, multiplier: 20 }];
const runFleet = (edge: Record<string, unknown>, events: Ev[] = slowOne, readRatio = 1) =>
  simulate(fleet(edge), scenario({ durationS: 20, warmupS: 0, traffic: { rps: 400, readRatio }, events }));

describe('hedged requests', () => {
  it('a hedge to another instance cuts the tail a slow instance causes, for about one extra call in four', () => {
    const plain = runFleet({});
    const hedged = runFleet({ hedgeMs: 30 });
    expect(plain.summary.latencyMs.p99).toBeGreaterThan(190);
    expect(hedged.summary.latencyMs.p99).toBeLessThan(60);
    const e = hedged.edges['lb->a'];
    const first = e.calls - e.hedges!;
    expect(within(e.hedges! / first, 0.25, 0.1)).toBe(true);
    // every hedge went to a fast instance, so every hedge won; the slow copy is not a late reply
    expect(e.hedgeWins).toBe(e.hedges);
    expect(e.late).toBe(0);
  });

  it('no hedge is sent when replies come before hedgeMs, and writes are never hedged', () => {
    expect(runFleet({ hedgeMs: 30 }, []).edges['lb->a'].hedges).toBeUndefined();
    expect(runFleet({ hedgeMs: 30 }, slowOne, 0).edges['lb->a'].hedges).toBeUndefined();
  });

  it('a copy that fails while the other is still out does not end the call', () => {
    // instance 0 is slow but right, instance 1 fails at once; every primary goes to 0, every hedge to 1
    const d = fleet({ hedgeMs: 30, timeoutMs: 0 }, 2);
    const ev: Ev[] = [{ type: 'slow', atS: 0, node: 'a', instance: 0, multiplier: 20 }, { type: 'errors', atS: 0, node: 'a', instance: 1, rate: 1 }];
    const r = simulate(d, scenario({ durationS: 10, warmupS: 0, traffic: { rps: 10, readRatio: 1, arrivals: 'constant' }, events: ev }));
    expect(r.edges['lb->a'].hedges).toBe(r.summary.offered);
    expect(r.summary.ok).toBe(r.summary.offered);
    expect(r.summary.fail.error).toBe(0);
  });
});

/** users → one server, 10 slots of 10 ms (1000 rps), a long queue. */
const server = (p: Record<string, unknown> = {}) =>
  design([['u', 'client'], ['a', 'service', { instances: 1, concurrency: 10, queueLimit: 100000, serviceMs: { mean: 10, cv: 1 }, ...p }]], [['u', 'a']]);
const runServer = (p: Record<string, unknown>, rps: number) =>
  simulate(server(p), scenario({ durationS: 30, warmupS: 0, traffic: { rps, readRatio: 1, clientTimeoutMs: 1000 } }));

describe('LIFO and CoDel queues', () => {
  it('overloaded FIFO serves requests whose clients gave up; LIFO keeps most requests fast', () => {
    const fifo = runServer({}, 1300);
    const lifo = runServer({ queueOrder: 'lifo' }, 1300);
    const adaptive = runServer({ queueOrder: 'adaptive_lifo' }, 1300);
    expect(fifo.summary.ok / fifo.summary.offered).toBeLessThan(0.2);
    expect(lifo.summary.ok / lifo.summary.offered).toBeGreaterThan(0.7);
    expect(adaptive.summary.ok / adaptive.summary.offered).toBeGreaterThan(0.7);
    expect(lifo.summary.latencyMs.p50).toBeLessThan(20);
  });

  it('CoDel drops what waited too long at once: no timeouts, about 1000 rps served', () => {
    const r = runServer({ codelTargetMs: 5 }, 1300);
    expect(r.summary.fail.timeout).toBe(0);
    expect(r.summary.fail.codel).toBeGreaterThan(5000);
    expect(r.nodes.a.origin.codel).toBe(r.summary.fail.codel);
    expect(r.summary.ok / r.summary.offered).toBeGreaterThan(0.7);
    expect(r.summary.latencyMs.p99).toBeLessThan(150);
  });

  it('below capacity, CoDel drops almost nothing and adaptive LIFO stays FIFO', () => {
    const codel = runServer({ codelTargetMs: 5 }, 800);
    expect(codel.summary.fail.codel / codel.summary.offered).toBeLessThan(0.01);
    expect(runServer({ queueOrder: 'adaptive_lifo' }, 300).summary).toEqual(runServer({}, 300).summary);
  });
});

describe('review fixes', () => {
  it('a hedge loser that fails is still reported to outlier detection', () => {
    // instance 1 is slow and always fails: its copies always lose to a hedge on instance 0
    const d = design(
      [['u', 'client'], ['lb', 'load_balancer', { policy: 'round_robin', outlier: 'on', outlierErrors: 5, ejectS: 100 }], ['a', 'service', { instances: 2, concurrency: 50, serviceMs: { mean: 10, cv: 0 } }]],
      [['u', 'lb'], ['lb', 'a', { timeoutMs: 0, hedgeMs: 30 }]],
    );
    const ev: Ev[] = [{ type: 'slow', atS: 0, node: 'a', instance: 1, multiplier: 20 }, { type: 'errors', atS: 0, node: 'a', instance: 1, rate: 1 }];
    const r = simulate(d, scenario({ durationS: 20, warmupS: 0, traffic: { rps: 50, readRatio: 1, arrivals: 'constant' }, events: ev }));
    expect(r.summary.ok).toBe(r.summary.offered);
    // ejected after 5 lost copies: later primaries all go to instance 0 and need no hedge
    expect(r.edges['lb->a'].hedges!).toBeLessThan(20);
  });

  it('a fully failing hedged edge shows its failures once per attempt', () => {
    const d = fleet({ hedgeMs: 30, timeoutMs: 0 }, 2);
    const ev: Ev[] = [{ type: 'slow', atS: 0, node: 'a', multiplier: 20 }, { type: 'errors', atS: 0, node: 'a', rate: 1 }];
    const r = simulate(d, scenario({ durationS: 10, warmupS: 0, traffic: { rps: 10, readRatio: 1, arrivals: 'constant' }, events: ev }));
    const e = r.edges['lb->a'];
    expect(e.hedges).toBeGreaterThan(0);
    // the rate the edge label shows; calls / fail would read about 50%
    expect(edgeFailShare(e)).toBeGreaterThan(0.95);
  });

  it('CoDel drops are not reported as a full queue', () => {
    const r = runServer({ queueOrder: 'adaptive_lifo', codelTargetMs: 5 }, 1300);
    expect(r.summary.fail.codel).toBeGreaterThan(0);
    expect(r.summary.fail.queue_full).toBe(0);
    expect(r.nodes.a.theory?.note ?? '').not.toContain('排隊滿');
  });
});

describe('review fixes', () => {
  it('the failure share uses logical attempts, which hedged edges report in every window', () => {
    // an attempt that started in the previous window, hedged and failed in this one
    expect(edgeFailShare({ calls: 1, hedges: 1, attempts: 0, fail: 1 } as never)).toBe(1);
    expect(edgeFailShare({ calls: 3, attempts: 2, fail: 2 })).toBe(1);
    const d = fleet({ hedgeMs: 30, timeoutMs: 0 }, 2);
    const ev: Ev[] = [{ type: 'slow', atS: 0, node: 'a', multiplier: 20 }, { type: 'errors', atS: 0, node: 'a', rate: 1 }];
    const sim = new Simulation(d, scenario({ durationS: 10, warmupS: 0, traffic: { rps: 10, readRatio: 1, arrivals: 'constant' }, events: ev }));
    sim.runToEnd();
    const ws = sim.allWindows().map((w) => w.edges['lb->a']).filter((e) => e && e.calls > 0);
    expect(ws.length).toBeGreaterThan(3);
    for (const e of ws) expect(e.attempts).toBeDefined();
    // steady state: every attempt fails, and the label says 100%, not 50%
    for (const e of ws.slice(1)) expect(edgeFailShare(e)).toBe(1);
  });
});
