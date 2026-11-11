// Service level: availability, "nines", the error budget and how fast it burns.
// Pure functions: no React, no DOM.
//
// Terms (Google SRE book): the SLI is what is measured (here: the share of requests that
// succeeded); the SLO is the target the team sets (for example 99.9%); the error budget is what
// the SLO allows to fail (0.1%). An SLA is a promise to customers, usually looser than the SLO.
import type { SimResult, WindowStat } from '../engine/index.ts';
import { failShare, settled } from './metrics.ts';

export interface Slo {
  /** Share of requests that must succeed, 0–1 (0.999 = 99.9%). */
  target: number;
  /** p99 latency target per second of the run, ms; 0 = no latency target. */
  p99Ms: number;
}

export const DEFAULT_SLO: Slo = { target: 0.999, p99Ms: 0 };
/** The availability targets offered in the UI. */
export const SLO_TARGETS = [0.99, 0.995, 0.999, 0.9999];

export interface Sla {
  /** Succeeded ÷ settled requests; null before any request settled. */
  availability: number | null;
  /** -log10(1 - availability): 2 = 99%, 3 = 99.9%. Infinity when nothing failed. */
  nines: number;
  /** Share of requests the SLO allows to fail (1 - target). */
  budget: number;
  /** Failed requests ÷ the failures the budget allows: 1 = the whole budget, over 1 = SLO missed. */
  budgetUsed: number;
  /** Few enough requests failed. */
  availabilityMet: boolean;
  /**
   * With a latency target: few enough seconds had a p99 over it (the same share as the error budget);
   * with no measured second, the run's p99 is within it. Null without a target or without data.
   */
  latencyMet: boolean | null;
  /** Both objectives met. */
  met: boolean;
  /** Measured seconds (windows) with settled requests, and those that met the SLO. */
  windows: number;
  goodWindows: number;
  /** Windows whose p99 was over the latency target (with a latency target). */
  slowWindows: number;
  /** The window that burned the budget fastest: its failure share ÷ the budget. */
  worstBurn: { t: number; rate: number } | null;
  /** The failed share as downtime in a 30-day month, minutes. */
  downtimeMinPerMonth: number;
}

const MONTH_MIN = 30 * 24 * 60;

export function nines(availability: number): number {
  return availability >= 1 ? Infinity : -Math.log10(1 - availability);
}

/** A window meets the SLO: few enough failures and, with a latency target, a low enough p99. */
export function goodWindow(w: WindowStat, slo: Slo): boolean {
  if (failShare(w) > 1 - slo.target + 1e-12) return false;
  return !(slo.p99Ms > 0 && w.latency.count > 0 && w.latency.p99 > slo.p99Ms);
}

/**
 * The service level of a run. `windows` are the measured ones (after the warm-up); with a finished
 * run, the totals come from its summary (requests sent in the measured interval, however late they
 * settled), otherwise from the windows so far.
 */
export function sla(windows: WindowStat[], slo: Slo, result?: SimResult | null): Sla {
  let ok = 0;
  let n = 0;
  if (result) {
    ok = result.summary.ok;
    n = ok;
    for (const v of Object.values(result.summary.fail)) n += v;
  } else {
    for (const w of windows) {
      ok += w.ok;
      n += settled(w);
    }
  }
  const availability = n ? ok / n : null;
  const budget = 1 - slo.target;
  const failed = availability === null ? 0 : 1 - availability;
  let count = 0;
  let good = 0;
  let slow = 0;
  let worst: Sla['worstBurn'] = null;
  for (const w of windows) {
    if (!settled(w)) continue;
    count++;
    if (goodWindow(w, slo)) good++;
    if (slo.p99Ms > 0 && w.latency.count > 0 && w.latency.p99 > slo.p99Ms) slow++;
    const rate = failShare(w) / budget;
    if (rate > 0 && (!worst || rate > worst.rate)) worst = { t: w.t, rate };
  }
  const availabilityMet = availability !== null && failed <= budget + 1e-12;
  // no measured second settled anything (every request finished late): judge the run's own p99
  let latencyMet: boolean | null = null;
  if (slo.p99Ms > 0 && count > 0) latencyMet = slow / count <= budget + 1e-12;
  else if (slo.p99Ms > 0 && result?.summary.latencyMs.count) latencyMet = result.summary.latencyMs.p99 <= slo.p99Ms;
  return {
    availability,
    nines: availability === null ? 0 : nines(availability),
    budget,
    budgetUsed: failed / budget,
    availabilityMet,
    latencyMet,
    met: availabilityMet && latencyMet !== false,
    windows: count,
    goodWindows: good,
    slowWindows: slow,
    worstBurn: worst,
    downtimeMinPerMonth: failed * MONTH_MIN,
  };
}

/** Minutes as the largest sensible unit: "43 分鐘", "7.2 小時", "3.0 天" (numbers only; text is the caller's). */
export function downtimeParts(min: number): { n: string; unit: 's' | 'min' | 'h' | 'd' } {
  if (min < 1) return { n: String(Math.round(min * 60)), unit: 's' };
  if (min < 60) return { n: min < 10 ? min.toFixed(1) : String(Math.round(min)), unit: 'min' };
  if (min < 24 * 60) return { n: (min / 60).toFixed(1), unit: 'h' };
  return { n: (min / 1440).toFixed(1), unit: 'd' };
}

/** "99.95%": enough decimals that a value under 100% does not show as 100%. */
export function fmtAvail(a: number): string {
  if (a >= 1) return '100%';
  for (const d of [2, 3, 4]) {
    const s = (a * 100).toFixed(d);
    if (Number(s) < 100) return `${s}%`;
  }
  return '>99.9999%';
}
