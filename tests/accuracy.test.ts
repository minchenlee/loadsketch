// Accuracy benchmark suite against analytical queueing and reliability formulas.
import { describe, expect, it } from 'vitest';
import { ekm1Wait, mgc, mm1TimeoutProb, mmckBlocking, retryAmplification, retryFailureRate, simulate } from '../src/engine/index.ts';
import { ACCURACY_CASES, measureAccuracyCase } from './accuracy-cases.ts';
import { design, scenario, within } from './helpers.ts';

describe('analytical accuracy formulas', () => {
  it('mmckBlocking matches closed-form M/M/c/K values', () => {
    // M/M/1/K at rho = 1: P_K = 1 / (K + 1)
    expect(mmckBlocking(1, 5, 1)).toBeCloseTo(1 / 6, 12);
    // Erlang B (K = c): M/M/1/1 with a = 0.5 -> 0.5 / 1.5 = 1/3
    expect(mmckBlocking(1, 1, 0.5)).toBeCloseTo(1 / 3, 12);
    // M/M/2/2 (Erlang B) with a = 2 -> (2^2/2) / (1 + 2 + 2) = 2/5
    expect(mmckBlocking(2, 2, 2)).toBeCloseTo(0.4, 12);
  });

  it('retryAmplification and retryFailureRate match geometric sum', () => {
    expect(retryAmplification(0.2, 2)).toBeCloseTo(1.24, 12);
    expect(retryFailureRate(0.2, 2)).toBeCloseTo(0.008, 12);
    expect(retryAmplification(0.5, 2)).toBeCloseTo(1.75, 12);
    expect(retryFailureRate(0.5, 2)).toBeCloseTo(0.125, 12);
  });

  it('mm1TimeoutProb matches Exp(mu - lambda) tail probability', () => {
    expect(mm1TimeoutProb(0.05, 0.1, 20)).toBeCloseTo(Math.exp(-1), 12);
    expect(mm1TimeoutProb(0.05, 0.1, 40)).toBeCloseTo(Math.exp(-2), 12);
  });

  it('ekm1Wait solves the E_k/M/1 fixed point across low and high utilization', () => {
    const k1 = ekm1Wait(1, 0.05, 0.1);
    expect(k1.pWait).toBeCloseTo(0.5, 10);
    expect(k1.waitMs).toBeCloseTo(10, 9);
    const k4 = ekm1Wait(4, 0.05, 0.1);
    expect(k4.pWait).toBeCloseTo(0.301931, 5);
    expect(k4.waitMs).toBeCloseTo(4.32523, 4);
    // High utilization (rho = 0.999): fixed-point iteration converges too slowly; exact root is ~7490.83 ms.
    const hi = ekm1Wait(2, 0.0999, 0.1);
    expect(hi.pWait).toBeCloseTo(0.99866681, 6);
    expect(hi.waitMs).toBeCloseTo(7490.834, 1);
    // Very low utilization / high k: (k*rho / (k*rho + 1))^k < eps, must not fail bracketing.
    const lo = ekm1Wait(32, 0.01, 1);
    expect(lo.pWait).toBeGreaterThanOrEqual(0);
    expect(lo.pWait).toBeLessThan(1e-15);
    expect(lo.waitMs).toBeGreaterThanOrEqual(0);
    expect(lo.waitMs).toBeLessThan(1e-15);
  });

  it('ekm1Wait sweeps k = 1..64 and rho = 0.001..0.9999 monotonically without throwing', () => {
    const ks = [1, 2, 4, 8, 16, 32, 64];
    const rhos = [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999, 0.9999];
    const grid = ks.map((k) =>
      rhos.map((rho) => {
        const res = ekm1Wait(k, rho, 1);
        expect(Number.isFinite(res.pWait)).toBe(true);
        expect(Number.isFinite(res.waitMs)).toBe(true);
        expect(res.pWait).toBeGreaterThanOrEqual(0);
        expect(res.pWait).toBeLessThan(1);
        expect(res.waitMs).toBeGreaterThanOrEqual(0);
        return res;
      }),
    );
    // Monotonic non-decreasing in rho for each k
    for (let ki = 0; ki < ks.length; ki++) {
      for (let ri = 1; ri < rhos.length; ri++) {
        expect(grid[ki][ri].pWait).toBeGreaterThanOrEqual(grid[ki][ri - 1].pWait);
        expect(grid[ki][ri].waitMs).toBeGreaterThanOrEqual(grid[ki][ri - 1].waitMs);
      }
    }
    // Monotonic non-increasing in k for each rho (more regular arrivals -> less queueing)
    for (let ri = 0; ri < rhos.length; ri++) {
      for (let ki = 1; ki < ks.length; ki++) {
        expect(grid[ki][ri].pWait).toBeLessThanOrEqual(grid[ki - 1][ri].pWait);
        expect(grid[ki][ri].waitMs).toBeLessThanOrEqual(grid[ki - 1][ri].waitMs);
      }
    }
  });
});

describe('simulation accuracy against theory', () => {
  for (const c of ACCURACY_CASES) {
    const label = c.knownDeviation
      ? `[known-deviation] ${c.name} (${c.metric})`
      : `${c.name} (${c.metric}) within ±${Math.round(c.tolerance * 100)}%`;

    it(label, () => {
      const m = measureAccuracyCase(c);
      if (c.knownDeviation) {
        expect(m.status).toBe('known-deviation');
        expect(within(m.actual, m.expected, c.tolerance)).toBe(false);
        expect(within(m.actual, c.knownDeviation.expectedActual, c.knownDeviation.actualTolerance)).toBe(true);
      } else {
        expect(m.status).toBe('pass');
        expect(within(m.actual, m.expected, c.tolerance)).toBe(true);
      }
    });
  }
});

describe('node.theory Erlang-k applicability', () => {
  it('uses E_k/M/1 for equal-weight 1-slot targets behind a round_robin LB', () => {
    const d = design(
      [
        ['u', 'client'],
        ['lb', 'load_balancer', { policy: 'round_robin', latencyMs: { mean: 0, cv: 0 } }],
        ['s1', 'service', { instances: 1, concurrency: 1, serviceMs: { mean: 10, cv: 1 }, queueLimit: 10000 }],
        ['s2', 'service', { instances: 1, concurrency: 1, serviceMs: { mean: 10, cv: 1 }, queueLimit: 10000 }],
      ],
      [['u', 'lb'], ['lb', 's1'], ['lb', 's2']],
    );
    const r = simulate(d, scenario({ seed: 11, durationS: 120, warmupS: 10, traffic: { rps: 100, clientTimeoutMs: 600000 } }));
    expect(r.nodes.s1.theory?.model).toBe('E_2/M/1');
    expect(r.nodes.s2.theory?.model).toBe('E_2/M/1');
    expect(r.nodes.s1.theory?.note ?? '').not.toContain('理論值假設請求隨機到達');
    const exp = ekm1Wait(2, r.nodes.s1.theory!.lambdaPerSec / 1000, 1 / r.nodes.s1.theory!.meanHoldMs);
    expect(r.nodes.s1.theory!.waitMs!).toBeCloseTo(exp.waitMs, 2);
  });

  it('keeps Poisson M/G/c theory when instances have c > 1 slots', () => {
    const d = design(
      [
        ['u', 'client'],
        ['lb', 'load_balancer', { policy: 'round_robin', latencyMs: { mean: 0, cv: 0 } }],
        ['s', 'service', { instances: 4, concurrency: 2, serviceMs: { mean: 10, cv: 1 }, queueLimit: 10000 }],
      ],
      [['u', 'lb'], ['lb', 's']],
    );
    const r = simulate(d, scenario({ seed: 7, durationS: 120, warmupS: 10, traffic: { rps: 640, clientTimeoutMs: 600000 } }));
    const th = r.nodes.s.theory!;
    expect(th.model).toBe('M/G/c');
    expect(th.servers).toBe(2);
    expect(th.note ?? '').toContain('理論值假設請求隨機到達');
    const poisson = mgc(th.lambdaPerSec / 1000, th.meanHoldMs, 2, 1, 1);
    expect(within(th.waitMs!, poisson.waitMs, 0.1)).toBe(true);
  });

  it('keeps Poisson M/G/1 theory when traffic comes from multiple sources, unequal weights, or non-round_robin policy', () => {
    const multiSource = design(
      [
        ['u', 'client'],
        ['u2', 'client'],
        ['lb', 'load_balancer', { policy: 'round_robin', latencyMs: { mean: 0, cv: 0 } }],
        ['s', 'service', { instances: 4, concurrency: 1, serviceMs: { mean: 10, cv: 1 }, queueLimit: 10000 }],
      ],
      [['u', 'lb'], ['lb', 's'], ['u2', 's']],
    );
    const rMulti = simulate(multiSource, scenario({ seed: 7, durationS: 120, warmupS: 10, traffic: { rps: 200, clientTimeoutMs: 600000 } }));
    expect(rMulti.nodes.s.theory?.model).toBe('M/G/1');

    const unequalWeights = design(
      [
        ['u', 'client'],
        ['lb', 'load_balancer', { policy: 'round_robin', latencyMs: { mean: 0, cv: 0 } }],
        ['s1', 'service', { instances: 2, concurrency: 1, serviceMs: { mean: 10, cv: 1 }, queueLimit: 10000 }],
        ['s2', 'service', { instances: 2, concurrency: 1, serviceMs: { mean: 10, cv: 1 }, queueLimit: 10000 }],
      ],
      [['u', 'lb'], ['lb', 's1', { weight: 1 }], ['lb', 's2', { weight: 2 }]],
    );
    const rWeight = simulate(unequalWeights, scenario({ seed: 7, durationS: 120, warmupS: 10, traffic: { rps: 200, clientTimeoutMs: 600000 } }));
    expect(rWeight.nodes.s1.theory?.model).toBe('M/G/1');
    expect(rWeight.nodes.s2.theory?.model).toBe('M/G/1');

    const leastConn = design(
      [
        ['u', 'client'],
        ['lb', 'load_balancer', { policy: 'least_conn', latencyMs: { mean: 0, cv: 0 } }],
        ['s', 'service', { instances: 4, concurrency: 1, serviceMs: { mean: 10, cv: 1 }, queueLimit: 10000 }],
      ],
      [['u', 'lb'], ['lb', 's']],
    );
    const rLc = simulate(leastConn, scenario({ seed: 7, durationS: 120, warmupS: 10, traffic: { rps: 200, clientTimeoutMs: 600000 } }));
    expect(rLc.nodes.s.theory?.model).toBe('M/G/1');
    expect(rLc.nodes.s.theory?.note ?? '').toContain('理論值假設請求隨機到達');
  });

  it('keeps Poisson M/G/1 theory when service CV != 1 or downstream calls change hold distribution', () => {
    const highCv = design(
      [
        ['u', 'client'],
        ['lb', 'load_balancer', { policy: 'round_robin', latencyMs: { mean: 0, cv: 0 } }],
        ['s', 'service', { instances: 4, concurrency: 1, serviceMs: { mean: 10, cv: 2 }, queueLimit: 100000 }],
      ],
      [['u', 'lb'], ['lb', 's']],
    );
    const rCv = simulate(highCv, scenario({ seed: 7, durationS: 200, warmupS: 10, traffic: { rps: 200, clientTimeoutMs: 600000 } }));
    const thCv = rCv.nodes.s.theory!;
    expect(thCv.model).toBe('M/G/1');
    expect(thCv.note ?? '').toContain('理論值假設請求隨機到達');
    expect(thCv.waitMs!).toBeGreaterThan(15);

    const withDownstream = design(
      [
        ['u', 'client'],
        ['lb', 'load_balancer', { policy: 'round_robin', latencyMs: { mean: 0, cv: 0 } }],
        ['s', 'service', { instances: 4, concurrency: 1, serviceMs: { mean: 5, cv: 1 }, queueLimit: 10000 }],
        ['db', 'database', { connections: 64, readMs: { mean: 5, cv: 0 }, queueLimit: 10000 }],
      ],
      [['u', 'lb'], ['lb', 's'], ['s', 'db']],
    );
    const rDown = simulate(withDownstream, scenario({ seed: 7, durationS: 120, warmupS: 10, traffic: { rps: 200, clientTimeoutMs: 600000 } }));
    expect(rDown.nodes.s.theory?.model).toBe('M/G/1');
    expect(rDown.nodes.s.theory?.note ?? '').toContain('理論值假設請求隨機到達');
  });

  it('uses active serving target count k and falls back to Poisson when membership changes during measurement', () => {
    const base = design(
      [
        ['u', 'client'],
        ['lb', 'load_balancer', { policy: 'round_robin', latencyMs: { mean: 0, cv: 0 } }],
        ['s', 'service', { instances: 4, concurrency: 1, serviceMs: { mean: 10, cv: 1 }, queueLimit: 100000 }],
      ],
      [['u', 'lb'], ['lb', 's']],
    );
    // 3 of 4 instances down for the entire run -> only 1 serving -> M/G/1 (~10 ms, not E_4/M/1 ~4.4 ms)
    const rOneUp = simulate(
      base,
      scenario({
        seed: 7,
        durationS: 200,
        warmupS: 10,
        traffic: { rps: 50, clientTimeoutMs: 600000 },
        events: [
          { type: 'down', node: 's', instance: 1, atS: 0 },
          { type: 'down', node: 's', instance: 2, atS: 0 },
          { type: 'down', node: 's', instance: 3, atS: 0 },
        ],
      }),
    );
    const thOneUp = rOneUp.nodes.s.theory!;
    expect(thOneUp.model).toBe('M/G/1');
    expect(thOneUp.note ?? '').toContain('理論值假設請求隨機到達');
    expect(within(thOneUp.waitMs!, 10, 0.25)).toBe(true);

    // 1 of 4 instances down for the entire run -> 3 serving constantly -> E_3/M/1
    const rThreeUp = simulate(
      base,
      scenario({
        seed: 7,
        durationS: 200,
        warmupS: 10,
        traffic: { rps: 150, clientTimeoutMs: 600000 },
        events: [{ type: 'down', node: 's', instance: 3, atS: 0 }],
      }),
    );
    expect(rThreeUp.nodes.s.theory?.model).toBe('E_3/M/1');

    // Mid-measurement outage -> falls back to M/G/1
    const rMidDown = simulate(
      base,
      scenario({
        seed: 7,
        durationS: 120,
        warmupS: 10,
        traffic: { rps: 100, clientTimeoutMs: 600000 },
        events: [{ type: 'down', node: 's', instance: 3, atS: 40, forS: 20 }],
      }),
    );
    expect(rMidDown.nodes.s.theory?.model).toBe('M/G/1');

    // Health check removal during measurement -> falls back to M/G/1
    const hcDesign = design(
      [
        ['u', 'client'],
        ['lb', 'load_balancer', { policy: 'round_robin', latencyMs: { mean: 0, cv: 0 }, healthCheck: 'liveness', hcIntervalS: 2, hcThreshold: 1 }],
        ['s', 'service', { instances: 4, concurrency: 1, serviceMs: { mean: 10, cv: 1 }, queueLimit: 100000 }],
      ],
      [['u', 'lb'], ['lb', 's']],
    );
    const rHc = simulate(
      hcDesign,
      scenario({
        seed: 7,
        durationS: 120,
        warmupS: 10,
        traffic: { rps: 100, clientTimeoutMs: 600000 },
        events: [{ type: 'down', node: 's', instance: 3, atS: 30 }],
      }),
    );
    expect(rHc.nodes.s.theory?.model).toBe('M/G/1');

    // Outlier ejection during measurement -> falls back to M/G/1
    const outlierDesign = design(
      [
        ['u', 'client'],
        ['lb', 'load_balancer', { policy: 'round_robin', latencyMs: { mean: 0, cv: 0 }, outlier: 'on', outlierErrors: 1, ejectS: 20 }],
        ['s', 'service', { instances: 4, concurrency: 1, serviceMs: { mean: 10, cv: 1 }, errorRate: 0.05, queueLimit: 100000 }],
      ],
      [['u', 'lb'], ['lb', 's']],
    );
    const rOutlier = simulate(outlierDesign, scenario({ seed: 7, durationS: 120, warmupS: 10, traffic: { rps: 100, clientTimeoutMs: 600000 } }));
    expect(rOutlier.nodes.s.theory?.model).toBe('M/G/1');

    // Rollout during measurement -> falls back to M/G/1
    const rRollout = simulate(
      base,
      scenario({
        seed: 7,
        durationS: 120,
        warmupS: 10,
        traffic: { rps: 100, clientTimeoutMs: 600000 },
        events: [{ type: 'rollout', node: 's', atS: 30, waves: 2, waveS: 20 }],
      }),
    );
    expect(rRollout.nodes.s.theory?.model).toBe('M/G/1');
  });
});
