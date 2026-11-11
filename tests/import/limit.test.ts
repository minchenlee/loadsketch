// --find-limit: with no peak in the answer file, raise the traffic until the design
// stops holding. Every step is a full --simulate run (warm-up, measured load, drain, the M27 SLO). The
// answer is "under these assumptions it holds up to about X rps", with the estimates it rests on.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { importReport, limitSummary } from '../../src/i18n/importReport.ts';
import { setLang } from '../../src/i18n/index.ts';
import { ANSWERS_SCHEMA, assumptionsOf, BISECT, findLimit, importScenario, importTerraform, limitAnswers, MAX_RPS, parseAnswers, searchLimit, simulateImport, START_RPS, warmUpS, type Answers, type LimitStep } from '../../src/import/terraform/index.ts';
import type { ParamValue } from '../../src/core/index.ts';
import { design, type NodeSpec } from '../helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const PLAN = join(import.meta.dirname, 'fixtures', 'ecs-rds.plan.json');
const tmp = mkdtempSync(join(tmpdir(), 'loadsketch-limit-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const answers = (a: Omit<Answers, 'schema'>): Answers => parseAnswers({ schema: ANSWERS_SCHEMA, ...a });
const cli = (...args: string[]) => spawnSync(process.execPath, [join(ROOT, 'cli', 'loadsketch.ts'), ...args], { encoding: 'utf8', env: { ...process.env, LOADSKETCH_LANG: 'en' } });

/** A fake step run: pass at or below `limit`, fail above, with `extra` overrides by rps. */
const fake = (limit: number, extra: Record<number, Partial<LimitStep>> = {}) => {
  const seen: number[] = [];
  const evaluate = (rps: number): LimitStep => {
    seen.push(rps);
    return { rps, verdict: rps <= limit ? 'pass' : 'fail', failed: rps <= limit ? [] : ['simulate.p99'], ...(rps <= limit ? {} : { bottleneck: 'api' }), ...extra[rps] };
  };
  return { evaluate, seen };
};
const doublings = (to: number) => Array.from({ length: Math.log2(to / START_RPS) + 1 }, (_, i) => START_RPS * 2 ** i);

describe('the search', () => {
  it('monotonic: doubles to the first fail, one more step, then bisects 4 times; holds below the first fail', () => {
    const { evaluate, seen } = fake(300);
    const l = searchLimit(evaluate);
    // 1 … 256 pass, 512 fails, 1024 (one more), then 384, 320, 288, 304.
    expect(seen).toEqual([...doublings(512), 1024, 384, 320, 288, 304]);
    expect(seen.length - doublings(512).length - 1).toBe(BISECT);
    expect(l).toMatchObject({ holdsRps: 288, firstFailRps: 304, bottleneck: 'api', nonMonotonic: false });
    expect(l.stopped).toBeUndefined();
    expect(l.steps.map((s) => s.rps)).toEqual([...seen].sort((a, b) => a - b));
  });

  it('not monotonic: a pass above the first fail is flagged, and the first fail is reported', () => {
    const { evaluate } = fake(300, { 1024: { verdict: 'pass', failed: [] } });
    const l = searchLimit(evaluate);
    expect(l).toMatchObject({ holdsRps: 288, firstFailRps: 304, nonMonotonic: true });
    const text = limitSummary(l, 0).join('\n');
    expect(text).toContain('1024');
  });

  it('fails already at the start: no "holds" value', () => {
    const { evaluate, seen } = fake(0);
    const l = searchLimit(evaluate);
    expect(seen).toEqual([1, 2]);
    expect(l.holdsRps).toBeUndefined();
    expect(l).toMatchObject({ firstFailRps: 1, nonMonotonic: false });
    // the summary still says it fails at the start.
    setLang('en');
    expect(limitSummary(l, 0)[0]).toContain('does not hold even at 1 rps');
  });

  it('holds up to the maximum: no first fail', () => {
    const { evaluate, seen } = fake(Infinity);
    const l = searchLimit(evaluate);
    expect(Math.max(...seen)).toBeLessThanOrEqual(MAX_RPS);
    expect(seen).toEqual(doublings(2 ** 19));
    expect(l.firstFailRps).toBeUndefined();
    expect(l.holdsRps).toBe(2 ** 19);
  });

  it('too few samples at low traffic: keeps raising (neither pass nor fail)', () => {
    const insufficient = { verdict: 'insufficient' as const, failed: [], insufficient: 'simulate.short.samples' };
    const { evaluate } = fake(300, { 1: insufficient, 2: insufficient });
    const l = searchLimit(evaluate);
    expect(l).toMatchObject({ holdsRps: 288, firstFailRps: 304 });
    expect(l.stopped).toBeUndefined();
  });

  it('too few samples inside the bracket: stops bisecting there, keeps the bracket', () => {
    const { evaluate, seen } = fake(300, { 384: { verdict: 'insufficient', failed: [], insufficient: 'simulate.short.samples' } });
    const l = searchLimit(evaluate);
    expect(seen.at(-1)).toBe(384);
    expect(l).toMatchObject({ holdsRps: 256, firstFailRps: 512 });
  });

  it('a step that cannot run (too long): the search stops and says where', () => {
    const { evaluate, seen } = fake(300, { 64: { verdict: 'insufficient', failed: [], insufficient: 'simulate.short.tooLong' } });
    const l = searchLimit(evaluate);
    expect(seen.at(-1)).toBe(64);
    expect(l.stopped).toEqual({ rps: 64, id: 'simulate.short.tooLong' });
    expect(l.firstFailRps).toBeUndefined();
    setLang('en');
    expect(limitSummary(l, 0).join('\n')).not.toContain('no point where it does not hold');
  });
});

/** client -> api -> queue -> worker; the worker does 4 jobs at a time, 1 s each. */
const background = (api: Record<string, ParamValue> = {}) => {
  const FIXED = (mean: number) => ({ mean, cv: 0 });
  const nodes: NodeSpec[] = [['users', 'client'], ['api', 'service', { instances: 2, concurrency: 50, serviceMs: FIXED(2), ...api }], ['q', 'queue'], ['w', 'worker', { instances: 4, concurrency: 1, serviceMs: FIXED(1000) }]];
  return design(nodes, [['users', 'api'], ['api', 'q'], ['q', 'w']]);
};

describe('every step is a full simulation', () => {
  it('each step keeps the answer file (SLO, measureS) and warms up the autoscaled nodes before it measures', () => {
    const plan = JSON.parse(readFileSync(PLAN, 'utf8'));
    const a = answers({ slo: { p99Ms: 500 }, traffic: { peakRps: 1, measureS: 200 } });
    const r = importTerraform(plan, { answers: a });
    const step = limitAnswers(a, 64);
    expect(step.traffic).toMatchObject({ peakRps: 64, measureS: 200 });
    expect(step.slo).toMatchObject({ p99Ms: 500 });
    const p = importScenario(r.design, step)!;
    expect(warmUpS(r.design)).toBeGreaterThan(0);
    expect(p.scenario.warmupS).toBe(warmUpS(r.design));
    expect(p.scenario.durationS).toBeGreaterThanOrEqual(2 * p.scenario.warmupS!);
  });

  it('the drain rule decides: a backlog the worker cannot clear fails, and the limit is near its rate', () => {
    // 4 jobs/s over 120 s load + 120 s drain: about 8 rps of jobs can be cleared.
    const l = findLimit(background(), answers({}));
    expect(l.firstFailRps).toBeDefined();
    expect(l.holdsRps!).toBeGreaterThanOrEqual(4);
    expect(l.holdsRps!).toBeLessThan(10);
    expect(l.steps.find((s) => s.rps === l.firstFailRps)!.failed).toContain('simulate.drain');
  });

  it('the SLO from the answer file decides: a tighter p99 gives a lower limit', () => {
    // The api takes 2 ms; with p99 ≤ 1 ms nothing holds.
    const loose = findLimit(background(), answers({}));
    const tight = findLimit(background(), answers({ slo: { p99Ms: 1 } }));
    expect(tight.holdsRps).toBeUndefined();
    expect(tight.firstFailRps).toBeLessThan(loose.firstFailRps!);
    expect(tight.steps[0].failed).toContain('simulate.p99');
  });

  it('a step is the same as --simulate at that rps', () => {
    const d = background();
    const l = findLimit(d, answers({}));
    const s = simulateImport(d, limitAnswers(answers({}), l.firstFailRps!))!;
    expect(s.verdict).toBe('fail');
  });
});

describe('the ECS fixture', () => {
  it('the result rests on estimates: they are listed, and the summary and report say so', () => {
    const r = importTerraform(JSON.parse(readFileSync(PLAN, 'utf8')), { answers: answers({ edges: [{ from: 'ecs_service_api', to: 'db_instance_main' }] }) });
    const as = assumptionsOf(r);
    expect(as.length).toBeGreaterThan(0);
    expect(as.some((x) => x.node === 'ecs_service_api')).toBe(true);
    setLang('en');
    const l = searchLimit(fake(300).evaluate);
    expect(limitSummary(l, as.length).join('\n')).toContain(`uses ${as.length} estimated values`);
    expect(limitSummary(l, as.length)[0]).toContain('holds up to about 288 rps');
    const rep = importReport(r, [], undefined, l);
    expect(rep).toContain('## Limit search (no peak given)');
    expect(rep).toContain(`\`${as[0].node}.${as[0].param}\``);
  });

  it('with traffic in the answer file, --find-limit runs --simulate and prints its verdict', () => {
    const a = join(tmp, 'peak.json');
    writeFileSync(a, JSON.stringify({ schema: ANSWERS_SCHEMA, traffic: { peakRps: 200 }, edges: [{ from: 'ecs_service_api', to: 'db_instance_main' }] }));
    const c = cli('import', 'terraform', PLAN, '--answers', a, '--find-limit', '--out', join(tmp, 'd3.json'));
    expect(c.status, c.stderr).toBe(0);
    expect(c.stderr).toContain('the --simulate run is used');
    expect(c.stderr).toContain('Simulation (200 rps)');
    expect(c.stderr).not.toContain('Under these assumptions');
  });

  it('the CLI prints the result within 120 s', () => {
    const t0 = Date.now();
    const rep = join(tmp, 'r.md');
    const c = cli('import', 'terraform', PLAN, '--find-limit', '--out', join(tmp, 'd.json'), '--report', rep);
    const s = (Date.now() - t0) / 1000;
    expect(c.status, c.stderr).toBe(0);
    expect(s).toBeLessThan(120);
    expect(c.stderr).toMatch(/Under these assumptions it (holds up to about \d+ rps|does not hold)/);
    expect(c.stderr).toContain('estimated values');
    expect(readFileSync(rep, 'utf8')).toContain('## Limit search (no peak given)');
  }, 150_000);
});
