// M29b #10 #12 #13 #41: instances of one count/for_each block are merged only when they act the same,
// and databases never are (each holds its own data).
import { describe, expect, it } from 'vitest';
import { parseDesign } from '../../src/core/index.ts';
import { buildGraph, memberLinks } from '../../src/import/terraform/graph.ts';
import { importTerraform } from '../../src/import/terraform/index.ts';
import { parsePlan } from '../../src/import/terraform/plan.ts';
import { cpuMs } from '../helpers.ts';
import { plan, type R } from './plan-helper.ts';

const lb: R = { address: 'aws_lb.web', values: { internal: false } };
const kinds = (r: ReturnType<typeof importTerraform>, kind: string) => r.design.nodes.filter((n) => n.kind === kind);

describe('merging instances', () => {
  it('#41 aws_db_instance.db[0] and [1] are two databases', () => {
    const db = (i: number): R => ({ address: `aws_db_instance.db[${i}]`, values: { engine: 'postgres', instance_class: 'db.t3.medium', multi_az: false } });
    const r = importTerraform(plan([lb, db(0), db(1)]));
    expect(kinds(r, 'database')).toHaveLength(2);
    expect(r.notes.map((n) => n.id)).not.toContain('import.merged');
  });
  it('#12 two Aurora clusters of one block are two databases', () => {
    const c = (i: number): R => ({ address: `aws_rds_cluster.c[${i}]`, values: { engine: 'aurora-postgresql' } });
    const inst = (i: number): R => ({ address: `aws_rds_cluster_instance.i[${i}]`, values: { instance_class: 'db.r6g.large' }, expressions: { cluster_identifier: { references: ['aws_rds_cluster.c[count.index].id', 'aws_rds_cluster.c'] } } });
    const r = importTerraform(plan([lb, c(0), c(1), inst(0), inst(1)]));
    const dbs = kinds(r, 'database');
    expect(dbs).toHaveLength(2);
    for (const d of dbs) expect(r.facts[d.id].instanceCount.value).toBe(1);
  });
  it('#13 queues of one block with different settings stay apart', () => {
    const q = (k: string, v: Record<string, unknown>): R => ({ address: `aws_sqs_queue.q["${k}"]`, values: v });
    const r = importTerraform(plan([lb, q('a', { fifo_queue: true, visibility_timeout_seconds: 30 }), q('b', { visibility_timeout_seconds: 300 })]));
    expect(kinds(r, 'queue')).toHaveLength(2);
  });
  it('#10 two functions with reserved 100 each: one node with 200; different reserved stay apart', () => {
    const fn = (i: number, reserved: number): R => ({ address: `aws_lambda_function.f[${i}]`, values: { reserved_concurrent_executions: reserved } });
    const same = importTerraform(plan([lb, fn(0, 100), fn(1, 100)]));
    expect(kinds(same, 'function').map((n) => n.params?.maxConcurrency)).toEqual([200]);
    const diff = importTerraform(plan([lb, fn(0, 100), fn(1, 50)]));
    expect(kinds(diff, 'function').map((n) => n.params?.maxConcurrency).sort()).toEqual([100, 50].sort());
  });
  it('Lambdas of two module instances, each with its own database, stay two', () => {
    const res = (address: string, type: string, name: string, values: Record<string, unknown>) => ({ address, mode: 'managed', type, name, values, sensitive_values: {} });
    const r = importTerraform({
      format_version: '1.2',
      planned_values: { root_module: {
        resources: [res('aws_lb.web', 'aws_lb', 'web', { internal: false })],
        child_modules: ['a', 'b'].map((k) => ({ address: `module.app["${k}"]`, resources: [
          res(`module.app["${k}"].aws_lambda_function.f`, 'aws_lambda_function', 'f', { reserved_concurrent_executions: 10 }),
          res(`module.app["${k}"].aws_db_instance.d`, 'aws_db_instance', 'd', { engine: 'postgres', instance_class: 'db.t3.medium', multi_az: false }),
        ] })),
      } },
      configuration: { root_module: {
        resources: [{ address: 'aws_lb.web', mode: 'managed', type: 'aws_lb', name: 'web', expressions: {} }],
        module_calls: { app: { module: { resources: [
          { address: 'aws_lambda_function.f', mode: 'managed', type: 'aws_lambda_function', name: 'f', expressions: { environment: [{ variables: { references: ['aws_db_instance.d.address', 'aws_db_instance.d'] } }] } },
          { address: 'aws_db_instance.d', mode: 'managed', type: 'aws_db_instance', name: 'd', expressions: {} },
        ] } } },
      } },
    });
    const fns = kinds(r, 'function');
    expect(fns).toHaveLength(2);
    for (const f of fns) expect(r.design.edges.filter((e) => e.from === f.id && kinds(r, 'database').some((d) => d.id === e.to))).toHaveLength(1);
  });
  it('a merged group scales n times as fast, and stops at the loadsketch limit with a note', () => {
    const fn = (i: number, reserved: number): R => ({ address: `aws_lambda_function.f[${i}]`, values: { reserved_concurrent_executions: reserved } });
    const two = importTerraform(plan([lb, fn(0, 900), fn(1, 900)]));
    expect(kinds(two, 'function')[0].params).toMatchObject({ maxConcurrency: 1800, scalePer10s: 2000 });
    const many = importTerraform(plan([lb, ...Array.from({ length: 101 }, (_, i) => fn(i, 1000))]));
    expect(kinds(many, 'function')[0].params).toMatchObject({ maxConcurrency: 100_000, scalePer10s: 100_000 });
    expect(many.notes.filter((n) => n.id === 'import.approx.capped').map((n) => n.args!.param).sort()).toEqual(['maxConcurrency', 'scalePer10s']);
    expect(() => parseDesign(many.design)).not.toThrow();
  });
});

describe('module instances split all the way', () => {
  type M = { name: string; type: string; values?: Record<string, unknown>; expressions?: Record<string, unknown> };
  /** Two instances (a, b) of one module with these resources, behind a public load balancer. */
  const modules = (rs: M[]) => {
    const res = (address: string, type: string, name: string, values: Record<string, unknown>) => ({ address, mode: 'managed', type, name, values, sensitive_values: {} });
    return {
      format_version: '1.2',
      planned_values: { root_module: {
        resources: [res('aws_lb.web', 'aws_lb', 'web', { internal: false })],
        child_modules: ['a', 'b'].map((k) => ({ address: `module.app["${k}"]`, resources: rs.map((r) => res(`module.app["${k}"].${r.type}.${r.name}`, r.type, r.name, r.values ?? {})) })),
      } },
      configuration: { root_module: {
        resources: [{ address: 'aws_lb.web', mode: 'managed', type: 'aws_lb', name: 'web', expressions: {} }],
        module_calls: { app: { module: { resources: rs.map((r) => ({ address: `${r.type}.${r.name}`, mode: 'managed', type: r.type, name: r.name, expressions: r.expressions ?? {} })) } } },
      } },
    };
  };
  const env = (a: string) => ({ environment: [{ variables: { references: [`${a}.arn`, a] } }] });
  const db: M = { name: 'd', type: 'aws_db_instance', values: { engine: 'postgres', instance_class: 'db.t3.medium', multi_az: false } };
  /** No function calls more than one function: a merged caller would fan out to both backends. */
  const noFanOut = (r: ReturnType<typeof importTerraform>) => {
    const fns = new Set(kinds(r, 'function').map((n) => n.id));
    for (const f of fns) expect(r.design.edges.filter((e) => e.from === f && fns.has(e.to))).toHaveLength(r.design.edges.some((e) => e.from === f && fns.has(e.to)) ? 1 : 0);
  };
  it('a caller of an alias splits when the alias\'s function does (P1)', () => {
    const r = importTerraform(modules([
      { name: 'caller', type: 'aws_lambda_function', expressions: env('aws_lambda_alias.live') },
      { name: 'live', type: 'aws_lambda_alias', expressions: { function_name: { references: ['aws_lambda_function.backend.function_name', 'aws_lambda_function.backend'] } } },
      { name: 'backend', type: 'aws_lambda_function', expressions: env('aws_db_instance.d') },
      db,
    ]));
    expect(kinds(r, 'function')).toHaveLength(4);
    noFanOut(r);
  });
  it('a chain of 22 functions splits to its first function (P2)', () => {
    const chain: M[] = Array.from({ length: 22 }, (_, i) => ({ name: `f${i + 1}`, type: 'aws_lambda_function', expressions: env(i < 21 ? `aws_lambda_function.f${i + 2}` : 'aws_db_instance.d') }));
    const r = importTerraform(modules([...chain, db]));
    expect(kinds(r, 'function')).toHaveLength(44);
    noFanOut(r);
  });
});

describe('member links stay linear', () => {
  it('1500 counted functions with one alias each import fast', () => {
    const n = 1500;
    const rs: R[] = [{ address: 'aws_lb.web', values: { internal: false } }];
    for (let i = 0; i < n; i++) {
      rs.push({ address: `aws_lambda_function.f[${i}]`, values: { reserved_concurrent_executions: 1 } });
      rs.push({ address: `aws_lambda_alias.a[${i}]`, expressions: { function_name: { references: ['aws_lambda_function.f.function_name', 'aws_lambda_function.f'] } } });
    }
    const p = plan(rs);
    let r: ReturnType<typeof importTerraform> | undefined;
    const ms = cpuMs(() => (r = importTerraform(p)));
    // About 1.5 s before cef0757 and with this fix; 25 s with N² member links. 8000 ms, not 4000: a
    // A run on a loaded machine went over 4000 ms of CPU; 8000 still catches the N² case.
    expect(ms, `${ms} ms`).toBeLessThan(8000);
    expect(r!.design.nodes.filter((x) => x.kind === 'function')).toHaveLength(1);
  }, 60_000); // the budget is CPU time (AGENTS.md); wall time grows on a busy machine
});

describe('member links fall back as referrers() does', () => {
  it('an alias with key b of functions a, b belongs to both; callers of two module instances stay apart', () => {
    const res = (address: string, type: string, name: string, values: Record<string, unknown>, index?: string) => ({ address, mode: 'managed', type, name, ...(index ? { index } : {}), values, sensitive_values: {} });
    const mod = (m: string, memA: number) => ({ address: `module.app["${m}"]`, resources: [
      res(`module.app["${m}"].aws_lambda_function.f["a"]`, 'aws_lambda_function', 'f', { memory_size: memA }, 'a'),
      res(`module.app["${m}"].aws_lambda_function.f["b"]`, 'aws_lambda_function', 'f', { memory_size: 128 }, 'b'),
      res(`module.app["${m}"].aws_lambda_alias.live["b"]`, 'aws_lambda_alias', 'live', {}, 'b'),
      res(`module.app["${m}"].aws_lambda_function.caller`, 'aws_lambda_function', 'caller', {}),
    ] });
    const r = importTerraform({
      format_version: '1.2',
      planned_values: { root_module: { resources: [res('aws_lb.web', 'aws_lb', 'web', { internal: false })], child_modules: [mod('x', 128), mod('y', 256)] } },
      configuration: { root_module: {
        resources: [{ address: 'aws_lb.web', mode: 'managed', type: 'aws_lb', name: 'web', expressions: {} }],
        module_calls: { app: { module: { resources: [
          { address: 'aws_lambda_function.f', mode: 'managed', type: 'aws_lambda_function', name: 'f', expressions: {} },
          { address: 'aws_lambda_alias.live', mode: 'managed', type: 'aws_lambda_alias', name: 'live', expressions: { function_name: { references: ['aws_lambda_function.f.function_name', 'aws_lambda_function.f'] } } },
          { address: 'aws_lambda_function.caller', mode: 'managed', type: 'aws_lambda_function', name: 'caller', expressions: { environment: [{ variables: { references: ['aws_lambda_alias.live.arn', 'aws_lambda_alias.live'] } }] } },
        ] } } },
      } },
    });
    const fns = new Set(kinds(r, 'function').map((n) => n.id));
    const callers = kinds(r, 'function').filter((n) => r.nodeFrom[n.id].some((a) => a.endsWith('.caller')));
    expect(callers).toHaveLength(2);
    for (const c of callers) expect(new Set(r.design.edges.filter((e) => e.from === c.id && fns.has(e.to)).map((e) => r.nodeFrom[e.to].map((a) => a.split('.')[0]).join())).size).toBe(1);
  });
});

describe('member links group as referrers() does', () => {
  const to = (rs: R[], from: string) => memberLinks(buildGraph(parsePlan(plan(rs)))).filter((l) => l.from === from).map((l) => l.to).sort();
  const cluster = (k: string): R => ({ address: `aws_rds_cluster.c["${k}"]`, values: { engine: 'aurora-postgresql' } });
  const byCluster = { references: ['aws_rds_cluster.c.id', 'aws_rds_cluster.c'] };
  it('proxy targets with the cluster\'s key do not take the fallback from a cluster instance', () => {
    const rs: R[] = [cluster('a'), cluster('b'),
      { address: 'aws_rds_cluster_instance.i["c"]', values: { instance_class: 'db.r6g.large' }, expressions: { cluster_identifier: byCluster } },
      { address: 'aws_db_proxy_target.t["a"]', expressions: { db_cluster_identifier: byCluster } },
      { address: 'aws_db_proxy_target.t["b"]', expressions: { db_cluster_identifier: byCluster } }];
    expect(to(rs, 'aws_rds_cluster_instance.i["c"]')).toEqual(['aws_rds_cluster.c["a"]', 'aws_rds_cluster.c["b"]']);
    expect(to(rs, 'aws_db_proxy_target.t["a"]')).toEqual(['aws_rds_cluster.c["a"]']);
  });
  it('a member with the target\'s key in another expression wins over the fallback', () => {
    const fn = (k: string): R => ({ address: `aws_lambda_function.f["${k}"]`, values: { reserved_concurrent_executions: 10 } });
    const rs: R[] = [fn('a'), fn('b'),
      { address: 'aws_lambda_alias.first["a"]', expressions: { function_name: { references: ['aws_lambda_function.f.function_name', 'aws_lambda_function.f'] } } },
      { address: 'aws_lambda_alias.second["b"]', expressions: { function_name: { references: ['var.pick', 'aws_lambda_function.f.function_name', 'aws_lambda_function.f'] } } }];
    expect(to(rs, 'aws_lambda_alias.first["a"]')).toEqual(['aws_lambda_function.f["a"]']);
    expect(to(rs, 'aws_lambda_alias.second["b"]')).toEqual(['aws_lambda_function.f["b"]']);
  });
});
