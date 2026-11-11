// The resource graph. Three kinds of line:
//   definite  - explicit wiring: LB listener -> target group -> target, event source mapping,
//               API Gateway integration, CloudFront origin, SNS subscription.
//   presumed  - an environment variable expression references a resource (DB_HOST =
//               aws_db_instance.main.address). It proves a setting depends on it, not that a call
//               happens, so checks that use it are "by assumption".
//   candidate - only a security group rule allows it. Drawn only after an answer file confirms it.
// A fixed string or an outside variable in an environment variable gives no line. Instances are
// never merged here; groupInstances() merges only identical ones (Q14).
import { KEY, stripKeys, stripLastKey, type Plan, type PlanResource } from './plan.ts';

export type LineKind = 'definite' | 'presumed' | 'candidate';
export interface Line {
  from: string;
  to: string;
  kind: LineKind;
  /** The resources or attributes that give this line, e.g. `aws_lb_listener.https`, `env:container_definitions`. */
  via: string[];
  /** Weaker evidence that agrees (a security group rule under a definite or presumed line). */
  agrees?: string[];
}
export interface ResourceGraph {
  plan: Plan;
  lines: Line[];
  /** Security group address -> member resource addresses. */
  members: Map<string, string[]>;
  /** Resource addresses the answer file names (nodes, edges, entry): a rule keeps them as nodes
   *  instead of folding them. */
  named?: Set<string>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
// Module outputs (`module.app.out`) need no rule: resourcePart() finds no `type.name` in them, or one
// that matches no resource.
const NOT_A_RESOURCE = /^(var|local|data|each|count|path|terraform|self)\b/;
/** Types an environment variable can name without being something the service calls at run time. */
const NOT_CALLED = /^aws_(iam_|ecr_|cloudwatch_|kms_|security_group|subnet|vpc|route_table|internet_gateway|nat_gateway|eip|ssm_parameter|secretsmanager_|acm_|route53_zone|ecs_cluster|ecs_task_definition|lb_target_group|lb_listener|alb_target_group|alb_listener|db_subnet_group|db_parameter_group|elasticache_subnet_group|elasticache_parameter_group|appautoscaling_|launch_template|s3_bucket_policy|lambda_permission)/;
const SG_KEYS = new Set(['security_groups', 'vpc_security_group_ids', 'security_group_ids']);

const RESOURCE_PART = new RegExp(String.raw`^((?:module\.[^.[\]"]+(?:${KEY})?\.)*)([a-z0-9_]+\.[^.[\]"]+(?:${KEY})?)`);
/** The resource part of a reference, with keys: `module.a[0].aws_x.y[1].arn` -> `module.a[0].aws_x.y[1]`. */
function resourcePart(ref: string): string | null {
  const m = RESOURCE_PART.exec(ref);
  return m ? m[1] + m[2] : null;
}
/** Every reference string anywhere under an expression. Terraform (checked with 1.17.1) lists each
 *  keyed reference with its ancestors, `x.t[0].url`, `x.t[0]`, `x.t`, and does not merge repeats; a
 *  splat `x.t[*].url` adds one more bare `x.t`. So each keyed instance entry cancels exactly one bare
 *  entry (its ancestor), and any bare entry left over is a real reference to every instance. */
function refStrings(expr: unknown, out: string[] = []): string[] {
  if (Array.isArray(expr)) for (const e of expr) refStrings(e, out);
  else if (isObj(expr)) {
    for (const [k, v] of Object.entries(expr)) {
      if (k === 'references' && Array.isArray(v)) {
        const list = v.filter((x): x is string => typeof x === 'string');
        const ancestors = new Map<string, number>();
        for (const r of list) if (resourcePart(r) === r && stripLastKey(r) !== r) {
          const bare = stripLastKey(r);
          ancestors.set(bare, (ancestors.get(bare) ?? 0) + 1);
        }
        for (const r of list) {
          const n = ancestors.get(r) ?? 0;
          if (n > 0) ancestors.set(r, n - 1);
          else out.push(r);
        }
      } else refStrings(v, out);
    }
  }
  return out;
}

/** The resource instances a reference string points at (`aws_db_instance.main.address` -> the DB). */
function resolveRef(plan: Plan, ref: string): PlanResource[] {
  if (NOT_A_RESOURCE.test(ref)) return [];
  // Tokenized by resourcePart(), not split('.'): a for_each key can hold a dot (module.app["prod.us"]).
  const resource = resourcePart(ref);
  if (!resource) return [];
  const exact = plan.byAddress.get(resource);
  if (exact) return [exact];
  // No key on the resource: all its instances, but only in the module instance the reference names.
  return (plan.byConfig.get(stripKeys(resource)) ?? []).filter((r) => stripLastKey(r.address) === resource);
}

const unique = (rs: PlanResource[]) => [...new Map(rs.map((r) => [r.address, r])).values()];
/** The resource instances an expression references, instance-aware (resolveRef), optionally of one type. */
export const refsTo = (plan: Plan, expr: unknown, type?: RegExp): PlanResource[] =>
  unique(refStrings(expr).flatMap((r) => resolveRef(plan, r))).filter((r) => !type || type.test(r.type));
const expr = (r: PlanResource, key: string): unknown => r.expressions[key];
const ofType = (plan: Plan, type: RegExp) => plan.resources.filter((r) => type.test(r.type));

const TG = /^aws_(lb|alb)_target_group$/;
const LB = /^aws_(lb|alb)$/;
const LISTENER = /^aws_(lb|alb)_listener$/;

/** Listener -> the target groups it forwards to: its default action and the actions of its rules. */
function listenerTargetGroups(plan: Plan): Map<string, PlanResource[]> {
  const out = new Map<string, PlanResource[]>();
  for (const l of ofType(plan, LISTENER)) out.set(l.address, refsTo(plan, expr(l, 'default_action'), TG));
  for (const rule of ofType(plan, /^aws_(lb|alb)_listener_rule$/)) {
    for (const l of refsTo(plan, expr(rule, 'listener_arn'), LISTENER)) out.get(l.address)?.push(...refsTo(plan, expr(rule, 'action'), TG));
  }
  for (const [k, v] of out) out.set(k, unique(v));
  return out;
}
/** A load balancer's listeners and the target groups behind them (the same walk as its definite lines). */
export function lbTargetGroups(plan: Plan, lb: PlanResource): { listeners: PlanResource[]; targetGroups: PlanResource[] } {
  const byListener = listenerTargetGroups(plan);
  const listeners = ofType(plan, LISTENER).filter((l) => refsTo(plan, expr(l, 'load_balancer_arn'), LB).some((x) => x.address === lb.address));
  return { listeners, targetGroups: unique(listeners.flatMap((l) => byListener.get(l.address) ?? [])) };
}

function definiteLines(plan: Plan): Line[] {
  const out: Line[] = [];
  const add = (from: PlanResource, to: PlanResource, via: string[]) => {
    if (from.address !== to.address) out.push({ from: from.address, to: to.address, kind: 'definite', via });
  };

  // Target group -> what it sends to.
  const targets = new Map<string, { target: PlanResource; via: string }[]>();
  const addTarget = (tg: PlanResource, target: PlanResource, via: string) => {
    if (!targets.has(tg.address)) targets.set(tg.address, []);
    targets.get(tg.address)!.push({ target, via });
  };
  for (const s of ofType(plan, /^aws_ecs_service$/)) for (const tg of refsTo(plan, expr(s, 'load_balancer'), TG)) addTarget(tg, s, s.address);
  for (const a of ofType(plan, /^aws_(lb|alb)_target_group_attachment$/)) {
    for (const tg of refsTo(plan, expr(a, 'target_group_arn'), TG)) for (const t of refsTo(plan, expr(a, 'target_id'))) addTarget(tg, t, a.address);
  }
  for (const g of ofType(plan, /^aws_autoscaling_group$/)) for (const tg of refsTo(plan, expr(g, 'target_group_arns'), TG)) addTarget(tg, g, g.address);
  for (const a of ofType(plan, /^aws_autoscaling_attachment$/)) {
    for (const tg of refsTo(plan, expr(a, 'lb_target_group_arn'), TG)) for (const g of refsTo(plan, expr(a, 'autoscaling_group_name'), /^aws_autoscaling_group$/)) addTarget(tg, g, a.address);
  }

  // Listener (and its rules) -> target groups; LB -> targets.
  const listenerTgs = listenerTargetGroups(plan);
  for (const l of ofType(plan, LISTENER)) {
    for (const lb of refsTo(plan, expr(l, 'load_balancer_arn'), LB)) {
      for (const tg of listenerTgs.get(l.address) ?? []) {
        for (const { target, via } of targets.get(tg.address) ?? []) add(lb, target, [l.address, tg.address, via]);
      }
    }
  }
  /** An integration that names a listener means its load balancer. */
  const callee = (r: PlanResource): PlanResource[] => (LISTENER.test(r.type) ? refsTo(plan, expr(r, 'load_balancer_arn'), LB) : [r]);

  // A disabled mapping (enabled = false) polls nothing: no line.
  for (const m of ofType(plan, /^aws_lambda_event_source_mapping$/)) {
    if (m.values.enabled === false) continue;
    for (const src of refsTo(plan, expr(m, 'event_source_arn'))) for (const fn of refsTo(plan, expr(m, 'function_name'), /^aws_lambda_(function|alias)$/)) add(src, fn, [m.address]);
  }
  for (const i of ofType(plan, /^aws_apigatewayv2_integration$/)) {
    for (const api of refsTo(plan, expr(i, 'api_id'), /^aws_apigatewayv2_api$/)) for (const t of refsTo(plan, expr(i, 'integration_uri')).flatMap(callee)) add(api, t, [i.address]);
  }
  for (const i of ofType(plan, /^aws_api_gateway_integration$/)) {
    for (const api of refsTo(plan, expr(i, 'rest_api_id'), /^aws_api_gateway_rest_api$/)) for (const t of refsTo(plan, expr(i, 'uri')).flatMap(callee)) add(api, t, [i.address]);
  }
  for (const cf of ofType(plan, /^aws_cloudfront_distribution$/)) {
    // Only where the origin points (domain_name), not what its settings use (headers, access ids).
    const origins = ((expr(cf, 'origin') as unknown[] | undefined) ?? []).map((o) => (isObj(o) ? o.domain_name : undefined));
    for (const o of refsTo(plan, origins)) if (!/^aws_cloudfront_/.test(o.type)) add(cf, o, [`${cf.address}.origin`]);
  }
  // A DNS record -> what it points at (records or alias name), not its health check.
  for (const rec of ofType(plan, /^aws_route53_record$/)) {
    const alias = ((expr(rec, 'alias') as unknown[] | undefined) ?? []).map((a) => (isObj(a) ? a.name : undefined));
    for (const t of refsTo(plan, [expr(rec, 'records'), alias])) if (!NOT_CALLED.test(t.type) && !/^aws_route53_/.test(t.type)) add(rec, t, [`${rec.address}.records`]);
  }
  for (const s of ofType(plan, /^aws_sns_topic_subscription$/)) {
    for (const topic of refsTo(plan, expr(s, 'topic_arn'), /^aws_sns_topic$/)) for (const t of refsTo(plan, expr(s, 'endpoint'))) add(topic, t, [s.address]);
  }
  return out;
}

function presumedLines(plan: Plan): Line[] {
  const out: Line[] = [];
  const add = (callers: PlanResource[], source: PlanResource, attr: string) => {
    for (const to of refsTo(plan, expr(source, attr))) {
      if (NOT_CALLED.test(to.type)) continue;
      for (const from of callers) if (from.address !== to.address) out.push({ from: from.address, to: to.address, kind: 'presumed', via: [source.address, `env:${attr}`] });
    }
  };
  // ECS: the environment is in the task definition (one jsonencode expression, so its references
  // are not split per variable); the caller is the service that runs it.
  const services = ofType(plan, /^aws_ecs_service$/);
  for (const td of ofType(plan, /^aws_ecs_task_definition$/)) {
    const users = services.filter((s) => refsTo(plan, expr(s, 'task_definition')).some((r) => r.address === td.address));
    add(users.length ? users : [td], td, 'container_definitions');
  }
  for (const fn of ofType(plan, /^aws_lambda_function$/)) add([fn], fn, 'environment');
  // EC2: user_data of a launch template or configuration (the callers are the Auto Scaling groups that use it), or of an instance.
  const asgs = ofType(plan, /^aws_autoscaling_group$/);
  // A launch configuration too (the older form; M29b #14).
  for (const lt of ofType(plan, /^aws_launch_(template|configuration)$/)) {
    const users = asgs.filter((a) => refsTo(plan, [expr(a, 'launch_template'), expr(a, 'mixed_instances_policy'), expr(a, 'launch_configuration')]).some((r) => r.address === lt.address));
    add(users.length ? users : [lt], lt, 'user_data');
  }
  for (const i of ofType(plan, /^aws_instance$/)) add([i], i, 'user_data');
  return out;
}

/** Which resources sit in which security group, and which group lets which group in. */
function securityGroups(plan: Plan): { members: Map<string, string[]>; allows: [src: string, dst: string, via: string][] } {
  const members = new Map<string, string[]>();
  const walk = (r: PlanResource, e: unknown) => {
    if (Array.isArray(e)) e.forEach((x) => walk(r, x));
    else if (isObj(e)) {
      for (const [k, v] of Object.entries(e)) {
        if (SG_KEYS.has(k)) {
          for (const sg of refsTo(plan, v, /^aws_security_group$/)) {
            if (!members.has(sg.address)) members.set(sg.address, []);
            if (!members.get(sg.address)!.includes(r.address)) members.get(sg.address)!.push(r.address);
          }
        } else walk(r, v);
      }
    }
  };
  for (const r of plan.resources) if (r.type !== 'aws_security_group' && !/^aws_(vpc_)?security_group_(rule|ingress_rule|egress_rule)$/.test(r.type)) walk(r, r.expressions);

  const allows: [string, string, string][] = [];
  for (const sg of ofType(plan, /^aws_security_group$/)) for (const src of refsTo(plan, expr(sg, 'ingress'), /^aws_security_group$/)) allows.push([src.address, sg.address, `${sg.address}.ingress`]);
  for (const rule of ofType(plan, /^aws_security_group_rule$/)) {
    if (rule.values.type !== 'ingress') continue;
    for (const dst of refsTo(plan, expr(rule, 'security_group_id'), /^aws_security_group$/)) for (const src of refsTo(plan, expr(rule, 'source_security_group_id'), /^aws_security_group$/)) allows.push([src.address, dst.address, rule.address]);
  }
  for (const rule of ofType(plan, /^aws_vpc_security_group_ingress_rule$/)) {
    for (const dst of refsTo(plan, expr(rule, 'security_group_id'), /^aws_security_group$/)) for (const src of refsTo(plan, expr(rule, 'referenced_security_group_id'), /^aws_security_group$/)) allows.push([src.address, dst.address, rule.address]);
  }
  return { members, allows };
}

export function buildGraph(plan: Plan): ResourceGraph {
  const lines: Line[] = [];
  const index = new Map<string, Line>();
  const key = (l: { from: string; to: string }) => `${l.from}\u0000${l.to}`;
  // Stronger evidence first: a pair keeps its strongest line; weaker ones only add to `via`/`agrees`.
  for (const l of [...definiteLines(plan), ...presumedLines(plan)]) {
    const old = index.get(key(l));
    if (!old) {
      index.set(key(l), l);
      lines.push(l);
    } else if (old.kind === l.kind) old.via = [...new Set([...old.via, ...l.via])];
    else (old.agrees ??= []).push(...l.via.filter((v) => !old.agrees!.includes(v)));
  }
  const { members, allows } = securityGroups(plan);
  for (const [src, dst, via] of allows) {
    for (const from of members.get(src) ?? []) {
      for (const to of members.get(dst) ?? []) {
        if (from === to) continue;
        const old = index.get(key({ from, to }));
        if (old) {
          if (old.kind !== 'candidate') (old.agrees ??= []).includes(via) || old.agrees.push(via);
          else if (!old.via.includes(via)) old.via.push(via);
          continue;
        }
        const l: Line = { from, to, kind: 'candidate', via: [via] };
        index.set(key(l), l);
        lines.push(l);
      }
    }
  }
  return { plan, lines, members };
}

/** The availability zone of a resource: its own attribute, else the subnet it names (if one). */
export function zoneOf(plan: Plan, r: PlanResource): string | undefined {
  const own = r.values.availability_zone;
  if (typeof own === 'string' && own) return own;
  const subnets = refsTo(plan, [expr(r, 'subnet_id'), expr(r, 'subnet_ids'), expr(r, 'subnets')], /^aws_subnet$/);
  const zones = [...new Set(subnets.map((s) => s.values.availability_zone).filter((z): z is string => typeof z === 'string'))];
  return zones.length === 1 ? zones[0] : zones.length ? zones.sort().join('+') : undefined;
}

/** Size and role. A value known only after apply counts as its own value ("unknown"), so a writer
 *  (replicate_source_db = null) and a replica (= a reference) of one block stay apart. */
const ROLE_KEYS = [
  'instance_type', 'instance_class', 'node_type', 'engine', 'engine_version', 'memory_size', 'runtime', 'replicate_source_db', 'replication_source_identifier', 'promotion_tier', 'multi_az', 'internal',
  // Lambda limits (#10) and queue behaviour (#13): instances that differ here act differently.
  'reserved_concurrent_executions', 'timeout', 'fifo_queue', 'visibility_timeout_seconds', 'message_retention_seconds', 'delay_seconds',
];
/** References that make a resource part of another node (rules fold it in as a member). */
const MEMBER_OF: Record<string, [string, RegExp][]> = {
  aws_lambda_alias: [['function_name', /^aws_lambda_function$/]],
  aws_elasticache_cluster: [['replication_group_id', /^aws_elasticache_replication_group$/]],
  aws_rds_cluster_instance: [['cluster_identifier', /^aws_rds_cluster$/]],
  aws_db_proxy_target: [['db_proxy_name', /^aws_db_proxy$/], ['db_instance_identifier', /^aws_db_instance$/], ['db_cluster_identifier', /^aws_rds_cluster$/]],
};
/** A Route 53 failover record: each one is a PRIMARY or SECONDARY of its own name, paired by name
 *  (rules-platform.ts), so records of one block never merge. */
const failoverRecord = (r: PlanResource) => r.type === 'aws_route53_record' && Array.isArray(r.values.failover_routing_policy) && r.values.failover_routing_policy.length > 0;
/** Each one holds its own data: two DB instances or two Aurora clusters are two databases, never one
 *  node with more capacity (M29b #12 #41). */
const NO_MERGE = /^aws_(db_instance|rds_cluster)$/;
type Link = { from: string; to: string; kind: string };
/** The member links rules fold by (an alias stands for its function), resolved as
 *  referrers() resolves them. groupInstances() splits by them as by lines. */
export function memberLinks(g: ResourceGraph): Link[] {
  // A caller of two aliases splits when their functions do.
  const links: Link[] = [];
  const keyOf = (a: string) => a.slice(stripLastKey(a).length);
  // Resolved once per expression (instances of one block share it): block -> instances.
  const resolved = new Map<string, Map<string, PlanResource[]>>();
  /** Unkeyed references to a block of several instances. Grouped as referrers() reads them: by the
   *  member's type and attribute and the target block; inside, one bucket per
   *  expression, with the targets it resolves and its members by their own key. */
  type Bucket = { byKey: Map<string, PlanResource[]>; all: PlanResource[]; targets: PlanResource[] };
  const ambiguous = new Map<string, Map<string, Bucket>>();
  for (const r of g.plan.resources) {
    for (const [attr, type] of MEMBER_OF[r.type] ?? []) {
      const ck = `${type.source}|${r.module}|${JSON.stringify(r.expressions[attr] ?? null)}`;
      let byBlock = resolved.get(ck);
      if (!byBlock) {
        resolved.set(ck, (byBlock = new Map()));
        for (const t of refsTo(g.plan, r.expressions[attr], type)) {
          const b = stripLastKey(t.address);
          if (!byBlock.has(b)) byBlock.set(b, []);
          byBlock.get(b)!.push(t);
        }
      }
      for (const [b, ts] of byBlock) {
        if (ts.length === 1) {
          links.push({ from: r.address, to: ts[0].address, kind: 'member' });
          continue;
        }
        const gk = `${r.type}|${attr}|${b}`;
        if (!ambiguous.has(gk)) ambiguous.set(gk, new Map());
        const buckets = ambiguous.get(gk)!;
        if (!buckets.has(ck)) buckets.set(ck, { byKey: new Map(), all: [], targets: ts });
        const amb = buckets.get(ck)!;
        amb.all.push(r);
        if (!amb.byKey.has(keyOf(r.address))) amb.byKey.set(keyOf(r.address), []);
        amb.byKey.get(keyOf(r.address))!.push(r);
      }
    }
  }
  // As referrers() does, from the target's side: the members with the target's key, or every member
  // when none has it, over every expression that resolves the target
  //.
  for (const buckets of ambiguous.values()) {
    const byTarget = new Map<string, { t: PlanResource; in: Bucket[] }>();
    for (const bk of buckets.values()) {
      for (const t of bk.targets) {
        if (!byTarget.has(t.address)) byTarget.set(t.address, { t, in: [] });
        byTarget.get(t.address)!.in.push(bk);
      }
    }
    for (const { t, in: bks } of byTarget.values()) {
      const same = bks.flatMap((bk) => bk.byKey.get(keyOf(t.address)) ?? []);
      const from = same.length ? same : bks.flatMap((bk) => bk.all);
      for (const r of new Set(from)) links.push({ from: r.address, to: t.address, kind: 'member' });
    }
  }
  return links;
}
/** Instances of one count/for_each block that are the same in size, zone, role and lines (Q14 A).
 *  Different blocks, zones, sizes or lines stay apart, even with the same type. */
export function groupInstances(g: ResourceGraph): { key: string; addresses: string[] }[] {
  // First by block, zone and role; then split again until each group's lines go to the same groups:
  // two callers merge only if their targets did (Lambdas of two module instances,
  // each with its own database, stay two).
  const base = new Map<string, string>();
  for (const r of g.plan.resources) {
    const role = ROLE_KEYS.map((k) => `${k}=${r.unknown.has(k) ? '(unknown)' : JSON.stringify(r.values[k] ?? null)}`).join(';');
    base.set(r.address, [NO_MERGE.test(r.type) || failoverRecord(r) ? r.address : r.configAddress, zoneOf(g.plan, r) ?? '', role].join('|'));
  }
  const byAddress = new Map<string, Link[]>();
  const links: Link[] = [...g.lines, ...memberLinks(g)];
  for (const l of links) {
    for (const a of [l.from, l.to]) {
      if (!byAddress.has(a)) byAddress.set(a, []);
      byAddress.get(a)!.push(l);
    }
  }
  /** A resource outside the plan's resources (no group) counts by its block. */
  let group = new Map(base);
  const of = (a: string) => group.get(a) ?? stripKeys(a);
  let groups = new Map<string, string[]>();
  // Each round that is not stable makes more groups, so this many rounds always reach the end.
  for (let round = 0; round <= g.plan.resources.length; round++) {
    const next = new Map<string, string[]>();
    for (const r of g.plan.resources) {
      const sig = (byAddress.get(r.address) ?? [])
        .map((l) => (l.from === r.address ? `>${of(l.to)}:${l.kind}` : `<${of(l.from)}:${l.kind}`))
        .sort()
        .join(',');
      const k = `${base.get(r.address)}|${sig}`;
      if (!next.has(k)) next.set(k, []);
      next.get(k)!.push(r.address);
    }
    const stable = next.size === groups.size;
    groups = next;
    if (stable) break;
    // Short names for the next round: the group's index.
    group = new Map([...next.values()].flatMap((as, i) => as.map((a) => [a, `#${i}`] as const)));
  }
  return [...groups].map(([key, addresses]) => ({ key, addresses }));
}
