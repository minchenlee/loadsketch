// Shared pieces of the mapping rules (rules.ts, rules-serverless.ts, rules-platform.ts): what a rule
// returns, origins, reverse references, and small readers of plan values.
import { refsTo, type ResourceGraph } from './graph.ts';
import { stripLastKey, type PlanResource } from './plan.ts';
import type { Fact, Note, Origin, Params } from './result.ts';

export interface RuleOut {
  kind: string;
  params: Params;
  origins: Record<string, Origin>;
  facts: Record<string, Fact>;
  notes: Note[];
  /** Other resources this node read its values from (they are folded into it). */
  uses: string[];
  /** Can traffic from outside enter here (an internet-facing load balancer)? */
  entry?: boolean;
  /** Other resources that stand for this node: graph lines to them end here (Aurora instances, RDS Proxy). */
  members?: string[];
  /** Members that sit between the callers and this node (RDS Proxy): an edge whose line ends at one says so. */
  through?: string[];
  /** A node in front of this one that takes its incoming lines (the throttle of API Gateway or a
   *  provisioned DynamoDB table), with the resource whose settings it comes from. */
  front?: { kind: string; params: Params; origins: Record<string, Origin>; via: string };
  /** Params of the edges from this node to the node of resource `to` (an integration timeout). */
  edgeParams?: { to: string; param: string; value: number; origin: Origin }[];
  /** Weight of the edges whose line starts at this resource (a Route 53 failover record), from the
   *  graph or the answer file; set after every line is an edge, the largest one when two meet. */
  lineWeights?: Record<string, { value: number; origin: Origin }>;
  /** maxConcurrency if every incoming edge in the final design comes only through `via` (event
   *  source mappings) and the value is lower: decided after the answer-file lines. */
  sourceCap?: { value: number; origin: Origin; via: string[] };
}
/** Not a node: the resources are folded, with a reason id (a DLQ, a DNS record that points nowhere mapped). */
export interface Fold { fold: string }
export type Rule = (rs: PlanResource[], g: ResourceGraph) => RuleOut | Fold;
/** An origin for our own estimate, with where it is written down. */
export const estimate = (from: string | undefined, source: string): Origin => ({ evidence: 'estimate', ...(from ? { from } : {}), source });
/** Origin of an attribute: written in the configuration (iac), else the provider/AWS default. */
export const setOr = (r: PlanResource, attr: string, source: string): Origin =>
  // written but not in the plan: the AWS default stands in for a value nobody knows yet (M29b #24–#29)
  unknownSet(r, attr) ? { evidence: 'estimate', from: `${r.address}.${attr}`, source, unknown: r.unknown.has(attr) ? 'apply' : 'sensitive' } : configured(r, attr) ? iac(r, attr) : awsDefault(r, attr, source);
/** Does the configuration write this attribute (a literal leaves `{}` in `expressions`)? A dotted path
 *  goes into nested blocks: `settings.throttling_rate_limit`. */
export function configured(r: PlanResource, path: string): boolean {
  let e: unknown = r.expressions;
  for (const k of path.split('.')) {
    if (Array.isArray(e)) e = e[0];
    if (!e || typeof e !== 'object') return false;
    e = (e as Record<string, unknown>)[k];
  }
  return e !== undefined;
}
/** The first element of a nested block (`[ { … } ]`), or undefined. */
export const block = (v: unknown): Record<string, unknown> | undefined => (Array.isArray(v) && v[0] && typeof v[0] === 'object' ? (v[0] as Record<string, unknown>) : undefined);
/** The availability zones of the subnets an expression names, sorted and joined; undefined if one is unknown. */
export function zonesOf(g: ResourceGraph, expr: unknown): { value: string; origin: Origin } | undefined {
  const subnets = refsTo(g.plan, expr, /^aws_subnet$/);
  const zones = subnets.map((x) => (x.unknown.has('availability_zone') ? undefined : x.values.availability_zone));
  if (!subnets.length || !zones.every((z): z is string => typeof z === 'string' && !!z)) return undefined;
  return { value: [...new Set(zones)].sort().join(','), origin: iac(subnets[0], 'availability_zone') };
}

export const iac = (r: PlanResource, attr: string): Origin => ({ evidence: 'iac', from: `${r.address}.${attr}` });
export const awsDefault = (r: PlanResource, attr: string, source: string): Origin => ({ evidence: 'aws-default', from: `${r.address}.${attr}`, source });
export const keyOf = (r: PlanResource): string => r.address.slice(stripLastKey(r.address).length);
interface Ref { r: PlanResource; ambiguous: boolean }
/** graph -> `type|attr` -> referenced address -> referrers, built once per graph (no N³ scans). */
const INDEX = new WeakMap<ResourceGraph, Map<string, Map<string, Ref[]>>>();
function reverse(g: ResourceGraph, type: RegExp, attr: string): Map<string, Ref[]> {
  let byKind = INDEX.get(g);
  if (!byKind) INDEX.set(g, (byKind = new Map()));
  const k = `${type.source}|${attr}`;
  let idx = byKind.get(k);
  if (idx) return idx;
  idx = new Map();
  for (const r of g.plan.resources) {
    if (!type.test(r.type)) continue;
    const resolved = refsTo(g.plan, r.expressions[attr]);
    const perBlock = new Map<string, number>();
    for (const t of resolved) perBlock.set(stripLastKey(t.address), (perBlock.get(stripLastKey(t.address)) ?? 0) + 1);
    for (const t of resolved) {
      if (!idx.has(t.address)) idx.set(t.address, []);
      // More than one instance of the block: an unkeyed reference such as `x[count.index]` (only `x` in the plan).
      idx.get(t.address)!.push({ r, ambiguous: perBlock.get(stripLastKey(t.address))! > 1 });
    }
  }
  byKind.set(k, idx);
  return idx;
}
/** Resources of a type whose attribute `attr` references `target` (instance-aware: graph.ts refsTo).
 *  Explicit references always count; unkeyed ones pair instances by key when one has the same key. */
export function referrers(g: ResourceGraph, type: RegExp, attr: string, target: PlanResource): PlanResource[] {
  const found = reverse(g, type, attr).get(target.address) ?? [];
  const explicit = found.filter((x) => !x.ambiguous).map((x) => x.r);
  const ambiguous = found.filter((x) => x.ambiguous).map((x) => x.r);
  const key = keyOf(target);
  const same = key ? ambiguous.filter((r) => keyOf(r) === key) : [];
  return [...new Set([...explicit, ...(same.length ? same : ambiguous)])];
}
/** The environment tag (Environment, Env, Stage), e.g. `prod` — C3 is high in production. */
export function environmentTag(r: PlanResource): { key: string; value: string } | undefined {
  const tags = r.values.tags_all ?? r.values.tags;
  if (!tags || typeof tags !== 'object') return undefined;
  for (const [k, v] of Object.entries(tags as Record<string, unknown>)) if (/^(environment|env|stage)$/i.test(k) && typeof v === 'string') return { key: k, value: v };
  return undefined;
}
/** The configuration sets it, but the plan has no value: unknown until apply, or sensitive (parsePlan()
 *  drops sensitive values and keeps the references). An Optional+Computed attribute the configuration
 *  leaves out (multi_az, parameter_group_name) is also in after_unknown, but AWS then uses its default. */
export const unknownSet = (r: PlanResource, attr: string) => configured(r, attr) && (r.unknown.has(attr) || valueAt(r.values, attr) === undefined);
/** A value by dotted path; a block (a list of one object) is stepped into. */
export function valueAt(v: unknown, path: string): unknown {
  for (const k of path.split('.')) {
    if (Array.isArray(v)) v = v[0];
    if (!v || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);


/** max_connections from a custom parameter group (`attr` names it, `type` is its resource type): a
 *  number, or `unknown` when the group or the value cannot be read from the plan (a formula, unknown
 *  until apply, a group the plan does not have). Undefined: the default group (or a group that does
 *  not set it), so the AWS formula applies. */
export function maxConnectionsSetting(db: PlanResource, g: ResourceGraph, attr: string, type: string): Fact | undefined {
  const at = iac(db, attr);
  const name = db.values[attr];
  const groups = refsTo(g.plan, db.expressions[attr], new RegExp(`^${type}$`));
  const literal = typeof name === 'string' && name !== '' ? name : undefined;
  if (unknownSet(db, attr)) return { value: 'unknown', origin: at };
  if (!literal || literal.startsWith('default.')) return undefined;
  // The planned name picks the group: a conditional also references the groups it does not select,
  // and a group whose name is unknown until apply matches no name.
  const named = (xs: PlanResource[]) => xs.filter((r) => !r.unknown.has('name') && r.values.name === literal);
  const picked = named(groups).length ? named(groups) : named(g.plan.resources.filter((r) => r.type === type));
  const group = picked.length === 1 ? picked[0] : undefined;
  if (!group || group.unknown.has('parameter')) return { value: 'unknown', origin: at };
  const params = Array.isArray(group.values.parameter) ? (group.values.parameter as Record<string, unknown>[]) : [];
  const p = params.find((x) => x && x.name === 'max_connections');
  if (!p) return undefined;
  const v = typeof p.value === 'string' && /^\d+$/.test(p.value.trim()) ? Number(p.value) : undefined;
  return { value: v ?? 'unknown', origin: iac(group, 'parameter.max_connections') };
}
