// Find the limit of any design (roadmap-next M17): raise steady traffic until the design stops
// meeting the limits, and say where, and which component goes first. The CLI's `import terraform
// --find-limit` (src/import/terraform/limit.ts) and the app's "find limit" use this.
//
// A step is one peak run: warm-up of the autoscaled nodes, measured load at the peak, then a drain
// with no new traffic, judged on the limits (`Slo`), with the base scenario's seed and settings and
// none of its length, window or events (a spike, a ramp, a failure would make the steps differ by more than the rps).
//
// Time contract (the engine is not changed): durationS = warm-up + measured load + drain. At the end
// of the load a `spike` with multiplier 0 stops new traffic for the drain. The engine measures from
// warmupS to the end, and no new request starts in the drain, so its front-end summary is the load's
// (requests that started in the load and finish in the drain count, as they should). The drain is done
// when nothing is left at the end (`unfinished`: queue messages, retries, background work).
// Background work is judged on its own: a message that goes to the DLQ is an `asyncFail` and leaves the
// backlog, so an empty backlog is not success; background latency only counts successful messages.
//
// Search: double from START_RPS until the first fail, one more step past it (a pass there means the
// results are not monotonic), then bisect between the last pass and the first fail BISECT times.
// The answer is "under these assumptions it holds up to about X rps", never "the limit is X".
// Text is message ids with arguments (src/i18n/importMessages.ts).
import type { Design, Scenario } from '../schema/design.ts';
import { SCENARIO_SCHEMA } from '../schema/design.ts';
import { Simulation, type SimResult } from './sim.ts';

/** The limits when none are given (Q18 A). */
export const DEFAULT_SLO = { p99Ms: 1000, errorRate: 0.01, asyncFailRate: 0, drainS: 120 } as const;
/** Seconds of load measured after the warm-up, and the fewest front-end samples a p99 needs. */
export const MEASURE_S = 120;
export const MIN_SAMPLES = 100;
const MIN_WARM_S = 30;
export const MAX_DURATION_S = 3600;

/** The limits a run must meet; a missing one is DEFAULT_SLO's (asyncP99Ms: no limit). */
export interface Slo { p99Ms?: number; errorRate?: number; asyncP99Ms?: number; asyncFailRate?: number; drainS?: number }
export interface PeakOptions { slo?: Slo; measureS?: number }

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

/** The limits with the defaults filled in. */
export function sloOf(slo: Slo = {}): SimulateResult['slo'] {
  return {
    p99Ms: slo.p99Ms ?? DEFAULT_SLO.p99Ms,
    errorRate: slo.errorRate ?? DEFAULT_SLO.errorRate,
    ...(slo.asyncP99Ms !== undefined ? { asyncP99Ms: slo.asyncP99Ms } : {}),
    asyncFailRate: slo.asyncFailRate ?? DEFAULT_SLO.asyncFailRate,
    drainS: slo.drainS ?? DEFAULT_SLO.drainS,
  };
}

/** The base scenario for a design with no scenario of its own (the CLI's import). */
export const steadyScenario = (readRatio?: number): Scenario => ({ schema: SCENARIO_SCHEMA, name: 'import peak', seed: 1, traffic: { rps: 0, ...(readRatio !== undefined ? { readRatio } : {}) } });

/**
 * The scenario for a peak: `base` (seed, read share, client timeout, keys, scale) at `rps`, with its
 * own length, window and events replaced by warm-up and measured load at the peak, then a drain with no new traffic.
 */
export function peakScenario(d: Design, base: Scenario, rps: number, o: PeakOptions = {}): { scenario: Scenario; warmS: number; loadS: number; drainS: number } {
  const warmS = warmUpS(d);
  const drainS = o.slo?.drainS ?? DEFAULT_SLO.drainS;
  // The engine caps warmupS at half the duration (design.ts resolveScenario): measure long enough that
  // warm-up + load + drain is at least twice the warm-up, so no warm-up second is measured.
  const loadS = warmS + Math.max(o.measureS ?? MEASURE_S, warmS - drainS);
  // The base's window is left out too: the engine measures from the warm-up rounded up to a whole
  // window, so a long window (60 s) would drop measured load (Codex review of M17).
  const { durationS: _d, warmupS: _w, windowS: _ws, traffic, events: _e, ...rest } = base;
  const scenario: Scenario = {
    ...rest,
    durationS: Math.min(MAX_DURATION_S, loadS + drainS),
    warmupS: warmS,
    traffic: { ...traffic, rps },
    events: [{ type: 'spike', atS: loadS, ...(drainS > 0 ? { forS: drainS } : {}), multiplier: 0 }],
  };
  return { scenario, warmS, loadS, drainS };
}

/** One peak run of `d` at `rps`, judged on the limits. */
export function simulatePeak(d: Design, base: Scenario, rps: number, o: PeakOptions = {}): SimulateResult {
  const { scenario, warmS, loadS, drainS } = peakScenario(d, base, rps, o);
  const slo = sloOf({ ...o.slo, drainS });
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
  const res = { criteria, ...(bottleneck ? { bottleneck } : {}), timing, slo, scenario, sim };
  // Not enough: the engine stopped early, the scenario did not fit, or too few samples for a p99.
  if (sim.truncated) return { verdict: 'insufficient', insufficient: { id: 'simulate.short.truncated', args: { events: sim.events } }, ...res };
  if (loadS + drainS > MAX_DURATION_S) return { verdict: 'insufficient', insufficient: { id: 'simulate.short.tooLong', args: { need: loadS + drainS, max: MAX_DURATION_S } }, ...res };
  // A p99 from too few samples says nothing either way; the other limits are counts and still fail.
  if (criteria.some((c) => !c.ok && c.id !== 'simulate.p99')) return { verdict: 'fail', ...res };
  if (front < MIN_SAMPLES) return { verdict: 'insufficient', insufficient: { id: 'simulate.short.samples', args: { n: front, min: MIN_SAMPLES } }, ...res };
  return { verdict: criteria.every((c) => c.ok) ? 'pass' : 'fail', ...res };
}

const round = (x: number) => Math.round(x * 10) / 10;
const pct = (x: number) => Math.round(x * 10000) / 100;

export const START_RPS = 1;
export const MAX_RPS = 1_000_000;
export const BISECT = 4;

export interface LimitStep { rps: number; verdict: Verdict; bottleneck?: string; failed: string[]; insufficient?: string }
export interface LimitResult {
  /** The most traffic that held, below the first fail (undefined: not even START_RPS held). */
  holdsRps?: number;
  /** The lowest traffic that failed (undefined: nothing failed up to MAX_RPS). */
  firstFailRps?: number;
  /** The busiest component at the first fail. */
  bottleneck?: string;
  /** A step passed above a step that failed. */
  nonMonotonic: boolean;
  /** The search stopped: a step could not give a result (too long, truncated). */
  stopped?: { rps: number; id: string };
  steps: LimitStep[];
}

/** rps for a step: whole numbers from 10 up, two decimals below. */
const tidy = (x: number) => (x >= 10 ? Math.round(x) : Math.round(x * 100) / 100);

/** The search, with the step run given (tests pass a fake one). */
export function searchLimit(evaluate: (rps: number) => LimitStep): LimitResult {
  const steps: LimitStep[] = [];
  const run = (rps: number) => {
    const s = evaluate(rps);
    steps.push(s);
    return s;
  };
  const result = (stopped?: LimitResult['stopped']): LimitResult => {
    const fails = steps.filter((s) => s.verdict === 'fail').sort((a, b) => a.rps - b.rps);
    const first = fails[0];
    const passes = steps.filter((s) => s.verdict === 'pass' && (!first || s.rps < first.rps));
    const holds = passes.length ? Math.max(...passes.map((s) => s.rps)) : undefined;
    const nonMonotonic = !!first && steps.some((s) => s.verdict === 'pass' && s.rps > first.rps);
    return { ...(holds !== undefined ? { holdsRps: holds } : {}), ...(first ? { firstFailRps: first.rps, ...(first.bottleneck ? { bottleneck: first.bottleneck } : {}) } : {}), nonMonotonic, ...(stopped ? { stopped } : {}), steps: [...steps].sort((a, b) => a.rps - b.rps) };
  };
  // An `insufficient` step from too few samples is neither pass nor fail: keep raising. One that
  // could not run (too long, truncated) stops the search.
  const stop = (s: LimitStep) => s.verdict === 'insufficient' && s.insufficient !== 'simulate.short.samples';

  let lo: number | undefined;
  let hi: number | undefined;
  for (let rps = START_RPS; rps <= MAX_RPS; rps *= 2) {
    const s = run(rps);
    if (stop(s)) return result({ rps, id: s.insufficient! });
    if (s.verdict === 'pass') lo = rps;
    if (s.verdict === 'fail') {
      hi = rps;
      // One step past the first fail: a pass there shows the results are not monotonic.
      if (rps * 2 <= MAX_RPS) {
        const after = run(rps * 2);
        if (stop(after)) return result({ rps: rps * 2, id: after.insufficient! });
      }
      break;
    }
  }
  if (hi === undefined || lo === undefined) return result();
  for (let i = 0; i < BISECT; i++) {
    const mid = tidy((lo + hi) / 2);
    if (mid <= lo || mid >= hi) break;
    const s = run(mid);
    if (stop(s)) return result({ rps: mid, id: s.insufficient! });
    if (s.verdict === 'pass') lo = mid;
    else if (s.verdict === 'fail') hi = mid;
    else break; // too few samples inside the bracket: no finer answer
  }
  return result();
}

export const stepOf = (rps: number, s: SimulateResult): LimitStep => ({
  rps,
  verdict: s.verdict,
  ...(s.bottleneck ? { bottleneck: s.bottleneck.node } : {}),
  failed: s.criteria.filter((c) => !c.ok).map((c) => c.id),
  ...(s.insufficient ? { insufficient: s.insufficient.id } : {}),
});

/** Find the limit of `d` under steady traffic shaped like `base`; `onStep` sees each step as it ends. */
export function findLimitOf(d: Design, base: Scenario, o: PeakOptions = {}, onStep?: (s: LimitStep) => void): LimitResult {
  return searchLimit((rps) => {
    const s = stepOf(rps, simulatePeak(d, base, rps, o));
    onStep?.(s);
    return s;
  });
}

export interface Assumption { node: string; param: string; value: string; from?: string }
/** The guessed values a run rests on: params whose `source` says `estimate` (set by an import). */
export function assumptionsOf(d: Design): Assumption[] {
  const out: Assumption[] = [];
  const str = (v: unknown) => (typeof v === 'object' ? JSON.stringify(v) : String(v));
  for (const n of d.nodes) {
    for (const [param, o] of Object.entries(n.source?.params ?? {})) {
      if (o.evidence !== 'estimate') continue;
      out.push({ node: n.id, param, value: str(n.params?.[param]), ...(o.from ? { from: o.from } : {}) });
    }
  }
  for (const e of d.edges) {
    for (const [param, o] of Object.entries(e.source?.params ?? {})) {
      if (o.evidence === 'estimate') out.push({ node: e.id!, param, value: String((e as unknown as Record<string, unknown>)[param]), ...(o.from ? { from: o.from } : {}) });
    }
  }
  return out;
}
