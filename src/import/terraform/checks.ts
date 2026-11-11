// Static capacity checks on an import: no simulation, only the mapped
// design, its origins and facts, and the line kinds. Every finding says how sure it is:
//   definite   — every input is `iac` or `aws-default` (or a measured answer), every line is definite
//                or confirmed by the answer file;
//   user       — an input is from the answer file and not marked measured ("依使用者提供");
//   assumption — an input is an `estimate` or a loadsketch default, or a line is only presumed/candidate;
//   incomplete — an input or a line is missing: "資料不完整", never "no problem".
// Only a definite finding can be high; the others stop at medium, and --strict does not block them.
import { KINDS, type DesignEdge, type DesignNode, type ParamValue } from '../../core/index.ts';
import { ASSUME } from './instances.ts';
import type { ImportResult, Origin } from './result.ts';
import { proxyPercentFact } from './rules-platform.ts';

export type Severity = 'high' | 'medium' | 'low' | 'info';
export type Certainty = 'definite' | 'user' | 'assumption' | 'incomplete';
export interface Input { name: string; value: string | number | boolean; origin: Origin }
export interface Finding {
  check: string;
  severity: Severity;
  certainty: Certainty;
  /** The design node it is about. */
  node: string;
  /** The resources behind that node. */
  resources: string[];
  /** Message id and arguments for the conclusion and the formula (src/i18n/importMessages.ts). */
  id: string;
  args: Record<string, string | number>;
  /** Message id of the advice. */
  advice: string;
  inputs: Input[];
  /** Lines the formula used, with what they are based on. */
  lines: { id: string; kind: string; confirmed?: boolean }[];
}
export interface CheckOptions { peakRps?: { value: number; origin: Origin } }

const RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1, info: 0 };

function certaintyOf(inputs: (Input | undefined)[], lines: Finding['lines']): Certainty {
  if (inputs.some((i) => !i)) return 'incomplete';
  const ins = inputs as Input[];
  if (ins.some((i) => i.origin.evidence === 'estimate' || i.origin.evidence === 'loadsketch-default')) return 'assumption';
  if (lines.some((l) => (l.kind === 'presumed' || l.kind === 'candidate') && !l.confirmed)) return 'assumption';
  if (ins.some((i) => i.origin.evidence === 'answer' && !i.origin.measured)) return 'user';
  if (lines.some((l) => l.kind === 'answer')) return 'user';
  return 'definite';
}

export function runChecks(res: ImportResult, opts: CheckOptions = {}): Finding[] {
  const d = res.design;
  const byId = new Map(d.nodes.map((n) => [n.id, n]));
  const out: Finding[] = [];
  const lineOf = (e: DesignEdge) => {
    const k = res.edges[e.id!];
    const kind = k.kind === 'answer' && !k.measured ? 'answer' : k.kind === 'answer' ? 'definite' : k.kind;
    return { id: e.id!, kind, ...(k.confirmed ? { confirmed: true } : {}) };
  };
  /** A param as an input: its value and origin; a param the node does not set is the kind's default. */
  const param = (n: DesignNode, name: string, label = `${n.id}.${name}`): Input | undefined => {
    const v = n.params?.[name];
    if (v !== undefined) {
      const o = res.origins[n.id]?.[name];
      return o ? { name: label, value: scalar(v), origin: o } : undefined;
    }
    const spec = KINDS[n.kind]?.params[name];
    return spec ? { name: label, value: scalar(spec.default as ParamValue), origin: { evidence: 'loadsketch-default' } } : undefined;
  };
  const fact = (n: DesignNode, name: string): Input | undefined => {
    const f = res.facts[n.id]?.[name];
    return f ? { name: `${n.id}.${name}`, value: f.value, origin: f.origin } : undefined;
  };
  /** A param the import set (IaC, table, answer): an infrastructure limit is never a loadsketch default. */
  const own = (n: DesignNode, name: string): Input | undefined => (n.params?.[name] !== undefined ? param(n, name) : undefined);
  /** Connections each caller instance opens on this line. bulkhead 0 means no limit on the line
   *  (kinds.ts), so the caller's concurrency bounds it instead. */
  const pool = (e: DesignEdge, caller: DesignNode): { value: number; inputs: Input[] } | undefined => {
    const v = (e as unknown as Record<string, unknown>).bulkhead;
    const o = res.edgeOrigins[e.id!]?.bulkhead;
    if (typeof v === 'number' && o) {
      const b: Input = { name: `${e.id}.bulkhead`, value: v, origin: o };
      if (v > 0) return { value: v, inputs: [b] };
      // A function has no concurrency param: an environment serves one request at a time, so no
      // limit on the line still means about one connection each.
      if (caller.kind === 'function') return { value: ASSUME.poolPerFunction, inputs: [b, { name: `${caller.id}.connectionsPerEnvironment`, value: ASSUME.poolPerFunction, origin: { evidence: 'estimate', source: 'src/import/terraform/instances.ts (poolPerFunction)' } }] };
      // Both are inputs: the bound is only as sure as the weaker of the two.
      const conc = param(caller, 'concurrency');
      return conc ? { value: Number(conc.value), inputs: [b, conc] } : undefined;
    }
    // A function environment serves one request at a time: about one connection each.
    if (caller.kind === 'function') return { value: ASSUME.poolPerFunction, inputs: [{ name: `${caller.id}.connectionsPerEnvironment`, value: ASSUME.poolPerFunction, origin: { evidence: 'estimate', source: 'src/import/terraform/instances.ts (poolPerFunction)' } }] };
    return { value: ASSUME.poolPerInstance, inputs: [{ name: `${caller.id}.pool`, value: ASSUME.poolPerInstance, origin: { evidence: 'estimate', source: 'src/import/terraform/instances.ts (poolPerInstance)' } }] };
  };
  /** The param that says how many instances a caller runs at most: maxInstances with autoscaling. */
  const ceilingName = (n: DesignNode) => (n.params?.autoscale === 'on' ? 'maxInstances' : 'instances');
  const ceiling = (n: DesignNode): Input | undefined => own(n, ceilingName(n));
  const add = (f: Omit<Finding, 'certainty' | 'resources' | 'inputs'> & { inputs: (Input | undefined)[] }) => {
    const certainty = certaintyOf(f.inputs, f.lines);
    const severity = certainty === 'definite' || RANK[f.severity] < RANK.medium ? f.severity : 'medium';
    out.push({ ...f, severity, certainty, inputs: f.inputs.filter((i): i is Input => !!i), resources: res.nodeFrom[f.node] ?? [] });
  };
  const incomplete = (check: string, node: string, missing: string) =>
    out.push({ check, severity: 'info', certainty: 'incomplete', node, resources: res.nodeFrom[node] ?? [], id: 'check.incomplete', args: { check, missing }, advice: 'check.incomplete.advice', inputs: [], lines: [] });
  const callersOf = (db: DesignNode) => d.edges.filter((e) => e.to === db.id && ['service', 'worker', 'function'].includes(byId.get(e.from)?.kind ?? ''));
  const through = (e: DesignEdge) => res.edges[e.id!]?.through;
  /** Every proxy a proxied line can reach: the caller may use any of them, so each pool counts it. */
  const routes = (e: DesignEdge): string[] => {
    const info = res.edges[e.id!];
    return info?.through ? (info.routes ?? [info.through]) : [];
  };
  /** The limit a group of callers is held to: max_connections, or the proxy's share of it (C1, C2). */
  const limits = (db: DesignNode, viaProxy: string | false): { high?: Input; low?: Input; proxy?: Input } => {
    const high = fact(db, 'maxConnectionsAllMemory');
    const low = fact(db, 'maxConnectionsAfterReserve');
    if (!viaProxy) return { high, low };
    // A DB with several proxies: each proxy's own share (its own pool).
    const pct = fact(db, proxyPercentFact(viaProxy)) ?? fact(db, 'proxyMaxConnectionsPercent');
    if (!pct || !high || !low) return { proxy: pct };
    const share = (b: Input): Input => ({ name: `${b.name} × ${pct.value}%`, value: Math.floor((Number(b.value) * Number(pct.value)) / 100), origin: b.origin });
    return { high: share(high), low: share(low), proxy: pct };
  };
  /** Sum caller ceilings × pools against a DB limit (both bounds); `kind` picks C1 or C2 wording. */
  const connections = (check: 'C1' | 'C2', db: DesignNode, edges: DesignEdge[], viaProxy: string | false) => {
    if (!edges.length) return;
    const { high, low, proxy } = limits(db, viaProxy);
    if (!high || !low) return incomplete(check, db.id, viaProxy && !proxy ? 'max_connections_percent' : 'max_connections');
    const terms = edges.map((e) => {
      const n = byId.get(e.from)!;
      return { e, n, cap: n.kind === 'function' ? own(n, 'maxConcurrency') : ceiling(n), capName: n.kind === 'function' ? 'maxConcurrency' : ceilingName(n), pool: pool(e, n) };
    });
    const gaps = terms.flatMap((t) => [...(t.cap ? [] : [`${t.n.id}.${t.capName}`]), ...(t.pool ? [] : [`${t.n.id}.concurrency`])]);
    if (gaps.length) return incomplete(check, db.id, gaps.join(', '));
    const total = terms.reduce((s, t) => s + Number(t.cap!.value) * Number(t.pool!.value), 0);
    const formula = terms.map((t) => `${t.cap!.value} × ${t.pool!.value}`).join(' + ');
    const lines = terms.map((t) => lineOf(t.e));
    const base = [...terms.flatMap((t) => [t.cap, ...t.pool!.inputs]), ...(proxy ? [proxy] : [])];
    const id = `check.${check}${viaProxy ? '.proxy' : ''}`;
    if (total > Number(high.value)) add({ check, severity: 'high', node: db.id, id, args: { formula, total, limit: Number(high.value) }, advice: `check.${check}.advice`, inputs: [...base, high], lines });
    else if (total > Number(low.value)) add({ check, severity: 'high', node: db.id, id: `${id}.reserve`, args: { formula, total, limit: Number(low.value), high: Number(high.value) }, advice: `check.${check}.advice`, inputs: [...base, low], lines });
  };

  for (const db of d.nodes.filter((n) => n.kind === 'database')) {
    const engine = fact(db, 'engine');
    // DynamoDB has no connection limit and is spread over AZs: C1, C2, C3 and C10 do not apply.
    if (engine?.value === 'dynamodb') continue;
    const callers = callersOf(db);
    const low = fact(db, 'maxConnectionsAfterReserve');
    // C1: the pools of every service and worker, at their most instances, against max_connections
    // (both bounds), or against the proxy's share for the callers that go through it. Functions are C2.
    const servers = callers.filter((e) => byId.get(e.from)!.kind !== 'function');
    const fns = callers.filter((e) => byId.get(e.from)!.kind === 'function');
    if (!callers.length) incomplete('C1', db.id, 'lines');
    connections('C1', db, servers.filter((e) => !through(e)), false);
    // Each proxy against every caller that can reach it (a caller of two proxies counts in both).
    const proxies = [...new Set(servers.flatMap(routes))];
    for (const p of proxies) connections('C1', db, servers.filter((e) => routes(e).includes(p)), p);
    // Several proxies share the DB: every proxied pool together against max_connections.
    if (proxies.length > 1) connections('C1', db, servers.filter((e) => through(e)), false);
    // C2: function concurrency × connections per environment, with no RDS Proxy in between.
    connections('C2', db, fns.filter((e) => !through(e)), false);
    // C3: a single-AZ database (high in production); Aurora: a single instance.
    const env = fact(db, 'environment');
    const prod = env && /^prod/i.test(String(env.value));
    const count = fact(db, 'instanceCount');
    const multiAz = fact(db, 'multiAz');
    if (count) {
      if (Number(count.value) <= 1) add({ check: 'C3', severity: prod ? 'high' : 'medium', node: db.id, id: 'check.C3.aurora', args: { n: Number(count.value) }, advice: 'check.C3.aurora.advice', inputs: [count, ...(prod ? [env] : [])], lines: [] });
    } else if (!multiAz) incomplete('C3', db.id, 'multi_az');
    else if (multiAz.value === false) {
      add({ check: 'C3', severity: prod ? 'high' : 'medium', node: db.id, id: 'check.C3.db', args: {}, advice: 'check.C3.db.advice', inputs: [multiAz, ...(prod ? [env] : [])], lines: [] });
    }
    // C10: autoscaled callers on a single DB with no replica and no cache, near the connection limit.
    // Read replicas are separate DB nodes (replicate_source_db), so `replicas` 0 alone proves nothing;
    // a DB that is itself a replica is not the single DB either.
    const scaled = servers.filter((e) => byId.get(e.from)!.params?.autoscale === 'on' && !through(e));
    const replicas = param(db, 'replicas');
    const single = replicas && Number(replicas.value) === 0 && !fact(db, 'readReplicas') && !fact(db, 'replicaOf');
    const cached = scaled.some((e) => d.edges.some((x) => x.from === e.from && byId.get(x.to)?.kind === 'cache'));
    if (scaled.length && low && single && !cached) {
      const terms = scaled.map((e) => ({ e, n: byId.get(e.from)!, cap: own(byId.get(e.from)!, 'maxInstances'), pool: pool(e, byId.get(e.from)!) }));
      const gaps = terms.flatMap((t) => [...(t.cap ? [] : [`${t.n.id}.maxInstances`]), ...(t.pool ? [] : [`${t.n.id}.concurrency`])]);
      const total = terms.reduce((s, t) => s + Number(t.cap?.value ?? 0) * Number(t.pool?.value ?? 0), 0);
      const limit = Math.floor(0.8 * Number(low.value));
      if (gaps.length) incomplete('C10', db.id, gaps.join(', '));
      else if (total > limit) {
        add({ check: 'C10', severity: 'medium', node: db.id, id: 'check.C10', args: { formula: terms.map((t) => `${t.cap!.value} × ${t.pool!.value}`).join(' + '), total, limit, max: Number(low.value) }, advice: 'check.C10.advice', inputs: [...terms.flatMap((t) => [t.cap, ...t.pool!.inputs]), low, replicas], lines: terms.map((t) => lineOf(t.e)) });
      }
    }
  }

  for (const s of d.nodes.filter((n) => n.kind === 'service')) {
    // C3: every instance in one AZ.
    const zones = fact(s, 'zones');
    if (zones && String(zones.value).split(',').length === 1) add({ check: 'C3', severity: 'medium', node: s.id, id: 'check.C3.service', args: { zone: String(zones.value) }, advice: 'check.C3.service.advice', inputs: [zones], lines: [] });
    // C4: the most rps it can take (70% of capacity) against the peak, or just the number.
    const cap = ceiling(s);
    const conc = param(s, 'concurrency');
    const ms = param(s, 'serviceMs');
    if (!cap || !conc || !ms) incomplete('C4', s.id, [...(cap ? [] : [`${s.id}.${ceilingName(s)}`]), ...(conc ? [] : [`${s.id}.concurrency`]), ...(ms ? [] : [`${s.id}.serviceMs`])].join(', '));
    else {
      const rps = Math.floor(Number(cap.value) * (Number(conc.value) / (Number(ms.value) / 1000)) * 0.7);
      const formula = `${cap.value} × ${conc.value} / ${ms.value} ms × 0.7`;
      const peak = opts.peakRps;
      if (peak && rps < peak.value) add({ check: 'C4', severity: 'high', node: s.id, id: 'check.C4.short', args: { formula, rps, peak: peak.value }, advice: 'check.C4.advice', inputs: [cap, conc, ms, { name: 'traffic.peakRps', value: peak.value, origin: peak.origin }], lines: [] });
      else if (!peak) add({ check: 'C4', severity: 'info', node: s.id, id: 'check.C4.max', args: { formula, rps }, advice: 'check.C4.max.advice', inputs: [cap, conc, ms], lines: [] });
      // The real floor (min_capacity), not `instances`: that is the start, which can be above it.
      const floor = fact(s, 'minInstances');
      if (s.params?.autoscale === 'on' && floor && cap.value === floor.value) add({ check: 'C4', severity: 'info', node: s.id, id: 'check.C4.noRoom', args: { n: Number(cap.value) }, advice: 'check.C4.noRoom.advice', inputs: [cap, floor], lines: [] });
    }
  }

  // C3: a cache with one node, or with no automatic failover.
  for (const c of d.nodes.filter((n) => n.kind === 'cache')) {
    const nodes = fact(c, 'numCacheClusters');
    const auto = fact(c, 'automaticFailover');
    if (nodes && Number(nodes.value) <= 1) add({ check: 'C3', severity: 'medium', node: c.id, id: 'check.C3.cacheSingle', args: {}, advice: 'check.C3.cache.advice', inputs: [nodes], lines: [] });
    else if (auto && auto.value === false) add({ check: 'C3', severity: 'medium', node: c.id, id: 'check.C3.cacheFailover', args: {}, advice: 'check.C3.cache.advice', inputs: [auto], lines: [] });
  }

  // C5: timeouts in the wrong order.
  for (const e of d.edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to || to.kind !== 'function') continue;
    const fnTimeout = fact(to, 'timeoutS');
    if (!fnTimeout) continue;
    const ms = (e as unknown as Record<string, unknown>).timeoutMs;
    const o = res.edgeOrigins[e.id!]?.timeoutMs;
    // The caller gives up first: the function keeps working for nobody.
    if (typeof ms === 'number' && o && ms < Number(fnTimeout.value) * 1000) {
      const up: Input = { name: `${e.id}.timeoutMs`, value: ms, origin: o };
      add({ check: 'C5', severity: 'medium', node: to.id, id: 'check.C5.caller', args: { caller: from.id, upS: ms / 1000, downS: Number(fnTimeout.value) }, advice: 'check.C5.caller.advice', inputs: [up, fnTimeout], lines: [lineOf(e)] });
    }
    // SQS: the visibility timeout should be at least 6 × the function timeout (AWS).
    const vis = from.kind === 'queue' ? fact(from, 'visibilityS') : undefined;
    if (vis && Number(vis.value) < 6 * Number(fnTimeout.value)) add({ check: 'C5', severity: 'medium', node: from.id, id: 'check.C5.visibility', args: { visibility: Number(vis.value), timeout: Number(fnTimeout.value), need: 6 * Number(fnTimeout.value) }, advice: 'check.C5.visibility.advice', inputs: [vis, fnTimeout], lines: [lineOf(e)] });
  }

  // C6: attempts multiplied along a path into a queue: the sender's SDK retries × deliveries.
  for (const q of d.nodes.filter((n) => n.kind === 'queue')) {
    const senders = d.edges.filter((e) => e.to === q.id && ['service', 'worker', 'function'].includes(byId.get(e.from)?.kind ?? ''));
    if (!senders.length || !fact(q, 'redrive')?.value) continue;
    const receives = fact(q, 'maxReceiveCount');
    if (!receives) {
      incomplete('C6', q.id, `${q.id}.maxReceiveCount`);
      continue;
    }
    const sdk: Input = { name: 'sdk.attempts', value: ASSUME.sdkAttempts, origin: { evidence: 'estimate', source: 'src/import/terraform/instances.ts (sdkAttempts: AWS SDK standard retry mode, 3 attempts)' } };
    const product = ASSUME.sdkAttempts * Number(receives.value);
    if (product > 10) add({ check: 'C6', severity: 'medium', node: q.id, id: 'check.C6', args: { formula: `SDK ${ASSUME.sdkAttempts} × maxReceiveCount ${receives.value}`, total: product }, advice: 'check.C6.advice', inputs: [sdk, receives], lines: senders.map(lineOf) });
  }

  // C7: failed messages and events with nowhere to go.
  for (const q of d.nodes.filter((n) => n.kind === 'queue')) {
    const r = fact(q, 'redrive');
    if (r && r.value === false) add({ check: 'C7', severity: 'medium', node: q.id, id: 'check.C7.queue', args: {}, advice: 'check.C7.queue.advice', inputs: [r], lines: [] });
  }
  for (const f of d.nodes.filter((n) => n.kind === 'function')) {
    const target = fact(f, 'asyncFailureTarget');
    if (fact(f, 'asyncInvoked')?.value === true && target && target.value === false) add({ check: 'C7', severity: 'medium', node: f.id, id: 'check.C7.async', args: {}, advice: 'check.C7.async.advice', inputs: [fact(f, 'asyncInvoked'), target], lines: [] });
  }

  // C8: a front door wider than what is behind it (the gateway throttle against the next hop's capacity).
  for (const t of d.nodes.filter((n) => n.kind === 'rate_limiter')) {
    const gw = d.edges.find((e) => e.from === t.id && byId.get(e.to)?.kind === 'api_gateway');
    if (!gw) continue;
    const rate = own(t, 'ratePerSec');
    if (!rate) continue;
    for (const e of d.edges.filter((x) => x.from === gw.to)) {
      const to = byId.get(e.to)!;
      const cap = to.kind === 'function' ? own(to, 'maxConcurrency') : ['service', 'worker'].includes(to.kind) ? ceiling(to) : undefined;
      const per = to.kind === 'function' ? undefined : param(to, 'concurrency');
      const ms = param(to, 'serviceMs');
      if (!cap || !ms || (to.kind !== 'function' && !per)) continue;
      const capacity = Math.floor((Number(cap.value) * Number(per?.value ?? 1)) / (Number(ms.value) / 1000));
      const formula = to.kind === 'function' ? `${cap.value} / ${ms.value} ms` : `${cap.value} × ${per!.value} / ${ms.value} ms`;
      if (Number(rate.value) > capacity) add({ check: 'C8', severity: 'medium', node: t.id, id: 'check.C8', args: { rate: Number(rate.value), target: to.id, formula, capacity }, advice: 'check.C8.advice', inputs: [rate, cap, ...(per ? [per] : []), ms], lines: [lineOf(gw), lineOf(e)] });
    }
  }

  // C11: provisioned DynamoDB capacity with no autoscaling.
  for (const db of d.nodes.filter((n) => n.kind === 'database' && fact(n, 'engine')?.value === 'dynamodb')) {
    const auto = fact(db, 'capacityAutoscaling');
    if (fact(db, 'billingMode')?.value === 'PROVISIONED' && auto && auto.value === false) add({ check: 'C11', severity: 'low', node: db.id, id: 'check.C11', args: {}, advice: 'check.C11.advice', inputs: [fact(db, 'billingMode'), auto], lines: [] });
  }

  // C9: failure detection slower than 60 s (load balancer) or 90 s (Route 53).
  for (const r of d.nodes.filter((n) => n.kind === 'dns')) {
    const iv = fact(r, 'requestInterval');
    const th = fact(r, 'failureThreshold');
    if (iv && th && Number(iv.value) * Number(th.value) > 90) add({ check: 'C9', severity: 'low', node: r.id, id: 'check.C9.dns', args: { interval: Number(iv.value), threshold: Number(th.value), total: Number(iv.value) * Number(th.value) }, advice: 'check.C9.dns.advice', inputs: [iv, th], lines: [] });
  }
  for (const lb of d.nodes.filter((n) => n.kind === 'load_balancer')) {
    if (!lb.params?.hcIntervalS) continue;
    const iv = param(lb, 'hcIntervalS');
    const th = param(lb, 'hcThreshold');
    if (iv && th && Number(iv.value) * Number(th.value) > 60) add({ check: 'C9', severity: 'low', node: lb.id, id: 'check.C9', args: { interval: Number(iv.value), threshold: Number(th.value), total: Number(iv.value) * Number(th.value) }, advice: 'check.C9.advice', inputs: [iv, th], lines: [] });
  }
  return out.sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.check.localeCompare(b.check, undefined, { numeric: true }));
}

/** --strict fails on these: only definite findings can be high. */
export const blocking = (fs: Finding[]) => fs.filter((f) => f.severity === 'high' && f.certainty === 'definite');

const scalar = (v: ParamValue): string | number => (typeof v === 'object' ? v.mean : v);
