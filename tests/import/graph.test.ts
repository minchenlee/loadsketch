// Resource graph from a Terraform plan. The ECS fixture is a real plan made by
// scripts/gen-fixtures.sh; the small plans below are written in the same shape as `terraform show
// -json` output, one per wiring rule.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGraph, groupInstances, type Line } from '../../src/import/terraform/graph.ts';
import { parsePlan, PlanError } from '../../src/import/terraform/plan.ts';
import { plan, refs, type R } from './plan-helper.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const load = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.plan.json`), 'utf8'));
const pairs = (lines: Line[], kind?: Line['kind']) => lines.filter((l) => !kind || l.kind === kind).map((l) => `${l.from} -> ${l.to}`).sort();


describe('parsePlan', () => {
  it('reads the ECS fixture: every resource, with its configuration', () => {
    const p = parsePlan(load('ecs-rds'));
    expect(p.formatVersion).toBe('1.2');
    expect(p.resources).toHaveLength(16);
    expect(p.byAddress.get('aws_ecs_service.api')!.expressions.task_definition).toBeTruthy();
    expect(p.byAddress.get('aws_ecs_task_definition.api')!.unknown.has('container_definitions')).toBe(true);
  });

  it('drops sensitive values before anything can read them', () => {
    const p = parsePlan(load('ecs-rds'));
    expect(p.byAddress.get('aws_db_instance.main')!.values).not.toHaveProperty('password');
    const q = parsePlan(plan([{ address: 'aws_db_instance.x', values: { password: 'hunter2', nested: { token: 't', keep: 1 }, port: 5432 }, sensitive: { password: true, nested: { token: true } } }]));
    expect(q.resources[0].values).toEqual({ nested: { keep: 1 }, port: 5432 });
  });

  it('rejects input that is not a plan, with a message id', () => {
    const id = (j: unknown) => {
      try {
        parsePlan(j);
      } catch (e) {
        return (e as PlanError).id;
      }
    };
    expect(id([])).toBe('import.plan.notObject');
    expect(id({ planned_values: {} })).toBe('import.plan.noFormatVersion');
    expect(id({ format_version: '2.0', planned_values: {} })).toBe('import.plan.formatVersion');
    expect(id({ format_version: '1.2' })).toBe('import.plan.noPlannedValues');
  });

  it('reads resources inside modules and makes their references absolute', () => {
    const p = parsePlan({
      format_version: '1.2',
      planned_values: { root_module: { child_modules: [{ address: 'module.app', resources: [
        { address: 'module.app.aws_lambda_function.fn', mode: 'managed', type: 'aws_lambda_function', name: 'fn', values: {} },
        { address: 'module.app.aws_sqs_queue.q', mode: 'managed', type: 'aws_sqs_queue', name: 'q', values: {} },
      ] }] } },
      configuration: { root_module: { module_calls: { app: { module: { resources: [
        { address: 'aws_lambda_function.fn', mode: 'managed', type: 'aws_lambda_function', name: 'fn', expressions: { environment: [{ variables: { references: ['aws_sqs_queue.q.url', 'aws_sqs_queue.q', 'var.x'] } }] } },
        { address: 'aws_sqs_queue.q', mode: 'managed', type: 'aws_sqs_queue', name: 'q', expressions: {} },
      ] } } } } },
    });
    expect(pairs(buildGraph(p).lines, 'presumed')).toEqual(['module.app.aws_lambda_function.fn -> module.app.aws_sqs_queue.q']);
  });
});

describe('the ECS fixture graph', () => {
  const g = buildGraph(parsePlan(load('ecs-rds')));
  const line = (from: string, to: string) => g.lines.find((l) => l.from === from && l.to === to);

  it('the ALB -> service line is definite, through the listener and the target group', () => {
    expect(line('aws_lb.web', 'aws_ecs_service.api')).toMatchObject({ kind: 'definite', via: ['aws_lb_listener.https', 'aws_lb_target_group.api', 'aws_ecs_service.api'] });
  });

  it('the service -> DB line is presumed (DB_HOST references aws_db_instance.main), and the DB security group agrees', () => {
    const l = line('aws_ecs_service.api', 'aws_db_instance.main')!;
    expect(l.kind).toBe('presumed');
    expect(l.via).toEqual(['aws_ecs_task_definition.api', 'env:container_definitions']);
    expect(l.agrees).toEqual(['aws_security_group.db.ingress']);
    expect(line('aws_lb.web', 'aws_ecs_service.api')!.agrees).toEqual(['aws_security_group.app.ingress']);
  });

  it('these are all the lines: the fixed string and the outside variable add none, and there are no candidates', () => {
    expect(pairs(g.lines)).toEqual(['aws_ecs_service.api -> aws_db_instance.main', 'aws_lb.web -> aws_ecs_service.api']);
    expect(g.lines.some((l) => l.from === 'aws_ecs_task_definition.api')).toBe(false);
  });

  it('knows which resources sit in which security group', () => {
    expect(g.members.get('aws_security_group.app')).toEqual(['aws_ecs_service.api']);
    expect(g.members.get('aws_security_group.db')).toEqual(['aws_db_instance.main']);
    expect(g.members.get('aws_security_group.alb')).toEqual(['aws_lb.web']);
  });
});

describe('definite lines from explicit wiring', () => {
  it('SQS -> Lambda through an event source mapping', () => {
    const g = buildGraph(parsePlan(plan([
      { address: 'aws_sqs_queue.jobs' },
      { address: 'aws_lambda_function.worker' },
      { address: 'aws_lambda_event_source_mapping.jobs', expressions: { event_source_arn: refs('aws_sqs_queue.jobs'), function_name: refs('aws_lambda_function.worker') } },
    ])));
    expect(g.lines).toEqual([{ from: 'aws_sqs_queue.jobs', to: 'aws_lambda_function.worker', kind: 'definite', via: ['aws_lambda_event_source_mapping.jobs'] }]);
  });

  it('API Gateway (HTTP and REST) -> Lambda, and HTTP API -> a listener means its load balancer', () => {
    const g = buildGraph(parsePlan(plan([
      { address: 'aws_apigatewayv2_api.http' },
      { address: 'aws_api_gateway_rest_api.rest' },
      { address: 'aws_lambda_function.fn' },
      { address: 'aws_lb.internal' },
      { address: 'aws_lb_listener.internal', expressions: { load_balancer_arn: refs('aws_lb.internal') } },
      { address: 'aws_apigatewayv2_integration.fn', expressions: { api_id: refs('aws_apigatewayv2_api.http'), integration_uri: { references: ['aws_lambda_function.fn.invoke_arn', 'aws_lambda_function.fn'] } } },
      { address: 'aws_apigatewayv2_integration.lb', expressions: { api_id: refs('aws_apigatewayv2_api.http'), integration_uri: refs('aws_lb_listener.internal') } },
      { address: 'aws_api_gateway_integration.fn', expressions: { rest_api_id: refs('aws_api_gateway_rest_api.rest'), uri: { references: ['aws_lambda_function.fn.invoke_arn', 'aws_lambda_function.fn'] } } },
    ])));
    expect(pairs(g.lines, 'definite')).toEqual([
      'aws_api_gateway_rest_api.rest -> aws_lambda_function.fn',
      'aws_apigatewayv2_api.http -> aws_lambda_function.fn',
      'aws_apigatewayv2_api.http -> aws_lb.internal',
    ]);
  });

  it('CloudFront -> its origins (an ALB and an S3 bucket)', () => {
    const g = buildGraph(parsePlan(plan([
      { address: 'aws_cloudfront_distribution.cdn', expressions: { origin: [{ domain_name: { references: ['aws_lb.web.dns_name', 'aws_lb.web'] } }, { domain_name: { references: ['aws_s3_bucket.assets.bucket_regional_domain_name', 'aws_s3_bucket.assets'] } }], origin_access_control_id: { references: [] } } },
      { address: 'aws_lb.web' },
      { address: 'aws_s3_bucket.assets' },
    ])));
    expect(pairs(g.lines, 'definite')).toEqual(['aws_cloudfront_distribution.cdn -> aws_lb.web', 'aws_cloudfront_distribution.cdn -> aws_s3_bucket.assets']);
  });

  it('ALB -> an autoscaling group and -> attached instances', () => {
    const g = buildGraph(parsePlan(plan([
      { address: 'aws_lb.web' },
      { address: 'aws_lb_target_group.a' },
      { address: 'aws_lb_target_group.b' },
      { address: 'aws_lb_listener.l', expressions: { load_balancer_arn: refs('aws_lb.web'), default_action: [{ target_group_arn: refs('aws_lb_target_group.a') }] } },
      { address: 'aws_lb_listener_rule.r', expressions: { listener_arn: refs('aws_lb_listener.l'), action: [{ target_group_arn: refs('aws_lb_target_group.b') }] } },
      { address: 'aws_autoscaling_group.web', expressions: { target_group_arns: refs('aws_lb_target_group.a') } },
      { address: 'aws_instance.legacy' },
      { address: 'aws_lb_target_group_attachment.legacy', expressions: { target_group_arn: refs('aws_lb_target_group.b'), target_id: refs('aws_instance.legacy') } },
    ])));
    expect(pairs(g.lines, 'definite')).toEqual(['aws_lb.web -> aws_autoscaling_group.web', 'aws_lb.web -> aws_instance.legacy']);
  });
});

describe('presumed lines from environment variables', () => {
  it('a Lambda environment that references a queue and a table is presumed; constants, variables and infrastructure are not', () => {
    const g = buildGraph(parsePlan(plan([
      { address: 'aws_lambda_function.api', expressions: { environment: [{ variables: { references: ['aws_sqs_queue.out.url', 'aws_sqs_queue.out', 'aws_dynamodb_table.t.name', 'aws_dynamodb_table.t', 'var.region', 'local.stage', 'data.aws_caller_identity.me.account_id', 'aws_iam_role.r.arn', 'aws_iam_role.r'] } }], role: refs('aws_iam_role.r') } },
      { address: 'aws_lambda_function.static', expressions: { environment: [{ variables: { constant_value: { MODE: 'prod', HOST: 'db.internal' } } }] } },
      { address: 'aws_sqs_queue.out' },
      { address: 'aws_dynamodb_table.t' },
      { address: 'aws_iam_role.r' },
    ])));
    expect(pairs(g.lines)).toEqual(['aws_lambda_function.api -> aws_dynamodb_table.t', 'aws_lambda_function.api -> aws_sqs_queue.out']);
    expect(g.lines.every((l) => l.kind === 'presumed')).toBe(true);
  });

  it('a task definition no service runs is its own caller', () => {
    const g = buildGraph(parsePlan(plan([
      { address: 'aws_ecs_task_definition.batch', expressions: { container_definitions: { references: ['aws_db_instance.main.address', 'aws_db_instance.main'] } } },
      { address: 'aws_db_instance.main' },
    ])));
    expect(pairs(g.lines, 'presumed')).toEqual(['aws_ecs_task_definition.batch -> aws_db_instance.main']);
  });

  it('an explicit line wins over a presumed one for the same pair', () => {
    const g = buildGraph(parsePlan(plan([
      { address: 'aws_sqs_queue.jobs' },
      { address: 'aws_lambda_function.worker', expressions: { environment: [{ variables: { references: ['aws_sqs_queue.jobs.url', 'aws_sqs_queue.jobs'] } }] } },
      { address: 'aws_lambda_event_source_mapping.jobs', expressions: { event_source_arn: refs('aws_sqs_queue.jobs'), function_name: refs('aws_lambda_function.worker') } },
    ])));
    expect(g.lines.map((l) => [l.from, l.to, l.kind])).toEqual([
      ['aws_sqs_queue.jobs', 'aws_lambda_function.worker', 'definite'],
      ['aws_lambda_function.worker', 'aws_sqs_queue.jobs', 'presumed'],
    ]);
  });
});

describe('candidate lines from security groups only', () => {
  const sgPlan = (rule: R[]) => plan([
    { address: 'aws_security_group.worker' },
    { address: 'aws_security_group.db', expressions: rule.length ? {} : { ingress: { references: ['aws_security_group.worker.id', 'aws_security_group.worker'] } } },
    { address: 'aws_ecs_service.worker', expressions: { network_configuration: [{ security_groups: { references: ['aws_security_group.worker.id', 'aws_security_group.worker'] } }] } },
    { address: 'aws_db_instance.main', expressions: { vpc_security_group_ids: { references: ['aws_security_group.db.id', 'aws_security_group.db'] } } },
    ...rule,
  ]);

  it('an inline ingress rule, a security_group_rule and a vpc ingress rule each give a candidate line', () => {
    for (const p of [
      sgPlan([]),
      sgPlan([{ address: 'aws_security_group_rule.in', values: { type: 'ingress' }, expressions: { security_group_id: { references: ['aws_security_group.db.id'] }, source_security_group_id: { references: ['aws_security_group.worker.id'] } } }]),
      sgPlan([{ address: 'aws_vpc_security_group_ingress_rule.in', expressions: { security_group_id: { references: ['aws_security_group.db.id'] }, referenced_security_group_id: { references: ['aws_security_group.worker.id'] } } }]),
    ]) {
      const g = buildGraph(parsePlan(p));
      expect(g.lines.map((l) => [l.from, l.to, l.kind])).toEqual([['aws_ecs_service.worker', 'aws_db_instance.main', 'candidate']]);
    }
  });

  it('an egress rule gives no line', () => {
    const g = buildGraph(parsePlan(sgPlan([{ address: 'aws_security_group_rule.out', values: { type: 'egress' }, expressions: { security_group_id: { references: ['aws_security_group.db.id'] }, source_security_group_id: { references: ['aws_security_group.worker.id'] } } }])));
    expect(g.lines).toEqual([]);
  });
});

describe('review fixes', () => {
  it('drops literals from expressions (a password written in the .tf file), keeping references', () => {
    const p = parsePlan(plan([{ address: 'aws_db_instance.x', values: { port: 5432 }, sensitive: { password: true }, expressions: { password: { constant_value: 'hunter2-literal' }, db_subnet_group_name: { references: ['aws_db_subnet_group.g.name', 'aws_db_subnet_group.g'] }, tags: { constant_value: { a: 'b' } } } }]));
    expect(JSON.stringify(p)).not.toContain('hunter2-literal');
    expect(p.resources[0].expressions).toEqual({ password: {}, db_subnet_group_name: { references: ['aws_db_subnet_group.g.name', 'aws_db_subnet_group.g'] }, tags: {} });
  });

  it('an indexed reference points at that instance only, not every sibling', () => {
    const g = buildGraph(parsePlan(plan([
      { address: 'aws_db_instance.target[0]' },
      { address: 'aws_db_instance.target[1]' },
      { address: 'aws_lambda_function.fn', expressions: { environment: [{ variables: { references: ['aws_db_instance.target[0].address', 'aws_db_instance.target[0]', 'aws_db_instance.target'] } }] } },
      { address: 'aws_lambda_function.all', expressions: { environment: [{ variables: { references: ['aws_db_instance.target'] } }] } },
    ])));
    expect(pairs(g.lines)).toEqual(['aws_lambda_function.all -> aws_db_instance.target[0]', 'aws_lambda_function.all -> aws_db_instance.target[1]', 'aws_lambda_function.fn -> aws_db_instance.target[0]']);
  });

  it('a splat next to an indexed reference still reaches every instance (lists as Terraform 1.17.1 writes them)', () => {
    const t = ['aws_db_instance.t[0]', 'aws_db_instance.t[1]', 'aws_db_instance.t[2]'].map((address) => ({ address }));
    const g = (list: string[]) => pairs(buildGraph(parsePlan(plan([...t, { address: 'aws_lambda_function.fn', expressions: { environment: [{ variables: { references: list } }] } }]))).lines);
    const all = ['aws_lambda_function.fn -> aws_db_instance.t[0]', 'aws_lambda_function.fn -> aws_db_instance.t[1]', 'aws_lambda_function.fn -> aws_db_instance.t[2]'];
    // { one = t[0].url, all = join(",", t[*].url) } and the same in the other order.
    expect(g(['aws_db_instance.t[0].url', 'aws_db_instance.t[0]', 'aws_db_instance.t', 'aws_db_instance.t'])).toEqual(all);
    expect(g(['aws_db_instance.t', 'aws_db_instance.t[1].url', 'aws_db_instance.t[1]', 'aws_db_instance.t'])).toEqual(all);
    expect(g(['aws_db_instance.t[0].url', 'aws_db_instance.t[0]', 'aws_db_instance.t', 'aws_db_instance.t[2].url', 'aws_db_instance.t[2]', 'aws_db_instance.t'])).toEqual([all[0], all[2]]);
  });

  it('a for_each module key with a dot in it (module.app["prod.us"])', () => {
    const r = (a: string, type: string, name: string) => ({ address: a, mode: 'managed', type, name, values: {} });
    const p = parsePlan({
      format_version: '1.2',
      planned_values: { root_module: { child_modules: ['"prod.us"', '"dev"'].map((k) => ({ address: `module.app[${k}]`, resources: [r(`module.app[${k}].aws_lambda_function.fn`, 'aws_lambda_function', 'fn'), r(`module.app[${k}].aws_db_instance.db`, 'aws_db_instance', 'db')] })) } },
      configuration: { root_module: { module_calls: { app: { module: { resources: [
        { address: 'aws_lambda_function.fn', mode: 'managed', type: 'aws_lambda_function', name: 'fn', expressions: { environment: [{ variables: { references: ['aws_db_instance.db.address', 'aws_db_instance.db'] } }] } },
        { address: 'aws_db_instance.db', mode: 'managed', type: 'aws_db_instance', name: 'db', expressions: {} },
      ] } } } } },
    });
    expect(pairs(buildGraph(p).lines)).toEqual(['module.app["dev"].aws_lambda_function.fn -> module.app["dev"].aws_db_instance.db', 'module.app["prod.us"].aws_lambda_function.fn -> module.app["prod.us"].aws_db_instance.db']);
  });

  it('quoted keys may hold a bracket, a dot or an escaped quote', () => {
    for (const key of ['["prod]us"]', '["a.b"]', '["say \\"hi\\""]']) {
      const db = `aws_db_instance.db${key}`;
      const g = buildGraph(parsePlan(plan([
        { address: db },
        { address: 'aws_db_instance.db["other"]' },
        { address: 'aws_lambda_function.fn', expressions: { environment: [{ variables: { references: [`${db}.address`, db, 'aws_db_instance.db'] } }] } },
      ])));
      expect(pairs(g.lines), key).toEqual([`aws_lambda_function.fn -> ${db}`]);
    }
  });

  it('a resource in module.app[0] reaches its own module instance only', () => {
    const r = (a: string, type: string, name: string) => ({ address: a, mode: 'managed', type, name, values: {} });
    const p = parsePlan({
      format_version: '1.2',
      planned_values: { root_module: { child_modules: ['0', '1'].map((k) => ({ address: `module.app[${k}]`, resources: [r(`module.app[${k}].aws_lambda_function.fn`, 'aws_lambda_function', 'fn'), r(`module.app[${k}].aws_db_instance.db`, 'aws_db_instance', 'db')] })) } },
      configuration: { root_module: { module_calls: { app: { module: { resources: [
        { address: 'aws_lambda_function.fn', mode: 'managed', type: 'aws_lambda_function', name: 'fn', expressions: { environment: [{ variables: { references: ['aws_db_instance.db.address', 'aws_db_instance.db'] } }] } },
        { address: 'aws_db_instance.db', mode: 'managed', type: 'aws_db_instance', name: 'db', expressions: {} },
      ] } } } } },
    });
    expect(pairs(buildGraph(p).lines)).toEqual(['module.app[0].aws_lambda_function.fn -> module.app[0].aws_db_instance.db', 'module.app[1].aws_lambda_function.fn -> module.app[1].aws_db_instance.db']);
  });

  it('CloudFront goes only where domain_name points, not to what a header uses', () => {
    const g = buildGraph(parsePlan(plan([
      { address: 'aws_cloudfront_distribution.cdn', expressions: { origin: [{ domain_name: { references: ['aws_lb.web.dns_name', 'aws_lb.web'] }, custom_header: [{ value: { references: ['aws_ssm_parameter.header.value', 'aws_ssm_parameter.header'] } }], origin_access_control_id: { references: ['aws_s3_bucket.logs.id', 'aws_s3_bucket.logs'] } }] } },
      { address: 'aws_lb.web' },
      { address: 'aws_ssm_parameter.header' },
      { address: 'aws_s3_bucket.logs' },
    ])));
    expect(pairs(g.lines)).toEqual(['aws_cloudfront_distribution.cdn -> aws_lb.web']);
  });

  it('a writer and a read replica of one count block do not merge', () => {
    const p = plan([
      { address: 'aws_db_instance.db[0]', values: { instance_class: 'db.r6g.large', engine: 'postgres', availability_zone: 'us-east-1a', replicate_source_db: null } },
      { address: 'aws_db_instance.db[1]', values: { instance_class: 'db.r6g.large', engine: 'postgres', availability_zone: 'us-east-1a' } },
      { address: 'aws_db_instance.db[2]', values: { instance_class: 'db.r6g.large', engine: 'postgres', availability_zone: 'us-east-1a' } },
    ]);
    (p as { resource_changes: unknown[] }).resource_changes = ['1', '2'].map((k) => ({ address: `aws_db_instance.db[${k}]`, change: { after_unknown: { replicate_source_db: true } } }));
    const groups = groupInstances(buildGraph(parsePlan(p))).map((x) => x.addresses);
    // Databases never merge: the replicas are two nodes too.
    expect(groups).toEqual([['aws_db_instance.db[0]'], ['aws_db_instance.db[1]'], ['aws_db_instance.db[2]']]);
  });
});

describe('instances are merged only when they are the same (Q14)', () => {
  it('count instances in one zone merge; another zone, another size or another block stays apart', () => {
    const g = buildGraph(parsePlan(plan([
      { address: 'aws_instance.web[0]', values: { availability_zone: 'us-east-1a', instance_type: 't3.large' } },
      { address: 'aws_instance.web[1]', values: { availability_zone: 'us-east-1a', instance_type: 't3.large' } },
      { address: 'aws_instance.web[2]', values: { availability_zone: 'us-east-1b', instance_type: 't3.large' } },
      { address: 'aws_instance.web[3]', values: { availability_zone: 'us-east-1a', instance_type: 'm5.xlarge' } },
      { address: 'aws_instance.api[0]', values: { availability_zone: 'us-east-1a', instance_type: 't3.large' } },
    ])));
    const groups = groupInstances(g).map((x) => x.addresses);
    expect(groups).toEqual([['aws_instance.web[0]', 'aws_instance.web[1]'], ['aws_instance.web[2]'], ['aws_instance.web[3]'], ['aws_instance.api[0]']]);
  });

  it('the zone can come from the subnet; different lines keep instances apart', () => {
    const g = buildGraph(parsePlan(plan([
      { address: 'aws_subnet.a', values: { availability_zone: 'us-east-1a' } },
      { address: 'aws_subnet.b', values: { availability_zone: 'us-east-1b' } },
      { address: 'aws_db_instance.primary', values: { instance_class: 'db.r6g.large' }, expressions: { db_subnet_group_name: { references: [] }, subnet_id: { references: ['aws_subnet.a.id', 'aws_subnet.a'] } } },
      { address: 'aws_db_instance.replica', values: { instance_class: 'db.r6g.large' }, expressions: { subnet_id: { references: ['aws_subnet.b.id', 'aws_subnet.b'] } } },
      { address: 'aws_lambda_function.fn[0]', expressions: { environment: [{ variables: { references: ['aws_db_instance.primary.address', 'aws_db_instance.primary'] } }] } },
    ])));
    const groups = groupInstances(g);
    expect(groups.find((x) => x.addresses.includes('aws_db_instance.primary'))!.key).toContain('us-east-1a');
    expect(groups.find((x) => x.addresses.includes('aws_db_instance.replica'))!.key).toContain('us-east-1b');
    expect(groups.filter((x) => x.addresses.some((a) => a.startsWith('aws_db_instance.')))).toHaveLength(2);
  });
});
