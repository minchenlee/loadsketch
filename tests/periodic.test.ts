// P3: periodic traffic — diurnal waves, cron bursts (with and without jitter) and GC pauses.
import { describe, expect, it } from 'vitest';
import { simulate, Simulation } from '../src/engine/index.ts';
import { parseScenario, type Scenario } from '../src/schema/design.ts';
import { design, scenario, within } from './helpers.ts';

type Ev = NonNullable<Scenario['events']>[number];
const one = design([['u', 'client'], ['a', 'service', { instances: 1, concurrency: 1000, serviceMs: { mean: 1, cv: 0 } }]], [['u', 'a']]);

function run(events: Ev[], extra: Partial<Scenario> = {}, d = one) {
  const sim = new Simulation(d, scenario({ durationS: 40, warmupS: 0, traffic: { rps: 1000, readRatio: 1 }, events, ...extra }));
  const r = sim.runToEnd();
  return { r, windows: sim.allWindows() };
}

describe('periodic traffic', () => {
  it('the new event types are valid scenario events', () => {
    const ok = (events: unknown[]) => parseScenario({ schema: 'loadsketch/scenario@1', traffic: { rps: 1 }, events }, one).ok;
    expect(ok([{ type: 'wave', atS: 0, periodS: 20, amplitude: 0.5 }])).toBe(true);
    expect(ok([{ type: 'cron', atS: 0, everyS: 10, burstS: 1, multiplier: 5, jitterS: 3 }])).toBe(true);
    expect(ok([{ type: 'pause', atS: 0, node: 'a', everyS: 1, pauseMs: 100 }])).toBe(true);
    // a pause as long as its period would freeze the node forever; a burst longer than its period overlaps the next
    expect(ok([{ type: 'pause', atS: 0, node: 'a', everyS: 1, pauseMs: 1000 }])).toBe(false);
    expect(ok([{ type: 'cron', atS: 0, everyS: 10, burstS: 5, multiplier: 5, jitterS: 6 }])).toBe(false);
    expect(ok([{ type: 'pause', atS: 0, node: 'nope', everyS: 1, pauseMs: 10 }])).toBe(false);
  });

  it('the thinning bound covers the true rate everywhere for waves and cron bursts', () => {
    const cases: Ev[][] = [
      [{ type: 'wave', atS: 3, forS: 20, periodS: 7, amplitude: 0.9 }],
      [{ type: 'cron', atS: 0.3, everyS: 3.3, burstS: 0.7, multiplier: 40 }],
      [{ type: 'cron', atS: 1, forS: 9.5, everyS: 2, burstS: 0.1, multiplier: 100, jitterS: 1.9 }, { type: 'wave', atS: 0, periodS: 5, amplitude: 1 }],
      [{ type: 'spike', atS: 2, forS: 3, multiplier: 2 }, { type: 'cron', atS: 0, everyS: 1, burstS: 0.25, multiplier: 8 }],
    ];
    for (const events of cases) {
      const sim = new Simulation(one, scenario({ durationS: 12, warmupS: 0, traffic: { rps: 1000 }, events }));
      const x = sim as unknown as { rateSegs: { t0: number; t1: number; lam: number }[]; rateAt(t: number): number };
      expect(x.rateSegs[0].t0).toBe(0);
      for (const seg of x.rateSegs) {
        for (let k = 0; k <= 64; k++) {
          const t = seg.t0 + ((seg.t1 - seg.t0) * k) / 64.0001;
          expect(x.rateAt(t)).toBeLessThanOrEqual(seg.lam * (1 + 1e-12));
        }
      }
    }
  });

  it('a wave makes traffic follow a sine: high at a quarter period, low at three quarters', () => {
    const { r, windows } = run([{ type: 'wave', atS: 0, periodS: 20, amplitude: 0.6 }]);
    const at = (s: number) => windows.find((w) => w.t === s)!.offered;
    // window (4,5] is near the peak 1.6×; window (14,15] near the trough 0.4×
    expect(at(5)).toBeGreaterThan(1350);
    expect(at(15)).toBeLessThan(650);
    // over whole cycles the average is still rps
    expect(within(r.summary.offered / 40, 1000, 0.03)).toBe(true);
    expect(r.timeline.some((e) => e.type === 'wave')).toBe(true);
  });

  it('a cron burst adds the same requests with or without jitter, but jitter lowers the peak', () => {
    const base = { type: 'cron', atS: 5, everyS: 10, burstS: 1, multiplier: 11 } as const;
    const a = run([base]);
    const b = run([{ ...base, jitterS: 4 }]);
    // 4 bursts × 1 s × 10 extra × 1000 rps = 40 000 extra on top of 40 000
    expect(within(a.r.summary.offered, 80000, 0.03)).toBe(true);
    expect(within(b.r.summary.offered, 80000, 0.03)).toBe(true);
    const peak = (w: { offered: number }[]) => Math.max(...w.map((x) => x.offered));
    expect(peak(a.windows)).toBeGreaterThan(10000);
    expect(peak(b.windows)).toBeLessThan(3500); // 1 + 10 / 5 = 3×
    expect(a.r.timeline.filter((e) => e.type === 'cron')).toHaveLength(4);
  });

  it('jitter protects a small service from the cron thundering herd', () => {
    const small = design(
      [['u', 'client'], ['a', 'service', { instances: 1, concurrency: 4, queueLimit: 200, serviceMs: { mean: 2, cv: 1 } }]],
      [['u', 'a']],
    );
    const base = { type: 'cron', atS: 5, everyS: 10, burstS: 0.5, multiplier: 9 } as const;
    const sc = { traffic: { rps: 600, readRatio: 1, clientTimeoutMs: 1000 } };
    const herd = run([base], sc, small).r;
    const spread = run([{ ...base, jitterS: 4.5 }], sc, small).r;
    expect(herd.summary.fail.queue_full + herd.summary.fail.timeout).toBeGreaterThan(500);
    expect(spread.summary.fail.queue_full + spread.summary.fail.timeout).toBe(0);
  });

  it('GC pauses stall every job that overlaps them: latency becomes bimodal', () => {
    const ev: Ev = { type: 'pause', atS: 0, node: 'a', everyS: 1, pauseMs: 200 };
    const calm = run([], { traffic: { rps: 200, readRatio: 1 } }).r;
    const gc = run([ev], { traffic: { rps: 200, readRatio: 1 } }).r;
    expect(calm.summary.latencyMs.max).toBeLessThan(1.5);
    // a request that arrives at the start of a pause waits the whole 200 ms
    expect(gc.summary.latencyMs.max).toBeGreaterThan(195);
    expect(gc.summary.latencyMs.max).toBeLessThan(202);
    // about 20% of requests arrive during a pause; the median is not affected
    expect(gc.summary.latencyMs.p50).toBeLessThan(1.5);
    expect(gc.summary.latencyMs.p95).toBeGreaterThan(50);
    expect(gc.timeline.some((e) => e.type === 'pause' && e.node === 'a')).toBe(true);
  });

  it('work stops during a pause and resumes after it (work clock)', () => {
    const sim = new Simulation(one, scenario({ durationS: 5, warmupS: 0, traffic: { rps: 0 }, events: [{ type: 'pause', atS: 1, forS: 2, node: 'a', everyS: 1, pauseMs: 300 }] }));
    const x = sim as unknown as { now: number; workEnd(n: unknown, i: unknown, w: number): number; byId: Map<string, { insts: unknown[] }> };
    sim.runToEnd(); // registers the pause rule
    const n = x.byId.get('a')!;
    const at = (now: number, w: number) => {
      x.now = now;
      return x.workEnd(n, n.insts[0], w);
    };
    expect(at(500, 100)).toBe(600); // before the window
    expect(at(900, 200)).toBe(1400); // 100 ms, pause 1000–1300, 100 ms
    expect(at(1100, 50)).toBe(1350); // starts inside a pause
    expect(at(1900, 500)).toBe(2700); // pause 2000–2300 → 2400 … would end at 2700 (no pause at 3000: window ends)
    expect(at(2900, 200)).toBe(3100); // the window [1000, 3000) has ended
  });

  it('a pause on a node that does no processing is flagged', () => {
    const d = design([['u', 'client'], ['lb', 'load_balancer'], ['a', 'service']], [['u', 'lb'], ['lb', 'a']]);
    const r = parseScenario({ schema: 'loadsketch/scenario@1', traffic: { rps: 1 }, events: [{ type: 'pause', atS: 0, node: 'lb', everyS: 1, pauseMs: 10 }] }, d);
    expect(r.issues.some((i) => i.code === 'event-pause-kind')).toBe(true);
  });

  it('each instance pauses on its own schedule (instance i is shifted by i / instances of the period)', () => {
    const d4 = design([['u', 'client'], ['lb', 'load_balancer'], ['a', 'service', { instances: 4 }]], [['u', 'lb'], ['lb', 'a']]);
    const s4 = new Simulation(d4, scenario({ durationS: 3, warmupS: 0, traffic: { rps: 0 }, events: [{ type: 'pause', atS: 0, node: 'a', everyS: 1, pauseMs: 100 }] }));
    const x = s4 as unknown as { now: number; workEnd(n: unknown, i: unknown, w: number): number; byId: Map<string, { insts: unknown[] }> };
    s4.runToEnd();
    const n = x.byId.get('a')!;
    x.now = 1010; // instance 0 is paused (1000–1100); instance 1 pauses at 1250, 2 at 1500, 3 at 1750
    expect(n.insts.map((i) => x.workEnd(n, i, 10))).toEqual([1110, 1020, 1020, 1020]);
    x.now = 1240;
    expect(n.insts.map((i) => x.workEnd(n, i, 20))).toEqual([1260, 1360, 1260, 1260]);
  });
});

describe('review fixes', () => {
  const offered = (rps: number, durationS: number, events: Ev[]) =>
    new Simulation(one, scenario({ durationS, warmupS: 0, traffic: { rps, readRatio: 1, arrivals: 'constant' }, events })).runToEnd().summary.offered;

  it('constant arrivals do not skip a short cron burst between two requests', () => {
    // base area 0.95 + burst 0.05 s × 100 rps = 5.95 requests in the first second
    const n = offered(1, 1, [{ type: 'cron', atS: 0.1, everyS: 10, burstS: 0.05, multiplier: 100 }]);
    expect(n).toBeGreaterThanOrEqual(5);
    expect(n).toBeLessThanOrEqual(6);
  });

  it('constant arrivals send as many requests as the area under the rate curve', () => {
    // spike: 10 s × 10 rps + 1 s × (200 − 10) extra = 290
    expect(Math.abs(offered(10, 10, [{ type: 'spike', atS: 4.95, forS: 1, multiplier: 20 }]) - 290)).toBeLessThanOrEqual(1);
    // wave over two whole periods: average rps
    expect(Math.abs(offered(100, 20, [{ type: 'wave', atS: 0, periodS: 10, amplitude: 0.9 }]) - 2000)).toBeLessThanOrEqual(2);
    // ramp 0 → 10 s from 1× to 3×: area 10 × 2 × 50 = 1000
    expect(Math.abs(offered(50, 10, [{ type: 'ramp', atS: 0, forS: 10, toMultiplier: 3 }]) - 1000)).toBeLessThanOrEqual(2);
  });

  it('a GC pause on a replica also delays applying replicated writes', () => {
    const d = design([['u', 'client'], ['db', 'database', { replicas: 1, writeMs: { mean: 10, cv: 0 }, replicaApplyRatio: 1, replicaDelayMs: 0 }]], [['u', 'db']]);
    const lag = (events: Ev[]) =>
      simulate(d, scenario({ durationS: 5, warmupS: 0, traffic: { rps: 50, readRatio: 0, arrivals: 'constant' }, events })).nodes.db.maxReplLagMs!;
    // the replica (instance 1) pauses 500–1100 ms of every second, so at each window end it is behind
    const paused = lag([{ type: 'pause', atS: 0, node: 'db', everyS: 1, pauseMs: 600 }]);
    expect(lag([])).toBeLessThan(20);
    expect(paused).toBeGreaterThan(200);
  });
});

describe('review fixes', () => {
  const offered = (rps: number, durationS: number, events: Ev[]) =>
    new Simulation(one, scenario({ durationS, warmupS: 0, traffic: { rps, readRatio: 1, arrivals: 'constant' }, events })).runToEnd().summary.offered;

  it('a request whose area ends exactly at a segment boundary is still sent before a zero-rate stretch', () => {
    // 10 rps for 100 ms is exactly one request; then traffic stops
    expect(offered(10, 10, [{ type: 'spike', atS: 0.1, forS: 9.9, multiplier: 0 }])).toBe(1);
  });

  it('a slow base rate does not alias a fast wave', () => {
    // (1 + sin)² averages 1.5: 0.125 rps × 1.5 × 100 s = 18.75
    const wave = { type: 'wave', atS: 0, periodS: 1, amplitude: 1 } as Ev;
    expect(Math.abs(offered(0.125, 100, [wave, { ...wave }]) - 18.75)).toBeLessThanOrEqual(1.5);
  });
});

describe('review fixes', () => {
  it('a remainder just short of one request is carried, not sent at a zero-rate boundary', () => {
    // 0.1 rps until 9.999999995 s is 0.9999999995 requests: none is due before the traffic stops
    const r = new Simulation(one, scenario({ durationS: 20, warmupS: 0, traffic: { rps: 0.1, readRatio: 1, arrivals: 'constant' }, events: [{ type: 'spike', atS: 9.999999995, multiplier: 0 }] })).runToEnd();
    expect(r.summary.offered).toBe(0);
  });
});

describe('review fixes', () => {
  it('an arrival due exactly at a zero-rate boundary is sent despite float drift in the arrival times', () => {
    // 7 rps until 1000/7 s is exactly 1000 requests; the 1000th arrival time is a sum of 999 gaps
    const r = new Simulation(one, scenario({ durationS: 200, warmupS: 0, traffic: { rps: 7, readRatio: 1, arrivals: 'constant' }, events: [{ type: 'spike', atS: 1000 / 7, multiplier: 0 }] })).runToEnd();
    expect(r.summary.offered).toBe(1000);
  });
});

describe('review fixes', () => {
  it('a short flat segment late in a long run that holds less than one request sends none', () => {
    // 1000 rps for 0.9999995 ms at 999.999 s: 0.9999995 requests
    const ev = [
      { type: 'spike' as const, atS: 0, forS: 999.999, multiplier: 0 },
      { type: 'spike' as const, atS: 999.9999999995, multiplier: 0 },
    ];
    const r = new Simulation(one, scenario({ durationS: 1000, warmupS: 0, traffic: { rps: 1000, readRatio: 1, arrivals: 'constant' }, events: ev })).runToEnd();
    expect(r.summary.offered).toBe(0);
  });
});
