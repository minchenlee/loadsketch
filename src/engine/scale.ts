// Scale factor k: a long or busy run simulates 1/k of the traffic on 1/k of the
// capacity, then multiplies the counts by k. Queueing behaviour stays close when each instance
// keeps enough slots (at least 32) and a node keeps enough instances (at least 10): with many
// servers, the wait and the share that waits depend on the load per server, not on the number.
// Processing times, instance counts (where possible) and time are not scaled.

import { instanceRoles, type Design, type DesignNode, type ScenarioEvent } from '../schema/design.ts';
import { KINDS, fanoutApplies, resolveParams } from '../schema/kinds.ts';

/** About this many requests keep a run to a few seconds (≈ 125 000 requests per second of CPU). */
export const SCALE_TARGET_REQUESTS = 300_000;
/** Slots per instance are cut down to this, not lower. */
export const MIN_SLOTS = 32;
/** After the slots, instances are cut down to this, not lower. */
export const MIN_INSTANCES = 10;

/** Slots per instance (threads, connections). */
const SLOTS = ['concurrency', 'connections'];
/** Per instance limits that follow the traffic each instance gets (÷ the node's slot factor). */
const PER_INSTANCE = ['queueLimit'];
/** Limits on totals across the node (÷ k). 0 keeps its meaning (off). */
const TOTALS = ['ratePerSec', 'burst', 'maxConcurrent', 'minCalls', 'maxDepth', 'maxConcurrency', 'provisioned', 'scalePer10s'];
/** Integer totals; ratePerSec stays a real number. */
const REAL = new Set(['ratePerSec']);

export interface NodeScale {
  /** Slots per instance are divided by this. */
  slots: number;
  /** Instances are divided by this. */
  instances: number;
  /**
   * Instance rows in the design and in the run, when the run has fewer (an autoscaled node has a
   * row for each instance it may start: maxInstances), and the design's name of each row.
   */
  from?: number;
  to?: number;
  roles?: string[];
}

export interface ScalePlan {
  k: number;
  /** k asked for, before the limits ('auto' picks it from the request count). */
  requested: number | 'auto';
  /** Largest k the design allows (slots ≥ 32, then instances ≥ 10). */
  maxK: number;
  nodes: Record<string, NodeScale>;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * Largest k a node allows: its slots down to 32, then its instances down to 10. A node an event
 * aims at by instance keeps all its instances (the event names one of them).
 */
function nodeMaxK(n: DesignNode, keepInstances: boolean): number {
  const p = resolveParams(n.kind, n.params);
  // a row lock caps that row's writes at 1 / (writeMs + lockHoldMs) at any size: 1/k of the traffic would hide the contention
  if (p.locks === 'row') return 1;
  // a function's environments have one slot each (MIN_SLOTS does not apply): keep at least
  // MIN_INSTANCES of its concurrency limit, like instances, and of its scaling rate and its
  // provisioned environments (scaleDesign() rounds each to a whole number of at least 1, so a
  // smaller one would change the rate)
  if (n.kind === 'function') {
    const prov = num(p.provisioned) ?? 0;
    const least = Math.min(num(p.maxConcurrency)!, num(p.scalePer10s)!, prov > 0 ? prov : Infinity);
    return Math.max(1, least / MIN_INSTANCES);
  }
  const slot = SLOTS.map((s) => num(p[s])).find((v) => v !== undefined);
  if (slot === undefined) return Infinity;
  const bySlots = Math.max(1, slot / MIN_SLOTS);
  const inst = num(p.instances);
  const byInst = inst === undefined || keepInstances ? 1 : Math.max(1, inst / MIN_INSTANCES);
  return bySlots * byInst;
}

/** Kinds a global rollout (a rollout without a node) updates. */
export const ROLLOUT_KINDS = new Set(['api_gateway', 'service', 'worker']);

/**
 * Pick k. `requested`: a number (capped by what the design allows) or 'auto' (the smallest whole k
 * that brings `expectedRequests` to SCALE_TARGET_REQUESTS, capped the same way).
 */
export function planScale(design: Design, expectedRequests: number, requested: number | 'auto' = 'auto', events: ScenarioEvent[] = []): ScalePlan {
  // an event that names one instance, or a fan-out that sends to N of them, needs all instances
  const pinned = new Set(events.flatMap((ev) => ('instance' in ev && ev.instance !== undefined ? [ev.node] : [])));
  const kindOf = new Map(design.nodes.map((n) => [n.id, n.kind]));
  // a rollout updates a share of the instances per wave: fewer instances would make the waves coarser
  for (const ev of events) {
    if (ev.type !== 'rollout') continue;
    if (ev.node !== undefined) pinned.add(ev.node);
    else for (const n of design.nodes) if (ROLLOUT_KINDS.has(n.kind)) pinned.add(n.id);
  }
  for (const e of design.edges) if ((e.fanout ?? 0) > 1 && fanoutApplies(kindOf.get(e.from) ?? '', kindOf.get(e.to) ?? '')) pinned.add(e.to);
  let maxK = Infinity;
  for (const n of design.nodes) maxK = Math.min(maxK, nodeMaxK(n, pinned.has(n.id)));
  maxK = Number.isFinite(maxK) ? Math.max(1, Math.floor(maxK + 1e-9)) : 1000;
  const want = requested === 'auto' ? Math.ceil(expectedRequests / SCALE_TARGET_REQUESTS - 1e-9) : Math.floor(requested);
  const k = Math.max(1, Math.min(want, maxK));
  const nodes: Record<string, NodeScale> = {};
  for (const n of design.nodes) {
    const p = resolveParams(n.kind, n.params);
    const slot = SLOTS.map((s) => num(p[s])).find((v) => v !== undefined);
    const slots = slot === undefined ? 1 : Math.min(k, Math.max(1, slot / MIN_SLOTS));
    const ns: NodeScale = { slots, instances: k / slots };
    const inst = num(p.instances);
    if (ns.instances > 1 + 1e-9 && inst !== undefined) {
      // the same rounding as scaleDesign
      const to = Math.max(1, Math.round(inst / ns.instances));
      const mx = p.autoscale === 'on' ? num(p.maxInstances) : undefined;
      const rowsFrom = mx === undefined ? inst : Math.max(inst, mx);
      const rowsTo = mx === undefined ? to : Math.max(to, Math.round(mx / ns.instances));
      if (rowsTo < rowsFrom) {
        ns.from = rowsFrom;
        ns.to = rowsTo;
        ns.roles = instanceRoles(n);
      }
    }
    nodes[n.id] = ns;
  }
  return { k, requested, maxK, nodes };
}

/** The design with its capacity cut by k (a copy; the input is not changed). */
export function scaleDesign(design: Design, plan: ScalePlan): Design {
  if (plan.k === 1) return design;
  const k = plan.k;
  const nodes = design.nodes.map((n) => {
    const ns = plan.nodes[n.id];
    const p = resolveParams(n.kind, n.params);
    const out: Record<string, unknown> = { ...(n.params ?? {}) };
    for (const s of SLOTS) {
      const v = num(p[s]);
      if (v !== undefined && s in p) out[s] = Math.max(1, Math.round(v / ns.slots));
    }
    for (const s of PER_INSTANCE) {
      const v = num(p[s]);
      if (v) out[s] = Math.max(1, Math.round(v / ns.slots));
    }
    for (const s of TOTALS) {
      const v = num(p[s]);
      if (v) out[s] = REAL.has(s) ? v / k : Math.max(1, Math.round(v / k));
    }
    if (ns.instances > 1 + 1e-9) {
      const inst = num(p.instances);
      if (inst !== undefined) {
        const i2 = Math.max(1, Math.round(inst / ns.instances));
        out.instances = i2;
        const mx = num(p.maxInstances);
        if (mx !== undefined) out.maxInstances = Math.max(i2, Math.round(mx / ns.instances));
      }
    }
    return { ...n, params: out as DesignNode['params'] };
  });
  const kindOf = new Map(design.nodes.map((n) => [n.id, n.kind]));
  const edges = design.edges.map((e) => {
    // a bulkhead caps calls in flight per calling instance, which get 1/(slot factor) of the traffic;
    // a caller without instances (users, a load balancer, a breaker) has one count for all: 1/k
    if (!e.bulkhead) return e;
    const f = KINDS[kindOf.get(e.from) ?? '']?.station ? (plan.nodes[e.from]?.slots ?? 1) : k;
    return { ...e, bulkhead: Math.max(1, Math.round(e.bulkhead / f)) };
  });
  return { ...design, nodes, edges };
}

// ---------------------------------------------------------------------------------------------
// Counts back to full size

/** Fields that count requests (or are rates of them): multiplied by k. */
const FLOW = new Set([
  'offered', 'ok', 'fail', 'origin', 'arrivals', 'rps', 'calls', 'read', 'write', 'retries', 'late', 'denied', 'throttled',
  'bulkhead', 'fallbacks', 'hedges', 'hedgeWins', 'attempts', 'copies', 'asyncDone', 'degraded', 'targetRps', 'throughputRps',
  'coalesced', 'leaseWaits', 'expired', 'redelivered', 'duplicates', 'dlq', 'staleReads', 'replicaReads',
  'replicationApplied', 'replicationDropped', 'lostWrites', 'crossRegion', 'rywMisses', 'divergentWrites', 'dualWriteGaps', 'outboxRetries', 'holBlocked', 'connects', 'asyncOk', 'asyncFail', 'started', 'lambdaPerSec', 'count',
]);
/** Requests waiting, summed over the node: multiplied by k. */
const NODE_QUEUE = new Set(['queue', 'depth', 'avgQueue', 'peakQueue', 'queueDepthAvg', 'queueDepthEnd', 'queueDepthMax']);

/** Multiply the count fields of `o` in place (nested objects too, except the ones in `skip`). */
function mulCounts(o: Record<string, unknown>, k: number, keys: Set<string>, skip: Set<string>): void {
  for (const [key, v] of Object.entries(o)) {
    if (skip.has(key)) continue;
    if (typeof v === 'number') {
      if (keys.has(key)) o[key] = v * k;
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = v as Record<string, unknown>;
      // a FailCounts object (fail, origin) holds only counts
      if (keys.has(key)) for (const [ik, iv] of Object.entries(inner)) inner[ik] = typeof iv === 'number' ? iv * k : iv;
      else mulCounts(inner, k, keys, skip);
    }
  }
}

const BOTH = new Set([...FLOW, ...NODE_QUEUE]);
/** Fields whose numbers are not counts even though their names match (latency summaries keep their ms). */
const KEEP = new Set(['latencyMs', 'asyncLatencyMs', 'theory', 'autoscale', 'function', 'scenario', 'scale']);
/** A function's counts: environments and cold starts follow the traffic (1/k of it ran). */
const FUNCTION_COUNTS = ['limit', 'provisioned', 'peakEnvs', 'endEnvs', 'coldStarts', 'throttles'] as const;

/** A window's counts at full size (in place; returns it). */
export function scaleWindow<W extends object>(w: W, k: number): W {
  if (k !== 1) {
    mulCounts(w as Record<string, unknown>, k, BOTH, new Set(['latency']));
    const lat = (w as { latency?: { count: number } }).latency;
    if (lat) lat.count *= k;
  }
  return w;
}

/** Design instance i is shown as run instance `of(i)` (the run may have fewer instances). */
const runIndex = (ns: NodeScale, i: number): number => (ns.from && ns.to ? Math.min(ns.to - 1, Math.floor((i * ns.to) / ns.from)) : i);
/** The first design instance shown by run instance j. */
const designIndex = (ns: NodeScale, j: number): number => (ns.from && ns.to ? Math.ceil((j * ns.from) / ns.to) : j);

type Row = { idx: number; role?: string; avgQueue: number; started: number };

/**
 * A result's counts at full size (in place; returns it). Per instance rows use the node's slot
 * factor, and a node run with fewer instances shows one row per instance of the design again.
 */
export function scaleResult<R extends { nodes: Record<string, { instances?: Row[]; maxQueue?: number }>; bottleneck: { node: string; instance?: number; avgQueue: number } | null }>(r: R, plan: ScalePlan): R {
  const k = plan.k;
  if (k === 1) return r;
  const obj = r as unknown as Record<string, unknown>;
  for (const [key, v] of Object.entries(obj)) {
    if (KEEP.has(key) || key === 'nodes' || key === 'bottleneck' || !v || typeof v !== 'object') continue;
    mulCounts(v as Record<string, unknown>, k, BOTH, KEEP);
  }
  const b = r.bottleneck;
  if (b) {
    const ns = plan.nodes[b.node];
    // the busiest instance's average queue
    b.avgQueue *= ns?.slots ?? 1;
    if (ns && b.instance !== undefined) b.instance = designIndex(ns, b.instance);
  }
  const summary = obj.summary as { latencyMs?: { count: number }; asyncLatencyMs?: { count: number } } | undefined;
  if (summary?.latencyMs) summary.latencyMs.count *= k;
  if (summary?.asyncLatencyMs) summary.asyncLatencyMs.count *= k;
  for (const a of Object.values((obj.apis ?? {}) as Record<string, { latencyMs?: { count: number } }>)) if (a.latencyMs) a.latencyMs.count *= k;
  if (typeof obj.unfinished === 'number') obj.unfinished *= k;
  for (const [id, n] of Object.entries(r.nodes)) {
    const ns = plan.nodes[id];
    mulCounts(n as Record<string, unknown>, k, BOTH, new Set([...KEEP, 'instances']));
    const fn = (n as { function?: Record<(typeof FUNCTION_COUNTS)[number], number> }).function;
    if (fn) for (const f of FUNCTION_COUNTS) fn[f] *= k;
    if (!ns) continue;
    // the largest queue of one instance
    if (n.maxQueue !== undefined) n.maxQueue *= ns.slots;
    const rows = n.instances;
    if (!rows) continue;
    for (const row of rows) {
      row.avgQueue *= ns.slots;
      row.started *= ns.slots;
    }
    if (ns.from && ns.to) {
      const byIdx = new Map(rows.map((x) => [x.idx, x]));
      // each row is a design instance: its own index and name, the numbers of the run instance it stands for
      n.instances = Array.from({ length: ns.from }, (_, i) => ({ ...(byIdx.get(runIndex(ns, i)) ?? rows[0]), idx: i, ...(ns.roles?.[i] !== undefined ? { role: ns.roles[i] } : {}) }));
    }
  }
  return r;
}

/**
 * Live state at full size: totals use k; per instance busy, slots and queued use the node's slot
 * factor, with one row per instance of the design.
 */
export function scaleLive<L extends { busy: number; slots: number; queued: number; down: number; depth?: number; inst?: [number, number, number, number, number][] }>(
  live: Record<string, L>,
  plan: ScalePlan,
): Record<string, L> {
  if (plan.k === 1) return live;
  for (const [id, s] of Object.entries(live)) {
    const ns = plan.nodes[id];
    const f = ns?.slots ?? 1;
    s.busy *= plan.k;
    s.slots *= plan.k;
    s.queued *= plan.k;
    if (s.depth !== undefined) s.depth *= plan.k;
    if (s.inst) {
      for (const i of s.inst) {
        i[0] *= f;
        i[1] *= f;
        i[2] *= f;
      }
      if (ns?.from && ns.to) {
        const run = s.inst;
        (s as { down: number }).down = Math.round(((s as { down: number }).down * ns.from) / ns.to);
        s.inst = Array.from({ length: ns.from }, (_, i) => [...run[runIndex(ns, i)]] as [number, number, number, number, number]);
      }
    }
  }
  return live;
}
