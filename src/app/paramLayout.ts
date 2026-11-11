// How the inspector lays out a component's or an edge's parameters: groups, which ones show, which
// "0 means off" values become a switch, which ones are percents. UI only: the JSON format and the
// engine do not change. Pure functions, so tests can check the layout without a browser.
import { EDGE_PARAMS, KINDS, type ParamSpec, whenHolds } from '../schema/kinds.ts';
import { tx } from '../i18n/index.ts';

/** The edge's parameters use the kind name 'edge'. */
export const EDGE = 'edge';

export interface GroupDef {
  key: string;
  label: string;
  params: string[];
  /** Collapsed while every parameter in it keeps its default; the summary then says "off". */
  fold?: boolean;
}

const g = (key: string, label: string, params: string[], fold = false): GroupDef => ({ key, label, params, fold });
const CAP = g('capacity', tx('容量'), ['shards', 'instances', 'concurrency', 'connections', 'queueLimit']);
const TIME = g('time', tx('處理時間'), ['serviceMs', 'readMs', 'writeMs', 'opMs', 'getMs', 'putMs']);
const CALLS = g('calls', tx('呼叫下游'), ['calls', 'outbox', 'outboxRetryMs']);
const OVERLOAD = g('overload', tx('過載保護'), ['shedAt', 'queueOrder', 'codelTargetMs'], true);
const SCALE = g('scale', tx('自動擴充'), ['autoscale', 'maxInstances', 'targetUtil', 'scaleEveryS', 'scaleDownS', 'bootS', 'warmS', 'coldFactor'], true);
const FAULT = g('fault', tx('故障注入'), ['errorRate', 'poisonRate'], true);
const REPL = g('replicas', tx('副本'), ['replicas', 'readFrom', 'replicaApplyRatio', 'replicaDelayMs', 'maxLagMs', 'localReplicas', 'failover', 'failoverS', 'fencing', 'readYourWrites', 'rywWindowMs']);
const LOCKS = g('locks', tx('鎖'), ['locks', 'lockHoldMs'], true);
const SERVER = [CAP, TIME, CALLS, OVERLOAD, SCALE, FAULT];
const DB = [CAP, TIME, REPL, LOCKS, FAULT];
const FUNCTION = [
  g('capacity', tx('容量'), ['maxConcurrency', 'provisioned', 'scalePer10s']),
  g('time', tx('處理時間'), ['serviceMs', 'coldStartMs', 'idleS']),
  g('calls', tx('呼叫下游'), ['calls']),
  FAULT,
];

/** Groups per kind, in order. A parameter no group lists lands in "其他" (tests keep that empty). */
export const GROUPS: Record<string, GroupDef[]> = {
  [EDGE]: [
    g('route', tx('路由'), ['on', 'weight']),
    g('network', tx('網路'), ['latencyMs', 'timeoutMs']),
    g('retry', tx('重試'), ['retries', 'backoffMs', 'retryBudget'], true),
    g('protect', tx('保護'), ['throttleK', 'bulkhead', 'hedgeMs', 'fallback'], true),
    g('fanout', tx('扇出'), ['fanout', 'quorum'], true),
    g('conn', tx('連線'), ['connectMs', 'keepAlive', 'idleS'], true),
  ],
  client: [g('traffic', tx('流量'), ['weight', 'deadline', 'priority'])],
  dns: [g('lookup', tx('查詢'), ['lookupMs', 'resolverCacheHit']), g('failover', tx('故障切換'), ['failover', 'detectS', 'ttlS'], true)],
  cdn: [g('cache', tx('快取'), ['hitRatio', 'edgeMs'])],
  api_gateway: SERVER,
  service: SERVER,
  worker: SERVER,
  function: FUNCTION,
  load_balancer: [
    g('route', tx('轉送'), ['policy', 'latencyMs']),
    g('health', tx('Health check'), ['healthCheck', 'hcIntervalS', 'hcThreshold', 'hcTimeoutMs'], true),
    g('outlier', tx('自動剔除'), ['outlier', 'outlierErrors', 'ejectS'], true),
  ],
  rate_limiter: [g('limit', tx('限流'), ['limit', 'ratePerSec', 'burst', 'maxConcurrent', 'scope', 'appliesTo'])],
  circuit_breaker: [g('breaker', tx('保險絲'), ['failureRatio', 'minCalls', 'windowS', 'openMs', 'halfOpenCalls'])],
  cache: [g('cache', tx('快取'), ['mode', 'hitRatio', 'capacityKeys', 'ttlS', 'ttlJitter', 'stampede', 'leaseMs', 'leaseWaitMs']), CAP, g('time', tx('處理時間'), ['opMs'])],
  database: DB,
  sharded_db: DB,
  queue: [g('queue', tx('佇列'), ['maxDepth', 'enqueueMs', 'messageTtlS', 'ordering', 'groups']), g('delivery', tx('交付'), ['delivery', 'visibilityTimeoutMs', 'maxReceives'])],
  object_storage: [TIME, CAP, FAULT],
};
const OTHER = tx('其他');

/**
 * "0 means not used" parameters: shown as a switch. The number is the value a parameter takes
 * when switched on. Key: "kind.param" or just "param" (any kind).
 */
export const TOGGLES: Record<string, number> = {
  timeoutMs: 1000,
  retryBudget: 0.1,
  throttleK: 2,
  bulkhead: 64,
  hedgeMs: 50,
  fanout: 4,
  quorum: 2,
  codelTargetMs: 5,
  shedAt: 0.8,
  maxLagMs: 1000,
  'cache.ttlS': 60,
  messageTtlS: 345600,
  maxReceives: 5,
};
export const toggleOn = (kind: string, name: string): number | undefined => TOGGLES[`${kind}.${name}`] ?? TOGGLES[name];

/** Numbers entered as a percent although stored as a fraction (ratios always are). */
const PERCENT = new Set(['retryBudget']);
export const isPercent = (name: string, spec: ParamSpec): boolean => spec.type === 'ratio' || PERCENT.has(name);

type Get = (name: string) => unknown;
const num = (v: unknown) => (typeof v === 'number' ? v : 0);
const hasReplicas: (get: Get) => boolean = (get) => num(get('replicas')) > 0;
/** Extra show conditions the schema's `when` cannot say ("more than 0", "not write-only"). */
const SHOW: Record<string, (get: Get) => boolean> = {
  'edge.backoffMs': (get) => num(get('retries')) > 0,
  'edge.retryBudget': (get) => num(get('retries')) > 0,
  // hedging re-sends reads only
  'edge.hedgeMs': (get) => get('on') !== 'write' && num(get('fanout')) <= 1,
  'edge.quorum': (get) => num(get('fanout')) > 1,
};
for (const k of ['database', 'sharded_db']) {
  for (const p of ['readFrom', 'replicaApplyRatio', 'replicaDelayMs', 'maxLagMs', 'localReplicas', 'failover', 'failoverS', 'fencing', 'readYourWrites', 'rywWindowMs']) SHOW[`${k}.${p}`] = hasReplicas;
}

export const specsOf = (kind: string): Record<string, ParamSpec> => (kind === EDGE ? EDGE_PARAMS : (KINDS[kind]?.params ?? {}));

/** A parameter's value: set in the design, else its default. */
export function valueOf(kind: string, values: Record<string, unknown>, name: string): unknown {
  return values[name] ?? specsOf(kind)[name]?.default;
}

/** Is the value set to something other than the default? */
export function isChanged(spec: ParamSpec, v: unknown): boolean {
  if (v === undefined) return false;
  if (spec.type === 'dist') {
    const d = typeof v === 'number' ? { mean: v, cv: spec.default.cv } : (v as { mean: number; cv?: number });
    return d.mean !== spec.default.mean || (d.cv ?? spec.default.cv) !== spec.default.cv;
  }
  return v !== spec.default;
}

/** Shown in the inspector: its `when` holds and its extra condition holds; a changed value always shows. */
export function isVisible(kind: string, values: Record<string, unknown>, name: string): boolean {
  const specs = specsOf(kind);
  const spec = specs[name];
  if (!spec) return false;
  if (isChanged(spec, values[name]) && SHOW[`${kind}.${name}`]) return true;
  const get: Get = (n) => valueOf(kind, values, n);
  if (spec.when && !whenHolds(spec.when, get(spec.when.param))) return false;
  return SHOW[`${kind}.${name}`]?.(get) ?? true;
}

export interface Group {
  key: string;
  label: string;
  params: string[];
  /** Collapsed when first shown. */
  folded: boolean;
  /** Labels of the parameters set away from their defaults. */
  changed: string[];
}

/** The groups to show for a kind and its values: only visible parameters, empty groups dropped. */
export function layout(kind: string, values: Record<string, unknown>): Group[] {
  const specs = specsOf(kind);
  const defs = GROUPS[kind] ?? [];
  const seen = new Set<string>();
  const out: Group[] = [];
  const add = (key: string, label: string, names: string[], fold: boolean) => {
    const params = names.filter((n) => n in specs && !seen.has(n) && isVisible(kind, values, n));
    for (const n of names) if (n in specs) seen.add(n);
    if (!params.length) return;
    const changed = params.filter((n) => isChanged(specs[n], values[n])).map((n) => specs[n].label);
    out.push({ key, label, params, folded: fold && !changed.length, changed });
  };
  for (const d of defs) add(d.key, d.label, d.params, !!d.fold);
  add('other', OTHER, Object.keys(specs).filter((n) => !seen.has(n)), false);
  return out;
}

/** Help text: the first sentence always shows; the rest goes under "more". */
export function splitHelp(s: string): [string, string] {
  const m = /^([\s\S]*?(?:。|[.!?](?=\s)))\s*(\S[\s\S]*)$/.exec(s);
  return m ? [m[1], m[2]] : [s, ''];
}

/** A unit as shown next to a field. */
export const unitLabel = (unit: string | undefined): string => (unit === 's' ? tx('秒') : (unit ?? ''));
