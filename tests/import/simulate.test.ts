// --simulate: with the peak from the answer file, run the engine on the imported
// design and judge it against the SLO (front-end p99 and failures, background failures and latency, the
// drain). No traffic: no simulation. Too little to measure: "not enough result", never pass.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { IMPORT_MESSAGE_IDS } from '../../src/i18n/importMessages.ts';
import { importReport } from '../../src/i18n/importReport.ts';
import { ANSWERS_SCHEMA, importScenario, importTerraform, parseAnswers, simulateImport, warmUpS, type Answers } from '../../src/import/terraform/index.ts';
import type { ParamValue } from '../../src/core/index.ts';
import { design, type NodeSpec } from '../helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const PLAN = join(import.meta.dirname, 'fixtures', 'ecs-rds.plan.json');
const tmp = mkdtempSync(join(tmpdir(), 'loadsketchulate-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const answers = (a: Omit<Answers, 'schema'>): Answers => parseAnswers({ schema: ANSWERS_SCHEMA, ...a });
const cli = (...args: string[]) => spawnSync(process.execPath, [join(ROOT, 'cli', 'loadsketch.ts'), ...args], { encoding: 'utf8', env: { ...process.env, LOADSKETCH_LANG: 'en' } });
const ecs = (a: Omit<Answers, 'schema'>) => {
  const ans = answers({ edges: [{ from: 'ecs_service_api', to: 'db_instance_main' }], ...a });
  const r = importTerraform(JSON.parse(readFileSync(PLAN, 'utf8')), { answers: ans });
  return { r, ans };
};
const FIXED = (mean: number) => ({ mean, cv: 0 });
/** client -> service -> queue -> worker (each message takes `ms`). */
const background = (worker: Record<string, ParamValue>, queue: Record<string, ParamValue> = {}) => {
  const nodes: NodeSpec[] = [['users', 'client'], ['api', 'service', { instances: 2, concurrency: 50, serviceMs: FIXED(2) }], ['q', 'queue', queue], ['w', 'worker', { instances: 4, concurrency: 50, ...worker }]];
  return design(nodes, [['users', 'api'], ['api', 'q'], ['q', 'w']]);
};

describe('the scenario', () => {
  it('covers the warm-up of every autoscaled node (2 checks + boot + warm), then measures, then drains with no new traffic', () => {
    const { r } = ecs({});
    expect(warmUpS(r.design)).toBe(260); // 2 × 60 + 120 + 20 (loadsketch defaults on the ECS service)
    const p = importScenario(r.design, answers({ traffic: { peakRps: 100 } }))!;
    expect(p).toMatchObject({ warmS: 260, drainS: 120 });
    expect(p.scenario).toMatchObject({ warmupS: 260, traffic: { rps: 100 }, events: [{ type: 'spike', atS: p.loadS, forS: 120, multiplier: 0 }] });
    // The engine caps warmupS at half the duration: the duration is at least twice the warm-up.
    expect(p.scenario.durationS).toBeGreaterThanOrEqual(2 * 260);
  });

  it('without traffic in the answer file there is no simulation (static checks only)', () => {
    const { r, ans } = ecs({});
    expect(simulateImport(r.design, ans)).toBeUndefined();
    const out = join(tmp, 'a.json');
    writeFileSync(out, JSON.stringify({ schema: ANSWERS_SCHEMA }));
    const c = cli('import', 'terraform', PLAN, '--answers', out, '--out', join(tmp, 'd.json'), '--simulate');
    expect(c.status, c.stderr).toBe(0);
    expect(c.stderr).toContain('no traffic.peakRps');
    expect(c.stderr).not.toContain('Simulation (');
  });
});

describe('the ECS fixture with traffic', () => {
  it('at 200 rps: requests reach RDS (through the presumed line) and it holds', () => {
    const { r, ans } = ecs({ traffic: { peakRps: 200 } });
    const s = simulateImport(r.design, ans)!;
    expect(s.sim.nodes.db_instance_main.arrivals).toBeGreaterThan(0);
    expect(s.verdict).toBe('pass');
    expect(s.criteria.every((c) => c.ok)).toBe(true);
  });


  it('the CLI prints the verdict and the report has a simulation section', () => {
    const a = join(tmp, 'peak.json');
    writeFileSync(a, JSON.stringify({ schema: ANSWERS_SCHEMA, traffic: { peakRps: 200 }, edges: [{ from: 'ecs_service_api', to: 'db_instance_main' }] }));
    const rep = join(tmp, 'r.md');
    const c = cli('import', 'terraform', PLAN, '--answers', a, '--out', join(tmp, 'd2.json'), '--report', rep, '--simulate');
    expect(c.status, c.stderr).toBe(0);
    expect(c.stderr).toContain('Holds');
    expect(readFileSync(rep, 'utf8')).toContain('## Simulation (200 rps)');
  });
});

describe('a high-traffic fixture', () => {
  it('lambda-sqs-rds at 10 000 rps (twice its 5000 rps gateway throttle): fails, with the throttled requests and the busiest component', () => {
    const ans = answers({ traffic: { peakRps: 10_000 } });
    const r = importTerraform(JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'lambda-sqs-rds.plan.json'), 'utf8')), { answers: ans });
    const s = simulateImport(r.design, ans)!;
    expect(s.verdict).toBe('fail');
    expect(s.criteria.find((c) => c.id === 'simulate.errorRate')).toMatchObject({ ok: false });
    expect(s.sim.summary.fail.rate_limited).toBeGreaterThan(0);
    expect(r.design.nodes.map((n) => n.id)).toContain(s.bottleneck!.node);
  }, 60_000); // about 11-13 s alone; over the 20 s default when the machine is busy (load 13 on 8 cores)
});

describe('background work', () => {
  it('low traffic with 5 s jobs: work still running when the load ends is not a failure if the drain clears it', () => {
    const d = background({ serviceMs: FIXED(5000) });
    const s = simulateImport(d, answers({ traffic: { peakRps: 10 } }))!;
    expect(s.sim.summary.asyncLatencyMs.count).toBeGreaterThan(1000);
    expect(s.criteria.find((c) => c.id === 'simulate.drain')).toMatchObject({ ok: true, args: { unfinished: 0 } });
    expect(s.verdict).toBe('pass');
  });

  it('every front-end request succeeds but every message ends in the DLQ: fail', () => {
    const d = background({ serviceMs: FIXED(10), errorRate: 1 }, { delivery: 'at_least_once', maxReceives: 2, visibilityTimeoutMs: 1000 });
    const s = simulateImport(d, answers({ traffic: { peakRps: 10 } }))!;
    expect(s.criteria.find((c) => c.id === 'simulate.errorRate')).toMatchObject({ ok: true });
    expect(s.criteria.find((c) => c.id === 'simulate.asyncFail')).toMatchObject({ ok: false });
    expect(s.sim.nodes.q.dlq).toBeGreaterThan(0);
    expect(s.verdict).toBe('fail');
  });

  it('no background message succeeds: the background latency does not count as met', () => {
    const d = background({ serviceMs: FIXED(10), errorRate: 1 }, { delivery: 'at_least_once', maxReceives: 2, visibilityTimeoutMs: 1000 });
    const s = simulateImport(d, answers({ traffic: { peakRps: 10 }, slo: { asyncP99Ms: 60_000, asyncFailRate: 1 } }))!;
    expect(s.criteria.find((c) => c.id === 'simulate.asyncFail')).toMatchObject({ ok: true });
    expect(s.criteria.find((c) => c.id === 'simulate.asyncNoSample')).toMatchObject({ ok: false });
    expect(s.verdict).toBe('fail');
  });

  it('a backlog that the drain does not clear: fail', () => {
    // 10 rps of 5 s jobs on 4 × 1 slots = 0.8 per second: the queue grows and 120 s are not enough.
    const d = background({ serviceMs: FIXED(5000), concurrency: 1 });
    const s = simulateImport(d, answers({ traffic: { peakRps: 10 } }))!;
    expect(s.criteria.find((c) => c.id === 'simulate.drain')).toMatchObject({ ok: false });
    expect(s.verdict).toBe('fail');
  });
});

describe('not enough result', () => {
  it('too few front-end requests for a p99: insufficient, not pass', () => {
    const d = background({ serviceMs: FIXED(10) });
    const s = simulateImport(d, answers({ traffic: { peakRps: 0.5 } }))!;
    expect(s.verdict).toBe('insufficient');
    expect(s.insufficient).toMatchObject({ id: 'simulate.short.samples', args: { min: 100 } });
  });

  it('warm-up + measurement + drain longer than the engine allows: insufficient', () => {
    const d = background({ serviceMs: FIXED(10) });
    const s = simulateImport(d, answers({ traffic: { peakRps: 1, measureS: 3000 }, slo: { drainS: 1000 } }))!;
    expect(s.verdict).toBe('insufficient');
    expect(s.insufficient).toMatchObject({ id: 'simulate.short.tooLong', args: { max: 3600 } });
  });

  it('every message id has text, and the report says the result is an assumption', () => {
    const { r, ans } = ecs({ traffic: { peakRps: 200 } });
    const s = simulateImport(r.design, ans)!;
    for (const c of s.criteria) expect(IMPORT_MESSAGE_IDS, c.id).toContain(c.id);
    for (const id of ['simulate.short.truncated', 'simulate.short.tooLong', 'simulate.short.samples', 'simulate.noTraffic', 'simulate.asyncNoSample', 'simulate.asyncP99', 'simulate.asyncFail']) expect(IMPORT_MESSAGE_IDS).toContain(id);
    expect(importReport(r, [], s)).toContain('依假設');
  });
});

describe('review fixes', () => {
  const rateOf = (s: NonNullable<ReturnType<typeof simulateImport>>) => {
    const q = Object.values(s.sim.nodes).filter((n) => n.kind === 'queue');
    const fail = q.reduce((x, n) => x + (n.asyncFail ?? 0), 0);
    const ok = q.reduce((x, n) => x + (n.asyncOk ?? 0), 0);
    return Math.round((fail / (fail + ok)) * 10000) / 100;
  };
  it('the drain is judged at its deadline, not after the engine\'s client-timeout grace', () => {
    // 5 s jobs, 3 s to drain: the jobs started in the last 5 s of the load are still running at the deadline.
    const s = simulateImport(background({ serviceMs: FIXED(5000) }), answers({ traffic: { peakRps: 10 }, slo: { drainS: 3 } }))!;
    expect(s.criteria.find((c) => c.id === 'simulate.drain')).toMatchObject({ ok: false });
    expect(s.verdict).toBe('fail');
  });
  it('an expired message is one failure (the engine already counts it in asyncFail)', () => {
    const s = simulateImport(background({ serviceMs: FIXED(2000), concurrency: 1 }, { messageTtlS: 1 }), answers({ traffic: { peakRps: 5 }, slo: { asyncFailRate: 1 } }))!;
    const c = s.criteria.find((x) => x.id === 'simulate.asyncFail')!;
    expect(Number(c.args.expired)).toBeGreaterThan(0);
    expect(c.args.pct).toBe(rateOf(s));
  });
  it('failures and successes come from the same messages (both counted when they end, in the measured time)', () => {
    const s = simulateImport(background({ serviceMs: FIXED(60_000), errorRate: 0.5 }, { delivery: 'at_least_once', maxReceives: 1, visibilityTimeoutMs: 120_000 }), answers({ traffic: { peakRps: 3, measureS: 40 }, slo: { asyncFailRate: 1, drainS: 200 } }))!;
    expect(s.criteria.find((x) => x.id === 'simulate.asyncFail')!.args.pct).toBe(rateOf(s));
  });
});

describe('review fixes', () => {
  it('unfinishedNow() is at full size when the engine runs scaled down (k > 1), like result().unfinished', async () => {
    const { Simulation } = await import('../../src/core/index.ts');
    const d = design([['users', 'client'], ['api', 'service', { instances: 20, concurrency: 64, serviceMs: FIXED(2) }], ['q', 'queue'], ['w', 'worker', { instances: 40, concurrency: 64, serviceMs: FIXED(5000) }]], [['users', 'api'], ['api', 'q'], ['q', 'w']]);
    const run = new Simulation(d, { schema: 'loadsketch/scenario@1', name: 'k2', seed: 1, durationS: 20, warmupS: 0, scale: 2, traffic: { rps: 400 } } as never);
    const r = run.runToEnd();
    expect(r.scale).toBe(2);
    expect(r.unfinished).toBeGreaterThan(0);
    expect(run.unfinishedNow()).toBe(r.unfinished);
  });
});
