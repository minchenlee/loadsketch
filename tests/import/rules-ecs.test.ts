// Mapping rules for ALB -> ECS service -> RDS, the client node and the CLI. The ECS
// fixture is a real plan (scripts/gen-fixtures.sh); expected.json says what the import should make
// of it. The small plans test one rule each.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseDesign } from '../../src/core/index.ts';
import { IMPORT_MESSAGE_IDS } from '../../src/i18n/importMessages.ts';
import { importTerraform, PlanError, type ImportResult } from '../../src/import/terraform/index.ts';
import { CPU, ecsPlan, plan, refs, type R } from './plan-helper.ts';
import { cpuMs } from '../helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const FIXTURES = join(import.meta.dirname, 'fixtures');
const PLAN = join(FIXTURES, 'ecs-rds.plan.json');
const fixture = () => importTerraform(JSON.parse(readFileSync(PLAN, 'utf8')));
const expected = JSON.parse(readFileSync(join(FIXTURES, 'ecs-rds.expected.json'), 'utf8')) as {
  components: { id: string; kind: string; from: string; params?: Record<string, unknown>; facts?: Record<string, unknown> }[];
  lines: { from: string; to: string; kind: string }[];
};
const factValues = (r: ImportResult, id: string) => Object.fromEntries(Object.entries(r.facts[id] ?? {}).map(([k, f]) => [k, f.value]));
const errorId = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    if (e instanceof PlanError) return e.id;
    throw e;
  }
};

describe('the ECS fixture', () => {
  const r = fixture();
  const node = (id: string) => r.design.nodes.find((n) => n.id === id);

  it('makes exactly the components in expected.json, with the same params and facts', () => {
    expect(r.design.nodes.map((n) => n.id).sort()).toEqual(expected.components.map((c) => c.id).sort());
    for (const c of expected.components) {
      expect(node(c.id)?.kind, c.id).toBe(c.kind);
      expect(node(c.id)?.params ?? {}, c.id).toEqual(c.params ?? {});
      expect(factValues(r, c.id), c.id).toEqual(c.facts ?? {});
      expect(r.nodeFrom[c.id], c.id).toEqual(c.from === 'generated' ? [] : [c.from]);
    }
  });

  it('makes exactly the lines in expected.json, with the same kinds', () => {
    const got = r.design.edges.map((e) => ({ from: e.from, to: e.to, kind: r.edges[e.id!].kind }));
    const want = expected.lines.map((l) => ({ from: l.from, to: l.to, kind: l.kind === 'definite' && l.from === 'client' ? 'generated' : l.kind }));
    const key = (x: { from: string; to: string }) => `${x.from}->${x.to}`;
    expect(got.sort((a, b) => key(a).localeCompare(key(b)))).toEqual(want.sort((a, b) => key(a).localeCompare(key(b))));
  });

  it('draws the presumed service -> RDS line without an answer file', () => {
    const e = r.design.edges.find((x) => x.from === 'ecs_service_api' && x.to === 'db_instance_main')!;
    expect(r.edges[e.id!]).toMatchObject({ kind: 'presumed', agrees: ['aws_security_group.db.ingress'] });
  });

  it('every param has an origin, every origin has a param, and every aws-default names its source', () => {
    for (const n of r.design.nodes) {
      expect(Object.keys(r.origins[n.id] ?? {}).sort(), n.id).toEqual(Object.keys(n.params ?? {}).sort());
      const all = [...Object.values(r.origins[n.id] ?? {}), ...Object.values(r.facts[n.id] ?? {}).map((f) => f.origin)];
      for (const o of all) if (o.evidence === 'aws-default') expect(o.source, n.id).toMatch(/^https:\/\//);
    }
    // health_check is unknown until apply in this plan, so its values are provider defaults.
    expect(r.origins.lb_web.hcIntervalS).toMatchObject({ evidence: 'aws-default', from: 'aws_lb_target_group.api.health_check.interval' });
    expect(r.origins.ecs_service_api.maxInstances).toEqual({ evidence: 'iac', from: 'aws_appautoscaling_target.api.max_capacity' });
  });

  it('is a valid design, with every resource either a node, folded or unmapped', () => {
    expect(parseDesign(r.design).ok).toBe(true);
    const seen = new Set([...Object.values(r.nodeFrom).flat(), ...r.folded.map((f) => f.address), ...r.unmapped.map((u) => u.address)]);
    expect(seen.size).toBe(16);
    expect(r.unmapped).toEqual([]);
    expect(r.folded.find((f) => f.address === 'aws_lb_target_group.api')).toMatchObject({ into: 'lb_web' });
    expect(r.folded.find((f) => f.address === 'aws_appautoscaling_policy.api_cpu')).toMatchObject({ into: 'ecs_service_api' });
  });

  it('says what it approximated, and every message id has text', () => {
    expect(r.notes.map((n) => n.id).sort()).toEqual(['import.approx.cpuTarget', 'import.approx.healthCheck', 'import.approx.instancesStartAndFloor', 'import.approx.scaleInCooldown']);
    for (const id of [...r.notes.map((n) => n.id), ...r.folded.map((f) => f.why)]) expect(IMPORT_MESSAGE_IDS, id).toContain(id);
  });

  it('lays nodes out left to right along the traffic', () => {
    const x = (id: string) => node(id)!.pos[0];
    expect(x('client')).toBeLessThan(x('lb_web'));
    expect(x('lb_web')).toBeLessThan(x('ecs_service_api'));
    expect(x('ecs_service_api')).toBeLessThan(x('db_instance_main'));
  });
});

describe('mapping rules on small plans', () => {
  it('a known health check is iac, with the timeout in ms', () => {
    const r = importTerraform(ecsPlan([{ address: 'aws_lb_target_group.a', values: { protocol: 'HTTP', health_check: [{ interval: 10, unhealthy_threshold: 2, timeout: 5 }], load_balancing_algorithm_type: 'least_outstanding_requests' } }]));
    const lb = r.design.nodes.find((n) => n.id === 'lb_web')!;
    expect(lb.params).toMatchObject({ hcIntervalS: 10, hcThreshold: 2, hcTimeoutMs: 5000, policy: 'least_conn' });
    expect(r.origins.lb_web.hcTimeoutMs).toEqual({ evidence: 'iac', from: 'aws_lb_target_group.a.health_check.timeout' });
    expect(r.origins.lb_web.policy).toEqual({ evidence: 'iac', from: 'aws_lb_target_group.a.load_balancing_algorithm_type' });
  });

  it('the default health check timeout follows the protocol (HTTPS 10 s)', () => {
    const r = importTerraform(ecsPlan([{ address: 'aws_lb_target_group.a', values: { protocol: 'HTTPS' } }]));
    expect(r.design.nodes.find((n) => n.id === 'lb_web')!.params!.hcTimeoutMs).toBe(10000);
  });

  it('desired_count below min_capacity: instances is the floor, from min_capacity, with a note', () => {
    const r = importTerraform(ecsPlan([{ address: 'aws_appautoscaling_target.t', values: { service_namespace: 'ecs', min_capacity: 4, max_capacity: 8 }, expressions: { resource_id: refs('aws_ecs_service.s') } }]));
    expect(r.design.nodes.find((n) => n.id === 'ecs_service_s')!.params).toMatchObject({ instances: 4, maxInstances: 8, autoscale: 'on', targetUtil: 0.7 });
    expect(r.origins.ecs_service_s.instances).toEqual({ evidence: 'iac', from: 'aws_appautoscaling_target.t.min_capacity' });
    expect(r.notes).toContainEqual({ id: 'import.approx.instancesStartAndFloor', args: { desired: 2, min: 4 }, node: 'ecs_service_s' });
  });

  it('scale_in_cooldown becomes scaleDownS', () => {
    const r = importTerraform(ecsPlan([{ address: 'aws_appautoscaling_policy.p', values: { target_tracking_scaling_policy_configuration: [{ target_value: 50, scale_in_cooldown: 120, predefined_metric_specification: CPU }] }, expressions: { resource_id: refs('aws_appautoscaling_target.t') } }]));
    expect(r.design.nodes.find((n) => n.id === 'ecs_service_s')!.params).toMatchObject({ scaleDownS: 120, targetUtil: 0.5 });
    expect(r.origins.ecs_service_s.scaleDownS.from).toBe('aws_appautoscaling_policy.p.target_tracking_scaling_policy_configuration.scale_in_cooldown');
  });

  it('several target groups behind one load balancer: uses the first, with a note', () => {
    const r = importTerraform(ecsPlan([
      { address: 'aws_lb_listener.l', expressions: { load_balancer_arn: refs('aws_lb.web'), default_action: [{ target_group_arn: refs('aws_lb_target_group.a') }, { target_group_arn: refs('aws_lb_target_group.b') }] } },
      { address: 'aws_lb_target_group.b', values: { protocol: 'HTTP' } },
    ]));
    expect(r.notes).toContainEqual({ id: 'import.approx.severalTargetGroups', args: { n: 2, used: 'aws_lb_target_group.a' }, node: 'lb_web' });
  });

  it('an internal load balancer is not an entry', () => {
    const r = importTerraform(ecsPlan([
      { address: 'aws_lb.inner', values: { internal: true } },
      { address: 'aws_lb_listener.inner', expressions: { load_balancer_arn: refs('aws_lb.inner'), default_action: [{ target_group_arn: refs('aws_lb_target_group.a') }] } },
    ]));
    expect(r.design.edges.filter((e) => e.from === 'client').map((e) => e.to)).toEqual(['lb_web']);
    expect(r.facts.lb_inner.internal).toMatchObject({ value: true, origin: { evidence: 'iac' } });
  });

  it('no entry at all is an error with a message id (the answer file can name one, M23)', () => {
    expect(errorId(() => importTerraform(ecsPlan([{ address: 'aws_lb.web', values: { internal: true } }])))).toBe('import.noEntry');
    expect(errorId(() => importTerraform(plan([{ address: 'aws_db_instance.only', values: { engine: 'postgres' } }])))).toBe('import.noEntry');
    expect(IMPORT_MESSAGE_IDS).toContain('import.noEntry');
  });

  it('types no rule knows are listed as unmapped, not dropped silently', () => {
    const r = importTerraform(ecsPlan([{ address: 'aws_kinesis_stream.q' }]));
    expect(r.unmapped).toEqual([{ address: 'aws_kinesis_stream.q', type: 'aws_kinesis_stream' }]);
  });

  it('Multi-AZ RDS: failover off with a note (the standby is no read replica, M29b #40); ids stay unique when two resources make the same id', () => {
    const r = importTerraform(ecsPlan([
      { address: 'aws_db_instance.main', values: { multi_az: true, engine: 'postgres' } },
      // for_each instances that differ in multi_az are two groups (Q14: role) with the same name.
      { address: 'aws_db_instance.x["a"]', values: { multi_az: true } },
      { address: 'aws_db_instance.x["b"]', values: { multi_az: false } },
    ]));
    const db = r.design.nodes.find((n) => n.id === 'db_instance_main')!;
    expect(db.params).toEqual({ replicas: 0, failover: 'off' });
    expect(r.facts.db_instance_main.multiAz.value).toBe(true);
    expect(r.notes).toContainEqual(expect.objectContaining({ id: 'import.approx.multiAzStandby', node: 'db_instance_main' }));
    expect(r.origins.db_instance_main.failover).toEqual({ evidence: 'iac', from: 'aws_db_instance.main.multi_az' });
    expect(r.design.nodes.map((n) => n.id).filter((id) => id.startsWith('db_instance_x')).sort()).toEqual(['db_instance_x', 'db_instance_x_2']);
    expect(['db_instance_x', 'db_instance_x_2'].map((id) => r.facts[id].multiAz.value).sort()).toEqual([false, true]);
  });
});

/** References as Terraform writes them for an indexed resource: the instance, then the unkeyed block. */
const keyed = (a: string) => ({ references: [`${a}.arn`, a, a.replace(/\[[^\]]*\]$/, '')] });

describe('review fixes', () => {
  it('long resource names still give valid, unique edge ids (max 48)', () => {
    const long = 'aws_ecs_service.production_frontend_application_x';
    const r = importTerraform(ecsPlan([
      { address: 'aws_ecs_service.s', values: { desired_count: 0 } },
      { address: long, values: { desired_count: 2 }, expressions: { load_balancer: [{ target_group_arn: refs('aws_lb_target_group.a') }] } },
      { address: 'aws_lb.web_with_a_rather_long_name_too_for_this', values: { internal: false } },
      { address: 'aws_lb_listener.l2', expressions: { load_balancer_arn: refs('aws_lb.web_with_a_rather_long_name_too_for_this'), default_action: [{ target_group_arn: refs('aws_lb_target_group.a') }] } },
    ]));
    const ids = r.design.edges.map((e) => e.id!);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.length, id).toBeLessThanOrEqual(48);
    expect(Object.keys(r.edges).sort()).toEqual([...ids].sort());
    expect(parseDesign(r.design).ok).toBe(true);
  });

  it('a listener on target group a[1] reads a[1], not a[0] (instance-aware references)', () => {
    const r = importTerraform(ecsPlan([
      { address: 'aws_lb_listener.l', expressions: { load_balancer_arn: refs('aws_lb.web'), default_action: [{ target_group_arn: keyed('aws_lb_target_group.a[1]') }] } },
      { address: 'aws_lb_target_group.a[0]', values: { protocol: 'HTTP', health_check: [{ interval: 10 }] } },
      { address: 'aws_lb_target_group.a[1]', values: { protocol: 'HTTP', health_check: [{ interval: 20 }] } },
      { address: 'aws_ecs_service.s', values: { desired_count: 2 }, expressions: { load_balancer: [{ target_group_arn: keyed('aws_lb_target_group.a[1]') }] } },
    ], ['aws_lb_target_group.a']));
    expect(r.design.nodes.find((n) => n.id === 'lb_web')!.params!.hcIntervalS).toBe(20);
    expect(r.origins.lb_web.hcIntervalS.from).toBe('aws_lb_target_group.a[1].health_check.interval');
  });

  it('merged ECS services add up their scaling limits', () => {
    // resource_id = aws_ecs_service.s[count.index].name: the plan keeps only the unkeyed block, so the
    // target of s[1] is the instance with the same key.
    const r = importTerraform(ecsPlan([
      { address: 'aws_ecs_service.s[0]', values: { desired_count: 3 }, expressions: { load_balancer: [{ target_group_arn: refs('aws_lb_target_group.a') }] } },
      { address: 'aws_ecs_service.s[1]', values: { desired_count: 3 }, expressions: { load_balancer: [{ target_group_arn: refs('aws_lb_target_group.a') }] } },
      { address: 'aws_appautoscaling_target.t[0]', values: { service_namespace: 'ecs', min_capacity: 3, max_capacity: 4 }, expressions: { resource_id: { references: ['aws_ecs_service.s.name', 'aws_ecs_service.s'] } } },
      { address: 'aws_appautoscaling_target.t[1]', values: { service_namespace: 'ecs', min_capacity: 3, max_capacity: 6 }, expressions: { resource_id: { references: ['aws_ecs_service.s.name', 'aws_ecs_service.s'] } } },
    ], ['aws_ecs_service.s', 'aws_appautoscaling_target.t', 'aws_appautoscaling_policy.p']));
    const svc = r.design.nodes.filter((n) => n.kind === 'service');
    expect(svc).toHaveLength(1);
    expect(svc[0].params).toMatchObject({ instances: 6, maxInstances: 10 });
  });

  it('a request-count scaling target is not read as a CPU percentage', () => {
    const r = importTerraform(ecsPlan([{ address: 'aws_appautoscaling_policy.p', values: { target_tracking_scaling_policy_configuration: [{ target_value: 1000, predefined_metric_specification: [{ predefined_metric_type: 'ALBRequestCountPerTarget' }] }] }, expressions: { resource_id: refs('aws_appautoscaling_target.t') } }]));
    expect(r.design.nodes.find((n) => n.id === 'ecs_service_s')!.params).not.toHaveProperty('targetUtil');
    expect(r.notes).toContainEqual({ id: 'import.unsupported.scalingMetric', args: { metric: 'ALBRequestCountPerTarget' }, node: 'ecs_service_s' });
    expect(IMPORT_MESSAGE_IDS).toContain('import.unsupported.scalingMetric');
  });

  it('target groups behind listener rules count (fixed-response default action)', () => {
    const r = importTerraform(ecsPlan([
      { address: 'aws_lb_listener.l', expressions: { load_balancer_arn: refs('aws_lb.web'), default_action: [{ type: { constant_value: 'fixed-response' } }] } },
      { address: 'aws_lb_listener_rule.r', expressions: { listener_arn: refs('aws_lb_listener.l'), action: [{ target_group_arn: refs('aws_lb_target_group.a') }] } },
      { address: 'aws_lb_target_group.a', values: { protocol: 'HTTP', health_check: [{ interval: 15 }] } },
    ]));
    expect(r.design.edges.some((e) => e.from === 'lb_web' && e.to === 'ecs_service_s')).toBe(true);
    expect(r.design.nodes.find((n) => n.id === 'lb_web')!.params!.hcIntervalS).toBe(15);
  });

  it('internal and internet-facing instances of one LB block stay apart', () => {
    for (const order of [[true, false], [false, true]]) {
      const r = importTerraform(ecsPlan([
        { address: 'aws_lb.web[0]', values: { internal: order[0] } },
        { address: 'aws_lb.web[1]', values: { internal: order[1] } },
        // Two listeners of their own (instances of one count block share one expression in the plan).
        { address: 'aws_lb_listener.l0', expressions: { load_balancer_arn: keyed('aws_lb.web[0]'), default_action: [{ target_group_arn: refs('aws_lb_target_group.a') }] } },
        { address: 'aws_lb_listener.l1', expressions: { load_balancer_arn: keyed('aws_lb.web[1]'), default_action: [{ target_group_arn: refs('aws_lb_target_group.a') }] } },
      ], ['aws_lb.web', 'aws_lb_listener.l']));
      const lbs = r.design.nodes.filter((n) => n.kind === 'load_balancer');
      expect(lbs, String(order)).toHaveLength(2);
      const entry = r.design.edges.filter((e) => e.from === 'client').map((e) => r.nodeFrom[e.to]);
      expect(entry).toEqual([[`aws_lb.web[${order.indexOf(false)}]`]]);
    }
  });
});

describe('review fixes', () => {
  it('a keyed policy on the same target does not hide an explicit unkeyed one', () => {
    const r = importTerraform(ecsPlan([
      { address: 'aws_ecs_service.s[0]', values: { desired_count: 2 }, expressions: { load_balancer: [{ target_group_arn: refs('aws_lb_target_group.a') }] } },
      { address: 'aws_appautoscaling_target.t[0]', values: { service_namespace: 'ecs', min_capacity: 2, max_capacity: 8 }, expressions: { resource_id: keyed('aws_ecs_service.s[0]') } },
      { address: 'aws_appautoscaling_policy.cpu', values: { target_tracking_scaling_policy_configuration: [{ target_value: 70, predefined_metric_specification: CPU }] }, expressions: { resource_id: keyed('aws_appautoscaling_target.t[0]') } },
      { address: 'aws_appautoscaling_policy.step[0]', values: { policy_type: 'StepScaling' }, expressions: { resource_id: keyed('aws_appautoscaling_target.t[0]') } },
    ], ['aws_ecs_service.s', 'aws_appautoscaling_target.t', 'aws_appautoscaling_policy.p']));
    expect(r.design.nodes.find((n) => n.kind === 'service')!.params!.targetUtil).toBe(0.7);
  });

  it('a CPU policy after a memory policy is still used; the memory one gets a note', () => {
    const r = importTerraform(ecsPlan([
      { address: 'aws_appautoscaling_policy.mem', values: { target_tracking_scaling_policy_configuration: [{ target_value: 80, predefined_metric_specification: [{ predefined_metric_type: 'ECSServiceAverageMemoryUtilization' }] }] }, expressions: { resource_id: refs('aws_appautoscaling_target.t') } },
      { address: 'aws_appautoscaling_policy.p', values: { target_tracking_scaling_policy_configuration: [{ target_value: 70, predefined_metric_specification: CPU }] }, expressions: { resource_id: refs('aws_appautoscaling_target.t') } },
    ]));
    expect(r.design.nodes.find((n) => n.id === 'ecs_service_s')!.params!.targetUtil).toBe(0.7);
    expect(r.notes).toContainEqual({ id: 'import.unsupported.scalingMetric', args: { metric: 'ECSServiceAverageMemoryUtilization' }, node: 'ecs_service_s' });
  });

  it('200 merged ECS services with unkeyed references import fast (CPU time)', () => {
    const n = 200;
    const rs: R[] = [];
    for (let i = 0; i < n; i++) {
      rs.push({ address: `aws_ecs_service.s[${i}]`, values: { desired_count: 1 }, expressions: { load_balancer: [{ target_group_arn: refs('aws_lb_target_group.a') }] } });
      rs.push({ address: `aws_appautoscaling_target.t[${i}]`, values: { service_namespace: 'ecs', min_capacity: 1, max_capacity: 2 }, expressions: { resource_id: { references: ['aws_ecs_service.s.name', 'aws_ecs_service.s'] } } });
    }
    const p = ecsPlan(rs, ['aws_ecs_service.s', 'aws_appautoscaling_target.t', 'aws_appautoscaling_policy.p']);
    let r: ImportResult | undefined;
    const ms = cpuMs(() => {
      r = importTerraform(p);
    });
    expect(r!.design.nodes.find((x) => x.kind === 'service')!.params).toMatchObject({ instances: n, maxInstances: 2 * n });
    expect(ms, `${ms} ms`).toBeLessThan(300);
  });
});

describe('loadsketch import terraform (CLI)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loadsketch-import-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const cli = (...args: string[]) => spawnSync(process.execPath, ['cli/loadsketch.ts', ...args], { cwd: ROOT, encoding: 'utf8' });

  it('--out writes a design that validate accepts', () => {
    const out = join(dir, 'x.json');
    const r = cli('import', 'terraform', PLAN, '--out', out);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('推定');
    expect(cli('validate', out).status).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(fixture().design);
  });

  it('--json prints the whole result; --name sets the design name', () => {
    const r = cli('import', 'terraform', PLAN, '--json', '--name', 'shop');
    expect(r.status, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout) as ImportResult;
    expect(j.design.name).toBe('shop');
    expect(j.edges['ecs_service_api-db_instance_main'].kind).toBe('presumed');
  });

  it('a file that is not a plan fails with the message, not a stack trace', () => {
    const r = cli('import', 'terraform', join(ROOT, 'package.json'));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('format_version');
    expect(r.stderr).not.toMatch(/\bat .*\.ts:\d+/);
  });

  it('an unknown source is a usage error', () => {
    expect(cli('import', 'pulumi', PLAN).status).toBe(1);
  });
});
