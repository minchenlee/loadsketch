// M29b #24–#29: a value written in the configuration but not in the plan (unknown until apply, or
// sensitive) is not iac. The AWS default stands in for it as an estimate, with a note.
import { describe, expect, it } from 'vitest';
import { ANSWERS_SCHEMA, importTerraform, parseAnswers, type ImportResult } from '../../src/import/terraform/index.ts';
import { IMPORT_MESSAGE_IDS } from '../../src/i18n/importMessages.ts';
import { plan, refs, type R } from './plan-helper.ts';

const lb: R = { address: 'aws_lb.web', values: { internal: false } };
const VAR = { references: ['var.x'] };
const notes = (r: ImportResult, id: string) => r.notes.filter((n) => n.id === id).map((n) => n.args!.from);

describe('a value that is written but not in the plan', () => {
  it('#24 API Gateway integration timeout_milliseconds: the edge timeout is an estimate', () => {
    const r = importTerraform(plan([
      { address: 'aws_apigatewayv2_api.h' },
      { address: 'aws_apigatewayv2_stage.s', values: {}, expressions: { api_id: refs('aws_apigatewayv2_api.h') } },
      { address: 'aws_apigatewayv2_integration.i', values: {}, expressions: { api_id: refs('aws_apigatewayv2_api.h'), integration_uri: refs('aws_lambda_function.f'), timeout_milliseconds: VAR }, unknown: ['timeout_milliseconds'] },
      { address: 'aws_lambda_function.f', values: { timeout: 3 } },
    ]));
    const e = Object.entries(r.edgeOrigins).find(([k]) => k.includes('lambda_function_f'))!;
    expect(e[1].timeoutMs).toMatchObject({ evidence: 'estimate', unknown: 'apply', from: 'aws_apigatewayv2_integration.i.timeout_milliseconds' });
    expect(notes(r, 'import.unknownValue.default')).toEqual(['aws_apigatewayv2_integration.i.timeout_milliseconds']);
  });

  it('#25 SQS visibility and retention: estimates, one note each', () => {
    const r = importTerraform(plan([
      lb,
      { address: 'aws_lambda_function.w', values: {} },
      { address: 'aws_lambda_event_source_mapping.m', expressions: { event_source_arn: refs('aws_sqs_queue.q'), function_name: refs('aws_lambda_function.w') } },
      { address: 'aws_sqs_queue.q', values: {}, expressions: { visibility_timeout_seconds: VAR, message_retention_seconds: VAR }, unknown: ['visibility_timeout_seconds', 'message_retention_seconds'] },
    ]));
    expect(r.origins.sqs_queue_q.visibilityTimeoutMs).toMatchObject({ evidence: 'estimate', unknown: 'apply' });
    expect(r.origins.sqs_queue_q.messageTtlS).toMatchObject({ evidence: 'estimate', unknown: 'apply' });
    expect(notes(r, 'import.unknownValue.default').sort()).toEqual(['aws_sqs_queue.q.message_retention_seconds', 'aws_sqs_queue.q.visibility_timeout_seconds']);
  });

  it('#26 Route 53 request_interval: the fact and the detect time are estimates', () => {
    const r = importTerraform(plan([
      lb,
      { address: 'aws_route53_health_check.h', values: { failure_threshold: 3 }, expressions: { request_interval: VAR, failure_threshold: {} }, unknown: ['request_interval'] },
      { address: 'aws_route53_record.p', values: { failover_routing_policy: [{ type: 'PRIMARY' }] }, expressions: { failover_routing_policy: [{}], health_check_id: refs('aws_route53_health_check.h'), records: { references: ['aws_lb.web.dns_name', 'aws_lb.web'] } } },
    ]));
    expect(r.facts.route53_record_p.requestInterval.origin).toMatchObject({ evidence: 'estimate', unknown: 'apply' });
    expect(r.origins.route53_record_p.detectS.evidence).toBe('estimate');
    expect(notes(r, 'import.unknownValue.default')).toEqual(['aws_route53_health_check.h.request_interval']);
  });

  it('#27 ElastiCache num_cache_clusters and automatic_failover_enabled (sensitive): estimates', () => {
    const r = importTerraform(plan([
      lb,
      { address: 'aws_elasticache_replication_group.g', values: { node_type: 'cache.t3.micro' }, expressions: { num_cache_clusters: VAR, automatic_failover_enabled: VAR }, unknown: ['num_cache_clusters'] },
    ]));
    expect(r.origins.elasticache_replication_group_g.instances).toMatchObject({ evidence: 'estimate', unknown: 'apply' });
    expect(r.facts.elasticache_replication_group_g.automaticFailover.origin).toMatchObject({ evidence: 'estimate', unknown: 'sensitive' });
    expect(notes(r, 'import.unknownValue.default')).toEqual(['aws_elasticache_replication_group.g.num_cache_clusters']);
    expect(notes(r, 'import.sensitiveValue.default')).toEqual(['aws_elasticache_replication_group.g.automatic_failover_enabled']);
  });

  it('#28 RDS Proxy max_connections_percent inside a block: an estimate', () => {
    const r = importTerraform(plan([
      lb,
      { address: 'aws_db_instance.main', values: { engine: 'postgres', instance_class: 'db.t3.medium' } },
      { address: 'aws_db_proxy.p' },
      { address: 'aws_db_proxy_default_target_group.g', values: { connection_pool_config: [{}] }, expressions: { db_proxy_name: refs('aws_db_proxy.p'), connection_pool_config: [{ max_connections_percent: VAR }] }, unknown: ['connection_pool_config.max_connections_percent'] },
      { address: 'aws_db_proxy_target.t', expressions: { db_proxy_name: refs('aws_db_proxy.p'), db_instance_identifier: refs('aws_db_instance.main') } },
    ]));
    expect(r.facts.db_instance_main.proxyMaxConnectionsPercent).toMatchObject({ value: 100, origin: { evidence: 'estimate', unknown: 'apply' } });
    expect(notes(r, 'import.unknownValue.default')).toEqual(['aws_db_proxy_default_target_group.g.connection_pool_config.max_connections_percent']);
  });

  it('#29 DynamoDB billing_mode: an estimate', () => {
    const r = importTerraform(plan([lb, { address: 'aws_dynamodb_table.t', values: { name: 't' }, expressions: { billing_mode: VAR }, unknown: ['billing_mode'] }]));
    expect(r.facts.dynamodb_table_t.billingMode.origin).toMatchObject({ evidence: 'estimate', unknown: 'apply' });
    expect(notes(r, 'import.unknownValue.default')).toContain('aws_dynamodb_table.t.billing_mode');
  });

  it('a written literal is still iac, with no note', () => {
    const lit = importTerraform(plan([lb, { address: 'aws_dynamodb_table.t', values: { name: 't', billing_mode: 'PAY_PER_REQUEST' }, expressions: { billing_mode: {} } }]));
    expect(lit.facts.dynamodb_table_t.billingMode.origin.evidence).toBe('iac');
    expect(lit.notes.filter((n) => n.id.endsWith('.default'))).toEqual([]);
  });
  it('an answer for the param replaces the stand-in and its note', () => {
    const r = importTerraform(plan([
      lb,
      { address: 'aws_lambda_function.w', values: {} },
      { address: 'aws_lambda_event_source_mapping.m', expressions: { event_source_arn: refs('aws_sqs_queue.q'), function_name: refs('aws_lambda_function.w') } },
      { address: 'aws_sqs_queue.q', values: {}, expressions: { visibility_timeout_seconds: VAR }, unknown: ['visibility_timeout_seconds'] },
    ]), { answers: parseAnswers({ schema: ANSWERS_SCHEMA, nodes: { 'aws_sqs_queue.q': { visibilityTimeoutMs: 60000 } } }) });
    expect(r.origins.sqs_queue_q.visibilityTimeoutMs.evidence).toBe('answer');
    // The fact C5 reads is replaced too (#45), so no value is left standing in: no note.
    expect(r.facts.sqs_queue_q.visibilityS).toMatchObject({ value: 60, origin: { evidence: 'answer' } });
    expect(notes(r, 'import.unknownValue.default')).toEqual([]);
  });

  it('the messages exist', () => {
    for (const id of ['import.unknownValue.default', 'import.sensitiveValue.default']) expect(IMPORT_MESSAGE_IDS).toContain(id);
  });
});
