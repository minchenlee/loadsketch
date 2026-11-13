// Accuracy benchmark suite against analytical queueing and reliability formulas.
import { describe, expect, it } from 'vitest';
import { ekm1Wait, mm1TimeoutProb, mmckBlocking, retryAmplification, retryFailureRate } from '../src/engine/index.ts';
import { ACCURACY_CASES, measureAccuracyCase } from './accuracy-cases.ts';
import { within } from './helpers.ts';

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
