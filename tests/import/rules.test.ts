// Mapping rules for the rest of the resource groups: Lambda, event source mappings,
// SQS, API Gateway, DynamoDB, S3, CloudFront, Route 53, ElastiCache, Aurora, RDS Proxy and Auto
// Scaling groups. Two real plans (scripts/gen-fixtures.sh) against their expected.json; small plans
// for one rule each.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseDesign } from '../../src/core/index.ts';
import { importReport } from '../../src/i18n/importReport.ts';
import { IMPORT_MESSAGE_IDS, importMessage } from '../../src/i18n/importMessages.ts';
import { importTerraform, type ImportResult } from '../../src/import/terraform/index.ts';
import { ANSWERS_SCHEMA, parseAnswers, runChecks } from '../../src/import/terraform/index.ts';
import { simulate } from '../../src/engine/index.ts';
import { design as simDesign, scenario } from '../helpers.ts';
import { plan, refs, type R } from './plan-helper.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const FIXTURES = join(import.meta.dirname, 'fixtures');
const tmp = mkdtempSync(join(tmpdir(), 'loadsketch-rules-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
interface Expected {
  components: { id: string; kind: string; from: string; params?: Record<string, unknown>; facts?: Record<string, unknown> }[];
  lines: { from: string; to: string; kind: string; timeoutMs?: number; through?: string }[];
  notLines: { from: string; to?: string; env?: string }[];
}
const factValues = (r: ImportResult, id: string) => Object.fromEntries(Object.entries(r.facts[id] ?? {}).map(([k, f]) => [k, f.value]));
const node = (r: ImportResult, id: string) => r.design.nodes.find((n) => n.id === id);
const edge = (r: ImportResult, from: string, to: string) => r.design.edges.find((e) => e.from === from && e.to === to);
const cli = (...args: string[]) => spawnSync(process.execPath, [join(ROOT, 'cli', 'loadsketch.ts'), ...args], { encoding: 'utf8', env: { ...process.env, LOADSKETCH_LANG: 'en' } });

describe.each(['lambda-sqs-rds', 'aurora-cache-multiaz'])('the %s fixture', (set) => {
  const planPath = join(FIXTURES, `${set}.plan.json`);
  const r = importTerraform(JSON.parse(readFileSync(planPath, 'utf8')));
  const expected = JSON.parse(readFileSync(join(FIXTURES, `${set}.expected.json`), 'utf8')) as Expected;

  it('makes exactly the components in expected.json, with the same params, facts and resources', () => {
    expect(r.design.nodes.map((n) => n.id).sort()).toEqual(expected.components.map((c) => c.id).sort());
    for (const c of expected.components) {
      expect(node(r, c.id)?.kind, c.id).toBe(c.kind);
      expect(node(r, c.id)?.params ?? {}, c.id).toEqual(c.params ?? {});
      expect(factValues(r, c.id), c.id).toEqual(c.facts ?? {});
      expect(r.nodeFrom[c.id], c.id).toEqual(c.from === 'generated' ? [] : c.from.split(', '));
    }
  });

  it('makes exactly the lines in expected.json, with their kinds, timeouts and proxies', () => {
    const key = (x: { from: string; to: string }) => `${x.from}->${x.to}`;
    const got = r.design.edges.map((e) => ({ from: e.from, to: e.to, kind: r.edges[e.id!].kind, timeoutMs: e.timeoutMs, through: r.edges[e.id!].through })).sort((a, b) => key(a).localeCompare(key(b)));
    const want = expected.lines.map((l) => ({ from: l.from, to: l.to, kind: l.from === 'client' ? 'generated' : l.kind, timeoutMs: l.timeoutMs, through: l.through })).sort((a, b) => key(a).localeCompare(key(b)));
    expect(got).toEqual(want);
    for (const n of expected.notLines) if (n.to) expect(edge(r, n.from, n.to), `${n.from}->${n.to}`).toBeUndefined();
  });

  it('every param has an origin, every aws-default names its source, every resource is accounted for', () => {
    for (const n of r.design.nodes) {
      expect(Object.keys(r.origins[n.id] ?? {}).sort(), n.id).toEqual(Object.keys(n.params ?? {}).sort());
      for (const o of [...Object.values(r.origins[n.id] ?? {}), ...Object.values(r.facts[n.id] ?? {}).map((f) => f.origin)]) {
        if (o.evidence === 'aws-default') expect(o.source, n.id).toMatch(/^https:\/\//);
        if (o.evidence === 'estimate') expect(o.source, n.id).toBeTruthy();
      }
    }
    const all = (JSON.parse(readFileSync(planPath, 'utf8')) as { planned_values: { root_module: { resources: { address: string }[] } } }).planned_values.root_module.resources.map((x) => x.address);
    const seen = new Set([...Object.values(r.nodeFrom).flat(), ...r.folded.map((f) => f.address), ...r.unmapped.map((u) => u.address)]);
    expect(all.filter((a) => !seen.has(a))).toEqual([]);
    expect(r.unmapped).toEqual([]);
    expect(parseDesign(r.design).ok).toBe(true);
  });

  it('`loadsketch validate` returns 0 on what `loadsketch import terraform` writes', () => {
    const out = join(tmp, `${set}.design.json`);
    expect(cli('import', 'terraform', planPath, '--out', out).status).toBe(0);
    const v = cli('validate', out);
    expect(v.status, v.stdout + v.stderr).toBe(0);
  });

  it('the report lists every approximation (and every note has text)', () => {
    const report = importReport(r, []);
    for (const n of r.notes) {
      expect(IMPORT_MESSAGE_IDS, n.id).toContain(n.id);
      if (n.id.startsWith('import.approx.')) expect(report).toContain(importMessage(n.id, n.args));
    }
    expect(r.notes.some((n) => n.id.startsWith('import.approx.'))).toBe(true);
    for (const f of r.folded) expect(IMPORT_MESSAGE_IDS, f.why).toContain(f.why);
  });
});

describe('the lambda-sqs-rds fixture, in detail', () => {
  const r = importTerraform(JSON.parse(readFileSync(join(FIXTURES, 'lambda-sqs-rds.plan.json'), 'utf8')));
  it('Lambda -> RDS is a presumed line from the environment reference', () => {
    const e = edge(r, 'lambda_function_api', 'db_instance_main')!;
    expect(r.edges[e.id!]).toMatchObject({ kind: 'presumed', via: ['aws_lambda_function.api', 'env:environment'] });
    expect(e.source).toMatchObject({ line: 'presumed' });
  });
  it('the DLQ is folded into its source queue; the integration timeout default names its source', () => {
    expect(r.folded.find((f) => f.address === 'aws_sqs_queue.jobs_dlq')).toEqual({ address: 'aws_sqs_queue.jobs_dlq', why: 'import.folded.dlq' });
    const e = edge(r, 'api_gateway_rest_api_main', 'lambda_function_api')!;
    expect(r.edgeOrigins[e.id!].timeoutMs).toMatchObject({ evidence: 'aws-default', from: 'aws_api_gateway_integration.orders_post.timeout_milliseconds' });
    expect(e.source!.params!.timeoutMs).toMatchObject({ evidence: 'aws-default' });
  });
  it('the account concurrency default is an estimate, not an AWS default (quotas get raised)', () => {
    expect(r.origins.lambda_function_api.maxConcurrency).toMatchObject({ evidence: 'estimate' });
    expect(r.origins.lambda_function_worker.maxConcurrency).toEqual({ evidence: 'iac', from: 'aws_lambda_event_source_mapping.jobs_worker.scaling_config.maximum_concurrency' });
  });
});

describe('the aurora-cache-multiaz fixture, in detail', () => {
  const r = importTerraform(JSON.parse(readFileSync(join(FIXTURES, 'aurora-cache-multiaz.plan.json'), 'utf8')));
  it('users enter at Route 53; CloudFront and the ALB are behind it and say so', () => {
    expect(r.design.edges.filter((e) => e.from === 'client').map((e) => e.to)).toEqual(['route53_record_primary']);
    expect(r.notes.filter((n) => n.id === 'import.entryBehind').map((n) => n.node).sort()).toEqual(['cloudfront_distribution_web', 'lb_web']);
  });
  it('the cluster instances and the proxy are folded into the cluster', () => {
    for (const a of ['aws_rds_cluster_instance.main[0]', 'aws_db_proxy.main', 'aws_db_proxy_default_target_group.main']) expect(r.folded.find((f) => f.address === a), a).toMatchObject({ into: 'rds_cluster_main' });
  });
});

// ---- small plans ----
const DB: R = { address: 'aws_db_instance.main', values: { engine: 'postgres', instance_class: 'db.t3.medium', multi_az: true } };
const env = (...targets: string[]) => [{ variables: { references: targets.flatMap((t) => [`${t}.address`, t]) } }];
/** API Gateway (REST) -> a Lambda that reads DB_HOST from the DB. */
function lambdaPlan(fn: Partial<R> = {}, extra: R[] = []) {
  return plan([
    { address: 'aws_api_gateway_rest_api.a' },
    { address: 'aws_api_gateway_integration.i', values: { timeout_milliseconds: 29000 }, expressions: { rest_api_id: refs('aws_api_gateway_rest_api.a'), uri: { references: ['aws_lambda_function.f.invoke_arn', 'aws_lambda_function.f'] } } },
    { address: 'aws_lambda_function.f', values: { timeout: 10, memory_size: 1769, ...fn.values }, expressions: { environment: env('aws_db_instance.main'), timeout: {}, memory_size: {}, ...fn.expressions }, unknown: fn.unknown },
    DB,
    ...extra,
  ]);
}

describe('Lambda', () => {
  it('reserved concurrency is the limit (iac); unset is the account default 1000 (estimate); 0 becomes 1 with a note', () => {
    const lim = (v: number | undefined) => {
      const r = importTerraform(lambdaPlan(v === undefined ? {} : { values: { reserved_concurrent_executions: v }, expressions: { reserved_concurrent_executions: {} } }));
      return { v: node(r, 'lambda_function_f')!.params!.maxConcurrency, o: r.origins.lambda_function_f.maxConcurrency.evidence, notes: r.notes.map((n) => n.id) };
    };
    expect(lim(40)).toMatchObject({ v: 40, o: 'iac' });
    expect(lim(-1)).toMatchObject({ v: 1000, o: 'estimate', notes: expect.arrayContaining(['import.approx.accountConcurrency']) });
    expect(lim(undefined)).toMatchObject({ v: 1000, o: 'estimate' });
    expect(lim(0)).toMatchObject({ v: 1, o: 'iac', notes: expect.arrayContaining(['import.approx.reservedZero']) });
  });

  it('reserved concurrency set from something unknown until apply: left out (not 1000), with a note', () => {
    const r = importTerraform(lambdaPlan({ expressions: { reserved_concurrent_executions: { references: ['var.x'] } }, unknown: ['reserved_concurrent_executions'] }));
    expect(node(r, 'lambda_function_f')!.params!.maxConcurrency).toBeUndefined();
    expect(r.notes).toContainEqual(expect.objectContaining({ id: 'import.unknownValue', args: { from: 'aws_lambda_function.f.reserved_concurrent_executions' } }));
  });

  it('serviceMs comes from memory (an estimate): a full vCPU at 1769 MB, slower below', () => {
    const ms = (mem: number) => node(importTerraform(lambdaPlan({ values: { memory_size: mem } })), 'lambda_function_f')!.params!.serviceMs;
    expect(ms(1769)).toBe(20);
    expect(ms(3538)).toBe(20);
    expect(ms(512)).toBeCloseTo(69.1, 1);
  });

  it('provisioned concurrency configs add up', () => {
    const r = importTerraform(lambdaPlan({}, [{ address: 'aws_lambda_provisioned_concurrency_config.p', values: { provisioned_concurrent_executions: 7 }, expressions: { function_name: refs('aws_lambda_function.f') } }]));
    expect(node(r, 'lambda_function_f')!.params!.provisioned).toBe(7);
    expect(r.folded.find((f) => f.address === 'aws_lambda_provisioned_concurrency_config.p')).toMatchObject({ into: 'lambda_function_f' });
  });

  it('maximum_concurrency becomes the limit only when every caller is an event source mapping', () => {
    const extra: R[] = [
      { address: 'aws_sqs_queue.q', values: { visibility_timeout_seconds: 60 } },
      { address: 'aws_lambda_event_source_mapping.m', values: { scaling_config: [{ maximum_concurrency: 5 }] }, expressions: { event_source_arn: refs('aws_sqs_queue.q'), function_name: refs('aws_lambda_function.f') } },
    ];
    const both = importTerraform(lambdaPlan({}, extra));
    expect(node(both, 'lambda_function_f')!.params!.maxConcurrency).toBe(1000);
    expect(factValues(both, 'lambda_function_f').sourceMaxConcurrency).toBe(5);
    const onlyQueue = importTerraform(plan([extra[0], extra[1], { address: 'aws_lambda_function.f', values: {} }, { address: 'aws_lb.web', values: { internal: false } }]));
    expect(node(onlyQueue, 'lambda_function_f')!.params!.maxConcurrency).toBe(5);
    expect(onlyQueue.notes.map((n) => n.id)).toContain('import.approx.sourceConcurrency');
  });

  it('an SNS permission makes it asynchronous; a DLQ or an on_failure destination is where failures go', () => {
    const perm: R = { address: 'aws_lambda_permission.sns', values: { principal: 'sns.amazonaws.com' }, expressions: { function_name: refs('aws_lambda_function.f') } };
    const f = (fn: Partial<R>, extra: R[] = []) => factValues(importTerraform(lambdaPlan(fn, [perm, ...extra])), 'lambda_function_f');
    expect(f({})).toMatchObject({ asyncInvoked: true, asyncFailureTarget: false, asyncAttempts: 3 });
    expect(f({ values: { dead_letter_config: [{ target_arn: 'arn:aws:sqs:us-east-1:1:dlq' }] } })).toMatchObject({ asyncFailureTarget: true });
    expect(f({}, [{ address: 'aws_lambda_function_event_invoke_config.c', values: { maximum_retry_attempts: 0 }, expressions: { function_name: refs('aws_lambda_function.f'), destination_config: [{ on_failure: [{ destination: refs('aws_sqs_queue.x') }] }] } }])).toMatchObject({ asyncFailureTarget: true, asyncAttempts: 1 });
    // API Gateway only: synchronous, no async facts
    expect(factValues(importTerraform(lambdaPlan()), 'lambda_function_f').asyncInvoked).toBeUndefined();
  });
});

describe('SQS', () => {
  const lb: R = { address: 'aws_lb.web', values: { internal: false } };
  const fn: R = { address: 'aws_lambda_function.w', values: {} };
  const esm: R = { address: 'aws_lambda_event_source_mapping.m', expressions: { event_source_arn: refs('aws_sqs_queue.q'), function_name: refs('aws_lambda_function.w') } };
  const q = (r: ImportResult) => ({ params: node(r, 'sqs_queue_q')!.params, facts: factValues(r, 'sqs_queue_q') });

  it('defaults: at-least-once, no depth limit, 30 s visibility, 4 days, no DLQ (all AWS defaults)', () => {
    const r = importTerraform(plan([lb, fn, esm, { address: 'aws_sqs_queue.q' }]));
    expect(q(r).params).toEqual({ delivery: 'at_least_once', maxDepth: 100_000_000, visibilityTimeoutMs: 30000, messageTtlS: 345600, maxReceives: 0 });
    expect(Object.values(r.origins.sqs_queue_q).every((o) => o.evidence === 'aws-default')).toBe(true);
    expect(q(r).facts).toMatchObject({ redrive: false });
  });

  it('a redrive policy that is unknown until apply: there is a DLQ, maxReceives is left out, a note says so', () => {
    const r = importTerraform(plan([lb, fn, esm, { address: 'aws_sqs_queue.q', expressions: { redrive_policy: { references: ['aws_sqs_queue.d.arn', 'aws_sqs_queue.d'] } }, unknown: ['redrive_policy'] }, { address: 'aws_sqs_queue.d' }]));
    expect(q(r).facts).toMatchObject({ redrive: true });
    expect(q(r).params!.maxReceives).toBeUndefined();
    expect(r.notes).toContainEqual(expect.objectContaining({ id: 'import.unknownValue', args: { from: 'aws_sqs_queue.q.redrive_policy' } }));
    expect(r.folded.find((f) => f.address === 'aws_sqs_queue.d')).toMatchObject({ why: 'import.folded.dlq' });
  });

  it('a separate aws_sqs_queue_redrive_policy counts; FIFO maps to ordering; a DLQ that a function reads stays a node', () => {
    const r = importTerraform(plan([
      lb, fn, esm,
      { address: 'aws_sqs_queue.q', values: { fifo_queue: true } },
      { address: 'aws_sqs_queue_redrive_policy.p', values: { redrive_policy: '{"deadLetterTargetArn":"arn:aws:sqs:us-east-1:1:d","maxReceiveCount":4}' }, expressions: { queue_url: refs('aws_sqs_queue.q'), redrive_policy: { references: ['aws_sqs_queue.d.arn', 'aws_sqs_queue.d'] } } },
      { address: 'aws_sqs_queue.d' },
      { address: 'aws_lambda_event_source_mapping.dm', expressions: { event_source_arn: refs('aws_sqs_queue.d'), function_name: refs('aws_lambda_function.w') } },
    ]));
    expect(q(r).params).toMatchObject({ maxReceives: 4, ordering: 'fifo' });
    expect(node(r, 'sqs_queue_d')).toBeDefined();
  });
});

describe('API Gateway (HTTP API) and DynamoDB', () => {
  const http = (stage: R['values'], extra: R[] = []) => importTerraform(plan([
    { address: 'aws_apigatewayv2_api.h' },
    { address: 'aws_apigatewayv2_stage.s', values: stage, expressions: { api_id: refs('aws_apigatewayv2_api.h'), default_route_settings: stage?.default_route_settings ? [{ throttling_rate_limit: {}, throttling_burst_limit: {} }] : undefined } },
    { address: 'aws_apigatewayv2_integration.i', values: {}, expressions: { api_id: refs('aws_apigatewayv2_api.h'), integration_uri: refs('aws_lambda_function.f') } },
    { address: 'aws_lambda_function.f', values: { timeout: 3 } },
    ...extra,
  ]));
  it('stage throttling is the throttle in front; the integration timeout default is 30 s for HTTP APIs', () => {
    const r = http({ default_route_settings: [{ throttling_rate_limit: 200, throttling_burst_limit: 50 }] });
    expect(node(r, 'apigatewayv2_api_h_throttle')!.params).toEqual({ limit: 'rate', ratePerSec: 200, burst: 50 });
    expect(r.design.edges.filter((e) => e.from === 'client').map((e) => e.to)).toEqual(['apigatewayv2_api_h_throttle']);
    expect(edge(r, 'apigatewayv2_api_h', 'lambda_function_f')!.timeoutMs).toBe(30000);
  });
  it('no throttling set: the account default 10 000 rps, an estimate', () => {
    const r = http({});
    expect(node(r, 'apigatewayv2_api_h_throttle')!.params).toMatchObject({ ratePerSec: 10000, burst: 5000 });
    expect(r.origins.apigatewayv2_api_h_throttle.ratePerSec.evidence).toBe('estimate');
  });
  it('DynamoDB on demand has no throttle in front; provisioned with an autoscaling target says so', () => {
    const lb: R = { address: 'aws_lb.web', values: { internal: false } };
    const od = importTerraform(plan([lb, { address: 'aws_dynamodb_table.t', values: { name: 't', billing_mode: 'PAY_PER_REQUEST' } }]));
    expect(od.design.nodes.map((n) => n.id).sort()).toEqual(['client', 'dynamodb_table_t', 'lb_web']);
    const auto = importTerraform(plan([lb, { address: 'aws_dynamodb_table.t', values: { name: 't', billing_mode: 'PROVISIONED', read_capacity: 5, write_capacity: 5 } }, { address: 'aws_appautoscaling_target.r', values: { service_namespace: 'dynamodb', resource_id: 'table/t' } }]));
    expect(factValues(auto, 'dynamodb_table_t').capacityAutoscaling).toBe(true);
    expect(node(auto, 'dynamodb_table_t_throttle')!.params).toMatchObject({ ratePerSec: 10 });
  });
});

describe('Route 53, CloudFront, ElastiCache', () => {
  const lb: R = { address: 'aws_lb.web', values: { internal: false } };
  it('a record that points at nothing mapped and has no failover is folded; a record to the ALB is a dns entry', () => {
    const r = importTerraform(plan([lb, { address: 'aws_route53_record.txt', values: { type: 'TXT' } }, { address: 'aws_route53_record.app', values: { ttl: 30 }, expressions: { alias: [{ name: { references: ['aws_lb.web.dns_name', 'aws_lb.web'] } }] } }]));
    expect(r.folded.find((f) => f.address === 'aws_route53_record.txt')).toMatchObject({ why: 'import.folded.dnsRecord' });
    expect(node(r, 'route53_record_app')).toMatchObject({ kind: 'dns', params: { ttlS: 30 } });
    expect(r.design.edges.filter((e) => e.from === 'client').map((e) => e.to)).toEqual(['route53_record_app']);
  });
  it('a failover record with a health check that leaves its interval unset: 30 s x 3, AWS defaults', () => {
    const r = importTerraform(plan([lb, { address: 'aws_route53_health_check.h' }, { address: 'aws_route53_record.p', values: { failover_routing_policy: [{ type: 'PRIMARY' }] }, expressions: { failover_routing_policy: [{}], health_check_id: refs('aws_route53_health_check.h'), records: { references: ['aws_lb.web.dns_name', 'aws_lb.web'] } } }]));
    expect(node(r, 'route53_record_p')!.params).toMatchObject({ failover: 'on', detectS: 90 });
    expect(r.origins.route53_record_p.detectS.evidence).toBe('aws-default');
  });
  it('a cache cluster in a replication group is folded into it; a single node is one instance', () => {
    const r = importTerraform(plan([lb, { address: 'aws_elasticache_replication_group.g', values: { node_type: 'cache.t3.micro' } }, { address: 'aws_elasticache_cluster.m', expressions: { replication_group_id: refs('aws_elasticache_replication_group.g') } }]));
    expect(r.folded.find((f) => f.address === 'aws_elasticache_cluster.m')).toMatchObject({ why: 'import.folded.cacheMember' });
    expect(node(r, 'elasticache_replication_group_g')!.params).toMatchObject({ instances: 1 });
    expect(factValues(r, 'elasticache_replication_group_g')).toMatchObject({ numCacheClusters: 1, automaticFailover: false, vcpu: 2 });
  });
});

describe('Aurora, RDS Proxy, Auto Scaling groups', () => {
  const lb: R = { address: 'aws_lb.web', values: { internal: false } };
  it('Aurora with one instance: no replicas, no failover; with none: a note', () => {
    const one = importTerraform(plan([lb, { address: 'aws_rds_cluster.c', values: { engine: 'aurora-postgresql' } }, { address: 'aws_rds_cluster_instance.i', values: { instance_class: 'db.r6g.large' }, expressions: { cluster_identifier: refs('aws_rds_cluster.c') } }]));
    expect(node(one, 'rds_cluster_c')!.params).toMatchObject({ replicas: 0 });
    expect(node(one, 'rds_cluster_c')!.params!.failover).toBeUndefined();
    const none = importTerraform(plan([lb, { address: 'aws_rds_cluster.c', values: { engine: 'aurora-mysql' } }]));
    expect(none.notes.map((n) => n.id)).toContain('import.aurora.noInstances');
  });
  it('Aurora MySQL gets no max_connections (its default is another formula): C1 will say incomplete', () => {
    const r = importTerraform(plan([lb, { address: 'aws_rds_cluster.c', values: { engine: 'aurora-mysql' } }, { address: 'aws_rds_cluster_instance.i', values: { instance_class: 'db.r6g.large' }, expressions: { cluster_identifier: refs('aws_rds_cluster.c') } }]));
    expect(factValues(r, 'rds_cluster_c').maxConnectionsAllMemory).toBeUndefined();
  });
  it('a DB instance behind RDS Proxy: the proxy is a member, its default share is 100% (AWS default)', () => {
    const r = importTerraform(plan([
      lb, DB,
      { address: 'aws_db_proxy.p' },
      { address: 'aws_db_proxy_default_target_group.g', values: {}, expressions: { db_proxy_name: refs('aws_db_proxy.p') } },
      { address: 'aws_db_proxy_target.t', expressions: { db_proxy_name: refs('aws_db_proxy.p'), db_instance_identifier: refs('aws_db_instance.main') } },
    ]));
    expect(r.facts.db_instance_main.proxyMaxConnectionsPercent).toMatchObject({ value: 100, origin: { evidence: 'aws-default' } });
    expect(r.folded.find((f) => f.address === 'aws_db_proxy.p')).toMatchObject({ into: 'db_instance_main' });
  });
  it('an ASG with a CPU target tracking policy autoscales between min and max', () => {
    const r = importTerraform(plan([
      lb,
      { address: 'aws_lb_listener.l', expressions: { load_balancer_arn: refs('aws_lb.web'), default_action: [{ target_group_arn: refs('aws_lb_target_group.t') }] } },
      { address: 'aws_lb_target_group.t', values: {} },
      { address: 'aws_autoscaling_group.a', values: { min_size: 2, max_size: 12, desired_capacity: 3 }, expressions: { target_group_arns: refs('aws_lb_target_group.t'), launch_template: [{ id: refs('aws_launch_template.lt') }] } },
      { address: 'aws_launch_template.lt', values: { instance_type: 'm6i.large' } },
      { address: 'aws_autoscaling_policy.cpu', values: { target_tracking_configuration: [{ target_value: 50, predefined_metric_specification: [{ predefined_metric_type: 'ASGAverageCPUUtilization' }] }] }, expressions: { autoscaling_group_name: refs('aws_autoscaling_group.a') } },
    ]));
    expect(node(r, 'autoscaling_group_a')!.params).toMatchObject({ instances: 3, autoscale: 'on', maxInstances: 12, targetUtil: 0.5, concurrency: 32 });
    expect(factValues(r, 'autoscaling_group_a')).toMatchObject({ minInstances: 2, instanceType: 'm6i.large', vcpu: 2 });
    expect(edge(r, 'lb_web', 'autoscaling_group_a')).toBeDefined();
  });
});

describe('review fixes', () => {
  const lb: R = { address: 'aws_lb.web', values: { internal: false } };
  const fnR = (v: Record<string, unknown> = {}, e: Record<string, unknown> = {}, unknown?: string[]): R => ({ address: 'aws_lambda_function.f', values: { timeout: 10, memory_size: 1769, ...v }, expressions: { timeout: {}, memory_size: {}, ...e }, unknown });
  const answers = (a: object) => parseAnswers({ schema: ANSWERS_SCHEMA, ...a });

  it('an API integration and an event source mapping that target a Lambda alias reach the function', () => {
    const r = importTerraform(plan([
      { address: 'aws_api_gateway_rest_api.a' },
      { address: 'aws_api_gateway_integration.i', values: { timeout_milliseconds: 5000 }, expressions: { rest_api_id: refs('aws_api_gateway_rest_api.a'), timeout_milliseconds: {}, uri: { references: ['aws_lambda_alias.live.invoke_arn', 'aws_lambda_alias.live'] } } },
      { address: 'aws_lambda_alias.live', expressions: { function_name: refs('aws_lambda_function.f') } },
      fnR(),
      { address: 'aws_sqs_queue.q' },
      { address: 'aws_lambda_event_source_mapping.m', values: { scaling_config: [{ maximum_concurrency: 4 }] }, expressions: { event_source_arn: refs('aws_sqs_queue.q'), function_name: refs('aws_lambda_alias.live') } },
    ]));
    expect(edge(r, 'api_gateway_rest_api_a', 'lambda_function_f')?.timeoutMs).toBe(5000);
    expect(edge(r, 'sqs_queue_q', 'lambda_function_f')).toBeDefined();
    expect(factValues(r, 'lambda_function_f').sourceMaxConcurrency).toBe(4);
    expect(r.folded.find((f) => f.address === 'aws_lambda_alias.live')).toMatchObject({ into: 'lambda_function_f' });
  });

  it('cache-aside still works through the throttle in front of a provisioned table (engine: a limiter in front of a store is a store)', () => {
    const d = simDesign(
      [['users', 'client'], ['svc', 'service'], ['c', 'cache', { mode: 'fixed', hitRatio: 1 }], ['lim', 'rate_limiter', { ratePerSec: 1_000_000, burst: 1_000_000 }], ['db', 'database']],
      [['users', 'svc'], ['svc', 'c'], ['svc', 'lim'], ['lim', 'db']],
    );
    const r = simulate(d, scenario({ seed: 1, durationS: 10, warmupS: 0, traffic: { rps: 50, readRatio: 1 } }));
    expect(r.nodes.c.arrivals).toBeGreaterThan(0);
    expect(r.nodes.db.arrivals).toBe(0);
    const w = simulate(d, scenario({ seed: 1, durationS: 10, warmupS: 0, traffic: { rps: 50, readRatio: 0 } }));
    expect(w.nodes.db.arrivals).toBeGreaterThan(0);
  });

  const table: R = { address: 'aws_dynamodb_table.t', values: { name: 't', billing_mode: 'PROVISIONED', read_capacity: 5, write_capacity: 5 }, expressions: { billing_mode: {} } };
  it('an answer-file line to a throttled node goes through its throttle, and is the same line as a presumed one', () => {
    const only = importTerraform(plan([lb, fnR(), table]), { answers: answers({ edges: [{ from: 'lambda_function_f', to: 'dynamodb_table_t' }] }) });
    expect(edge(only, 'lambda_function_f', 'dynamodb_table_t')).toBeUndefined();
    expect(only.edges[edge(only, 'lambda_function_f', 'dynamodb_table_t_throttle')!.id!]).toMatchObject({ kind: 'answer' });
    const both = importTerraform(plan([lb, fnR({}, { environment: [{ variables: { references: ['aws_dynamodb_table.t.name', 'aws_dynamodb_table.t'] } }] }), table]), { answers: answers({ edges: [{ from: 'lambda_function_f', to: 'dynamodb_table_t' }] }) });
    expect(both.design.edges.filter((e) => e.from === 'lambda_function_f').map((e) => e.to)).toEqual(['dynamodb_table_t_throttle']);
    expect(both.edges[edge(both, 'lambda_function_f', 'dynamodb_table_t_throttle')!.id!]).toMatchObject({ kind: 'presumed', confirmed: true });
  });

  const httpToLb = (extra: R[] = []) => plan([
    lb,
    { address: 'aws_lb_listener.l', expressions: { load_balancer_arn: refs('aws_lb.web') } },
    { address: 'aws_apigatewayv2_api.h' },
    { address: 'aws_apigatewayv2_integration.i', values: {}, expressions: { api_id: refs('aws_apigatewayv2_api.h'), integration_uri: refs('aws_lb_listener.l') } },
    ...extra,
  ]);
  it('an entry named in the answer file that has a throttle is wired through the throttle', () => {
    const r = importTerraform(httpToLb(), { answers: answers({ entry: ['apigatewayv2_api_h'] }) });
    expect(r.design.edges.filter((e) => e.from === 'client').map((e) => e.to)).toEqual(['apigatewayv2_api_h_throttle']);
  });
  it('a load balancer behind an API Gateway (with its throttle) is behind an entry: no client line of its own', () => {
    const r = importTerraform(httpToLb());
    expect(edge(r, 'apigatewayv2_api_h', 'lb_web')).toBeDefined();
    expect(r.design.edges.filter((e) => e.from === 'client').map((e) => e.to)).toEqual(['apigatewayv2_api_h_throttle']);
    expect(r.notes.filter((n) => n.id === 'import.entryBehind').map((n) => n.node)).toEqual(['lb_web']);
  });

  it('a Lambda timeout or memory_size set from something unknown until apply is left out, not the AWS default', () => {
    const r = importTerraform(plan([lb, fnR({ timeout: undefined, memory_size: undefined }, { timeout: { references: ['var.t'] }, memory_size: { references: ['var.m'] } }, ['timeout', 'memory_size'])]));
    expect(factValues(r, 'lambda_function_f').timeoutS).toBeUndefined();
    expect(factValues(r, 'lambda_function_f').memoryMiB).toBeUndefined();
    expect(node(r, 'lambda_function_f')!.params!.serviceMs).toBeUndefined();
    expect(r.notes.filter((n) => n.id === 'import.unknownValue').map((n) => n.args!.from).sort()).toEqual(['aws_lambda_function.f.memory_size', 'aws_lambda_function.f.timeout']);
  });

  it('two identical Auto Scaling groups (count = 2) add up their capacity', () => {
    const asg = (i: number): R => ({ address: `aws_autoscaling_group.a[${i}]`, values: { min_size: 2, max_size: 6, desired_capacity: 3 } });
    const r = importTerraform(plan([lb, asg(0), asg(1), { address: 'aws_autoscaling_policy.p', values: {}, expressions: { autoscaling_group_name: refs('aws_autoscaling_group.a') } }]));
    expect(node(r, 'autoscaling_group_a')!.params).toMatchObject({ instances: 6, maxInstances: 12 });
    expect(factValues(r, 'autoscaling_group_a')).toMatchObject({ minInstances: 4, maxSize: 12 });
  });

  const aurora = (inst: Partial<R>, cluster: Partial<R> = {}, extra: R[] = []) => importTerraform(plan([
    lb,
    { address: 'aws_rds_cluster.c', values: { engine: 'aurora-postgresql', ...cluster.values }, expressions: { ...cluster.expressions } },
    { address: 'aws_rds_cluster_instance.i', values: { instance_class: 'db.r6g.large', ...inst.values }, expressions: { cluster_identifier: refs('aws_rds_cluster.c'), ...inst.expressions } },
    ...extra,
  ]));
  it('Aurora: max_connections from the instance parameter group, else the cluster parameter group, else the formula', () => {
    const pg: R = { address: 'aws_db_parameter_group.pg', values: { name: 'custom', parameter: [{ name: 'max_connections', value: '100' }] } };
    const cpg: R = { address: 'aws_rds_cluster_parameter_group.cpg', values: { name: 'ccustom', parameter: [{ name: 'max_connections', value: '200' }] } };
    const byInst = aurora({ values: { db_parameter_group_name: 'custom' }, expressions: { db_parameter_group_name: refs('aws_db_parameter_group.pg') } }, {}, [pg]);
    expect(factValues(byInst, 'rds_cluster_c').maxConnectionsAllMemory).toBe(100);
    const byCluster = aurora({}, { values: { db_cluster_parameter_group_name: 'ccustom' }, expressions: { db_cluster_parameter_group_name: refs('aws_rds_cluster_parameter_group.cpg') } }, [cpg]);
    expect(factValues(byCluster, 'rds_cluster_c').maxConnectionsAllMemory).toBe(200);
    expect(factValues(aurora({}), 'rds_cluster_c').maxConnectionsAllMemory).toBe(1802);
  });

  it('a function that calls the DB directly and through its proxy keeps C2', () => {
    const r = importTerraform(plan([
      lb,
      fnR({ reserved_concurrent_executions: 1000 }, { reserved_concurrent_executions: {}, environment: [{ variables: { references: ['aws_db_instance.main.address', 'aws_db_instance.main', 'aws_db_proxy.p.endpoint', 'aws_db_proxy.p'] } }] }),
      DB,
      { address: 'aws_db_proxy.p' },
      { address: 'aws_db_proxy_target.t', expressions: { db_proxy_name: refs('aws_db_proxy.p'), db_instance_identifier: refs('aws_db_instance.main') } },
    ]));
    expect(r.edges[edge(r, 'lambda_function_f', 'db_instance_main')!.id!].through).toBeUndefined();
    expect(runChecks(r).filter((f) => f.check === 'C2')).toHaveLength(1);
  });

  it('a line to a cache cluster in a replication group ends at the group', () => {
    const r = importTerraform(plan([
      lb,
      fnR({}, { environment: [{ variables: { references: ['aws_elasticache_cluster.m.cache_nodes', 'aws_elasticache_cluster.m'] } }] }),
      { address: 'aws_elasticache_replication_group.g', values: { node_type: 'cache.t3.micro' } },
      { address: 'aws_elasticache_cluster.m', expressions: { replication_group_id: refs('aws_elasticache_replication_group.g') } },
    ]));
    expect(edge(r, 'lambda_function_f', 'elasticache_replication_group_g')).toBeDefined();
  });

  it('SQS visibility 0 and an API Gateway burst of 0 still make a valid design, with a note', () => {
    const r = importTerraform(plan([
      { address: 'aws_apigatewayv2_api.h' },
      { address: 'aws_apigatewayv2_stage.s', values: { default_route_settings: [{ throttling_rate_limit: 0, throttling_burst_limit: 0 }] }, expressions: { api_id: refs('aws_apigatewayv2_api.h'), default_route_settings: [{ throttling_rate_limit: {}, throttling_burst_limit: {} }] } },
      { address: 'aws_sqs_queue.q', values: { visibility_timeout_seconds: 0 }, expressions: { visibility_timeout_seconds: {} } },
    ]));
    expect(parseDesign(r.design).ok).toBe(true);
    expect(node(r, 'sqs_queue_q')!.params!.visibilityTimeoutMs).toBe(1);
    expect(factValues(r, 'sqs_queue_q').visibilityS).toBe(0);
    expect(node(r, 'apigatewayv2_api_h_throttle')!.params).toMatchObject({ ratePerSec: 0, burst: 1 });
    expect(r.notes.map((n) => n.id)).toEqual(expect.arrayContaining(['import.approx.visibilityZero', 'import.approx.burstZero']));
  });
});

describe('review fixes', () => {
  it('an alias with its own on_failure does not hide C7 when the unqualified function has none', () => {
    const lb: R = { address: 'aws_lb.web', values: { internal: false } };
    const cfg = (name: string, target: string, failure: boolean): R => ({ address: `aws_lambda_function_event_invoke_config.${name}`, values: {}, expressions: { function_name: refs(target), ...(failure ? { destination_config: [{ on_failure: [{ destination: refs('aws_sqs_queue.x') }] }] } : {}) } });
    const c7 = (fnFailure: boolean) => runChecks(importTerraform(plan([
      lb,
      { address: 'aws_lambda_function.f', values: { timeout: 3 }, expressions: { timeout: {} } },
      { address: 'aws_lambda_alias.live', expressions: { function_name: refs('aws_lambda_function.f') } },
      cfg('fn', 'aws_lambda_function.f', fnFailure),
      cfg('live', 'aws_lambda_alias.live', true),
    ]))).filter((f) => f.check === 'C7');
    expect(c7(false)).toMatchObject([{ id: 'check.C7.async', node: 'lambda_function_f' }]);
    expect(c7(true)).toEqual([]);
  });
});
