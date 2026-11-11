// Step 4 of the import: instance table, answer file, and the `source` fields. Order:
// answer file > IaC > instance table > loadsketch default; every value says where it came from.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { formatJson, parseDesign, type Design } from '../../src/core/index.ts';
import { IMPORT_MESSAGE_IDS } from '../../src/i18n/importMessages.ts';
import { maxConnections, sizeOf } from '../../src/import/terraform/instances.ts';
import { ANSWERS_SCHEMA, importTerraform, parseAnswers, PlanError, type Answers } from '../../src/import/terraform/index.ts';
import { ecsPlan, plan, refs, type R } from './plan-helper.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const PLAN = join(import.meta.dirname, 'fixtures', 'ecs-rds.plan.json');
const fixturePlan = () => JSON.parse(readFileSync(PLAN, 'utf8'));
const answers = (a: Omit<Answers, 'schema'>): Answers => parseAnswers({ schema: ANSWERS_SCHEMA, ...a });
const node = (d: Design, id: string) => d.nodes.find((n) => n.id === id)!;
const errorId = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    if (e instanceof PlanError) return e.id;
    throw e;
  }
};

describe('every value has a source', () => {
  const r = importTerraform(fixturePlan());

  it('every param of every node has an evidence level and a role; every edge says what it is based on', () => {
    for (const n of r.design.nodes) {
      expect(n.source, n.id).toBeDefined();
      expect(Object.keys(n.source!.params ?? {}).sort(), n.id).toEqual(Object.keys(n.params ?? {}).sort());
      for (const [k, s] of Object.entries(n.source!.params ?? {})) {
        expect(['iac', 'aws-default', 'estimate', 'answer'], `${n.id}.${k}`).toContain(s.evidence);
        if (s.evidence === 'aws-default') expect(s.ref, `${n.id}.${k}`).toMatch(/^https:\/\//);
      }
    }
    expect(r.design.edges.map((e) => e.source!.line).sort()).toEqual(['definite', 'generated', 'presumed']);
    expect(node(r.design, 'db_instance_main').source!.from).toEqual(['aws_db_instance.main']);
    expect(node(r.design, 'client').source).toEqual({ from: [] });
  });

  it('settings and performance assumptions are told apart', () => {
    const s = node(r.design, 'ecs_service_api').source!.params!;
    expect(s.maxInstances).toMatchObject({ evidence: 'iac', role: 'setting' });
    expect(s.serviceMs).toMatchObject({ evidence: 'estimate', role: 'assumption' });
    expect(s.concurrency).toMatchObject({ evidence: 'estimate', role: 'assumption', from: 'aws_ecs_task_definition.api.cpu' });
    expect(node(r.design, 'db_instance_main').source!.params!.connections).toMatchObject({ evidence: 'estimate', role: 'assumption' });
  });

  it('the design with sources is valid and survives a parse and format unchanged', () => {
    const p = parseDesign(JSON.parse(formatJson(r.design)));
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    expect(formatJson(p.value)).toBe(formatJson(r.design));
  });
});

describe('the instance table', () => {
  it('sizes follow the family and the size', () => {
    expect(sizeOf('m6i.large')).toMatchObject({ vcpu: 2, memoryGiB: 8 });
    expect(sizeOf('db.r6g.xlarge')).toMatchObject({ vcpu: 4, memoryGiB: 32 });
    expect(sizeOf('c7g.2xlarge')).toMatchObject({ vcpu: 8, memoryGiB: 16 });
    expect(sizeOf('db.t3.medium')).toMatchObject({ vcpu: 2, memoryGiB: 4 });
    expect(sizeOf('t4g.micro')).toMatchObject({ vcpu: 2, memoryGiB: 1 });
    expect(sizeOf('x2iedn.32xlarge')).toBeUndefined();
    expect(sizeOf('db.serverless')).toBeUndefined();
  });

  it('RDS max_connections: the AWS formula with all memory, and after the OS reserve', () => {
    expect(maxConnections('postgres', 4 * 2 ** 30)!.value).toBe(450);
    expect(maxConnections('mysql', 4 * 2 ** 30)!.value).toBe(341);
    expect(maxConnections('postgres', 1024 * 2 ** 30)!.value).toBe(5000);
    expect(maxConnections('sqlserver-ex', 4 * 2 ** 30)).toBeUndefined();
    const f = importTerraform(fixturePlan()).facts.db_instance_main;
    expect(f.maxConnectionsAllMemory).toMatchObject({ value: 450, origin: { evidence: 'aws-default' } });
    expect(f.maxConnectionsAfterReserve).toMatchObject({ value: 414, origin: { evidence: 'estimate' } });
  });

  it('an instance class the table does not know: no assumptions, and a note', () => {
    const r = importTerraform(ecsPlan([{ address: 'aws_db_instance.main', values: { engine: 'postgres', instance_class: 'db.x2iedn.32xlarge' } }]));
    expect(node(r.design, 'db_instance_main').params).toEqual({ replicas: 0, failover: 'off' });
    expect(r.notes).toContainEqual({ id: 'import.unknownInstanceType', args: { type: 'db.x2iedn.32xlarge' }, node: 'db_instance_main' });
  });
});

describe('the answer file', () => {
  it('overrides IaC and table values, by node id or by resource address', () => {
    const r = importTerraform(fixturePlan(), { answers: answers({ nodes: { 'aws_ecs_service.api': { maxInstances: 20, serviceMs: { value: 12, evidence: 'measured' } }, db_instance_main: { connections: 16 } } }) });
    expect(node(r.design, 'ecs_service_api').params).toMatchObject({ maxInstances: 20, serviceMs: 12, instances: 3 });
    expect(node(r.design, 'ecs_service_api').source!.params!.maxInstances).toEqual({ evidence: 'answer', role: 'setting' });
    expect(node(r.design, 'ecs_service_api').source!.params!.serviceMs).toEqual({ evidence: 'answer', role: 'assumption', measured: true });
    expect(node(r.design, 'db_instance_main').params!.connections).toBe(16);
    expect(parseDesign(r.design).ok).toBe(true);
  });

  it('a value the kind does not accept makes the design invalid (not silently dropped)', () => {
    const r = importTerraform(fixturePlan(), { answers: answers({ nodes: { ecs_service_api: { concurrency: 'lots' } } }) });
    expect(parseDesign(r.design).ok).toBe(false);
  });

  it('confirming the presumed line marks it confirmed; a new line is added as an answer line', () => {
    const r = importTerraform(fixturePlan(), { answers: answers({ edges: [{ from: 'aws_ecs_service.api', to: 'aws_db_instance.main' }, { from: 'db_instance_main', to: 'lb_web' }] }) });
    expect(r.design.edges.find((e) => e.to === 'db_instance_main')!.source).toMatchObject({ line: 'presumed', confirmed: true });
    expect(r.design.edges.find((e) => e.from === 'db_instance_main')!.source).toEqual({ line: 'answer', confirmed: true });
  });

  it('names nothing in the import: an error with a message id', () => {
    expect(errorId(() => importTerraform(fixturePlan(), { answers: answers({ nodes: { nope: { instances: 2 } } }) }))).toBe('import.answers.unknownNode');
    expect(errorId(() => importTerraform(fixturePlan(), { answers: answers({ edges: [{ from: 'client', to: 'aws_nope.x' }] }) }))).toBe('import.answers.unknownNode');
    expect(errorId(() => parseAnswers({ schema: ANSWERS_SCHEMA, nodes: [] }))).toBe('import.answers.invalid');
    expect(errorId(() => parseAnswers({ traffic: { peakRps: 10 } }))).toBe('import.answers.invalid');
    for (const id of ['import.answers.unknownNode', 'import.answers.invalid', 'import.unknownValue', 'import.unknownInstanceType']) expect(IMPORT_MESSAGE_IDS).toContain(id);
  });

  it('can name the entry when no load balancer is internet-facing', () => {
    const p = ecsPlan([{ address: 'aws_lb.web', values: { internal: true } }]);
    expect(errorId(() => importTerraform(p))).toBe('import.noEntry');
    const r = importTerraform(p, { answers: answers({ entry: ['aws_lb.web'] }) });
    expect(r.design.edges.filter((e) => e.from === 'client').map((e) => e.to)).toEqual(['lb_web']);
  });
});

describe('candidate lines', () => {
  // The worker's security group may reach the DB's: the only evidence for worker -> DB.
  const p = (extra: R[] = []) =>
    ecsPlan([
      { address: 'aws_security_group.worker' },
      { address: 'aws_security_group.db', expressions: { ingress: { references: ['aws_security_group.worker.id', 'aws_security_group.worker'] } } },
      { address: 'aws_ecs_service.s', values: { desired_count: 2 }, expressions: { load_balancer: [{ target_group_arn: refs('aws_lb_target_group.a') }], network_configuration: [{ security_groups: { references: ['aws_security_group.worker.id', 'aws_security_group.worker'] } }] } },
      { address: 'aws_db_instance.main', values: { engine: 'postgres' }, expressions: { vpc_security_group_ids: { references: ['aws_security_group.db.id', 'aws_security_group.db'] } } },
      ...extra,
    ]);

  it('are not in the design until the answer file confirms them', () => {
    const r = importTerraform(p());
    expect(r.design.edges.some((e) => e.to === 'db_instance_main')).toBe(false);
    expect(r.candidates.map((l) => `${l.from} -> ${l.to}`)).toEqual(['aws_ecs_service.s -> aws_db_instance.main']);
    const c = importTerraform(p(), { answers: answers({ edges: [{ from: 'ecs_service_s', to: 'db_instance_main' }] }) });
    expect(c.design.edges.find((e) => e.to === 'db_instance_main')!.source).toEqual({ line: 'candidate', confirmed: true, via: ['aws_security_group.db.ingress'] });
    expect(c.candidates).toEqual([]);
    expect(parseDesign(c.design).ok).toBe(true);
  });
});

describe('unknown values', () => {
  it('a desired_count or max_capacity known only after apply is left out (never 0), with a note', () => {
    const r = importTerraform(ecsPlan([
      { address: 'aws_ecs_service.s', values: {}, unknown: ['desired_count'], expressions: { load_balancer: [{ target_group_arn: refs('aws_lb_target_group.a') }] } },
      { address: 'aws_appautoscaling_target.t', values: { service_namespace: 'ecs' }, unknown: ['min_capacity', 'max_capacity'], expressions: { resource_id: refs('aws_ecs_service.s') } },
    ]));
    const params = node(r.design, 'ecs_service_s').params!;
    expect(params).not.toHaveProperty('instances');
    expect(params).not.toHaveProperty('maxInstances');
    for (const v of Object.values(params)) expect(v).not.toBe(0);
    expect(r.notes.filter((n) => n.id === 'import.unknownValue').map((n) => n.args!.from).sort()).toEqual(['aws_appautoscaling_target.t.max_capacity', 'aws_appautoscaling_target.t.min_capacity', 'aws_ecs_service.s.desired_count']);
    expect(parseDesign(r.design).ok).toBe(true);
  });

  it('an unknown instance class gives no table values', () => {
    const r = importTerraform(ecsPlan([{ address: 'aws_db_instance.main', values: { engine: 'postgres' }, unknown: ['instance_class'] }]));
    expect(node(r.design, 'db_instance_main').params).toEqual({ replicas: 0, failover: 'off' });
  });
});

describe('designs that were not imported', () => {
  it('every example design parses and formats back to the same bytes, with no source field', () => {
    const dir = join(ROOT, 'examples', 'designs');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const text = readFileSync(join(dir, f), 'utf8');
      const p = parseDesign(JSON.parse(text));
      if (!p.ok) throw new Error(`${f}: ${JSON.stringify(p.issues)}`);
      expect(formatJson(p.value), f).toBe(text);
      expect(text, f).not.toContain('"source"');
    }
  });

  it('an empty or unknown source field is rejected (the format stays strict)', () => {
    const d = importTerraform(plan([{ address: 'aws_lb.web' }])).design;
    const bad = (patch: (x: Design) => void) => {
      const x = JSON.parse(JSON.stringify(d)) as Design;
      patch(x);
      return parseDesign(x).ok;
    };
    expect(bad(() => {})).toBe(true);
    expect(bad((x) => ((x.nodes[1].source as unknown as Record<string, unknown>).extra = 1))).toBe(false);
    expect(bad((x) => (x.nodes[1].source = {} as never))).toBe(false);
  });
});

describe('review fixes', () => {
  it('a task with cpu 0 (EC2 launch type, task cpu unset) gets no CPU-based estimates', () => {
    const r = importTerraform(ecsPlan([
      { address: 'aws_ecs_service.s', values: { desired_count: 2 }, expressions: { load_balancer: [{ target_group_arn: refs('aws_lb_target_group.a') }], task_definition: refs('aws_ecs_task_definition.t') } },
      { address: 'aws_ecs_task_definition.t', values: { cpu: '0', memory: '512' } },
    ]));
    expect(node(r.design, 'ecs_service_s').params).not.toHaveProperty('serviceMs');
    expect(parseDesign(r.design).ok).toBe(true);
  });

  it('the answer file can set params on the client and draw lines from it', () => {
    const r = importTerraform(fixturePlan(), { answers: answers({ nodes: { client: { deadline: 'propagate' } }, edges: [{ from: 'client', to: 'ecs_service_api' }] }) });
    expect(node(r.design, 'client').params).toEqual({ deadline: 'propagate' });
    expect(r.design.edges.filter((e) => e.from === 'client').map((e) => e.to).sort()).toEqual(['ecs_service_api', 'lb_web']);
    expect(parseDesign(r.design).ok).toBe(true);
  });

  it('a node merged from 600 instances, and a very long address, still give a valid design', () => {
    const rs: R[] = [];
    for (let i = 0; i < 600; i++) rs.push({ address: `aws_ecs_service.s[${i}]`, values: { desired_count: 1 }, expressions: { load_balancer: [{ target_group_arn: refs('aws_lb_target_group.a') }] } });
    const many = importTerraform(ecsPlan(rs, ['aws_ecs_service.s', 'aws_appautoscaling_target.t', 'aws_appautoscaling_policy.p']));
    const svc = many.design.nodes.find((n) => n.kind === 'service')!;
    expect(svc.params!.instances).toBe(600);
    expect(parseDesign(many.design).ok).toBe(true);
    expect(svc.source!.from).toContain('aws_ecs_service.s[599]');
    const key = 'k'.repeat(400);
    const long = importTerraform(ecsPlan([{ address: `aws_db_instance.main["${key}"]`, values: { engine: 'postgres' } }]));
    expect(parseDesign(long.design).ok).toBe(true);
    expect(long.design.nodes.find((n) => n.kind === 'database')!.source!.from).toEqual([`aws_db_instance.main["${key}"]`]);
  });
});

describe('loadsketch import terraform --answers (CLI)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loadsketch-answers-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const cli = (...args: string[]) => spawnSync(process.execPath, ['cli/loadsketch.ts', ...args], { cwd: ROOT, encoding: 'utf8' });

  it('applies the answers; a bad answer file names itself', () => {
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify({ schema: ANSWERS_SCHEMA, nodes: { ecs_service_api: { maxInstances: 20 } } }));
    const out = join(dir, 'x.json');
    const r = cli('import', 'terraform', PLAN, '--answers', good, '--out', out);
    expect(r.status, r.stderr).toBe(0);
    expect(node(JSON.parse(readFileSync(out, 'utf8')), 'ecs_service_api').params!.maxInstances).toBe(20);
    expect(cli('validate', out).status).toBe(0);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ schema: ANSWERS_SCHEMA, nodes: { nope: { instances: 1 } } }));
    const b = cli('import', 'terraform', PLAN, '--answers', bad);
    expect(b.status).not.toBe(0);
    expect(b.stderr).toContain(bad);
    expect(b.stderr).toContain('nope');
  });
});
