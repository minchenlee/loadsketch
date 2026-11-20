// What a run or try step shows on the course page after its run, next to the run before it
// (the Show of a step in src/learn/lesson.ts). Pure: no React.
import { t, tx } from '../i18n/index.ts';
import { recoveryS, spikeEnd, type RunData } from '../learn/metrics.ts';
import { KINDS } from '../schema/kinds.ts';

type NodeRes = RunData['result']['nodes'][string];

/**
 * A component's name in the page's language. The run holds its labels in the language it was made
 * in; t() maps an example's label either way (English id ↔ Chinese text), and leaves a learner's own
 * name as written.
 */
const nameOf = (n: { label: string }): string => t(n.label);
type InstRes = NonNullable<NodeRes['instances']>[number];

/** A design parameter of a node, else its kind's default. */
const paramOf = (r: RunData, id: string, name: string): number => {
  const d = r.design.nodes.find((n) => n.id === id);
  const v = d?.params?.[name];
  if (typeof v === 'number') return v;
  const def = d ? KINDS[d.kind]?.params[name]?.default : undefined;
  return typeof def === 'number' ? def : 0;
};

/**
 * An instance's name in the page's language. The engine names database instances in the language
 * of the run (a run made before the learner switched language keeps it), so they are named again
 * from the design, as the engine does: per shard a primary, then its replicas.
 */
function instanceName(r: RunData, id: string, n: NodeRes, inst: InstRes | undefined): string {
  if (!inst?.role) return nameOf(n);
  if (n.kind === 'database' || n.kind === 'sharded_db') {
    let shards = n.kind === 'sharded_db' ? paramOf(r, id, 'shards') : 1;
    for (const ev of r.scenario.events ?? []) if (ev.type === 'reshard' && ev.node === id) shards = Math.max(shards, ev.toShards);
    const per = 1 + paramOf(r, id, 'replicas');
    const s = Math.floor(inst.idx / per);
    const k = inst.idx % per;
    const role = k === 0 ? t('Primary') : t('Replica {r}', { r: k });
    return `${nameOf(n)} ${shards > 1 ? t('Shard {s} {role}', { s, role }) : role}`;
  }
  return `${nameOf(n)} ${t(inst.role)}`;
}

/** The busiest instance of one node (its maxInstanceUtilization), named. */
const busiestOf = (r: RunData, id: string, n: NodeRes): Reading | null => {
  const u = n.maxInstanceUtilization;
  if (typeof u !== 'number') return null;
  const inst = n.instances?.reduce((a, b) => (b.utilization > a.utilization ? b : a));
  return { value: u, who: instanceName(r, id, n, inst) };
};

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
  /** Share of all offered requests that did not succeed (like rejected and timedOut; summary.errorRate counts only settled ones). */
  failRate: {
    label: tx('Failed requests'),
    of: (r) => {
      const s = r.result.summary;
      return { value: s.offered > 0 ? Math.min(1, Math.max(0, s.offered - s.ok) / s.offered) : 0 };
    },
    fmt: pct,
    better: 'lower',
  },
  throughput: { label: tx('Successful requests per second'), of: (r) => ({ value: r.result.summary.throughputRps }), fmt: (x) => `${Math.round(x)}/s`, better: 'higher' },
  busiest: {
    label: tx('Busiest component (average)'),
    of: (r) => {
      let best: Reading | null = null;
      for (const n of nodes(r)) if (typeof n.utilization === 'number' && (!best || n.utilization > best.value)) best = { value: n.utilization, who: nameOf(n) };
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
      return c ? { value: c.hitRatio!, who: nameOf(c) } : null;
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
      for (const [id, n] of Object.entries(r.result.nodes)) {
        const b = busiestOf(r, id, n);
        if (b && (!best || b.value > best.value)) best = b;
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
      for (const n of nodes(r)) if (typeof n.queueDepthMax === 'number' && (!best || n.queueDepthMax > best.value)) best = { value: n.queueDepthMax, who: nameOf(n) };
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
    return n && n.kind === 'client' ? { value: n.arrivals > 0 ? n.fail / n.arrivals : 0, who: nameOf(n) } : null;
  },
  fmt: pct,
  better: 'lower',
});

/** `util:<node id>`: how busy that component was (its utilization, averaged over its instances). Null when the design has no such component or it has no utilization (not a server). */
const utilOf = (id: string): Measure => ({
  label: tx('How busy {name} was'),
  of: (r) => {
    const n = r.result.nodes[id];
    return n && typeof n.utilization === 'number' ? { value: n.utilization, who: nameOf(n) } : null;
  },
  fmt: pct,
  better: 'lower',
});

/** `busiestInstance:<node id>`: the busiest instance (or shard) of that component only, named like busiestInstance. */
const busiestInstanceOf = (id: string): Measure => ({
  label: tx('Busiest instance of {name}'),
  of: (r) => {
    const n = r.result.nodes[id];
    return n ? busiestOf(r, id, n) : null;
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
  const b = /^busiestInstance:(.+)$/.exec(key);
  if (b) return busiestInstanceOf(b[1]);
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
  /** What the row shows after its label: who, less what the label already names ('' when nothing is left). */
  shown?: string;
  /** better / worse / same, by the measure's direction; absent without a run before. */
  change?: 'better' | 'worse' | 'same';
}

/** The component a keyed measure is about, by its label (busiestInstance:<id> names the component, not the instance). */
const r0 = (r: RunData, key: string) => {
  const n = r.result.nodes[key.slice(key.indexOf(':') + 1)];
  return n && nameOf(n);
};

/** A keyed measure names its component in the label: show only the rest of who (an instance), or nothing. */
function shownOf(key: string, who: string | undefined, name: string | undefined): string | undefined {
  if (!who) return who;
  if (/^(clientFail|util):/.test(key)) return '';
  if (key.startsWith('busiestInstance:')) return name && who.startsWith(name) ? who.slice(name.length).trim() : who;
  return who;
}

/** The rows a step shows after `run`, with `before` (the run before it). Unknown keys and readings the run has not are left out. */
export function readings(show: string[] | undefined, run: RunData, before?: RunData): Row[] {
  const out: Row[] = [];
  for (const key of show?.length ? show : DEFAULT_SHOW) {
    const m = measureOf(key);
    const now = m?.of(run);
    if (!m || !now) continue;
    const name = key.startsWith('busiestInstance:') ? r0(run, key) : now.who;
    const row: Row = { key, label: t(m.label, { name: name ?? '' }), now: m.fmt(now.value), who: now.who, shown: shownOf(key, now.who, name) };
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
