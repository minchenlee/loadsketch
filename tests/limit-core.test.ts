// The limit search on any design (roadmap-next M17): a design + a scenario + the limits, with no
// Terraform import and no answer file. `import terraform --find-limit` uses the same core
// (tests/import/limit.test.ts checks that its output is unchanged).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assumptionsOf, DEFAULT_SLO, findLimitOf, peakScenario, SCENARIO_SCHEMA, simulatePeak, steadyScenario, type Design, type LimitStep, type ParamValue, type Scenario } from '../src/core/index.ts';
import { ANSWERS_SCHEMA, findLimit, importTerraform, parseAnswers, simulateImport, type ImportResult } from '../src/import/terraform/index.ts';
import { design } from './helpers.ts';

const FIXED = (mean: number) => ({ mean, cv: 0 });
/** users -> api: 2 instances × 4 slots, 100 ms each = 80 rps at most. */
const small = (api: Record<string, ParamValue> = {}) => design([['users', 'client'], ['api', 'service', { instances: 2, concurrency: 4, queueLimit: 50, serviceMs: FIXED(100), ...api }]], [['users', 'api']]);
const canvas: Scenario = {
  schema: SCENARIO_SCHEMA,
  name: 'spike',
  seed: 7,
  durationS: 60,
  warmupS: 5,
  traffic: { rps: 500, readRatio: 0.5, clientTimeoutMs: 2000 },
  keys: { count: 1000 },
  events: [{ type: 'spike', atS: 10, forS: 5, multiplier: 4 }, { type: 'down', node: 'api', atS: 20, forS: 5 }],
};

describe('a step on any design', () => {
  it('keeps the scenario settings (seed, read share, client timeout, keys) and drops its length and events', () => {
    const d = small();
    const p = peakScenario(d, canvas, 40);
    const s = p.scenario;
    expect(s.seed).toBe(7);
    expect(s.traffic).toEqual({ rps: 40, readRatio: 0.5, clientTimeoutMs: 2000 });
    expect(s.keys).toEqual({ count: 1000 });
    // warm-up, measured load, drain with no new traffic: the only event is the stop
    expect(s.events).toEqual([{ type: 'spike', atS: p.loadS, forS: DEFAULT_SLO.drainS, multiplier: 0 }]);
    expect(s.durationS).toBe(p.loadS + p.drainS);
    expect(s.warmupS).toBe(p.warmS);
    // the scenario given is not changed
    expect(canvas.events).toHaveLength(2);
    expect(canvas.traffic.rps).toBe(500);
  });

  it('the events of the scenario make no difference: the steps are steady traffic', () => {
    const d = small();
    const calm: Scenario = { ...canvas, events: [] };
    const a = simulatePeak(d, canvas, 40);
    const b = simulatePeak(d, calm, 40);
    expect(a.verdict).toBe('pass');
    expect(a.criteria).toEqual(b.criteria);
    expect(a.sim.summary).toEqual(b.sim.summary);
  });

  it('the limits decide: under the defaults it holds near capacity; a tight p99 fails sooner', () => {
    const d = small();
    const seen: LimitStep[] = [];
    const l = findLimitOf(d, canvas, {}, (s) => seen.push(s));
    expect(seen.map((s) => s.rps).sort((x, y) => x - y)).toEqual(l.steps.map((s) => s.rps));
    expect(l.nonMonotonic).toBe(false);
    expect(l.holdsRps!).toBeGreaterThanOrEqual(40);
    expect(l.firstFailRps!).toBeLessThanOrEqual(128);
    expect(l.bottleneck).toBe('api');
    // the api takes 100 ms: a p99 limit of 50 ms holds nowhere
    const tight = findLimitOf(d, canvas, { slo: { p99Ms: 50 } });
    expect(tight.holdsRps).toBeUndefined();
    expect(tight.steps[0].failed).toContain('simulate.p99');
  });
});

describe('the time window of the base scenario', () => {
  it('a long window in the base does not cut the measured load: every step measures from the end of its warm-up', () => {
    // 1 rps, evenly spaced, one slot of 800 ms: holds, with 120 s measured (Codex review of M17)
    const d = design([['users', 'client'], ['api', 'service', { instances: 1, concurrency: 1, serviceMs: FIXED(800) }]], [['users', 'api']]);
    const base: Scenario = { schema: SCENARIO_SCHEMA, name: 'w', windowS: 60, traffic: { rps: 1, arrivals: 'constant' } };
    const r = simulatePeak(d, base, 1);
    expect(r.scenario.windowS).toBeUndefined();
    expect(r.sim.summary.latencyMs.count).toBeGreaterThanOrEqual(120);
    expect(r.verdict).toBe('pass');
    expect(simulatePeak(d, { ...base, windowS: undefined }, 1).criteria).toEqual(r.criteria);
  });
});

describe('the import uses the same core', () => {
  it('an answer file is a steady base scenario and its limits: the same steps and the same run', () => {
    const d = small();
    const a = parseAnswers({ schema: ANSWERS_SCHEMA, traffic: { peakRps: 40, readRatio: 0.6, measureS: 60 }, slo: { p99Ms: 400, drainS: 30 } });
    const base = steadyScenario(0.6);
    const o = { slo: { p99Ms: 400, drainS: 30 }, measureS: 60 };
    const s = simulateImport(d, a)!;
    const t = simulatePeak(d, base, 40, o);
    expect(t.scenario).toEqual(s.scenario);
    expect(t.criteria).toEqual(s.criteria);
    const noPeak = parseAnswers({ schema: ANSWERS_SCHEMA, slo: { p99Ms: 400, drainS: 30 } });
    expect(findLimitOf(d, steadyScenario(), { slo: { p99Ms: 400, drainS: 30 } })).toEqual(findLimit(d, noPeak));
  });
});

/** The list as it was read from the import result before M17 (origins, then edge origins). */
function fromOrigins(res: ImportResult) {
  const out: { node: string; param: string; value: string; from?: string }[] = [];
  for (const n of res.design.nodes) {
    for (const [param, o] of Object.entries(res.origins[n.id] ?? {})) {
      if (o.evidence !== 'estimate') continue;
      const v = n.params?.[param];
      out.push({ node: n.id, param, value: typeof v === 'object' ? JSON.stringify(v) : String(v), ...(o.from ? { from: o.from } : {}) });
    }
  }
  for (const [edge, ps] of Object.entries(res.edgeOrigins)) {
    for (const [param, o] of Object.entries(ps)) if (o.evidence === 'estimate') out.push({ node: edge, param, value: String((res.design.edges.find((e) => e.id === edge) as Record<string, unknown> | undefined)?.[param]), ...(o.from ? { from: o.from } : {}) });
  }
  return out;
}

describe('assumptions are read from the design', () => {
  it('an imported design lists the same estimates as its import result', () => {
    for (const f of ['ecs-rds', 'lambda-sqs-rds', 'aurora-cache-multiaz']) {
      const plan = JSON.parse(readFileSync(join(import.meta.dirname, 'import', 'fixtures', `${f}.plan.json`), 'utf8'));
      const r = importTerraform(plan, {});
      // the design alone, as the app has it after a paste or a reload
      const d = JSON.parse(JSON.stringify(r.design)) as Design;
      expect(assumptionsOf(d), f).toEqual(fromOrigins(r));
      expect(assumptionsOf(d).length, f).toBeGreaterThan(0);
    }
  });

  it('a hand-written design rests on no estimates', () => {
    expect(assumptionsOf(small())).toEqual([]);
  });
});
