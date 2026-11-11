// Static checks on an import: C1, C3, C4, C9, C10, how sure each finding is, the
// Markdown report and --strict. Small plans: ALB -> ECS service -> RDS, the service reaching the DB
// through an environment variable in its task definition (a presumed line).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { importReport } from '../../src/i18n/importReport.ts';
import { IMPORT_MESSAGE_IDS } from '../../src/i18n/importMessages.ts';
import { ANSWERS_SCHEMA, blocking, importTerraform, parseAnswers, runChecks, type Answers, type Finding } from '../../src/import/terraform/index.ts';
import { ecsPlan, plan, refs, type R } from './plan-helper.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const FIXTURES = join(import.meta.dirname, 'fixtures');
const PLAN = join(FIXTURES, 'ecs-rds.plan.json');
const answers = (a: Omit<Answers, 'schema'>): Answers => parseAnswers({ schema: ANSWERS_SCHEMA, ...a });
const SVC = 'ecs_service_s';
const DB = 'db_instance_main';

/** The service (max `max` tasks) reads DB_HOST (or `env`) = aws_db_instance.main.address. */
function dbPlan(o: { max?: number; min?: number; db?: Record<string, unknown>; extra?: R[]; env?: string } = {}) {
  return ecsPlan([
    { address: 'aws_ecs_service.s', values: { desired_count: 2 }, expressions: { load_balancer: [{ target_group_arn: refs('aws_lb_target_group.a') }], task_definition: refs('aws_ecs_task_definition.t') } },
    { address: 'aws_ecs_task_definition.t', values: { cpu: '512', memory: '1024' }, expressions: { container_definitions: { references: ['aws_db_instance.main.address', 'aws_db_instance.main'] } } },
    { address: 'aws_appautoscaling_target.t', values: { service_namespace: 'ecs', min_capacity: o.min ?? 2, max_capacity: o.max ?? 8 }, expressions: { resource_id: refs('aws_ecs_service.s') } },
    { address: 'aws_db_instance.main', values: { engine: 'postgres', instance_class: 'db.t3.medium', multi_az: false, ...o.db } },
    ...(o.extra ?? []),
  ]);
}
const check = (fs: Finding[], c: string, node?: string) => fs.filter((f) => f.check === c && (!node || f.node === node));
const run = (p: unknown, a?: Answers) => {
  const r = importTerraform(p, a ? { answers: a } : {});
  const peak = a?.traffic?.peakRps;
  return runChecks(r, peak ? { peakRps: { value: peak, origin: { evidence: 'answer' } } } : {});
};

describe('C1: connection pools against max_connections', () => {
  it('triggers above the AWS formula (50 x 10 = 500 > 450); a pool estimate keeps it an assumption, at most medium', () => {
    const [f] = check(run(dbPlan({ max: 50 })), 'C1');
    expect(f).toMatchObject({ severity: 'medium', certainty: 'assumption', node: DB, args: { total: 500, limit: 450 } });
    expect(f.inputs.map((i) => [i.name, i.origin.evidence])).toEqual([[`${SVC}.maxInstances`, 'iac'], [`${SVC}.pool`, 'estimate'], [`${DB}.maxConnectionsAllMemory`, 'aws-default']]);
    expect(f.lines).toEqual([{ id: `${SVC}-${DB}`, kind: 'presumed' }]);
  });

  it('does not trigger below both bounds (8 x 10 = 80)', () => {
    expect(check(run(dbPlan({ max: 8 })), 'C1')).toEqual([]);
  });

  it('between the bounds (420 > 414, < 450) it is only an assumption, from the OS reserve', () => {
    const r = check(run(dbPlan({ max: 42 })), 'C1');
    expect(r).toMatchObject([{ id: 'check.C1.reserve', certainty: 'assumption', severity: 'medium', args: { total: 420, limit: 414, high: 450 } }]);
  });

  it('the line confirmed and the pool measured in the answer file: definite and high, and --strict blocks it', () => {
    const fs = run(dbPlan({ max: 50 }), answers({ edges: [{ from: SVC, to: DB, bulkhead: { value: 10, evidence: 'measured' } }] }));
    expect(check(fs, 'C1')).toMatchObject([{ severity: 'high', certainty: 'definite' }]);
    expect(blocking(fs).map((f) => f.check)).toEqual(['C1']);
  });

  it('a pool from the answer file that is not measured: "user", still medium', () => {
    const fs = run(dbPlan({ max: 50 }), answers({ edges: [{ from: SVC, to: DB, bulkhead: 10 }] }));
    expect(check(fs, 'C1')).toMatchObject([{ severity: 'medium', certainty: 'user' }]);
    expect(blocking(fs)).toEqual([]);
  });

  it('UNUSED_DB_HOST: an environment variable naming the DB is only a presumed line, so C1 stays an assumption', () => {
    // The task definition references the DB in a variable the code never reads; nothing in the plan
    // can tell. Without an answer file, the line is presumed and C1 cannot be definite.
    const p = dbPlan({ max: 50, extra: [{ address: 'aws_ecs_task_definition.t', values: { cpu: '512', memory: '1024' }, expressions: { container_definitions: { references: ['aws_db_instance.main.address', 'aws_db_instance.main'] } } }] });
    const fs = run(p);
    expect(check(fs, 'C1')).toMatchObject([{ certainty: 'assumption', severity: 'medium' }]);
    expect(blocking(fs)).toEqual([]);
  });

  it('no line to the DB, or no max_connections: incomplete, not "no problem"', () => {
    const lonely = run(ecsPlan([{ address: 'aws_db_instance.main', values: { engine: 'postgres', instance_class: 'db.t3.medium', multi_az: true } }]));
    expect(check(lonely, 'C1')).toMatchObject([{ certainty: 'incomplete', severity: 'info', args: { missing: 'lines' } }]);
    const unknownClass = run(dbPlan({ max: 50, db: { instance_class: 'db.x2iedn.32xlarge' } }));
    expect(check(unknownClass, 'C1')).toMatchObject([{ certainty: 'incomplete', args: { missing: 'max_connections' } }]);
  });
});

describe('C3: single AZ', () => {
  it('a single-AZ DB is a definite medium; with an Environment = prod tag it is high', () => {
    expect(check(run(dbPlan()), 'C3', DB)).toMatchObject([{ severity: 'medium', certainty: 'definite' }]);
    expect(check(run(dbPlan({ db: { tags: { Environment: 'prod' } } })), 'C3', DB)).toMatchObject([{ severity: 'high', certainty: 'definite' }]);
  });

  it('a Multi-AZ DB is not flagged', () => {
    expect(check(run(dbPlan({ db: { multi_az: true } })), 'C3')).toEqual([]);
  });

  it('a service whose subnets are all in one AZ is flagged; two AZs are not', () => {
    const svc = (zones: string[]) =>
      dbPlan({ extra: [
        ...zones.map((z, i) => ({ address: `aws_subnet.s${i}`, values: { availability_zone: z } })),
        { address: 'aws_ecs_service.s', values: { desired_count: 2 }, expressions: { load_balancer: [{ target_group_arn: refs('aws_lb_target_group.a') }], task_definition: refs('aws_ecs_task_definition.t'), network_configuration: [{ subnets: refs(...zones.map((_, i) => `aws_subnet.s${i}`)) }] } },
      ] });
    expect(check(run(svc(['us-east-1a'])), 'C3', SVC)).toMatchObject([{ severity: 'medium', certainty: 'definite', args: { zone: 'us-east-1a' } }]);
    expect(check(run(svc(['us-east-1a', 'us-east-1b'])), 'C3', SVC)).toEqual([]);
  });
});

describe('C4: autoscaling ceiling against the peak', () => {
  it('without a peak: the most rps it can take, as info', () => {
    // 8 tasks x 8 at a time / 10 ms x 0.7 (0.5 vCPU task: table estimates).
    expect(check(run(dbPlan()), 'C4')).toMatchObject([{ id: 'check.C4.max', severity: 'info', certainty: 'assumption', args: { rps: 4480 } }]);
  });

  it('a peak above it triggers (capped at medium: the per-task capacity is an estimate); a peak below does not', () => {
    expect(check(run(dbPlan(), answers({ traffic: { peakRps: 100_000 } })), 'C4')).toMatchObject([{ id: 'check.C4.short', severity: 'medium', certainty: 'assumption', args: { rps: 4480, peak: 100_000 } }]);
    expect(check(run(dbPlan(), answers({ traffic: { peakRps: 100 } })), 'C4')).toEqual([]);
  });

  it('min = max: autoscaling that cannot grow', () => {
    expect(check(run(dbPlan({ min: 4, max: 4 })), 'C4').map((f) => f.id)).toContain('check.C4.noRoom');
    expect(check(run(dbPlan({ min: 2, max: 8 })), 'C4').map((f) => f.id)).not.toContain('check.C4.noRoom');
  });
});

describe('C9: slow failure detection', () => {
  it('30 s x 3 (provider defaults) = 90 s > 60 s: definite low; 10 s x 2 is not flagged', () => {
    expect(check(run(dbPlan()), 'C9')).toMatchObject([{ severity: 'low', certainty: 'definite', node: 'lb_web', args: { total: 90 } }]);
    const fast = dbPlan({ extra: [{ address: 'aws_lb_target_group.a', values: { protocol: 'HTTP', health_check: [{ interval: 10, unhealthy_threshold: 2 }] } }] });
    expect(check(run(fast), 'C9')).toEqual([]);
  });
});

describe('C10: autoscaled service on a single DB', () => {
  it('50 x 10 = 500 > 80% of 414: medium assumption; 8 x 10 = 80 is not flagged', () => {
    expect(check(run(dbPlan({ max: 50 })), 'C10')).toMatchObject([{ severity: 'medium', certainty: 'assumption', args: { total: 500, limit: 331 } }]);
    expect(check(run(dbPlan({ max: 8 })), 'C10')).toEqual([]);
  });
});

describe('the ECS fixture', () => {
  const expected = JSON.parse(readFileSync(join(FIXTURES, 'ecs-rds.expected.json'), 'utf8')) as { findings: { check: string; evidence: string; severity: string; on: string }[] };
  const confirm = answers({ edges: [{ from: 'ecs_service_api', to: 'db_instance_main' }] });
  const r = importTerraform(JSON.parse(readFileSync(PLAN, 'utf8')), { answers: confirm });
  const fs = runChecks(r);

  it('with the presumed line confirmed, finds what expected.json says', () => {
    const key = (x: { check: string; evidence: string; severity: string; on: string }) => `${x.check} ${x.on} ${x.severity} ${x.evidence}`;
    expect(fs.map((f) => key({ check: f.check, evidence: f.certainty, severity: f.severity, on: f.node })).sort()).toEqual(expected.findings.map(key).sort());
  });

  it('every finding has a message, advice and resource addresses', () => {
    for (const f of fs) {
      expect(IMPORT_MESSAGE_IDS, f.id).toContain(f.id);
      expect(IMPORT_MESSAGE_IDS, f.advice).toContain(f.advice);
      expect(f.resources.length, f.check).toBeGreaterThan(0);
    }
  });

  it('the report lists findings by severity, their inputs with evidence, and the guessed values', () => {
    const md = importReport(r, fs);
    expect(md).toMatch(/^# 匯入報告：terraform/);
    expect(md.indexOf('| C1 |')).toBeLessThan(md.indexOf('| C9 |'));
    expect(md).toContain('`ecs_service_api.pool` = 10（估計');
    expect(md).toContain('`db_instance_main.maxConnectionsAllMemory` = 450（AWS 預設');
    expect(md).toContain('## 猜的值');
    expect(md).toMatch(/\| ecs_service_api \| serviceMs \| 10 \|/);
    expect(md).toContain('推定線，答案檔確認');
  });
});

describe('loadsketch import terraform --report --strict (CLI)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loadsketch-checks-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const cli = (...args: string[]) => spawnSync(process.execPath, ['cli/loadsketch.ts', ...args], { cwd: ROOT, encoding: 'utf8' });
  const secrets = [...readFileSync(join(FIXTURES, 'ecs-rds', 'main.tf'), 'utf8').matchAll(/"([^"]*fixture-fake[^"]*)"/g)].map((m) => m[1]);

  it('--strict passes when the only high findings are assumptions', () => {
    const r = cli('import', 'terraform', PLAN, '--out', join(dir, 'x.json'), '--strict');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('C1');
  });

  it('--strict fails on a definite high finding', () => {
    const plan = join(dir, 'p.json');
    writeFileSync(plan, JSON.stringify(dbPlan({ max: 50 })));
    const ans = join(dir, 'a.json');
    writeFileSync(ans, JSON.stringify({ schema: ANSWERS_SCHEMA, edges: [{ from: SVC, to: DB, bulkhead: { value: 10, evidence: 'measured' } }] }));
    expect(cli('import', 'terraform', plan, '--answers', ans, '--out', join(dir, 'y.json')).status).toBe(0);
    const r = cli('import', 'terraform', plan, '--answers', ans, '--out', join(dir, 'y.json'), '--strict');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--strict');
  });

  it('no fake secret from the fixture reaches the design, the report, stdout, stderr or an error message', () => {
    expect(secrets.length).toBeGreaterThanOrEqual(2);
    const out = join(dir, 'z.json');
    const md = join(dir, 'z.md');
    const runs = [
      cli('import', 'terraform', PLAN, '--out', out, '--report', md, '--json'),
      cli('import', 'terraform', PLAN, '--answers', join(dir, 'missing.json')),
      cli('import', 'terraform', PLAN, '--lang', 'en', '--report', join(dir, 'en.md')),
    ];
    const texts = [...runs.flatMap((r) => [r.stdout, r.stderr]), readFileSync(out, 'utf8'), readFileSync(md, 'utf8'), readFileSync(join(dir, 'en.md'), 'utf8')];
    for (const s of secrets) for (const t of texts) expect(t.includes(s), s).toBe(false);
    expect(runs[1].status).not.toBe(0);
  });
});

// unknown or missing inputs never become a definite finding or a quiet "no problem".
describe('unknown inputs and replicas', () => {
  const MEASURED = (n: number) => answers({ edges: [{ from: SVC, to: DB, bulkhead: { value: n, evidence: 'measured' } }] });
  const db = (values: Record<string, unknown>, expressions: Record<string, unknown> = {}, unknown: string[] = []): R =>
    ({ address: 'aws_db_instance.main', values: { engine: 'postgres', instance_class: 'db.t3.medium', ...values }, expressions, unknown });

  it('multi_az set from a value unknown until apply: C3 incomplete, not a definite high in production', () => {
    const fs = run(dbPlan({ extra: [db({ tags: { Environment: 'prod' } }, { multi_az: { references: ['var.ha'] } }, ['multi_az'])] }));
    expect(check(fs, 'C3', DB)).toMatchObject([{ certainty: 'incomplete', args: { missing: 'multi_az' } }]);
    expect(blocking(fs)).toEqual([]);
    // Left out of the configuration (also in after_unknown): the AWS default, still definite.
    expect(check(run(dbPlan({ extra: [db({ tags: { Environment: 'prod' } }, {}, ['multi_az'])] })), 'C3', DB)).toMatchObject([{ certainty: 'definite', severity: 'high' }]);
  });

  it('a parameter group with max_connections = 1000 is the limit; one the plan cannot read leaves C1 incomplete', () => {
    const group = (value: string): R => ({ address: 'aws_db_parameter_group.pg', values: { name: 'pg', parameter: [{ name: 'max_connections', value }] } });
    const withGroup = (value: string) => dbPlan({ max: 50, extra: [db({ multi_az: true, parameter_group_name: 'pg' }, { parameter_group_name: refs('aws_db_parameter_group.pg') }), group(value)] });
    const fs = run(withGroup('1000'), MEASURED(10));
    expect(check(fs, 'C1')).toEqual([]);
    expect(blocking(fs)).toEqual([]);
    expect(check(run(withGroup('{DBInstanceClassMemory/9531392}'), MEASURED(10)), 'C1')).toMatchObject([{ certainty: 'incomplete', args: { missing: 'max_connections' } }]);
    // 50 x 10 = 500 > 450 still blocks with the default group.
    expect(blocking(run(dbPlan({ max: 50, db: { parameter_group_name: 'default.postgres16' } }), MEASURED(10))).map((f) => f.check)).toEqual(['C1']);
  });

  it('max_capacity unknown until apply: C1 and C4 incomplete, not the loadsketch default of 10 tasks', () => {
    const p = dbPlan({ extra: [{ address: 'aws_appautoscaling_target.t', values: { service_namespace: 'ecs', min_capacity: 2 }, expressions: { resource_id: refs('aws_ecs_service.s'), max_capacity: { references: ['var.max'] } }, unknown: ['max_capacity'] }] });
    const fs = run(p, MEASURED(10));
    expect(check(fs, 'C1')).toMatchObject([{ certainty: 'incomplete', args: { missing: `${SVC}.maxInstances` } }]);
    expect(check(fs, 'C4')).toMatchObject([{ certainty: 'incomplete', args: { missing: `${SVC}.maxInstances` } }]);
  });

  it('bulkhead 0 (no limit) bounds the pool by the caller concurrency, not by zero connections', () => {
    const [f] = check(run(dbPlan({ max: 60 }), MEASURED(0)), 'C1');
    expect(f).toMatchObject({ certainty: 'assumption', args: { total: 480, limit: 450 } });
    expect(f.inputs.map((i) => i.name)).toContain(`${SVC}.concurrency`);
  });

  it('a writer with a read replica (replicate_source_db) is not "a single DB with no replica" (C10)', () => {
    expect(check(run(dbPlan({ max: 50 })), 'C10')).toHaveLength(1);
    const replica: R = { address: 'aws_db_instance.replica', values: { instance_class: 'db.t3.medium', replicate_source_db: 'main' }, expressions: { replicate_source_db: { references: ['aws_db_instance.main.identifier', 'aws_db_instance.main'] } } };
    const r = importTerraform(dbPlan({ max: 50, extra: [replica] }));
    expect(r.facts[DB].readReplicas).toMatchObject({ value: 1 });
    // The replica is one of main's replicas, not a node of its own.
    expect(r.design.nodes.find((n) => n.id === DB)!.params).toMatchObject({ replicas: 1 });
    expect(r.folded.find((f) => f.address === 'aws_db_instance.replica')).toMatchObject({ into: DB, why: 'import.folded.readReplica' });
    expect(check(runChecks(r), 'C10')).toEqual([]);
  });

  it('C4 compares max_capacity with min_capacity, not with the start (desired 8, min 2, max 8 can scale)', () => {
    const svc = (desired: number, min: number): R[] => [
      { address: 'aws_ecs_service.s', values: { desired_count: desired }, expressions: { load_balancer: [{ target_group_arn: refs('aws_lb_target_group.a') }] } },
      { address: 'aws_appautoscaling_target.t', values: { service_namespace: 'ecs', min_capacity: min, max_capacity: 8 }, expressions: { resource_id: refs('aws_ecs_service.s') } },
    ];
    const noRoom = (fs: Finding[]) => fs.filter((f) => f.id === 'check.C4.noRoom');
    expect(noRoom(run(ecsPlan(svc(8, 2))))).toEqual([]);
    expect(noRoom(run(ecsPlan(svc(2, 8))))).toMatchObject([{ args: { n: 8 } }]);
  });
});

describe('parameter groups and bulkhead 0', () => {
  const MEASURED = (n: number) => answers({ edges: [{ from: SVC, to: DB, bulkhead: { value: n, evidence: 'measured' } }] });
  const group = (values: Record<string, unknown>, unknown: string[] = []): R => ({ address: 'aws_db_parameter_group.pg', values: { parameter: [{ name: 'max_connections', value: '1000' }], ...values }, unknown });
  const db = (values: Record<string, unknown>, expressions: Record<string, unknown>, unknown: string[] = [], cls = 'db.t3.medium'): R =>
    ({ address: 'aws_db_instance.main', values: { engine: 'postgres', instance_class: cls, multi_az: true, ...values }, expressions, unknown });

  it('a conditional that references a group but plans the default name uses the default formula', () => {
    const cond = { references: ['var.custom', 'aws_db_parameter_group.pg.name', 'aws_db_parameter_group.pg'] };
    const fs = run(dbPlan({ max: 50, extra: [db({ parameter_group_name: 'default.postgres16' }, { parameter_group_name: cond }), group({ name: 'pg' })] }), MEASURED(10));
    expect(blocking(fs).map((f) => f.check)).toEqual(['C1']);
  });

  it('a group name unknown until apply never matches a group whose name is also unknown', () => {
    const fs = run(dbPlan({ max: 50, extra: [db({}, { parameter_group_name: { references: ['var.pg'] } }, ['parameter_group_name']), group({}, ['name'])] }), MEASURED(10));
    expect(check(fs, 'C1')).toMatchObject([{ certainty: 'incomplete', args: { missing: 'max_connections' } }]);
  });

  it('bulkhead 0 from the answer file (not measured) keeps C1 "user" even with a measured concurrency', () => {
    const a = answers({ nodes: { [SVC]: { concurrency: { value: 8, evidence: 'measured' } } }, edges: [{ from: SVC, to: DB, bulkhead: 0 }] });
    const fs = run(dbPlan({ max: 60 }), a);
    expect(check(fs, 'C1')).toMatchObject([{ certainty: 'user', severity: 'medium', args: { total: 480 } }]);
    expect(blocking(fs)).toEqual([]);
  });

  it('an explicit max_connections applies to an instance class the table does not know', () => {
    const fs = run(dbPlan({ max: 50, extra: [db({ parameter_group_name: 'pg' }, { parameter_group_name: refs('aws_db_parameter_group.pg') }, [], 'db.x2iedn.32xlarge'), group({ name: 'pg', parameter: [{ name: 'max_connections', value: '100' }] })] }), MEASURED(10));
    expect(check(fs, 'C1')).toMatchObject([{ severity: 'high', certainty: 'definite', args: { total: 500, limit: 100 } }]);
  });
});

describe('sensitive attributes', () => {
  it('a sensitive parameter_group_name that references a custom group is unknown, not the default group', () => {
    const p = dbPlan({ max: 50, extra: [
      { address: 'aws_db_instance.main', values: { engine: 'postgres', instance_class: 'db.t3.medium', multi_az: true, parameter_group_name: 'pg' }, sensitive: { parameter_group_name: true }, expressions: { parameter_group_name: refs('aws_db_parameter_group.pg') } },
      { address: 'aws_db_parameter_group.pg', values: { name: 'pg', parameter: [{ name: 'max_connections', value: '1000' }] } },
    ] });
    const fs = run(p, answers({ edges: [{ from: SVC, to: DB, bulkhead: { value: 10, evidence: 'measured' } }] }));
    expect(check(fs, 'C1')).toMatchObject([{ certainty: 'incomplete', args: { missing: 'max_connections' } }]);
    expect(blocking(fs)).toEqual([]);
  });

  it('a sensitive multi_az is unknown (C3 incomplete), with its own note', () => {
    const p = dbPlan({ extra: [{ address: 'aws_db_instance.main', values: { engine: 'postgres', instance_class: 'db.t3.medium', multi_az: false, tags: { Environment: 'prod' } }, sensitive: { multi_az: true }, expressions: { multi_az: { references: ['var.ha'] } } }] });
    const r = importTerraform(p);
    expect(check(runChecks(r), 'C3', DB)).toMatchObject([{ certainty: 'incomplete' }]);
    expect(r.notes.map((n) => n.id)).toContain('import.sensitiveValue');
  });
});

// ---- M26: the checks for the other resource groups ----
const PG: R = { address: 'aws_db_instance.main', values: { engine: 'postgres', instance_class: 'db.t3.medium', multi_az: true } };
const LB: R = { address: 'aws_lb.web', values: { internal: false } };
const vars = (...refs: string[]) => [{ variables: { references: refs } }];
const toDb = ['aws_db_instance.main.address', 'aws_db_instance.main'];
const toProxy = ['aws_db_proxy.p.endpoint', 'aws_db_proxy.p'];
/** RDS Proxy in front of aws_db_instance.main; `pct` sets max_connections_percent. */
const proxy = (pct?: number): R[] => [
  { address: 'aws_db_proxy.p' },
  { address: 'aws_db_proxy_default_target_group.g', values: pct === undefined ? {} : { connection_pool_config: [{ max_connections_percent: pct }] }, expressions: { db_proxy_name: refs('aws_db_proxy.p'), ...(pct === undefined ? {} : { connection_pool_config: [{ max_connections_percent: {} }] }) } },
  { address: 'aws_db_proxy_target.t', expressions: { db_proxy_name: refs('aws_db_proxy.p'), db_instance_identifier: refs('aws_db_instance.main') } },
];
/** API Gateway (REST, integration timeout `gw` ms) -> Lambda f (timeout s, reserved concurrency) -> `env` refs. */
function fnPlan(o: { reserved?: number; timeout?: number; gw?: number; env?: string[]; extra?: R[] } = {}) {
  return plan([
    { address: 'aws_api_gateway_rest_api.a' },
    { address: 'aws_api_gateway_integration.i', values: { timeout_milliseconds: o.gw ?? 29000 }, expressions: { rest_api_id: refs('aws_api_gateway_rest_api.a'), timeout_milliseconds: {}, uri: { references: ['aws_lambda_function.f.invoke_arn', 'aws_lambda_function.f'] } } },
    { address: 'aws_lambda_function.f', values: { timeout: o.timeout ?? 10, memory_size: 1769, ...(o.reserved === undefined ? {} : { reserved_concurrent_executions: o.reserved }) }, expressions: { environment: vars(...(o.env ?? toDb)), timeout: {}, memory_size: {}, ...(o.reserved === undefined ? {} : { reserved_concurrent_executions: {} }) } },
    PG,
    ...(o.extra ?? []),
  ]);
}
const SQ = 'sqs_queue_q';
/** Lambda s sends to queue q (env), q feeds Lambda w (timeout `wt`) through an event source mapping. */
function queuePlan(q: Partial<R> = {}, o: { wt?: number; extra?: R[] } = {}) {
  return plan([
    LB,
    { address: 'aws_lambda_function.s', values: { timeout: 3 }, expressions: { environment: vars('aws_sqs_queue.q.url', 'aws_sqs_queue.q'), timeout: {} } },
    { address: 'aws_sqs_queue.q', values: { ...q.values }, expressions: { ...q.expressions }, unknown: q.unknown },
    { address: 'aws_lambda_event_source_mapping.m', expressions: { event_source_arn: refs('aws_sqs_queue.q'), function_name: refs('aws_lambda_function.w') } },
    { address: 'aws_lambda_function.w', values: { timeout: o.wt ?? 10 }, expressions: { timeout: {} } },
    ...(o.extra ?? []),
  ]);
}
const redrive = (n: number): Partial<R> => ({ values: { redrive_policy: JSON.stringify({ deadLetterTargetArn: 'arn:aws:sqs:us-east-1:1:d', maxReceiveCount: n }) }, expressions: { redrive_policy: { references: ['aws_sqs_queue.d.arn', 'aws_sqs_queue.d'] } } });
const DLQ: R = { address: 'aws_sqs_queue.d' };

/** A second RDS Proxy (q) on aws_db_instance.main at `pct`. */
const proxyQ = (pct: number): R[] => [
  { address: 'aws_db_proxy.q' },
  { address: 'aws_db_proxy_default_target_group.gq', values: { connection_pool_config: [{ max_connections_percent: pct }] }, expressions: { db_proxy_name: refs('aws_db_proxy.q'), connection_pool_config: [{ max_connections_percent: {} }] } },
  { address: 'aws_db_proxy_target.tq', expressions: { db_proxy_name: refs('aws_db_proxy.q'), db_instance_identifier: refs('aws_db_instance.main') } },
];

describe('answer lines and several proxies', () => {
  it('a direct and a proxy answer entry for one pair keep the line direct: C2 in either order', () => {
    const edges = [{ from: 'aws_lambda_function.f', to: 'aws_db_instance.main' }, { from: 'aws_lambda_function.f', to: 'aws_db_proxy.p' }];
    for (const order of [edges, [...edges].reverse()]) {
      const fs = run(fnPlan({ reserved: 1000, env: [], extra: proxy() }), answers({ edges: order }));
      expect(check(fs, 'C2')).toMatchObject([{ id: 'check.C2', args: { total: 1000, limit: 450 } }]);
    }
  });
  it('C1 uses the percent of the proxy the line goes through, not the first proxy', () => {
    const td = (refs: string[]): R => ({ address: 'aws_ecs_task_definition.t', values: { cpu: '512', memory: '1024' }, expressions: { container_definitions: { references: refs } } });
    // 20 x 10 = 200: over 10% of 450 (p), under 100% of 450 (q).
    const viaAnswer = run(dbPlan({ max: 20, extra: [td([]), ...proxy(10), ...proxyQ(100)] }), answers({ edges: [{ from: 'aws_ecs_service.s', to: 'aws_db_proxy.q' }] }));
    expect(check(viaAnswer, 'C1')).toEqual([]);
    const viaLine = run(dbPlan({ max: 20, extra: [td(['aws_db_proxy.q.endpoint', 'aws_db_proxy.q']), ...proxy(10), ...proxyQ(100)] }));
    expect(check(viaLine, 'C1')).toEqual([]);
    const viaP = run(dbPlan({ max: 20, extra: [td(toProxy), ...proxy(10), ...proxyQ(100)] }));
    expect(check(viaP, 'C1')).toMatchObject([{ id: 'check.C1.proxy', args: { total: 200, limit: 45 } }]);
  });
});

describe('several proxies, round 2', () => {
  const td = (refs: string[], name = 't'): R => ({ address: `aws_ecs_task_definition.${name}`, values: { cpu: '512', memory: '1024' }, expressions: { container_definitions: { references: refs } } });
  const toQ = ['aws_db_proxy.q.endpoint', 'aws_db_proxy.q'];
  it('pools through two proxies together are checked against max_connections', () => {
    // 30 x 10 through p (100%) + 30 x 10 through q (100%) = 600 > 450; each alone is 300.
    const s2: R[] = [td(toQ, 't2'), { address: 'aws_ecs_service.s2', values: { desired_count: 30 }, expressions: { task_definition: refs('aws_ecs_task_definition.t2') } }];
    const fs = check(run(dbPlan({ max: 30, extra: [td(toProxy), ...s2, ...proxy(100), ...proxyQ(100)] })), 'C1');
    expect(fs).toMatchObject([{ id: 'check.C1', args: { total: 600, limit: 450 } }]);
  });
  it('a function named through two proxies in the answer file is not direct: no C2', () => {
    const edges = [{ from: 'aws_lambda_function.f', to: 'aws_db_proxy.p' }, { from: 'aws_lambda_function.f', to: 'aws_db_proxy.q' }];
    expect(check(run(fnPlan({ reserved: 1000, env: [], extra: [...proxy(), ...proxyQ(100)] }), answers({ edges })), 'C2')).toEqual([]);
  });
  it('a caller of two proxies counts in both pools', () => {
    // A: 4 x 10 = 40 through p (10% = 45) or q (50% = 225); B: 20 x 10 = 200 through q. q gets 240 > 225.
    const s2: R[] = [td(toQ, 't2'), { address: 'aws_ecs_service.s2', values: { desired_count: 20 }, expressions: { task_definition: refs('aws_ecs_task_definition.t2') } }];
    const fs = check(run(dbPlan({ max: 4, min: 1, extra: [td([...toProxy, ...toQ]), ...s2, ...proxy(10), ...proxyQ(50)] })), 'C1');
    expect(fs).toMatchObject([{ args: { total: 240, limit: 225 } }]);
  });
  it('a caller of two proxies is held to the smaller share, in either reference order', () => {
    for (const refs of [[...toQ, ...toProxy], [...toProxy, ...toQ]]) {
      expect(check(run(dbPlan({ max: 20, extra: [td(refs), ...proxy(10), ...proxyQ(100)] })), 'C1')).toMatchObject([{ id: 'check.C1.proxy', args: { total: 200, limit: 45 } }]);
    }
  });
});

describe('C1 through RDS Proxy, and C2: functions against max_connections', () => {
  it('C2: 500 environments x 1 connection > 450, no proxy: medium assumption (connections per environment is an estimate)', () => {
    const [f, ...rest] = check(runChecks(importTerraform(fnPlan({ reserved: 500 }))), 'C2');
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ id: 'check.C2', node: DB, severity: 'medium', certainty: 'assumption', args: { total: 500, limit: 450 } });
    expect(f.inputs.map((i) => [i.name, i.origin.evidence])).toEqual([['lambda_function_f.maxConcurrency', 'iac'], ['lambda_function_f.connectionsPerEnvironment', 'estimate'], [`${DB}.maxConnectionsAllMemory`, 'aws-default']]);
  });

  it('C2 does not trigger with a small reserved concurrency, or when the function goes through RDS Proxy; C1 is not about functions', () => {
    const fs = (o: Parameters<typeof fnPlan>[0]) => runChecks(importTerraform(fnPlan(o)));
    expect(check(fs({ reserved: 40 }), 'C2')).toEqual([]);
    const viaProxy = fs({ reserved: 500, env: toProxy, extra: proxy() });
    const r = importTerraform(fnPlan({ reserved: 500, env: toProxy, extra: proxy() }));
    const line = r.design.edges.find((e) => e.from === 'lambda_function_f' && e.to === DB)!;
    expect(r.edges[line.id!].through).toBe('aws_db_proxy.p');
    expect(check(viaProxy, 'C2')).toEqual([]);
    expect(check(fs({ reserved: 500 }), 'C1')).toEqual([]);
  });

  it('C1 through the proxy: 50 x 10 = 500 > 100% of 450 (the proxy default share, AWS default)', () => {
    const p = dbPlan({ max: 50, extra: [{ address: 'aws_ecs_task_definition.t', values: { cpu: '512', memory: '1024' }, expressions: { container_definitions: { references: toProxy } } }, ...proxy()] });
    const [f, ...rest] = check(run(p), 'C1');
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ id: 'check.C1.proxy', certainty: 'assumption', args: { total: 500, limit: 450 } });
    expect(f.inputs.map((i) => [i.name, i.origin.evidence])).toContainEqual([`${DB}.proxyMaxConnectionsPercent`, 'aws-default']);
  });

  it('C1 through the proxy at 50%: 20 x 10 = 200 is under 50% of 414 = 207; 21 x 10 = 210 is between the bounds', () => {
    const p = (max: number) => dbPlan({ max, extra: [{ address: 'aws_ecs_task_definition.t', values: { cpu: '512', memory: '1024' }, expressions: { container_definitions: { references: toProxy } } }, ...proxy(50)] });
    expect(check(run(p(20)), 'C1')).toEqual([]);
    expect(check(run(p(21)), 'C1')).toMatchObject([{ id: 'check.C1.proxy.reserve', args: { total: 210, limit: 207, high: 225 } }]);
  });
});

describe('C3: Aurora and ElastiCache', () => {
  const aurora = (n: number) => runChecks(importTerraform(plan([
    LB,
    { address: 'aws_rds_cluster.c', values: { engine: 'aurora-postgresql' } },
    ...Array.from({ length: n }, (_, i) => ({ address: `aws_rds_cluster_instance.i[${i}]`, values: { instance_class: 'db.r6g.large' }, expressions: { cluster_identifier: refs('aws_rds_cluster.c') } })),
  ])));
  it('an Aurora cluster with one instance is a definite medium; with two it is not flagged', () => {
    expect(check(aurora(1), 'C3')).toMatchObject([{ id: 'check.C3.aurora', node: 'rds_cluster_c', severity: 'medium', certainty: 'definite', args: { n: 1 } }]);
    expect(check(aurora(2), 'C3')).toEqual([]);
  });
  const cache = (v: Record<string, unknown>) => check(runChecks(importTerraform(plan([LB, { address: 'aws_elasticache_replication_group.g', values: { node_type: 'cache.t3.micro', ...v }, expressions: Object.fromEntries(Object.keys(v).map((k) => [k, {}])) }]))), 'C3');
  it('a cache with one node, or two nodes and no automatic failover, is flagged; two with failover are not', () => {
    expect(cache({})).toMatchObject([{ id: 'check.C3.cacheSingle', certainty: 'definite' }]);
    expect(cache({ num_cache_clusters: 2, automatic_failover_enabled: false })).toMatchObject([{ id: 'check.C3.cacheFailover', certainty: 'definite' }]);
    expect(cache({ num_cache_clusters: 2, automatic_failover_enabled: true })).toEqual([]);
  });
});

describe('C5: timeouts in the wrong order', () => {
  it('the API Gateway integration gives up (29 s) before the function (60 s); 10 s is fine', () => {
    expect(check(runChecks(importTerraform(fnPlan({ timeout: 60 }))), 'C5')).toMatchObject([{ id: 'check.C5.caller', node: 'lambda_function_f', certainty: 'definite', args: { caller: 'api_gateway_rest_api_a', upS: 29, downS: 60 } }]);
    expect(check(runChecks(importTerraform(fnPlan({ timeout: 10 }))), 'C5')).toEqual([]);
  });
  it('SQS visibility 60 s < 6 x the consumer timeout 30 s; 180 s is enough', () => {
    const vis = (s: number) => check(runChecks(importTerraform(queuePlan({ values: { visibility_timeout_seconds: s, ...redrive(3).values }, expressions: { visibility_timeout_seconds: {}, ...redrive(3).expressions } }, { wt: 30, extra: [DLQ] }))), 'C5');
    expect(vis(60)).toMatchObject([{ id: 'check.C5.visibility', node: SQ, certainty: 'definite', args: { visibility: 60, timeout: 30, need: 180 } }]);
    expect(vis(180)).toEqual([]);
  });
});

describe('C6 and C7: retries and failures with nowhere to go', () => {
  const fs = (q: Partial<R>, extra: R[] = [DLQ]) => runChecks(importTerraform(queuePlan(q, { extra })));
  it('C6: SDK 3 x maxReceiveCount 5 = 15 > 10 is a medium assumption; 3 x 3 = 9 is not flagged', () => {
    expect(check(fs(redrive(5)), 'C6')).toMatchObject([{ id: 'check.C6', node: SQ, severity: 'medium', certainty: 'assumption', args: { total: 15 } }]);
    expect(check(fs(redrive(3)), 'C6')).toEqual([]);
  });
  it('C6: a redrive policy unknown until apply leaves maxReceiveCount unknown: incomplete', () => {
    const r = check(fs({ expressions: redrive(5).expressions, unknown: ['redrive_policy'] }), 'C6');
    expect(r).toMatchObject([{ certainty: 'incomplete', args: { missing: `${SQ}.maxReceiveCount` } }]);
  });
  it('C7: a queue with no redrive policy is flagged; with one it is not', () => {
    expect(check(fs({}, []), 'C7')).toMatchObject([{ id: 'check.C7.queue', node: SQ, certainty: 'definite' }]);
    expect(check(fs(redrive(3)), 'C7')).toEqual([]);
  });
  it('C7: a function called through SNS with no DLQ and no on_failure destination is flagged; with a DLQ it is not', () => {
    const perm: R = { address: 'aws_lambda_permission.sns', values: { principal: 'sns.amazonaws.com' }, expressions: { function_name: refs('aws_lambda_function.f') } };
    const fn = (v: Record<string, unknown>): R => ({ address: 'aws_lambda_function.f', values: { timeout: 3, ...v }, expressions: { timeout: {}, ...Object.fromEntries(Object.keys(v).map((k) => [k, {}])) } });
    expect(check(runChecks(importTerraform(plan([LB, fn({}), perm]))), 'C7')).toMatchObject([{ id: 'check.C7.async', node: 'lambda_function_f' }]);
    expect(check(runChecks(importTerraform(plan([LB, fn({ dead_letter_config: [{ target_arn: 'arn:aws:sqs:us-east-1:1:dlq' }] }), perm]))), 'C7')).toEqual([]);
  });
});

describe('C8, C9 (Route 53) and C11', () => {
  const http = (rate: number, reserved: number) => runChecks(importTerraform(plan([
    { address: 'aws_apigatewayv2_api.h' },
    { address: 'aws_apigatewayv2_stage.s', values: { default_route_settings: [{ throttling_rate_limit: rate, throttling_burst_limit: rate }] }, expressions: { api_id: refs('aws_apigatewayv2_api.h'), default_route_settings: [{ throttling_rate_limit: {}, throttling_burst_limit: {} }] } },
    { address: 'aws_apigatewayv2_integration.i', values: {}, expressions: { api_id: refs('aws_apigatewayv2_api.h'), integration_uri: refs('aws_lambda_function.f') } },
    { address: 'aws_lambda_function.f', values: { timeout: 3, memory_size: 1769, reserved_concurrent_executions: reserved }, expressions: { timeout: {}, memory_size: {}, reserved_concurrent_executions: {} } },
  ])));
  it('C8: a 200 rps throttle in front of 2 environments at 20 ms (100 rps) is flagged; 10 environments (500 rps) are not', () => {
    expect(check(http(200, 2), 'C8')).toMatchObject([{ id: 'check.C8', node: 'apigatewayv2_api_h_throttle', certainty: 'assumption', args: { rate: 200, target: 'lambda_function_f', capacity: 100 } }]);
    expect(check(http(200, 10), 'C8')).toEqual([]);
  });
  const dns = (hc: Record<string, unknown>) => check(runChecks(importTerraform(plan([
    LB,
    { address: 'aws_route53_health_check.h', values: hc, expressions: Object.fromEntries(Object.keys(hc).map((k) => [k, {}])) },
    { address: 'aws_route53_record.p', values: { failover_routing_policy: [{ type: 'PRIMARY' }] }, expressions: { failover_routing_policy: [{}], health_check_id: refs('aws_route53_health_check.h'), records: { references: ['aws_lb.web.dns_name', 'aws_lb.web'] } } },
  ]))), 'C9').filter((f) => f.id === 'check.C9.dns');
  it('C9: Route 53 30 s x 4 = 120 s > 90 s is a definite low; the defaults (30 s x 3 = 90 s) are not flagged', () => {
    expect(dns({ request_interval: 30, failure_threshold: 4 })).toMatchObject([{ node: 'route53_record_p', severity: 'low', certainty: 'definite', args: { total: 120 } }]);
    expect(dns({})).toEqual([]);
  });
  const table = (v: Record<string, unknown>, extra: R[] = []) => check(runChecks(importTerraform(plan([LB, { address: 'aws_dynamodb_table.t', values: { name: 't', ...v }, expressions: Object.fromEntries(Object.keys(v).map((k) => [k, {}])) }, ...extra]))), 'C11');
  it('C11: provisioned capacity with no autoscaling is a definite low; with an autoscaling target, or on demand, it is not', () => {
    expect(table({ billing_mode: 'PROVISIONED', read_capacity: 5, write_capacity: 5 })).toMatchObject([{ node: 'dynamodb_table_t', severity: 'low', certainty: 'definite' }]);
    expect(table({ billing_mode: 'PROVISIONED', read_capacity: 5, write_capacity: 5 }, [{ address: 'aws_appautoscaling_target.r', values: { service_namespace: 'dynamodb', resource_id: 'table/t' } }])).toEqual([]);
    expect(table({ billing_mode: 'PAY_PER_REQUEST' })).toEqual([]);
  });
});

describe.each(['lambda-sqs-rds', 'aurora-cache-multiaz'])('the %s fixture: findings', (set) => {
  const expected = JSON.parse(readFileSync(join(FIXTURES, `${set}.expected.json`), 'utf8')) as { findings: { check: string; evidence: string; severity: string; on: string }[]; notFindings: { check: string; on: string }[] };
  const fs = runChecks(importTerraform(JSON.parse(readFileSync(join(FIXTURES, `${set}.plan.json`), 'utf8'))));
  it('finds exactly what expected.json says, and nothing in notFindings', () => {
    const key = (x: { check: string; evidence: string; severity: string; on: string }) => `${x.check} ${x.on} ${x.severity} ${x.evidence}`;
    expect(fs.map((f) => key({ check: f.check, evidence: f.certainty, severity: f.severity, on: f.node })).sort()).toEqual(expected.findings.map(key).sort());
    for (const n of expected.notFindings) expect(fs.filter((f) => f.check === n.check && (n.on === '*' || f.node === n.on)), `${n.check} ${n.on}`).toEqual([]);
  });
  it('every finding has a message and advice', () => {
    for (const f of fs) {
      expect(IMPORT_MESSAGE_IDS, f.id).toContain(f.id);
      expect(IMPORT_MESSAGE_IDS, f.advice).toContain(f.advice);
    }
  });
});
