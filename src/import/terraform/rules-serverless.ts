// Mapping rules for the serverless resource group:
// Lambda, its event source mappings, SQS, API Gateway (REST and HTTP), DynamoDB and S3.
import { DEFAULTS } from './defaults.ts';
import { refsTo, type ResourceGraph } from './graph.ts';
import { ASSUME } from './instances.ts';
import type { PlanResource } from './plan.ts';
import type { Origin } from './result.ts';
import { awsDefault, block, configured, estimate, iac, num, referrers, setOr, unknownSet, zonesOf, type Rule, type RuleOut } from './rule-kit.ts';

const TABLE = 'src/import/terraform/instances.ts (ASSUME)';
const empty = (kind: string): RuleOut => ({ kind, params: {}, origins: {}, facts: {}, notes: [], uses: [] });
const set = (out: RuleOut, param: string, value: number | string, origin: Origin) => {
  out.params[param] = value;
  out.origins[param] = origin;
};

/** Principals that invoke a function asynchronously (events, not a request that waits). */
const ASYNC_PRINCIPAL = /^(sns|s3|events|logs|ses|iot|codecommit|config)\.amazonaws\.com$/;

/** loadsketch's function params stop at 100 000; a merged group above that is cut, with a note. */
const FN_MAX = 100_000;
function capped(out: RuleOut, param: string, v: number): number {
  if (v <= FN_MAX) return v;
  out.notes.push({ id: 'import.approx.capped', args: { param, value: v, max: FN_MAX } });
  return FN_MAX;
}

const lambdaFunction: Rule = (rs, g) => {
  const fn = rs[0];
  const out = empty('function');
  const L = DEFAULTS.lambda;
  // Concurrency limit: reserved concurrency, else the account quota (an estimate: quotas get raised).
  const reserved = num(fn.values.reserved_concurrent_executions);
  if (unknownSet(fn, 'reserved_concurrent_executions')) out.notes.push({ id: 'import.unknownValue', args: { from: `${fn.address}.reserved_concurrent_executions` } });
  // Merged functions have the same reserved concurrency (ROLE_KEYS); each has its own (#10).
  else if (reserved !== undefined && reserved > 0) set(out, 'maxConcurrency', capped(out, 'maxConcurrency', reserved * rs.length), iac(fn, 'reserved_concurrent_executions'));
  else if (reserved === 0) {
    // 0 = the function is turned off; loadsketch needs at least 1.
    set(out, 'maxConcurrency', 1, iac(fn, 'reserved_concurrent_executions'));
    out.notes.push({ id: 'import.approx.reservedZero' });
  } else {
    set(out, 'maxConcurrency', L.accountConcurrency.value, estimate(`${fn.address}.reserved_concurrent_executions`, L.accountConcurrency.source));
    out.notes.push({ id: 'import.approx.accountConcurrency', args: { n: L.accountConcurrency.value } });
  }
  // Each function scales on its own: a merged group scales n times as fast.
  set(out, 'scalePer10s', capped(out, 'scalePer10s', L.scalePer10s.value * rs.length), awsDefault(fn, 'scaling', L.scalePer10s.source));
  // Aliases stand for the function: lines and settings that name an alias belong to it.
  const aliases = rs.flatMap((r) => referrers(g, /^aws_lambda_alias$/, 'function_name', r));
  out.members = aliases.map((x) => x.address);
  const named = [...rs, ...aliases];
  const of = (type: RegExp) => [...new Set(named.flatMap((r) => referrers(g, type, 'function_name', r)))];
  const provisioned = of(/^aws_lambda_provisioned_concurrency_config$/);
  out.uses.push(...provisioned.map((p) => p.address));
  const prov = provisioned.reduce((s, p) => s + (num(p.values.provisioned_concurrent_executions) ?? 0), 0);
  if (prov > 0) set(out, 'provisioned', Math.min(prov, Number(out.params.maxConcurrency ?? prov)), iac(provisioned[0], 'provisioned_concurrent_executions'));

  // Event source mappings: their maximum_concurrency caps what the queue starts; when every caller
  // is one of them, the cap is the function's limit in the design too. That needs the final edges
  // (answer-file lines too), so index.ts decides (sourceCap). A disabled mapping calls nothing (#17).
  const all = of(/^aws_lambda_event_source_mapping$/);
  out.uses.push(...all.map((m) => m.address));
  for (const m of all) if (m.values.enabled === false) out.notes.push({ id: 'import.mappingDisabled', args: { from: m.address } });
  const esms = all.filter((m) => m.values.enabled !== false);
  const esmMax = esms.map((m) => num(block(m.values.scaling_config)?.maximum_concurrency));
  if (esms.length && esmMax.every((v) => v !== undefined)) {
    const sum = (esmMax as number[]).reduce((a, b) => a + b, 0);
    const origin = iac(esms[0], 'scaling_config.maximum_concurrency');
    out.facts.sourceMaxConcurrency = { value: sum, origin };
    // Not when the function's own limit is unknown (#16), or something else may invoke it: a
    // permission (S3, SNS, another account) is a caller with no line (#15).
    // A permission counts only if it allows invoking (not lambda:GetFunction); unknown counts.
    const invokers = of(/^aws_lambda_permission$/).filter((p) => typeof p.values.action !== 'string' || /^(\*|lambda:\*|lambda:Invoke)/i.test(p.values.action));
    // A line from a caller that has no node (an EC2 instance's user_data) is dropped from the design
    // but still calls: the graph's lines are checked here, the final edges in index.ts.
    const otherLine = g.lines.some((l) => l.kind !== 'candidate' && named.some((r) => r.address === l.to) && !(l.kind === 'definite' && l.via.some((v) => esms.some((m) => m.address === v))));
    if (!unknownSet(fn, 'reserved_concurrent_executions') && !invokers.length && !otherLine) out.sourceCap = { value: sum, origin, via: esms.map((m) => m.address) };
  }
  const batch = esms.map((m) => num(m.values.batch_size)).find((v) => v !== undefined);
  if (batch !== undefined) out.facts.batchSize = { value: batch, origin: iac(esms.find((m) => num(m.values.batch_size) !== undefined)!, 'batch_size') };
  if (esms.length) out.notes.push({ id: 'import.approx.batch' });

  // Written but unknown until apply (or sensitive): left out, never the AWS default (C5 would be wrong).
  for (const [fact, attr, d] of [['timeoutS', 'timeout', L.timeoutS], ['memoryMiB', 'memory_size', L.memoryMiB]] as const) {
    if (unknownSet(fn, attr)) out.notes.push({ id: fn.unknown.has(attr) ? 'import.unknownValue' : 'import.sensitiveValue', args: { from: `${fn.address}.${attr}` } });
    else out.facts[fact] = { value: num(fn.values[attr]) ?? d.value, origin: setOr(fn, attr, d.source) };
  }

  // Asynchronous invocation (C7): an invoke config, or a permission for an event source.
  const invokeConfigs = of(/^aws_lambda_function_event_invoke_config$/);
  const permissions = of(/^aws_lambda_permission$/).filter((p) => typeof p.values.principal === 'string' && ASYNC_PRINCIPAL.test(p.values.principal));
  out.uses.push(...invokeConfigs.map((c) => c.address), ...permissions.map((p) => p.address));
  const asyncBy = invokeConfigs[0] ?? permissions[0];
  if (asyncBy) {
    out.facts.asyncInvoked = { value: true, origin: iac(asyncBy, invokeConfigs[0] ? 'function_name' : 'principal') };
    const dlq = configured(fn, 'dead_letter_config.target_arn') || typeof block(fn.values.dead_letter_config)?.target_arn === 'string';
    // Each invoke config covers its own qualifier (the function, an alias): failures have somewhere to
    // go only if the function has a DLQ or every config has an on_failure destination.
    const bare = invokeConfigs.find((c) => !configured(c, 'destination_config.on_failure'));
    const covered = invokeConfigs.length > 0 && !bare;
    out.facts.asyncFailureTarget = { value: dlq || covered, origin: dlq ? iac(fn, 'dead_letter_config') : covered ? iac(invokeConfigs[0], 'destination_config.on_failure') : bare ? iac(bare, 'destination_config') : awsDefault(fn, 'dead_letter_config', L.asyncAttempts.source) };
    const retries = invokeConfigs.map((c) => num(c.values.maximum_retry_attempts)).find((v) => v !== undefined);
    out.facts.asyncAttempts = retries !== undefined ? { value: retries + 1, origin: iac(invokeConfigs[0], 'maximum_retry_attempts') } : { value: L.asyncAttempts.value, origin: awsDefault(fn, 'maximum_retry_attempts', L.asyncAttempts.source) };
  }
  const zones = zonesOf(g, fn.expressions.vpc_config);
  if (zones) out.facts.zones = zones;
  if (rs.length > 1) out.notes.push({ id: 'import.merged', args: { n: rs.length } });
  return out;
};

/** A redrive policy's JSON (a string in the plan), parsed; undefined when it is unknown or not JSON. */
function redrive(v: unknown): { maxReceiveCount?: number } | undefined {
  if (typeof v !== 'string') return undefined;
  try {
    const p = JSON.parse(v) as Record<string, unknown>;
    const n = Number(p.maxReceiveCount);
    return { ...(Number.isFinite(n) && n > 0 ? { maxReceiveCount: n } : {}) };
  } catch {
    return undefined;
  }
}

const sqsQueue: Rule = (rs, g) => {
  const q = rs[0];
  const S = DEFAULTS.sqs;
  const mine = (r: PlanResource) => rs.some((x) => x.address === r.address);
  const policies = g.plan.resources.filter((r) => r.type === 'aws_sqs_queue_redrive_policy' && refsTo(g.plan, r.expressions.queue_url).some(mine));
  // A dead-letter queue that nothing reads or writes: the source queue's maxReceives stands for it.
  const asDlq = g.plan.resources.some((r) => (r.type === 'aws_sqs_queue' || r.type === 'aws_sqs_queue_redrive_policy') && !mine(r) && refsTo(g.plan, r.expressions.redrive_policy).some(mine));
  const used = g.lines.some((l) => l.kind !== 'candidate' && rs.some((r) => r.address === l.from || r.address === l.to));
  if (asDlq && !used && !rs.some((r) => g.named?.has(r.address))) return { fold: 'import.folded.dlq' };

  const out = empty('queue');
  out.uses.push(...policies.map((p) => p.address));
  set(out, 'delivery', S.delivery.value, awsDefault(q, 'delivery', S.delivery.source));
  set(out, 'maxDepth', S.noDepthLimit.value, awsDefault(q, 'max_depth', S.noDepthLimit.source));
  const vis = num(q.values.visibility_timeout_seconds) ?? S.visibilityS.value;
  const visOrigin = setOr(q, 'visibility_timeout_seconds', S.visibilityS.source);
  // 0 is valid in SQS (the message shows again at once); loadsketch needs at least 1 ms.
  set(out, 'visibilityTimeoutMs', Math.max(1, vis * 1000), visOrigin);
  if (vis === 0) out.notes.push({ id: 'import.approx.visibilityZero' });
  out.facts.visibilityS = { value: vis, origin: visOrigin };
  set(out, 'messageTtlS', num(q.values.message_retention_seconds) ?? S.retentionS.value, setOr(q, 'message_retention_seconds', S.retentionS.source));
  if (q.values.fifo_queue === true) set(out, 'ordering', 'fifo', iac(q, 'fifo_queue'));
  // Redrive: on the queue, or in an aws_sqs_queue_redrive_policy. Written but unknown until apply
  // (an ARN reference): there is a DLQ, but its maxReceiveCount is not known.
  const holder = configured(q, 'redrive_policy') || redrive(q.values.redrive_policy) ? q : policies[0];
  if (holder) {
    out.facts.redrive = { value: true, origin: iac(holder, 'redrive_policy') };
    const p = redrive(holder.values.redrive_policy);
    if (p?.maxReceiveCount !== undefined) {
      set(out, 'maxReceives', p.maxReceiveCount, iac(holder, 'redrive_policy.maxReceiveCount'));
      out.facts.maxReceiveCount = { value: p.maxReceiveCount, origin: iac(holder, 'redrive_policy.maxReceiveCount') };
    } else out.notes.push({ id: 'import.unknownValue', args: { from: `${holder.address}.redrive_policy` } });
  } else {
    out.facts.redrive = { value: false, origin: awsDefault(q, 'redrive_policy', S.noRedrive.source) };
    set(out, 'maxReceives', S.noRedrive.value, awsDefault(q, 'redrive_policy', S.noRedrive.source));
  }
  out.notes.push({ id: 'import.approx.queuePolling' });
  if (rs.length > 1) out.notes.push({ id: 'import.merged', args: { n: rs.length } });
  return out;
};

/** API Gateway (REST or HTTP): the gateway, a throttle in front of it, and the integration timeouts. */
function gateway(api: PlanResource, g: ResourceGraph, v: 'rest' | 'http'): RuleOut {
  const A = DEFAULTS.apiGateway;
  const out = empty('api_gateway');
  const apiAttr = v === 'rest' ? 'rest_api_id' : 'api_id';
  const prefix = v === 'rest' ? /^aws_api_gateway_/ : /^aws_apigatewayv2_/;
  const children = g.plan.resources.filter((r) => prefix.test(r.type) && r.address !== api.address && refsTo(g.plan, r.expressions[apiAttr]).some((x) => x.address === api.address));
  out.uses.push(...children.map((c) => c.address));
  out.entry = !(v === 'rest' && JSON.stringify(api.values.endpoint_configuration ?? '').includes('PRIVATE'));
  // Throttle: REST method settings (the stage-wide `*/*` first), HTTP stage default route settings.
  const pick = v === 'rest'
    ? children.filter((c) => c.type === 'aws_api_gateway_method_settings').sort((a, b) => Number(b.values.method_path === '*/*') - Number(a.values.method_path === '*/*')).map((c) => ({ r: c, path: 'settings', s: block(c.values.settings), rate: 'throttling_rate_limit', burst: 'throttling_burst_limit' }))
    : children.filter((c) => c.type === 'aws_apigatewayv2_stage').map((c) => ({ r: c, path: 'default_route_settings', s: block(c.values.default_route_settings), rate: 'throttling_rate_limit', burst: 'throttling_burst_limit' }));
  const t = pick[0];
  const front: NonNullable<RuleOut['front']> = { kind: 'rate_limiter', params: { limit: 'rate' }, origins: {}, via: t?.r.address ?? api.address };
  front.origins.limit = t ? iac(t.r, `${t.path}.${t.rate}`) : estimate(api.address, A.accountRate.source);
  for (const [param, attr, dflt] of [['ratePerSec', t?.rate, A.accountRate], ['burst', t?.burst, A.accountBurst]] as const) {
    const val = t && attr ? num(t.s?.[attr]) : undefined;
    if (val !== undefined && val >= 0) {
      // A burst of 0 is valid in API Gateway (nothing passes); loadsketch needs at least 1.
      front.params[param] = param === 'burst' ? Math.max(1, val) : val;
      front.origins[param] = iac(t!.r, `${t!.path}.${attr}`);
      if (param === 'burst' && val === 0) out.notes.push({ id: 'import.approx.burstZero' });
    } else {
      // -1 or unset: the account throttle (an estimate, like the Lambda quota).
      front.params[param] = dflt.value;
      front.origins[param] = estimate(t ? `${t.r.address}.${t.path}.${attr}` : api.address, dflt.source);
    }
  }
  if (!t || front.origins.ratePerSec.evidence === 'estimate') out.notes.push({ id: 'import.approx.accountThrottle', args: { rps: Number(front.params.ratePerSec) } });
  if (pick.length > 1) out.notes.push({ id: 'import.approx.severalStages', args: { n: pick.length, used: t!.r.address } });
  out.front = front;
  // Integration timeouts: on the edge to what each integration calls.
  const iType = v === 'rest' ? 'aws_api_gateway_integration' : 'aws_apigatewayv2_integration';
  const uriAttr = v === 'rest' ? 'uri' : 'integration_uri';
  const dflt = v === 'rest' ? A.restTimeoutMs : A.httpTimeoutMs;
  out.edgeParams = [];
  for (const i of children.filter((c) => c.type === iType)) {
    const ms = num(i.values.timeout_milliseconds) ?? dflt.value;
    const targets = refsTo(g.plan, i.expressions[uriAttr]).flatMap((r) => (/^aws_(lb|alb)_listener$/.test(r.type) ? refsTo(g.plan, r.expressions.load_balancer_arn, /^aws_(lb|alb)$/) : [r]));
    for (const to of targets) out.edgeParams.push({ to: to.address, param: 'timeoutMs', value: ms, origin: setOr(i, 'timeout_milliseconds', dflt.source) });
  }
  out.notes.push({ id: 'import.approx.managedGateway' });
  return out;
}
const restApi: Rule = ([api], g) => gateway(api, g, 'rest');
const httpApi: Rule = ([api], g) => gateway(api, g, 'http');

const dynamoTable: Rule = ([t], g) => {
  const out = empty('database');
  out.facts.engine = { value: 'dynamodb', origin: iac(t, 'name') };
  const mode = typeof t.values.billing_mode === 'string' ? t.values.billing_mode : 'PROVISIONED';
  out.facts.billingMode = { value: mode, origin: setOr(t, 'billing_mode', 'https://github.com/hashicorp/terraform-provider-aws/blob/v6.72.0/website/docs/r/dynamodb_table.html.markdown (billing_mode: Defaults to PROVISIONED)') };
  for (const [k, v] of Object.entries(ASSUME.dynamodb)) set(out, k, v, estimate(t.address, TABLE));
  out.notes.push({ id: 'import.approx.dynamodb' });
  if (mode !== 'PROVISIONED') return out;
  const rcu = num(t.values.read_capacity);
  const wcu = num(t.values.write_capacity);
  if (rcu === undefined || wcu === undefined) {
    out.notes.push({ id: 'import.unknownValue', args: { from: `${t.address}.read_capacity` } });
  } else {
    // One limiter for reads and writes together (G5): capacity units, not requests of every size.
    out.front = { kind: 'rate_limiter', params: { limit: 'rate', ratePerSec: rcu + wcu, burst: rcu + wcu }, origins: { limit: iac(t, 'billing_mode'), ratePerSec: iac(t, 'read_capacity+write_capacity'), burst: estimate(`${t.address}.read_capacity`, TABLE) }, via: t.address };
    out.notes.push({ id: 'import.approx.capacityUnits', args: { rcu, wcu } });
  }
  const name = typeof t.values.name === 'string' ? t.values.name : undefined;
  const targets = g.plan.resources.filter((r) => r.type === 'aws_appautoscaling_target' && r.values.service_namespace === 'dynamodb' && (refsTo(g.plan, r.expressions.resource_id).some((x) => x.address === t.address) || (name !== undefined && typeof r.values.resource_id === 'string' && (r.values.resource_id === `table/${name}` || r.values.resource_id.startsWith(`table/${name}/`)))));
  out.uses.push(...targets.map((x) => x.address));
  // A global secondary index scales on its own (dynamodb:index:*): not the table's capacity.
  const table = targets.filter((r) => (typeof r.values.scalable_dimension === 'string' ? r.values.scalable_dimension.startsWith('dynamodb:table:') : !(typeof r.values.resource_id === 'string' && r.values.resource_id.includes('/index/'))));
  out.facts.capacityAutoscaling = { value: table.length > 0, origin: table.length ? iac(table[0], 'resource_id') : iac(t, 'billing_mode') };
  return out;
};

const s3Bucket: Rule = () => ({ ...empty('object_storage'), notes: [{ id: 'import.approx.s3' }] });

export const SERVERLESS_RULES: Record<string, Rule> = {
  aws_lambda_function: lambdaFunction,
  aws_sqs_queue: sqsQueue,
  aws_api_gateway_rest_api: restApi,
  aws_apigatewayv2_api: httpApi,
  aws_dynamodb_table: dynamoTable,
  aws_s3_bucket: s3Bucket,
};
export const SERVERLESS_FOLDED: Record<string, string> = {
  aws_lambda_event_source_mapping: 'import.folded.eventSource',
  aws_lambda_permission: 'import.folded.permission',
  aws_lambda_provisioned_concurrency_config: 'import.folded.lambdaConfig',
  aws_lambda_function_event_invoke_config: 'import.folded.lambdaConfig',
  aws_lambda_alias: 'import.folded.lambdaConfig',
  aws_sqs_queue_redrive_policy: 'import.folded.redrivePolicy',
  aws_sqs_queue_policy: 'import.folded.permission',
  aws_api_gateway_resource: 'import.folded.gatewayPart',
  aws_api_gateway_method: 'import.folded.gatewayPart',
  aws_api_gateway_integration: 'import.folded.gatewayPart',
  aws_api_gateway_integration_response: 'import.folded.gatewayPart',
  aws_api_gateway_method_response: 'import.folded.gatewayPart',
  aws_api_gateway_deployment: 'import.folded.gatewayPart',
  aws_api_gateway_stage: 'import.folded.gatewayPart',
  aws_api_gateway_method_settings: 'import.folded.gatewayPart',
  aws_apigatewayv2_integration: 'import.folded.gatewayPart',
  aws_apigatewayv2_route: 'import.folded.gatewayPart',
  aws_apigatewayv2_stage: 'import.folded.gatewayPart',
  aws_apigatewayv2_deployment: 'import.folded.gatewayPart',
  aws_s3_bucket_policy: 'import.folded.permission',
  aws_s3_bucket_versioning: 'import.folded.bucketSetting',
  aws_s3_bucket_public_access_block: 'import.folded.bucketSetting',
  aws_s3_bucket_server_side_encryption_configuration: 'import.folded.bucketSetting',
  aws_iam_role: 'import.folded.permission',
  aws_iam_policy: 'import.folded.permission',
  aws_iam_role_policy: 'import.folded.permission',
  aws_iam_role_policy_attachment: 'import.folded.permission',
};
