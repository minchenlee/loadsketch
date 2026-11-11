// Mapping rules: one function per resource type that becomes a design node.
// Each gets the instances of one group (groupInstances(), Q14) and the graph, and returns the node's
// kind, params, where each param came from, facts for the checks, and notes. Types that only shape
// another node (target groups, listeners, autoscaling, task definitions, network) are in FOLDED.
import { DEFAULTS } from './defaults.ts';
import { lbTargetGroups, refsTo, type ResourceGraph } from './graph.ts';
import type { PlanResource } from './plan.ts';
import { awsDefault, configured, environmentTag, estimate, iac, maxConnectionsSetting, num, referrers, unknownSet, type Rule, type RuleOut } from './rule-kit.ts';
import { addProxy, PLATFORM_FOLDED, PLATFORM_RULES, proxyFor } from './rules-platform.ts';
import { SERVERLESS_FOLDED, SERVERLESS_RULES } from './rules-serverless.ts';

const loadBalancer: Rule = ([lb], g) => {
  const out: RuleOut = { kind: 'load_balancer', params: {}, origins: {}, facts: {}, notes: [], uses: [] };
  const internal = lb.unknown.has('internal') || lb.values.internal === undefined ? DEFAULTS.lb.internal.value : lb.values.internal === true;
  out.facts.internal = { value: internal, origin: lb.unknown.has('internal') || lb.values.internal === undefined ? awsDefault(lb, 'internal', DEFAULTS.lb.internal.source) : iac(lb, 'internal') };
  out.entry = !internal;
  // Health check and policy come from the target groups behind its listeners and listener rules (the
  // first one; a note says so when there are several).
  const { listeners, targetGroups: tgs } = lbTargetGroups(g.plan, lb);
  out.uses.push(...listeners.map((l) => l.address), ...tgs.map((t) => t.address));
  const tg = tgs[0];
  if (tg) {
    const hc = (Array.isArray(tg.values.health_check) ? tg.values.health_check[0] : undefined) as Record<string, unknown> | undefined;
    const known = !tg.unknown.has('health_check') && hc;
    const T = DEFAULTS.targetGroup;
    const protocol = typeof tg.values.protocol === 'string' ? tg.values.protocol : 'HTTP';
    const timeoutDefault = tg.values.target_type === 'lambda' ? T.timeout.value.lambda : (T.timeout.value[protocol] ?? T.timeout.value.HTTP);
    const pick = (param: string, attr: string, dflt: number, source: string, scale = 1) => {
      const v = known ? num(hc![attr]) : undefined;
      out.params[param] = (v ?? dflt) * scale;
      out.origins[param] = v !== undefined ? iac(tg, `health_check.${attr}`) : awsDefault(tg, `health_check.${attr}`, source);
    };
    out.params.healthCheck = 'liveness';
    out.origins.healthCheck = { evidence: 'estimate', from: `${tg.address}.health_check`, source: 'import.approx.healthCheck: an ALB health check sees only that the target answers, so it is modelled as liveness' };
    out.notes.push({ id: 'import.approx.healthCheck', node: lb.address });
    pick('hcIntervalS', 'interval', T.interval.value, T.interval.source);
    pick('hcThreshold', 'unhealthy_threshold', T.unhealthyThreshold.value, T.unhealthyThreshold.source);
    pick('hcTimeoutMs', 'timeout', timeoutDefault, T.timeout.source, 1000);
    const alg = tg.unknown.has('load_balancing_algorithm_type') ? undefined : tg.values.load_balancing_algorithm_type;
    const policy = { round_robin: 'round_robin', least_outstanding_requests: 'least_conn', weighted_random: 'random' }[String(alg ?? T.algorithm.value)] ?? 'round_robin';
    out.params.policy = policy;
    out.origins.policy = alg ? iac(tg, 'load_balancing_algorithm_type') : awsDefault(tg, 'load_balancing_algorithm_type', T.algorithm.source);
    if (tgs.length > 1) out.notes.push({ id: 'import.approx.severalTargetGroups', args: { n: tgs.length, used: tg.address }, node: lb.address });
  }
  return out;
};

/** Target tracking on CPU is the only metric that maps to loadsketch's target utilization. */
const CPU_METRIC = 'ECSServiceAverageCPUUtilization';

/** Where a resource lives: its provider configuration and its region (AWS provider 6 sets `region`
 *  on each resource). Names repeat across regions and accounts, so a name matches only inside this. */
const scope = (r: PlanResource) => `${(r.provider ?? '').replace(/^.*:/, '')}|${typeof r.values.region === 'string' ? r.values.region : ''}`;

/** A scaling target whose resource_id is a literal `service/<cluster>/<service>` (no reference, M29b
 *  #38): the cluster's and the service's names must match, in the same provider and region. A
 *  service whose cluster is not known before apply matches none. */
function literalTarget(g: ResourceGraph, svc: PlanResource): PlanResource | undefined {
  const name = svc.values.name;
  if (typeof name !== 'string' || !name) return undefined;
  const c = svc.values.cluster;
  // Not written: AWS uses the `default` cluster (the plan may leave the computed value unknown).
  const cluster = !configured(svc, 'cluster') ? (typeof c === 'string' && c ? c.split('/').pop() : 'default') : typeof c === 'string' && c ? c.split('/').pop() : refsTo(g.plan, svc.expressions.cluster, /^aws_ecs_cluster$/).map((x) => x.values.name).find((x): x is string => typeof x === 'string');
  if (!cluster) return undefined;
  return g.plan.resources.find((t) => {
    if (t.type !== 'aws_appautoscaling_target' || t.values.service_namespace !== 'ecs' || typeof t.values.resource_id !== 'string') return false;
    // A target that references an ECS service is matched by the reference, never by name; other
    // references (variables, locals, the cluster) still leave the name to match.
    if (refsTo(g.plan, t.expressions.resource_id, /^aws_ecs_service$/).length) return false;
    const [kind, cl, sv] = t.values.resource_id.split('/');
    return kind === 'service' && sv === name && cl === cluster && scope(t) === scope(svc);
  });
}

const ecsService: Rule = (rs, g) => {
  const s = rs[0];
  const out: RuleOut = { kind: 'service', params: {}, origins: {}, facts: {}, notes: [], uses: [] };
  // Merged instances (Q14) add up: each service instance scales on its own, between its own limits.
  const each = rs.map((r) => {
    const desired = num(r.values.desired_count) ?? 0;
    const target = referrers(g, /^aws_appautoscaling_target$/, 'resource_id', r).find((t) => t.values.service_namespace === 'ecs') ?? literalTarget(g, r);
    const min = target ? num(target.values.min_capacity) : undefined;
    const max = target ? num(target.values.max_capacity) : undefined;
    return { r, desired, target, min, max, start: Math.max(desired, min ?? 0) };
  });
  // Unknown until apply: left out (never 0), and said in a note; the answer file can set it.
  for (const x of each) {
    if (x.r.unknown.has('desired_count')) out.notes.push({ id: 'import.unknownValue', args: { from: `${x.r.address}.desired_count` }, node: s.address });
    for (const k of ['min_capacity', 'max_capacity']) if (x.target?.unknown.has(k)) out.notes.push({ id: 'import.unknownValue', args: { from: `${x.target.address}.${k}` }, node: s.address });
  }
  const sum = (f: (x: (typeof each)[number]) => number) => each.reduce((n, x) => n + f(x), 0);
  const desired = sum((x) => x.desired);
  const start = sum((x) => x.start);
  const first = each.find((x) => x.target);
  if (start > 0) {
    out.params.instances = start;
    out.origins.instances = start > desired && first ? iac(first.target!, 'min_capacity') : iac(s, 'desired_count');
  } else if (each.every((x) => num(x.r.values.desired_count) !== undefined && !unknownSet(x.r, 'desired_count') && (!x.target || (x.min !== undefined && !unknownSet(x.target, 'min_capacity'))))) {
    // Known to be 0 tasks (stopped): loadsketch needs at least 1.
    out.params.instances = 1;
    out.origins.instances = iac(s, 'desired_count');
    out.notes.push({ id: 'import.approx.instancesZero', args: { from: `${s.address}.desired_count` } });
  }
  if (first) {
    const target = first.target!;
    out.uses.push(...each.flatMap((x) => (x.target ? [x.target.address] : [])));
    out.params.autoscale = 'on';
    out.origins.autoscale = iac(target, 'scalable_dimension');
    if (each.every((x) => !x.target || x.max !== undefined)) {
      out.params.maxInstances = sum((x) => (x.target ? x.max! : x.start));
      out.origins.maxInstances = iac(target, 'max_capacity');
    }
    // The real floor (C4): min_capacity of each target, or the start of a service without one.
    if (each.every((x) => !x.target || x.min !== undefined)) out.facts.minInstances = { value: sum((x) => (x.target ? x.min! : x.start)), origin: iac(target, 'min_capacity') };
    // loadsketch has one `instances` for the start and the floor; ECS has desired_count and min_capacity.
    out.notes.push({ id: 'import.approx.instancesStartAndFloor', args: { desired, min: sum((x) => x.min ?? x.desired) }, node: s.address });
    const policies = each.flatMap((x) => (x.target ? referrers(g, /^aws_appautoscaling_policy$/, 'resource_id', x.target) : []));
    out.uses.push(...policies.map((p) => p.address));
    const tracking = [...new Set(policies)]
      .map((p) => {
        const tt = (Array.isArray(p.values.target_tracking_scaling_policy_configuration) ? p.values.target_tracking_scaling_policy_configuration[0] : undefined) as Record<string, unknown> | undefined;
        const spec = (Array.isArray(tt?.predefined_metric_specification) ? tt.predefined_metric_specification[0] : undefined) as Record<string, unknown> | undefined;
        const metric = typeof spec?.predefined_metric_type === 'string' ? spec.predefined_metric_type : p.unknown.has('target_tracking_scaling_policy_configuration') ? 'unknown' : 'custom';
        return { p, tt, metric };
      })
      .filter((x) => x.tt && num(x.tt.target_value) !== undefined);
    // Merged instances share one policy shape (Q14), so one note per metric is enough.
    for (const metric of new Set(tracking.filter((x) => x.metric !== CPU_METRIC).map((x) => x.metric))) out.notes.push({ id: 'import.unsupported.scalingMetric', args: { metric }, node: s.address });
    const cpu = tracking.find((x) => x.metric === CPU_METRIC);
    if (cpu) {
      out.params.targetUtil = Math.min(1, num(cpu.tt!.target_value)! / 100);
      out.origins.targetUtil = iac(cpu.p, 'target_tracking_scaling_policy_configuration.target_value');
      out.notes.push({ id: 'import.approx.cpuTarget', args: { target: num(cpu.tt!.target_value)! }, node: s.address });
    }
    const chosen = cpu ?? tracking[0];
    if (chosen) {
      const { p, tt } = chosen;
      if (num(tt!.scale_in_cooldown) !== undefined) {
        out.params.scaleDownS = num(tt!.scale_in_cooldown)!;
        out.origins.scaleDownS = iac(p, 'target_tracking_scaling_policy_configuration.scale_in_cooldown');
      }
      out.notes.push({ id: 'import.approx.scaleInCooldown', node: s.address });
    }
  }
  // AZs from the subnets it runs in (C3); left out when any subnet's zone is unknown until apply.
  const subnets = [...new Set(rs.flatMap((r) => refsTo(g.plan, r.expressions.network_configuration, /^aws_subnet$/)))];
  const zones = subnets.map((x) => (x.unknown.has('availability_zone') ? undefined : x.values.availability_zone));
  if (subnets.length && zones.every((z): z is string => typeof z === 'string' && !!z)) {
    out.facts.zones = { value: [...new Set(zones)].sort().join(','), origin: iac(subnets[0], 'availability_zone') };
  }
  const tds = refsTo(g.plan, s.expressions.task_definition, /^aws_ecs_task_definition$/);
  out.uses.push(...tds.map((t) => t.address));
  for (const td of tds) {
    for (const k of ['cpu', 'memory'] as const) if (td.values[k] !== undefined) out.facts[k] = { value: Number(td.values[k]), origin: iac(td, k) };
  }
  if (rs.length > 1) out.notes.push({ id: 'import.merged', args: { n: rs.length }, node: s.address });
  return out;
};

/** The DB in this plan that `r` replicates (replicate_source_db), when one is sure: the planned value
 *  picks among the references (a conditional references both branches); null means none. */
function replicaSource(g: ResourceGraph, r: PlanResource): PlanResource | undefined {
  const refs = refsTo(g.plan, r.expressions.replicate_source_db, /^aws_db_instance$/).filter((x) => x.address !== r.address);
  if (!refs.length) return undefined;
  const v = r.values.replicate_source_db;
  if (typeof v === 'string' && v) {
    const ids = (x: PlanResource) => [x.values.identifier, x.values.arn, x.values.id].filter((k): k is string => typeof k === 'string' && !!k);
    // An exact name first. Else an ARN built from the identifier (arn:aws:rds:<region>:<account>:db:<identifier>)
    // names a DB whose own ARN is not known yet, when the region agrees or is not set;
    // a known ARN that differs rules the DB out.
    const arn = /^arn:[^:]+:rds:([^:]*):[^:]*:db:(.+)$/.exec(v);
    const exact = refs.filter((x) => ids(x).includes(v));
    const byArn = (x: PlanResource) => !!arn && !(typeof x.values.arn === 'string' && x.values.arn) && x.values.identifier === arn[2] && (typeof x.values.region !== 'string' || x.values.region === arn[1]);
    const hit = exact.length ? exact : refs.filter(byArn);
    // The one reference is the source only when its names are not known yet; a known name that is not
    // the planned value means the source is outside the plan.
    return hit.length === 1 ? hit[0] : !hit.length && refs.length === 1 && !ids(refs[0]).length ? refs[0] : undefined;
  }
  return unknownSet(r, 'replicate_source_db') && refs.length === 1 ? refs[0] : undefined;
}
/** A replica nobody connects to (no line ends at it, the answer file does not name it, no proxy): it
 *  is one of its source's replicas. One that callers use keeps its own node and connection limit. */
const unusedReplica = (g: ResourceGraph, r: PlanResource) =>
  !!replicaSource(g, r) && !g.lines.some((l) => l.to === r.address) && !g.named?.has(r.address) && !referrers(g, /^aws_db_proxy_target$/, 'db_instance_identifier', r).length;
/** The node an unused replica counts under: up its chain (main -> r1 -> r2) to the first DB that is a node. */
function replicaRoot(g: ResourceGraph, r: PlanResource): PlanResource {
  let x = r;
  for (let i = 0; i <= g.plan.resources.length && unusedReplica(g, x); i++) x = replicaSource(g, x)!;
  return x;
}

const dbInstance: Rule = (rs, g) => {
  const db = rs[0];
  // An unused read replica of a DB in this plan is one of that DB's replicas (loadsketch's model), not a
  // second database that takes writes.
  if (rs.every((r) => unusedReplica(g, r))) return { fold: 'import.folded.readReplica' };
  const out: RuleOut = { kind: 'database', params: {}, origins: {}, facts: {}, notes: [], uses: [] };
  const M = DEFAULTS.dbInstance.multiAz;
  // Set from something unknown until apply: no multi-AZ fact (C3 says incomplete), never the AWS default.
  if (unknownSet(db, 'multi_az')) out.notes.push({ id: db.unknown.has('multi_az') ? 'import.unknownValue' : 'import.sensitiveValue', args: { from: `${db.address}.multi_az` }, node: db.address });
  else {
    const set = typeof db.values.multi_az === 'boolean';
    const multiAz = set ? (db.values.multi_az as boolean) : M.value;
    out.facts.multiAz = { value: multiAz, origin: set ? iac(db, 'multi_az') : awsDefault(db, 'multi_az', M.source) };
    // Multi-AZ keeps a standby that takes over and serves no reads. loadsketch fails over only to a read
    // replica, so 'auto' with 0 replicas would do nothing: off, and a note. C3 reads the fact.
    out.params.failover = 'off';
    out.origins.failover = out.facts.multiAz.origin;
    if (multiAz) out.notes.push({ id: 'import.approx.multiAzStandby' });
  }
  for (const [k, attr] of [['engine', 'engine'], ['instanceClass', 'instance_class'], ['engineVersion', 'engine_version'], ['allocatedStorage', 'allocated_storage']] as const) {
    const v = db.values[attr];
    if ((typeof v === 'string' && v) || typeof v === 'number') out.facts[k] = { value: v, origin: iac(db, attr) };
  }
  const env = environmentTag(db);
  if (env) out.facts.environment = { value: env.value, origin: iac(db, `tags.${env.key}`) };
  const mc = maxConnectionsSetting(db, g, 'parameter_group_name', 'aws_db_parameter_group');
  if (mc) out.facts.maxConnections = mc;
  // Its unused read replicas, down the chain, are members, and `replicas` counts them.
  // Callers use the primary endpoint only, so reads stay on the primary (readFrom), as before.
  const readers = g.plan.resources.filter((r) => r.type === 'aws_db_instance' && !rs.includes(r) && unusedReplica(g, r) && rs.includes(replicaRoot(g, r)));
  // loadsketch allows at most 15 replicas (kinds.ts); a cascade can have more.
  const REPLICAS_MAX = 15;
  out.params.replicas = Math.min(readers.length, REPLICAS_MAX);
  out.origins.replicas = readers.length ? iac(readers[0], 'replicate_source_db') : { evidence: 'iac', from: `${db.address}` };
  if (readers.length > REPLICAS_MAX) out.notes.push({ id: 'import.approx.capped', args: { param: 'replicas', value: readers.length, max: REPLICAS_MAX } });
  // Every replica in the plan, folded or its own node, for C10: the DB has replicas either way.
  const physical = [...new Set([...readers, ...g.plan.resources.filter((r) => r.type === 'aws_db_instance' && !rs.includes(r) && rs.includes(replicaSource(g, r)!))])];
  if (physical.length) out.facts.readReplicas = { value: physical.length, origin: iac(physical[0], 'replicate_source_db') };
  if (readers.length) {
    out.members = readers.map((r) => r.address);
    out.uses.push(...out.members);
    out.params.readFrom = 'primary';
    out.origins.readFrom = estimate(readers[0].address, 'no line ends at the replica: callers use the primary endpoint');
  }
  // A replica that stays a node (callers use it, or its source is outside the plan or not sure): it
  // takes writes in the simulation. replicaOf for C10.
  const source = db.values.replicate_source_db;
  // A planned null is no replica, even when a conditional references a DB.
  if ((typeof source === 'string' && source) || unknownSet(db, 'replicate_source_db')) {
    out.facts.replicaOf = { value: typeof source === 'string' && source ? source : 'unknown', origin: iac(db, 'replicate_source_db') };
    out.notes.push({ id: replicaSource(g, db) ? 'import.approx.replicaNode' : 'import.approx.replicaOutside', node: db.address });
  }
  addProxy(out, proxyFor(g, db, 'db_instance_identifier'));
  if (rs.length > 1) out.notes.push({ id: 'import.merged', args: { n: rs.length }, node: db.address });
  return out;
};

export const RULES: Record<string, Rule> = {
  aws_lb: loadBalancer,
  aws_alb: loadBalancer,
  aws_ecs_service: ecsService,
  aws_db_instance: dbInstance,
  ...SERVERLESS_RULES,
  ...PLATFORM_RULES,
};

/** Types that never become a node of their own: they shape another node, or are network plumbing. */
export const FOLDED: Record<string, string> = {
  aws_lb_target_group: 'import.folded.targetGroup',
  aws_alb_target_group: 'import.folded.targetGroup',
  aws_lb_listener: 'import.folded.listener',
  aws_alb_listener: 'import.folded.listener',
  aws_lb_listener_rule: 'import.folded.listener',
  aws_lb_target_group_attachment: 'import.folded.targetGroup',
  aws_appautoscaling_target: 'import.folded.autoscaling',
  aws_appautoscaling_policy: 'import.folded.autoscaling',
  aws_ecs_task_definition: 'import.folded.taskDefinition',
  aws_db_parameter_group: 'import.folded.parameterGroup',
  aws_ecs_cluster: 'import.folded.cluster',
  aws_vpc: 'import.folded.network',
  aws_subnet: 'import.folded.network',
  aws_security_group: 'import.folded.network',
  aws_security_group_rule: 'import.folded.network',
  aws_vpc_security_group_ingress_rule: 'import.folded.network',
  aws_vpc_security_group_egress_rule: 'import.folded.network',
  aws_db_subnet_group: 'import.folded.network',
  aws_route_table: 'import.folded.network',
  aws_route_table_association: 'import.folded.network',
  aws_internet_gateway: 'import.folded.network',
  aws_nat_gateway: 'import.folded.network',
  aws_eip: 'import.folded.network',
  ...SERVERLESS_FOLDED,
  ...PLATFORM_FOLDED,
};
