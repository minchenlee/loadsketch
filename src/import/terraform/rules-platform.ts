// Mapping rules for the edge, cache, Aurora and EC2 resource group:
// CloudFront, Route 53, ElastiCache, Aurora, RDS Proxy, Auto Scaling groups.
import { DEFAULTS } from './defaults.ts';
import { refsTo, type ResourceGraph } from './graph.ts';
import type { PlanResource } from './plan.ts';
import type { Fact, Origin } from './result.ts';
import { awsDefault, block, configured, environmentTag, estimate, iac, maxConnectionsSetting, num, referrers, setOr, unknownSet, zonesOf, type Rule, type RuleOut } from './rule-kit.ts';

const empty = (kind: string): RuleOut => ({ kind, params: {}, origins: {}, facts: {}, notes: [], uses: [] });
const set = (out: RuleOut, param: string, value: number | string, origin: Origin) => {
  out.params[param] = value;
  out.origins[param] = origin;
};
const uniq = (rs: PlanResource[]) => [...new Map(rs.map((r) => [r.address, r])).values()];

/** The RDS Proxy in front of a DB instance or an Aurora cluster: its address (a member of the DB
 *  node, so lines to its endpoint end at the DB) and the share of max_connections each proxy may use. */
export function proxyFor(g: ResourceGraph, db: PlanResource, attr: 'db_instance_identifier' | 'db_cluster_identifier'): { proxies: string[]; uses: string[]; percents: Fact[] } | undefined {
  const targets = referrers(g, /^aws_db_proxy_target$/, attr, db);
  const proxies = uniq(targets.flatMap((t) => refsTo(g.plan, t.expressions.db_proxy_name, /^aws_db_proxy$/)));
  if (!proxies.length) return undefined;
  const P = DEFAULTS.rdsProxy.maxConnectionsPercent;
  const uses: string[] = targets.map((r) => r.address);
  // Each proxy has its own pool: its own target group and percent.
  const percents = proxies.map((p): Fact => {
    const tg = referrers(g, /^aws_db_proxy_default_target_group$/, 'db_proxy_name', p)[0];
    if (tg) uses.push(tg.address);
    const pct = num(block(tg?.values.connection_pool_config)?.max_connections_percent);
    const origin = tg ? setOr(tg, 'connection_pool_config.max_connections_percent', P.source) : awsDefault(p, 'connection_pool_config.max_connections_percent', P.source);
    return { value: pct ?? P.value, origin };
  });
  return { proxies: proxies.map((p) => p.address), uses, percents };
}
/** The fact that holds one proxy's percent when a DB has more than one proxy. */
export const proxyPercentFact = (proxy: string) => `proxyMaxConnectionsPercent:${proxy}`;
/** Put a proxy on a DB node's rule output. */
export function addProxy(out: RuleOut, p: ReturnType<typeof proxyFor>): void {
  if (!p) return;
  out.members = [...(out.members ?? []), ...p.proxies];
  out.through = [...(out.through ?? []), ...p.proxies];
  out.uses.push(...p.uses);
  out.facts.proxyMaxConnectionsPercent = p.percents[0];
  if (p.proxies.length > 1) p.proxies.forEach((a, i) => (out.facts[proxyPercentFact(a)] = p.percents[i]));
  for (const pct of new Set(p.percents.map((f) => Number(f.value)))) out.notes.push({ id: 'import.approx.proxy', args: { pct } });
}

const cloudfront: Rule = ([cf]) => {
  const out = empty('cdn');
  out.entry = true;
  const ttl = num(block(cf.values.default_cache_behavior)?.default_ttl);
  if (ttl !== undefined) out.facts.defaultTtlS = { value: ttl, origin: iac(cf, 'default_cache_behavior.default_ttl') };
  out.notes.push({ id: 'import.approx.hitRatio' });
  return out;
};

/** PRIMARY or SECONDARY of a failover record ('' for none or unknown). */
const failoverRole = (r: PlanResource) => String(block(r.values.failover_routing_policy)?.type ?? '').toUpperCase();
/** The name a failover pair shares: zone, name and type (undefined when one is not known). */
function recordKey(g: ResourceGraph, r: PlanResource): string | undefined {
  const { name, type } = r.values;
  if (typeof name !== 'string' || typeof type !== 'string') return undefined;
  let zone = typeof r.values.zone_id === 'string' ? r.values.zone_id : undefined;
  if (!zone) {
    // A reference only when it names one zone: a conditional names both.
    const zones = refsTo(g.plan, r.expressions.zone_id, /^aws_route53_zone$/);
    zone = zones.length === 1 ? zones[0].address : undefined;
  }
  return zone ? `${zone}|${name.replace(/\.$/, '').toLowerCase()}|${type}` : undefined;
}
/** Failover records by name key and role, built once per graph (no scan per record). */
const RECORDS = new WeakMap<ResourceGraph, { key: Map<string, string | undefined>; byKey: Map<string, PlanResource[]> }>();
function records(g: ResourceGraph) {
  let x = RECORDS.get(g);
  if (!x) {
    x = { key: new Map(), byKey: new Map() };
    for (const r of g.plan.resources) {
      if (r.type !== 'aws_route53_record' || !failoverRole(r)) continue;
      const k = recordKey(g, r);
      x.key.set(r.address, k);
      if (k) x.byKey.set(k, [...(x.byKey.get(k) ?? []), r]);
    }
    RECORDS.set(g, x);
  }
  return x;
}
/** The other records of the same name with failover role `role`. */
const partners = (g: ResourceGraph, r: PlanResource, role: string) => {
  const { key, byKey } = records(g);
  const k = key.get(r.address);
  return k ? (byKey.get(k) ?? []).filter((x) => x.address !== r.address && failoverRole(x) === role) : [];
};
/** Edge weights of a failover pair: Route 53 sends everything to PRIMARY while it is healthy; the
 *  simulator's DNS splits by weight and drops a failed target, so SECONDARY gets 1/1001. */
const FAILOVER_WEIGHT = { PRIMARY: 1000, SECONDARY: 1 } as const;

const route53Record: Rule = (rs, g) => {
  // One name with a PRIMARY and a SECONDARY record is one entry: the SECONDARY folds into it.
  // Failover records never merge (graph.ts), so `rs` is one record.
  const rec = rs[0];
  if (failoverRole(rec) === 'SECONDARY' && partners(g, rec, 'PRIMARY').length) return { fold: 'import.folded.failoverSecondary' };
  const failover = !!block(rec.values.failover_routing_policy) || configured(rec, 'failover_routing_policy');
  // A record that points at nothing mapped and has no failover is plumbing (validation records, mail).
  if (!failover && !g.lines.some((l) => l.from === rec.address) && !rs.some((r) => g.named?.has(r.address))) return { fold: 'import.folded.dnsRecord' };
  const out = empty('dns');
  out.entry = true;
  if (failover) set(out, 'failover', 'on', iac(rec, 'failover_routing_policy'));
  const secondaries = failoverRole(rec) === 'PRIMARY' ? partners(g, rec, 'SECONDARY') : [];
  if (secondaries.length) {
    const pair = [rec, ...secondaries];
    out.members = secondaries.map((x) => x.address);
    out.lineWeights = Object.fromEntries(pair.map((r) => {
      const role = failoverRole(r) as keyof typeof FAILOVER_WEIGHT;
      return [r.address, { value: FAILOVER_WEIGHT[role], origin: estimate(`${r.address}.failover_routing_policy`, 'import.approx.failoverPair') }];
    }));
    out.notes.push({ id: 'import.approx.failoverPair', args: { n: pair.length } });
  }
  const ttl = num(rec.values.ttl);
  if (ttl !== undefined) set(out, 'ttlS', ttl, iac(rec, 'ttl'));
  const hc = refsTo(g.plan, rec.expressions.health_check_id, /^aws_route53_health_check$/)[0];
  if (hc) {
    out.uses.push(hc.address);
    const R = DEFAULTS.route53;
    const iv = num(hc.values.request_interval) ?? R.requestInterval.value;
    const th = num(hc.values.failure_threshold) ?? R.failureThreshold.value;
    const ivO = setOr(hc, 'request_interval', R.requestInterval.source);
    const thO = setOr(hc, 'failure_threshold', R.failureThreshold.source);
    out.facts.requestInterval = { value: iv, origin: ivO };
    out.facts.failureThreshold = { value: th, origin: thO };
    // Both written: the product is iac; otherwise the default one carries its source.
    if (failover) set(out, 'detectS', iv * th, ivO.evidence === 'iac' && thO.evidence === 'iac' ? iac(hc, 'request_interval*failure_threshold') : ivO.evidence === 'iac' ? thO : ivO);
  }
  return out;
};

const replicationGroup: Rule = (rs, g) => {
  const c = rs[0];
  const E = DEFAULTS.elastiCache;
  const out = empty('cache');
  // Its cache clusters: lines to their endpoints end at the group (they are folded: cacheCluster()).
  out.members = rs.flatMap((r) => referrers(g, /^aws_elasticache_cluster$/, 'replication_group_id', r)).map((x) => x.address);
  const shards = num(c.values.num_node_groups);
  if (configured(c, 'num_node_groups') && shards !== undefined) {
    set(out, 'instances', shards, iac(c, 'num_node_groups'));
    out.notes.push({ id: 'import.approx.clusterMode', args: { n: shards } });
  } else {
    const n = num(c.values.num_cache_clusters) ?? E.numCacheClusters.value;
    const o = setOr(c, 'num_cache_clusters', E.numCacheClusters.source);
    set(out, 'instances', n, o);
    out.facts.numCacheClusters = { value: n, origin: o };
  }
  if (typeof c.values.node_type === 'string') out.facts.nodeType = { value: c.values.node_type, origin: iac(c, 'node_type') };
  if (typeof c.values.engine === 'string') out.facts.engine = { value: c.values.engine, origin: iac(c, 'engine') };
  out.facts.automaticFailover = { value: c.values.automatic_failover_enabled === true, origin: setOr(c, 'automatic_failover_enabled', E.automaticFailover.source) };
  out.facts.multiAz = { value: c.values.multi_az_enabled === true, origin: setOr(c, 'multi_az_enabled', E.multiAz.source) };
  const env = environmentTag(c);
  if (env) out.facts.environment = { value: env.value, origin: iac(c, `tags.${env.key}`) };
  const subnetGroup = refsTo(g.plan, c.expressions.subnet_group_name, /^aws_elasticache_subnet_group$/)[0];
  const zones = subnetGroup ? zonesOf(g, subnetGroup.expressions.subnet_ids) : undefined;
  if (zones) out.facts.zones = zones;
  out.notes.push({ id: 'import.approx.hitRatio' });
  return out;
};

const cacheCluster: Rule = ([c], g) => {
  // A member of a replication group: that group is the node.
  if (refsTo(g.plan, c.expressions.replication_group_id, /^aws_elasticache_replication_group$/).length) return { fold: 'import.folded.cacheMember' };
  const out = empty('cache');
  const n = num(c.values.num_cache_nodes) ?? 1;
  set(out, 'instances', n, setOr(c, 'num_cache_nodes', DEFAULTS.elastiCache.numCacheClusters.source));
  out.facts.numCacheClusters = { value: n, origin: out.origins.instances };
  out.facts.automaticFailover = { value: false, origin: awsDefault(c, 'automatic_failover_enabled', DEFAULTS.elastiCache.automaticFailover.source) };
  if (typeof c.values.node_type === 'string') out.facts.nodeType = { value: c.values.node_type, origin: iac(c, 'node_type') };
  if (typeof c.values.engine === 'string') out.facts.engine = { value: c.values.engine, origin: iac(c, 'engine') };
  out.notes.push({ id: 'import.approx.hitRatio' });
  return out;
};

const rdsCluster: Rule = (rs, g) => {
  const c = rs[0];
  const out = empty('database');
  const insts = rs.flatMap((r) => referrers(g, /^aws_rds_cluster_instance$/, 'cluster_identifier', r));
  out.members = insts.map((i) => i.address);
  out.uses.push(...out.members);
  out.facts.instanceCount = { value: insts.length, origin: insts.length ? iac(insts[0], 'cluster_identifier') : iac(c, 'cluster_identifier') };
  if (typeof c.values.engine === 'string') out.facts.engine = { value: c.values.engine, origin: iac(c, 'engine') };
  const classes = [...new Set(insts.map((i) => i.values.instance_class).filter((x): x is string => typeof x === 'string'))];
  if (classes.length) out.facts.instanceClass = { value: classes[0], origin: iac(insts.find((i) => i.values.instance_class === classes[0])!, 'instance_class') };
  if (classes.length > 1) out.notes.push({ id: 'import.approx.mixedClasses', args: { used: classes[0] } });
  // max_connections: an instance's DB parameter group wins over the cluster parameter group. Instances
  // that disagree (or one the plan cannot read): unknown, so C1 says incomplete.
  const fromCluster = maxConnectionsSetting(c, g, 'db_cluster_parameter_group_name', 'aws_rds_cluster_parameter_group');
  const each = (insts.length ? insts : [undefined]).map((i) => (i && maxConnectionsSetting(i, g, 'db_parameter_group_name', 'aws_db_parameter_group')) ?? fromCluster);
  const setting = each.find((x) => x);
  if (setting) out.facts.maxConnections = each.every((x) => x && x.value === setting.value) ? setting : { value: 'unknown', origin: setting.origin };
  const env = environmentTag(c);
  if (env) out.facts.environment = { value: env.value, origin: iac(c, `tags.${env.key}`) };
  if (insts.length) {
    // One writer, the rest readers behind the reader endpoint; Aurora fails over to a reader.
    set(out, 'replicas', insts.length - 1, iac(insts[0], 'cluster_identifier'));
    const A = DEFAULTS.aurora.failoverS;
    if (insts.length > 1) {
      set(out, 'failover', 'auto', awsDefault(c, 'failover', A.source));
      set(out, 'failoverS', A.value, awsDefault(c, 'failover', A.source));
      set(out, 'readFrom', 'replicas', estimate(c.address, 'reads use the reader endpoint'));
      out.notes.push({ id: 'import.approx.readerEndpoint' });
    }
  } else out.notes.push({ id: 'import.aurora.noInstances' });
  addProxy(out, proxyFor(g, c, 'db_cluster_identifier'));
  return out;
};

const CPU_METRIC = 'ASGAverageCPUUtilization';

const autoscalingGroup: Rule = (rs, g) => {
  const a = rs[0];
  const out = empty('service');
  // Identical groups (count, for_each) are one node: their capacities add up, as for ECS services.
  const sum = (read: (r: PlanResource) => number | undefined) => {
    const vs = rs.map(read);
    return vs.every((v) => v !== undefined) ? (vs as number[]).reduce((x, y) => x + y, 0) : undefined;
  };
  const desired = sum((r) => (r.unknown.has('desired_capacity') ? undefined : num(r.values.desired_capacity)));
  const min = sum((r) => num(r.values.min_size));
  const max = sum((r) => num(r.values.max_size));
  const start = Math.max(desired ?? 0, min ?? 0);
  if (start > 0) set(out, 'instances', start, desired !== undefined && desired >= (min ?? 0) ? iac(a, 'desired_capacity') : iac(a, 'min_size'));
  else if (min !== undefined && !rs.some((r) => unknownSet(r, 'desired_capacity') || unknownSet(r, 'min_size'))) {
    // Known to be 0 instances (scaled to zero): loadsketch needs at least 1.
    set(out, 'instances', 1, iac(a, 'min_size'));
    out.notes.push({ id: 'import.approx.instancesZero', args: { from: `${a.address}.min_size` } });
  }
  if (min !== undefined) out.facts.minInstances = { value: min, origin: iac(a, 'min_size') };
  if (max !== undefined) out.facts.maxSize = { value: max, origin: iac(a, 'max_size') };
  const policies = [...new Set(rs.flatMap((r) => referrers(g, /^aws_autoscaling_policy$/, 'autoscaling_group_name', r)))];
  out.uses.push(...policies.map((p) => p.address));
  if (policies.length && max !== undefined) {
    set(out, 'autoscale', 'on', iac(policies[0], 'autoscaling_group_name'));
    set(out, 'maxInstances', max, iac(a, 'max_size'));
    const tracked = policies
      .map((p) => ({ p, tt: block(p.values.target_tracking_configuration) }))
      .find((x) => block(x.tt?.predefined_metric_specification)?.predefined_metric_type === CPU_METRIC && num(x.tt?.target_value) !== undefined);
    if (tracked) {
      set(out, 'targetUtil', Math.min(1, num(tracked.tt!.target_value)! / 100), iac(tracked.p, 'target_tracking_configuration.target_value'));
      out.notes.push({ id: 'import.approx.cpuTarget', args: { target: num(tracked.tt!.target_value)! } });
    } else out.notes.push({ id: 'import.unsupported.scalingMetric', args: { metric: String(policies[0].values.policy_type ?? 'unknown') } });
    out.notes.push({ id: 'import.approx.instancesStartAndFloor', args: { desired: desired ?? start, min: min ?? start } });
  }
  // Size from the launch template (or launch configuration).
  const lts = refsTo(g.plan, [a.expressions.launch_template, a.expressions.mixed_instances_policy, a.expressions.launch_configuration], /^aws_(launch_template|launch_configuration)$/);
  out.uses.push(...lts.map((l) => l.address));
  const lt = lts.find((l) => typeof l.values.instance_type === 'string');
  if (lt) out.facts.instanceType = { value: lt.values.instance_type as string, origin: iac(lt, 'instance_type') };
  else if (lts.length) out.notes.push({ id: 'import.unknownValue', args: { from: `${lts[0].address}.instance_type` } });
  const zones = zonesOf(g, a.expressions.vpc_zone_identifier);
  if (zones) out.facts.zones = zones;
  const grace = num(a.values.health_check_grace_period);
  if (grace !== undefined) out.facts.gracePeriodS = { value: grace, origin: iac(a, 'health_check_grace_period') };
  if (rs.length > 1) out.notes.push({ id: 'import.merged', args: { n: rs.length } });
  return out;
};

export const PLATFORM_RULES: Record<string, Rule> = {
  aws_cloudfront_distribution: cloudfront,
  aws_route53_record: route53Record,
  aws_elasticache_replication_group: replicationGroup,
  aws_elasticache_cluster: cacheCluster,
  aws_rds_cluster: rdsCluster,
  aws_autoscaling_group: autoscalingGroup,
};
export const PLATFORM_FOLDED: Record<string, string> = {
  aws_rds_cluster_instance: 'import.folded.clusterInstance',
  aws_db_proxy: 'import.folded.proxy',
  aws_db_proxy_default_target_group: 'import.folded.proxy',
  aws_db_proxy_target: 'import.folded.proxy',
  aws_rds_cluster_parameter_group: 'import.folded.parameterGroup',
  aws_route53_health_check: 'import.folded.healthCheck',
  aws_route53_zone: 'import.folded.dnsRecord',
  aws_elasticache_subnet_group: 'import.folded.network',
  aws_elasticache_parameter_group: 'import.folded.parameterGroup',
  aws_launch_template: 'import.folded.launchTemplate',
  aws_launch_configuration: 'import.folded.launchTemplate',
  aws_autoscaling_policy: 'import.folded.autoscaling',
  aws_autoscaling_attachment: 'import.folded.targetGroup',
  aws_secretsmanager_secret: 'import.folded.permission',
  aws_secretsmanager_secret_version: 'import.folded.permission',
  aws_acm_certificate: 'import.folded.permission',
  aws_acm_certificate_validation: 'import.folded.permission',
  aws_cloudfront_origin_access_control: 'import.folded.cdnSetting',
  aws_cloudfront_origin_access_identity: 'import.folded.cdnSetting',
  aws_cloudfront_cache_policy: 'import.folded.cdnSetting',
};
