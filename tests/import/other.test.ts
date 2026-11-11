// M29b "other" group: one test (or two) per item.
import { describe, expect, it } from 'vitest';
import { parseDesign } from '../../src/core/index.ts';
import { ANSWERS_SCHEMA, importTerraform, parseAnswers, runChecks } from '../../src/import/terraform/index.ts';
import { cpuMs } from '../helpers.ts';
import { ecsPlan, plan, refs, type R } from './plan-helper.ts';

describe('M29b other', () => {
  it('#44 a resource name over 60 characters still makes a valid design; the address is kept', () => {
    const long = 'a'.repeat(70);
    const r = importTerraform(ecsPlan([{ address: `aws_ecs_service.${long}`, values: { desired_count: 2 }, expressions: { load_balancer: [{ target_group_arn: refs('aws_lb_target_group.a') }] } }], ['aws_ecs_service.s', 'aws_appautoscaling_target.t', 'aws_appautoscaling_policy.p']));
    const n = r.design.nodes.find((x) => x.kind === 'service')!;
    expect(n.label!.length).toBeLessThanOrEqual(60);
    expect(r.nodeFrom[n.id]).toEqual([`aws_ecs_service.${long}`]);
    expect(() => parseDesign(r.design)).not.toThrow();
  });
  it('#38 a scaling target with a literal resource_id finds its ECS service by name', () => {
    const r = importTerraform(ecsPlan([
      { address: 'aws_ecs_cluster.c', values: { name: 'prod' } },
      { address: 'aws_ecs_service.s', values: { name: 'api', desired_count: 2 }, expressions: { cluster: refs('aws_ecs_cluster.c'), load_balancer: [{ target_group_arn: refs('aws_lb_target_group.a') }] } },
      { address: 'aws_appautoscaling_target.t', values: { service_namespace: 'ecs', resource_id: 'service/prod/api', min_capacity: 2, max_capacity: 8 } },
      { address: 'aws_appautoscaling_target.other', values: { service_namespace: 'ecs', resource_id: 'service/stage/api', min_capacity: 1, max_capacity: 3 } },
    ]));
    expect(r.design.nodes.find((n) => n.id === 'ecs_service_s')!.params).toMatchObject({ autoscale: 'on', maxInstances: 8 });
  });
  it('#38 a service whose cluster is unknown matches no literal target; a target with a reference is not matched by name', () => {
    const r = importTerraform(ecsPlan([
      { address: 'aws_ecs_cluster.c', values: { name: 'prod' } },
      { address: 'aws_ecs_service.s', values: { name: 'api', desired_count: 2 }, expressions: { cluster: refs('aws_ecs_cluster.c'), load_balancer: [{ target_group_arn: refs('aws_lb_target_group.a') }] } },
      { address: 'aws_ecs_service.u', values: { name: 'api', desired_count: 2 }, unknown: ['cluster'] },
      { address: 'aws_appautoscaling_target.t', values: { service_namespace: 'ecs', resource_id: 'service/prod/api', min_capacity: 4, max_capacity: 8 }, expressions: { resource_id: refs('aws_ecs_service.s') } },
    ]));
    const u = r.design.nodes.find((n) => n.id === 'ecs_service_u')!;
    expect(u.params?.autoscale).not.toBe('on');
    expect(u.params?.maxInstances).toBeUndefined();
  });
  it('#38 a literal target matches only a service in its own region', () => {
    const r = importTerraform(ecsPlan([
      { address: 'aws_ecs_service.s', values: { name: 'api', desired_count: 2, cluster: 'prod', region: 'us-east-1' }, expressions: { load_balancer: [{ target_group_arn: refs('aws_lb_target_group.a') }] } },
      { address: 'aws_ecs_service.w', values: { name: 'api', desired_count: 2, cluster: 'arn:aws:ecs:us-west-2:1:cluster/prod', region: 'us-west-2' } },
      { address: 'aws_appautoscaling_target.t', values: { service_namespace: 'ecs', resource_id: 'service/prod/api', min_capacity: 2, max_capacity: 8, region: 'us-east-1' } },
    ]));
    expect(r.design.nodes.find((n) => n.id === 'ecs_service_s')!.params).toMatchObject({ autoscale: 'on', maxInstances: 8 });
    expect(r.design.nodes.find((n) => n.id === 'ecs_service_w')!.params?.autoscale).not.toBe('on');
  });
  it('#38 a literal target matches only a service of its own provider configuration', () => {
    const p = ecsPlan([
      { address: 'aws_ecs_service.s', values: { name: 'api', desired_count: 2, cluster: 'prod' }, expressions: { load_balancer: [{ target_group_arn: refs('aws_lb_target_group.a') }] } },
      { address: 'aws_ecs_service.w', values: { name: 'api', desired_count: 2, cluster: 'prod' } },
      { address: 'aws_appautoscaling_target.t', values: { service_namespace: 'ecs', resource_id: 'service/prod/api', min_capacity: 2, max_capacity: 8 } },
    ]) as { configuration: { root_module: { resources: { address: string; provider_config_key?: string }[] } } };
    for (const c of p.configuration.root_module.resources) c.provider_config_key = c.address === 'aws_ecs_service.w' ? 'aws.west' : 'aws';
    const r = importTerraform(p);
    expect(r.design.nodes.find((n) => n.id === 'ecs_service_s')!.params).toMatchObject({ autoscale: 'on', maxInstances: 8 });
    expect(r.design.nodes.find((n) => n.id === 'ecs_service_w')!.params?.autoscale).not.toBe('on');
  });
  it('#38 a literal resource_id built from the cluster reference still matches by name', () => {
    const r = importTerraform(ecsPlan([
      { address: 'aws_ecs_cluster.c', values: { name: 'prod' } },
      { address: 'aws_ecs_service.s', values: { name: 'api', desired_count: 2 }, expressions: { cluster: refs('aws_ecs_cluster.c'), load_balancer: [{ target_group_arn: refs('aws_lb_target_group.a') }] } },
      { address: 'aws_appautoscaling_target.t', values: { service_namespace: 'ecs', resource_id: 'service/prod/api', min_capacity: 4, max_capacity: 8 }, expressions: { resource_id: { references: ['aws_ecs_cluster.c.name', 'aws_ecs_cluster.c'] } } },
    ]));
    expect(r.design.nodes.find((n) => n.id === 'ecs_service_s')!.params).toMatchObject({ autoscale: 'on', maxInstances: 8 });
  });
  it('#38 a service with no cluster written is in the default cluster', () => {
    const r = importTerraform(ecsPlan([
      { address: 'aws_ecs_service.s', values: { name: 'api', desired_count: 2 }, expressions: { load_balancer: [{ target_group_arn: refs('aws_lb_target_group.a') }] }, unknown: ['cluster'] },
      { address: 'aws_appautoscaling_target.t', values: { service_namespace: 'ecs', resource_id: 'service/default/api', min_capacity: 2, max_capacity: 8 } },
    ]));
    expect(r.design.nodes.find((n) => n.id === 'ecs_service_s')!.params).toMatchObject({ autoscale: 'on', maxInstances: 8 });
  });
  it('#14 user_data of a launch configuration gives the ASG a presumed line to the DB', () => {
    const r = importTerraform(plan([
      { address: 'aws_lb.web', values: { internal: false } },
      { address: 'aws_lb_listener.l', expressions: { load_balancer_arn: refs('aws_lb.web'), default_action: [{ target_group_arn: refs('aws_lb_target_group.t') }] } },
      { address: 'aws_lb_target_group.t', values: {} },
      { address: 'aws_launch_configuration.lc', values: { instance_type: 't3.small' }, expressions: { user_data: { references: ['aws_db_instance.main.address', 'aws_db_instance.main'] } } },
      { address: 'aws_autoscaling_group.a', values: { min_size: 2, max_size: 4 }, expressions: { target_group_arns: refs('aws_lb_target_group.t'), launch_configuration: refs('aws_launch_configuration.lc') } },
      { address: 'aws_db_instance.main', values: { engine: 'postgres', instance_class: 'db.t3.medium' } },
    ]));
    const e = r.design.edges.find((x) => x.from === 'autoscaling_group_a' && x.to === 'db_instance_main');
    expect(e && r.edges[e.id!].kind).toBe('presumed');
  });
  it('#19 bulkhead 0 on a line from a function: C2 is not incomplete', () => {
    const p = plan([
      { address: 'aws_api_gateway_rest_api.api' },
      { address: 'aws_api_gateway_integration.i', expressions: { rest_api_id: refs('aws_api_gateway_rest_api.api'), uri: refs('aws_lambda_function.f') } },
      { address: 'aws_lambda_function.f', values: { reserved_concurrent_executions: 1000 }, expressions: { environment: [{ variables: { D: refs('aws_db_instance.d') } }] } },
      { address: 'aws_db_instance.d', values: { engine: 'postgres', instance_class: 'db.t3.medium', multi_az: false } },
    ]);
    const c2 = (bulkhead?: number) => runChecks(importTerraform(p, { answers: parseAnswers({ schema: ANSWERS_SCHEMA, edges: [{ from: 'aws_lambda_function.f', to: 'aws_db_instance.d', ...(bulkhead === undefined ? {} : { bulkhead }) }] }) })).filter((f) => f.check === 'C2');
    expect(c2(0).map((f) => f.certainty)).not.toContain('incomplete');
    expect(c2().length).toBeGreaterThan(0);
    expect(c2(0).map((f) => f.id)).toEqual(c2().map((f) => f.id));
  });
  it('#30 autoscaling on a GSI only is not the table\'s autoscaling', () => {
    const t = { address: 'aws_dynamodb_table.t', values: { name: 't', billing_mode: 'PROVISIONED', read_capacity: 5, write_capacity: 5 } };
    const lb = { address: 'aws_lb.web', values: { internal: false } };
    const gsi = importTerraform(plan([lb, t, { address: 'aws_appautoscaling_target.g', values: { service_namespace: 'dynamodb', resource_id: 'table/t/index/by_user', scalable_dimension: 'dynamodb:index:ReadCapacityUnits' } }]));
    expect(gsi.facts.dynamodb_table_t.capacityAutoscaling.value).toBe(false);
    const tbl = importTerraform(plan([lb, t, { address: 'aws_appautoscaling_target.r', values: { service_namespace: 'dynamodb', resource_id: 'table/t', scalable_dimension: 'dynamodb:table:ReadCapacityUnits' } }]));
    expect(tbl.facts.dynamodb_table_t.capacityAutoscaling.value).toBe(true);
  });
  const pg = (name: string, extra: Partial<R> = {}): R => ({ address: `aws_db_instance.${name}`, ...extra, values: { identifier: name, engine: 'postgres', instance_class: 'db.t3.medium', multi_az: false, ...extra.values } });
  const replicaOf = (name: string, src: string | null, refsTo: string[] = [src!], unknown = false): R => pg(name, { values: { replicate_source_db: src }, expressions: { replicate_source_db: { references: refsTo.flatMap((x) => [`aws_db_instance.${x}.identifier`, `aws_db_instance.${x}`]) } }, ...(unknown ? { unknown: ['replicate_source_db'] } : {}) });
  /** The ECS service reads DB_HOST of `db`. */
  const caller = (db: string): R[] => [
    { address: 'aws_ecs_task_definition.td', values: {}, expressions: { container_definitions: { references: [`aws_db_instance.${db}.address`, `aws_db_instance.${db}`] } } },
    { address: 'aws_ecs_service.s', values: { desired_count: 2 }, expressions: { task_definition: refs('aws_ecs_task_definition.td'), load_balancer: [{ target_group_arn: refs('aws_lb_target_group.a') }] } },
  ];
  const dbs = (r: ReturnType<typeof importTerraform>) => r.design.nodes.filter((n) => n.kind === 'database').map((n) => [n.id, n.params?.replicas, n.params?.readFrom]);
  it('#42 a read replica nobody connects to is one of its source DB\'s replicas; reads stay on the primary', () => {
    const r = importTerraform(ecsPlan([pg('main'), replicaOf('ro', 'main'), ...caller('main')]));
    expect(dbs(r)).toEqual([['db_instance_main', 1, 'primary']]);
  });
  it('#42 a replica that callers connect to stays its own node with its own limit', () => {
    const r = importTerraform(ecsPlan([pg('main'), replicaOf('ro', 'main'), ...caller('ro')]));
    expect(dbs(r)).toEqual([['db_instance_main', 0, undefined], ['db_instance_ro', 0, undefined]]);
    expect(r.design.edges.find((e) => e.from === 'ecs_service_s' && e.to === 'db_instance_ro')).toBeDefined();
    expect(r.notes).toContainEqual(expect.objectContaining({ id: 'import.approx.replicaNode', node: 'db_instance_ro' }));
  });
  it('#42 the planned source picks among conditional references; null is no replica', () => {
    const none = importTerraform(ecsPlan([pg('main'), replicaOf('other', null, ['main']), ...caller('main')]));
    expect(dbs(none).map((d) => d[0])).toEqual(['db_instance_main', 'db_instance_other']);
    const picked = importTerraform(ecsPlan([pg('a'), pg('b'), replicaOf('ro', 'b', ['a', 'b']), ...caller('a')]));
    expect(dbs(picked)).toEqual([['db_instance_a', 0, undefined], ['db_instance_b', 1, 'primary']]);
    const unsure = importTerraform(ecsPlan([pg('a'), pg('b'), replicaOf('ro', null, ['a', 'b'], true), ...caller('a')]));
    expect(dbs(unsure).map((d) => d[0])).toContain('db_instance_ro');
  });
  it('#42 a chain main -> r1 -> r2 counts both replicas', () => {
    const r = importTerraform(ecsPlan([pg('main'), replicaOf('r1', 'main'), replicaOf('r2', 'r1'), ...caller('main')]));
    expect(dbs(r)).toEqual([['db_instance_main', 2, 'primary']]);
  });
  it('#42 a replica kept as its own node still counts in the source\'s readReplicas fact', () => {
    const r = importTerraform(ecsPlan([pg('main'), replicaOf('ro', 'main'), ...caller('ro')]));
    expect(r.facts.db_instance_main.readReplicas.value).toBe(1);
  });
  it('#42 more than 15 replicas: 15 and a note; the design stays valid', () => {
    const many = Array.from({ length: 15 }, (_, i) => replicaOf(`r${i}`, 'main'));
    const r = importTerraform(ecsPlan([pg('main'), ...many, replicaOf('deep', 'r0'), ...caller('main')]));
    expect(dbs(r)).toEqual([['db_instance_main', 15, 'primary']]);
    expect(r.notes).toContainEqual(expect.objectContaining({ id: 'import.approx.capped', args: { param: 'replicas', value: 16, max: 15 } }));
    expect(() => parseDesign(r.design)).not.toThrow();
  });
  it('#42 a planned null source gives no replicaOf fact', () => {
    const r = importTerraform(ecsPlan([pg('main'), replicaOf('other', null, ['main']), ...caller('main')]));
    expect(r.facts.db_instance_other?.replicaOf).toBeUndefined();
  });
  it('#42 a planned source that is not the known name of the one reference is outside the plan', () => {
    const r = importTerraform(ecsPlan([pg('main'), replicaOf('ro', 'external-db', ['main']), ...caller('ro')]));
    expect(r.facts.db_instance_main?.readReplicas).toBeUndefined();
    const unknownName = importTerraform(ecsPlan([pg('main', { values: { identifier: undefined }, unknown: ['identifier'] } as Partial<R>), replicaOf('ro', 'from-var', ['main']), ...caller('main')]));
    expect(dbs(unknownName)).toEqual([['db_instance_main', 1, 'primary']]);
  });
  it('#42 a source ARN built from the known identifier is that DB; another region is not', () => {
    const arnOf = (region: string) => replicaOf('ro', `arn:aws:rds:${region}:123456789012:db:main`, ['main']);
    const main = pg('main', { values: { region: 'us-east-1' }, unknown: ['arn', 'id'] } as Partial<R>);
    expect(dbs(importTerraform(ecsPlan([main, arnOf('us-east-1'), ...caller('main')])))).toEqual([['db_instance_main', 1, 'primary']]);
    expect(importTerraform(ecsPlan([main, arnOf('eu-west-1'), ...caller('main')])).facts.db_instance_main?.readReplicas).toBeUndefined();
  });
  it('#42 a known ARN that differs rules the DB out; an exact ARN wins over a same-named DB', () => {
    const src = 'arn:aws:rds:us-east-1:999999999999:db:main';
    const local = pg('main', { values: { arn: 'arn:aws:rds:us-east-1:123456789012:db:main' } } as Partial<R>);
    expect(importTerraform(ecsPlan([local, replicaOf('ro', src, ['main']), ...caller('main')])).facts.db_instance_main?.readReplicas).toBeUndefined();
    const a = pg('a', { values: { identifier: 'main', arn: src } } as Partial<R>);
    const b = pg('b', { values: { identifier: 'main', arn: 'arn:aws:rds:eu-west-1:999999999999:db:main' } } as Partial<R>);
    expect(dbs(importTerraform(ecsPlan([a, b, replicaOf('ro', src, ['a', 'b']), ...caller('a')])))).toEqual([['db_instance_a', 1, 'primary'], ['db_instance_b', 0, undefined]]);
  });
  it('#42 a replica of a DB outside the plan stays a node, with a note', () => {
    const r = importTerraform(ecsPlan([{ address: 'aws_db_instance.ro', values: { instance_class: 'db.t3.medium', replicate_source_db: 'arn:aws:rds:us-east-1:1:db:main' } }]));
    expect(r.facts.db_instance_ro.replicaOf.value).toBe('arn:aws:rds:us-east-1:1:db:main');
    expect(r.notes).toContainEqual(expect.objectContaining({ id: 'import.approx.replicaOutside', node: 'db_instance_ro' }));
  });
});

describe('#3 Route 53 failover pair', () => {
  const rec = (n: string, role: string, lb: string): R => ({ address: `aws_route53_record.${n}`, values: { zone_id: 'Z1', name: 'app.example.com', type: 'A', set_identifier: n, failover_routing_policy: [{ type: role }] }, expressions: { failover_routing_policy: [{}], alias: [{ name: { references: [`${lb}.dns_name`, lb] } }] } });
  const pair = (roles: [string, string]) => plan([
    { address: 'aws_lb.a', values: { internal: false } },
    { address: 'aws_lb.b', values: { internal: false } },
    rec('p', roles[0], 'aws_lb.a'),
    rec('s', roles[1], 'aws_lb.b'),
  ]);
  it('PRIMARY and SECONDARY of one name are one DNS entry; the SECONDARY line has weight 1', () => {
    const r = importTerraform(pair(['PRIMARY', 'SECONDARY']));
    expect(r.design.nodes.filter((n) => n.kind === 'dns').map((n) => n.id)).toEqual(['route53_record_p']);
    expect(r.design.edges.filter((e) => e.from === 'client').map((e) => e.to)).toEqual(['route53_record_p']);
    const w = (to: string) => (r.design.edges.find((e) => e.from === 'route53_record_p' && e.to === to) as { weight?: number } | undefined)?.weight;
    expect([w('lb_a'), w('lb_b')]).toEqual([1000, 1]);
    expect(r.folded.find((f) => f.address === 'aws_route53_record.s')).toMatchObject({ into: 'route53_record_p', why: 'import.folded.failoverSecondary' });
    expect(r.notes.map((n) => n.id)).toContain('import.approx.failoverPair');
  });
  it('the order of the records does not matter', () => {
    const r = importTerraform(plan([
      { address: 'aws_lb.a', values: { internal: false } },
      { address: 'aws_lb.b', values: { internal: false } },
      rec('s', 'SECONDARY', 'aws_lb.b'),
      rec('p', 'PRIMARY', 'aws_lb.a'),
    ]));
    expect(r.design.edges.filter((e) => e.from === 'client').map((e) => e.to)).toEqual(['route53_record_p']);
  });
  it('a SECONDARY with no PRIMARY of the same name stays its own entry', () => {
    const r = importTerraform(pair(['SECONDARY', 'SECONDARY']));
    expect(r.design.nodes.filter((n) => n.kind === 'dns')).toHaveLength(2);
  });
});

describe('#3 failover pairs, harder cases', () => {
  const lbs = ['a', 'b', 'c'].map((k): R => ({ address: `aws_lb.${k}`, values: { internal: false } }));
  const rec = (address: string, role: string, name: string, to: string[], zone: Partial<R> = { values: { zone_id: 'Z1' } }): R => ({
    address,
    values: { ...zone.values, name, type: 'A', failover_routing_policy: [{ type: role }] },
    expressions: { ...zone.expressions, failover_routing_policy: [{}], ...(to.length ? { records: { references: to.flatMap((t) => [`${t}.dns_name`, t]) } } : {}) },
    ...(zone.unknown ? { unknown: zone.unknown } : {}),
  });
  const dns = (r: ReturnType<typeof importTerraform>) => r.design.nodes.filter((n) => n.kind === 'dns').map((n) => n.id).sort();
  const nodeOf = (r: ReturnType<typeof importTerraform>, a: string) => Object.keys(r.nodeFrom).find((id) => r.nodeFrom[id].includes(a))!;
  const weight = (r: ReturnType<typeof importTerraform>, from: string, to: string) => (r.design.edges.find((e) => e.from === from && e.to === to) as { weight?: number } | undefined)?.weight;
  it('records of one block pair by name, each with its own standby; no line is dropped', () => {
    const r = importTerraform(plan([...lbs,
      rec('aws_route53_record.p[0]', 'PRIMARY', 'x.example.com', ['aws_lb.a']), rec('aws_route53_record.p[1]', 'PRIMARY', 'y.example.com', ['aws_lb.a']),
      rec('aws_route53_record.s[0]', 'SECONDARY', 'x.example.com', ['aws_lb.b']), rec('aws_route53_record.s[1]', 'SECONDARY', 'y.example.com', ['aws_lb.c'])]));
    expect(r.notes.filter((n) => n.id === 'import.lineDropped')).toEqual([]);
    expect(dns(r)).toHaveLength(2);
    // One block shares one configuration, so both standbys reference the same targets.
    for (const i of [0, 1]) {
      expect(r.folded.find((f) => f.address === `aws_route53_record.s[${i}]`)?.into).toBe(nodeOf(r, `aws_route53_record.p[${i}]`));
      expect(weight(r, nodeOf(r, `aws_route53_record.p[${i}]`), 'lb_b')).toBe(1);
    }
  });
  it('a SECONDARY with no PRIMARY in a block of paired ones stays its own entry', () => {
    const r = importTerraform(plan([...lbs,
      rec('aws_route53_record.p', 'PRIMARY', 'x.example.com', ['aws_lb.a']),
      rec('aws_route53_record.s[0]', 'SECONDARY', 'x.example.com', ['aws_lb.b']), rec('aws_route53_record.s[1]', 'SECONDARY', 'z.example.com', ['aws_lb.b'])]));
    expect(dns(r)).toEqual([nodeOf(r, 'aws_route53_record.p'), nodeOf(r, 'aws_route53_record.s[1]')].sort());
    expect(nodeOf(r, 'aws_route53_record.s[1]')).toBeDefined();
  });
  it('answer-file lines of a pair get the failover weights', () => {
    const r = importTerraform(plan([...lbs, rec('aws_route53_record.p', 'PRIMARY', 'x.example.com', []), rec('aws_route53_record.s', 'SECONDARY', 'x.example.com', [])]), {
      answers: parseAnswers({ schema: ANSWERS_SCHEMA, edges: [{ from: 'aws_route53_record.p', to: 'aws_lb.a' }, { from: 'aws_route53_record.s', to: 'aws_lb.b' }] }),
    });
    expect([weight(r, 'route53_record_p', 'lb_a'), weight(r, 'route53_record_p', 'lb_b')]).toEqual([1000, 1]);
  });
  it('a target of both records keeps the PRIMARY weight', () => {
    const r = importTerraform(plan([...lbs, rec('aws_route53_record.p', 'PRIMARY', 'x.example.com', ['aws_lb.a', 'aws_lb.b']), rec('aws_route53_record.s', 'SECONDARY', 'x.example.com', ['aws_lb.a', 'aws_lb.c'])]));
    expect(['lb_a', 'lb_b', 'lb_c'].map((t) => weight(r, 'route53_record_p', t))).toEqual([1000, 1000, 1]);
  });
  it('a zone_id that references two zones does not pair', () => {
    const zr = (...zs: string[]): Partial<R> => ({ values: {}, expressions: { zone_id: { references: zs.flatMap((z) => [`${z}.zone_id`, z]) } }, unknown: ['zone_id'] });
    const r = importTerraform(plan([...lbs, { address: 'aws_route53_zone.pub' }, { address: 'aws_route53_zone.priv' },
      rec('aws_route53_record.p', 'PRIMARY', 'x.example.com', ['aws_lb.a'], zr('aws_route53_zone.pub', 'aws_route53_zone.priv')),
      rec('aws_route53_record.s', 'SECONDARY', 'x.example.com', ['aws_lb.b'], zr('aws_route53_zone.pub'))]));
    expect(dns(r)).toEqual(['route53_record_p', 'route53_record_s']);
  });
});

describe('#3 pairing stays fast', () => {
  it('150 failover pairs over 150 zones import fast', () => {
    const rs: R[] = [{ address: 'aws_lb.a', values: { internal: false } }];
    for (let i = 0; i < 150; i++) {
      rs.push({ address: `aws_route53_zone.z[${i}]`, values: { zone_id: `Z${i}` } });
      for (const role of ['PRIMARY', 'SECONDARY']) {
        rs.push({ address: `aws_route53_record.${role.toLowerCase()}[${i}]`, values: { zone_id: `Z${i}`, name: `n${i}.example.com`, type: 'A', failover_routing_policy: [{ type: role }] }, expressions: { zone_id: { references: ['aws_route53_zone.z.zone_id', 'aws_route53_zone.z'] }, failover_routing_policy: [{}], records: { references: ['aws_lb.a.dns_name', 'aws_lb.a'] } } });
      }
    }
    const p = plan(rs);
    let r: ReturnType<typeof importTerraform> | undefined;
    const ms = cpuMs(() => (r = importTerraform(p)));
    // About 40 ms with the index; 1.4 s when every record scanned every record's zones.
    expect(ms).toBeLessThan(500);
    expect(r!.design.nodes.filter((n) => n.kind === 'dns')).toHaveLength(150);
  }, 60_000);
});
