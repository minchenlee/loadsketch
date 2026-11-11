// M29b #6 #7 #45: answer-file names and values.
// #6: a resource folded into a node (RDS Proxy, cache cluster) names that node.
// #7: a resource the answer file names is not folded away (a DLQ with no consumer, a DNS record).
// #45: an answer for a param the checks read as a fact replaces the fact too.
import { describe, expect, it } from 'vitest';
import { ANSWERS_SCHEMA, importTerraform, parseAnswers, runChecks, type Answers } from '../../src/import/terraform/index.ts';
import { ecsPlan, plan, refs, type R } from './plan-helper.ts';

const ans = (a: Omit<Answers, 'schema'>) => parseAnswers({ schema: ANSWERS_SCHEMA, ...a });
const lb: R = { address: 'aws_lb.web', values: { internal: false } };

describe('answer-file names', () => {
  it('#6 an RDS Proxy address names the DB node it is folded into', () => {
    const p = plan([
      lb,
      { address: 'aws_db_instance.main', values: { engine: 'postgres', instance_class: 'db.t3.medium' } },
      { address: 'aws_db_proxy.p' },
      { address: 'aws_db_proxy_default_target_group.g', values: {}, expressions: { db_proxy_name: refs('aws_db_proxy.p') } },
      { address: 'aws_db_proxy_target.t', expressions: { db_proxy_name: refs('aws_db_proxy.p'), db_instance_identifier: refs('aws_db_instance.main') } },
    ]);
    const r = importTerraform(p, { answers: ans({ edges: [{ from: 'aws_lb.web', to: 'aws_db_proxy.p' }] }) });
    expect(r.design.edges.find((e) => e.from === 'lb_web' && e.to === 'db_instance_main')).toBeDefined();
  });
  it('an answer line to the RDS Proxy goes through it', () => {
    const p = plan([
      lb,
      { address: 'aws_db_instance.main', values: { engine: 'postgres', instance_class: 'db.t3.medium' } },
      { address: 'aws_db_proxy.p' },
      { address: 'aws_db_proxy_default_target_group.g', values: {}, expressions: { db_proxy_name: refs('aws_db_proxy.p') } },
      { address: 'aws_db_proxy_target.t', expressions: { db_proxy_name: refs('aws_db_proxy.p'), db_instance_identifier: refs('aws_db_instance.main') } },
    ]);
    const r = importTerraform(p, { answers: ans({ edges: [{ from: 'aws_lb.web', to: 'aws_db_proxy.p' }] }) });
    const e = r.design.edges.find((x) => x.from === 'lb_web' && x.to === 'db_instance_main')!;
    expect(r.edges[e.id!].through).toBe('aws_db_proxy.p');
  });
  it('#6 a cache cluster address names its replication group', () => {
    const p = plan([lb, { address: 'aws_elasticache_replication_group.g', values: { node_type: 'cache.t3.micro' } }, { address: 'aws_elasticache_cluster.m', expressions: { replication_group_id: refs('aws_elasticache_replication_group.g') } }]);
    const r = importTerraform(p, { answers: ans({ edges: [{ from: 'aws_lb.web', to: 'aws_elasticache_cluster.m' }] }) });
    expect(r.design.edges.find((e) => e.from === 'lb_web' && e.to === 'elasticache_replication_group_g')).toBeDefined();
    expect(r.folded.find((f) => f.address === 'aws_elasticache_cluster.m')).toMatchObject({ into: 'elasticache_replication_group_g' });
  });
  it('#7 a DLQ the answer file says something reads stays a node', () => {
    const p = plan([
      lb,
      { address: 'aws_lambda_function.w', values: {} },
      { address: 'aws_lambda_event_source_mapping.m', expressions: { event_source_arn: refs('aws_sqs_queue.q'), function_name: refs('aws_lambda_function.w') } },
      { address: 'aws_sqs_queue.q', values: {}, expressions: { redrive_policy: { references: ['aws_sqs_queue.d.arn', 'aws_sqs_queue.d'] } }, unknown: ['redrive_policy'] },
      { address: 'aws_sqs_queue.d' },
    ]);
    const r = importTerraform(p, { answers: ans({ edges: [{ from: 'aws_sqs_queue.d', to: 'aws_lambda_function.w' }] }) });
    expect(r.design.nodes.map((n) => n.id)).toContain('sqs_queue_d');
    expect(r.folded.find((f) => f.address === 'aws_sqs_queue.d')).toBeUndefined();
    // without the answer it is still folded
    expect(importTerraform(p).folded.find((f) => f.address === 'aws_sqs_queue.d')).toMatchObject({ why: 'import.folded.dlq' });
  });
  it('#7 a DNS record with a literal target named as an entry stays a node', () => {
    const p = plan([lb, { address: 'aws_route53_record.app', values: { type: 'CNAME', records: ['example.com'] } }]);
    const r = importTerraform(p, { answers: ans({ entry: ['aws_route53_record.app'], edges: [{ from: 'aws_route53_record.app', to: 'aws_lb.web' }] }) });
    expect(r.design.edges.find((e) => e.from === 'client' && e.to === 'route53_record_app')).toBeDefined();
  });
});

describe('#45 an answer replaces the fact a check reads', () => {
  const p = plan([
    lb,
    { address: 'aws_lambda_function.w', values: { timeout: 30 } },
    { address: 'aws_lambda_event_source_mapping.m', expressions: { event_source_arn: refs('aws_sqs_queue.q'), function_name: refs('aws_lambda_function.w') } },
    { address: 'aws_sqs_queue.q', values: { visibility_timeout_seconds: 30 } },
  ]);
  it('SQS visibility: C5 uses the answer, not the plan', () => {
    const c5 = (a?: Answers) => runChecks(importTerraform(p, a ? { answers: a } : {})).filter((f) => f.id === 'check.C5.visibility');
    expect(c5()).toHaveLength(1);
    expect(c5(ans({ nodes: { 'aws_sqs_queue.q': { visibilityTimeoutMs: 180_000 } } }))).toEqual([]);
  });
  it('a service instances answer does not change the autoscaling minimum', () => {
    const r = importTerraform(ecsPlan([
      { address: 'aws_ecs_service.s', values: { desired_count: 8 }, expressions: { load_balancer: [{ target_group_arn: refs('aws_lb_target_group.a') }] } },
      { address: 'aws_appautoscaling_target.t', values: { service_namespace: 'ecs', min_capacity: 2, max_capacity: 8 }, expressions: { resource_id: refs('aws_ecs_service.s') } },
    ]), { answers: ans({ nodes: { 'aws_ecs_service.s': { instances: 8 } } }) });
    expect(r.facts.ecs_service_s.minInstances.value).toBe(2);
    expect(runChecks(r).map((f) => f.id)).not.toContain('check.C4.noRoom');
  });
  it('maxReceives fills in a redrive maxReceiveCount the plan did not know', () => {
    const q = plan([
      lb,
      { address: 'aws_lambda_function.w', values: {} },
      { address: 'aws_lambda_event_source_mapping.m', expressions: { event_source_arn: refs('aws_sqs_queue.q'), function_name: refs('aws_lambda_function.w') } },
      { address: 'aws_sqs_queue.q', values: {}, expressions: { redrive_policy: { references: ['aws_sqs_queue.d.arn', 'aws_sqs_queue.d'] } }, unknown: ['redrive_policy'] },
      { address: 'aws_sqs_queue.d' },
    ]);
    const r = importTerraform(q, { answers: ans({ nodes: { 'aws_sqs_queue.q': { maxReceives: 3 } } }) });
    expect(r.facts.sqs_queue_q.maxReceiveCount).toMatchObject({ value: 3, origin: { evidence: 'answer' } });
  });
});
