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
/** Token bucket bursts keep at least this many tokens (or the original burst when smaller) so Poisson jitter stays faithful. */
export const MIN_BURST = 32;
/** Max refill time (burst / ratePerSec) in seconds for the burst floor: slower or zero refill makes burst a total budget that must scale by 1/k. */
export const BURST_REFILL_MAX_S = 1;

/**
 * Events that directly change arrival rate (`spike`, `ramp`, `wave`, `cron`). Other events
 * (`down`, `region_down`, `slow`, `errors`, `shift`, `rollout`, `reshard`, `partition`, `pause`)
 * do not, so only the former disable the burst floor to prevent scaled runs from absorbing k× bursts.
 */
const SPIKE_EVENTS = new Set<ScenarioEvent['type']>(['spike', 'ramp', 'wave', 'cron']);

/** Slots per instance (threads, connections). */
const SLOTS = ['concurrency', 'connections'];
/** Per instance limits that follow the traffic each instance gets (÷ the node's slot factor). */
const PER_INSTANCE = ['queueLimit'];
/** Limits on totals across the node (÷ k). 0 keeps its meaning (off). */
const TOTALS = ['ratePerSec', 'maxConcurrent', 'minCalls', 'maxDepth', 'maxConcurrency', 'provisioned', 'scalePer10s'];
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
  /** Whether the scenario includes arrival-rate events (`SPIKE_EVENTS`). */
  hasSpikes: boolean;
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
 * Kinds that route by `keyBucket(req.key, ...)` (`cache` across instances; `database` / `sharded_db`
 * across shards). A hot key hits one instance/shard, so scaling must cut per-instance slots by `k`
 * first (down to `MIN_SLOTS`) before shrinking instances; trading fewer instances for more slots per
 * instance would give each hot bucket extra capacity and mask hot-key overload.
 */
const HASH_ROUTED_KINDS = new Set(['cache', 'database', 'sharded_db']);

/** Mirrors `EdgeRT.carries(op, api)` in sim.ts for LB traffic ops (`read` / `write`). */
function edgeCarries(e: Design['edges'][number], op: 'read' | 'write', api: string | undefined): boolean {
  const on = e.on ?? 'all';
  if (on === 'boot' || on === 'control') return false;
  if (api !== undefined && e.apis?.length && !e.apis.includes(api)) return false;
  return on === 'all' || on === op;
}

/**
 * Nodes that share an upstream instance selection pool (`load_balancer` via `lbBuild()`/`lbWeighted()`,
 * or `queue` via `consumers` when feeding 2+ distinct consumer nodes). Optimizing each target
 * independently would alter their relative instance counts or traffic share against single-entry
 * targets (`function`, `cache`, `database`, `sharded_db`, `queue`, etc.) in the same LB pool.
 */
function sharedPoolNodes(design: Design, kindOf: Map<string, string>): Set<string> {
  const shared = new Set<string>();
  const outByNode = new Map<string, Design['edges']>();
  for (const e of design.edges) {
    let list = outByNode.get(e.from);
    if (!list) outByNode.set(e.from, (list = []));
    list.push(e);
  }
  const lbContexts = design.apis?.length
    ? design.apis.map((a) => ({ op: a.op, api: a.name as string | undefined }))
    : [{ op: 'read' as const, api: undefined }, { op: 'write' as const, api: undefined }];

  for (const n of design.nodes) {
    const out = outByNode.get(n.id);
    if (!out?.length) continue;
    if (n.kind === 'load_balancer') {
      // Any (op, api) pool where 2+ distinct carrying targets share an upstream LB uses slots-first,
      // ignoring static edge weights (including 0 or unequal weights). A `shift` event can equalize
      // weights mid-run (`sim.ts:1642`), causing `lbWeighted()` to fall back to the shared-pool draw,
      // so initial weights cannot predict independence.
      for (const { op, api } of lbContexts) {
        const targets = new Set(out.filter((e) => edgeCarries(e, op, api)).map((e) => e.to));
        if (targets.size >= 2) for (const id of targets) shared.add(id);
      }
    } else if (n.kind === 'queue') {
      // setup() puts every non-function station's instances into qs.consumers (non-station targets have
      // no insts). Functions go to qs.fns and dispatch() only overflows to fns when ALL consumer slots
      // are busy, so a sole consumer worker + overflow function does not distort worker vs fn share.
      const consumers = new Set<string>();
      for (const e of out) {
        if (e.on === 'boot' || e.on === 'control') continue;
        const toKind = kindOf.get(e.to) ?? '';
        if (KINDS[toKind]?.station && toKind !== 'function') consumers.add(e.to);
      }
      if (consumers.size >= 2) for (const id of consumers) shared.add(id);
    }
  }
  return shared;
}

/**
 * Pick (instances, slots) factors for one node.
 * - For hash-routed kinds and nodes sharing a multi-node upstream pool (`slotsFirst`), keep the
 *   original slots-first rule: cut per-instance slots down to `MIN_SLOTS` before reducing
 *   instances. Known limitation (inherited from the original rule): when nodes sharing a pool have
 *   different slot counts that cross `MIN_SLOTS` differently (e.g. 20x40 and 20x64 at k = 2 ->
 *   13x32 and 20x32), slots-first scaling itself can still shift their instance ratio; also, designs
 *   with unequal LB weights and no `shift` event take the pre-fix slots-first path too, retaining
 *   the pre-fix capacity rounding error on those nodes.
 * - For nodes with their own selection pool, jointly pick integer (instances, slots) factors whose
 *   product stays as close to 1/k of total slots as possible. Known limitation: when instances do not
 *   divide evenly by k and slots hit the `MIN_SLOTS` or original-`slot` clamp (e.g. 33 instances at
 *   k = 2 -> 17), total capacity error can reach ~4-5% (bounded by 1 / (2 * MIN_INSTANCES)).
 */
function fitSlotScale(
  inst: number | undefined,
  slot: number | undefined,
  k: number,
  keepInst: boolean,
  slotsFirst = false,
): { slots: number; instances: number } {
  if (k <= 1 || slot === undefined) return { slots: 1, instances: k };
  if (slotsFirst) {
    const slots = Math.min(k, Math.max(1, slot / MIN_SLOTS));
    return { slots, instances: k / slots };
  }
  const minSlots = Math.min(slot, MIN_SLOTS);
  if (inst === undefined) {
    const s2 = Math.max(minSlots, Math.min(slot, Math.round(slot / k)));
    return { slots: slot / s2, instances: 1 };
  }
  const minInst = keepInst ? inst : Math.min(inst, MIN_INSTANCES);
  const orig = inst * slot;
  let bestInst = inst;
  let bestSlot = slot;
  let bestErr = Infinity;
  // Walk down from inst so exact or equal-error ties preserve more instances (cutting slots first).
  for (let i = inst; i >= minInst; i--) {
    const exact = orig / (k * i);
    for (const cand of [Math.floor(exact), Math.ceil(exact)]) {
      const s = Math.max(minSlots, Math.min(slot, cand));
      const err = Math.abs(i * s * k - orig);
      if (err < bestErr) {
        bestErr = err;
        bestInst = i;
        bestSlot = s;
      }
    }
  }
  return { slots: slot / bestSlot, instances: inst / bestInst };
}

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
  const sharedPool = sharedPoolNodes(design, kindOf);
  // keyed by node id: no prototype, so an id such as `constructor` finds nothing it should not
  const nodes: Record<string, NodeScale> = Object.create(null);
  for (const n of design.nodes) {
    const p = resolveParams(n.kind, n.params);
    const slot = SLOTS.map((s) => num(p[s])).find((v) => v !== undefined);
    const inst = num(p.instances);
    const ns: NodeScale = fitSlotScale(inst, slot, k, pinned.has(n.id), HASH_ROUTED_KINDS.has(n.kind) || sharedPool.has(n.id));
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
  const hasSpikes = events.some((ev) => SPIKE_EVENTS.has(ev.type));
  return { k, requested, maxK, hasSpikes, nodes };
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
    const burst = num(p.burst);
    if (burst) {
      const rate = num(p.ratePerSec) ?? 0;
      // Only floor burst when arrivals have no spike-like events and the bucket refills within
      // BURST_REFILL_MAX_S; under spikes or slow/zero refill, burst is a total budget and scales by 1/k.
      const keepFloor = !plan.hasSpikes && rate > 0 && burst / rate <= BURST_REFILL_MAX_S;
      const divK = Math.max(1, Math.round(burst / k));
      out.burst = keepFloor ? Math.max(Math.min(burst, MIN_BURST), divK) : divK;
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

/** Multiply the count fields of each entry of a map keyed by id (nodes, edges, APIs). The keys are
 *  ids, never compared with the field names: a node named `write` is a node, not a write count. */
function mulEach(map: unknown, k: number, keys: Set<string>, skip: Set<string>): void {
  if (!map || typeof map !== 'object') return;
  for (const v of Object.values(map as Record<string, unknown>)) if (v && typeof v === 'object' && !Array.isArray(v)) mulCounts(v as Record<string, unknown>, k, keys, skip);
}

const BOTH = new Set([...FLOW, ...NODE_QUEUE]);
/** Fields whose numbers are not counts even though their names match (latency summaries keep their ms). */
const KEEP = new Set(['latencyMs', 'asyncLatencyMs', 'theory', 'autoscale', 'function', 'scenario', 'scale']);
/** A function's counts: environments and cold starts follow the traffic (1/k of it ran). */
const FUNCTION_COUNTS = ['limit', 'provisioned', 'peakEnvs', 'endEnvs', 'coldStarts', 'throttles'] as const;

/** A window's counts at full size (in place; returns it). */
export function scaleWindow<W extends object>(w: W, k: number): W {
  if (k !== 1) {
    // the maps keyed by id, entry by entry; the rest by field name
    mulCounts(w as Record<string, unknown>, k, BOTH, new Set(['latency', 'nodes', 'edges']));
    const byId = w as { nodes?: unknown; edges?: unknown };
    mulEach(byId.nodes, k, BOTH, new Set(['latency']));
    mulEach(byId.edges, k, BOTH, new Set(['latency']));
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
    if (KEEP.has(key) || key === 'nodes' || key === 'bottleneck' || key === 'edges' || key === 'apis' || !v || typeof v !== 'object') continue;
    mulCounts(v as Record<string, unknown>, k, BOTH, KEEP);
  }
  // keyed by edge id and API name, entry by entry (an API named `write` is an API)
  mulEach(obj.edges, k, BOTH, KEEP);
  mulEach(obj.apis, k, BOTH, KEEP);
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
