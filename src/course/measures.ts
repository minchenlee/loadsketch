// What a run or try step shows on the course page after its run, next to the run before it
// (the Show of a step in src/learn/lesson.ts). Pure: no React.
import { tx } from '../i18n/index.ts';
import type { RunData } from '../learn/metrics.ts';

export interface Reading {
  value: number;
  /** The component the value is about (the busiest one). */
  who?: string;
}

export interface Measure {
  label: string; // message id
  of: (run: RunData) => Reading | null;
  fmt: (v: number) => string;
  /** Which way is better, for the colour of the change (null: neither). */
  better: 'lower' | 'higher' | null;
}

const ms = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(2)} s` : x >= 100 ? `${x.toFixed(0)} ms` : x >= 10 ? `${x.toFixed(1)} ms` : `${x.toFixed(2)} ms`);
const pct = (x: number) => (x === 0 ? '0%' : x < 0.001 ? '<0.1%' : x < 0.1 ? `${(x * 100).toFixed(1)}%` : `${Math.round(x * 100)}%`);
const count = (x: number) => `${Math.round(x)}`;
const nodes = (r: RunData) => Object.values(r.result.nodes);
const sum = (r: RunData, f: (n: RunData['result']['nodes'][string]) => number | undefined): Reading | null => {
  const xs = nodes(r).map(f).filter((x): x is number => typeof x === 'number');
  return xs.length ? { value: xs.reduce((a, b) => a + b, 0) } : null;
};

/** Keys a step's `show` may use. Add one here when a lesson needs it (tests/course-measures.test.ts checks every lesson's keys). */
export const MEASURES: Record<string, Measure> = {
  p99: { label: tx('p99 latency'), of: (r) => (r.result.summary.latencyMs.count ? { value: r.result.summary.latencyMs.p99 } : null), fmt: ms, better: 'lower' },
  p50: { label: tx('Median latency'), of: (r) => (r.result.summary.latencyMs.count ? { value: r.result.summary.latencyMs.p50 } : null), fmt: ms, better: 'lower' },
  failRate: { label: tx('Failed requests'), of: (r) => ({ value: r.result.summary.errorRate }), fmt: pct, better: 'lower' },
  throughput: { label: tx('Successful requests per second'), of: (r) => ({ value: r.result.summary.throughputRps }), fmt: (x) => `${Math.round(x)}/s`, better: 'higher' },
  busiest: {
    label: tx('Busiest component'),
    of: (r) => {
      let best: Reading | null = null;
      for (const n of nodes(r)) if (typeof n.utilization === 'number' && (!best || n.utilization > best.value)) best = { value: n.utilization, who: n.label };
      return best;
    },
    fmt: pct,
    better: 'lower',
  },
  asyncP99: { label: tx('p99 of background work'), of: (r) => (r.result.summary.asyncLatencyMs.count ? { value: r.result.summary.asyncLatencyMs.p99 } : null), fmt: ms, better: 'lower' },
  hitRatio: {
    label: tx('Cache hit ratio'),
    of: (r) => {
      const c = nodes(r).find((n) => typeof n.hitRatio === 'number');
      return c ? { value: c.hitRatio!, who: c.label } : null;
    },
    fmt: pct,
    better: 'higher',
  },
  duplicates: { label: tx('Messages processed twice'), of: (r) => sum(r, (n) => n.duplicates), fmt: count, better: 'lower' },
  dlq: { label: tx('Messages in the dead-letter queue'), of: (r) => sum(r, (n) => n.dlq), fmt: count, better: null },
  staleReads: { label: tx('Stale reads'), of: (r) => sum(r, (n) => n.staleReads), fmt: count, better: 'lower' },
};

/** Without a `show`: p99, failed requests and the busiest component. */
export const DEFAULT_SHOW = ['p99', 'failRate', 'busiest'];

export interface Row {
  key: string;
  label: string; // message id
  now: string;
  /** The run before it (same example and scenario); absent on the first run. */
  before?: string;
  who?: string;
  /** better / worse / same, by the measure's direction; absent without a run before. */
  change?: 'better' | 'worse' | 'same';
}

/** The rows a step shows after `run`, with `before` (the run before it). Unknown keys and readings the run has not are left out. */
export function readings(show: string[] | undefined, run: RunData, before?: RunData): Row[] {
  const out: Row[] = [];
  for (const key of show?.length ? show : DEFAULT_SHOW) {
    const m = MEASURES[key];
    const now = m?.of(run);
    if (!m || !now) continue;
    const row: Row = { key, label: m.label, now: m.fmt(now.value), who: now.who };
    const was = before ? m.of(before) : null;
    if (was) {
      row.before = m.fmt(was.value);
      const same = row.before === row.now;
      row.change = same || !m.better ? 'same' : (now.value < was.value) === (m.better === 'lower') ? 'better' : 'worse';
    }
    out.push(row);
  }
  return out;
}
