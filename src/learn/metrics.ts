// Numbers read from one finished run, shared by the quiz, the challenges and the diagnosis.
// Pure functions: no React, no DOM.
import type { SimResult, TimelineEvent, WindowStat } from '../engine/index.ts';
import type { Design, Scenario } from '../schema/design.ts';

/** One finished run: the design and scenario it ran with, and what came out. */
export interface RunData {
  design: Design;
  scenario: Scenario;
  result: SimResult;
  windows: WindowStat[];
}

/**
 * The run cut to its measured interval: after the warm-up, up to the end of the traffic. The engine
 * runs on to drain the last requests, and the summary leaves the warm-up out; the story and the
 * lesson numbers do the same. Idempotent.
 */
export function measured(run: RunData): RunData {
  // the engine marks the windows it measured (whole windows after the warm-up, up to the end of
  // the traffic); events stop at the exact end of the interval or of the traffic
  const from = run.result.measuredFromS;
  const eps = 1e-6;
  const windows = run.windows.filter((w) => w.measured);
  const end = Math.min(run.result.measuredToS, run.result.scenario.durationS);
  const timeline = run.result.timeline.filter((e) => e.t >= from - eps && e.t < end - eps);
  if (windows.length === run.windows.length && timeline.length === run.result.timeline.length) return run;
  return { ...run, windows, result: { ...run.result, timeline } };
}

/** A window counts as failing when at least this share of its settled requests failed. */
export const BAD_SHARE = 0.05;
/** Windows with fewer settled requests are too small to call failing or healthy. */
const MIN_SETTLED = 10;

export function settled(w: WindowStat): number {
  let f = 0;
  for (const v of Object.values(w.fail)) f += v;
  return w.ok + f;
}

/** Share of the window's settled requests that failed. */
export function failShare(w: WindowStat): number {
  const n = settled(w);
  return n ? (n - w.ok) / n : 0;
}

export function isBad(w: WindowStat): boolean {
  return settled(w) >= MIN_SETTLED && failShare(w) >= BAD_SHARE;
}

/** Timeline types that change the load or break something (what the run is about). */
const TRIGGER_TYPES = new Set(['spike', 'ramp', 'wave', 'cron', 'down', 'slow', 'errors', 'pause', 'region_down', 'shift', 'partition', 'rollout', 'reshard']);
/** Timeline types that end a trigger. */
const CALM_TYPES = new Set(['spike_end', 'wave_end', 'up', 'slow_end', 'errors_end', 'pause_end', 'region_up', 'shift_end', 'partition_end', 'rollback', 'reshard_done']);

export function triggers(timeline: TimelineEvent[]): TimelineEvent[] {
  return timeline.filter((e) => TRIGGER_TYPES.has(e.type));
}

/** Timeline types where the system itself reacts (ejects an instance, scales out). */
const REACT_TYPES = new Set(['eject', 'hc_out', 'scale_out', 'scale_ready']);

export function reactions(timeline: TimelineEvent[]): TimelineEvent[] {
  return timeline.filter((e) => REACT_TYPES.has(e.type));
}

export function calms(timeline: TimelineEvent[]): TimelineEvent[] {
  return timeline.filter((e) => CALM_TYPES.has(e.type));
}

/** When the last trigger ended (seconds), or undefined when nothing ended. */
export function calmAt(timeline: TimelineEvent[]): number | undefined {
  let at: number | undefined;
  for (const e of timeline) if (CALM_TYPES.has(e.type)) at = Math.max(at ?? 0, e.t);
  return at;
}

/**
 * The windows before anything happened: up to the first trigger, without the first second
 * (the system is still filling up). Without a trigger: the first fifth of the run.
 */
export function baseline(run: RunData): WindowStat[] {
  const first = triggers(run.result.timeline)[0]?.t;
  const ws = run.windows;
  let out = first === undefined ? [] : ws.filter((w) => w.t > 1 && w.t <= first + 1e-9);
  if (out.length < 3) out = ws.slice(1, Math.max(3, Math.floor(ws.length / 5)));
  return out;
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Requests per second the node received, averaged over the baseline windows. */
export function baseArrivals(run: RunData, node: string): number {
  return mean(baseline(run).map((w) => (w.nodes[node]?.arrivals ?? 0) / w.dt));
}

/** The client traffic (requests per second) of the baseline windows. */
export function baseTraffic(run: RunData): number {
  return mean(baseline(run).map((w) => w.targetRps));
}

/** Largest "requests per second at the node ÷ baseline" over windows ending in (fromS, toS]. */
export function peakAmp(full: RunData, node: string, fromS: number, toS: number): number {
  const run = measured(full);
  const base = baseArrivals(run, node);
  if (base <= 0) return 0;
  let m = 0;
  for (const w of run.windows) if (w.t > fromS && w.t <= toS + 1e-9) m = Math.max(m, (w.nodes[node]?.arrivals ?? 0) / w.dt / base);
  return m;
}

/**
 * Seconds after `afterS` until the run is healthy for good: every later window has fewer than 5%
 * failed requests. 0 when nothing failed after `afterS`; Infinity when the run ends still failing.
 */
export function recoveryS(run: RunData, afterS: number): number {
  const ws = measured(run).windows;
  let last = -1;
  for (let i = ws.length - 1; i >= 0; i--) {
    if (isBad(ws[i])) {
      last = i;
      break;
    }
  }
  if (last < 0 || ws[last].t <= afterS) return 0;
  if (last >= ws.length - 2) return Infinity;
  return ws[last].t - afterS;
}

/** The end of the last spike in the scenario (seconds), or 0 without one. */
export function spikeEnd(sc: Scenario): number {
  let end = 0;
  for (const e of sc.events ?? []) if (e.type === 'spike' && e.forS !== undefined) end = Math.max(end, e.atS + e.forS);
  return end;
}
