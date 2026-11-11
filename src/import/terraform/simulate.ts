// --simulate: with the peak traffic from the answer file, run the existing
// engine on the imported design and say pass, fail or "not enough result". No traffic: no simulation
// (static checks only; M28 finds the limit instead).
//
// Time contract (the engine is not changed): durationS = warm-up + measured load + drain. At the end
// of the load a `spike` with multiplier 0 stops new traffic for the drain. The engine measures from
// warmupS to the end, and no new request starts in the drain, so its front-end summary is the load's
// (requests that started in the load and finish in the drain count, as they should). The drain is done
// when nothing is left at the end (`unfinished`: queue messages, retries, background work).
// Background work is judged on its own: a message that goes to the DLQ is an `asyncFail` and leaves the
// backlog, so an empty backlog is not success; background latency only counts successful messages.
import { SCENARIO_SCHEMA, Simulation, type Design, type Scenario, type SimResult } from '../../core/index.ts';
import type { Answers } from './answers.ts';

/** Q18 A: the limits when the answer file gives no SLO. */
export const DEFAULT_SLO = { p99Ms: 1000, errorRate: 0.01, asyncFailRate: 0, drainS: 120 } as const;
/** Seconds of load measured after the warm-up, and the fewest front-end samples a p99 needs. */
export const MEASURE_S = 120;
export const MIN_SAMPLES = 100;
const MIN_WARM_S = 30;
const MAX_DURATION_S = 3600;

export type Verdict = 'pass' | 'fail' | 'insufficient';
export interface Criterion {
  /** Message id (src/i18n/importMessages.ts) and its arguments. */
  id: string;
  ok: boolean;
  args: Record<string, string | number>;
}
export interface SimulateResult {
  verdict: Verdict;
  /** Why the result is not enough (message id), when verdict is `insufficient`. */
  insufficient?: { id: string; args: Record<string, string | number> };
  criteria: Criterion[];
  /** The busiest component, from the engine. */
  bottleneck?: { node: string; utilization: number };
  timing: { warmS: number; loadS: number; drainS: number; durationS: number };
  slo: { p99Ms: number; errorRate: number; asyncP99Ms?: number; asyncFailRate: number; drainS: number };
  scenario: Scenario;
  sim: SimResult;
}

/** Warm-up: every autoscaled node gets two checks, a boot and its warm-up; at least 30 s (cold starts). */
export function warmUpS(d: Design): number {
  let w = MIN_WARM_S;
  for (const n of d.nodes) {
    if (n.params?.autoscale !== 'on') continue;
    const p = n.params as Record<string, unknown>;
    const num = (k: string, dflt: number) => (typeof p[k] === 'number' ? (p[k] as number) : dflt);
    w = Math.max(w, 2 * num('scaleEveryS', 60) + num('bootS', 120) + num('warmS', 20));
  }
  return w;
}

/** The scenario for a peak: warm-up and measured load at the peak, then a drain with no new traffic. */
export function importScenario(d: Design, a: Answers): { scenario: Scenario; warmS: number; loadS: number; drainS: number } | undefined {
  const tr = a.traffic;
  if (!tr) return undefined;
  const warmS = warmUpS(d);
  const drainS = a.slo?.drainS ?? DEFAULT_SLO.drainS;
  // The engine caps warmupS at half the duration (design.ts resolveScenario): measure long enough that
  // warm-up + load + drain is at least twice the warm-up, so no warm-up second is measured.
  const loadS = warmS + Math.max(tr.measureS ?? MEASURE_S, warmS - drainS);
  const scenario: Scenario = {
    schema: SCENARIO_SCHEMA,
    name: 'import peak',
    seed: 1,
    durationS: Math.min(MAX_DURATION_S, loadS + drainS),
    warmupS: warmS,
    traffic: { rps: tr.peakRps, ...(tr.readRatio !== undefined ? { readRatio: tr.readRatio } : {}) },
    events: [{ type: 'spike', atS: loadS, ...(drainS > 0 ? { forS: drainS } : {}), multiplier: 0 }],
  };
  return { scenario, warmS, loadS, drainS };
}

export function simulateImport(d: Design, a: Answers): SimulateResult | undefined {
  const plan = importScenario(d, a);
  if (!plan) return undefined;
  const { scenario, warmS, loadS, drainS } = plan;
  const slo = {
    p99Ms: a.slo?.p99Ms ?? DEFAULT_SLO.p99Ms,
    errorRate: a.slo?.errorRate ?? DEFAULT_SLO.errorRate,
    ...(a.slo?.asyncP99Ms !== undefined ? { asyncP99Ms: a.slo.asyncP99Ms } : {}),
    asyncFailRate: a.slo?.asyncFailRate ?? DEFAULT_SLO.asyncFailRate,
    drainS,
  };
  // The engine runs on past durationS by the client timeout (so the last requests can end); the drain
  // deadline is durationS, so the work left is read there.
  const run = new Simulation(d, scenario);
  run.runUntil(scenario.durationS! * 1000);
  const leftAtDeadline = run.unfinishedNow();
  const sim = run.runToEnd();
  const s = sim.summary;
  const criteria: Criterion[] = [];
  const front = s.latencyMs.count;
  const failed = s.offered - s.ok;
  const errorRate = s.offered ? failed / s.offered : 0;
  criteria.push({ id: 'simulate.p99', ok: s.latencyMs.p99 <= slo.p99Ms, args: { p99: round(s.latencyMs.p99), limit: slo.p99Ms } });
  criteria.push({ id: 'simulate.errorRate', ok: errorRate <= slo.errorRate, args: { pct: pct(errorRate), limit: pct(slo.errorRate), failed, offered: s.offered } });

  // Background: the queues' messages that ended in the measured time, failed (asyncFail: retries used
  // up, moved to the DLQ, or past their TTL, which is also `expired`) or done (asyncOk). Both are
  // counted when the message ends, so they are the same messages.
  const queues = Object.values(sim.nodes).filter((n) => n.kind === 'queue');
  const total = (k: 'arrivals' | 'asyncFail' | 'asyncOk' | 'expired') => queues.reduce((x, n) => x + (n[k] ?? 0), 0);
  const asyncFail = total('asyncFail');
  const expired = total('expired');
  const done = total('asyncOk');
  const background = total('arrivals') > 0 || done > 0 || asyncFail > 0;
  if (background) {
    const rate = asyncFail + done ? asyncFail / (asyncFail + done) : 0;
    criteria.push({ id: 'simulate.asyncFail', ok: rate <= slo.asyncFailRate, args: { pct: pct(rate), limit: pct(slo.asyncFailRate), failed: asyncFail, expired, done } });
    // No successful message: there is no background latency to meet the limit with.
    if (slo.asyncP99Ms !== undefined) criteria.push(s.asyncLatencyMs.count > 0
      ? { id: 'simulate.asyncP99', ok: s.asyncLatencyMs.p99 <= slo.asyncP99Ms, args: { p99: round(s.asyncLatencyMs.p99), limit: slo.asyncP99Ms } }
      : { id: 'simulate.asyncNoSample', ok: false, args: { limit: slo.asyncP99Ms } });
  }
  criteria.push({ id: 'simulate.drain', ok: leftAtDeadline === 0, args: { drainS, unfinished: leftAtDeadline } });

  const bottleneck = sim.bottleneck ? { node: sim.bottleneck.node, utilization: sim.bottleneck.utilization } : undefined;
  const timing = { warmS, loadS, drainS, durationS: scenario.durationS! };
  const base = { criteria, ...(bottleneck ? { bottleneck } : {}), timing, slo, scenario, sim };
  // Not enough: the engine stopped early, the scenario did not fit, or too few samples for a p99.
  if (sim.truncated) return { verdict: 'insufficient', insufficient: { id: 'simulate.short.truncated', args: { events: sim.events } }, ...base };
  if (loadS + drainS > MAX_DURATION_S) return { verdict: 'insufficient', insufficient: { id: 'simulate.short.tooLong', args: { need: loadS + drainS, max: MAX_DURATION_S } }, ...base };
  // A p99 from too few samples says nothing either way; the other limits are counts and still fail.
  if (criteria.some((c) => !c.ok && c.id !== 'simulate.p99')) return { verdict: 'fail', ...base };
  if (front < MIN_SAMPLES) return { verdict: 'insufficient', insufficient: { id: 'simulate.short.samples', args: { n: front, min: MIN_SAMPLES } }, ...base };
  return { verdict: criteria.every((c) => c.ok) ? 'pass' : 'fail', ...base };
}

const round = (x: number) => Math.round(x * 10) / 10;
const pct = (x: number) => Math.round(x * 10000) / 100;
