// The engine against queueing theory. These are the "is the simulator honest?" checks.
import { describe, expect, it } from 'vitest';
import { Simulation, erlangC, mgc, mm1SojournQuantileMs, simulate } from '../src/engine/index.ts';
import { design, scenario, slope, within } from './helpers.ts';

describe('theory formulas', () => {
  it('Erlang C matches known values', () => {
    expect(erlangC(1, 0.5)).toBeCloseTo(0.5, 12); // M/M/1: P(wait) = ρ
    expect(erlangC(2, 1)).toBeCloseTo(1 / 3, 12);
    // c = 3, a = 2: C = (a^c/c!)·(c/(c−a)) / (Σ_{k<c} a^k/k! + (a^c/c!)·(c/(c−a))) = 4 / 9
    expect(erlangC(3, 2)).toBeCloseTo(4 / 9, 12);
    expect(erlangC(4, 4)).toBe(1); // unstable
  });

  it('M/M/1 mean wait and sojourn', () => {
    const t = mgc(0.05, 10, 1); // λ = 50/s, E[S] = 10 ms → ρ = 0.5
    expect(t.rho).toBeCloseTo(0.5, 12);
    expect(t.waitMs).toBeCloseTo(10, 9); // ρ/(μ−λ) = 0.5 / 0.05
    expect(t.sojournMs).toBeCloseTo(20, 9);
    expect(mm1SojournQuantileMs(0.05, 0.1, 0.99)).toBeCloseTo(Math.log(100) / 0.05, 9);
  });

  it('fixed service halves the M/M/1 wait (Pollaczek–Khinchine)', () => {
    expect(mgc(0.05, 10, 1, 0).waitMs).toBeCloseTo(5, 9);
  });
});

// One service with no downstream calls is a plain queueing station.
function single(c: number, meanMs: number, cv: number) {
  return design(
    [
      ['users', 'client'],
      ['svc', 'service', { instances: 1, concurrency: c, serviceMs: { mean: meanMs, cv }, queueLimit: 100000 }],
    ],
    [['users', 'svc']],
  );
}

describe('a single server matches queueing theory', () => {
  for (const rho of [0.5, 0.8]) {
    it(`M/M/1 at ρ = ${rho}: mean within 5%, p99 within 10%`, () => {
      const mu = 0.1; // per ms (10 ms mean service)
      const lam = rho * mu;
      const r = simulate(single(1, 10, 1), scenario({ seed: 7, durationS: 3000, warmupS: 50, traffic: { rps: lam * 1000, clientTimeoutMs: 600000 } }));
      const mean = 1 / (mu - lam);
      const p99 = mm1SojournQuantileMs(lam, mu, 0.99);
      expect(r.summary.fail.timeout).toBe(0);
      expect(r.summary.latencyMs.mean / mean).toBeGreaterThan(0.95);
      expect(r.summary.latencyMs.mean / mean).toBeLessThan(1.05);
      expect(within(r.summary.latencyMs.p99, p99, 0.1)).toBe(true);
      expect(within(r.nodes.svc.utilization!, rho, 0.03)).toBe(true);
    });
  }

  it('M/M/4 at ρ = 0.8: P(wait) and mean wait within 10% of Erlang C', () => {
    const c = 4;
    const mu = 0.1;
    const lam = 0.8 * c * mu;
    const r = simulate(single(c, 10, 1), scenario({ seed: 3, durationS: 2000, warmupS: 50, traffic: { rps: lam * 1000, clientTimeoutMs: 600000 } }));
    const pw = erlangC(c, lam / mu);
    const wq = pw / (c * mu - lam);
    const th = r.nodes.svc.theory!;
    expect(within(th.simPWait, pw, 0.1)).toBe(true);
    expect(within(r.nodes.svc.waitMs!, wq, 0.1)).toBe(true);
    // the theory row the UI shows agrees with the closed form
    expect(within(th.waitMs!, wq, 0.05)).toBe(true);
  });

  it('M/D/1: fixed service time waits half as long as exponential', () => {
    const r = simulate(single(1, 10, 0), scenario({ seed: 5, durationS: 2000, warmupS: 50, traffic: { rps: 70, clientTimeoutMs: 600000 } }));
    const wq = mgc(0.07, 10, 1, 0).waitMs; // ρ = 0.7
    expect(within(r.nodes.svc.waitMs!, wq, 0.08)).toBe(true);
    expect(r.nodes.svc.holdCv).toBe(0);
  });

  it('overload at λ = 1.2μ: the queue grows at λ − μ and latency keeps rising', () => {
    // μ = 1000/s, λ = 1200/s. The growth rate is a difference of two Poisson counts, so a fast server
    // keeps its noise small: σ ≈ √(2200·90)/90 ≈ 5/s against a 10% band of 20/s.
    const sim = new Simulation(single(1, 1, 1), scenario({ seed: 11, durationS: 100, warmupS: 1, traffic: { rps: 1200, clientTimeoutMs: 600000 } }));
    sim.runUntil(100_000);
    const ws = sim.allWindows().filter((w) => w.t >= 10 && w.t <= 100);
    const k = slope(ws.map((w) => w.t), ws.map((w) => w.nodes.svc.queue!));
    expect(within(k, 1200 - 1000, 0.1)).toBe(true); // requests per second
    const meanLat = (from: number, to: number) => {
      const xs = ws.filter((w) => w.t > from && w.t <= to && w.latency.count > 0);
      return xs.reduce((a, w) => a + w.latency.mean * w.latency.count, 0) / xs.reduce((a, w) => a + w.latency.count, 0);
    };
    const a = meanLat(10, 20);
    const b = meanLat(45, 55);
    const c = meanLat(85, 95);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    // Fluid approximation: arriving at time a, a request waits queue(a)/μ = (λ−μ)·a/μ = 0.2·a.
    // It finishes at T = 1.2·a, so requests finishing around T = 90 s took T/6 = 15 s.
    expect(within(c, (90 * 1000) / 6, 0.15)).toBe(true);
  });
});

describe('conservation and determinism', () => {
  const three = design(
    [
      ['users', 'client'],
      ['lb', 'load_balancer'],
      ['api', 'service', { instances: 2, concurrency: 4 }],
      ['cache', 'cache'],
      ['db', 'database', { replicas: 1, connections: 8 }],
    ],
    [['users', 'lb'], ['lb', 'api'], ['api', 'cache'], ['api', 'db', { timeoutMs: 300 }]],
  );
  const sc = scenario({ seed: 1, durationS: 40, traffic: { rps: 1500 }, events: [{ type: 'spike', atS: 15, forS: 10, multiplier: 2 }] });

  it('every measured request ends exactly once', () => {
    const r = simulate(three, sc);
    const failed = Object.values(r.summary.fail).reduce((a, b) => a + b, 0);
    expect(r.summary.ok + failed).toBe(r.summary.offered);
    expect(failed).toBeGreaterThan(0); // the spike overloads it
  });

  it('same seed gives the same result, another seed does not', () => {
    const a = JSON.stringify(simulate(three, sc));
    const b = JSON.stringify(simulate(three, sc));
    const c = JSON.stringify(simulate(three, { ...sc, seed: 2 }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('two designs see the same traffic (common random numbers)', () => {
    const other = design([['users', 'client'], ['api', 'service', { instances: 8 }]], [['users', 'api']]);
    expect(simulate(other, sc).summary.offered).toBe(simulate(three, sc).summary.offered);
  });
});
