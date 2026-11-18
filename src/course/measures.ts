// What a run or try step shows on the course page after its run, next to the run before it
// (the Show of a step in src/learn/lesson.ts). Pure: no React.
import { t, tx } from '../i18n/index.ts';
import { recoveryS, spikeEnd, type RunData } from '../learn/metrics.ts';

export interface Reading {
  value: number;
  /** The component the value is about (the busiest one). */
  who?: string;
}

export interface Measure {
  label: string; // message id ({name}: the component a keyed measure is about, clientFail:<id> and util:<id>)
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

/** Keys a step's `show` may use (and clientFail:<id>, measureOf). Add one here when a lesson needs it (tests/course-measures.test.ts checks every lesson's keys). */
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
  /**
   * The busiest single instance or shard of any component (maxInstanceUtilization), with its name:
   * the node average (busiest) hides one hot shard.
   */
  busiestInstance: {
    label: tx('Busiest single instance'),
    of: (r) => {
      let best: Reading | null = null;
      for (const n of nodes(r)) {
        const u = n.maxInstanceUtilization;
        if (typeof u !== 'number' || (best && u <= best.value)) continue;
        const inst = n.instances?.reduce((a, b) => (b.utilization > a.utilization ? b : a));
        best = { value: u, who: inst?.role ? `${n.label} ${inst.role}` : n.label };
      }
      return best;
    },
    fmt: pct,
    better: 'lower',
  },
  /** Share of all requests turned away at once (REJECTED reasons). */
  rejected: { label: tx('Requests turned away at once'), of: (r) => failShareOf(r, REJECTED), fmt: pct, better: 'lower' },
  /** Share of all requests that failed by waiting too long (the timeout reason). */
  timedOut: { label: tx('Requests that timed out'), of: (r) => failShareOf(r, ['timeout']), fmt: pct, better: 'lower' },
  /** Seconds from the end of the scenario's last spike until fewer than 5% fail in every later second (recoveryS); null without a spike. */
  recovery: {
    label: tx('Recovery after the spike'),
    of: (r) => (spikeEnd(r.scenario) > 0 ? { value: recoveryS(r, spikeEnd(r.scenario)) } : null),
    fmt: (s) => (s === Infinity ? t('not before the end') : t('{s} s', { s: Math.round(s) })),
    better: 'lower',
  },
  /** Share of all requests that got a fallback response (summary.degraded ÷ offered); null when no edge has a fallback. */
  degraded: {
    label: tx('Requests answered by a fallback'),
    of: (r) => (r.result.summary.degraded === undefined ? null : { value: r.result.summary.offered > 0 ? r.result.summary.degraded / r.result.summary.offered : 0 }),
    fmt: pct,
    better: null,
  },
  /** The most messages waiting in a queue at once (queueDepthMax of the fullest queue). */
  queuePeak: {
    label: tx('Most messages waiting in the queue'),
    of: (r) => {
      let best: Reading | null = null;
      for (const n of nodes(r)) if (typeof n.queueDepthMax === 'number' && (!best || n.queueDepthMax > best.value)) best = { value: n.queueDepthMax, who: n.label };
      return best;
    },
    fmt: count,
    better: 'lower',
  },
  /** Extra calls the hedged connections sent: second copies ÷ first calls, over the edges with hedgeMs; null without one. */
  hedgeExtra: {
    label: tx('Extra calls from hedging'),
    of: (r) => {
      const hedged = new Set(r.design.edges.filter((e) => (e.hedgeMs ?? 0) > 0).map((e) => `${e.from}->${e.to}`));
      if (!hedged.size) return null;
      let copies = 0;
      let calls = 0;
      for (const e of Object.values(r.result.edges)) {
        if (!hedged.has(`${e.from}->${e.to}`)) continue;
        copies += e.hedges ?? 0;
        calls += e.calls - (e.hedges ?? 0);
      }
      return { value: calls > 0 ? copies / calls : 0 };
    },
    fmt: pct,
    better: 'lower',
  },
};

/**
 * A key with an argument, `clientFail:<client id>`: the share of that client's requests that failed
 * (the same as clientFailShare in the lessons). Null when the design has no such client.
 */
const clientFail = (id: string): Measure => ({
  label: tx('Failed requests of {name}'),
  of: (r) => {
    const n = r.result.nodes[id];
    return n && n.kind === 'client' ? { value: n.arrivals > 0 ? n.fail / n.arrivals : 0, who: n.label } : null;
  },
  fmt: pct,
  better: 'lower',
});

/** `util:<node id>`: how busy that component was (its utilization, averaged over its instances). Null when the design has no such component or it has no utilization (not a server). */
const utilOf = (id: string): Measure => ({
  label: tx('How busy {name} was'),
  of: (r) => {
    const n = r.result.nodes[id];
    return n && typeof n.utilization === 'number' ? { value: n.utilization, who: n.label } : null;
  },
  fmt: pct,
  better: 'lower',
});

/** Failure reasons that turn a request away at once (a full queue, a limit, an open breaker, a down instance, CoDel), not after a wait. */
const REJECTED = ['queue_full', 'rate_limited', 'shed', 'circuit_open', 'down', 'throttled', 'bulkhead', 'codel'] as const;
const failShareOf = (r: RunData, reasons: readonly string[]): Reading => {
  const s = r.result.summary;
  const fail = s.fail as unknown as Record<string, number>;
  const n = reasons.reduce((a, k) => a + (fail[k] ?? 0), 0);
  return { value: s.offered > 0 ? n / s.offered : 0 };
};

/** The measure for a key of a step's `show`, with its argument (clientFail:<id>, util:<id>); undefined for an unknown key. */
export function measureOf(key: string): Measure | undefined {
  const c = /^clientFail:(.+)$/.exec(key);
  if (c) return clientFail(c[1]);
  const u = /^util:(.+)$/.exec(key);
  if (u) return utilOf(u[1]);
  return Object.hasOwn(MEASURES, key) ? MEASURES[key] : undefined;
}

/** Without a `show`: p99, failed requests and the busiest component. */
export const DEFAULT_SHOW = ['p99', 'failRate', 'busiest'];

export interface Row {
  key: string;
  /** Translated (readings() runs when the page renders). */
  label: string;
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
    const m = measureOf(key);
    const now = m?.of(run);
    if (!m || !now) continue;
    const row: Row = { key, label: t(m.label, { name: now.who ?? '' }), now: m.fmt(now.value), who: now.who };
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
