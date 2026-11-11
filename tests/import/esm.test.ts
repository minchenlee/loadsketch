// M29b #15–#17: an event source mapping's maximum_concurrency is the function's limit only when the
// mappings are its only callers in the final design, and a disabled mapping calls nothing.
import { describe, expect, it } from 'vitest';
import { ANSWERS_SCHEMA, importTerraform, parseAnswers, type ImportResult } from '../../src/import/terraform/index.ts';
import { IMPORT_MESSAGE_IDS } from '../../src/i18n/importMessages.ts';
import { plan, refs, type R } from './plan-helper.ts';

const lb: R = { address: 'aws_lb.web', values: { internal: false } };
const q: R = { address: 'aws_sqs_queue.q', values: { visibility_timeout_seconds: 60 } };
const fn = (x: Partial<R> = {}): R => ({ address: 'aws_lambda_function.f', values: { reserved_concurrent_executions: 100 }, ...x });
const esm = (values: Record<string, unknown> = {}): R => ({ address: 'aws_lambda_event_source_mapping.m', values: { scaling_config: [{ maximum_concurrency: 5 }], ...values }, expressions: { event_source_arn: refs('aws_sqs_queue.q'), function_name: refs('aws_lambda_function.f') } });
const limit = (r: ImportResult) => r.design.nodes.find((n) => n.id === 'lambda_function_f')!.params?.maxConcurrency;

describe('event source mapping limits', () => {
  it('only the mapping calls it: its maximum_concurrency is the limit', () => {
    const r = importTerraform(plan([lb, q, fn(), esm()]));
    expect(limit(r)).toBe(5);
    expect(r.notes).toContainEqual(expect.objectContaining({ id: 'import.approx.sourceConcurrency', node: 'lambda_function_f' }));
  });
  it('#15 an answer-file line from another caller: the function keeps its own limit', () => {
    const r = importTerraform(plan([lb, q, fn(), esm()]), { answers: parseAnswers({ schema: ANSWERS_SCHEMA, edges: [{ from: 'aws_lb.web', to: 'aws_lambda_function.f' }] }) });
    expect(limit(r)).toBe(100);
    expect(r.notes.map((n) => n.id)).not.toContain('import.approx.sourceConcurrency');
  });
  it('#15 an S3 permission (a caller with no line): the function keeps its own limit', () => {
    const r = importTerraform(plan([lb, q, fn(), esm(), { address: 'aws_lambda_permission.s3', values: { principal: 's3.amazonaws.com' }, expressions: { function_name: refs('aws_lambda_function.f') } }]));
    expect(limit(r)).toBe(100);
  });
  it('a read-only permission (lambda:GetFunction) is not a caller: the cap stays', () => {
    const r = importTerraform(plan([lb, q, fn(), esm(), { address: 'aws_lambda_permission.read', values: { action: 'lambda:GetFunction', principal: '123456789012' }, expressions: { function_name: refs('aws_lambda_function.f') } }]));
    expect(limit(r)).toBe(5);
  });
  it('a caller with no node (an EC2 instance whose user_data names the function): no cap', () => {
    const r = importTerraform(plan([lb, q, fn(), esm(), { address: 'aws_instance.box', values: {}, expressions: { user_data: refs('aws_lambda_function.f') } }]));
    expect(limit(r)).toBe(100);
  });
  it('#16 reserved concurrency unknown until apply: no limit from the mapping either', () => {
    const r = importTerraform(plan([lb, q, fn({ values: {}, expressions: { reserved_concurrent_executions: { references: ['var.n'] } }, unknown: ['reserved_concurrent_executions'] }), esm()]));
    expect(limit(r)).toBeUndefined();
    expect(r.facts.lambda_function_f.sourceMaxConcurrency.value).toBe(5);
  });
  it('#17 a disabled mapping: no line, no limit, a note', () => {
    const r = importTerraform(plan([lb, q, fn(), esm({ enabled: false })]));
    expect(r.design.edges.find((e) => e.from === 'sqs_queue_q' && e.to === 'lambda_function_f')).toBeUndefined();
    expect(limit(r)).toBe(100);
    expect(r.facts.lambda_function_f?.sourceMaxConcurrency).toBeUndefined();
    expect(r.notes).toContainEqual(expect.objectContaining({ id: 'import.mappingDisabled', args: { from: 'aws_lambda_event_source_mapping.m' } }));
    expect(IMPORT_MESSAGE_IDS).toContain('import.mappingDisabled');
  });
  it('an answer for maxConcurrency wins over the mapping', () => {
    const r = importTerraform(plan([lb, q, fn(), esm()]), { answers: parseAnswers({ schema: ANSWERS_SCHEMA, nodes: { 'aws_lambda_function.f': { maxConcurrency: 50 } } }) });
    expect(limit(r)).toBe(50);
  });
});
