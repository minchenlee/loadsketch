// Discrete-event simulation of a system design.
//
// Model (documented in docs/model.md):
// - Time is in milliseconds. Events are callbacks in a min-heap; ties run in insertion order.
// - A request is a call tree. Each hop crosses an edge (one-way network latency each direction).
// - "Station" components have instances; each instance has `slots` and a FIFO queue with a limit.
//   A request holds its slot while it waits for its own downstream calls (blocking, like a thread
//   pool). So a slow database fills the API server's slots too.
// - When a caller times out, the callee keeps working (wasted work). Retries add load.
// - Arrivals, request class, key and trace sampling use their own random streams, so two designs run
//   with the same scenario see the same traffic.

import { EventQueue } from './heap.ts';
import { Histogram, type LatencySummary } from './histogram.ts';
import { KeySampler, keyBucket, makeRng, sampleDuration, sampleExp, type Rng } from './rng.ts';
import { mgc } from './theory.ts';
import { ROLLOUT_KINDS, planScale, scaleDesign, scaleLive, scaleResult, scaleWindow, type ScalePlan } from './scale.ts';
import { getLang, t, tx } from '../i18n/index.ts';
import { KINDS, fanoutApplies, resolveParams, type Dist, type ResolvedParams } from '../schema/kinds.ts';
import {
  RESULT_SCHEMA,
  edgeId,
  edgeLatencyMs,
  INTER_REGION_MS,
  resolveScenario,
  type Design,
  type DesignEdge,
  type DesignNode,
  type ResolvedScenario,
  type Scenario,
} from '../schema/design.ts';

export type FailReason = 'timeout' | 'queue_full' | 'error' | 'rate_limited' | 'shed' | 'circuit_open' | 'down' | 'throttled' | 'bulkhead' | 'codel';
export const FAIL_REASONS: FailReason[] = ['timeout', 'queue_full', 'error', 'rate_limited', 'shed', 'circuit_open', 'down', 'throttled', 'bulkhead', 'codel'];
export const FAIL_LABEL: Record<FailReason, string> = {
  timeout: tx('逾時'),
  queue_full: tx('排隊滿了被拒'),
  error: tx('元件錯誤'),
  rate_limited: tx('被限流（429）'),
  shed: tx('降載丟掉（低優先級）'),
  circuit_open: tx('保險絲跳開'),
  down: tx('元件故障'),
  throttled: tx('呼叫端自我限流'),
  bulkhead: tx('隔艙已滿'),
  codel: tx('排隊太久被丟掉（CoDel）'),
};

const READ = 0;
const WRITE = 1;
const CACHE_SET = 2;
const CACHE_DEL = 3;
type Op = 0 | 1 | 2 | 3;

const STORE_KINDS = new Set(['database', 'sharded_db', 'object_storage']);
const isStoreCall = (s: Step): s is Extract<Step, { t: 'call' }> => s.t === 'call' && STORE_KINDS.has(s.edge.to.kind);
const isQueueCall = (s: Step): s is Extract<Step, { t: 'call' }> => s.t === 'call' && s.edge.to.kind === 'queue';

interface Outcome {
  ok: boolean;
  reason?: FailReason;
  hit?: boolean;
  /** Cache with leases: another request holds this key's lease; ask again after a short wait. */
  wait?: boolean;
  /** A call on the way failed and its caller answered with a fallback instead (degraded response). */
  degraded?: boolean;
  /** This hop's own call failed and its fallback answered (seen only by the node that sent it). */
  fellBack?: boolean;
  /** A reply between two regions: the edge it travels back over checks the partition again when it arrives. */
  cross?: [string, string];
}
type Done = (o: Outcome) => void;

export interface TraceHop {
  edge: string;
  from: string;
  to: string;
  op: 'read' | 'write' | 'cache_set' | 'cache_del';
  tSend: number;
  tArrive?: number;
  tStart?: number; // got a slot (stations only)
  tReply?: number; // reply sent back by the callee
  tDone?: number; // reply received (or timeout) at the caller
  ok?: boolean;
  reason?: FailReason;
  hit?: boolean;
  inst?: number;
}

export interface Trace {
  id: number;
  client: string;
  op: 'read' | 'write';
  /** The API the request called, when the design names its APIs. */
  api?: string;
  t0: number;
  t1: number;
  ok: boolean;
  reason?: FailReason;
  hops: TraceHop[];
}

interface Req {
  id: number;
  cls: 0 | 1;
  key: number;
  t0: number;
  settled: boolean;
  client: string;
  /** Priority from the client: 0 critical, 1 normal, 2 batch (sheddable). */
  pri: 0 | 1 | 2;
  /** Time (ms) when the client gives up, when the client propagates its deadline. */
  deadline?: number;
  trace?: TraceHop[];
  /** The API this request calls, when the design names its APIs. */
  api?: string;
  /** A write: when the database committed it. */
  committedAt?: number;
  /**
   * Called when a store commits this request's write (also after the caller timed out), with the
   * instance that holds the copy: a fan-out calls it once per copy, a retry again for the same copy.
   */
  onCommit?: (copy: Instance) => void;
  /** A fan-out store call: the copies that must commit for the write to count (its quorum). */
  need?: number;
  /** A read that follows the user's own write (scenario followReads): that write's commit time. */
  wroteAt?: number;
}

type FailCounts = Record<FailReason, number>;
const zeroFails = (): FailCounts => ({ timeout: 0, queue_full: 0, error: 0, rate_limited: 0, shed: 0, circuit_open: 0, down: 0, throttled: 0, bulkhead: 0, codel: 0 });
const opName = (op: Op): TraceHop['op'] => (op === READ ? 'read' : op === WRITE ? 'write' : op === CACHE_SET ? 'cache_set' : 'cache_del');

// ---------------------------------------------------------------------------------------------
// Runtime structures

interface Job {
  req: Req;
  op: Op;
  tq: number; // time queued
  ts: number; // time started
  dead: boolean;
  /** Slot already given back (cache read-through frees the slot before it answers). */
  released?: boolean;
  hop?: TraceHop;
  /** A database write sent to every copy (fan-out): this copy is the write, it is not replicated. */
  direct?: boolean;
  run: (job: Job, inst: Instance) => void;
  fail: (reason: FailReason) => void;
  /** Drop a job whose deadline passed before it started (the caller has already given up). */
  expire?: () => void;
  /** Database replication work: the replica's epoch when it was sent (a failover makes it stale). */
  replEpoch?: number;
}

class Deque<T> {
  private a: (T | undefined)[] = [];
  private h = 0;
  get length(): number {
    return this.a.length - this.h;
  }
  push(x: T): void {
    this.a.push(x);
  }
  shift(): T | undefined {
    if (this.h >= this.a.length) return undefined;
    const x = this.a[this.h];
    this.a[this.h++] = undefined;
    if (this.h > 1024 && this.h * 2 > this.a.length) {
      this.a = this.a.slice(this.h);
      this.h = 0;
    }
    return x;
  }
  peek(): T | undefined {
    return this.a[this.h];
  }
  /** Take the newest item (LIFO). */
  pop(): T | undefined {
    if (this.h >= this.a.length) return undefined;
    const x = this.a.pop();
    if (this.h >= this.a.length) {
      this.a = [];
      this.h = 0;
    }
    return x;
  }
  drain(): T[] {
    const out = this.a.slice(this.h) as T[];
    this.a = [];
    this.h = 0;
    return out;
  }
}

interface InstStats {
  /** Time this instance was provisioned (not off or booting), for autoscaled nodes. */
  up: number;
  started: number;
  waited: number; // jobs that had to queue
  waitSum: number;
  holdSum: number;
  holdSq: number;
  holds: number;
  busyArea: number;
  qArea: number;
  maxQ: number;
  rejected: number;
}
const zeroInst = (): InstStats => ({ up: 0, started: 0, waited: 0, waitSum: 0, holdSum: 0, holdSq: 0, holds: 0, busyArea: 0, qArea: 0, maxQ: 0, rejected: 0 });

/** Highest arrival rate the generator produces (requests per second). */
const MAX_RPS = 1_000_000;
const MAX_MULTIPLIER = 1e12;

type ScEvent = ResolvedScenario['events'][number];
type RateSeg = { t0: number; t1: number; lam: number; flat: boolean; step: number };
type CronEvent = Extract<ScEvent, { type: 'cron' }>;
/** [start, end) of an event's window in ms; end is Infinity for "until the end". */
const windowMs = (ev: { atS: number; forS?: number }): [number, number] => [ev.atS * 1000, ev.forS === undefined ? Infinity : (ev.atS + ev.forS) * 1000];
/** Start of cron burst k in ms. The segment cuts and eventFactor both use this, so they agree exactly. */
const cronStart = (ev: CronEvent, k: number): number => ev.atS * 1000 + k * ev.everyS * 1000;
const cronLenMs = (ev: CronEvent): number => (ev.burstS + (ev.jitterS ?? 0)) * 1000;
/**
 * Inside a burst, every client fires once within burstS + jitterS seconds. Jitter spreads the same
 * extra requests over a longer time, so the peak is lower: 1 + (m − 1) × burstS / (burstS + jitterS).
 */
const cronPeak = (ev: CronEvent): number => 1 + ((ev.multiplier - 1) * ev.burstS) / (ev.burstS + (ev.jitterS ?? 0));

/** Requests the scenario sends at full size: its rate integrated over the same segments the run uses. */
function expectedRequests(sc: ResolvedScenario): number {
  const durationMs = sc.durationS * 1000;
  let n = 0;
  for (const seg of rateSegments(sc, durationMs, MAX_RPS)) {
    const dt = seg.t1 - seg.t0;
    if (seg.flat) {
      n += (seg.lam * dt) / 1000;
      continue;
    }
    // a ramp or a wave: midpoints of steps short enough to follow it
    const k = Math.max(1, Math.ceil(dt / Math.min(seg.step, 1000)));
    for (let i = 0; i < k; i++) {
      const t = seg.t0 + ((i + 0.5) * dt) / k;
      let m = 1;
      for (const ev of sc.events) m = Math.min(MAX_MULTIPLIER, m * eventFactor(ev, t));
      n += (Math.min(MAX_RPS, sc.rps * m) * dt) / k / 1000;
    }
  }
  return n;
}

/** One traffic event's multiplier at time t (ms). */
function eventFactor(ev: ScEvent, t: number): number {
  if (ev.type === 'wave' || ev.type === 'cron') {
    const [w0, w1] = windowMs(ev);
    if (t < w0 || t >= w1) return 1;
    if (ev.type === 'wave') return 1 + ev.amplitude * Math.sin((2 * Math.PI * (t - w0)) / (ev.periodS * 1000));
    let k = Math.floor((t - w0) / (ev.everyS * 1000));
    if (cronStart(ev, k) > t) k--;
    if (cronStart(ev, k + 1) <= t) k++;
    return t < cronStart(ev, k) + cronLenMs(ev) ? cronPeak(ev) : 1;
  }
  const s = t / 1000;
  if (ev.type === 'spike') return s >= ev.atS && (ev.forS === undefined || s < ev.atS + ev.forS) ? ev.multiplier : 1;
  if (ev.type === 'ramp') {
    if (s < ev.atS) return 1;
    const f = ev.forS > 0 ? Math.min(1, (s - ev.atS) / ev.forS) : 1;
    return 1 + (ev.toMultiplier - 1) * f;
  }
  return 1;
}

/** A rollout in progress: the instances on the new version, and how their requests went since the last wave. */
interface RolloutRT {
  ok: number;
  fail: number;
}

class Instance {
  node: NodeRT;
  idx: number;
  slots: number;
  queueLimit: number;
  busy = 0;
  q = new Deque<Job>();
  /** Last time the queue was empty (CoDel, adaptive LIFO). */
  qEmptyAt = 0;
  down = false;
  /** Outages in progress (a down event, a region outage): down while above 0. */
  outages = 0;
  inflight = new Set<Job>();
  /** Jobs that gave their slot back early (cache read/write-through) and have not answered yet. */
  detached = new Set<Job>();
  lastT = 0;
  w: InstStats = zeroInst();
  tot: InstStats = zeroInst();
  lru: Map<number, number> | null = null;
  lruCap = 0;
  /** Cache, coalescing: keys being fetched from the store, and the callers waiting for each. */
  fills: Map<number, Done[]> | null = null;
  /** Cache, leases: key → time the lease expires. */
  leases: Map<number, number> | null = null;
  /** Queues this instance pulls messages from (workers). */
  pullFrom: QueueNodeState[] = [];
  /** The edge each queue in pullFrom delivers on (the first one, like consumers.find). */
  edgeFrom = new Map<QueueNodeState, EdgeRT>();
  /** Function: in the node's idle list; idle since (ms); a provisioned environment is never reclaimed. */
  inIdle = false;
  idleAt = 0;
  kept = false;
  /** Active connections from load balancers (for least_conn / p2c). */
  active = 0;
  role = ''; // 'primary' | 'replica' | 'shard-2 primary' ... for display
  /** Region the instance runs in (a database's replicas can be in another region than its primary). */
  region: string | undefined;
  /** Times it went down (a failover checks that the primary is still down from the same crash). */
  crashes = 0;
  /** Database: bumped when this instance stops following the old primary (failover); older replication work is ignored. */
  replEpoch = 0;
  /**
   * Database replica: writes of the primary it follows that it will never apply (it was down, its
   * queue was full, or the primary crashed before shipping them). A failover to it loses them.
   */
  missed = 0;
  /**
   * Autoscaling state. 'on' serves; 'boot' was launched and is not ready yet; 'retiring' takes no
   * new work and turns 'off' when it is idle; 'off' is not provisioned. Fixed nodes stay 'on'.
   */
  state: 'on' | 'off' | 'boot' | 'retiring' = 'on';
  /** Cold start: until this time (ms) the service time is longer, falling linearly to normal. */
  warmUntil = 0;
  /** Gray failure: this instance alone is slower, or fails more often, than the rest of its node. */
  slowEv = 1;
  errOverride: number | null = null;
  /** A rollout updated this instance to a new version: its slowdown and extra error rate. */
  rollout: RolloutRT | null = null;
  verSlow = 1;
  verErr = 0;
  /** Slowdown of this instance: a slow event times its version's. */
  /** Resharding: the copy to the new layout makes this instance slower while it runs. */
  copySlow = 1;
  get slow(): number {
    return this.slowEv * this.verSlow * this.copySlow;
  }
  /** Error rate of this instance: its own override (or the node's), and its version's on top. */
  errRate(nodeRate: number): number {
    const base = this.errOverride ?? nodeRate;
    return this.verErr > 0 ? 1 - (1 - base) * (1 - this.verErr) : base;
  }
  /** Busy slot-time and up time since the last autoscaling check. */
  sBusy = 0;
  sUp = 0;
  /**
   * Database replica: writes the primary has committed that this replica has not applied yet.
   * pending counts them per key (a read of such a key is stale); commits keeps their commit
   * times in commit order (the oldest gives the replication lag).
   */
  pending: Map<number, number> | null = null;
  commits: Map<number, number> | null = null;
  /**
   * Database replica, read-your-writes check: per key, the commit times of the primary's writes
   * this replica has not applied yet.
   */
  pendingAt: Map<number, number[]> | null = null;
  /** Database with row locks: key → writes waiting for that row's lock (present while it is held). */
  locks: Map<number, (() => void)[]> | null = null;
  /** Replication lag (ms): age of the oldest unapplied write, 0 when caught up. */
  lag(now: number): number {
    if (!this.commits || this.commits.size === 0) return 0;
    const first = this.commits.values().next().value as number;
    return now - first;
  }
  constructor(node: NodeRT, idx: number, slots: number, queueLimit: number) {
    this.node = node;
    this.idx = idx;
    this.slots = slots;
    this.queueLimit = queueLimit;
  }
  touch(now: number): void {
    const dt = now - this.lastT;
    if (dt > 0) {
      this.w.busyArea += this.busy * dt;
      this.w.qArea += this.q.length * dt;
      if (this.state === 'on' || this.state === 'retiring') this.w.up += dt;
      if (this.state === 'on') {
        this.sBusy += this.busy * dt;
        this.sUp += dt;
      }
      this.lastT = now;
    }
  }
  /** Can a router send new work here? */
  serving(): boolean {
    return !this.down && this.state === 'on';
  }
  load(): number {
    return this.busy + this.q.length;
  }
}

interface NodeStats {
  arrivals: number;
  ok: number;
  fail: number;
  origin: FailCounts; // failures this node produced itself
  hits: number;
  misses: number;
  enq: number;
  deq: number;
  depthArea: number;
  maxDepth: number;
  asyncOk: number;
  asyncFail: number;
  replApplied: number;
  replDropped: number;
  /** Jobs dropped before they started because their deadline had passed; queue: messages past their TTL. */
  expired: number;
  /** Queue (at-least-once): messages made visible again, done twice, and moved to the DLQ. */
  redelivered: number;
  duplicates: number;
  dlq: number;
  /** Database: reads served by a replica, those that missed a committed write, and the largest replica lag seen at a window end. */
  replicaReads: number;
  staleReads: number;
  maxLagMs: number;
  /** Cache: misses that waited for another request's fetch (coalescing), and lease "wait" answers. */
  coalesced: number;
  leaseWaits: number;
  /** Load balancer: instances its health check took out of rotation, and outlier ejections. */
  hcOut: number;
  ejections: number;
  /** Database failover: replicas promoted, and committed writes the new primary never received. */
  failovers: number;
  lostWrites: number;
  /** Database: writes that waited for a row lock; reads that missed the caller's own write; writes taken by an old primary cut off from the new one (split brain). */
  lockWaits: number;
  rywMisses: number;
  divergentWrites: number;
  /** A write to a store and a queue: one succeeded and the other did not (no outbox); messages the outbox relay sent again. */
  dualWriteGaps: number;
  outboxRetries: number;
  /** FIFO queue: messages that had to wait behind an earlier message of their group. */
  holBlocked: number;
  /** Function: new execution environments started (cold starts). */
  coldStarts: number;
}
const zeroNode = (): NodeStats => ({
  arrivals: 0, ok: 0, fail: 0, origin: zeroFails(), hits: 0, misses: 0, enq: 0, deq: 0, depthArea: 0, maxDepth: 0,
  asyncOk: 0, asyncFail: 0, replApplied: 0, replDropped: 0, expired: 0, redelivered: 0, duplicates: 0, dlq: 0,
  replicaReads: 0, staleReads: 0, maxLagMs: 0, coalesced: 0, leaseWaits: 0, hcOut: 0, ejections: 0, failovers: 0, lostWrites: 0,
  lockWaits: 0, rywMisses: 0, divergentWrites: 0, dualWriteGaps: 0, outboxRetries: 0, holBlocked: 0, coldStarts: 0,
});

interface EdgeStats {
  calls: number;
  read: number;
  write: number;
  ok: number;
  fail: number;
  retries: number;
  late: number; // replies that arrived after the caller gave up
  denied: number; // retries not made because the retry budget was used up
  throttled: number; // calls the caller rejected itself (adaptive throttling)
  bulkhead: number; // calls rejected because the caller's bulkhead for this edge was full
  fallbacks: number; // failed calls the caller answered with a fallback (degraded response)
  hedges: number; // second copies sent because the first had no reply after hedgeMs
  hedgeWins: number; // calls the hedge copy answered first
  connects: number; // new connections opened (connectMs > 0)
  attempts: number; // logical attempts (first tries and retries; a hedge copy is not one)
  copies: number; // fan-out: copies sent (each call sends `fanout` of them)
  crossRegion: number; // messages that went between two regions: copies that reached an instance in another region than the caller, and cache copies
}
/**
 * Share of failed attempts on an edge. `fail` counts each logical attempt once, so the denominator is
 * `attempts` (reported on hedged edges; a hedge copy is an extra call, not an attempt), else `calls`.
 * In one stats window an attempt can start in the window before the one where it fails: capped at 1.
 */
export const edgeFailShare = (e: { calls: number; fail: number; attempts?: number }): number => {
  const n = e.attempts ?? e.calls;
  if (n <= 0) return e.fail > 0 ? 1 : 0;
  return Math.min(1, e.fail / n);
};
const zeroEdge = (): EdgeStats => ({ calls: 0, read: 0, write: 0, ok: 0, fail: 0, retries: 0, late: 0, denied: 0, throttled: 0, bulkhead: 0, fallbacks: 0, hedges: 0, hedgeWins: 0, attempts: 0, copies: 0, crossRegion: 0, connects: 0 });

/** CoDel interval (Facebook, "Fail at Scale"): the queue must empty at least this often, ms. */
const CODEL_INTERVAL_MS = 100;

/** Adaptive throttling window, seconds (the SRE book uses 2 minutes; runs here are short). */
const THROTTLE_S = 10;
/** A sent call with no answer after this long counts as a request that was not accepted (yet). */
const THROTTLE_HUNG_MS = 5000;

/** Retry budget window, seconds (like Finagle's RetryBudget TTL). */
const BUDGET_S = 10;
/** A gradual traffic shift moves the weights this often, ms. */
const SHIFT_STEP_MS = 500;

class EdgeRT {
  id: string;
  from: NodeRT;
  to: NodeRT;
  on: 'all' | 'read' | 'write' | 'boot' | 'control';
  /** A boot or control edge: only the node's own boot or control calls take it, never requests. */
  side: boolean;
  /** Only requests to these APIs take this edge; null: every API. */
  apis: Set<string> | null;
  weight: number;
  latency: number;
  fromRegion: string | undefined;
  /** The latency comes from the regions (the edge has no latencyMs of its own). */
  regionLatency: boolean;
  /**
   * The target has instances in two regions (a database with replicaRegion): the edge carries only
   * the local latency, and the trip across regions is added once the instance is known.
   */
  perInstance: boolean;
  timeoutMs: number;
  retries: number;
  backoffMs: number;
  /** Retries allowed per first attempt over the last BUDGET_S seconds; 0 = no limit. */
  budget: number;
  budgetRing: { sec: number; first: number; retries: number }[] = [];
  /** Client-side adaptive throttling (Google SRE): K, 0 = off; requests and accepts per second. */
  throttleK: number;
  thrRing: { sec: number; req: number; acc: number }[] = [];
  /** Bulkhead: most calls in flight over this edge per caller instance (0 = no limit), and the count now. */
  bulkhead: number;
  inUse = new Map<Instance | null, number>();
  /** Fallback: a call that finally fails is answered by the caller with a degraded response. */
  fallback: boolean;
  /** Hedged reads: send a second copy when the first has no reply after this long (0 = off). */
  hedgeMs: number;
  /** Connections: handshake time of a new one (0 = not modelled), reuse, idle close; per caller instance the idle ones (the time each went idle). */
  connectMs: number;
  keepAlive: boolean;
  idleMs: number;
  idle = new Map<Instance | null, number[]>();
  /** Fan-out: copies per call (0 or 1: one), and how many must succeed (0: all). */
  fanout: number;
  quorum: number;
  rng: Rng;
  w: EdgeStats = zeroEdge();
  tot: EdgeStats = zeroEdge();
  constructor(e: DesignEdge, from: NodeRT, to: NodeRT, seed: number, interRegionMs: number) {
    this.id = edgeId(e);
    this.from = from;
    this.to = to;
    this.on = (e.on as EdgeRT['on']) ?? 'all';
    this.side = this.on === 'boot' || this.on === 'control';
    this.apis = e.apis?.length ? new Set(e.apis) : null;
    this.weight = (e.weight as number | undefined) ?? 1;
    this.latency = edgeLatencyMs(e as { latencyMs?: number }, from, to, interRegionMs);
    // the caller's region, for a database whose instances are in several regions
    this.fromRegion = from.kind !== 'client' ? from.region : undefined;
    this.regionLatency = e.latencyMs === undefined;
    this.perInstance = this.regionLatency && !!this.fromRegion && !!to.replicaRegion && to.replicaRegion !== to.region;
    if (this.perInstance) this.latency = edgeLatencyMs({}, from, { region: from.region }, interRegionMs);
    this.timeoutMs = (e.timeoutMs as number | undefined) ?? 0;
    this.retries = (e.retries as number | undefined) ?? 0;
    this.backoffMs = (e.backoffMs as number | undefined) ?? 50;
    this.budget = (e.retryBudget as number | undefined) ?? 0;
    if (this.budget > 0) this.budgetRing = Array.from({ length: BUDGET_S }, () => ({ sec: -1, first: 0, retries: 0 }));
    this.throttleK = (e.throttleK as number | undefined) ?? 0;
    if (this.throttleK > 0) this.thrRing = Array.from({ length: THROTTLE_S }, () => ({ sec: -1, req: 0, acc: 0 }));
    this.bulkhead = (e.bulkhead as number | undefined) ?? 0;
    // (a cache-aside lookup ignores it: a failed lookup already falls through to the store)
    this.fallback = e.fallback === 'on';
    this.hedgeMs = (e.hedgeMs as number | undefined) ?? 0;
    this.connectMs = (e.connectMs as number | undefined) ?? 0;
    this.keepAlive = e.keepAlive !== 'off';
    this.idleMs = ((e.idleS as number | undefined) ?? 60) * 1000;
    // fan-out needs a target with instances (or shards); hedging a fan-out is not modelled
    this.fanout = fanoutApplies(from.kind, to.kind) ? ((e.fanout as number | undefined) ?? 0) : 0;
    this.quorum = (e.quorum as number | undefined) ?? 0;
    if (this.fanout > 1) this.hedgeMs = 0;
    this.rng = makeRng(seed, `edge:${this.id}`);
  }
  private thrBucket(now: number): { sec: number; req: number; acc: number } {
    const sec = Math.floor(now / 1000);
    const b = this.thrRing[sec % THROTTLE_S];
    if (b.sec !== sec) {
      b.sec = sec;
      b.req = 0;
      b.acc = 0;
    }
    return b;
  }
  /**
   * Adaptive throttling: over the last THROTTLE_S seconds, reject locally with probability
   * max(0, (requests − K × accepts) / (requests + 1)). Every attempt counts as a request, also the
   * ones rejected here, so the rejection rate falls only when the backend accepts again.
   * A sent call is counted when its outcome is known (noteResult), so calls still in flight are
   * neither requests nor accepts: at the start of a run the window is not full of unanswered calls.
   * Returns true when this attempt must be rejected (it is then counted as a request).
   */
  throttle(now: number): boolean {
    if (this.throttleK <= 0) return false;
    const sec = Math.floor(now / 1000);
    let req = 0;
    let acc = 0;
    for (const b of this.thrRing) {
      if (b.sec > sec - THROTTLE_S && b.sec <= sec) {
        req += b.req;
        acc += b.acc;
      }
    }
    const p = Math.max(0, (req - this.throttleK * acc) / (req + 1));
    if (!(p > 0 && this.rng() < p)) return false;
    this.thrBucket(now).req++;
    return true;
  }
  /**
   * A sent call ended: count it as a request (unless noteHung already did), and as an accept when
   * it succeeded.
   */
  noteResult(now: number, ok: boolean, counted = false): void {
    if (this.throttleK <= 0) return;
    const b = this.thrBucket(now);
    if (!counted) b.req++;
    if (ok) b.acc++;
  }
  /** A sent call still has no answer after THROTTLE_HUNG_MS: count it as a request now (not accepted). */
  noteHung(now: number): void {
    this.thrBucket(now).req++;
  }
  /** Does this edge carry operation `op`? Cache fills ride read edges; invalidations ride write edges. */
  private bucket(now: number): { sec: number; first: number; retries: number } {
    const sec = Math.floor(now / 1000);
    const b = this.budgetRing[sec % BUDGET_S];
    if (b.sec !== sec) {
      b.sec = sec;
      b.first = 0;
      b.retries = 0;
    }
    return b;
  }
  /** Count a first attempt in the retry budget window. */
  noteFirst(now: number): void {
    if (this.budget > 0) this.bucket(now).first++;
  }
  /**
   * Reserve one retry from the budget, if there is one left. Returns the second it is charged to
   * (-1 when there is no budget). The caller moves it to the send second, or refunds it.
   */
  takeRetry(now: number): number | false {
    if (this.budget <= 0) return -1;
    const sec = Math.floor(now / 1000);
    let first = 0;
    let retries = 0;
    for (const b of this.budgetRing) {
      if (b.sec > sec - BUDGET_S && b.sec <= sec) {
        first += b.first;
        retries += b.retries;
      }
    }
    if (retries + 1 > this.budget * first) return false;
    this.bucket(now).retries++;
    return sec;
  }
  /** Give back a reserved retry that was never sent. */
  refundRetry(sec: number): void {
    if (sec < 0) return;
    const b = this.budgetRing[sec % BUDGET_S];
    if (b.sec === sec && b.retries > 0) b.retries--;
  }
  /** A reserved retry is sent now: charge it to the current second. */
  sendRetry(sec: number, now: number): void {
    if (sec < 0 || Math.floor(now / 1000) === sec) return;
    this.refundRetry(sec);
    this.bucket(now).retries++;
  }
  carries(op: Op, api?: string): boolean {
    if (this.side) return false;
    if (this.apis && api !== undefined && !this.apis.has(api)) return false;
    if (this.on === 'all') return true;
    if (this.on === 'read') return op === READ || op === CACHE_SET;
    return op === WRITE || op === CACHE_DEL;
  }
}

/** How a load balancer chooses the instance for each attempt and learns when it answered. */
interface Route {
  /** `avoid`: an instance not to pick if another one is available (a hedge goes to a different one). */
  pick: (avoid?: Instance | null) => Instance | null;
  settle: (inst: Instance | null) => void;
  /** The outcome of one call to `inst` (for passive health checking). */
  report?: (inst: Instance | null, o: Outcome) => void;
}

/** What a load balancer believes about one instance behind it. */
interface HcState {
  /** Active health check: in rotation. Consecutive failed and passed probes. */
  up: boolean;
  fails: number;
  passes: number;
  /** Outlier detection: consecutive failed replies, and ejected until this time (ms). */
  streak: number;
  ejectUntil: number;
}

type Step =
  | { t: 'call'; edge: EdgeRT }
  | { t: 'aside'; caches: EdgeRT[]; stores: EdgeRT[] }
  | { t: 'inval'; edge: EdgeRT };

/** A queue message. tEnq: first enqueued; tVis: last made visible (its wait starts here). */
interface QMsg {
  req: Req;
  op: Op;
  tEnq: number;
  tVis: number;
  receives: number;
  gen: number;
  acked: boolean;
  hidden: boolean;
  /** Ended as a failure (moved to the DLQ or expired): a late completion no longer counts. */
  dead: boolean;
  /** FIFO queue: the message group, and whether this message has let the next one of its group go. */
  grp?: number;
  freed?: boolean;
}

interface QueueNodeState {
  node: NodeRT;
  msgs: Deque<QMsg>;
  /** at-least-once: delivered messages that are neither deleted nor visible again */
  hidden: number;
  consumers: { inst: Instance; edge: EdgeRT }[];
  rr: number;
  lastT: number;
  /**
   * FIFO queue (0: standard): message groups. Only one message per group is in msgs or being
   * worked on; the rest of its group wait in parked until it ends (head-of-line blocking).
   */
  groups: number;
  busy: Set<number>;
  parked: Map<number, QMsg[]>;
  parkedN: number;
  /** Functions it feeds (event source mapping): their environments are not in consumers. */
  fns: NodeRT[];
}

/** Messages a queue holds and has not handed out: the deliverable ones and, in a FIFO queue, the ones parked behind their group. */
const qDepth = (qs: QueueNodeState): number => qs.msgs.length + qs.parkedN;

interface CbState {
  state: 'closed' | 'open' | 'half_open';
  gen: number;
  openUntil: number;
  ring: { sec: number; calls: number; fails: number }[];
  probes: number;
  probeOk: number;
  opens: number;
}

interface DnsTarget {
  /** In the DNS answer. */
  up: boolean;
  /** When the answer last changed for this target (ms; -Infinity: never). */
  since: number;
  /** Since when the checks have seen the opposite of `up` (null: they agree). */
  flip: number | null;
}

class NodeRT {
  id: string;
  kind: string;
  label: string;
  region: string | undefined;
  replicaRegion: string | undefined;
  /** Database: which instance of each shard is the primary now (offset in the shard; failover changes it). */
  prim: number[] = [];
  /** Sharded database: shards that hold keys now (a reshard changes it; instances exist for the most it will have). */
  shardsNow = 1;
  /**
   * Database, network partition: per shard, the old primary that a failover on the other side of
   * the cut replaced while it still runs (split brain), and the writes it took since.
   */
  zombie: ({ inst: Instance; writes: number } | null)[] = [];
  p: ResolvedParams;
  rng: Rng;
  out: EdgeRT[] = [];
  inc: EdgeRT[] = [];
  insts: Instance[] = [];
  w: NodeStats = zeroNode();
  tot: NodeStats = zeroNode();
  down = false;
  /** Outages in progress for the whole node: down while above 0. */
  outages = 0;
  /** Times the whole node went down (a request inside it when it failed is lost, even if it is back). */
  crashes = 0;
  slow = 1;
  errOverride: number | null = null;
  /** Periodic stop-the-world pauses: from t0 to t1 (ms), a pause of ms every `every` ms. */
  pauses: { t0: number; t1: number; every: number; ms: number }[] = [];
  rr = 0;
  /** Steps for a read and for a write, per API ('' when the design names no APIs). Built on first use. */
  plans = new Map<string, Step[][]>();
  queue: QueueNodeState | null = null;
  cb: CbState | null = null;
  /** Rate limiter: one bucket for all requests, or one per client (tenant). */
  buckets = new Map<string, { tokens: number; last: number; inflight: number }>();
  /** Client: the APIs it calls (those its edges carry), with cumulative shares (0..1]. */
  apiMix: { api: Simulation['apis'][number]; cum: number }[] = [];
  /** Client: priority of the requests it sends (0 critical, 1 normal, 2 batch). */
  pri: 0 | 1 | 2 = 1;
  /** Cache: it has an edge to another cache (cross-region replication of its sets and deletes). */
  replicates = false;
  /** Load balancer: the targets for a read and for a write, per API (as plans). */
  lbSets = new Map<string, { edge: EdgeRT; inst: Instance | null }[][]>();
  /** DNS failover: what the health check believes about each target, and when the answer last changed. */
  dns = new Map<EdgeRT, DnsTarget>();
  /** Load balancer: its view of each instance behind it (health checks, outlier ejection). */
  hc = new Map<Instance, HcState>();
  hcRng: Rng;
  /** Autoscaling: on, and counters for the result. */
  auto = false;
  scaleT = 0;
  launches = 0;
  /** Autoscaling: boots that failed because a call on a boot edge failed (the instance tries again). */
  bootFails = 0;
  /** Control edges: the controller cannot see its metrics now, and how many checks it skipped. */
  blind = false;
  blindChecks = 0;
  /** Divergent writes committed after the heal, not yet in the timeline. */
  lateDiv = 0;
  /** A write here went to a store and a queue (a dual write, or an outbox when it is on). */
  dualWrite = false;
  /** Autoscaling: [time, desired] from each check in the scale-down window (Kubernetes HPA stabilization). */
  scaleRecs: [number, number][] = [];
  /** First entry of scaleRecs still in use (older ones left the window). */
  scaleHead = 0;
  retires = 0;
  peakActive = 0;
  /**
   * Function (Lambda): idle environments (most recent last: it is reused first, the others age out),
   * reclaimed ones to reuse, environments not off, the most at once, the scaling-rate bucket, and
   * the queues that feed it (with the environments booting for each, so one message starts one).
   */
  fnIdle: Instance[] = [];
  fnOff: Instance[] = [];
  fnLive = 0;
  fnPeak = 0;
  fnTokens = 0;
  fnTokT = 0;
  fnSweep = false;
  fnQueues: { qs: QueueNodeState; edge: EdgeRT; booting: number; retry?: boolean }[] = [];
  /** Instances measured over the time they were up (autoscaling, function environments). */
  get elastic(): boolean {
    return this.auto || this.kind === 'function';
  }
  constructor(n: DesignNode, seed: number) {
    this.id = n.id;
    this.kind = n.kind;
    this.label = n.label ?? (KINDS[n.kind] ? t(KINDS[n.kind].label) : n.id);
    this.region = n.region;
    this.replicaRegion = n.replicaRegion;
    this.p = resolveParams(n.kind, n.params as Record<string, unknown> | undefined);
    this.rng = makeRng(seed, `node:${n.id}`);
    this.hcRng = makeRng(seed, `hc:${n.id}`);
  }
  num(k: string): number {
    return this.p[k] as number;
  }
  str(k: string): string {
    return this.p[k] as string;
  }
  dist(k: string): Dist {
    return this.p[k] as Dist;
  }
  errorRate(): number {
    return this.errOverride ?? ((this.p.errorRate as number | undefined) ?? 0);
  }
}

// ---------------------------------------------------------------------------------------------
// Public result types

export interface NodeWindow {
  arrivals: number;
  ok: number;
  fail: number;
  util?: number; // average busy share across instances, 0..1
  maxUtil?: number; // busiest instance
  queue?: number; // average total queued (all instances)
  waitMs?: number;
  instUtil?: number[];
  hitRatio?: number;
  depth?: number; // queue node: average depth
  lagMs?: number; // queue node: age of the oldest message at window end
  cb?: 'closed' | 'open' | 'half_open';
  /** Autoscaled node: instances serving at window end, and instances booting. */
  active?: number;
  booting?: number;
  /** Jobs dropped in this window because their deadline had passed; queue: messages past their TTL. */
  expired?: number;
  /** Queue (at-least-once) in this window. */
  redelivered?: number;
  duplicates?: number;
  dlq?: number;
  /** Database with replicas: largest replica lag at window end (ms), and stale replica reads in this window. */
  replLagMs?: number;
  staleReads?: number;
}

export interface WindowStat {
  t: number; // window end, seconds
  dt: number;
  /** Inside the measured interval [measureFromMs, measureToMs), decided on exact times (t is rounded). */
  measured: boolean;
  targetRps: number;
  offered: number;
  ok: number;
  fail: FailCounts;
  latency: { count: number; mean: number; p50: number; p95: number; p99: number };
  asyncDone: number;
  asyncP99: number;
  /** With a fallback on some edge: successful requests that got a degraded response. */
  degraded?: number;
  nodes: Record<string, NodeWindow>;
  edges: Record<string, { calls: number; read: number; write: number; fail: number; retries: number; denied?: number; throttled?: number; bulkhead?: number; fallbacks?: number; hedges?: number; hedgeWins?: number; attempts?: number; copies?: number; crossRegion?: number; connects?: number }>;
}

export interface LiveNode {
  busy: number;
  slots: number;
  queued: number;
  /** Instances down (or 1 for a node without instances that is down). */
  down: number;
  /**
   * Per instance [busy, slots, queued, down, state] when there is more than one.
   * state: 0 serving, 1 off, 2 booting, 3 warming up (cold), 4 retiring.
   */
  inst?: [number, number, number, number, number][];
  cb?: 'closed' | 'open' | 'half_open';
  depth?: number;
}

export interface TimelineEvent {
  t: number; // seconds
  node?: string;
  type: string;
  text: string;
  /** A divergence entry: the writes it reports. */
  count?: number;
}

export interface NodeResult {
  kind: string;
  label: string;
  arrivals: number;
  rps: number;
  ok: number;
  fail: number;
  origin: FailCounts;
  utilization?: number;
  maxInstanceUtilization?: number;
  avgQueue?: number;
  maxQueue?: number;
  waitMs?: number;
  holdMs?: number;
  holdCv?: number;
  hitRatio?: number;
  /** Cache: misses that waited for another request's fetch instead of reading the store (coalescing). */
  coalesced?: number;
  /** Cache with leases: times a caller was told to wait and ask again. */
  leaseWaits?: number;
  /** Load balancer: times its health check took an instance out of rotation, and outlier ejections. */
  hcRemoved?: number;
  /** Control edges: checks the controller skipped because it could not see its metrics. */
  blindChecks?: number;
  ejections?: number;
  queueDepthAvg?: number;
  queueDepthEnd?: number;
  queueDepthMax?: number;
  asyncOk?: number;
  asyncFail?: number;
  replicationApplied?: number;
  replicationDropped?: number;
  /** Database with failover: replicas promoted to primary, and committed writes lost by it (async replication). */
  failovers?: number;
  lostWrites?: number;
  /** Database with row locks: writes that waited for a lock. */
  lockWaits?: number;
  /** Database with replicas, scenario followReads: reads after the user's own write that did not see it. */
  rywMisses?: number;
  /** Database with failover, network partition: writes the old primary took after a new one was promoted (they diverge). */
  divergentWrites?: number;
  /** Writes to a store and a queue: one succeeded and the other did not; with an outbox, messages the relay sent again. */
  dualWriteGaps?: number;
  outboxRetries?: number;
  /** FIFO queue: messages that waited behind an earlier message of their group (head-of-line blocking). */
  holBlocked?: number;
  /** Database with replicas: reads served by a replica, those that returned old data, and the largest lag seen. */
  replicaReads?: number;
  staleReads?: number;
  maxReplLagMs?: number;
  circuitOpens?: number;
  /** Busiest measured window: its utilisation (busiest instance), end time and average queue. */
  peakUtilization?: number;
  peakAtS?: number;
  peakQueue?: number;
  instances?: { idx: number; role: string; utilization: number; avgQueue: number; started: number; waitMs: number; theory?: TheoryRow }[];
  theory?: TheoryRow;
  /** Jobs dropped before they started because their deadline had passed (deadline propagation); queue: messages past their TTL. */
  expired?: number;
  /** Queue (at-least-once): messages made visible again, processed twice, and moved to the dead-letter queue. */
  redelivered?: number;
  duplicates?: number;
  dlq?: number;
  autoscale?: { min: number; max: number; peakActive: number; endActive: number; launches: number; retires: number; bootFails?: number };
  /** Function: the concurrency limit, environments at most and at the end, cold starts and throttled requests (429). */
  function?: { limit: number; provisioned: number; peakEnvs: number; endEnvs: number; coldStarts: number; throttles: number };
}

export interface TheoryRow {
  model: string;
  servers: number;
  lambdaPerSec: number;
  meanHoldMs: number;
  rho: number;
  pWait: number;
  waitMs: number | null; // null = unstable (ρ ≥ 1)
  simWaitMs: number;
  simPWait: number;
  note?: string;
}

export interface SimResult {
  schema: typeof RESULT_SCHEMA;
  design: string;
  scenario: { name: string; seed: number; durationS: number; warmupS: number; rps: number; readRatio: number; clientTimeoutMs: number };
  measuredFromS: number;
  measuredS: number;
  /** End of the measured interval, seconds, exact (measuredS is rounded to 1 ms). */
  measuredToS: number;
  simulatedS: number;
  events: number;
  truncated: boolean;
  /** Jobs still running or waiting when the run stopped (background work: queue messages, replication, retries after the user gave up). */
  unfinished: number;
  summary: {
    offered: number;
    ok: number;
    fail: FailCounts;
    errorRate: number;
    throughputRps: number;
    latencyMs: LatencySummary;
    asyncLatencyMs: LatencySummary;
    /** With a fallback on some edge: successful requests (in `ok`) that got a degraded response. */
    degraded?: number;
  };
  bottleneck: {
    node: string;
    label: string;
    instance?: number;
    /** Average utilisation of the busiest instance over the measured time. */
    utilization: number;
    peakUtilization: number;
    peakAtS: number;
    avgQueue: number;
    why: string;
  } | null;
  /** Per API, when the design names its APIs: requests sent in the measured time and how they ended. */
  apis?: Record<string, { op: 'read' | 'write'; offered: number; ok: number; fail: number; errorRate: number; latencyMs: LatencySummary }>;
  nodes: Record<string, NodeResult>;
  edges: Record<string, { from: string; to: string; calls: number; rps: number; ok: number; fail: number; retries: number; late: number; denied?: number; throttled?: number; bulkhead?: number; fallbacks?: number; hedges?: number; hedgeWins?: number; attempts?: number; copies?: number; crossRegion?: number; connects?: number }>;
  timeline: TimelineEvent[];
  /** Simulated at 1/scale of the traffic and capacity; the counts here are multiplied back (absent: full size). */
  scale?: number;
}

export interface SimOptions {
  /** Target number of sampled request traces per simulated second (default 40). */
  tracesPerSec?: number;
  /** Stop after this many events (default 300 million). */
  maxEvents?: number;
  /** Keep at most this many traces in memory (default 400). */
  maxTraces?: number;
}

// ---------------------------------------------------------------------------------------------

/** Arrival-rate segments: cut at every event edge; `lam` is the rate (or its upper bound where it varies). */
function rateSegments(sc: ResolvedScenario, durationMs: number, maxRps: number): RateSeg[] {
  const segs: RateSeg[] = [];
  const cuts = new Set<number>([0, durationMs]);
  const cut = (ms: number) => {
    if (ms > 0 && ms < durationMs) cuts.add(ms);
  };
  for (const ev of sc.events) {
    if (ev.type === 'spike' || ev.type === 'ramp') {
      for (const s of [ev.atS, ev.forS === undefined ? undefined : ev.atS + ev.forS]) {
        if (s !== undefined) cut(s * 1000);
      }
    } else if (ev.type === 'wave' || ev.type === 'cron') {
      const [w0, w1] = windowMs(ev);
      cut(w0);
      cut(w1);
      if (ev.type === 'cron') {
        for (let k = 0; cronStart(ev, k) < Math.min(w1, durationMs); k++) {
          cut(cronStart(ev, k));
          cut(Math.min(w1, cronStart(ev, k) + cronLenMs(ev)));
        }
      }
    }
  }
  const pts = [...cuts].sort((a, b) => a - b);
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    let m = 1;
    let flat = true;
    let step = Infinity; // longest integration step that still follows every active wave
    for (const ev of sc.events) {
      // A spike or a cron burst is constant inside a segment (segments are cut at its edges): take the midpoint.
      // A ramp is linear inside a segment and continuous up to its end: take both ends.
      // A wave inside its window is at most 1 + amplitude.
      let f: number;
      if (ev.type === 'ramp') {
        f = Math.max(eventFactor(ev, a), eventFactor(ev, b));
        if (eventFactor(ev, a) !== eventFactor(ev, b)) flat = false;
      } else if (ev.type === 'wave') {
        const [w0, w1] = windowMs(ev);
        const on = (a + b) / 2 >= w0 && (a + b) / 2 < w1;
        f = on ? 1 + ev.amplitude : 1;
        if (on && ev.amplitude !== 0) {
          flat = false;
          step = Math.min(step, (ev.periodS * 1000) / 64);
        }
      } else f = eventFactor(ev, (a + b) / 2);
      m = Math.min(MAX_MULTIPLIER, m * f);
    }
    segs.push({ t0: a, t1: b, lam: Math.min(maxRps, sc.rps * m), flat, step });
  }
  return segs;
}

export class Simulation {
  readonly design: Design;
  readonly sc: ResolvedScenario;
  now = 0;
  events = 0;
  /** Calls and replies on the wire, and retries waiting to go. */
  private pending = 0;
  done = false;
  truncated = false;
  readonly durationMs: number;
  readonly endMs: number;
  readonly windowMs: number;
  readonly measureFromMs: number;
  /** Rates and utilisation are measured over [measureFromMs, measureToMs): traffic time after warm-up. */
  readonly measureToMs: number;

  private q = new EventQueue();
  private nodes: NodeRT[] = [];
  private byId = new Map<string, NodeRT>();
  private edges: EdgeRT[] = [];
  private clients: NodeRT[] = [];
  private clientWeights: number[] = [];
  private rArr: Rng;
  private rCls: Rng;
  private rKey: Rng;
  private rClient: Rng;
  private rSample: Rng;
  private rFollow: Rng;
  private keys: KeySampler;
  private sampleP: number;
  private maxEvents: number;
  private maxTraces: number;
  private nextReqId = 1;
  /** Sequence number for replicated writes (orders a replica's pending commits). */
  private nextCommit = 1;
  /** Arrival-rate bounds per time segment (between traffic event edges), for Poisson thinning. */
  /** `lam` bounds the rate in the segment; when `flat`, the rate is exactly `lam` throughout. */
  private rateSegs: RateSeg[] = [];
  /** MAX_RPS at the simulated scale (divided by k). */
  private maxRps = MAX_RPS;
  private rateSeg = 0;
  /** Constant arrivals in a flat segment: the segment index, and the area (in requests) from its start to the next arrival. */
  private flatSeg = -1;
  private flatArea = 0;

  private g = { offered: 0, ok: 0, fail: zeroFails(), asyncDone: 0, degraded: 0 };
  /** Some edge answers failures with a fallback (then results report degraded responses). */
  private anyFallback = false;
  private gTot = { offered: 0, ok: 0, fail: zeroFails(), degraded: 0 };
  private hist = new Histogram();
  /** The design's APIs (share above 0) and their measured totals. */
  apis: { name: string; op: 0 | 1; share: number; offered: number; ok: number; fail: number; hist: Histogram }[] = [];
  private whist = new Histogram();
  private asyncHist = new Histogram();
  private wAsyncHist = new Histogram();
  private windowStart = 0;
  private windows: WindowStat[] = [];
  private windowsRead = 0;
  private traces: Trace[] = [];
  private tracesRead = 0;
  private timeline: TimelineEvent[] = [];
  /** One-way latency between two regions, ms. */
  private interRegionMs: number;
  /** Network partitions in progress: region pair → how many (they can overlap). */
  private cuts = new Map<string, number>();
  /** The scenario has a partition: replies are checked against the cuts on the way back. */
  private anyPartition = false;
  /** Scale factor k and how each node was cut (k = 1: full size). */
  readonly scalePlan: ScalePlan;

  /** Each client calls the APIs its edges with a positive weight carry, by their shares (none: no API). */
  private buildApiMix(): void {
    for (const c of this.clients) {
      // an API is usable from this client when an edge with a positive weight carries it (what pickEdge takes)
      const list = this.apis.filter((a) => c.out.some((e) => e.weight > 0 && e.carries(a.op, a.name)));
      const total = list.reduce((t, a) => t + a.share, 0);
      let cum = 0;
      c.apiMix = list.map((api) => ({ api, cum: (cum += api.share / total) }));
    }
  }

  constructor(design: Design, scenario: Scenario, opts: SimOptions = {}) {
    this.sc = resolveScenario(scenario);
    // Q3: a long or busy run simulates 1/k of the traffic on 1/k of the capacity
    this.scalePlan = planScale(design, expectedRequests(this.sc), scenario.scale ?? 'auto', this.sc.events);
    design = scaleDesign(design, this.scalePlan);
    this.sc.rps /= this.scalePlan.k;
    this.maxRps = MAX_RPS / this.scalePlan.k;
    this.design = design;
    this.interRegionMs = design.interRegionMs ?? INTER_REGION_MS;
    const seed = this.sc.seed;
    this.durationMs = this.sc.durationS * 1000;
    this.endMs = this.durationMs + this.sc.clientTimeoutMs + 1;
    this.windowMs = this.sc.windowS * 1000;
    this.measureFromMs = Math.ceil((this.sc.warmupS * 1000) / this.windowMs - 1e-9) * this.windowMs;
    this.measureToMs = Math.max(this.measureFromMs + this.windowMs, Math.floor(this.durationMs / this.windowMs + 1e-9) * this.windowMs);
    this.rArr = makeRng(seed, 'arrivals');
    this.rCls = makeRng(seed, 'class');
    this.rKey = makeRng(seed, 'key');
    this.rClient = makeRng(seed, 'client');
    this.rSample = makeRng(seed, 'sample');
    this.rFollow = makeRng(seed, 'follow');
    this.keys = new KeySampler(this.sc.keyCount, this.sc.zipf);
    for (const x of design.apis ?? []) {
      if ((x.share ?? 1) > 0) this.apis.push({ name: x.name, op: x.op === 'write' ? WRITE : READ, share: x.share ?? 1, offered: 0, ok: 0, fail: 0, hist: new Histogram() });
    }
    this.maxEvents = opts.maxEvents ?? 300_000_000;
    this.maxTraces = opts.maxTraces ?? 400;
    this.sampleP = this.sc.rps > 0 ? Math.min(1, (opts.tracesPerSec ?? 40) / this.sc.rps) : 0;

    this.build(seed);
    this.buildApiMix();
    this.buildRateSegments();
    this.scheduleEvents();
    for (const n of this.nodes) {
      if (n.kind === 'load_balancer') this.scheduleHealthChecks(n);
      if (n.kind === 'dns' && n.str('failover') === 'on') this.scheduleDnsChecks(n);
      if (!n.auto) continue;
      n.peakActive = n.num('instances');
      this.scheduleScale(n);
    }
    this.at(this.windowMs, () => this.flushWindow());
    this.scheduleArrival(0);
  }

  // -------------------------------------------------------------------------------------------
  // Build

  private build(seed: number): void {
    for (const n of this.design.nodes) {
      const rt = new NodeRT(n, seed);
      this.nodes.push(rt);
      this.byId.set(rt.id, rt);
      this.makeInstances(rt);
      if (rt.kind === 'client') {
        this.clients.push(rt);
        this.clientWeights.push(rt.num('weight'));
      }
      if (rt.kind === 'queue') {
        const groups = rt.str('ordering') === 'fifo' ? Math.max(1, rt.num('groups')) : 0;
        rt.queue = { node: rt, msgs: new Deque(), hidden: 0, consumers: [], rr: 0, lastT: 0, groups, busy: new Set(), parked: new Map(), parkedN: 0, fns: [] };
      }
      if (rt.kind === 'circuit_breaker') {
        const size = Math.max(1, Math.ceil(rt.num('windowS')));
        rt.cb = { state: 'closed', gen: 0, openUntil: 0, ring: Array.from({ length: size }, () => ({ sec: -1, calls: 0, fails: 0 })), probes: 0, probeOk: 0, opens: 0 };
      }
      if (rt.kind === 'client') rt.pri = rt.str('priority') === 'critical' ? 0 : rt.str('priority') === 'batch' ? 2 : 1;
    }
    for (const e of this.design.edges as DesignEdge[]) {
      const from = this.byId.get(e.from)!;
      const to = this.byId.get(e.to)!;
      const rt = new EdgeRT(e, from, to, seed, this.interRegionMs);
      this.edges.push(rt);
      if (rt.fallback) this.anyFallback = true;
      from.out.push(rt);
      if (from.kind === 'cache' && to.kind === 'cache' && !rt.side) from.replicates = true;
      to.inc.push(rt);
    }
    for (const n of this.nodes) {
      if (n.queue) {
        for (const e of n.out) {
          if (e.side) continue;
          // a function's environments come and go: they join when they start (fnEnv())
          if (e.to.kind === 'function') {
            e.to.fnQueues.push({ qs: n.queue, edge: e, booting: 0 });
            if (!n.queue.fns.includes(e.to)) n.queue.fns.push(e.to);
            for (const inst of e.to.insts) this.fnConsume(inst, n.queue, e);
            continue;
          }
          for (const inst of e.to.insts) {
            n.queue.consumers.push({ inst, edge: e });
            inst.pullFrom.push(n.queue);
            if (!inst.edgeFrom.has(n.queue)) inst.edgeFrom.set(n.queue, e);
          }
        }
      }
    }
  }

  private makeInstances(n: NodeRT): void {
    const spec = KINDS[n.kind];
    if (!spec.station) return;
    if (n.kind === 'function') {
      // only the provisioned environments now; the others start when a request needs one (fnLaunch())
      n.fnTokens = n.num('scalePer10s');
      const keep = Math.min(n.num('provisioned'), n.num('maxConcurrency'));
      for (let i = 0; i < keep; i++) {
        const inst = this.fnEnv(n);
        inst.state = 'on';
        inst.kept = true;
        n.fnLive++;
        this.fnIdleNow(inst);
      }
      n.fnPeak = n.fnLive;
      return;
    }
    if (n.kind === 'database' || n.kind === 'sharded_db') {
      n.shardsNow = n.kind === 'sharded_db' ? n.num('shards') : 1;
      // a reshard needs the new shards' instances from the start (they hold no keys until the cutover)
      let shards = n.shardsNow;
      for (const ev of this.sc.events) if (ev.type === 'reshard' && ev.node === n.id) shards = Math.max(shards, ev.toShards);
      const per = 1 + n.num('replicas');
      for (let s = 0; s < shards; s++) {
        n.prim.push(0);
        for (let r = 0; r < per; r++) {
          const inst = new Instance(n, n.insts.length, n.num('connections'), n.num('queueLimit'));
          const role = r === 0 ? t('主庫') : t('副本 {r}', { r });
          inst.role = shards > 1 ? t('分片 {s} {role}', { s, role }) : role;
          // the first localReplicas replicas stay with the primary; the others are in replicaRegion
          inst.region = r <= n.num('localReplicas') ? n.region : (n.replicaRegion ?? n.region);
          // every instance of a replicated shard can become a replica (after a failover)
          if (per > 1) {
            inst.pending = new Map();
            inst.commits = new Map();
            inst.pendingAt = new Map();
          }
          if (n.str('locks') === 'row') inst.locks = new Map();
          n.insts.push(inst);
        }
      }
      return;
    }
    const base = n.kind === 'object_storage' ? 1 : n.num('instances');
    n.auto = n.p.autoscale === 'on';
    // an autoscaled node gets all its possible instances now; the ones above the minimum start off
    const count = n.auto ? Math.max(base, n.num('maxInstances')) : base;
    for (let i = 0; i < count; i++) {
      const inst = new Instance(n, i, n.num('concurrency'), n.num('queueLimit'));
      if (i >= base) inst.state = 'off';
      inst.role = count > 1 ? `#${i}` : '';
      inst.region = n.region;
      if (n.kind === 'cache' && n.str('mode') === 'lru') {
        inst.lru = new Map();
        inst.lruCap = Math.max(1, Math.ceil(n.num('capacityKeys') / count));
        if (n.str('stampede') === 'coalesce') inst.fills = new Map();
        if (n.str('stampede') === 'lease') inst.leases = new Map();
      }
      n.insts.push(inst);
    }
  }

  /** The steps a plan node runs for this request: by read or write, and by API. */
  private plan(n: NodeRT, op: Op, api: string | undefined): Step[] {
    let p = n.plans.get(api ?? '');
    if (!p) n.plans.set(api ?? '', (p = [this.buildPlan(n, READ, api), this.buildPlan(n, WRITE, api)]));
    return p[op === WRITE ? 1 : 0];
  }

  private buildPlan(n: NodeRT, op: Op, api: string | undefined): Step[] {
    const edges = n.out.filter((e) => e.carries(op, api) && e.to.kind !== 'client');
    const caches = edges.filter((e) => e.to.kind === 'cache');
    // A rate limiter that only guards stores (a provisioned DynamoDB table) is a store
    // for cache-aside and invalidation; it forwards the op unchanged.
    const isStore = (e: EdgeRT) => STORE_KINDS.has(e.to.kind) || (e.to.kind === 'rate_limiter' && e.to.out.some((x) => x.to.kind !== 'client') && e.to.out.every((x) => x.to.kind === 'client' || STORE_KINDS.has(x.to.kind)));
    const stores = edges.filter(isStore);
    const others = edges.filter((e) => e.to.kind !== 'cache' && !isStore(e));
    const steps: Step[] = [];
    if (n.kind === 'cache') {
      // read-through / write-through cache: only stores are called, by the cache logic itself
      return stores.map((edge) => ({ t: 'call', edge }));
    }
    if (op === READ) {
      if (caches.length && stores.length) steps.push({ t: 'aside', caches, stores });
      else for (const edge of [...caches, ...stores]) steps.push({ t: 'call', edge });
    } else {
      for (const edge of stores) steps.push({ t: 'call', edge });
      if (stores.length) for (const edge of caches) steps.push({ t: 'inval', edge });
      else for (const edge of caches) steps.push({ t: 'call', edge });
    }
    for (const edge of others) steps.push({ t: 'call', edge });
    return steps;
  }

  /**
   * Weights on a load balancer's edges (a canary, blue-green): an edge with weight 0 gets nothing.
   * When the weights differ, an edge is picked first by weight, among the edges with a healthy
   * target (none healthy: among all), and the policy picks among that edge's targets. Equal
   * weights: one pool of every target, as before (no random draw is added).
   */
  private lbWeighted(n: NodeRT, all: { edge: EdgeRT; inst: Instance | null }[]): { edge: EdgeRT; inst: Instance | null }[] {
    if (!all.length) return all;
    const w0 = all[0].edge.weight;
    if (all.every((x) => x.edge.weight === w0)) return w0 > 0 ? all : [];
    const edges = [...new Set(all.filter((x) => x.edge.weight > 0).map((x) => x.edge))];
    if (edges.length <= 1) return edges.length ? all.filter((x) => x.edge === edges[0]) : [];
    const up = edges.filter((e) => all.some((x) => x.edge === e && this.healthy(n, x)));
    const pool = up.length ? up : edges;
    const total = pool.reduce((a, e) => a + e.weight, 0);
    let u = n.rng() * total;
    let pick = pool[pool.length - 1];
    for (const e of pool) {
      u -= e.weight;
      if (u < 0) {
        pick = e;
        break;
      }
    }
    return all.filter((x) => x.edge === pick);
  }

  private lbTargets(n: NodeRT, op: Op, api: string | undefined): { edge: EdgeRT; inst: Instance | null }[] {
    let p = n.lbSets.get(api ?? '');
    if (!p) n.lbSets.set(api ?? '', (p = [this.lbBuild(n, READ, api), this.lbBuild(n, WRITE, api)]));
    return p[op === WRITE ? 1 : 0];
  }

  private lbBuild(n: NodeRT, op: Op, api: string | undefined): { edge: EdgeRT; inst: Instance | null }[] {
    const out: { edge: EdgeRT; inst: Instance | null }[] = [];
    for (const e of n.out) {
      if (!e.carries(op, api)) continue;
      const t = e.to;
      // a function picks its own environment (warm or new): the balancer sends to the node
      if (t.insts.length && t.kind !== 'database' && t.kind !== 'sharded_db' && t.kind !== 'cache' && t.kind !== 'function') {
        for (const inst of t.insts) out.push({ edge: e, inst });
      } else out.push({ edge: e, inst: null });
    }
    return out;
  }

  /**
   * Split [0, duration) at every spike/ramp edge. Inside a segment each event's factor is constant
   * or linear, so its largest value is at one of the segment's ends; the product of those is an
   * upper bound for the rate in the segment. (One global bound, the product of all multipliers,
   * overflowed with many spikes and stalled the generator.)
   */
  private buildRateSegments(): void {
    this.rateSegs = rateSegments(this.sc, this.durationMs, this.maxRps);
  }

  /** Traffic multiplier at time t (ms). */
  multiplierAt(t: number): number {
    let m = 1;
    for (const ev of this.sc.events) m = Math.min(MAX_MULTIPLIER, m * eventFactor(ev, t));
    return m;
  }

  /** Arrival rate (per second) at time t (ms), capped at MAX_RPS (at the simulated scale). */
  private rateAt(t: number): number {
    return Math.min(this.maxRps, this.sc.rps * this.multiplierAt(t));
  }

  private scheduleEvents(): void {
    for (const ev of this.sc.events) {
      if (ev.type === 'spike' || ev.type === 'ramp') {
        const text = ev.type === 'spike' ? t('流量變 {m} 倍', { m: ev.multiplier }) : t('流量開始爬升到 {m} 倍', { m: ev.toMultiplier });
        this.at(ev.atS * 1000, () => this.log({ type: ev.type, text }));
        if (ev.type === 'spike' && ev.forS !== undefined) this.at((ev.atS + ev.forS) * 1000, () => this.log({ type: 'spike_end', text: t('突波結束') }));
        continue;
      }
      if (ev.type === 'wave') {
        this.at(ev.atS * 1000, () =>
          this.log({ type: 'wave', text: t('流量開始週期變化：每 {p} 秒一輪，在 {lo}–{hi} 倍之間', { p: ev.periodS, lo: round(1 - ev.amplitude, 2), hi: round(1 + ev.amplitude, 2) }) }),
        );
        if (ev.forS !== undefined) this.at((ev.atS + ev.forS) * 1000, () => this.log({ type: 'wave_end', text: t('週期流量結束') }));
        continue;
      }
      if (ev.type === 'cron') {
        const [, w1] = windowMs(ev);
        const peak = round(cronPeak(ev), 2);
        for (let k = 0; cronStart(ev, k) < Math.min(w1, this.durationMs); k++) {
          const text = ev.jitterS
            ? t('排程工作觸發：{s} 秒內分散送出，流量最高 {m} 倍', { s: round(ev.burstS + ev.jitterS, 2), m: peak })
            : t('排程工作觸發：所有使用者同時送出，流量 {m} 倍', { m: peak });
          this.at(cronStart(ev, k), () => this.log({ type: 'cron', text }));
        }
        continue;
      }
      if (ev.type === 'region_down') {
        // users are not in the data center: clients stay up
        const R = ev.region;
        const inRegion = this.nodes.filter((n) => n.kind !== 'client' && (n.region === R || n.insts.some((i) => i.region === R)));
        const set = (down: boolean) => {
          for (const n of inRegion) {
            // a database with replicas in another region: only its instances in this region
            if (!n.insts.length || n.insts.every((i) => i.region === R)) this.setDown(n, undefined, down, true);
            else for (const i of n.insts) if (i.region === R) this.setDown(n, i.idx, down, true);
          }
          this.log({ type: down ? 'region_down' : 'region_up', text: down ? t('區域 {r} 整區故障（{k} 個元件）', { r: ev.region, k: inRegion.length }) : t('區域 {r} 恢復', { r: ev.region }) });
        };
        this.at(ev.atS * 1000, () => set(true));
        if (ev.forS !== undefined) this.at((ev.atS + ev.forS) * 1000, () => set(false));
        continue;
      }
      if (ev.type === 'shift') {
        this.scheduleShift(ev);
        continue;
      }
      if (ev.type === 'partition') {
        this.schedulePartition(ev);
        continue;
      }
      if (ev.type === 'rollout') {
        this.scheduleRollout(ev);
        continue;
      }
      const n = this.byId.get(ev.node);
      if (!n) continue;
      const start = ev.atS * 1000;
      const end = ev.forS !== undefined ? (ev.atS + ev.forS) * 1000 : null;
      if (ev.type === 'down') {
        this.at(start, () => this.setDown(n, ev.instance, true));
        if (end !== null) this.at(end, () => this.setDown(n, ev.instance, false));
      } else if (ev.type === 'slow' && ev.instance !== undefined) {
        const inst = n.insts[ev.instance];
        if (!inst) continue;
        this.at(start, () => {
          inst.slowEv = ev.multiplier;
          this.log({ node: n.id, type: 'slow', text: t('{name}第 {i} 台變慢 {m} 倍', { name: n.label, i: inst.idx, m: ev.multiplier }) });
        });
        if (end !== null) this.at(end, () => { inst.slowEv = 1; this.log({ node: n.id, type: 'slow_end', text: t('{name}第 {i} 台恢復速度', { name: n.label, i: inst.idx }) }); });
      } else if (ev.type === 'slow') {
        this.at(start, () => {
          n.slow = ev.multiplier;
          this.log({ node: n.id, type: 'slow', text: t('{name}變慢 {m} 倍', { name: n.label, m: ev.multiplier }) });
        });
        if (end !== null) this.at(end, () => { n.slow = 1; this.log({ node: n.id, type: 'slow_end', text: t('{name}恢復速度', { name: n.label }) }); });
      } else if (ev.type === 'reshard') {
        if (n.kind !== 'sharded_db') continue;
        const copyS = ev.forS ?? 60;
        const load = 1 + (ev.copyLoad ?? 0.5);
        this.at(start, () => {
          for (const i of n.insts) i.copySlow = load;
          this.log({ node: n.id, type: 'reshard', text: t('{name}開始重新分片：{a} → {b} 份，複製資料 {s} 秒（每份變慢 {m} 倍）', { name: n.label, a: n.shardsNow, b: ev.toShards, s: copyS, m: load }) });
        });
        this.at(start + copyS * 1000, () => {
          for (const i of n.insts) i.copySlow = 1;
          const was = n.shardsNow;
          n.shardsNow = ev.toShards;
          // a new shard whose primary went down before the cutover: its failover starts now
          if (n.str('failover') === 'auto' && n.num('replicaApplyRatio') > 0) {
            const per = 1 + n.num('replicas');
            for (let s = was; s < n.shardsNow; s++) {
              const p = n.insts[s * per + n.prim[s]];
              if (p?.down) this.scheduleFailover(n, p);
            }
          }
          this.log({ node: n.id, type: 'reshard_done', text: t('{name}切換到 {b} 份分片', { name: n.label, b: ev.toShards }) });
        });
      } else if (ev.type === 'pause') {
        n.pauses.push({ t0: start, t1: end ?? Infinity, every: ev.everyS * 1000, ms: ev.pauseMs });
        this.at(start, () =>
          this.log({ node: n.id, type: 'pause', text: t('{name}開始週期性 GC 停頓：每 {e} 秒停 {ms} ms', { name: n.label, e: ev.everyS, ms: ev.pauseMs }) }),
        );
        if (end !== null) this.at(end, () => this.log({ node: n.id, type: 'pause_end', text: t('{name}停止 GC 停頓', { name: n.label }) }));
      } else if (ev.type === 'errors' && ev.instance !== undefined) {
        const inst = n.insts[ev.instance];
        if (!inst) continue;
        this.at(start, () => {
          inst.errOverride = ev.rate;
          this.log({ node: n.id, type: 'errors', text: t('{name}第 {i} 台錯誤率變 {p}%', { name: n.label, i: inst.idx, p: Math.round(ev.rate * 100) }) });
        });
        if (end !== null) this.at(end, () => { inst.errOverride = null; this.log({ node: n.id, type: 'errors_end', text: t('{name}第 {i} 台錯誤率恢復', { name: n.label, i: inst.idx }) }); });
      } else if (ev.type === 'errors') {
        this.at(start, () => {
          n.errOverride = ev.rate;
          this.log({ node: n.id, type: 'errors', text: t('{name}錯誤率變 {p}%', { name: n.label, p: Math.round(ev.rate * 100) }) });
        });
        if (end !== null) this.at(end, () => { n.errOverride = null; this.log({ node: n.id, type: 'errors_end', text: t('{name}錯誤率恢復', { name: n.label }) }); });
      }
    }
  }

  /**
   * Traffic shift: the weight of every edge from → to moves to ev.weight, linearly over forS
   * (a step every SHIFT_STEP_MS), and stays. Routers read the weights live (pickEdge, balance), so
   * a DNS answer, a load balancer or a client sends by the new split at once.
   */
  private scheduleShift(ev: Extract<ScEvent, { type: 'shift' }>): void {
    const edges = this.edges.filter((e) => e.from.id === ev.from && e.to.id === ev.to);
    if (!edges.length) return;
    const from = edges[0].from;
    const start = ev.atS * 1000;
    const over = (ev.forS ?? 0) * 1000;
    let w0: number[] = [];
    const apply = (f: number) => {
      edges.forEach((e, i) => (e.weight = w0[i] + (ev.weight - w0[i]) * f));
      // a client's API mix counts only APIs its edges with a positive weight carry
      if (from.kind === 'client') this.buildApiMix();
    };
    // one more hop at the same time: an earlier shift that ends now sets its final weight first
    // (events at one time run in the order they were added, and its end was added when it started)
    this.at(start, () => this.at(this.now, () => {
      // from the weights at the start (an earlier shift may have changed them)
      w0 = edges.map((e) => e.weight);
      this.log({ node: from.id, type: 'shift', text: over > 0 ? t('流量移轉：{from} → {to} 的權重在 {s} 秒內改成 {w}', { from: from.label, to: edges[0].to.label, s: round(over / 1000, 2), w: ev.weight }) : t('流量移轉：{from} → {to} 的權重改成 {w}', { from: from.label, to: edges[0].to.label, w: ev.weight }) });
      if (over <= 0) return apply(1);
      for (let k = 1; k * SHIFT_STEP_MS < over; k++) this.at(start + k * SHIFT_STEP_MS, () => apply((k * SHIFT_STEP_MS) / over));
      this.at(start + over, () => {
        apply(1);
        this.log({ node: from.id, type: 'shift_end', text: t('流量移轉完成：{from} → {to} 的權重是 {w}', { from: from.label, to: edges[0].to.label, w: ev.weight }) });
      });
    }));
  }

  /**
   * Rollout of a new version, wave by wave: wave w moves the first ceil(w / waves) of each target's
   * instances to it (off instances too: they boot on it). Each wave bakes waveS. With haltAt, after
   * a wave bakes the updated instances' failure share is checked: above it (or a crash), every
   * update is rolled back and the rollout stops.
   */
  private scheduleRollout(ev: Extract<ScEvent, { type: 'rollout' }>): void {
    const targets = (ev.node !== undefined ? [this.byId.get(ev.node)] : this.nodes.filter((n) => ROLLOUT_KINDS.has(n.kind))).filter((n): n is NodeRT => !!n && n.insts.length > 0);
    if (!targets.length) return;
    const waves = ev.waves ?? 1;
    const bake = (ev.waveS ?? 60) * 1000;
    const roll: RolloutRT = { ok: 0, fail: 0 };
    const updated: Instance[] = [];
    /** The version each instance ran before (a rollback goes back to it, not to a clean one). */
    const prev = new Map<Instance, { slow: number; err: number }>();
    const crashed = new Set<Instance>();
    let stopped = false;
    const where = ev.node !== undefined ? targets[0].label : t('全部伺服器（{k} 個元件）', { k: targets.length });
    const update = (n: NodeRT, inst: Instance): void => {
      if (inst.rollout === roll) return;
      inst.touch(this.now);
      prev.set(inst, { slow: inst.verSlow, err: inst.verErr });
      inst.rollout = roll;
      inst.verSlow = ev.slow ?? 1;
      inst.verErr = ev.errorRate ?? 0;
      updated.push(inst);
      if (ev.crash && inst.state !== 'off') {
        crashed.add(inst);
        this.setDown(n, inst.idx, true, true);
      }
    };
    const rollback = (): void => {
      for (const inst of updated) {
        inst.touch(this.now);
        const was = prev.get(inst)!;
        if (inst.rollout === roll) inst.rollout = null;
        inst.verSlow = was.slow;
        inst.verErr = was.err;
        if (crashed.has(inst)) this.setDown(inst.node, inst.idx, false, true);
      }
    };
    const wave = (w: number): void => {
      if (stopped) return;
      roll.ok = 0;
      roll.fail = 0;
      let k = 0;
      for (const n of targets) {
        const upto = Math.ceil((w / waves) * n.insts.length - 1e-9);
        for (let i = 0; i < upto; i++) {
          if (n.insts[i].rollout !== roll) k++;
          update(n, n.insts[i]);
        }
      }
      this.log({
        ...(ev.node !== undefined ? { node: ev.node } : {}),
        type: w === 1 ? 'rollout' : 'rollout_wave',
        text: waves > 1 ? t('部署新版本到{where}：第 {w}／{n} 波，更新 {k} 台（共 {total} 台）', { where, w, n: waves, k, total: updated.length }) : t('部署新版本到{where}：一次更新全部 {k} 台', { where, k }),
      });
      const done = (): void => {
        // the new version stays; the rollout is over, so a later one can update these instances again
        for (const inst of updated) if (inst.rollout === roll) inst.rollout = null;
        this.log({ ...(ev.node !== undefined ? { node: ev.node } : {}), type: 'rollout_done', text: t('部署完成：{where}共 {k} 台是新版本', { where, k: updated.length }) });
      };
      // the last wave without a check has nothing to wait for
      if (w === waves && ev.haltAt === undefined) return done();
      this.at(this.now + bake, () => {
        if (stopped) return;
        if (ev.haltAt !== undefined) {
          const seen = roll.ok + roll.fail;
          // a scaled run sees 1/k of the requests: the minimum sample is in real requests
          const share = ev.crash ? 1 : seen * this.scalePlan.k >= 20 ? roll.fail / seen : 0;
          if (share > ev.haltAt) {
            stopped = true;
            rollback();
            this.log({
              ...(ev.node !== undefined ? { node: ev.node } : {}),
              type: 'rollback',
              text: t('新版本失敗 {p}%，超過 {h}%：自動回滾 {k} 台，停止部署（第 {w}／{n} 波）', { p: Math.round(share * 100), h: Math.round(ev.haltAt * 100), k: updated.length, w, n: waves }),
            });
            return;
          }
        }
        if (w < waves) wave(w + 1);
        else done();
      });
    };
    this.at(ev.atS * 1000, () => wave(1));
  }

  /** The reply of a call between two regions: lost when a partition cut them meanwhile (the caller times out). */
  private overCut(from: string | undefined, to: string | undefined, done: Done): Done {
    if (!from || !to || from === to) return done;
    return (o) => {
      if (!this.cut(from, to)) done({ ...o, cross: [from, to] });
    };
  }

  /** Is the network between these two regions cut now? A node without a region is never cut off (users, global services). */
  private cut(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b || a === b || !this.cuts.size) return false;
    return (this.cuts.get(a < b ? `${a}|${b}` : `${b}|${a}`) ?? 0) > 0;
  }

  /**
   * Network partition between two regions: calls and replication between them are lost (the
   * caller times out); users reach both sides. A database with automatic failover whose replicas
   * are on the other side of the cut thinks its primary is down: after failoverS (the failover
   * controller is on the replicas' side) a replica there becomes the primary while the old one
   * still runs and takes writes from its side (split brain), unless fencing stops it.
   */
  private schedulePartition(ev: Extract<ScEvent, { type: 'partition' }>): void {
    this.anyPartition = true;
    const [a, b] = ev.regions;
    const pair = a < b ? `${a}|${b}` : `${b}|${a}`;
    this.at(ev.atS * 1000, () => {
      this.cuts.set(pair, (this.cuts.get(pair) ?? 0) + 1);
      this.log({ type: 'partition', text: t('網路分區：區域 {a} 和 {b} 之間斷線', { a, b }) });
      for (const n of this.nodes) {
        if ((n.kind !== 'database' && n.kind !== 'sharded_db') || n.str('failover') !== 'auto' || n.num('replicaApplyRatio') <= 0) continue;
        const per = 1 + n.num('replicas');
        if (per < 2) continue;
        // shards a later reshard adds hold no keys yet: they take no part
        for (let s = 0; s < n.shardsNow; s++) {
          const primary = n.insts[s * per + n.prim[s]];
          if (!n.insts.slice(s * per, s * per + per).some((i) => this.cut(primary.region, i.region))) continue;
          // healed, failed over already, or really down (the crash failover handles that)
          const stale = () => primary.down || !this.isPrimary(n, primary) || !!n.zombie[s] || !n.insts.slice(s * per, s * per + per).some((i) => this.cut(primary.region, i.region));
          const decide = (): void => {
            if (stale()) return;
            this.control(n, t('failover'), splitOver);
            // blind (the control call failed): look again after another failoverS
            if (n.out.some((e) => e.on === 'control')) this.at(this.now + n.num('failoverS') * 1000, decide);
          };
          const splitOver = (): void => {
            if (stale()) return;
            let best: Instance | null = null;
            for (let r = 0; r < per; r++) {
              const i = n.insts[s * per + r];
              if (i === primary || i.down || !this.cut(primary.region, i.region)) continue;
              if (!best || i.commits!.size + i.missed < best.commits!.size + best.missed) best = i;
            }
            if (!best) return;
            n.zombie[s] = { inst: primary, writes: 0 };
            this.promote(n, s, best, primary, true);
          };
          this.at(this.now + n.num('failoverS') * 1000, decide);
        }
      }
    });
    if (ev.forS === undefined) return;
    this.at((ev.atS + ev.forS) * 1000, () => {
      this.cuts.set(pair, (this.cuts.get(pair) ?? 1) - 1);
      if (!this.cuts.get(pair)) this.cuts.delete(pair);
      this.log({ type: 'partition_end', text: t('網路分區結束：區域 {a} 和 {b} 恢復連線', { a, b }) });
      for (const n of this.nodes) {
        n.zombie.forEach((z, s) => {
          if (!z) return;
          // still cut off from the new primary by another partition
          if (this.cut(z.inst.region, n.insts[s * (1 + n.num('replicas')) + n.prim[s]].region)) return;
          n.zombie[s] = null;
          this.log({
            node: n.id,
            type: 'divergence',
            count: z.writes,
            text: z.writes
              ? t('{name}：舊主庫在分區期間收了 {k} 筆寫入，新主庫沒有，資料分歧', { name: n.label, k: z.writes })
              : t('{name}：舊主庫在分區期間沒有收寫入，沒有分歧', { name: n.label }),
          });
        });
      }
    });
  }

  /**
   * One outage starts (`down`) or ends. Outages can overlap (a down event and a region outage):
   * a node or instance is up again only when the last one ends. `quiet`: no timeline entry (a
   * region event logs once for all its nodes).
   */
  private setDown(n: NodeRT, instance: number | undefined, down: boolean, quiet = false): void {
    const targets = instance === undefined ? (n.insts.length ? n.insts : null) : [n.insts[instance]].filter(Boolean);
    let changed = false;
    if (instance === undefined) {
      n.outages = Math.max(0, n.outages + (down ? 1 : -1));
      changed = n.down !== n.outages > 0;
      if (changed && down) n.crashes++;
      n.down = n.outages > 0;
    }
    for (const inst of targets ?? []) {
      inst.outages = Math.max(0, inst.outages + (down ? 1 : -1));
      // still down from another outage, or not down at all
      if (inst.down === inst.outages > 0) continue;
      changed = true;
      inst.touch(this.now);
      if (down && !inst.down) {
        inst.crashes++;
        // replication is tracked only with an apply cost (the design check says so)
        if (n.str('failover') === 'auto' && n.num('replicaApplyRatio') > 0 && this.isPrimary(n, inst)) this.scheduleFailover(n, inst);
      }
      inst.down = down;
      if (down) {
        // crash: queued and in-flight requests fail now; their later completions are ignored
        this.purgeExpired(inst);
        for (const job of inst.q.drain()) this.failJob(inst, job, 'down');
        for (const job of [...inst.inflight, ...inst.detached]) {
          job.dead = true;
          this.failJob(inst, job, 'down');
        }
        inst.inflight.clear();
        inst.detached.clear();
        inst.busy = 0;
        // a crashed cache comes back empty (cold)
        inst.lru?.clear();
        inst.fills?.clear();
        inst.leases?.clear();
        // the transactions died with it: their row locks go too
        inst.locks?.clear();
      } else {
        this.pull(inst);
        if (n.kind === 'function' && inst.state === 'on' && inst.busy === 0) this.fnIdleNow(inst);
      }
      // a retiring instance that lost its work in the crash can turn off now
      this.maybeRetired(inst);
    }
    // a function that is back starts environments for the messages that waited (pull() needs one)
    if (instance === undefined && !down && changed && !n.down && n.kind === 'function') for (const f of n.fnQueues) this.dispatch(f.qs);
    if (quiet || !changed) return;
    const who = instance === undefined ? n.label : `${n.label} ${n.insts[instance]?.role || `#${instance}`}`;
    this.log({ node: n.id, type: down ? 'down' : 'up', text: down ? t('{name}故障', { name: who }) : t('{name}恢復', { name: who }) });
  }

  // -------------------------------------------------------------------------------------------
  // Autoscaling (like a Kubernetes HPA): every scaleEveryS, compare the average busy share of the
  // serving instances with the target; launch instances that serve after bootS (and start cold),
  // or retire one instance that first finishes its own queue.

  private scheduleScale(n: NodeRT): void {
    const next = this.now + n.num('scaleEveryS') * 1000;
    if (next < this.durationMs) {
      this.at(next, () => {
        this.scale(n);
        this.scheduleScale(n);
      });
    }
  }

  /**
   * Instances finished booting. Without boot edges they serve now. With them, each instance calls
   * every boot edge once (fetch its config, register, pull its image): when every call succeeds it
   * serves; otherwise it boots again after bootS (it still counts as booting, so no extra launch).
   */
  private bootUp(n: NodeRT, launched: Instance[]): void {
    const boots = n.out.filter((e) => e.on === 'boot');
    const live = launched.filter((i) => i.state === 'boot');
    if (!live.length) return;
    const ready = (ok: Instance[]): void => {
      if (!ok.length) return;
      const warmS = n.num('warmS');
      const warm = warmS > 0 && n.num('coldFactor') > 1;
      for (const i of ok) {
        i.touch(this.now);
        i.state = 'on';
        i.warmUntil = warm ? this.now + warmS * 1000 : 0;
        this.pull(i);
      }
      const active = n.insts.filter((x) => x.state === 'on').length;
      n.peakActive = Math.max(n.peakActive, active);
      const vars = { name: n.label, k: ok.length, total: active, s: warmS };
      this.log({ node: n.id, type: 'scale_ready', text: warm ? t('{name}新的 {k} 台上線，共 {total} 台，新機器暖機 {s} 秒', vars) : t('{name}新的 {k} 台上線，共 {total} 台', vars) });
    };
    if (!boots.length) return ready(live);
    const ok: Instance[] = [];
    const bad: Instance[] = [];
    let left = live.length;
    const settle = (): void => {
      if (--left > 0) return;
      ready(ok.filter((i) => i.state === 'boot'));
      const retry = bad.filter((i) => i.state === 'boot');
      if (!retry.length) return;
      n.bootFails += retry.length;
      // bootS 0 would retry at the same instant, again and again: wait at least a second
      const bootS = Math.max(1, n.num('bootS'));
      this.log({ node: n.id, type: 'boot_fail', text: t('{name}有 {k} 台開機失敗（開機時要呼叫的元件沒回應），{s} 秒後重開', { name: n.label, k: retry.length, s: bootS }) });
      this.at(this.now + bootS * 1000, () => this.bootUp(n, retry));
    };
    for (const i of live) {
      let calls = boots.length;
      let good = true;
      for (const e of boots) {
        const req: Req = { id: this.nextReqId++, cls: 0, key: i.idx, t0: this.now, settled: false, client: n.id, pri: 0 };
        this.callEdge(e, req, READ, (o) => {
          if (!o.ok) good = false;
          if (--calls > 0) return;
          (good ? ok : bad).push(i);
          settle();
          // a fallback would make a failed boot look fine: a boot call takes none
        }, undefined, i, true);
      }
    }
  }

  /**
   * The node's controller (autoscaler, failover, DNS health checks) first asks its control edges
   * (its metrics or coordination service). When one fails it is blind: it does not act this time.
   */
  private control(n: NodeRT, what: string, act: () => void): void {
    const ctl = n.out.filter((e) => e.on === 'control');
    if (!ctl.length) return act();
    let left = ctl.length;
    let ok = true;
    for (const e of ctl) {
      const req: Req = { id: this.nextReqId++, cls: 0, key: 0, t0: this.now, settled: false, client: n.id, pri: 0 };
      // a fallback answer is no control data: the controller is blind (noFallback below)
      this.callEdge(e, req, READ, (o) => {
        if (!o.ok) ok = false;
        if (--left > 0) return;
        if (ok) {
          if (n.blind) {
            n.blind = false;
            this.log({ node: n.id, type: 'control_back', text: t('{name}又看得到監控了（{what}）', { name: n.label, what }) });
          }
          act();
          return;
        }
        n.blindChecks++;
        if (!n.blind) {
          n.blind = true;
          this.log({ node: n.id, type: 'control_lost', text: t('{name}看不到監控（{what}要呼叫的元件失敗），先不動作', { name: n.label, what }) });
        }
      }, undefined, undefined, true);
    }
  }

  private scale(n: NodeRT): void {
    this.control(n, t('自動擴充'), () => this.scaleNow(n));
  }

  private scaleNow(n: NodeRT): void {
    let busy = 0;
    let cap = 0;
    let ready = 0;
    let booting = 0;
    for (const i of n.insts) {
      i.touch(this.now);
      if (i.state === 'boot') booting++;
      if (i.state === 'on' && !i.down) {
        ready++;
        busy += i.sBusy;
        cap += i.sUp * i.slots;
      }
      i.sBusy = 0;
      i.sUp = 0;
    }
    const target = n.num('targetUtil');
    if (!cap || target <= 0) return;
    const util = busy / cap;
    const ratio = util / target;
    const min = n.num('instances');
    const max = Math.max(min, n.num('maxInstances'));
    // within the tolerance (as in the Kubernetes HPA) the recommendation is "keep what is there"
    const desired = Math.abs(ratio - 1) <= 0.1 ? ready + booting : Math.min(max, Math.max(min, Math.ceil(ready * ratio - 1e-9)));
    // scale in only to the most instances any check in the window wanted (HPA stabilization window)
    const windowMs = n.num('scaleDownS') * 1000;
    // a monotonic queue: only the checks that can still be the largest in the window, largest first
    const recs = n.scaleRecs;
    while (recs.length > n.scaleHead && recs[recs.length - 1][1] <= desired) recs.pop();
    recs.push([this.now, desired]);
    while (n.scaleHead < recs.length - 1 && recs[n.scaleHead][0] <= this.now - windowMs) n.scaleHead++;
    if (n.scaleHead > 64 && n.scaleHead * 2 > recs.length) {
      recs.splice(0, n.scaleHead);
      n.scaleHead = 0;
    }
    const keep = recs[n.scaleHead][1];
    const pct = Math.round(util * 100);
    if (desired > ready + booting) {
      const launched: Instance[] = [];
      for (const i of n.insts) {
        if (launched.length >= desired - ready - booting) break;
        if (i.state !== 'off' || i.down) continue;
        i.touch(this.now);
        i.state = 'boot';
        launched.push(i);
      }
      if (!launched.length) return;
      n.launches += launched.length;
      const bootS = n.num('bootS');
      this.log({ node: n.id, type: 'scale_out', text: t('{name}忙碌 {p}%，決定加 {k} 台（{s} 秒後上線）', { name: n.label, p: pct, k: launched.length, s: bootS }) });
      this.at(this.now + bootS * 1000, () => this.bootUp(n, launched));
    } else if (keep < ready && booting === 0) {
      // retire down to the most the window wanted, newest instances first
      const victims: Instance[] = [];
      for (let k = n.insts.length - 1; k >= 0 && victims.length < ready - keep; k--) if (n.insts[k].state === 'on' && !n.insts[k].down) victims.push(n.insts[k]);
      if (!victims.length) return;
      for (const v of victims) {
        v.touch(this.now);
        v.state = 'retiring';
      }
      n.retires += victims.length;
      this.log({ node: n.id, type: 'scale_in', text: t('{name}忙碌 {p}%，減 {n} 台（剩 {k} 台）', { name: n.label, p: pct, n: victims.length, k: ready - victims.length }) });
      for (const v of victims) this.maybeRetired(v);
    }
  }

  /** A retiring instance turns off once it has no work and no open connections from a load balancer. */
  private maybeRetired(inst: Instance): void {
    if (inst.state !== 'retiring' || inst.busy > 0 || inst.q.length > 0 || inst.active > 0 || inst.detached.size > 0) return;
    inst.touch(this.now);
    inst.state = 'off';
    inst.warmUntil = 0;
  }

  private log(e: Omit<TimelineEvent, 't'>): void {
    this.timeline.push({ t: this.now / 1000, ...e });
  }

  // -------------------------------------------------------------------------------------------
  // Event loop

  private at(t: number, f: () => void): void {
    this.q.push(t, f);
  }

  /** Advance the simulation to time `tMs` (or to the end). */
  runUntil(tMs: number): void {
    const limit = Math.min(tMs, this.endMs);
    const q = this.q;
    while (!this.done && q.peekTime() <= limit) {
      const e = q.pop()!;
      this.now = e.t;
      e.f();
      if (++this.events >= this.maxEvents) {
        this.truncated = true;
        this.finish();
        return;
      }
    }
    if (!this.done) this.now = Math.max(this.now, limit);
    if (!this.done && limit >= this.endMs) this.finish();
  }

  runToEnd(): SimResult {
    this.runUntil(Infinity);
    return this.result();
  }

  /** Jobs still running or waiting now (what `unfinished` in the result counts at the end), at full
   *  size: × k when the run is scaled down, as in result(). */
  unfinishedNow(): number {
    return this.unfinished() * this.scalePlan.k;
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    // queued work whose propagated deadline passed counts as expired, not unfinished
    for (const n of this.nodes) for (const i of n.insts) this.purgeExpired(i);
    // divergence counted in the last second, whose timeline entry was due after the end
    for (const n of this.nodes) this.logLateDivergence(n);
    if (this.now > this.windowStart) this.flushWindow(true);
  }

  // -------------------------------------------------------------------------------------------
  // Traffic

  private scheduleArrival(from: number): void {
    let t = from;
    if (this.sc.arrivals === 'constant') {
      // Evenly spaced: the next request comes when the area under the rate curve reaches one request.
      // Walk the rate segments so a short burst (cron, spike) between two requests is not skipped.
      let need = 1;
      for (;;) {
        // the area reached one request exactly at the end of a stepped segment: emit here, before a zero-rate segment can skip it
        if (need <= 1e-12) break;
        while (this.rateSeg < this.rateSegs.length && this.rateSegs[this.rateSeg].t1 <= t) this.rateSeg++;
        const seg = this.rateSegs[this.rateSeg];
        if (!seg) return;
        if (seg.lam <= 0) {
          t = seg.t1;
          continue;
        }
        if (seg.flat) {
          // count area from the segment start instead of adding gaps to t, so arrival times do not drift;
          // the n-th arrival is due when the area reaches n (to a few ulps of n, the rounding of one product)
          if (this.flatSeg !== this.rateSeg) {
            this.flatSeg = this.rateSeg;
            this.flatArea = ((t - seg.t0) * seg.lam) / 1000 + need;
          } else this.flatArea += need;
          const area = ((seg.t1 - seg.t0) * seg.lam) / 1000;
          if (this.flatArea <= area * (1 + 4 * Number.EPSILON)) {
            t = Math.min(seg.t0 + (this.flatArea * 1000) / seg.lam, seg.t1);
            break;
          }
          need = this.flatArea - area;
          t = seg.t1;
          continue;
        }
        // the rate changes inside the segment (ramp, wave): midpoint steps of a quarter of the shortest gap,
        // and at most 1/64 of a wave period so a slow rate does not alias a fast wave
        const h = Math.min(seg.t1 - t, 250 / seg.lam, seg.step);
        const r = this.rateAt(t + h / 2);
        const got = (h * r) / 1000;
        if (got >= need) {
          t += (need * 1000) / r;
          break;
        }
        need -= got;
        t += h;
      }
    } else {
      // thinning, one segment at a time; past a segment's end, restart there (exponential gaps are memoryless)
      for (;;) {
        while (this.rateSeg < this.rateSegs.length && this.rateSegs[this.rateSeg].t1 <= t) this.rateSeg++;
        const seg = this.rateSegs[this.rateSeg];
        if (!seg) return;
        if (seg.lam <= 0) {
          t = seg.t1;
          continue;
        }
        const next = t + sampleExp(this.rArr, 1000 / seg.lam);
        if (next >= seg.t1) {
          t = seg.t1;
          continue;
        }
        t = next;
        if (this.rArr() * seg.lam < this.rateAt(t)) break;
      }
    }
    if (t >= this.durationMs) return;
    this.at(t, () => {
      this.spawn();
      this.scheduleArrival(this.now);
    });
  }

  private pickClient(): NodeRT {
    if (this.clients.length === 1) return this.clients[0];
    const total = this.clientWeights.reduce((a, b) => a + b, 0);
    let u = this.rClient() * total;
    for (let i = 0; i < this.clients.length; i++) {
      u -= this.clientWeights[i];
      if (u < 0) return this.clients[i];
    }
    return this.clients[this.clients.length - 1];
  }

  private spawn(): void {
    const client = this.pickClient();
    // one draw either way: a design without APIs keeps the same random numbers
    const u = this.rCls();
    const mix = client.apiMix;
    const api = mix.length ? (mix.find((m) => u < m.cum) ?? mix[mix.length - 1]).api : undefined;
    const cls: 0 | 1 = api ? api.op : u < this.sc.readRatio ? READ : WRITE;
    const key = this.keys.sample(this.rKey);
    this.send(client, cls, key, api);
  }

  /** Send one request from a client (a new arrival, or a read that follows the user's own write). */
  private send(client: NodeRT, cls: 0 | 1, key: number, api: Simulation['apis'][number] | undefined, wroteAt?: number): void {
    const sampled = this.rSample() < this.sampleP;
    const req: Req = { id: this.nextReqId++, cls, key, t0: this.now, settled: false, client: client.id, pri: client.pri };
    if (wroteAt !== undefined) req.wroteAt = wroteAt;
    if (api) {
      req.api = api.name;
      if (this.sentInMeasure(req.t0)) api.offered++;
    }
    if (client.p.deadline === 'propagate') req.deadline = req.t0 + this.sc.clientTimeoutMs;
    if (sampled) req.trace = [];
    this.g.offered++;
    if (this.sentInMeasure(req.t0)) this.gTot.offered++;
    client.w.arrivals++;
    this.at(this.now + this.sc.clientTimeoutMs, () => this.settle(req, client, { ok: false, reason: 'timeout' }));
    // the design names its APIs, and no edge of this client carries one: nowhere to send it (like a client without edges)
    if (!api && this.apis.length) this.settle(req, client, { ok: true });
    else this.forwardOne(client, req, cls, (o) => this.settle(req, client, o));
  }

  /**
   * Read-your-writes: some users read the key they just wrote, followAfterMs later. With APIs the
   * read calls the first read API of the client's mix (none: no read). Its own random stream, so
   * the other draws do not change.
   */
  private followRead(req: Req, client: NodeRT): void {
    if (this.rFollow() >= this.sc.followReads) return;
    const at = this.now + this.sc.followAfterMs;
    if (at >= this.durationMs) return;
    let api: Simulation['apis'][number] | undefined;
    if (this.apis.length) {
      api = client.apiMix.find((m) => m.api.op === READ)?.api;
      if (!api) return;
    }
    const wroteAt = req.committedAt!;
    this.at(at, () => this.send(client, READ, req.key, api, wroteAt));
  }

  /** Summary stats follow the requests sent in [measureFromMs, measureToMs), the same span as the node totals. */
  private sentInMeasure(t: number): boolean {
    return t >= this.measureFromMs && t < this.measureToMs;
  }

  private settle(req: Req, client: NodeRT, o: Outcome): void {
    if (req.settled) return;
    req.settled = true;
    const lat = this.now - req.t0;
    const measured = this.sentInMeasure(req.t0);
    if (measured && req.api !== undefined) {
      const a = this.apis.find((x) => x.name === req.api)!;
      if (o.ok) {
        a.ok++;
        a.hist.add(lat);
      } else a.fail++;
    }
    if (o.ok && req.cls === WRITE && req.committedAt !== undefined && this.sc.followReads > 0) this.followRead(req, client);
    if (o.ok) {
      this.g.ok++;
      client.w.ok++;
      this.whist.add(lat);
      if (o.degraded) this.g.degraded++;
      if (measured) {
        this.gTot.ok++;
        this.hist.add(lat);
        if (o.degraded) this.gTot.degraded++;
      }
    } else {
      const r = o.reason ?? 'error';
      this.g.fail[r]++;
      client.w.fail++;
      if (r === 'timeout') client.w.origin.timeout++;
      if (measured) this.gTot.fail[r]++;
    }
    if (req.trace) {
      this.traces.push({ id: req.id, client: client.id, op: req.cls === READ ? 'read' : 'write', ...(req.api !== undefined ? { api: req.api } : {}), t0: req.t0, t1: this.now, ok: o.ok, reason: o.ok ? undefined : o.reason, hops: req.trace });
      if (this.traces.length > this.maxTraces * 2) {
        const drop = this.traces.length - this.maxTraces;
        this.traces.splice(0, drop);
        this.tracesRead = Math.max(0, this.tracesRead - drop);
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Calls

  /**
   * Call `edge.to` over `edge`, with the edge's timeout, retries, bulkhead and fallback. `from` is
   * the caller's instance (its bulkhead is per instance); without it the limit is for the whole edge.
   */
  private callEdge(edge: EdgeRT, req: Req, op: Op, done: Done, route?: Route, from?: Instance, noFallback = false): void {
    let attempt = 0;
    let reserved: number | null = null; // retry-budget second of the retry waiting for its backoff
    const caller = from ?? null;
    // the final failure: with a fallback the caller answers anyway, with a degraded response
    const fail = (o: Outcome): void => {
      if (!o.ok && edge.fallback && !noFallback && !(req.deadline !== undefined && this.now >= req.deadline)) {
        edge.w.fallbacks++;
        done({ ok: true, degraded: true, fellBack: true });
      } else done(o.fellBack ? { ...o, fellBack: undefined } : o);
    };
    const go = (): void => {
      // the client has given up: with a propagated deadline nobody sends (or re-sends) for it
      if (req.deadline !== undefined && this.now >= req.deadline) {
        if (reserved !== null) edge.refundRetry(reserved);
        reserved = null;
        done({ ok: false, reason: 'timeout' });
        return;
      }
      // bulkhead: the caller already has its limit of calls in flight over this edge
      if (edge.bulkhead > 0 && (edge.inUse.get(caller) ?? 0) >= edge.bulkhead) {
        if (reserved !== null) edge.refundRetry(reserved);
        reserved = null;
        edge.w.bulkhead++;
        edge.from.w.origin.bulkhead++;
        fail({ ok: false, reason: 'bulkhead' });
        return;
      }
      // adaptive throttling: the caller rejects the call itself, without sending it
      if (edge.throttle(this.now)) {
        if (reserved !== null) edge.refundRetry(reserved);
        reserved = null;
        edge.w.throttled++;
        edge.from.w.origin.throttled++;
        fail({ ok: false, reason: 'throttled' });
        return;
      }
      attempt++;
      if (attempt === 1) edge.noteFirst(this.now);
      else edge.w.retries++; // counted when sent: a retry the deadline cancelled is not a call
      if (reserved !== null) edge.sendRetry(reserved, this.now);
      reserved = null;
      edge.w.calls++;
      edge.w.attempts++;
      if (op === READ) edge.w.read++;
      else if (op === WRITE) edge.w.write++;
      let settled = false;
      // adaptive throttling counts a call when its answer is known, or after THROTTLE_HUNG_MS without one
      let hung = false;
      // a propagated deadline caps every hop's wait at the time the client gives up
      const wait = req.deadline === undefined ? edge.timeoutMs : Math.min(edge.timeoutMs > 0 ? edge.timeoutMs : Infinity, req.deadline - this.now);
      // no timer when the call surely settles (reply or timeout) before THROTTLE_HUNG_MS
      if (edge.throttleK > 0 && !(wait > 0 && wait <= THROTTLE_HUNG_MS)) {
        this.at(this.now + THROTTLE_HUNG_MS, () => {
          if (settled) return;
          hung = true;
          edge.noteHung(this.now);
        });
      }
      // One attempt is one copy, or two with hedging. Each copy holds the caller's connection until
      // the attempt settles (a reply is accepted, or the caller gives up).
      type Copy = { inst: Instance | null; open: boolean; replied: boolean; conn: boolean };
      const copies: Copy[] = [];
      let timedOut = false;
      const close = (c: Copy): void => {
        if (!c.open) return;
        c.open = false;
        if (edge.bulkhead > 0) edge.inUse.set(caller, edge.inUse.get(caller)! - 1);
        // keep-alive: the connection waits for the next call (a timed-out call's connection is reset)
        if (c.conn && edge.keepAlive && !timedOut) {
          const pool = edge.idle.get(caller);
          if (pool) pool.push(this.now);
          else edge.idle.set(caller, [this.now]);
        }
        route?.settle(c.inst);
      };
      const hop: TraceHop | undefined = req.trace
        ? { edge: edge.id, from: edge.from.id, to: edge.to.id, op: opName(op), tSend: this.now }
        : undefined;
      if (hop) req.trace!.push(hop);
      const finish = (o: Outcome, by: Copy | null): void => {
        if (settled) return;
        settled = true;
        for (const c of copies) close(c);
        if (hop) {
          hop.tDone = this.now;
          hop.ok = o.ok;
          if (!o.ok) hop.reason = o.reason;
          if (o.hit !== undefined) hop.hit = o.hit;
        }
        edge.noteResult(this.now, o.ok, hung);
        // passive health checking: the copy that answered, or every copy still out when the caller gave up
        if (by) route?.report?.(by.inst, o);
        else for (const c of copies) if (!c.replied) route?.report?.(c.inst, o);
        if (o.ok) edge.w.ok++;
        else edge.w.fail++;
        // no retry after the propagated deadline, or when the retry budget is used up
        const want = !o.ok && attempt <= edge.retries && o.reason !== 'rate_limited' && o.reason !== 'shed' && o.reason !== 'circuit_open' && o.reason !== 'throttled' && o.reason !== 'bulkhead'
          && !(req.deadline !== undefined && this.now >= req.deadline);
        const sec = want ? edge.takeRetry(this.now) : false;
        if (want && sec === false) edge.w.denied++;
        if (sec !== false) {
          reserved = sec;
          const cap = edge.backoffMs * Math.pow(2, attempt - 1);
          this.pending++;
          this.at(this.now + edge.rng() * cap, () => {
            this.pending--;
            go();
          });
        } else fail(o);
      };
      if (wait > 0)
        this.at(this.now + wait, () => {
          if (settled) return;
          timedOut = true;
          finish({ ok: false, reason: 'timeout' }, null);
        });
      const send = (hedge: boolean): void => {
        if (edge.bulkhead > 0) edge.inUse.set(caller, (edge.inUse.get(caller) ?? 0) + 1);
        // the load balancer picks (and counts) the instance when it sends, not when the request lands
        const c: Copy = { inst: route ? route.pick(hedge ? copies[0].inst : undefined) : null, open: true, replied: false, conn: edge.connectMs > 0 };
        copies.push(c);
        // a new connection first does its handshakes; an idle one that is still open is reused
        let connect = 0;
        if (c.conn) {
          const pool = edge.idle.get(caller);
          let reuse = false;
          while (pool?.length) {
            if (this.now - pool.pop()! < edge.idleMs) {
              reuse = true;
              break;
            }
            // the newest idle one is too old: so are the rest
            pool.length = 0;
          }
          if (!reuse) {
            connect = edge.connectMs;
            edge.w.connects++;
          }
        }
        this.pending++;
        this.at(this.now + edge.latency + connect, () => {
          this.pending--;
          if (hop && !hedge) hop.tArrive = this.now;
          // a copy that answers after the attempt settled: late when the caller timed out (already
          // reported as a timeout); otherwise a hedge loser, reported to passive health checking only
          const lost = (o: Outcome): void => {
            if (c.replied) return;
            c.replied = true;
            if (timedOut) edge.w.late++;
            else route?.report?.(c.inst, o);
          };
          // back: the trip home. A fan-out's copies each travel back on their own (in scatter): 0 here
          const reply = (out: Outcome, back = edge.latency): void => {
            // the regions this reply crosses: checked again when it arrives, and not passed further up
            let o = out;
            let cross: [string, string] | undefined;
            if (o.cross) {
              cross = o.cross;
              const { cross: _, ...rest } = o;
              o = rest;
            }
            if (settled) {
              lost(o);
              return;
            }
            // a fan-out copy's trace keeps the time the callee answered (set when its work ended)
            if (hop && !hedge && (back > 0 || hop.tReply === undefined)) hop.tReply = this.now;
            this.pending++;
            this.at(this.now + back, () => {
              this.pending--;
              // a partition that started while the reply travelled back: it is lost (the caller times out)
              if (cross && this.cut(cross[0], cross[1])) return;
              // the reply travelled back after the attempt settled (a hedge loser is not late)
              if (settled) {
                lost(o);
                return;
              }
              c.replied = true;
              // a failed copy while the other is still out: wait for the other one
              if (!o.ok && copies.some((x) => !x.replied)) {
                route?.report?.(c.inst, o);
                close(c);
                return;
              }
              if (hedge && o.ok) edge.w.hedgeWins++;
              finish(o, c);
            });
          };
          if (edge.fanout > 1) this.scatter(edge, req, op, (o) => reply(o, 0), hop, reply);
          else this.handle(edge.to, req, op, reply, c.inst ?? undefined, hedge ? undefined : hop, edge);
        });
      };
      send(false);
      // hedging: a read with no reply after hedgeMs gets a second copy (writes are not idempotent)
      if (edge.hedgeMs > 0 && op === READ && (wait <= 0 || edge.hedgeMs < wait)) {
        this.at(this.now + edge.hedgeMs, () => {
          if (settled || copies.length > 1 || copies[0].replied) return;
          if (edge.bulkhead > 0 && (edge.inUse.get(caller) ?? 0) >= edge.bulkhead) return;
          edge.w.hedges++;
          edge.w.calls++;
          edge.w.read++;
          send(true);
        });
      }
    };
    go();
  }

  /**
   * Fan-out (scatter-gather): send the call to `edge.fanout` shards or instances of the target at
   * once, and answer when `edge.quorum` of them (default: all) succeeded, or when too many failed for
   * that. Copies not waited for still run to the end. `early`: the answer when the call fails before
   * any copy is sent (it still travels back over the edge); `done` gets the copies' result, which
   * travelled back already.
   */
  private scatter(edge: EdgeRT, req: Req, op: Op, done: Done, hop?: TraceHop, early: Done = done): void {
    const n = edge.to;
    const targets = this.fanoutTargets(n, req, op, edge.fanout, edge.fromRegion);
    if (!targets.length) {
      n.w.arrivals++;
      this.reject(n, 'down', early);
      return;
    }
    // quorum: at most the copies asked for; fewer copies than that can never reach it (fail at once)
    const need = edge.quorum > 0 ? Math.min(edge.quorum, edge.fanout) : targets.length;
    if (need > targets.length) {
      n.w.arrivals++;
      this.reject(n, 'down', early);
      return;
    }
    edge.w.copies += targets.length;
    if (STORE_KINDS.has(n.kind)) req.need = need;
    // a database write goes to every copy itself (leaderless, like Cassandra): no replication after it
    const direct = op === WRITE && n.kind === 'database';
    let ok = 0;
    let bad = 0;
    let hits = 0;
    let degraded = false;
    let settled = false;
    targets.forEach((inst, i) => {
      // each copy travels back on its own: a partition that starts meanwhile loses it (it never counts)
      const got: Done = (out) => {
        if (settled) return;
        const { cross, ...o } = out;
        this.pending++;
        this.at(this.now + edge.latency, () => {
          this.pending--;
          if (cross && this.cut(cross[0], cross[1])) return;
          arrived(o);
        });
      };
      const arrived: Done = (o) => {
        if (settled) return;
        if (o.ok) {
          ok++;
          if (o.hit) hits++;
          if (o.degraded) degraded = true;
        } else bad++;
        if (ok >= need) {
          settled = true;
          const r: Outcome = { ok: true };
          if (degraded) r.degraded = true;
          if (n.kind === 'cache') r.hit = hits >= need;
          done(r);
        } else if (bad > targets.length - need) {
          settled = true;
          done(o);
        }
      };
      if (inst) this.handle(n, req, op, got, inst, i === 0 ? hop : undefined, edge, direct);
      else {
        n.w.arrivals++;
        this.reject(n, 'down', got);
      }
    });
  }

  /**
   * Where one fan-out call goes: a sharded database, the key's shard and the next ones (null for a
   * shard with no instance to serve it); a database, members of its replica group; other nodes,
   * distinct instances that are on (not booting or retiring; a down one is a failed copy). At most
   * `count`; fewer when the target has fewer.
   */
  private fanoutTargets(n: NodeRT, req: Req, op: Op, count: number, fromRegion?: string): (Instance | null)[] {
    if (n.kind === 'sharded_db') {
      const shards = n.shardsNow;
      const s0 = keyBucket(req.key, shards);
      return Array.from({ length: Math.min(count, shards) }, (_, i) => this.pickInstance(n, req, op, fromRegion, (s0 + i) % shards));
    }
    const pool = n.kind === 'database' ? n.insts.slice(0, 1 + n.num('replicas')) : n.insts.filter((x) => x.state === 'on');
    if (n.kind === 'database' && op === WRITE) {
      // the primary first: a write always reaches it
      const p = n.prim[0] ?? 0;
      pool.unshift(...pool.splice(p, 1));
      return pool.slice(0, count);
    }
    const m = Math.min(count, pool.length);
    const start = m < pool.length ? n.rr++ % pool.length : 0;
    return Array.from({ length: m }, (_, i) => pool[(start + i) % pool.length]);
  }

  /** A downstream edge for `op` and the request's API, by weight; `skip`: edges not to pick. */
  private pickEdge(n: NodeRT, op: Op, api: string | undefined, skip?: (e: EdgeRT) => boolean): EdgeRT | null {
    let total = 0;
    let only: EdgeRT | null = null;
    let count = 0;
    for (const e of n.out) {
      if (e.carries(op, api) && e.weight > 0 && !skip?.(e)) {
        total += e.weight;
        only = e;
        count++;
      }
    }
    if (count <= 1) return only;
    let u = n.rng() * total;
    for (const e of n.out) {
      if (!e.carries(op, api) || e.weight <= 0 || skip?.(e)) continue;
      u -= e.weight;
      if (u < 0) return e;
    }
    return only;
  }

  // -------------------------------------------------------------------------------------------
  // Database failover

  private isPrimary(n: NodeRT, inst: Instance): boolean {
    if (!n.prim.length) return false;
    const per = 1 + n.num('replicas');
    return inst.idx % per === n.prim[Math.floor(inst.idx / per)];
  }

  /**
   * Automatic failover (like Orchestrator or RDS Multi-AZ): when the primary has been down for
   * failoverS, the replica that is furthest along becomes the primary. Replication is
   * asynchronous: the writes the primary acknowledged that this replica had not applied yet are
   * lost. The other replicas follow the new primary from now on (their backlog is dropped too).
   */
  private scheduleFailover(n: NodeRT, primary: Instance): void {
    const per = 1 + n.num('replicas');
    if (per < 2) return;
    // a shard that holds no keys (not added yet, or merged away by a later reshard): nothing to fail
    // over. Checked again when the timer fires: a reshard can end the shard meanwhile
    const live = (): boolean => Math.floor(primary.idx / per) < n.shardsNow;
    if (!live()) return;
    const crash = primary.crashes;
    const decide = (): void => {
      if (!live() || !primary.down || primary.crashes !== crash || !this.isPrimary(n, primary)) return;
      this.control(n, t('failover'), promoteBest);
      // blind (the control call failed): look again after another failoverS
      if (n.out.some((e) => e.on === 'control')) this.at(this.now + n.num('failoverS') * 1000, decide);
    };
    const promoteBest = (): void => {
      if (!live() || !primary.down || primary.crashes !== crash || !this.isPrimary(n, primary)) return;
      const shard = Math.floor(primary.idx / per);
      const base = shard * per;
      let best: Instance | null = null;
      for (let r = 0; r < per; r++) {
        const i = n.insts[base + r];
        if (i === primary || i.down) continue;
        // the replica missing the fewest writes: not applied yet, or never to arrive
        if (!best || i.commits!.size + i.missed < best.commits!.size + best.missed) best = i;
      }
      if (!best) {
        this.log({ node: n.id, type: 'failover_none', text: t('{name}的主庫故障，但沒有可用的副本，無法 failover', { name: n.label }) });
        return;
      }
      this.promote(n, shard, best, primary, false);
    };
    this.at(this.now + n.num('failoverS') * 1000, decide);
  }

  /**
   * Make `best` the primary of its shard. Replication is asynchronous: the writes it had not
   * applied are lost. Every copy follows the new primary from now on (older replication work is dropped).
   * `split`: the old primary still runs, cut off by a network partition.
   */
  private promote(n: NodeRT, shard: number, best: Instance, primary: Instance, split: boolean): void {
    const per = 1 + n.num('replicas');
    const base = shard * per;
    const lost = best.commits!.size + best.missed;
    for (let r = 0; r < per; r++) {
      const i = n.insts[base + r];
      i.replEpoch++;
      i.missed = 0;
      // close the queue-time area before the queue changes
      i.touch(this.now);
      // replication work for the old primary is dropped, so it does not hold the new primary's slots
      const keep = i.q.drain().filter((j) => j.replEpoch === undefined);
      for (const j of keep) i.q.push(j);
      for (const j of [...i.inflight]) {
        if (j.replEpoch === undefined) continue;
        this.release(i, j);
        j.dead = true;
      }
      i.pending!.clear();
      i.commits!.clear();
      i.pendingAt!.clear();
    }
    n.prim[shard] = best.idx - base;
    n.w.failovers++;
    n.w.lostWrites += lost;
    const was = best.role;
    [best.role, primary.role] = [primary.role, best.role];
    this.log({
      node: n.id,
      type: 'failover',
      text: split
        ? t('{name} failover：副本那一側連不到主庫，「{rep}」升為主庫（遺失 {k} 筆寫入）；舊主庫還在跑', { name: n.label, rep: was, k: lost })
        : lost
          ? t('{name} failover：「{rep}」升為主庫，遺失 {k} 筆還沒複製過去的寫入', { name: n.label, rep: was, k: lost })
          : t('{name} failover：「{rep}」升為主庫，沒有遺失寫入', { name: n.label, rep: was }),
    });
  }

  // -------------------------------------------------------------------------------------------
  // DNS failover

  /** No instance can serve (or the node itself is down). */
  private nodeDown(n: NodeRT): boolean {
    // a database's instances of shards a later reshard adds serve nothing yet
    const insts = n.kind === 'database' || n.kind === 'sharded_db' ? n.insts.slice(0, n.shardsNow * (1 + n.num('replicas'))) : n.insts;
    return n.down || (insts.length > 0 && !insts.some((i) => i.state === 'on' && !i.down));
  }

  /**
   * Every second the DNS checks each target. A target that has been down for detectS leaves the
   * answer; one that has been up for detectS comes back.
   */
  private scheduleDnsChecks(n: NodeRT): void {
    for (const e of n.out) if (!e.side) n.dns.set(e, { up: true, since: -Infinity, flip: null });
    const detect = n.num('detectS') * 1000;
    const check = () => {
      this.control(n, t('DNS 健康檢查'), checkNow);
      if (this.now + 1000 < this.durationMs) this.at(this.now + 1000, check);
    };
    const checkNow = () => {
      for (const [e, s] of n.dns) {
        if (this.nodeDown(e.to) !== s.up) {
          s.flip = null;
          continue;
        }
        s.flip ??= this.now;
        if (this.now - s.flip < detect) continue;
        s.up = !s.up;
        s.since = this.now;
        s.flip = null;
        this.log({
          node: n.id,
          type: s.up ? 'dns_in' : 'dns_out',
          text: s.up ? t('{dns}把{name}放回答案', { dns: n.label, name: e.to.label }) : t('{dns}把{name}從答案拿掉（客戶端快取 {ttl} 秒）', { dns: n.label, name: e.to.label, ttl: n.num('ttlS') }),
        });
      }
    };
    this.at(1000, check);
  }

  /**
   * DNS with failover: the client's cached answer picks the target by weight. After the answer
   * changed, the share of clients that already have the new answer grows from 0 to 1 over the TTL
   * (a request that misses the client cache looks it up and has it at once);
   * the others still use the old one (a removed target: still sent to it; a target put back: not yet).
   */
  private dnsPick(n: NodeRT, op: Op, api: string | undefined, lookedUp: boolean): EdgeRT | null {
    const first = this.pickEdge(n, op, api);
    const s = first && n.dns.get(first);
    if (!first || !s) return first;
    const ttl = n.num('ttlS') * 1000;
    const fresh = ttl <= 0 ? 1 : Math.min(1, (this.now - s.since) / ttl);
    // a request that looked the name up (cache miss) always gets the current answer
    const hasNew = lookedUp || fresh >= 1 || n.rng() < fresh;
    const out = (e: EdgeRT) => !n.dns.get(e)!.up;
    if (s.up) {
      if (hasNew) return first;
      // put back recently: a client with the old answer picks among the others in it
      return this.pickEdge(n, op, api, (e) => e === first || out(e)) ?? first;
    }
    // removed: a client with the old answer still sends to it; one with the new answer picks
    // among the targets in it (none left: the old one)
    if (!hasNew) return first;
    return this.pickEdge(n, op, api, out) ?? first;
  }

  /** Router behaviour: forward to one matching downstream edge; no edge means "answer here". */
  private forwardOne(n: NodeRT, req: Req, op: Op, done: Done, from?: Instance): void {
    const e = this.pickEdge(n, op, req.api);
    if (!e) {
      done({ ok: true });
      return;
    }
    this.callEdge(e, req, op, done, undefined, from);
  }

  /** Wrap `done` so the node counts its outcome. */
  private counted(n: NodeRT, done: Done): Done {
    return (o) => {
      if (o.ok) n.w.ok++;
      else n.w.fail++;
      done(o);
    };
  }

  /**
   * Rate limiter: a token bucket (requests per second), a cap on requests in flight (sent on and
   * not answered yet), or both; shared by all requests or one per client (tenant).
   */
  private limit(n: NodeRT, req: Req, op: Op, done: Done): void {
    if (n.str('appliesTo') === 'batch' && req.pri !== 2) {
      this.forwardOne(n, req, op, this.counted(n, done));
      return;
    }
    const id = n.str('scope') === 'per_client' ? req.client : '';
    let b = n.buckets.get(id);
    if (!b) {
      b = { tokens: n.num('burst'), last: this.now, inflight: 0 };
      n.buckets.set(id, b);
    }
    const mode = n.str('limit');
    const byRate = mode !== 'concurrency';
    const byConc = mode !== 'rate';
    if (byRate) {
      b.tokens = Math.min(n.num('burst'), b.tokens + (this.now - b.last) * (n.num('ratePerSec') / 1000));
      b.last = this.now;
    }
    if ((byRate && b.tokens < 1) || (byConc && b.inflight >= n.num('maxConcurrent'))) {
      this.reject(n, 'rate_limited', done);
      return;
    }
    if (byRate) b.tokens -= 1;
    let reply = this.counted(n, done);
    if (byConc) {
      const bucket = b;
      bucket.inflight++;
      let open = true;
      const inner = reply;
      reply = (o) => {
        if (open) {
          open = false;
          bucket.inflight--;
        }
        inner(o);
      };
    }
    this.forwardOne(n, req, op, reply);
  }

  private reject(n: NodeRT, reason: FailReason, done: Done): void {
    n.w.origin[reason]++;
    n.w.fail++;
    done({ ok: false, reason });
  }

  /** `via`: the edge the request came over (its caller's region). */
  // -------------------------------------------------------------------------------------------
  // Function (like AWS Lambda): one request per execution environment. A request takes a warm idle
  // environment, else starts a new one (a cold start, part of its latency) while the environments
  // are below maxConcurrency and the scaling rate allows; otherwise it is throttled (429). An
  // environment idle for idleS is reclaimed. Environments are made when first needed and reused
  // after they are reclaimed, so a node has at most as many as it ran at once.

  /** A new environment (off), joined to the queues that feed the function. */
  private fnEnv(n: NodeRT): Instance {
    const inst = new Instance(n, n.insts.length, 1, 0);
    inst.state = 'off';
    inst.role = `#${inst.idx}`;
    inst.region = n.region;
    inst.lastT = this.now;
    n.insts.push(inst);
    for (const f of n.fnQueues) this.fnConsume(inst, f.qs, f.edge);
    return inst;
  }

  private fnConsume(inst: Instance, qs: QueueNodeState, edge: EdgeRT): void {
    inst.pullFrom.push(qs);
    if (!inst.edgeFrom.has(qs)) inst.edgeFrom.set(qs, edge);
  }

  /** The most recently idle environment that is still free, or null. */
  private fnWarm(n: NodeRT): Instance | null {
    let inst: Instance | undefined;
    while ((inst = n.fnIdle.pop())) {
      inst.inIdle = false;
      if (inst.state === 'on' && !inst.down && inst.busy === 0) return inst;
    }
    return null;
  }

  private fnIdleNow(inst: Instance): void {
    const n = inst.node;
    inst.idleAt = this.now;
    if (!inst.inIdle) {
      inst.inIdle = true;
      n.fnIdle.push(inst);
    }
    if (!n.fnSweep) this.fnScheduleSweep(n);
  }

  /** Reclaim environments idle for idleS; checked every min(idleS, 10) s while some are up. */
  private fnScheduleSweep(n: NodeRT): void {
    const idleMs = n.num('idleS') * 1000;
    const next = this.now + Math.min(idleMs, 10_000);
    if (next >= this.durationMs) return;
    n.fnSweep = true;
    this.at(next, () => {
      n.fnSweep = false;
      const keep: Instance[] = [];
      for (const inst of n.fnIdle) {
        if (inst.state !== 'on' || inst.busy > 0 || inst.down) {
          inst.inIdle = false;
          continue;
        }
        if (!inst.kept && this.now - inst.idleAt >= idleMs) {
          inst.touch(this.now);
          inst.state = 'off';
          inst.inIdle = false;
          n.fnLive--;
          n.fnOff.push(inst);
        } else keep.push(inst);
      }
      n.fnIdle = keep;
      if (keep.some((i) => !i.kept)) this.fnScheduleSweep(n);
    });
  }

  /** Start a new environment (state boot), or null when the limit or the scaling rate says no. */
  private fnLaunch(n: NodeRT): Instance | null {
    if (n.fnLive >= n.num('maxConcurrency')) return null;
    // scaling rate: scalePer10s new environments per 10 s, as a token bucket that starts full
    const rate = n.num('scalePer10s');
    n.fnTokens = Math.min(rate, n.fnTokens + ((this.now - n.fnTokT) * rate) / 10_000);
    n.fnTokT = this.now;
    if (n.fnTokens < 1) return null;
    n.fnTokens -= 1;
    const inst = n.fnOff.pop() ?? this.fnEnv(n);
    inst.touch(this.now);
    inst.state = 'boot';
    n.fnLive++;
    if (n.fnLive > n.fnPeak) n.fnPeak = n.fnLive;
    n.w.coldStarts++;
    return inst;
  }

  /**
   * The environment is ready after coldStartMs; then `ready` runs. `crashed`: it went down during
   * the cold start (even if it is up again): the request that waited for it fails.
   */
  private fnBoot(n: NodeRT, inst: Instance, ready: (crashed: boolean) => void): void {
    this.pending++;
    const gen = inst.crashes;
    this.at(this.now + this.dur(n, 'coldStartMs'), () => {
      this.pending--;
      inst.touch(this.now);
      inst.state = 'on';
      ready(inst.crashes !== gen);
    });
  }

  /** An environment that is up and has no work goes back to the idle pool (or it would count toward the limit for ever). */
  private fnSettle(inst: Instance): void {
    if (inst.busy === 0 && inst.state === 'on' && !inst.down) this.fnIdleNow(inst);
  }

  /** submit() may start no work (the deadline passed, the environment is down): then the environment is idle again. */
  private fnSubmit(inst: Instance, req: Req, op: Op, done: Done, hop?: TraceHop, direct = false): void {
    this.submit(inst, req, op, done, hop, direct);
    this.fnSettle(inst);
  }

  private invoke(n: NodeRT, req: Req, op: Op, done: Done, hop?: TraceHop, direct = false): void {
    if (n.down) return this.reject(n, 'down', done);
    const warm = this.fnWarm(n);
    if (warm) return this.fnSubmit(warm, req, op, done, hop, direct);
    const cold = this.fnLaunch(n);
    if (!cold) return this.reject(n, 'rate_limited', done);
    this.fnBoot(n, cold, (crashed) => {
      if (!crashed) return this.fnSubmit(cold, req, op, done, hop, direct);
      this.reject(n, 'down', done);
      this.fnSettle(cold);
    });
  }

  private handle(n: NodeRT, req: Req, op: Op, done: Done, inst?: Instance, hop?: TraceHop, via?: EdgeRT, direct = false): void {
    const fromRegion = via?.fromRegion;
    // a network partition: the call never arrives (the caller times out); stations check the
    // instance's region below. A function's environments are all in the node's region.
    const whole = !n.insts.length || n.kind === 'function';
    if (whole && this.cut(fromRegion, n.region)) return;
    if (this.anyPartition && whole) done = this.overCut(fromRegion, n.region, done);
    if (via && whole && fromRegion && n.region && fromRegion !== n.region) via.w.crossRegion++;
    n.w.arrivals++;
    if (n.down && !n.insts.length) {
      this.reject(n, 'down', done);
      return;
    }
    switch (n.kind) {
      case 'client':
        this.reject(n, 'error', done);
        return;
      case 'dns': {
        const miss = n.rng() >= n.num('resolverCacheHit');
        const extra = miss ? this.dur(n, 'lookupMs') : 0;
        if (miss) n.w.misses++;
        else n.w.hits++;
        const gen = n.crashes;
        this.at(this.now + extra, () => {
          // the node failed while the request was in it (even if it is back already)
          if (n.crashes !== gen) return this.reject(n, 'down', done);
          const e = n.dns.size ? this.dnsPick(n, op, req.api, miss) : this.pickEdge(n, op, req.api);
          const d = this.counted(n, done);
          if (e) this.callEdge(e, req, op, d);
          else d({ ok: true });
        });
        return;
      }
      case 'cdn': {
        const d = this.dur(n, 'edgeMs');
        const gen = n.crashes;
        this.at(this.now + d, () => {
          if (n.crashes !== gen) return this.reject(n, 'down', done);
          if (op === READ && n.rng() < n.num('hitRatio')) {
            n.w.hits++;
            n.w.ok++;
            done({ ok: true, hit: true });
            return;
          }
          if (op === READ) n.w.misses++;
          this.forwardOne(n, req, op, this.counted(n, done));
        });
        return;
      }
      case 'load_balancer': {
        const d = this.dur(n, 'latencyMs');
        const gen = n.crashes;
        this.at(this.now + d, () => (n.crashes !== gen ? this.reject(n, 'down', done) : this.balance(n, req, op, this.counted(n, done))));
        return;
      }
      case 'rate_limiter':
        this.limit(n, req, op, done);
        return;
      case 'circuit_breaker':
        this.breaker(n, req, op, done);
        return;
      case 'queue':
        this.enqueue(n, req, op, done);
        return;
      case 'function':
        this.invoke(n, req, op, done, hop, direct);
        return;
      case 'api_gateway':
      case 'service':
      case 'worker':
      case 'cache':
      case 'database':
      case 'sharded_db':
      case 'object_storage': {
        // an instance picked by a load balancer may have been scaled in while the request travelled
        const target = inst && inst.state !== 'off' ? inst : this.pickInstance(n, req, op, fromRegion);
        if (!target) {
          this.reject(n, 'down', done);
          return;
        }
        if (this.cut(fromRegion, target.region)) {
          n.w.arrivals--;
          return;
        }
        if (this.anyPartition) done = this.overCut(fromRegion, target.region, done);
        // the instance's region, not the node's: a replica in another region, or a primary moved there by a failover
        if (via && fromRegion && target.region && fromRegion !== target.region) via.w.crossRegion++;
        // the edge carried the local latency only; an instance in another region than the caller is a trip across each way
        const extra = via?.perInstance && target.region && target.region !== fromRegion ? Math.max(0, this.interRegionMs - via.latency) : 0;
        if (!extra) {
          this.submit(target, req, op, done, hop, direct);
          return;
        }
        this.pending++;
        this.at(this.now + extra, () => {
          this.pending--;
          this.submit(target, req, op, (o) => {
            this.pending++;
            this.at(this.now + extra, () => {
              this.pending--;
              done(o);
            });
          }, hop, direct);
        });
        return;
      }
      default:
        done({ ok: true });
    }
  }

  /** A sampled duration of parameter k; `slowed` false leaves out the slow events (the caller applies them). */
  private dur(n: NodeRT, k: string, inst?: Instance, slowed = true): number {
    const d = n.dist(k);
    let mean = d.mean * (slowed ? n.slow * (inst ? inst.slow : 1) : 1);
    // cold start: a new instance starts coldFactor× slower and warms up linearly over warmS
    if (inst && inst.warmUntil > this.now) {
      const left = (inst.warmUntil - this.now) / (n.num('warmS') * 1000);
      mean *= 1 + (n.num('coldFactor') - 1) * left;
    }
    return sampleDuration(n.rng, mean, d.cv);
  }

  /**
   * When `work` ms of processing that starts now on `inst` is done. A stop-the-world pause (GC)
   * freezes the whole process, so work only advances outside pauses: a job that overlaps a pause
   * takes longer, and a job that starts during one waits for it to end. Each instance collects
   * garbage on its own: instance i's pauses are shifted by i / instances of the period.
   */
  private workEnd(n: NodeRT, inst: Instance, work: number): number {
    let cur = this.now;
    if (!n.pauses.length) return cur + work;
    const shift = n.insts.length > 1 ? inst.idx / n.insts.length : 0;
    let rem = work;
    for (;;) {
      // the earliest pause (of any rule) that has not ended yet
      let ps = Infinity;
      let pe = Infinity;
      for (const p of n.pauses) {
        const t0 = p.t0 + shift * p.every;
        // pauses as long as their period never let go (a scenario check rejects this; do not loop on it)
        if (p.ms >= p.every && cur >= t0 && cur < p.t1) {
          ps = cur;
          pe = p.t1;
          break;
        }
        let k = cur < t0 ? 0 : Math.floor((cur - t0) / p.every);
        if (t0 + k * p.every + p.ms <= cur) k++;
        const s0 = t0 + k * p.every;
        if (s0 >= p.t1) continue;
        if (s0 < ps) {
          ps = s0;
          pe = s0 + p.ms;
        }
      }
      if (ps >= cur + rem) return cur + rem;
      if (ps > cur) rem -= ps - cur;
      if (pe === Infinity) return Infinity;
      cur = pe;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Load balancing

  /**
   * Does load balancer `n` send to this target? It always knows which instances are registered
   * (autoscaling). With healthCheck 'instant' it also knows at once which are down; otherwise it
   * only knows what its probes told it. Outlier detection removes an instance for a while.
   */
  private healthy(n: NodeRT, t: { edge: EdgeRT; inst: Instance | null }): boolean {
    const inst = t.inst;
    if (!inst) return !t.edge.to.down;
    if (inst.state !== 'on') return false;
    const s = n.hc.get(inst);
    if (s && s.ejectUntil > this.now) return false;
    if (n.str('healthCheck') === 'instant') return !inst.down;
    return s ? s.up : true;
  }

  private hcState(n: NodeRT, inst: Instance): HcState {
    let s = n.hc.get(inst);
    if (!s) {
      s = { up: true, fails: 0, passes: 0, streak: 0, ejectUntil: 0 };
      n.hc.set(inst, s);
    }
    return s;
  }

  /** Each instance behind the load balancer is probed every hcIntervalS; the probes are spread over the interval. */
  private scheduleHealthChecks(n: NodeRT): void {
    if (n.str('healthCheck') === 'instant') return;
    const insts = [...new Set([...this.lbTargets(n, READ, undefined), ...this.lbTargets(n, WRITE, undefined)].map((t) => t.inst).filter((i): i is Instance => i !== null))];
    const every = n.num('hcIntervalS') * 1000;
    insts.forEach((inst, k) => {
      const next = (at: number): void => {
        if (at >= this.durationMs) return;
        this.at(at, () => {
          this.probe(n, inst);
          next(at + every);
        });
      };
      next((every * (k + 1)) / insts.length);
    });
  }

  /**
   * One health check. A liveness probe only fails on a crashed instance. A deep probe runs like a
   * request: it fails with the instance's error rate, and when its expected time (service time
   * with any slowdown, plus the wait for the requests queued ahead) exceeds hcTimeoutMs.
   */
  private probe(n: NodeRT, inst: Instance): void {
    if (inst.state !== 'on') return;
    let ok = !inst.down;
    if (ok && n.str('healthCheck') === 'deep') {
      const tn = inst.node;
      const er = inst.errRate(tn.errorRate());
      const d = (tn.p.serviceMs ?? tn.p.getMs) as Dist | undefined;
      const est = d ? d.mean * tn.slow * inst.slow * (1 + inst.q.length / Math.max(1, inst.slots)) : 0;
      ok = !(er > 0 && n.hcRng() < er) && est <= n.num('hcTimeoutMs');
    }
    const s = this.hcState(n, inst);
    const thr = n.num('hcThreshold');
    const name = { name: n.label, target: inst.node.label, i: inst.idx };
    if (ok) {
      s.fails = 0;
      s.passes++;
      if (!s.up && s.passes >= thr) {
        s.up = true;
        this.log({ node: n.id, type: 'hc_in', text: t('{name}的 health check 把「{target}」第 {i} 台放回', name) });
      }
    } else {
      s.passes = 0;
      s.fails++;
      if (s.up && s.fails >= thr) {
        s.up = false;
        n.w.hcOut++;
        this.log({ node: n.id, type: 'hc_out', text: t('{name}的 health check 把「{target}」第 {i} 台移出', name) });
      }
    }
  }

  /**
   * Outlier detection (passive health checking, as in Envoy): after outlierErrors failed replies in
   * a row (error, timeout, down) from one instance, stop sending to it for ejectS. Failures that a
   * dependency caused count too, as they do in a real proxy. At most half of the instances behind
   * one edge (at least one) are ejected at the same time.
   */
  private outlierNote(n: NodeRT, inst: Instance, o: Outcome, peers: Instance[]): void {
    const s = this.hcState(n, inst);
    if (o.ok) {
      s.streak = 0;
      return;
    }
    // like Envoy's consecutive 5xx: errors, timeouts, down and overload replies (503: queue full,
    // shed, CoDel) count; any other reply (a 429 from a rate limiter) breaks the streak
    const bad = ['error', 'timeout', 'down', 'queue_full', 'shed', 'codel'];
    if (!bad.includes(o.reason ?? '')) {
      s.streak = 0;
      return;
    }
    if (s.ejectUntil > this.now || ++s.streak < n.num('outlierErrors')) return;
    // the cap is half of the instances that serve now (autoscaled nodes keep their extra instances
    // off); every active ejection counts against it, also of an instance that crashed since: it is
    // still ejected when it comes back, so sequential crashes cannot eject the whole pool
    const on = peers.filter((p) => p.state === 'on');
    const serving = on.filter((p) => !p.down);
    const ejected = on.filter((p) => (n.hc.get(p)?.ejectUntil ?? 0) > this.now).length;
    if (ejected + 1 > Math.max(1, Math.floor(serving.length / 2))) return;
    s.streak = 0;
    s.ejectUntil = this.now + n.num('ejectS') * 1000;
    n.w.ejections++;
    this.log({ node: n.id, type: 'eject', text: t('{name}暫時剔除「{target}」第 {i} 台（連續 {k} 次失敗）', { name: n.label, target: inst.node.label, i: inst.idx, k: n.num('outlierErrors') }) });
  }

  private balance(n: NodeRT, req: Req, op: Op, done: Done): void {
    const all = this.lbWeighted(n, this.lbTargets(n, op, req.api));
    const policy = n.str('policy');
    const instant = n.str('healthCheck') === 'instant';
    const choose = (cands: { edge: EdgeRT; inst: Instance | null }[]): { edge: EdgeRT; inst: Instance | null } | null => {
      let pred = (t: { edge: EdgeRT; inst: Instance | null }) => this.healthy(n, t);
      let ok = cands.filter(pred);
      // fail open: when its checks have taken out every instance, a load balancer sends to all registered ones
      if (!ok.length && !instant) {
        pred = (t) => (t.inst ? t.inst.state === 'on' : !t.edge.to.down);
        ok = cands.filter(pred);
      }
      if (!ok.length) return null;
      const load = (t: { edge: EdgeRT; inst: Instance | null }) => (t.inst ? t.inst.active : 0);
      switch (policy) {
        case 'random':
          return ok[Math.floor(n.rng() * ok.length)];
        case 'least_conn': {
          const start = Math.floor(n.rng() * ok.length);
          let best = ok[start];
          for (let i = 1; i < ok.length; i++) {
            const t = ok[(start + i) % ok.length];
            if (load(t) < load(best)) best = t;
          }
          return best;
        }
        case 'p2c': {
          if (ok.length === 1) return ok[0];
          const a = Math.floor(n.rng() * ok.length);
          let b = Math.floor(n.rng() * (ok.length - 1));
          if (b >= a) b++;
          return load(ok[b]) < load(ok[a]) ? ok[b] : ok[a];
        }
        default: {
          // round robin over all targets, skipping unhealthy ones
          for (let i = 0; i < cands.length; i++) {
            const t = cands[n.rr++ % cands.length];
            if (pred(t)) return t;
          }
          return null;
        }
      }
    };
    const first = choose(all);
    if (!first) {
      // `done` already counts the outcome on this node (see handle), so only mark the origin here
      n.w.origin.down++;
      done({ ok: false, reason: 'down' });
      return;
    }
    // A retry picks again among the same downstream node's instances (often a different one).
    const sameEdge = all.filter((t) => t.edge === first.edge);
    let attempt = 0;
    this.callEdge(first.edge, req, op, done, {
      pick: (avoid) => {
        const others = avoid ? sameEdge.filter((x) => x.inst !== avoid) : sameEdge;
        const t = attempt++ === 0 ? first : (choose(others) ?? (avoid ? choose(sameEdge) : null) ?? first);
        if (t.inst) t.inst.active++;
        return t.inst;
      },
      settle: (inst) => {
        if (!inst) return;
        inst.active--;
        if (inst.state === 'retiring') this.maybeRetired(inst);
      },
      report: n.str('outlier') === 'on'
        ? (inst, o) => {
          if (inst) this.outlierNote(n, inst, o, [...new Set(sameEdge.map((t) => t.inst).filter((i): i is Instance => i !== null))]);
        }
        : undefined,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Stations

  private pickInstance(n: NodeRT, req: Req, op: Op, fromRegion?: string, shard?: number): Instance | null {
    const insts = n.insts;
    if (n.kind === 'cache') {
      const inst = insts[keyBucket(req.key, insts.length)];
      return inst.down ? null : inst;
    }
    if (n.kind === 'database' || n.kind === 'sharded_db') {
      const per = 1 + n.num('replicas');
      const shards = n.shardsNow;
      const s = shard ?? (shards > 1 ? keyBucket(req.key, shards) : 0);
      const base = s * per;
      const primary = insts[base + n.prim[s]];
      // split brain: this side cannot reach the new primary, but the old one still runs here
      const z = n.zombie[s];
      if (z && !z.inst.down && this.cut(fromRegion, primary.region) && !this.cut(fromRegion, z.inst.region)) {
        if (op !== READ) return n.str('fencing') === 'on' ? null : z.inst;
        if (n.str('readFrom') === 'primary' || per === 1) return z.inst;
      }
      if (op !== READ) return primary.down ? null : primary;
      const from = n.str('readFrom');
      if (from === 'primary' || per === 1) return primary.down ? null : primary;
      // read-your-writes: soon after the user's own write, read where it is committed
      if (req.wroteAt !== undefined && n.str('readYourWrites') === 'primary' && this.now - req.wroteAt <= n.num('rywWindowMs') && !primary.down) return primary;
      const group: Instance[] = [];
      if (from === 'any') group.push(primary);
      for (let r = 0; r < per; r++) if (r !== n.prim[s]) group.push(insts[base + r]);
      const maxLag = n.num('maxLagMs');
      // replicas in the caller's region first (a read across regions is slower)
      const local = fromRegion ? group.filter((i) => i.region === fromRegion) : [];
      for (const g of local.length && local.length < group.length ? [local, group] : [group]) {
        for (let i = 0; i < g.length; i++) {
          const inst = g[n.rr++ % g.length];
          if (inst.down || this.cut(fromRegion, inst.region)) continue;
          if (maxLag > 0 && inst.lag(this.now) > maxLag) continue; // too far behind: skip it
          return inst;
        }
      }
      // all replicas down (or too far behind, or cut off): read the primary (the old one, when this side has only that)
      if (z && !z.inst.down && this.cut(fromRegion, primary.region) && !this.cut(fromRegion, z.inst.region)) return z.inst;
      return primary.down ? null : primary;
    }
    // round robin, skipping instances that are down (or not serving: autoscaling)
    for (let i = 0; i < insts.length; i++) {
      const inst = insts[n.rr++ % insts.length];
      if (inst.serving()) return inst;
    }
    return null;
  }

  private submit(inst: Instance, req: Req, op: Op, done: Done, hop?: TraceHop, direct = false): void {
    const n = inst.node;
    // a request the new version turns away (down, queue full, shed, dropped, expired) counts against it
    const rolled = (): void => {
      if (inst.rollout) inst.rollout.fail++;
    };
    if (inst.down) {
      rolled();
      this.reject(n, 'down', done);
      return;
    }
    const job: Job = {
      req,
      op,
      tq: this.now,
      ts: 0,
      dead: false,
      hop,
      ...(direct ? { direct } : {}),
      run: (j, i) => this.runJob(j, i, done),
      fail: (reason) => {
        rolled();
        n.w.origin[reason]++;
        n.w.fail++;
        done({ ok: false, reason });
      },
      // not a failure of this node: the caller had already given up
      expire: () => {
        rolled();
        n.w.expired++;
        done({ ok: false, reason: 'timeout' });
      },
    };
    if (hop) hop.inst = inst.idx;
    inst.touch(this.now);
    // priority load shedding: past the threshold, batch requests are turned away before queueing
    const shedAt = n.num('shedAt');
    if (shedAt > 0 && req.pri === 2 && inst.busy >= inst.slots && inst.q.length >= shedAt * inst.queueLimit) {
      job.fail('shed');
      return;
    }
    if (inst.busy < inst.slots) {
      this.start(inst, job);
    } else if (inst.q.length < inst.queueLimit) {
      if (!inst.q.length) inst.qEmptyAt = this.now;
      inst.q.push(job);
      if (inst.q.length > inst.w.maxQ) inst.w.maxQ = inst.q.length;
    } else {
      inst.w.rejected++;
      job.fail('queue_full');
    }
  }

  private start(inst: Instance, job: Job): void {
    if (job.expire && job.req.deadline !== undefined && this.now >= job.req.deadline) {
      job.expire();
      return;
    }
    inst.busy++;
    job.ts = this.now;
    inst.w.started++;
    const wait = this.now - job.tq;
    if (wait > 0) inst.w.waited++;
    inst.w.waitSum += wait;
    if (job.hop) job.hop.tStart = this.now;
    inst.inflight.add(job);
    job.run(job, inst);
  }

  /** Drop queued jobs whose propagated deadline has passed (they would expire when started). */
  private purgeExpired(inst: Instance): void {
    if (!inst.q.length) return;
    const all = inst.q.drain();
    const expired: Job[] = [];
    for (const job of all) {
      if (job.expire && job.req.deadline !== undefined && this.now >= job.req.deadline) expired.push(job);
      else inst.q.push(job);
    }
    for (const job of expired) job.expire!();
  }

  private failJob(inst: Instance, job: Job, reason: FailReason): void {
    void inst;
    job.fail(reason);
  }

  /** Free a slot and start the next job (local queue first, then any queue we pull from). */
  private release(inst: Instance, job: Job): void {
    if (job.dead || job.released) return;
    job.released = true;
    inst.inflight.delete(job);
    inst.touch(this.now);
    inst.busy--;
    const hold = this.now - job.ts;
    inst.w.holds++;
    inst.w.holdSum += hold;
    inst.w.holdSq += hold * hold;
    this.pull(inst);
    if (inst.state === 'retiring') this.maybeRetired(inst);
    if (inst.node.kind === 'function' && inst.busy === 0 && inst.state === 'on' && !inst.down) this.fnIdleNow(inst);
  }

  private pull(inst: Instance): void {
    if (inst.down || inst.state === 'off' || inst.state === 'boot') return;
    const n = inst.node;
    const front = n.kind === 'service' || n.kind === 'api_gateway';
    const order = front ? n.str('queueOrder') : 'fifo';
    const target = front ? n.num('codelTargetMs') : 0;
    while (inst.busy < inst.slots && inst.q.length) {
      // overloaded (Facebook's CoDel): the queue has not been empty for a whole interval
      const over = this.now - inst.qEmptyAt >= CODEL_INTERVAL_MS;
      const job = order === 'lifo' || (order === 'adaptive_lifo' && over) ? inst.q.pop()! : inst.q.shift()!;
      if (!inst.q.length) inst.qEmptyAt = this.now;
      // CoDel: a request that waited too long is dropped at once instead of served late
      const expired = job.expire && job.req.deadline !== undefined && this.now >= job.req.deadline;
      if (target > 0 && !expired && this.now - job.tq > (over ? target : CODEL_INTERVAL_MS)) {
        // not counted in rejected: that counter means the queue was full
        job.fail('codel');
        continue;
      }
      this.start(inst, job);
    }
    // a retiring instance finishes its own queue but takes no new messages
    if (inst.state === 'on' && inst.busy < inst.slots && inst.pullFrom.length) {
      for (const qs of inst.pullFrom) {
        while (inst.busy < inst.slots && qs.msgs.length) this.deliver(qs, inst);
        if (inst.busy >= inst.slots) break;
      }
    }
  }

  private runJob(job: Job, inst: Instance, done: Done): void {
    const n = inst.node;
    const req = job.req;
    const op = job.op;
    const finish = (o: Outcome): void => {
      if (job.dead) return;
      this.release(inst, job);
      if (job.hop) job.hop.tReply = this.now;
      if (inst.rollout) {
        if (o.ok) inst.rollout.ok++;
        else inst.rollout.fail++;
      }
      if (o.ok) n.w.ok++;
      else if (!o.reason || o.reason === 'error') {
        n.w.fail++;
      } else n.w.fail++;
      done(o);
    };
    const maybeError = (): boolean => {
      const er = inst.errRate(n.errorRate());
      if (er > 0 && n.rng() < er) {
        n.w.origin.error++;
        return true;
      }
      return false;
    };
    switch (n.kind) {
      case 'api_gateway': {
        this.at(this.workEnd(n, inst, this.dur(n, 'serviceMs', inst)), () => {
          if (job.dead) return;
          // a gateway has no error rate of its own; a bad version (a config push) still fails
          if (inst.verErr > 0 && n.rng() < inst.verErr) {
            n.w.origin.error++;
            return finish({ ok: false, reason: 'error' });
          }
          this.forwardOne(n, req, op, finish, inst);
        });
        return;
      }
      case 'service':
      case 'worker':
      case 'function': {
        this.at(this.workEnd(n, inst, this.dur(n, 'serviceMs', inst)), () => {
          if (job.dead) return;
          if (maybeError()) return finish({ ok: false, reason: 'error' });
          // a poison message fails every time it is processed
          const pr = n.num('poisonRate');
          if (pr > 0 && unitHash(req.id) < pr) {
            n.w.origin.error++;
            return finish({ ok: false, reason: 'error' });
          }
          this.execPlan(n, req, op, finish, inst);
        });
        return;
      }
      case 'cache': {
        this.at(this.workEnd(n, inst, this.dur(n, 'opMs', inst)), () => {
          if (job.dead) return;
          // a cache has no error rate of its own; a bad version still fails
          if (inst.verErr > 0 && n.rng() < inst.verErr) {
            n.w.origin.error++;
            return finish({ ok: false, reason: 'error' });
          }
          this.cacheOp(n, inst, job, finish);
        });
        return;
      }
      case 'database':
      case 'sharded_db': {
        // the replicas apply a write at their own speed: keep its duration without this slowdown
        const unslowed = op === WRITE ? this.dur(n, 'writeMs', inst, false) : 0;
        const d = op === WRITE ? unslowed * n.slow * inst.slow : this.dur(n, 'readMs', inst);
        const locks = op === WRITE && !job.direct ? inst.locks : null;
        const work = (): void => {
          const gen = inst.crashes;
          this.at(this.workEnd(n, inst, d), () => {
            // the transaction holds the row lock until it commits
            const commit = (): void => {
              if (locks && inst.crashes === gen) this.unlock(locks, req.key);
              if (job.dead) return;
              if (maybeError()) return finish({ ok: false, reason: 'error' });
              if (op === WRITE) {
                const z = n.zombie.find((x) => x?.inst === inst);
                // demoted while the write ran (the partition healed): it is not the primary any more
                const stale = !z && !job.direct && !this.isPrimary(n, inst);
                // fencing: the old primary's epoch is stale, so even a write already running cannot commit
                if ((z || stale) && n.str('fencing') === 'on') {
                  n.w.origin.down++;
                  return finish({ ok: false, reason: 'down' });
                }
                if (!job.direct) this.replicate(n, inst, unslowed, req.key);
                req.committedAt = this.now;
                req.onCommit?.(inst);
                if (z) z.writes++;
                // committed on a primary nobody follows: the new primary never sees it
                if (z || stale) n.w.divergentWrites++;
                if (stale) this.lateDivergence(n);
              } else if (inst.pending && !this.isPrimary(n, inst)) {
                n.w.replicaReads++;
                if (inst.pending.has(req.key)) n.w.staleReads++;
                // the user's own write is committed on the primary and not applied here yet
                const at = req.wroteAt !== undefined ? inst.pendingAt?.get(req.key) : undefined;
                if (at && at.some((c) => c <= req.wroteAt!)) n.w.rywMisses++;
              }
              finish({ ok: true });
            };
            const hold = locks ? n.num('lockHoldMs') : 0;
            if (hold > 0) this.at(this.now + hold, commit);
            else commit();
          });
        };
        if (locks) {
          const waiting = locks.get(req.key);
          if (waiting) {
            // another transaction holds this row: wait for it (the connection stays taken)
            n.w.lockWaits++;
            waiting.push(work);
            return;
          }
          locks.set(req.key, []);
        }
        work();
        return;
      }
      case 'object_storage': {
        const d = op === WRITE ? this.dur(n, 'putMs', inst) : this.dur(n, 'getMs', inst);
        this.at(this.workEnd(n, inst, d), () => {
          if (job.dead) return;
          if (maybeError()) return finish({ ok: false, reason: 'error' });
          // a PUT is stored once it completes, even when its caller timed out first
          if (op === WRITE) req.onCommit?.(inst);
          finish({ ok: true });
        });
        return;
      }
      default:
        finish({ ok: true });
    }
  }

  /**
   * After a write on a primary, each replica of that shard receives it after replicaDelayMs and
   * spends writeMs × ratio applying it (writeMs without slowdowns; the slowdown when the work starts applies). From commit until applied, the replica holds the write as
   * pending: reads of that key there return old data, and its age is the replication lag.
   * A write a replica never receives (down, queue full, crash) is counted as dropped and no longer
   * pending: this model does not track a replica that stays permanently behind.
   */
  /** Give a row lock to the next waiting write, or free it. */
  private unlock(locks: Map<number, (() => void)[]>, key: number): void {
    const waiting = locks.get(key);
    if (!waiting) return;
    const next = waiting.shift();
    if (next) next();
    else locks.delete(key);
  }

  private replicate(n: NodeRT, primary: Instance, writeMs: number, key: number): void {
    const ratio = n.num('replicaApplyRatio');
    const per = 1 + n.num('replicas');
    if (ratio <= 0 || per === 1) return;
    // an old primary cut off by a partition: nobody follows it any more
    if (!this.isPrimary(n, primary)) return;
    const base = primary.idx - (primary.idx % per);
    for (let r = 0; r < per; r++) {
      const rep = n.insts[base + r];
      if (rep === primary) continue;
      if (rep.down || this.cut(primary.region, rep.region)) {
        n.w.replDropped++;
        rep.missed++;
        continue;
      }
      // a replica in another region gets the write one inter-region trip later
      const delay = n.num('replicaDelayMs') + (rep.region && primary.region && rep.region !== primary.region ? this.interRegionMs : 0);
      const seq = this.nextCommit++;
      const epoch = rep.replEpoch;
      const crash = primary.crashes;
      rep.pending!.set(key, (rep.pending!.get(key) ?? 0) + 1);
      rep.commits!.set(seq, this.now);
      const committed = this.now;
      const ats = rep.pendingAt!.get(key);
      if (ats) ats.push(committed);
      else rep.pendingAt!.set(key, [committed]);
      let open = true;
      const settle = (applied: boolean): void => {
        if (!open) return;
        open = false;
        // the replica follows a new primary now: this write was counted as lost at the failover
        if (rep.replEpoch !== epoch) return;
        const c = rep.pending!.get(key)! - 1;
        if (c > 0) rep.pending!.set(key, c);
        else rep.pending!.delete(key);
        rep.commits!.delete(seq);
        const ats = rep.pendingAt!.get(key)!;
        ats.splice(ats.indexOf(committed), 1);
        if (!ats.length) rep.pendingAt!.delete(key);
        if (applied) n.w.replApplied++;
        else {
          n.w.replDropped++;
          rep.missed++;
        }
      };
      const cost = writeMs * ratio;
      const job: Job = {
        req: { id: 0, cls: WRITE, key: 0, t0: this.now, settled: true, client: '', pri: 1 },
        op: WRITE,
        tq: this.now,
        ts: 0,
        dead: false,
        replEpoch: epoch,
        run: (j, i) => {
          // a slow database or replica applies writes slowly too: the slowdown when the work starts
          this.at(this.workEnd(n, i, cost * n.slow * i.slow), () => {
            if (j.dead) return;
            this.release(i, j);
            settle(true);
          });
        },
        fail: () => settle(false),
      };
      const send = (): void => {
        // the primary crashed before this write reached the replica: it never will
        if (primary.crashes !== crash) return settle(false);
        if (rep.down || this.cut(primary.region, rep.region)) return settle(false);
        rep.touch(this.now);
        job.tq = this.now;
        if (rep.busy < rep.slots) this.start(rep, job);
        else if (rep.q.length < rep.queueLimit) {
          rep.q.push(job);
          if (rep.q.length > rep.w.maxQ) rep.w.maxQ = rep.q.length;
        } else settle(false);
      };
      if (delay > 0) {
        // shipped later: counted as unfinished work until it reaches the replica
        this.pending++;
        this.at(this.now + delay, () => {
          this.pending--;
          send();
        });
      } else send();
    }
  }

  /** Put `key` in an LRU cache instance, with the node's TTL (and jitter); evicts the oldest when full. */
  private cachePut(n: NodeRT, inst: Instance, key: number): void {
    const lru = inst.lru;
    if (!lru) return;
    const ttl = n.num('ttlS') * 1000;
    lru.delete(key);
    // TTL jitter: each entry lives ttl × (1 − jitter × u), so entries filled together expire apart
    const jitter = n.num('ttlJitter');
    lru.set(key, ttl > 0 ? this.now + (jitter > 0 ? ttl * (1 - jitter * n.rng()) : ttl) : Infinity);
    if (lru.size > inst.lruCap) lru.delete(lru.keys().next().value as number);
  }

  /**
   * Cross-region cache replication: an edge cache → cache copies every set and delete to the
   * other cache after the edge's latency (the inter-region latency when the regions differ). The
   * copy goes to the instance that owns the key, with the target's TTL; it takes no slot there,
   * and a copied change is not copied on (no loops). A target that is down drops it.
   */
  private cacheReplicate(n: NodeRT, key: number, del: boolean): void {
    for (const e of n.out) {
      const dst = e.to;
      if (dst.kind !== 'cache' || !dst.insts.length || e.side) continue;
      // sent across regions (and paid for), even when the partition drops it on the way
      if (n.region && dst.region && n.region !== dst.region) e.w.crossRegion++;
      // sent during a partition: lost on the way, even if the network is back before it would arrive
      if (this.cut(n.region, dst.region)) {
        dst.w.replDropped++;
        continue;
      }
      // on the wire: unfinished work if the run stops first
      this.pending++;
      this.at(this.now + e.latency, () => {
        this.pending--;
        const inst = dst.insts[keyBucket(key, dst.insts.length)];
        if (inst.down || !inst.lru || this.cut(n.region, dst.region)) {
          dst.w.replDropped++;
          return;
        }
        if (del) inst.lru.delete(key);
        else this.cachePut(dst, inst, key);
        dst.w.replApplied++;
      });
    }
  }

  private cacheOp(n: NodeRT, inst: Instance, job: Job, finish: Done): void {
    const key = job.req.key;
    const lru = inst.lru;
    const set = (): void => {
      if (!lru) return;
      this.cachePut(n, inst, key);
      if (n.replicates) this.cacheReplicate(n, key, false);
    };
    if (job.op === CACHE_SET) {
      set();
      inst.leases?.delete(key);
      return finish({ ok: true });
    }
    if (job.op === CACHE_DEL) {
      lru?.delete(key);
      inst.leases?.delete(key);
      if (lru && n.replicates) this.cacheReplicate(n, key, true);
      return finish({ ok: true });
    }
    const stores = this.plan(n, job.op, job.req.api);
    if (job.op === WRITE) {
      // write-through: release the slot, write to the store, then update the cache entry
      if (!stores.length) {
        set();
        return finish({ ok: true });
      }
      const req = job.req;
      // the cache slot is not held while the store works
      this.releaseThen(inst, job, (done) => this.runSteps(n, req, WRITE, stores, (o) => {
        if (o.ok && !o.degraded && !job.dead) set();
        done(o);
      }, inst), finish);
      return;
    }
    let hit: boolean;
    if (lru) {
      const exp = lru.get(key);
      hit = exp !== undefined && exp > this.now;
      if (exp !== undefined) {
        lru.delete(key);
        if (hit) lru.set(key, exp);
      }
    } else hit = n.rng() < n.num('hitRatio');
    if (hit) {
      n.w.hits++;
      return finish({ ok: true, hit: true });
    }
    if (!stores.length) {
      // cache-aside with leases: while another caller holds this key's lease, tell this one to wait
      const leases = inst.leases;
      if (leases) {
        const until = leases.get(key);
        if (until !== undefined && until > this.now) {
          // a "wait" answer is a miss: the caller got no value
          n.w.misses++;
          n.w.leaseWaits++;
          return finish({ ok: true, hit: false, wait: true });
        }
        leases.set(key, this.now + n.num('leaseMs'));
      }
      n.w.misses++;
      return finish({ ok: true, hit: false });
    }
    n.w.misses++;
    const req = job.req;
    // coalescing (singleflight): a miss on a key that is already being fetched waits for that fetch
    const fills = inst.fills;
    const waiting = fills?.get(key);
    if (waiting) {
      n.w.coalesced++;
      this.releaseThen(inst, job, (done) => waiting.push(done), finish);
      return;
    }
    const mine: Done[] = [];
    fills?.set(key, mine);
    // read-through: fetch from the store without holding the cache slot, then fill
    this.releaseThen(inst, job, (done) => this.runSteps(n, req, READ, stores, (o) => {
      // if this cache crashed meanwhile, the job already failed: do not fill the (now empty) cache
      // a fallback answer is not real data: do not put it in the cache
      if (o.ok && !o.degraded && !job.dead) set();
      if (fills && fills.get(key) === mine) fills.delete(key);
      done({ ...o, hit: false });
      for (const d of mine) d({ ...o, hit: false });
    }, inst), finish);
  }

  /** Free the slot now, but answer the caller only after `work` completes. `finish` then skips the release. */
  private releaseThen(inst: Instance, job: Job, work: (done: Done) => void, finish: Done): void {
    this.release(inst, job);
    // still this instance's work: a crash must fail it (see setDown)
    inst.detached.add(job);
    work((o) => {
      inst.detached.delete(job);
      finish(o);
    });
  }

  private execPlan(n: NodeRT, req: Req, op: Op, done: Done, inst?: Instance): void {
    const steps = this.plan(n, op, req.api);
    if (op === WRITE && steps.some(isStoreCall) && steps.some(isQueueCall)) return this.dualWriteSteps(n, req, steps, done, inst);
    this.runSteps(n, req, op, steps, done, inst);
  }

  /**
   * A write that goes to a store and to a queue. Without an outbox they are two separate calls:
   * when one succeeds and the other fails, the data and the message disagree (a dual-write gap).
   * With an outbox the message is written in the same transaction as the data; a relay then sends
   * it to the queue and tries again until it gets there. The request does not wait for the queue.
   */
  private dualWriteSteps(n: NodeRT, req: Req, steps: Step[], done: Done, from?: Instance): void {
    n.dualWrite = true;
    // stored: the store call succeeded, or the store committed the write after the call to it timed
    // out (a fan-out once as many copies committed as its quorum needs: one copy is not enough).
    // A fallback answer delivered nothing.
    let stored = false;
    let sent = false;
    let answered = false;
    // the copies that committed: a retry that commits on the same instance again is still one copy
    const copies = new Set<Instance>();
    const prevCommit = req.onCommit;
    const committed = (copy: Instance): boolean => copies.add(copy).size >= (req.need ?? 1);
    const storeOk = (st: Step, o: Outcome): boolean => isStoreCall(st) && o.ok && !o.fellBack;
    if (n.str('outbox') !== 'on') {
      req.onCommit = (copy) => {
        prevCommit?.(copy);
        if (!committed(copy) || stored) return;
        stored = true;
        // committed after the request answered without its message: a gap found late
        if (answered && !sent) n.w.dualWriteGaps++;
      };
      this.runSteps(n, req, WRITE, steps, (o) => {
        answered = true;
        if (stored !== sent) n.w.dualWriteGaps++;
        done(o);
      }, from, (st, o) => {
        if (o.ok && !o.fellBack && isQueueCall(st)) sent = true;
        if (storeOk(st, o)) stored = true;
      });
      return;
    }
    const relays = steps.filter(isQueueCall);
    let relayed = false;
    const relayAll = (): void => {
      if (relayed) return;
      relayed = true;
      for (const st of relays) this.relay(n, req, st.edge, from);
    };
    req.onCommit = (copy) => {
      prevCommit?.(copy);
      if (!committed(copy)) return;
      stored = true;
      // the message is in the outbox once the data is committed: a commit after the answer too
      if (answered) relayAll();
    };
    this.runSteps(n, req, WRITE, steps.filter((st) => !isQueueCall(st)), (o) => {
      answered = true;
      // even if a later call failed
      if (stored) relayAll();
      done(o);
    }, from, (st, o) => {
      if (storeOk(st, o)) stored = true;
    });
  }

  /** The outbox relay: send the message to the queue; on a failure, again after outboxRetryMs. */
  private relay(n: NodeRT, req: Req, edge: EdgeRT, from?: Instance): void {
    const send = (): void => {
      const r: Req = { id: this.nextReqId++, cls: req.cls, key: req.key, t0: this.now, settled: false, client: req.client, pri: req.pri, ...(req.api ? { api: req.api } : {}) };
      this.callEdge(edge, r, WRITE, (o) => {
        // a fallback answer is not a message in the queue
        if (o.ok && !o.fellBack) return;
        n.w.outboxRetries++;
        const next = this.now + n.num('outboxRetryMs');
        if (next < this.endMs) this.at(next, send);
      }, undefined, from);
    };
    send();
  }

  /** Run a node's calls. A response is degraded when any call on the way answered with a fallback. */
  private runSteps(n: NodeRT, req: Req, op: Op, steps: Step[], done: Done, from?: Instance, seen?: (s: Step, o: Outcome) => void): void {
    if (!steps.length) {
      done({ ok: true });
      return;
    }
    let degraded = false;
    const success = (): Outcome => (degraded ? { ok: true, degraded: true } : { ok: true });
    const parallel = n.kind !== 'cache' && n.p.calls === 'parallel';
    if (parallel) {
      let left = steps.length;
      let failure: Outcome | null = null;
      for (const s of steps) {
        this.runStep(s, req, op, (o) => {
          seen?.(s, o);
          if (!o.ok && !failure) failure = o;
          if (o.degraded) degraded = true;
          if (--left === 0) done(failure ?? success());
        }, from);
      }
      return;
    }
    let i = 0;
    const next = (): void => {
      if (i >= steps.length) {
        done(success());
        return;
      }
      const s = steps[i++];
      this.runStep(s, req, op, (o) => {
        seen?.(s, o);
        if (o.degraded) degraded = true;
        if (!o.ok) done(o);
        else next();
      }, from);
    };
    next();
  }

  private runStep(s: Step, req: Req, op: Op, done: Done, from?: Instance): void {
    if (s.t === 'call') {
      this.callEdge(s.edge, req, op, done, undefined, from);
      return;
    }
    if (s.t === 'inval') {
      // a failed invalidation does not fail the write
      this.callEdge(s.edge, req, CACHE_DEL, () => done({ ok: true }), undefined, from, true);
      return;
    }
    // cache-aside: try caches in order; on a full miss (or cache failure) read the stores, then fill
    let i = 0;
    /** Lease waits: when this request was first told to wait (it gives up waiting after leaseMs). */
    let waitFrom = -1;
    const tryCache = (): void => {
      if (i >= s.caches.length) {
        let j = 0;
        const readStore = (): void => {
          if (j >= s.stores.length) {
            for (const c of s.caches) this.callEdge(c, req, CACHE_SET, () => {}, undefined, from, true);
            done({ ok: true, hit: false });
            return;
          }
          this.callEdge(s.stores[j++], req, READ, (o) => {
            // a fallback answer is not real data: pass it on, and do not put it in the cache
            if (!o.ok || o.degraded) done(o);
            else readStore();
          }, undefined, from);
        };
        readStore();
        return;
      }
      const c = s.caches[i++];
      this.callEdge(c, req, READ, (o) => {
        if (o.ok && o.hit) done({ ok: true, hit: true });
        else if (o.ok && o.wait && !(req.deadline !== undefined && this.now >= req.deadline)) {
          // another request is filling this key: ask the same cache again shortly, for at most
          // leaseMs in total; after that, read the store without the lease
          if (waitFrom < 0) waitFrom = this.now;
          if (this.now - waitFrom >= c.to.num('leaseMs')) return tryCache();
          i--;
          this.pending++;
          this.at(this.now + c.to.num('leaseWaitMs'), () => {
            this.pending--;
            tryCache();
          });
        } else tryCache();
      }, undefined, from, true);
    };
    tryCache();
  }

  // -------------------------------------------------------------------------------------------
  // Queue

  private enqueue(n: NodeRT, req: Req, op: Op, done: Done): void {
    const d = this.dur(n, 'enqueueMs');
    this.at(this.now + d, () => {
      const qs = n.queue!;
      if (n.down) return this.reject(n, 'down', done);
      if (qDepth(qs) >= n.num('maxDepth')) return this.reject(n, 'queue_full', done);
      this.touchQueue(qs);
      const msg: Req = { id: this.nextReqId++, cls: req.cls, key: req.key, t0: this.now, settled: false, client: req.client, pri: req.pri, ...(req.api !== undefined ? { api: req.api } : {}) };
      const m: QMsg = { req: msg, op, tEnq: this.now, tVis: this.now, receives: 0, gen: 0, acked: false, hidden: false, dead: false };
      if (qs.groups) {
        // the group is the message key: messages of one key are worked on one at a time, in order
        const g = (m.grp = req.key % qs.groups);
        if (qs.busy.has(g)) {
          const list = qs.parked.get(g);
          if (list) list.push(m);
          else qs.parked.set(g, [m]);
          qs.parkedN++;
          n.w.holBlocked++;
        } else {
          qs.busy.add(g);
          qs.msgs.push(m);
        }
      } else qs.msgs.push(m);
      n.w.enq++;
      if (qDepth(qs) > n.w.maxDepth) n.w.maxDepth = qDepth(qs);
      n.w.ok++;
      done({ ok: true });
      this.dispatch(qs);
    });
  }

  private touchQueue(qs: QueueNodeState): void {
    const dt = this.now - qs.lastT;
    if (dt > 0) {
      qs.node.w.depthArea += qDepth(qs) * dt;
      qs.lastT = this.now;
    }
  }

  private dispatch(qs: QueueNodeState): void {
    const cs = qs.consumers;
    const fns = qs.fns;
    if (!cs.length && !fns.length) return;
    while (qs.msgs.length) {
      let found: Instance | null = null;
      for (let i = 0; i < cs.length; i++) {
        const c = cs[qs.rr++ % cs.length];
        if (c.inst.serving() && c.inst.busy < c.inst.slots) {
          found = c.inst;
          break;
        }
      }
      if (found) {
        this.deliver(qs, found);
        continue;
      }
      // functions: a warm environment, else start one per message not yet covered by one booting
      let started = false;
      for (const n of fns) {
        if (n.down) continue;
        const env = this.fnWarm(n);
        if (env) {
          this.deliver(qs, env);
          if (env.busy === 0) this.fnIdleNow(env);
          started = true;
          break;
        }
        const feed = n.fnQueues.find((x) => x.qs === qs)!;
        if (qs.msgs.length <= feed.booting) continue;
        const cold = this.fnLaunch(n);
        if (!cold) {
          this.fnRetryLater(n, qs);
          continue;
        }
        feed.booting++;
        this.fnBoot(n, cold, () => {
          feed.booting--;
          // the message may be gone (taken by a warm environment): then it is just idle. A message
          // was never given to an environment that crashed while it booted, so nothing fails here.
          if (qs.msgs.length && !cold.down) this.deliver(qs, cold);
          if (cold.busy === 0 && !cold.down) {
            this.pull(cold);
            this.fnSettle(cold);
          }
        });
        started = true;
        break;
      }
      if (!started) return;
    }
  }

  /**
   * The scaling rate stopped a launch: dispatch the queue again when the next launch token is
   * there (environments that are up only pull; none would start a new one). At the limit, a
   * release() pulls the message instead.
   */
  private fnRetryLater(n: NodeRT, qs: QueueNodeState): void {
    const feed = n.fnQueues.find((x) => x.qs === qs)!;
    if (feed.retry || n.fnLive >= n.num('maxConcurrency')) return;
    const rate = n.num('scalePer10s');
    const t = this.now + Math.max(1, Math.ceil(((1 - n.fnTokens) * 10_000) / rate));
    if (t >= this.durationMs) return;
    feed.retry = true;
    this.at(t, () => {
      feed.retry = false;
      this.dispatch(qs);
    });
  }

  /** A message older than the queue's TTL is dropped (like SQS retention). */
  private msgExpired(qs: QueueNodeState, m: QMsg): boolean {
    const ttl = qs.node.num('messageTtlS');
    if (ttl <= 0 || this.now - m.tEnq < ttl * 1000) return false;
    m.dead = true;
    qs.node.w.expired++;
    qs.node.w.asyncFail++;
    this.freeGroup(qs, m);
    return true;
  }

  /**
   * A write the old primary commits after the heal (it started while that one was still the
   * primary): divergence the heal's timeline entry could not count. Logged once a second at most.
   */
  private lateDivergence(n: NodeRT): void {
    if (n.lateDiv++ > 0) return;
    this.at(this.now + 1000, () => this.logLateDivergence(n));
  }

  private logLateDivergence(n: NodeRT): void {
    const k = n.lateDiv;
    if (!k) return;
    n.lateDiv = 0;
    this.log({ node: n.id, type: 'divergence', count: k, text: t('{name}：分區結束後，舊主庫又完成 {k} 筆分區時開始的寫入，新主庫沒有，資料分歧', { name: n.label, k }) });
  }

  /** FIFO queue: this message is done (or gone): the next one of its group may be delivered. */
  private freeGroup(qs: QueueNodeState, m: QMsg): void {
    if (m.grp === undefined || m.freed) return;
    m.freed = true;
    const list = qs.parked.get(m.grp);
    const next = list?.shift();
    if (!next) {
      qs.busy.delete(m.grp);
      return;
    }
    if (!list!.length) qs.parked.delete(m.grp);
    qs.parkedN--;
    qs.msgs.push(next);
    this.dispatch(qs);
  }

  /** at-least-once: a delivered message that was not deleted in time becomes visible again, or goes to the DLQ. */
  private reappear(qs: QueueNodeState, m: QMsg): void {
    if (!m.hidden || m.acked) return;
    m.hidden = false;
    qs.hidden--;
    const qn = qs.node;
    const maxRx = qn.num('maxReceives');
    if (maxRx > 0 && m.receives >= maxRx) {
      m.dead = true;
      qn.w.dlq++;
      qn.w.asyncFail++;
      this.freeGroup(qs, m);
      return;
    }
    if (this.msgExpired(qs, m)) return;
    this.touchQueue(qs);
    m.tVis = this.now;
    qs.msgs.push(m);
    qn.w.redelivered++;
    if (qDepth(qs) > qn.w.maxDepth) qn.w.maxDepth = qDepth(qs);
    this.dispatch(qs);
  }

  /**
   * Hand the oldest live message to a free slot of `inst`.
   * at_most_once: the message is deleted when handed out, so a failure loses it.
   * at_least_once: it is hidden for visibilityTimeoutMs and deleted only when the worker succeeds;
   * a failure or a slow worker makes it visible again (a slow worker then does it twice).
   */
  private deliver(qs: QueueNodeState, inst: Instance): void {
    this.touchQueue(qs);
    let m: QMsg | undefined;
    while ((m = qs.msgs.shift())) {
      if (m.acked) continue; // done by an earlier delivery while it waited here
      if (this.msgExpired(qs, m)) continue;
      break;
    }
    if (!m) return;
    const msg = m;
    const qn = qs.node;
    const alo = qn.str('delivery') === 'at_least_once';
    qn.w.deq++;
    const edge = inst.edgeFrom.get(qs)!;
    edge.w.calls++;
    if (qn.region && inst.region && qn.region !== inst.region) edge.w.crossRegion++;
    if (msg.op === READ) edge.w.read++;
    else edge.w.write++;
    const worker = inst.node;
    worker.w.arrivals++;
    inst.touch(this.now);
    msg.receives++;
    if (alo) {
      const gen = ++msg.gen;
      msg.hidden = true;
      qs.hidden++;
      this.at(this.now + qn.num('visibilityTimeoutMs'), () => {
        if (msg.gen === gen) this.reappear(qs, msg);
      });
    }
    const failed = (): void => {
      edge.w.fail++;
      // at-least-once: it comes back when the visibility timeout ends (its group stays blocked)
      if (alo) return;
      qn.w.asyncFail++;
      this.freeGroup(qs, msg);
    };

    const job: Job = {
      req: msg.req,
      op: msg.op,
      tq: msg.tVis, // waiting in the queue counts as this worker pool's wait
      ts: 0,
      dead: false,
      run: (j, i) => {
        // delivery latency is part of the hold
        this.at(this.now + edge.latency, () => {
          if (j.dead) return;
          this.runJob(j, i, (o) => {
            if (!o.ok) return failed();
            edge.w.ok++;
            // the message already went to the DLQ or expired: the work happened, but it stays a failure
            if (msg.dead) return;
            if (msg.acked) {
              qn.w.duplicates++; // another delivery already did (and deleted) it
              return;
            }
            msg.acked = true;
            this.freeGroup(qs, msg);
            if (msg.hidden) {
              msg.hidden = false;
              qs.hidden--;
            }
            qn.w.asyncOk++;
            const lat = this.now - msg.tEnq;
            this.g.asyncDone++;
            this.wAsyncHist.add(lat);
            if (this.sentInMeasure(msg.tEnq)) this.asyncHist.add(lat);
          });
        });
      },
      fail: (reason) => {
        worker.w.origin[reason]++;
        worker.w.fail++;
        failed();
      },
    };
    this.start(inst, job);
  }

  // -------------------------------------------------------------------------------------------
  // Circuit breaker

  private breaker(n: NodeRT, req: Req, op: Op, done: Done): void {
    const cb = n.cb!;
    // a call the open breaker stops: with a fallback on the breaker's outbound edge, a degraded answer
    const stop = (): void => {
      // pick an edge only when one has a fallback, so runs without one keep their random draws
      const e = n.out.some((x) => x.fallback && x.carries(op, req.api)) ? this.pickEdge(n, op, req.api) : null;
      if (e?.fallback && !(req.deadline !== undefined && this.now >= req.deadline)) {
        n.w.ok++;
        e.w.fallbacks++;
        done({ ok: true, degraded: true, fellBack: true });
      } else this.reject(n, 'circuit_open', done);
    };
    if (cb.state === 'open') {
      if (this.now >= cb.openUntil) this.cbTo(n, 'half_open');
      else return stop();
    }
    const gen = cb.gen;
    if (cb.state === 'half_open') {
      if (cb.probes >= n.num('halfOpenCalls')) return stop();
      cb.probes++;
      this.forwardOne(n, req, op, (o) => {
        if (o.ok) n.w.ok++;
        else n.w.fail++;
        if (cb.gen === gen && cb.state === 'half_open') {
          if (!o.ok || o.fellBack) this.cbTo(n, 'open');
          else if (++cb.probeOk >= n.num('halfOpenCalls')) this.cbTo(n, 'closed');
        }
        done(o);
      });
      return;
    }
    this.forwardOne(n, req, op, (o) => {
      if (o.ok) n.w.ok++;
      else n.w.fail++;
      if (cb.gen === gen && cb.state === 'closed') {
        const sec = Math.floor(this.now / 1000);
        const b = cb.ring[sec % cb.ring.length];
        if (b.sec !== sec) {
          b.sec = sec;
          b.calls = 0;
          b.fails = 0;
        }
        b.calls++;
        // a fallback answer on the breaker's own call still means the dependency failed
        if (!o.ok || o.fellBack) b.fails++;
        let calls = 0;
        let fails = 0;
        for (const x of cb.ring) {
          if (x.sec > sec - cb.ring.length) {
            calls += x.calls;
            fails += x.fails;
          }
        }
        // fails > 0: with failureRatio 0 ("trip on any failure") a success must not trip it
        if (calls >= n.num('minCalls') && fails > 0 && fails / calls >= n.num('failureRatio')) this.cbTo(n, 'open');
      }
      done(o);
    });
  }

  private cbTo(n: NodeRT, state: CbState['state']): void {
    const cb = n.cb!;
    cb.state = state;
    cb.gen++;
    cb.probes = 0;
    cb.probeOk = 0;
    for (const b of cb.ring) b.sec = -1;
    if (state === 'open') {
      cb.openUntil = this.now + n.num('openMs');
      cb.opens++;
    }
    const v = { name: n.label };
    const text = state === 'open' ? t('{name}跳開，暫停呼叫下游', v) : state === 'half_open' ? t('{name}開始試探下游', v) : t('{name}關上，恢復正常', v);
    this.log({ node: n.id, type: `cb_${state}`, text });
  }

  // -------------------------------------------------------------------------------------------
  // Windows and results

  private flushWindow(final = false): void {
    const t0 = this.windowStart;
    const t1 = this.now;
    const dt = t1 - t0;
    if (dt <= 0) return;
    const measured = t0 >= this.measureFromMs - 1e-6 && t1 <= this.measureToMs + 1e-6;
    const nodes: Record<string, NodeWindow> = {};
    for (const n of this.nodes) {
      const nw: NodeWindow = { arrivals: n.w.arrivals, ok: n.w.ok, fail: n.w.fail };
      if (n.insts.length) {
        let util = 0;
        let maxU = 0;
        let qa = 0;
        let ws = 0;
        let st = 0;
        let busyA = 0;
        let capA = 0;
        let active = 0;
        let booting = 0;
        const iu: number[] = [];
        for (const inst of n.insts) {
          inst.touch(t1);
          // an autoscaled instance is measured over the time it was provisioned
          const u = n.elastic ? (inst.w.up > 0 ? inst.w.busyArea / (inst.w.up * inst.slots) : 0) : inst.w.busyArea / (dt * inst.slots);
          busyA += inst.w.busyArea;
          capA += inst.w.up * inst.slots;
          if (inst.state === 'on') active++;
          if (inst.state === 'boot') booting++;
          iu.push(round(u, 4));
          util += u;
          if (u > maxU) maxU = u;
          qa += inst.w.qArea / dt;
          ws += inst.w.waitSum;
          st += inst.w.started;
          if (measured) addInst(inst.tot, inst.w);
          inst.w = zeroInst();
        }
        nw.util = n.elastic ? round(capA ? busyA / capA : 0, 4) : round(util / n.insts.length, 4);
        // a function starts environments as it needs them: how busy it is means its share of the limit
        if (n.kind === 'function') nw.util = maxU = round(busyA / (dt * n.num('maxConcurrency')), 4);
        if (n.elastic) {
          nw.active = active;
          nw.booting = booting;
        }
        nw.maxUtil = round(maxU, 4);
        nw.queue = round(qa, 2);
        nw.waitMs = st ? round(ws / st, 3) : 0;
        // a function's environments come and go: no row per environment
        if (n.insts.length > 1 && n.kind !== 'function') nw.instUtil = iu;
      }
      if (n.kind === 'cache' || n.kind === 'cdn') {
        const tot = n.w.hits + n.w.misses;
        nw.hitRatio = tot ? round(n.w.hits / tot, 4) : undefined;
      }
      if (n.queue) {
        this.touchQueue(n.queue);
        nw.depth = round(n.w.depthArea / dt, 2);
        const head = n.queue.msgs.peek();
        nw.lagMs = head ? round(t1 - head.tEnq, 1) : 0;
      }
      if (n.insts.length && n.insts.some((i) => i.commits)) {
        let lag = 0;
        for (const i of n.insts) if (i.commits) lag = Math.max(lag, i.lag(t1));
        if (lag > n.w.maxLagMs) n.w.maxLagMs = lag;
        nw.replLagMs = round(lag, 1);
        if (n.w.staleReads) nw.staleReads = n.w.staleReads;
      }
      if (n.cb) nw.cb = n.cb.state;
      if (n.w.expired) nw.expired = n.w.expired;
      if (n.w.redelivered) nw.redelivered = n.w.redelivered;
      if (n.w.duplicates) nw.duplicates = n.w.duplicates;
      if (n.w.dlq) nw.dlq = n.w.dlq;
      nodes[n.id] = nw;
      if (measured) addNode(n.tot, n.w);
      n.w = zeroNode();
    }
    const edges: WindowStat['edges'] = {};
    for (const e of this.edges) {
      edges[e.id] = { calls: e.w.calls, read: e.w.read, write: e.w.write, fail: e.w.fail, retries: e.w.retries };
      if (e.w.denied) edges[e.id].denied = e.w.denied;
      if (e.w.throttled) edges[e.id].throttled = e.w.throttled;
      if (e.w.bulkhead) edges[e.id].bulkhead = e.w.bulkhead;
      if (e.w.fallbacks) edges[e.id].fallbacks = e.w.fallbacks;
      if (e.w.hedges) edges[e.id].hedges = e.w.hedges;
      if (e.hedgeMs > 0) edges[e.id].attempts = e.w.attempts;
      if (e.w.hedgeWins) edges[e.id].hedgeWins = e.w.hedgeWins;
      if (e.w.connects) edges[e.id].connects = e.w.connects;
      if (e.w.copies) edges[e.id].copies = e.w.copies;
      if (e.w.crossRegion) edges[e.id].crossRegion = e.w.crossRegion;
      if (measured) addEdge(e.tot, e.w);
      e.w = zeroEdge();
    }
    const lat = this.whist.summary();
    this.windows.push({
      t: round(t1 / 1000, 3),
      dt: dt / 1000,
      measured,
      targetRps: t0 < this.durationMs ? round(this.sc.rps * this.multiplierAt(t0), 2) : 0,
      offered: this.g.offered,
      ok: this.g.ok,
      fail: this.g.fail,
      latency: { count: lat.count, mean: round(lat.mean, 3), p50: round(lat.p50, 3), p95: round(lat.p95, 3), p99: round(lat.p99, 3) },
      asyncDone: this.g.asyncDone,
      asyncP99: round(this.wAsyncHist.quantile(0.99), 3),
      ...(this.anyFallback ? { degraded: this.g.degraded } : {}),
      nodes,
      edges,
    });
    this.whist.reset();
    this.wAsyncHist.reset();
    this.g = { offered: 0, ok: 0, fail: zeroFails(), asyncDone: 0, degraded: 0 };
    this.windowStart = t1;
    if (!final && !this.done) {
      const next = Math.min(t1 + this.windowMs, this.endMs);
      if (next > t1) this.at(next, () => this.flushWindow());
    }
  }

  private inMeasure(w: WindowStat): boolean {
    return w.measured;
  }

  /** Windows completed since the last call. */
  drainWindows(): WindowStat[] {
    const out = this.windows.slice(this.windowsRead).map((w) => this.full(w));
    this.windowsRead = this.windows.length;
    return out;
  }

  allWindows(): WindowStat[] {
    return this.windows.map((w) => this.full(w));
  }

  /** A window with its counts at full size (a copy when k > 1). */
  private full(w: WindowStat): WindowStat {
    return this.scalePlan.k === 1 ? w : scaleWindow(structuredClone(w), this.scalePlan.k);
  }

  /** Sampled request traces completed since the last call. */
  drainTraces(): Trace[] {
    const out = this.traces.slice(this.tracesRead);
    this.tracesRead = this.traces.length;
    return out;
  }

  drainTimeline(from: number): TimelineEvent[] {
    return this.timeline.slice(from);
  }

  /** Instantaneous state for animation: per node busy slots, total slots and queued requests. */
  liveState(): Record<string, LiveNode> {
    return scaleLive(this.liveRaw(), this.scalePlan);
  }

  private liveRaw(): Record<string, LiveNode> {
    const out: Record<string, LiveNode> = {};
    for (const n of this.nodes) {
      let busy = 0;
      let slots = 0;
      let queued = 0;
      let down = 0;
      for (const i of n.insts) {
        busy += i.busy;
        if (i.state === 'on' || i.state === 'retiring') slots += i.slots;
        queued += i.q.length;
        if (i.down) down++;
      }
      // a function: busy environments out of the concurrency limit, no row per environment
      if (n.kind === 'function') slots = n.num('maxConcurrency');
      const s: LiveNode = { busy, slots, queued, down: n.down && (!n.insts.length || n.kind === 'function') ? 1 : down };
      const code = (i: Instance): number =>
        i.state === 'off' ? 1 : i.state === 'boot' ? 2 : i.state === 'retiring' ? 4 : i.warmUntil > this.now ? 3 : 0;
      if (n.insts.length > 1 && n.kind !== 'function') s.inst = n.insts.map((i) => [i.busy, i.slots, i.q.length, i.down ? 1 : 0, code(i)]);
      if (n.cb) s.cb = n.cb.state;
      if (n.queue) s.depth = qDepth(n.queue);
      out[n.id] = s;
    }
    return out;
  }

  result(): SimResult {
    const r = scaleResult(this.resultRaw(), this.scalePlan);
    if (this.scalePlan.k > 1) {
      r.scale = this.scalePlan.k;
      r.scenario.rps *= this.scalePlan.k;
      this.explain(r.bottleneck, r.nodes);
    }
    return r;
  }

  private resultRaw(): SimResult {
    // Windows inside [measureFromMs, measureToMs) are summed; a truncated run measures what it reached.
    const measuredMs = Math.max(1, Math.min(this.now, this.measureToMs) - this.measureFromMs);
    const measuredS = measuredMs / 1000;
    const trafficMs = measuredMs;
    const nodes: Record<string, NodeResult> = {};
    let bottleneck: SimResult['bottleneck'] = null;
    let worst = -1;
    const peaks = new Map<string, { util: number; t: number; queue: number }>();
    for (const w of this.windows) {
      if (!this.inMeasure(w)) continue;
      for (const [id, nw] of Object.entries(w.nodes)) {
        const p = peaks.get(id) ?? { util: 0, t: 0, queue: 0 };
        const u = nw.maxUtil ?? 0;
        if (u > p.util) {
          p.util = u;
          p.t = w.t;
        }
        p.queue = Math.max(p.queue, nw.queue ?? nw.depth ?? 0);
        peaks.set(id, p);
      }
    }
    for (const n of this.nodes) {
      const t = n.tot;
      const r: NodeResult = {
        kind: n.kind,
        label: n.label,
        arrivals: t.arrivals,
        rps: round((t.arrivals / trafficMs) * 1000, 2),
        ok: t.ok,
        fail: t.fail,
        origin: t.origin,
      };
      if (n.insts.length) {
        let busy = 0;
        let slots = 0;
        let qa = 0;
        let maxQ = 0;
        let ws = 0;
        let started = 0;
        let waited = 0;
        let hs = 0;
        let hq = 0;
        let hn = 0;
        let maxU = 0;
        let maxIdx = 0;
        let capA = 0;
        const instRows: NonNullable<NodeResult['instances']> = [];
        const balanced = n.insts.length > 1 && n.inc.some((e) => e.from.kind === 'load_balancer' && e.from.str('policy') !== 'random');
        for (const i of n.insts) {
          const s = i.tot;
          const u = n.elastic ? (s.up > 0 ? s.busyArea / (s.up * i.slots) : 0) : s.busyArea / (measuredMs * i.slots);
          capA += s.up * i.slots;
          busy += s.busyArea;
          slots += i.slots;
          qa += s.qArea / measuredMs;
          maxQ = Math.max(maxQ, s.maxQ);
          ws += s.waitSum;
          started += s.started;
          waited += s.waited;
          hs += s.holdSum;
          hq += s.holdSq;
          hn += s.holds;
          if (u > maxU) {
            maxU = u;
            maxIdx = i.idx;
          }
          instRows.push({
            idx: i.idx,
            role: i.role,
            utilization: round(u, 4),
            avgQueue: round(s.qArea / measuredMs, 3),
            started: s.started,
            waitMs: s.started ? round(s.waitSum / s.started, 3) : 0,
            // queueing theory needs a fixed number of servers
            theory: n.elastic ? undefined : this.theory(i.slots, s, measuredMs, s.rejected > 0, balanced),
          });
        }
        r.utilization = n.elastic ? round(capA ? busy / capA : 0, 4) : round(busy / (measuredMs * slots), 4);
        if (n.kind === 'function') r.utilization = maxU = round(busy / (measuredMs * n.num('maxConcurrency')), 4);
        r.maxInstanceUtilization = round(maxU, 4);
        r.avgQueue = round(qa, 3);
        r.maxQueue = maxQ;
        r.waitMs = started ? round(ws / started, 3) : 0;
        const meanHold = hn ? hs / hn : 0;
        r.holdMs = round(meanHold, 3);
        r.holdCv = hn && meanHold > 0 ? round(Math.sqrt(Math.max(0, hq / hn - meanHold * meanHold)) / meanHold, 3) : 0;
        if (n.insts.length > 1 && n.kind !== 'function') r.instances = instRows;
        if (n.kind === 'function') {
          r.function = {
            limit: n.num('maxConcurrency'),
            provisioned: n.num('provisioned'),
            peakEnvs: n.fnPeak,
            endEnvs: n.fnLive,
            coldStarts: t.coldStarts,
            throttles: t.origin.rate_limited,
          };
        } else if (n.auto) {
          const min = n.num('instances');
          r.autoscale = {
            min,
            max: Math.max(min, n.num('maxInstances')),
            peakActive: n.peakActive,
            endActive: n.insts.filter((x) => x.state === 'on').length,
            launches: n.launches,
            retires: n.retires,
            ...(n.bootFails ? { bootFails: n.bootFails } : {}),
          };
        } else if (n.insts[0].pullFrom.length) {
          // workers share one queue, so together they are one M/G/c system with c = all their slots
          const all = zeroInst();
          for (const i of n.insts) addInst(all, i.tot);
          r.theory = this.theory(slots, all, measuredMs, false);
          if (r.instances) for (const row of r.instances) delete row.theory;
        } else {
          // separate queues: the busiest instance is the one that matters
          r.theory = instRows.find((x) => x.idx === maxIdx)?.theory;
        }
        void waited;
        const avgQ = n.insts.length ? qa / n.insts.length : 0;
        const peak = peaks.get(n.id) ?? { util: maxU, t: 0, queue: avgQ };
        r.peakUtilization = round(peak.util, 4);
        r.peakAtS = peak.t;
        r.peakQueue = round(peak.queue, 2);
        // a node that dropped requests because its queue was full is a stronger signal than busy time alone
        const score = peak.util + (t.origin.queue_full > 0 ? 0.5 : 0);
        if (score > worst && t.arrivals > 0) {
          worst = score;
          bottleneck = {
            node: n.id,
            label: n.label,
            instance: n.insts.length > 1 ? maxIdx : undefined,
            utilization: round(maxU, 4),
            peakUtilization: round(peak.util, 4),
            peakAtS: peak.t,
            avgQueue: round(avgQ, 2),
            why: '',
          };
        }
      }
      if (n.kind === 'cache' || n.kind === 'cdn' || n.kind === 'dns') {
        const tot = t.hits + t.misses;
        if (tot) r.hitRatio = round(t.hits / tot, 4);
        if (t.coalesced) r.coalesced = t.coalesced;
        if (t.leaseWaits) r.leaseWaits = t.leaseWaits;
      }
      if (n.kind === 'load_balancer') {
        if (n.str('healthCheck') !== 'instant') r.hcRemoved = t.hcOut;
        if (n.str('outlier') === 'on') r.ejections = t.ejections;
      }
      if (n.blindChecks) r.blindChecks = n.blindChecks;
      if (n.dualWrite) {
        r.dualWriteGaps = t.dualWriteGaps;
        if (n.str('outbox') === 'on') r.outboxRetries = t.outboxRetries;
      }
      if (n.queue) {
        r.queueDepthAvg = round(t.depthArea / measuredMs, 2);
        r.queueDepthEnd = qDepth(n.queue);
        if (n.queue.groups) r.holBlocked = t.holBlocked;
        r.queueDepthMax = t.maxDepth;
        r.asyncOk = t.asyncOk;
        r.asyncFail = t.asyncFail;
        const growing = qDepth(n.queue) > Math.max(100, t.maxDepth * 0.5) && t.enq > t.deq * 1.05;
        if (growing && worst < 2) {
          worst = 2;
          bottleneck = { node: n.id, label: n.label, utilization: 1, peakUtilization: 1, peakAtS: this.durationMs / 1000, avgQueue: round(t.depthArea / measuredMs, 2), why: '' };
        }
      }
      if (n.kind === 'cache' && (t.replApplied || t.replDropped)) {
        // changes copied in from another cache (cross-region replication)
        r.replicationApplied = t.replApplied;
        r.replicationDropped = t.replDropped;
      }
      if (n.kind === 'database' || n.kind === 'sharded_db') {
        r.replicationApplied = t.replApplied;
        r.replicationDropped = t.replDropped;
        if (n.str('failover') === 'auto') {
          r.failovers = t.failovers;
          r.lostWrites = t.lostWrites;
          if (t.divergentWrites) r.divergentWrites = t.divergentWrites;
        }
        if (n.str('locks') === 'row') r.lockWaits = t.lockWaits;
        if (this.sc.followReads > 0 && n.insts.some((i) => i.commits) && n.num('replicaApplyRatio') > 0) r.rywMisses = t.rywMisses;
        if (n.insts.some((i) => i.commits) && n.num('replicaApplyRatio') > 0) {
          r.replicaReads = t.replicaReads;
          r.staleReads = t.staleReads;
          r.maxReplLagMs = round(t.maxLagMs, 1);
        }
      }
      if (n.cb) r.circuitOpens = n.cb.opens;
      if (t.expired) r.expired = t.expired;
      if (n.queue && n.str('delivery') === 'at_least_once') {
        r.redelivered = t.redelivered;
        r.duplicates = t.duplicates;
        r.dlq = t.dlq;
      }
      nodes[n.id] = r;
    }
    this.explain(bottleneck, nodes);
    const edges: SimResult['edges'] = {};
    for (const e of this.edges) {
      edges[e.id] = {
        from: e.from.id,
        to: e.to.id,
        calls: e.tot.calls,
        rps: round((e.tot.calls / trafficMs) * 1000, 2),
        ok: e.tot.ok,
        fail: e.tot.fail,
        retries: e.tot.retries,
        late: e.tot.late,
      };
      if (e.tot.denied) edges[e.id].denied = e.tot.denied;
      if (e.tot.throttled) edges[e.id].throttled = e.tot.throttled;
      if (e.tot.bulkhead) edges[e.id].bulkhead = e.tot.bulkhead;
      if (e.tot.fallbacks) edges[e.id].fallbacks = e.tot.fallbacks;
      if (e.tot.hedges) edges[e.id].hedges = e.tot.hedges;
      if (e.hedgeMs > 0) edges[e.id].attempts = e.tot.attempts;
      if (e.tot.hedgeWins) edges[e.id].hedgeWins = e.tot.hedgeWins;
      if (e.tot.connects) edges[e.id].connects = e.tot.connects;
      if (e.tot.copies) edges[e.id].copies = e.tot.copies;
      if (e.tot.crossRegion) edges[e.id].crossRegion = e.tot.crossRegion;
    }
    const failTotal = FAIL_REASONS.reduce((a, r) => a + this.gTot.fail[r], 0);
    const settled = this.gTot.ok + failTotal;
    const roundSummary = (s: LatencySummary): LatencySummary => ({
      count: s.count, mean: round(s.mean, 3), p50: round(s.p50, 3), p90: round(s.p90, 3), p95: round(s.p95, 3),
      p99: round(s.p99, 3), p999: round(s.p999, 3), max: round(s.max, 3),
    });
    return {
      schema: RESULT_SCHEMA,
      design: this.design.name,
      scenario: {
        name: this.sc.name, seed: this.sc.seed, durationS: this.sc.durationS, warmupS: this.sc.warmupS,
        rps: this.sc.rps, readRatio: this.sc.readRatio, clientTimeoutMs: this.sc.clientTimeoutMs,
      },
      measuredFromS: this.measureFromMs / 1000,
      measuredS: round(measuredS, 3),
      measuredToS: (this.measureFromMs + measuredMs) / 1000,
      simulatedS: round(this.now / 1000, 3),
      events: this.events,
      truncated: this.truncated,
      unfinished: this.unfinished(),
      summary: {
        offered: this.gTot.offered,
        ok: this.gTot.ok,
        fail: this.gTot.fail,
        errorRate: settled ? round(failTotal / settled, 5) : 0,
        throughputRps: round((this.gTot.ok / trafficMs) * 1000, 2),
        latencyMs: roundSummary(this.hist.summary()),
        asyncLatencyMs: roundSummary(this.asyncHist.summary()),
        ...(this.anyFallback ? { degraded: this.gTot.degraded } : {}),
      },
      bottleneck,
      ...(this.apis.length
        ? {
            apis: Object.fromEntries(this.apis.map((a) => [a.name, {
              op: a.op === READ ? 'read' as const : 'write' as const, offered: a.offered, ok: a.ok, fail: a.fail,
              errorRate: a.ok + a.fail ? round(a.fail / (a.ok + a.fail), 5) : 0, latencyMs: roundSummary(a.hist.summary()),
            }])),
          }
        : {}),
      nodes,
      edges,
      timeline: this.timeline,
    };
  }

  /**
   * Work left when the simulation stopped: jobs running or waiting on an instance, jobs a cache
   * holds while the database answers, calls and replies on the wire, retries waiting to go, and
   * queue messages. A job that waits for a downstream call counts once on each instance.
   */
  private unfinished(): number {
    let k = this.pending;
    for (const n of this.nodes) {
      for (const i of n.insts) k += i.busy + i.q.length + i.detached.size;
      if (n.queue) k += qDepth(n.queue) + n.queue.hidden;
    }
    return k;
  }

  private theory(c: number, s: InstStats, measuredMs: number, drops: boolean, balanced = false): TheoryRow | undefined {
    if (!s.holds || !s.started) return undefined;
    const lam = s.started / measuredMs;
    const mean = s.holdSum / s.holds;
    const varH = Math.max(0, s.holdSq / s.holds - mean * mean);
    const cs2 = mean > 0 ? varH / (mean * mean) : 0;
    const th = mgc(lam, mean, c, cs2, 1);
    return {
      model: c === 1 ? 'M/G/1' : 'M/G/c',
      servers: c,
      lambdaPerSec: round(lam * 1000, 3),
      meanHoldMs: round(mean, 3),
      rho: round(th.rho, 4),
      pWait: round(th.pWait, 4),
      waitMs: th.stable ? round(th.waitMs, 3) : null,
      simWaitMs: round(s.waitSum / s.started, 3),
      simPWait: round(s.waited / s.started, 4),
      note:
        [
          drops ? t('有請求因排隊滿被拒，理論值假設排隊無上限，僅供參考。') : '',
          balanced ? t('理論值假設請求隨機到達；負載平衡器分配得比隨機平均，實際排隊通常比理論少。') : '',
        ].join('') || undefined,
    };
  }

  /**
   * Where most failures came from, when that is not already the bottleneck's full queue.
   * Without it a run where a rate limiter or breaker rejected half the traffic reads
   * "no component is near its limit", which hides the main thing that happened.
   */
  private failureSource(b: NonNullable<SimResult['bottleneck']>, nodes: SimResult['nodes']): string {
    const total = FAIL_REASONS.reduce((a, r) => a + this.gTot.fail[r], 0);
    if (total === 0 || total < this.gTot.offered * 0.01) return '';
    let top: { id: string; reason: FailReason; n: number } | null = null;
    let all = 0;
    for (const [id, r] of Object.entries(nodes)) {
      for (const reason of FAIL_REASONS) {
        all += r.origin[reason];
        if (!top || r.origin[reason] > top.n) top = { id, reason, n: r.origin[reason] };
      }
    }
    if (!top || top.n === 0 || (top.id === b.node && top.reason === 'queue_full')) return '';
    const why: Record<FailReason, string> = {
      rate_limited: tx('限流器照設定擋掉超過額度的請求，保護後面的服務'),
      shed: tx('過載時先丟掉可丟棄（batch）的請求，把位置留給重要的請求'),
      circuit_open: tx('保險絲跳開後直接拒絕，不再打已經出問題的下游'),
      error: tx('元件本身回傳錯誤'),
      down: tx('元件故障，送到它的請求都失敗'),
      throttled: tx('呼叫端看到下游最近大多失敗，自己先擋掉一部分請求，讓下游有機會恢復'),
      bulkhead: tx('呼叫端給這個下游的同時呼叫名額用完了，直接失敗，不再佔用更多執行緒'),
      timeout: tx('呼叫等太久，呼叫端放棄'),
      queue_full: tx('排隊滿了，新請求直接被拒'),
      codel: tx('塞車時排太久的請求輪到時直接丟掉，不做呼叫端已經不等的白工'),
    };
    const share = Math.round((top.n / Math.max(1, all)) * 100);
    const n = top.n.toLocaleString('en-US');
    // a timeout is counted at the caller that gave up, so name it as the one waiting
    if (top.reason === 'timeout') return t('失敗主要是{name}等太久放棄（逾時 {n} 個，占失敗的 {share}%）：下游回應太慢。', { name: nodes[top.id].label, n, share });
    return t('失敗主要來自{name}：{reason} {n} 個（占失敗的 {share}%），{why}。', { name: nodes[top.id].label, reason: t(FAIL_LABEL[top.reason]), n, share, why: t(why[top.reason]) });
  }

  /** The bottleneck's text, from the numbers of the result (at full size when the run was scaled). */
  private explain(b: SimResult['bottleneck'], nodes: SimResult['nodes']): void {
    if (!b) return;
    const parts = [this.why(b, nodes[b.node]), this.failureSource(b, nodes)].filter(Boolean);
    b.why = parts.join(getLang() === 'zh-TW' ? '' : ' ');
  }

  private why(b: NonNullable<SimResult['bottleneck']>, r: NodeResult): string {
    if (r.kind === 'queue') {
      return t('{name}的訊息越積越多（結束時還有 {k} 則）：worker 處理得比寫入慢。', { name: b.label, k: r.queueDepthEnd ?? 0 });
    }
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    const count = r.instances?.length ?? 1;
    // When every instance is about as busy as the busiest, the whole pool is the bottleneck.
    const pool = count > 1 && r.utilization !== undefined && b.utilization <= r.utilization * 1.15;
    const role = b.instance !== undefined && r.instances ? r.instances.find((x) => x.idx === b.instance)?.role || `#${b.instance}` : '';
    const who = pool ? t('{name}（{k} 台都很忙）', { name: b.label, k: count }) : role ? `${b.label} ${role}` : b.label;
    const util = pool ? (r.utilization ?? b.utilization) : b.utilization;
    const queued = Math.round(r.peakQueue ?? 0);
    const dropped = r.origin.queue_full;
    const parts: string[] = [];
    if (b.peakUtilization >= 0.95) {
      if (util >= 0.9) parts.push(t('{name}幾乎一直滿載（平均忙碌 {u}），請求在這裡排隊。', { name: who, u: pct(util) }));
      else parts.push(t('{name}在第 {s} 秒前後滿載（那一秒忙碌 {peak}，排隊 {q} 個）；整段平均忙碌 {u}。', { name: who, s: Math.round(b.peakAtS), peak: pct(b.peakUtilization), q: queued.toLocaleString('en-US'), u: pct(util) }));
    } else if (b.peakUtilization >= 0.7) {
      parts.push(t('{name}最忙時忙碌 {peak}，是最接近上限的元件；流量再增加，這裡會先開始排隊。', { name: who, peak: pct(b.peakUtilization) }));
    } else {
      return t('目前沒有元件接近上限；最忙的是{name}（最忙時 {peak}）。', { name: who, peak: pct(b.peakUtilization) });
    }
    if (dropped) parts.push(t('有 {k} 個請求因為排隊滿了被拒絕。', { k: dropped.toLocaleString('en-US') }));
    // In the blocking model a slot is held while waiting for downstream calls. Say so when that dominates.
    const own = this.ownWorkMs(b.node);
    if (own !== null && r.holdMs !== undefined && r.holdMs > own * 3 && r.holdMs - own > 2) {
      parts.push(t('每個請求佔住一個執行緒平均 {hold} ms，自己處理只要約 {own} ms，其餘時間在等下游回應。', { hold: round(r.holdMs, 1), own: round(own, 1) }));
      const down = this.busiestDownstream(b.node);
      if (down && down.peak >= 0.7) parts.push(t('下游最忙的是{name}（最忙時 {peak}）。', { name: down.label, peak: pct(down.peak) }));
      else parts.push(t('下游沒有很忙，但回應慢（例如變慢、逾時或重試）。'));
    }
    // Chinese sentences end in 。 and join without a space; English ones need one.
    return parts.join(getLang() === 'zh-TW' ? '' : ' ');
  }

  /** The busiest station reachable downstream of `id`, by peak window utilisation. */
  private busiestDownstream(id: string): { label: string; peak: number } | null {
    const start = this.byId.get(id);
    if (!start) return null;
    const seen = new Set<NodeRT>([start]);
    const todo = [start];
    let best: { label: string; peak: number } | null = null;
    while (todo.length) {
      const n = todo.pop()!;
      for (const e of n.out) {
        const t = e.to;
        if (seen.has(t)) continue;
        seen.add(t);
        todo.push(t);
        if (!t.insts.length) continue;
        let peak = 0;
        for (const w of this.windows) {
          if (!this.inMeasure(w)) continue;
          const nw = w.nodes[t.id];
          if (nw?.maxUtil !== undefined && nw.maxUtil > peak) peak = nw.maxUtil;
        }
        if (!best || peak > best.peak) best = { label: t.label, peak };
      }
    }
    return best;
  }

  /** Mean time a node spends on its own work per request (not waiting for others), or null. */
  private ownWorkMs(id: string): number | null {
    const n = this.byId.get(id);
    if (!n) return null;
    if (n.kind === 'service' || n.kind === 'worker' || n.kind === 'function' || n.kind === 'api_gateway') return n.dist('serviceMs').mean;
    if (n.kind === 'cache') return n.dist('opMs').mean;
    return null;
  }
}

function round(x: number, d: number): number {
  if (!Number.isFinite(x)) return x;
  const m = Math.pow(10, d);
  return Math.round(x * m) / m;
}

function addInst(a: InstStats, b: InstStats): void {
  a.up += b.up;
  a.started += b.started;
  a.waited += b.waited;
  a.waitSum += b.waitSum;
  a.holdSum += b.holdSum;
  a.holdSq += b.holdSq;
  a.holds += b.holds;
  a.busyArea += b.busyArea;
  a.qArea += b.qArea;
  a.maxQ = Math.max(a.maxQ, b.maxQ);
  a.rejected += b.rejected;
}

function addNode(a: NodeStats, b: NodeStats): void {
  a.arrivals += b.arrivals;
  a.ok += b.ok;
  a.fail += b.fail;
  for (const r of FAIL_REASONS) a.origin[r] += b.origin[r];
  a.hits += b.hits;
  a.misses += b.misses;
  a.coalesced += b.coalesced;
  a.leaseWaits += b.leaseWaits;
  a.hcOut += b.hcOut;
  a.ejections += b.ejections;
  a.enq += b.enq;
  a.deq += b.deq;
  a.depthArea += b.depthArea;
  a.maxDepth = Math.max(a.maxDepth, b.maxDepth);
  a.asyncOk += b.asyncOk;
  a.asyncFail += b.asyncFail;
  a.replApplied += b.replApplied;
  a.replDropped += b.replDropped;
  a.failovers += b.failovers;
  a.lostWrites += b.lostWrites;
  a.lockWaits += b.lockWaits;
  a.rywMisses += b.rywMisses;
  a.divergentWrites += b.divergentWrites;
  a.dualWriteGaps += b.dualWriteGaps;
  a.outboxRetries += b.outboxRetries;
  a.holBlocked += b.holBlocked;
  a.coldStarts += b.coldStarts;
  a.expired += b.expired;
  a.redelivered += b.redelivered;
  a.duplicates += b.duplicates;
  a.dlq += b.dlq;
  a.replicaReads += b.replicaReads;
  a.staleReads += b.staleReads;
  a.maxLagMs = Math.max(a.maxLagMs, b.maxLagMs);
}

/** A fixed pseudo-random number in [0, 1) for an id (murmur3 finaliser). */
function unitHash(id: number): number {
  let h = id ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function addEdge(a: EdgeStats, b: EdgeStats): void {
  a.calls += b.calls;
  a.read += b.read;
  a.write += b.write;
  a.ok += b.ok;
  a.fail += b.fail;
  a.retries += b.retries;
  a.late += b.late;
  a.denied += b.denied;
  a.throttled += b.throttled;
  a.bulkhead += b.bulkhead;
  a.fallbacks += b.fallbacks;
  a.hedges += b.hedges;
  a.attempts += b.attempts;
  a.hedgeWins += b.hedgeWins;
  a.connects += b.connects;
  a.copies += b.copies;
  a.crossRegion += b.crossRegion;
}

export function simulate(design: Design, scenario: Scenario, opts?: SimOptions): SimResult {
  return new Simulation(design, scenario, opts).runToEnd();
}
