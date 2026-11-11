// A scenario for a check finding: the checks tab says what can go wrong in numbers; this
// makes the situation happen in the simulator, so the user sees what it does. The engine is not
// changed: each finding maps to traffic and events the engine already has. Where the engine does not
// model the mechanism (it has no max_connections: a database's `connections` are the queries it runs at
// once), the scenario shows the nearest effect and the note says so.
import { KINDS, SCENARIO_SCHEMA, type Design, type DesignNode, type ParamValue, type Scenario, type ScenarioEvent } from '../../core/index.ts';
import type { Finding } from './checks.ts';
import { warmUpS } from './simulate.ts';

/** What the run shows, as a key the UI turns into a sentence (src/app/components/ImportChecks.tsx). */
export type SimNote =
  | 'connections' | 'peak' | 'max' | 'noRoom' | 'throttled' | 'down' | 'zone' | 'callerTimeout'
  | 'visibility' | 'retries' | 'noDlq' | 'asyncFail' | 'gateway' | 'detect';
/** Why there is no scenario. */
export type NoSim = 'incomplete' | 'missingNode' | 'changed' | 'unreachable' | 'beyondEngine' | 'tooLong' | 'sharedQueue' | 'noHealthCheck' | 'unknown';
export type SimFor = { scenario: Scenario; note: SimNote; args: Record<string, number | string> } | { none: NoSim };

/** Seconds: events start at EVENT_AT and last EVENT_FOR; an event scenario runs DURATION. */
const EVENT_AT = 20;
const EVENT_FOR = 60;
const DURATION = 120;
/** A ramp goes from 1× to RAMP× the base traffic. */
const RAMP = 4;  // at most: the start is also kept at the healthy level
const MAX_RPS = 1_000_000;
const MAX_MULT = 1000;
const MAX_DURATION = 3600;

const mean = (v: ParamValue | undefined): number | undefined =>
  typeof v === 'number' ? v : v && typeof v === 'object' ? v.mean : undefined;
function num(n: DesignNode, name: string): number | undefined {
  const v = n.params?.[name] ?? (KINDS[n.kind]?.params[name]?.default as ParamValue | undefined);
  return mean(v);
}
/** Work time of one request on the node (ms). */
function workMs(n: DesignNode): number | undefined {
  if (n.kind === 'database' || n.kind === 'sharded_db') {
    const r = num(n, 'readMs');
    const w = num(n, 'writeMs');
    return r !== undefined && w !== undefined ? 0.9 * r + 0.1 * w : undefined;
  }
  return num(n, 'serviceMs') ?? num(n, 'opMs');
}
/** Requests per second the node can do: its slots over its work time. `atMost`: at its most instances. */
export function capacityOf(n: DesignNode, atMost = false): number | undefined {
  const ms = workMs(n);
  if (!ms) return undefined;
  if (n.kind === 'function') {
    const c = num(n, 'maxConcurrency');
    return c ? (c * 1000) / ms : undefined;
  }
  const slots = num(n, 'concurrency') ?? num(n, 'connections');
  const auto = n.params?.autoscale === 'on';
  const inst = (atMost && auto ? num(n, 'maxInstances') : undefined) ?? num(n, 'instances') ?? 1;
  return slots ? (inst * slots * 1000) / ms : undefined;
}

const rps = (x: number) => Math.max(1, Math.min(MAX_RPS, Math.round(x)));
const base = (name: string, durationS: number, r: number, events: ScenarioEvent[], warmupS = 5): Scenario => ({
  schema: SCENARIO_SCHEMA,
  name,
  seed: 1,
  durationS,
  warmupS,
  traffic: { rps: rps(r), readRatio: 0.9 },
  ...(events.length ? { events } : {}),
});

export function scenarioFor(f: Finding, d: Design): SimFor {
  if (f.certainty === 'incomplete' || f.id === 'check.incomplete') return { none: 'incomplete' };
  const byId = new Map(d.nodes.map((n) => [n.id, n]));
  const node = byId.get(f.node);
  if (!node) return { none: 'missingNode' };
  const name = `${f.check} · ${f.node}`;
  /** Lines requests take: not the boot and control lines, which the engine keeps out of traffic. */
  const live = d.edges.filter((e) => {
    const on = (e as unknown as Record<string, unknown>).on;
    return on !== 'boot' && on !== 'control';
  });
  /** The nodes a node sends requests to, each once. */
  const outs = (id: string) => [...new Set(live.filter((e) => e.from === id).map((e) => e.to))].map((x) => byId.get(x)).filter((n): n is DesignNode => !!n);
  /** Half of the smallest capacity in the design (a rate limiter counts at its rate): the whole system
   *  is healthy before the event, not only the node of the finding. Fan-out is not counted. */
  const floor = Math.min(...d.nodes.map((n) => (n.kind === 'rate_limiter' ? num(n, 'ratePerSec') : capacityOf(n)) ?? Infinity));
  const healthy = 0.5 * (Number.isFinite(floor) ? floor : 400);
  const calm = (n: DesignNode, share = 0.5) => Math.min(healthy, share * (capacityOf(n) ?? 400));
  /** Nodes traffic reaches: from the clients along the lines (an async function with no
   *  modelled source gets no requests, so an event on it shows nothing). */
  const reached = new Set<string>();
  const todo = d.nodes.filter((n) => n.kind === 'client').map((n) => n.id);
  while (todo.length) {
    const id = todo.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const e of live) if (e.from === id) todo.push(e.to);
  }
  /** A run with one event. `forS` and `durationS` default to EVENT_FOR and DURATION. */
  const event = (r: number, ev: ScenarioEvent, note: SimNote, args: Record<string, number | string> = {}, durationS = DURATION): SimFor => {
    if ('node' in ev && ev.node && !reached.has(ev.node)) return { none: 'unreachable' };
    // a run cut short would end before the failure shows: say so instead
    if (durationS > MAX_DURATION) return { none: 'tooLong' };
    const forS = 'forS' in ev && ev.forS !== undefined ? ev.forS : EVENT_FOR;
    return { scenario: base(name, durationS, r, [ev]), note, args: { node: f.node, at: EVENT_AT, for: forS, ...args } };
  };
  /** The slowdown that makes a node of `ms` take longer than `deadlineMs`, with a margin; none when even
   *  the engine's largest slowdown is not enough (the margin is dropped first). */
  const slower = (ms: number, deadlineMs: number): number | undefined => {
    const need = deadlineMs / ms;
    return need >= MAX_MULT ? undefined : Math.min(MAX_MULT, Math.ceil(1.5 * need));
  };
  /** The line the finding was made for, as it is on the canvas now. */
  const line = () => d.edges.find((e) => e.id === f.lines[0]?.id);
  /** Traffic from target ÷ RAMP (at most the healthy level) up to target, over the run after the
   *  warm-up (autoscaled nodes get time). */
  const ramp = (target: number, note: SimNote, args: Record<string, number | string> = {}): SimFor => {
    if (!reached.has(node.id)) return { none: 'unreachable' };
    const warm = Math.min(600, warmUpS(d));
    const durationS = warm + DURATION;
    const r = rps(Math.min(target / RAMP, healthy));
    const k = Math.min(MAX_MULT, Math.max(1, Math.round((target / r) * 10) / 10));
    return {
      scenario: base(name, durationS, r, [{ type: 'ramp', atS: 10, forS: durationS - 40, toMultiplier: k }], Math.min(warm, durationS / 2)),
      note,
      args: { node: f.node, from: r, to: Math.round(r * k), ...args },
    };
  };
  const steady = (r: number, note: SimNote, args: Record<string, number | string> = {}): SimFor => {
    if (!reached.has(node.id)) return { none: 'unreachable' };
    const warm = Math.min(600, warmUpS(d));
    return { scenario: base(name, warm + DURATION, r, [], Math.min(warm, (warm + DURATION) / 2)), note, args: { node: f.node, rps: rps(r), ...args } };
  };
  /** The worker or function that takes the queue's messages. */
  const consumer = () => outs(node.id).find((n) => ['worker', 'function', 'service'].includes(n.kind));

  switch (f.check) {
    case 'C1':
    case 'C2':
    case 'C10': {
      // No max_connections in the engine: raise the traffic to twice what the database can do, so the
      // callers scale out and their queries wait for the database's slots.
      const cap = capacityOf(node);
      return cap ? ramp(2 * cap, 'connections', { limit: Number(f.args.limit ?? 0) }) : { none: 'unknown' };
    }
    case 'C4': {
      if (f.id === 'check.C4.short') return steady(Number(f.args.peak), 'peak');
      const cap = capacityOf(node, true);
      // C4.max: the limit from the service as it is now (70% of its capacity, as the check computes it)
      if (f.id === 'check.C4.max') return cap ? ramp(1.5 * 0.7 * cap, 'max', { max: Math.floor(0.7 * cap) }) : { none: 'unknown' };
      return cap ? ramp(1.5 * cap, 'noRoom', { n: Number(f.args.n ?? 0) }) : { none: 'unknown' };
    }
    case 'C11': {
      // Provisioned capacity with no autoscaling: the table's throttle, when the import made one.
      const limiter = d.edges.map((e) => (e.to === node.id ? byId.get(e.from) : undefined)).find((n) => n?.kind === 'rate_limiter');
      const limit = limiter ? num(limiter, 'ratePerSec') : undefined;
      if (limit) return ramp(3 * limit, 'throttled', { limit });
      const cap = capacityOf(node);
      return cap ? ramp(2 * cap, 'throttled', { limit: rps(cap) }) : { none: 'unknown' };
    }
    case 'C3': {
      // One AZ, one instance or no failover: that one place fails. A database loses its primary.
      const instance = node.kind === 'database' ? { instance: 0 } : {};
      const ev: ScenarioEvent = { type: 'down', atS: EVENT_AT, forS: EVENT_FOR, node: node.id, ...instance };
      return event(calm(node), ev, f.id === 'check.C3.service' ? 'zone' : 'down');
    }
    case 'C5': {
      if (f.id === 'check.C5.caller') {
        // The function gets slow enough that the caller gives up first: the caller's timeout as it is
        // now on the line the finding was made for.
        const e = line();
        const upMs = (e as unknown as Record<string, unknown> | undefined)?.timeoutMs;
        if (!e || e.to !== node.id || typeof upMs !== 'number') return { none: 'changed' };
        const ms = workMs(node);
        if (!ms) return { none: 'unknown' };
        const m = slower(ms, upMs);
        if (!m) return { none: 'beyondEngine' };
        // the last slowed call starts at the end of the window and gives up one timeout later
        const durationS = Math.max(DURATION, Math.ceil(EVENT_AT + EVENT_FOR + upMs / 1000 + 30));
        return event(calm(node, 0.3), { type: 'slow', atS: EVENT_AT, forS: EVENT_FOR, node: node.id, multiplier: m }, 'callerTimeout', { multiplier: m, upS: upMs / 1000 }, durationS);
      }
      // The consumer of this finding's line takes longer than the visibility timeout: the message shows
      // again and is done twice. The run lasts until the slow messages have shown again.
      const e = line();
      const c = e && e.from === node.id ? byId.get(e.to) : undefined;
      const vis = num(node, 'visibilityTimeoutMs');
      if (!c || !vis) return { none: 'changed' };
      // The engine gives a queue's messages to its first consumer while it has room: another consumer
      // may get none while it is slow.
      if (outs(node.id).filter((n) => ['worker', 'function', 'service'].includes(n.kind)).length > 1) return { none: 'sharedQueue' };
      const ms = workMs(c);
      if (!ms) return { none: 'unknown' };
      const m = slower(ms, vis);
      if (!m) return { none: 'beyondEngine' };
      // The visibility timer starts when a message is given out (engine deliver()), while the work goes
      // on: a message slowed at the end of the window shows again one timeout later.
      // ... and the slowed work started at the end of the window must also end, or no message is done
      // twice yet (speed coming back does not shorten work already running).
      const durationS = Math.max(DURATION, Math.ceil(EVENT_AT + EVENT_FOR + Math.max(vis, m * ms) / 1000 + 30));
      return event(calm(c, 0.3), { type: 'slow', atS: EVENT_AT, forS: EVENT_FOR, node: c.id, multiplier: m }, 'visibility', { consumer: c.id, multiplier: m, visibilityS: vis / 1000 }, durationS);
    }
    case 'C6':
    case 'C7': {
      // Every attempt fails for a while: see the messages tried again and again (C6), with no DLQ to
      // stop them (C7 queue), or async events lost (C7 function).
      const target = f.id === 'check.C7.async' ? node : consumer();
      if (!target) return { none: 'unknown' };
      const note: SimNote = f.check === 'C6' ? 'retries' : f.id === 'check.C7.async' ? 'asyncFail' : 'noDlq';
      // A failed message shows again only after the visibility timeout: the failures last for several
      // deliveries (the DLQ's count, at most 5) and the run one more timeout after them.
      // A message shows again one visibility timeout after it was given out (the timer runs while the
      // work goes on: engine deliver()), and an attempt fails when its work ends
      //. So delivery k starts at (k − 1) × visibility, and the failures last until the
      // last delivery's work has ended; the run, one more timeout. Fewer deliveries when they do not fit.
      const vis = target === node ? undefined : num(node, 'visibilityTimeoutMs');
      const visS = (vis ?? 0) / 1000;
      const workS = (workMs(target) ?? 0) / 1000;
      // A slot stays busy until its work ends, even after the message shows again: the
      // next delivery starts after the longer of the two.
      const failS = (k: number) => Math.ceil((k - 1) * Math.max(visS, workS) + workS) + 1;
      let tries = Math.min(5, num(node, 'maxReceives') || 3);
      while (vis && tries > 1 && EVENT_AT + failS(tries) + Math.ceil(visS) + 30 > MAX_DURATION) tries--;
      const forS = vis ? Math.max(EVENT_FOR / 2, failS(tries)) : EVENT_FOR / 2;
      const durationS = vis ? EVENT_AT + forS + Math.ceil(Math.max(visS, workS)) + 30 : DURATION;
      return event(calm(target, 0.3), { type: 'errors', atS: EVENT_AT, forS, node: target.id, rate: 1 }, note, { target: target.id }, durationS);
    }
    case 'C8':
      // Traffic at the throttle's rate: everything it lets in, more than the next hop can do.
      // The throttle and the next hop as they are on the canvas now.
      {
        const rate = num(node, 'ratePerSec');
        const to = byId.get(String(f.args.target));
        const cap = to && capacityOf(to, true);
        if (!rate || !cap) return { none: 'changed' };
        return steady(rate, 'gateway', { target: to.id, capacity: Math.floor(cap) });
      }
    case 'C9': {
      // One target behind the load balancer (or the DNS record's first target) fails; see how long
      // requests still go to it before the health check notices.
      const target = outs(node.id)[0];
      if (!target) return { none: 'unknown' };
      // The engine health-checks instances behind a load balancer; a function has execution
      // environments, not registered instances, so there is no detection delay to show.
      if (node.kind === 'load_balancer' && target.kind === 'function') return { none: 'noHealthCheck' };
      const ev: ScenarioEvent = { type: 'down', atS: EVENT_AT, forS: EVENT_FOR, node: target.id, ...(node.kind === 'load_balancer' ? { instance: 0 } : {}) };
      return event(calm(target), ev, 'detect', { target: target.id, total: Number(f.args.total) });
    }
  }
  return { none: 'unknown' };
}
