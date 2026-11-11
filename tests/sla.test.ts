// Availability, nines, the error budget and burn rate.
import { describe, expect, it } from 'vitest';
import type { WindowStat } from '../src/engine/index.ts';
import { downtimeParts, fmtAvail, goodWindow, nines, sla } from '../src/learn/sla.ts';

const w = (t: number, ok: number, failed: number, p99 = 50): WindowStat =>
  ({ t, dt: 1, measured: true, ok, fail: { timeout: failed }, latency: { count: ok, p99 } }) as unknown as WindowStat;

describe('sla', () => {
  it('nines: 99% is 2, 99.9% is 3, no failures is infinite', () => {
    expect(nines(0.99)).toBeCloseTo(2);
    expect(nines(0.999)).toBeCloseTo(3);
    expect(nines(1)).toBe(Infinity);
  });

  it('availability, budget used and downtime from the windows', () => {
    // 10 000 requests, 20 failed: 99.8%; a 99.9% SLO allows 10, so 200% of the budget is used
    const s = sla([w(1, 4990, 10), w(2, 4990, 10)], { target: 0.999, p99Ms: 0 });
    expect(s.availability).toBeCloseTo(0.998);
    expect(s.budgetUsed).toBeCloseTo(2);
    expect(s.met).toBe(false);
    expect(s.downtimeMinPerMonth).toBeCloseTo(0.002 * 43200);
    expect(sla([w(1, 9995, 5)], { target: 0.999, p99Ms: 0 }).met).toBe(true);
  });

  it('a finished run takes its totals from the summary', () => {
    const result = { summary: { ok: 990, fail: { timeout: 6, rejected: 4 } } } as never;
    const s = sla([w(1, 5, 5)], { target: 0.99, p99Ms: 0 }, result);
    expect(s.availability).toBeCloseTo(0.99);
    expect(s.met).toBe(true);
  });

  it('a latency target is part of the verdict', () => {
    const slow = [w(1, 1000, 0, 500), w(2, 1000, 0, 500)];
    const s = sla(slow, { target: 0.999, p99Ms: 1 });
    expect(s.availabilityMet).toBe(true);
    expect(s.latencyMet).toBe(false);
    expect(s.met).toBe(false);
    expect(sla(slow, { target: 0.999, p99Ms: 0 }).latencyMet).toBeNull();
    expect(sla(slow, { target: 0.999, p99Ms: 0 }).met).toBe(true);
    expect(sla(slow, { target: 0.999, p99Ms: 600 }).met).toBe(true);
    // 1 slow second in 100 is within a 99% target, 2 are not
    const run = (slowN: number) => Array.from({ length: 100 }, (_, i) => w(i + 1, 1000, 0, i < slowN ? 500 : 10));
    expect(sla(run(1), { target: 0.99, p99Ms: 100 }).latencyMet).toBe(true);
    expect(sla(run(2), { target: 0.99, p99Ms: 100 }).latencyMet).toBe(false);
  });

  it('no measured second has data: the run p99 decides', () => {
    const result = (p99: number) => ({ summary: { ok: 100, fail: {}, latencyMs: { count: 100, p99 } } }) as never;
    expect(sla([], { target: 0.999, p99Ms: 500 }, result(400)).latencyMet).toBe(true);
    expect(sla([], { target: 0.999, p99Ms: 500 }, result(600)).latencyMet).toBe(false);
    expect(sla([], { target: 0.999, p99Ms: 500 }).latencyMet).toBeNull();
    expect(sla([], { target: 0.999, p99Ms: 500 }, result(400)).met).toBe(true);
  });

  it('each second is judged on its own; the fastest burn is found', () => {
    const ws = [w(1, 1000, 0), w(2, 900, 100), w(3, 999, 1, 500)];
    const s = sla(ws, { target: 0.999, p99Ms: 200 });
    expect(s.windows).toBe(3);
    expect(s.goodWindows).toBe(1); // second 2 fails too often, second 3 is too slow
    expect(s.slowWindows).toBe(1);
    expect(s.worstBurn?.t).toBe(2);
    expect(s.worstBurn?.rate).toBeCloseTo(100); // 10% failed ÷ 0.1% allowed
    expect(goodWindow(w(1, 999, 1), { target: 0.999, p99Ms: 0 })).toBe(true); // exactly at the budget
  });

  it('nothing settled: no availability', () => {
    expect(sla([], { target: 0.999, p99Ms: 0 }).availability).toBeNull();
  });

  it('formats: a value just under 100% never shows as 100%', () => {
    expect(fmtAvail(0.9921)).toBe('99.21%');
    expect(fmtAvail(0.99996)).toBe('99.996%');
    expect(fmtAvail(1)).toBe('100%');
    expect(downtimeParts(43.2)).toEqual({ n: '43', unit: 'min' });
    expect(downtimeParts(0.5)).toEqual({ n: '30', unit: 's' });
    expect(downtimeParts(600)).toEqual({ n: '10.0', unit: 'h' });
  });
});
