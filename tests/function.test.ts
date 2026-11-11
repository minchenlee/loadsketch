// The function component: like AWS Lambda, one request per execution
// environment, a cold start when no environment is free, a concurrency limit, a scaling rate, idle
// environments reclaimed, and environments made only when needed.
import { describe, expect, it } from 'vitest';
import { Simulation, simulate } from '../src/engine/index.ts';
import { planScale } from '../src/engine/scale.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkDesign, type Design, type Scenario } from '../src/schema/design.ts';
import { cpuMs, design, scenario, within, type NodeSpec } from './helpers.ts';

const FIXED = (mean: number) => ({ mean, cv: 0 });
const fnDesign = (p: Record<string, unknown>, front: 'direct' | 'lb' | 'queue' = 'direct') => {
  const fn: NodeSpec = ['fn', 'function', { serviceMs: FIXED(100), coldStartMs: FIXED(500), ...p }];
  if (front === 'lb') return design([['users', 'client'], ['lb', 'load_balancer'], fn], [['users', 'lb'], ['lb', 'fn']]);
  if (front === 'queue') return design([['users', 'client'], ['q', 'queue', { maxDepth: 1_000_000 }], fn], [['users', 'q'], ['q', 'fn']]);
  return design([['users', 'client'], fn], [['users', 'fn']]);
};
const run = (d: ReturnType<typeof fnDesign>, s: Partial<Parameters<typeof scenario>[0]> & { rps: number }) =>
  simulate(d, scenario({ seed: 3, durationS: 30, warmupS: 0, ...s, traffic: { rps: s.rps, readRatio: 1 } }));

describe('function: cold starts', () => {
  it('from no environment, every request in the first coldStartMs + serviceMs starts one; later ones are warm', () => {
    const r = run(fnDesign({}), { rps: 100 });
    const f = r.nodes.fn.function!;
    // about λ · (500 + 100) ms = 60 environments, then about 10 busy at once: no more cold starts
    expect(f.coldStarts).toBeGreaterThan(35);
    expect(f.coldStarts).toBeLessThan(90);
    expect(f.peakEnvs).toBe(f.coldStarts);
    expect(f.throttles).toBe(0);
    // a cold request waits coldStartMs on top of its work; a warm one only works
    expect(r.summary.latencyMs.max).toBeGreaterThanOrEqual(599);
    expect(r.summary.latencyMs.max).toBeLessThan(620);
    expect(r.summary.latencyMs.p50).toBeLessThan(110);
    expect(r.summary.fail.rate_limited).toBe(0);
  });

  it('a longer cold start makes more environments start (and slower first requests)', () => {
    const short = run(fnDesign({ coldStartMs: FIXED(100) }), { rps: 100 }).nodes.fn.function!;
    const long = run(fnDesign({ coldStartMs: FIXED(2000) }), { rps: 100 }).nodes.fn.function!;
    expect(long.coldStarts).toBeGreaterThan(3 * short.coldStarts);
  });

  it('provisioned environments are warm from the start: no cold start below that concurrency', () => {
    const r = run(fnDesign({ provisioned: 30 }), { rps: 100 });
    expect(r.nodes.fn.function!.coldStarts).toBe(0);
    expect(r.summary.latencyMs.max).toBeLessThan(110);
  });

  it('environments idle for idleS are reclaimed: traffic after a pause starts cold again', () => {
    const steady = run(fnDesign({ idleS: 5 }), { rps: 100, durationS: 40 }).nodes.fn.function!;
    // no traffic from 10 s to 30 s (multiplier 0), longer than idleS
    const paused = run(fnDesign({ idleS: 5 }), { rps: 100, durationS: 40, events: [{ type: 'spike', atS: 10, forS: 20, multiplier: 0 }] }).nodes.fn.function!;
    expect(paused.coldStarts).toBeGreaterThan(1.6 * steady.coldStarts);
    // the same pause with idleS longer than it keeps them
    const kept = run(fnDesign({ idleS: 600 }), { rps: 100, durationS: 40, events: [{ type: 'spike', atS: 10, forS: 20, multiplier: 0 }] }).nodes.fn.function!;
    expect(kept.coldStarts).toBe(steady.coldStarts === 0 ? 0 : kept.peakEnvs);
    expect(kept.coldStarts).toBeLessThan(1.3 * steady.coldStarts);
  });
});

describe('function: limits', () => {
  it('at the concurrency limit new requests are throttled (429); environments stop at the limit', () => {
    // 500 rps × 100 ms needs 50 at once; 20 allowed: Erlang B(load 50, 20 servers) ≈ 0.61 lost
    const r = run(fnDesign({ maxConcurrency: 20 }), { rps: 500, warmupS: 5 });
    const f = r.nodes.fn.function!;
    expect(f.peakEnvs).toBe(20);
    expect(f.throttles).toBeGreaterThan(0);
    const lost = r.summary.fail.rate_limited / r.summary.offered;
    expect(within(lost, 0.61, 0.08)).toBe(true);
    expect(r.summary.fail.timeout + r.summary.fail.queue_full).toBe(0);
  });

  it('the scaling rate caps how fast environments start; requests past it are throttled', () => {
    // 10 new environments per 10 s: 1 per second after the first 10
    const r = run(fnDesign({ scalePer10s: 10 }), { rps: 500, durationS: 20 });
    const f = r.nodes.fn.function!;
    expect(f.peakEnvs).toBeLessThanOrEqual(10 + 20 + 1);
    expect(f.peakEnvs).toBeGreaterThan(20);
    expect(f.throttles).toBeGreaterThan(0);
    // with the default rate the same load runs with no throttling once warm
    expect(run(fnDesign({}), { rps: 500, durationS: 20 }).nodes.fn.function!.throttles).toBe(0);
  });

  it('a limit of 1000 (or 100 000) does not make 1000 environments up front: memory and time stay bounded', () => {
    for (const maxConcurrency of [1000, 100_000]) {
      const sim = new Simulation(fnDesign({ maxConcurrency }), scenario({ seed: 1, durationS: 30, warmupS: 0, traffic: { rps: 50, readRatio: 1 } }));
      const insts = () => (sim as unknown as { byId: Map<string, { insts: unknown[] }> }).byId.get('fn')!.insts.length;
      expect(insts()).toBe(0);
      let peak = 0;
      const ms = cpuMs(() => {
        peak = sim.runToEnd().nodes.fn.function!.peakEnvs;
      });
      // about 50 × 0.6 = 30 environments, never more than it ran at once
      expect(insts()).toBe(peak);
      expect(peak).toBeLessThan(80);
      expect(ms).toBeLessThan(2000);
    }
  });

  it('a big run scaled by k reports the function counts at full size', () => {
    const d = fnDesign({ maxConcurrency: 5000 });
    const r = simulate(d, scenario({ seed: 2, durationS: 60, warmupS: 10, traffic: { rps: 20_000, readRatio: 1 } }));
    expect(r.scale ?? 1).toBeGreaterThan(1);
    const f = r.nodes.fn.function!;
    // 20 000 rps × 100 ms = 2000 busy at once, below the limit: nothing throttled once warm
    expect(f.limit).toBeGreaterThan(4500);
    expect(f.peakEnvs).toBeGreaterThan(1800);
    expect(f.peakEnvs).toBeLessThanOrEqual(5100);
    expect(r.summary.fail.rate_limited / r.summary.offered).toBeLessThan(0.01);
  });
});

describe('function: callers', () => {
  it('behind a load balancer the function picks its own environment', () => {
    const r = run(fnDesign({}, 'lb'), { rps: 100 });
    expect(r.summary.fail.down + r.summary.fail.queue_full + r.summary.fail.rate_limited).toBe(0);
    expect(r.nodes.fn.function!.peakEnvs).toBeLessThan(90);
  });

  it('from a queue (event source mapping) the consumers follow the environments, and the queue drains', () => {
    const r = run(fnDesign({}, 'queue'), { rps: 200, durationS: 30, warmupS: 5 });
    const f = r.nodes.fn.function!;
    expect(f.throttles).toBe(0);
    // about 20 at once after the start: each message started at most one environment
    expect(f.peakEnvs).toBeGreaterThan(15);
    expect(f.peakEnvs).toBeLessThan(200 * 0.6 + 30);
    expect(r.nodes.q.queueDepthEnd ?? 0).toBeLessThan(50);
    expect(within(r.nodes.q.asyncOk! / r.measuredS, 200, 0.05)).toBe(true);
  });

  it('from a queue at the concurrency limit, messages wait in the queue (no throttle failure)', () => {
    const r = run(fnDesign({ maxConcurrency: 5 }, 'queue'), { rps: 200, durationS: 30, warmupS: 5 });
    const f = r.nodes.fn.function!;
    expect(f.peakEnvs).toBe(5);
    expect(f.throttles).toBe(0);
    // 5 environments × 10 per second each
    expect(within(r.nodes.q.asyncOk! / r.measuredS, 50, 0.08)).toBe(true);
    expect(r.nodes.q.queueDepthEnd!).toBeGreaterThan(3000);
  });

  it('a whole-node outage fails its requests; it serves again after', () => {
    const r = run(fnDesign({}), { rps: 100, durationS: 30, events: [{ type: 'down', node: 'fn', atS: 10, forS: 5 }] });
    expect(within(r.summary.fail.down / r.summary.offered, 5 / 30, 0.15)).toBe(true);
    expect(checkDesign(fnDesign({})).filter((i) => i.level === 'error')).toEqual([]);
  });
});

describe('function: what the result says', () => {
  it('utilization is the busy share of the concurrency limit (environments come and go)', () => {
    // 100 rps × 100 ms = 10 busy of 1000 after the first cold starts
    const r = run(fnDesign({}), { rps: 100, warmupS: 5 });
    expect(within(r.nodes.fn.utilization!, 0.01, 0.1)).toBe(true);
    expect(r.nodes.fn.instances).toBeUndefined();
  });

  it('serverless-db example: in the spike, the database (40 connections) is the bottleneck, not the function', () => {
    const root = join(import.meta.dirname, '..', 'examples');
    const d = JSON.parse(readFileSync(join(root, 'designs', 'serverless-db.json'), 'utf8')) as Design;
    const sc = JSON.parse(readFileSync(join(root, 'scenarios', 'spike.json'), 'utf8')) as Scenario;
    const r = simulate(d, sc);
    expect(r.bottleneck?.node).toBe('db');
    expect(r.nodes.db.peakUtilization!).toBeGreaterThan(0.95);
    expect(r.nodes.fn.function!.throttles).toBe(0);
  });
});

describe('function: review fixes', () => {
  const sc = (rps: number, durationS: number, extra: Partial<Scenario> = {}, traffic: Partial<Scenario['traffic']> = {}) =>
    scenario({ seed: 3, durationS, warmupS: 0, ...extra, traffic: { rps, readRatio: 1, ...traffic } });

  it('an environment whose cold start outlived the request deadline goes back to the idle pool', () => {
    // deadline 100 ms < cold start 500 ms: the first requests expire; their environments must serve the next ones
    const d = fnDesign({ maxConcurrency: 5, serviceMs: FIXED(20) });
    d.nodes = d.nodes.map((n) => (n.id === 'users' ? { ...n, params: { ...n.params, deadline: 'propagate' } } : n));
    const r = simulate(d, sc(50, 10, {}, { clientTimeoutMs: 100 }));
    expect(r.summary.fail.rate_limited / r.summary.offered).toBeLessThan(0.1);
    expect(r.summary.ok / r.summary.offered).toBeGreaterThan(0.85);
  });

  it('a network partition cuts calls to a function that already has environments', () => {
    const d = design(
      [['users', 'client'], ['api', 'service', { instances: 2, concurrency: 100, serviceMs: FIXED(1) }], ['fn', 'function', { serviceMs: FIXED(20), coldStartMs: FIXED(100), provisioned: 5 }]],
      [['users', 'api'], ['api', 'fn', { timeoutMs: 500 }]],
    );
    d.nodes = d.nodes.map((n) => (n.id === 'api' ? { ...n, region: 'east' } : n.id === 'fn' ? { ...n, region: 'west' } : n));
    const r = simulate(d, sc(50, 20, { events: [{ type: 'partition', atS: 5, forS: 10, regions: ['east', 'west'] }] }));
    // 10 s × 50 rps cut off: they time out
    expect(r.summary.fail.timeout).toBeGreaterThan(400);
  });

  it('a function that was down before it had an environment drains its queue when it is back', () => {
    // 1 s of messages while it is down, then no traffic
    const r = simulate(fnDesign({}, 'queue'), sc(20, 15, {
      events: [{ type: 'down', node: 'fn', atS: 0, forS: 5 }, { type: 'spike', atS: 1, multiplier: 0 }],
    }));
    expect(r.nodes.q.asyncOk!).toBeGreaterThan(10);
    expect(r.nodes.q.queueDepthEnd ?? 0).toBe(0);
  });

  it('a queue backlog uses the launch tokens that come back after the traffic stops', () => {
    // 1 new environment per 10 s; 2 s per message: one environment cannot drain 50 messages in 40 s
    const r = simulate(fnDesign({ scalePer10s: 1, maxConcurrency: 10, serviceMs: FIXED(2000) }, 'queue'), sc(50, 40, {
      events: [{ type: 'spike', atS: 1, multiplier: 0 }],
    }));
    expect(r.nodes.fn.function!.peakEnvs).toBeGreaterThanOrEqual(3);
  });

  it('scaling a run by k never rounds the scaling rate or the provisioned environments up', () => {
    const k = (p: Record<string, unknown>) => planScale(fnDesign({ maxConcurrency: 1000, ...p }), 1e9, 20).k;
    expect(k({ scalePer10s: 1 })).toBe(1);
    expect(k({ scalePer10s: 50 })).toBe(5);
    expect(k({ scalePer10s: 1000, provisioned: 30 })).toBe(3);
    expect(k({ scalePer10s: 1000 })).toBe(20);
  });

  it('a request waiting for a cold start fails when its environment crashes meanwhile, even if it is back before the start ends', () => {
    // cold start 1 s; outage 0.5–0.6 s: every request from 0 to 0.6 s is lost (about 24 at 40 rps)
    const r = simulate(fnDesign({ coldStartMs: FIXED(1000) }), sc(40, 5, { events: [{ type: 'down', node: 'fn', atS: 0.5, forS: 0.1 }] }));
    expect(r.summary.fail.down).toBeGreaterThanOrEqual(14);
  });
});
