// The compare view (roadmap-next M2, Q6–Q8): up to 4 runs side by side, one of them the baseline.
// Pure helpers: the metrics, how much each run differs from the baseline, and the time series a
// run again gives. The view is src/app/components/Compare.tsx; the runs again happen in
// src/worker/compare.worker.ts.
import type { WindowStat } from '../engine/index.ts';
import { FAIL_REASONS } from '../engine/index.ts';
import type { Design, Scenario } from '../schema/design.ts';
import type { VersionSummary } from './versions.ts';
import { fmtMs, pct } from './ui.ts';
import { fmtUsd } from '../learn/cost.ts';
import { t, tx } from '../i18n/index.ts';

/** At most this many runs in one comparison (Q6=B). */
export const MAX_COMPARE = 4;

/** One run in a comparison: a saved version, or a design and scenario not run yet (summary from the run again). */
export interface CompareItem {
  key: string;
  name: string;
  /** When the version was made, ms since 1970 (absent: not a saved version). */
  at?: number;
  design: Design;
  scenario: Scenario;
  summary?: VersionSummary;
}

/** A run again: per-window failure share and p99, on the window end times. */
export interface RunSeries {
  t: number[];
  failShare: (number | null)[];
  p99: (number | null)[];
}

/** A run again in the compare view: its summary and series, or why it failed. */
export type Again = { summary: VersionSummary; series: RunSeries } | { error: string };

export function seriesOf(windows: WindowStat[]): RunSeries {
  const out: RunSeries = { t: [], failShare: [], p99: [] };
  for (const w of windows) {
    const fail = FAIL_REASONS.reduce((a, k) => a + w.fail[k], 0);
    out.t.push(w.t);
    out.failShare.push(w.ok + fail > 0 ? fail / (w.ok + fail) : null);
    out.p99.push(w.latency.count ? w.latency.p99 : null);
  }
  return out;
}

/**
 * The series of a run up to the end of its traffic (`durationMs`): the span the live run shows and a
 * finished run keeps (src/app/curves.ts), so a series kept and a series from a run again are the same.
 */
export function seriesUpTo(windows: WindowStat[], durationMs: number): RunSeries {
  return seriesOf(windows.filter((w) => w.t <= durationMs / 1000 + 1e-9));
}

/**
 * Chart data for several runs: [xs, run 1, run 2, …] on the union of their times, null where a
 * run has no window (a shorter run).
 */
export function overlay(series: (RunSeries | undefined)[], pick: 'failShare' | 'p99'): (number | null)[][] {
  const xs = [...new Set(series.flatMap((s) => s?.t ?? []))].sort((a, b) => a - b);
  const at = new Map(xs.map((x, i) => [x, i]));
  const ys = series.map((s) => {
    const y: (number | null)[] = xs.map(() => null);
    if (s) s.t.forEach((x, i) => (y[at.get(x)!] = s[pick][i]));
    return y;
  });
  return [xs, ...ys];
}

/** A metric row of the compare table. `better`: which way is an improvement. */
export interface Metric {
  key: 'errorRate' | 'p50' | 'p99' | 'throughputRps' | 'costPerMonth' | 'complexity';
  label: string;
  better: 'lower' | 'higher';
  fmt: (v: number) => string;
}

export const METRICS: Metric[] = [
  { key: 'errorRate', label: tx('失敗率'), better: 'lower', fmt: pctFine },
  { key: 'p50', label: 'p50', better: 'lower', fmt: fmtMs },
  { key: 'p99', label: 'p99', better: 'lower', fmt: fmtMs },
  { key: 'throughputRps', label: tx('每秒成功'), better: 'higher', fmt: (v) => fmtRate(v) },
  { key: 'costPerMonth', label: tx('每月成本'), better: 'lower', fmt: fmtUsd },
  { key: 'complexity', label: tx('複雜度'), better: 'lower', fmt: (v) => t('{n} 點', { n: v }) },
];

/** A failure share with one decimal under 10% (0.4%, 2.5%): the compare view tells small changes apart. */
function pctFine(x: number): string {
  if (x === 0) return '0%';
  if (x < 0.001) return '<0.1%';
  if (x < 0.1) return `${(x * 100).toFixed(1)}%`;
  return pct(x);
}

function fmtRate(v: number): string {
  return v >= 100 ? Math.round(v).toLocaleString('en-US') : String(Math.round(v * 10) / 10);
}

/** How a run's value compares with the baseline's. */
export interface Delta {
  text: string;
  /** better / worse than the baseline, or the same. */
  tone: 'better' | 'worse' | 'same';
}

const sign = (d: number) => (d > 0 ? '+' : '−');

/** The difference of one metric from the baseline, as the table shows it. */
export function delta(m: Metric, base: number, v: number): Delta {
  const d = v - base;
  // a change below rounding is no change
  const tiny = m.key === 'errorRate' ? Math.abs(d) < 0.0005 : m.key === 'complexity' ? d === 0 : Math.abs(d) < Math.max(1e-9, Math.abs(base) * 0.005);
  if (tiny) return { text: t('一樣'), tone: 'same' };
  const tone = (d < 0) === (m.better === 'lower') ? 'better' : 'worse';
  const rel = base > 0 && m.key !== 'errorRate' && m.key !== 'complexity' ? ` (${sign(d)}${Math.round((Math.abs(d) / base) * 100)}%)` : '';
  switch (m.key) {
    case 'errorRate':
      return { text: t('{d} 個百分點', { d: `${sign(d)}${(Math.abs(d) * 100).toFixed(1)}` }), tone };
    case 'p50':
    case 'p99':
      return { text: `${sign(d)}${fmtMs(Math.abs(d))}${rel}`, tone };
    case 'costPerMonth':
      return { text: `${sign(d)}${fmtUsd(Math.abs(d))}${rel}`, tone };
    case 'throughputRps':
      return { text: `${sign(d)}${fmtRate(Math.abs(d))}${rel}`, tone };
    case 'complexity':
      return { text: `${sign(d)}${Math.abs(d)}`, tone };
  }
}

/**
 * The summary a run again gave differs from the saved one: the version was made by an older
 * simulator, and its charts (from the run again) do not match its numbers exactly.
 */
export function rerunDiffers(saved: VersionSummary, again: VersionSummary): boolean {
  return saved.offered !== again.offered || saved.ok !== again.ok || saved.p99 !== again.p99;
}
