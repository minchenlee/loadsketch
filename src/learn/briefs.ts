// Design briefs: a problem that starts from requirements, not from a finished design. The canvas
// holds only what is given (the users, sometimes an outside service); the learner builds the rest.
// A run of the brief's scenario is judged on the same four limits as a constraint problem, plus:
//   - needs: things the design must have to do the job at all (data is stored, work is finished);
//   - givens: how fast each part is. A part cannot be made faster than the brief says, or every
//     brief is solved by typing a smaller number.
// The simulator cannot judge the questions a person asks about the requirements, the API or the
// data model. The brief states those, and tests the architecture.
// Pure functions: no React, no DOM.
import { tx } from '../i18n/index.ts';
import type { SimResult, WindowStat } from '../engine/index.ts';
import { edgeId, edgeLatencyMs, type Design, type DesignNode, type ParamValue, type Scenario } from '../schema/design.ts';
import { KINDS } from '../schema/kinds.ts';
import { customUsed, judgeLimits, type Broken, type ProblemVerdict } from './constraints.ts';
import { HOURS_PER_MONTH } from './cost.ts';
import { loadPracticeList, parseBriefSpec, type NeedSpec, type ParseOptions } from './practiceData.ts';

/**
 * `windows` end with the traffic (what the charts show). `allWindows` also holds the time after
 * it, while queues empty: the needs count on those, so work finished late is still counted.
 */
type Run = { result: SimResult; windows: WindowStat[]; allWindows?: WindowStat[] };

/** Something the design must have or do. `vars` fill the text. */
export interface Need {
  id: string;
  text: string; // message id
  check: (d: Design, run: Run) => boolean;
}

/** A broken given: text (message id) and its variables. */
export type { Broken };

export interface Brief {
  id: string;
  title: string;
  /** Who builds it and by when. */
  text: string;
  /** Functional requirements: "users can …". */
  functional: string[];
  /** Non-functional requirements that are not one of the four limits (the load, in words). */
  load: string[];
  /** How fast each part is. */
  given: string[];
  outOfScope: string[];
  scenario: Scenario;
  limits: { maxErrorRate: number; maxP99Ms: number; budgetPerMonth: number; maxPoints: number };
  /** The canvas at the start. */
  start: Design;
  /** Nodes of `start` that are not the learner's to change (an outside service). */
  fixed: string[];
  needs: Need[];
  /** The fastest a part can be, by kind and parameter (mean, ms). Without an entry: the kind's default. */
  floors?: Record<string, Record<string, number>>;
  hint: string;
  /** A design that passes (the tests check it), and the first thing most people draw, which does not. */
  reference: Design;
  naive: Design;
}

export interface BriefVerdict extends ProblemVerdict {
  needs: { id: string; text: string; ok: boolean }[];
  broken: Broken[];
}

// ---------------------------------------------------------------------------------------------
// Givens

/** Parameters that are a time: a smaller mean is a faster part. */
const TIMES = ['serviceMs', 'readMs', 'writeMs', 'opMs', 'getMs', 'putMs', 'edgeMs', 'lookupMs', 'latencyMs', 'enqueueMs', 'coldStartMs'];
/** Parameters that are a share of requests answered without the work: a larger value is a faster part. */
const SHARES = ['hitRatio'];

/** The mean of a time parameter: it is a number, or a distribution with a mean. */
const meanOf = (v: unknown): number | undefined => (typeof v === 'number' ? v : v && typeof v === 'object' && 'mean' in v ? (v as { mean: number }).mean : undefined);
/** One form for a value, so that `5` and `{ mean: 5 }` with the default spread compare equal, in any key order. */
const norm = (v: unknown, def: unknown): string => {
  const full = typeof v === 'number' && def && typeof def === 'object' ? { ...(def as object), mean: v } : v && typeof v === 'object' && def && typeof def === 'object' ? { ...(def as object), ...(v as object) } : v;
  return JSON.stringify(full && typeof full === 'object' ? Object.fromEntries(Object.entries(full).sort(([a], [b]) => (a < b ? -1 : 1))) : full ?? null);
};
/** The settings of a node as the engine sees them: a default written out is the same as one left out. */
const sameSettings = (a: DesignNode, b: DesignNode): boolean => {
  const spec = KINDS[a.kind]?.params ?? {};
  const keys = new Set([...Object.keys(spec), ...Object.keys(a.params ?? {}), ...Object.keys(b.params ?? {})]);
  for (const k of keys) if (norm(value(a, k), spec[k]?.default) !== norm(value(b, k), spec[k]?.default)) return false;
  return true;
};
const value = (n: DesignNode, key: string): ParamValue | undefined => n.params?.[key] ?? (KINDS[n.kind]?.params[key]?.default as ParamValue | undefined);

/** The parts made faster than the brief allows, and given nodes that were changed or removed. */
export function brokenGivens(b: Brief, d: Design): Broken[] {
  const out: Broken[] = customUsed(d);
  const now = new Map(d.nodes.map((n) => [n.id, n]));
  // APIs replace the scenario's read share, so they would change the load the brief gives. A brief
  // that gives its own APIs (the mix of the load) keeps them as given: none added, removed, renamed
  // or reweighted. Which edges carry which API is the learner's. A design with no APIs at all (an
  // answer saved before the brief gave them) falls back to the scenario's read share, the same mix.
  const apiKey = (x: Design['apis']) => JSON.stringify((x ?? []).map((a) => [a.name, a.op, a.share ?? 1]).sort());
  if (b.start.apis?.length) {
    if (d.apis?.length && apiKey(d.apis) !== apiKey(b.start.apis)) out.push({ text: tx('This brief gives the APIs and their traffic shares: you cannot add, remove, rename or reweight them'), vars: {} });
  } else if (d.apis?.length) out.push({ text: tx('The brief gives the read and write shares; APIs cannot replace them'), vars: {} });
  for (const id of b.fixed) {
    const was = b.start.nodes.find((n) => n.id === id)!;
    const n = now.get(id);
    const name = was.label ?? id;
    if (!n || n.kind !== was.kind) out.push({ text: tx('"{name}", given by the brief, is gone'), vars: { name } });
    else if (!sameSettings(n, was)) out.push({ text: tx('"{name}" is given by the brief: its settings cannot change'), vars: { name } });
  }
  // the network is given too: a connection cannot be faster than its default (20 ms from the users)
  for (const e of d.edges) {
    const from = now.get(e.from);
    if (!from || e.latencyMs === undefined) continue;
    const floor = edgeLatencyMs({}, from);
    if (e.latencyMs < floor) out.push({ text: tx('The network latency of connection "{name}" is {got} ms; the fastest the brief gives is {floor} ms'), vars: { name: edgeId(e), got: e.latencyMs, floor } });
  }
  for (const n of d.nodes) {
    if (b.fixed.includes(n.id)) continue;
    const spec = KINDS[n.kind];
    if (!spec) continue;
    const name = n.label ?? n.id;
    for (const k of TIMES) {
      const def = meanOf(spec.params[k]?.default);
      const got = meanOf(value(n, k));
      if (def === undefined || got === undefined) continue;
      const floor = b.floors?.[n.kind]?.[k] ?? def;
      if (got < floor) out.push({ text: tx('"{name}": {what} is {got} ms; the brief gives {floor} ms as the fastest'), vars: { name, what: spec.params[k].label ?? k, got, floor } });
    }
    for (const k of SHARES) {
      const def = spec.params[k]?.default;
      const got = value(n, k);
      if (typeof def !== 'number' || typeof got !== 'number') continue;
      if (got > def) out.push({ text: tx('"{name}": {what} is {got}; the brief gives {floor} as the highest'), vars: { name, what: spec.params[k].label ?? k, got, floor: def } });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Needs

/** Node ids a request from a client can reach along the connections. */
export function reachable(d: Design): Set<string> {
  const next = new Map<string, string[]>();
  for (const e of d.edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const seen = new Set(d.nodes.filter((n) => n.kind === 'client').map((n) => n.id));
  const todo = [...seen];
  while (todo.length) {
    for (const to of next.get(todo.pop()!) ?? []) {
      if (!seen.has(to)) {
        seen.add(to);
        todo.push(to);
      }
    }
  }
  return seen;
}

const reaches = (d: Design, kinds: string[]) => {
  const r = reachable(d);
  return d.nodes.some((n) => kinds.includes(n.kind) && r.has(n.id));
};

/**
 * The writes (or reads) users send arrive at these nodes. A line on the canvas is not enough: an
 * edge can carry reads only, and a queue can lose messages. Counted on the connections, over the
 * whole run: calls that go into the nodes, against calls that leave the users (3% is still on the way).
 * It counts calls, not requests: a design that sends one request twice and drops another is not
 * found. The check is there for an honest mistake, not to stop someone who wants to cheat.
 */
function arrive(op: 'read' | 'write', d: Design, run: Run, into: (n: DesignNode) => boolean): boolean {
  const [out, arrived] = calls(op, d, run, into);
  return out > 0 && arrived >= 0.97 * out;
}

/** Calls of one kind that leave the users, and those that go into the chosen nodes, over the whole run. */
/** `calls`: every call, of either kind (what a cache fetches from its store is counted so). */
type Op = 'read' | 'write' | 'calls';
function calls(op: Op, d: Design, run: Run, into: (n: DesignNode) => boolean): [out: number, arrived: number] {
  const kind = new Map(d.nodes.map((n) => [n.id, n]));
  const sent = new Set<string>();
  const got = new Set<string>();
  for (const e of d.edges) {
    if (kind.get(e.from)?.kind === 'client') sent.add(edgeId(e));
    const to = kind.get(e.to);
    if (to && into(to)) got.add(edgeId(e));
  }
  let out = 0;
  let arrived = 0;
  for (const w of run.allWindows ?? run.windows) {
    for (const [id, e] of Object.entries(w.edges)) {
      if (sent.has(id)) out += e[op];
      if (got.has(id)) arrived += e[op];
    }
  }
  return [out, arrived];
}

/** Reads that go to a store: from a caller directly, or fetched by a cache (counted as calls of the cache). */
function misses(d: Design, run: Run): number {
  const kind = new Map(d.nodes.map((n) => [n.id, n.kind]));
  const direct = new Set<string>();
  const fetched = new Set<string>();
  for (const e of d.edges) {
    if (!STORES.includes(kind.get(e.to) ?? '')) continue;
    (kind.get(e.from) === 'cache' ? fetched : direct).add(edgeId(e));
  }
  let n = 0;
  for (const w of run.allWindows ?? run.windows) {
    for (const [id, e] of Object.entries(w.edges)) n += direct.has(id) ? e.read : fetched.has(id) ? e.calls : 0;
  }
  return n;
}
const STORES = ['database', 'sharded_db', 'object_storage'];

/** What users write is stored in a database. */
const stored: Need = { id: 'stored', text: tx('Data is stored in a database'), check: (d, run) => reaches(d, ['database', 'sharded_db']) && arrive('write', d, run, (n) => n.kind === 'database' || n.kind === 'sharded_db') };

/** What users read comes from somewhere: a cache or a database. An API with no store behind its reads answers with nothing. */
const looked: Need = {
  id: 'looked',
  text: tx('Reads get their data from a cache or a database'),
  check: (d, run) => {
    // a read put on a queue is answered before anything was looked up
    const [out, queued] = calls('read', d, run, (n) => n.kind === 'queue');
    if (queued > 0.01 * out || !arrive('read', d, run, (n) => ['cache', 'database', 'sharded_db'].includes(n.kind))) return false;
    // reads that go to a cache: what the cache does not have must be read from a store (the cache
    // hits at most 90%, so at least 5% of the reads). A cache with no store behind its reads
    // answers a miss with nothing.
    const [, cached] = calls('read', d, run, (n) => n.kind === 'cache');
    return cached <= 0.5 * out || misses(d, run) >= 0.05 * out;
  },
};

/**
 * Background work is finished: what still waits at the end, and what was lost on the way (a message
 * past its time to live, a delivery that failed), is at most 1% of the requests.
 */
const finished: Need = {
  id: 'finished',
  text: tx('Background work is finished (at most 1% still waiting or lost)'),
  check: (_, run) => run.result.unfinished + Object.values(run.result.nodes).reduce((s, n) => s + (n.asyncFail ?? 0), 0) <= 0.01 * Math.max(1, run.result.summary.offered),
};

/**
 * A degraded answer is not the real one: at most 1% of the requests. Background work that fell back
 * (a worker's call that failed and was answered by a fallback) counts too: the summary has only
 * the answers users got, so the fallbacks on every connection are counted as well.
 */
const notDegraded: Need = {
  id: 'not-degraded',
  text: tx('At most 1% degraded responses'),
  check: (_, run) => {
    const max = 0.01 * Math.max(1, run.result.summary.offered);
    const fallbacks = Object.values(run.result.edges).reduce((s, e) => s + (e.fallbacks ?? 0), 0);
    return (run.result.summary.degraded ?? 0) <= max && fallbacks <= max;
  },
};

/**
 * The calls of one kind arrive at a given node. `share`: how much of what users send must arrive
 * (less than all of it when a cache or a circuit breaker may answer some of the calls).
 */
const reachesNode = (id: string, text: string, op: Op = 'write', share = 0.97): Need => ({
  id: `reaches-${id}`,
  text,
  check: (d, run) => {
    const [out, arrived] = calls(op, d, run, (n) => n.id === id);
    return reachable(d).has(id) && out > 0 && arrived >= share * out;
  },
});

export function compileNeed(spec: NeedSpec): Need {
  switch (spec.kind) {
    case 'stored':
      return stored;
    case 'looked':
      return looked;
    case 'finished':
      return finished;
    case 'not-degraded':
      return notDegraded;
    case 'reaches-node':
      return reachesNode(spec.node, spec.text, spec.op, spec.share);
  }
}

export function parseBrief(file: string, raw: unknown, opts?: ParseOptions): Brief {
  const spec = parseBriefSpec(file, raw, opts);
  return { ...spec, needs: spec.needs.map(compileNeed) };
}

// ---------------------------------------------------------------------------------------------
// Briefs

const briefFiles = import.meta.glob('../../examples/practice/briefs/*.json', { eager: true, import: 'default' });
export const BRIEFS: Brief[] = loadPracticeList(briefFiles, parseBrief);

export const BRIEF_BY_ID: Record<string, Brief> = Object.fromEntries(BRIEFS.map((b) => [b.id, b]));

/** Judge one run of a brief: the four limits, the needs and the givens are all gates. */
export function judgeBrief(b: Brief, design: Design, run: Run): BriefVerdict {
  const v = judgeLimits(b.limits, design, run);
  const needs = b.needs.map((n) => ({ id: n.id, text: n.text, ok: n.check(design, run) }));
  const broken = brokenGivens(b, design);
  const passed = v.passed && broken.length === 0 && needs.every((n) => n.ok);
  // Traffic to users and the given nodes cost the same in every design, so the score compares the
  // rest: 100 = nothing but that part, 50 = the whole budget.
  const same = v.cost.items.filter((i) => i.id === 'egress' || b.fixed.includes(i.id)).reduce((s, i) => s + i.perHour * HOURS_PER_MONTH, 0);
  const room = b.limits.budgetPerMonth - same;
  const score = passed ? 50 + Math.round((50 * Math.max(0, b.limits.budgetPerMonth - v.cost.perMonth)) / Math.max(1, room)) : 0;
  return { ...v, passed, score: Math.min(100, score), needs, broken };
}
