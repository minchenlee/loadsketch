// M7: on-call mode. A hidden fault in an example; the learner sees what users see, pays to open a
// component's metrics, names the component and the fault, then fixes the design.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/engine/index.ts';
import { parseScenario, type Design, type Scenario } from '../src/schema/design.ts';
import { FAULTS, INCIDENTS, POINTS, applyPatches, judgeFix, nodeSamples, openCost, score, symptoms, type Incident } from '../src/learn/oncall.ts';

const root = join(import.meta.dirname, '..');
const example = (name: string) => JSON.parse(readFileSync(join(root, 'examples/designs', `${name}.json`), 'utf8')) as Design;

function run(d: Design, s: Scenario) {
  const sim = new Simulation(d, s);
  const result = sim.runToEnd();
  return { result, windows: sim.drainWindows() };
}

const runs = new Map<string, ReturnType<typeof run>>();
const base = (inc: Incident) => {
  if (!runs.has(inc.id)) runs.set(inc.id, run(example(inc.example), inc.scenario));
  return runs.get(inc.id)!;
};

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

describe('incidents (Q7=A: a hand-written set of 8–10)', () => {
  it('there are 8–10, with distinct ids, and they cover every kind of fault', () => {
    expect(INCIDENTS.length).toBeGreaterThanOrEqual(8);
    expect(INCIDENTS.length).toBeLessThanOrEqual(10);
    expect(new Set(INCIDENTS.map((i) => i.id)).size).toBe(INCIDENTS.length);
    expect(new Set(INCIDENTS.map((i) => i.answer.fault))).toEqual(new Set(FAULTS.map((f) => f.id)));
  });

  it.each(INCIDENTS.map((i) => [i.id, i] as const))('%s: the scenario is valid and the answer is a component of the design', (_, inc) => {
    const d = example(inc.example);
    expect(parseScenario(inc.scenario, d).ok).toBe(true);
    expect(d.nodes.map((n) => n.id)).toContain(inc.answer.node);
    // the page names symptoms only: not the component, not the fault
    const node = d.nodes.find((n) => n.id === inc.answer.node)!;
    expect(inc.title).not.toContain(inc.answer.node);
    if (node.label) expect(inc.title).not.toContain(node.label);
    for (const w of ['故障', '變慢', 'GC', '停頓', '暴增', '快取', '資料庫']) expect(inc.title).not.toContain(w);
  });

  it.each(INCIDENTS.map((i) => [i.id, i] as const))('%s: users see it (error rate or p99 gets worse after the fault)', (_, inc) => {
    const s = symptoms(base(inc).windows);
    const before = s.filter((x) => x.t > 6 && x.t <= 20);
    const after = s.filter((x) => x.t > 22 && x.t <= 60);
    const errUp = mean(after.map((x) => x.errorRate)) - mean(before.map((x) => x.errorRate));
    const p99Up = Math.max(...after.map((x) => x.p99 ?? 0)) / Math.max(...before.map((x) => x.p99 ?? 0));
    expect(errUp > 0.05 || p99Up > 2).toBe(true);
    // and the design as it is fails the fix goal
    expect(judgeFix(inc, example(inc.example), example(inc.example), base(inc).result).ok).toBe(false);
  });

  it.each(INCIDENTS.map((i) => [i.id, i] as const))('%s: the known fix meets the goal with the fault still on', (_, inc) => {
    const d = example(inc.example);
    const fixed = applyPatches(d, inc.solution);
    expect(fixed).not.toEqual(d);
    const r = run(fixed, inc.scenario);
    const v = judgeFix(inc, d, fixed, r.result);
    expect(v.missing).toEqual([]);
    expect(r.result.summary.errorRate).toBeLessThanOrEqual(inc.fixGoal.maxErrorRate);
    if (inc.fixGoal.maxP99Ms !== undefined) expect(r.result.summary.latencyMs.p99).toBeLessThanOrEqual(inc.fixGoal.maxP99Ms);
    expect(v.ok).toBe(true);
  });
});

describe('what the learner can open (Q8=A)', () => {
  const byId = Object.fromEntries(INCIDENTS.map((i) => [i.id, i]));

  it('the client shows the traffic: 4× after the spike', () => {
    const inc = byId['traffic-spike'];
    const s = nodeSamples(base(inc).windows, example(inc.example), 'users');
    const before = mean(s.filter((x) => x.t > 6 && x.t <= 20).map((x) => x.rps));
    const after = mean(s.filter((x) => x.t > 22 && x.t <= 60).map((x) => x.rps));
    expect(after / before).toBeGreaterThan(3.5);
    expect(after / before).toBeLessThan(4.5);
  });

  it('a gray failure shows one instance unlike the others', () => {
    const inc = byId['gray-slow'];
    const s = nodeSamples(base(inc).windows, example(inc.example), 'api').filter((x) => x.t > 25);
    const per = [0, 1, 2, 3].map((i) => mean(s.map((x) => x.instUtil![i])));
    expect(per[2]).toBeGreaterThan(0.9);
    for (const i of [0, 1, 3]) expect(per[i]).toBeLessThan(0.5);
  });

  it('a component shows arrivals, failures and its queue', () => {
    const inc = byId['db-slow'];
    const s = nodeSamples(base(inc).windows, example(inc.example), 'db');
    const late = s.filter((x) => x.t > 30);
    expect(mean(late.map((x) => x.rps))).toBeGreaterThan(0);
    const early = s.filter((x) => x.t > 6 && x.t <= 20);
    expect(mean(late.map((x) => x.util ?? 0))).toBeGreaterThan(3 * mean(early.map((x) => x.util ?? 0)));
    expect(mean(late.map((x) => x.queue ?? 0))).toBeGreaterThan(mean(early.map((x) => x.queue ?? 0)));
    // the database does not fail itself: the callers give up (timeouts)
    expect(mean(late.map((x) => x.fail))).toBe(0);
    const errs = byId['db-errors'];
    const e = nodeSamples(base(errs).windows, example(errs.example), 'db').filter((x) => x.t > 22);
    expect(mean(e.map((x) => x.fail))).toBeGreaterThan(0);
  });
});

describe('symptoms and metrics keep what the engine recorded', () => {
  const byId = Object.fromEntries(INCIDENTS.map((i) => [i.id, i]));

  it('a second with no successful request has no p99 (null, not 0)', () => {
    const s = symptoms(base(byId['cache-down']).windows);
    const dead = s.filter((x) => x.errorRate === 1);
    expect(dead.length).toBeGreaterThan(0);
    for (const x of dead) expect(x.p99).toBeNull();
  });

  it("the client's metrics show the failed user requests", () => {
    const inc = byId['gray-errors'];
    const s = nodeSamples(base(inc).windows, example(inc.example), 'users').filter((x) => x.t > 22);
    expect(mean(s.map((x) => x.fail))).toBeGreaterThan(0);
  });
});

describe('score (Q9=A)', () => {
  const inc = INCIDENTS[0];
  const right = inc.answer;

  it('component 40, fault 30, fix 30; the first 2 opened components are free, each one after −10; never below 0', () => {
    expect(POINTS.free).toBe(2);
    expect([0, 1, 2, 3, 4, 5].map(openCost)).toEqual([0, 0, 0, -10, -20, -30]);
    expect(score(inc, right, 0, false).total).toBe(70);
    expect(score(inc, right, 0, true).total).toBe(100);
    // a full score with two components looked at
    expect(score(inc, right, 1, true).total).toBe(100);
    expect(score(inc, right, 2, true).total).toBe(100);
    expect(score(inc, right, 3, true).total).toBe(90);
    expect(score(inc, right, 4, true).total).toBe(80);
    expect(score(inc, { node: right.node, fault: 'traffic' }, 3, false)).toMatchObject({ node: true, fault: false, total: 30 });
    expect(score(inc, { node: 'nope', fault: 'traffic' }, 5, false).total).toBe(0);
  });

  it('a fix that deletes a component does not count', () => {
    const d = example(inc.example);
    const smaller = { ...d, nodes: d.nodes.filter((n) => n.id !== 'cache'), edges: d.edges.filter((e) => e.to !== 'cache') };
    const v = judgeFix(inc, d, smaller, { summary: { errorRate: 0, latencyMs: { p99: 1 } }, nodes: {} });
    expect(v.ok).toBe(false);
    expect(v.missing).toEqual(['cache']);
  });

  it.each(INCIDENTS.map((i) => [i.id, i] as const))('%s: a weight-0 edge out of the client (no traffic reaches the system) is not a fix', (_, inc) => {
    const d = example(inc.example);
    const bypass = structuredClone(d);
    for (const e of bypass.edges) if (e.from === 'users') e.weight = 0;
    const r = run(bypass, inc.scenario);
    const v = judgeFix(inc, d, bypass, r.result);
    expect(v.ok).toBe(false);
    expect(v.idle.length).toBeGreaterThan(0);
  });
});

describe('a fix must be one an engineer on call can make', () => {
  const byId = Object.fromEntries(INCIDENTS.map((i) => [i.id, i]));

  it('a higher cache hit ratio is not a fix: the hit ratio comes from the traffic', () => {
    const inc = byId['db-slow'];
    const d = example(inc.example);
    const fixed = applyPatches(d, [{ node: 'cache', params: { hitRatio: 0.98 } }]);
    const v = judgeFix(inc, d, fixed, run(fixed, inc.scenario).result);
    expect(v.raised).toEqual(['cache']);
    expect(v.ok).toBe(false);
  });

  it('db-errors: retries on the API connection alone leave one background job in five lost', () => {
    const inc = byId['db-errors'];
    const d = example(inc.example);
    const half = applyPatches(d, [{ edge: 'api->db', set: { retries: 2 } }]);
    const r = run(half, inc.scenario);
    expect(r.result.summary.errorRate).toBeLessThanOrEqual(inc.fixGoal.maxErrorRate);
    const v = judgeFix(inc, d, half, r.result);
    expect(v.lost).toBe(true);
    expect(v.ok).toBe(false);
  });

  it('cache-down: the database is not the busy one; the API is, and the retries on the dead cache are the cause', () => {
    const inc = byId['cache-down'];
    const r = base(inc).result;
    expect(r.nodes.db.utilization!).toBeLessThan(0.1);
    expect(r.nodes.api.utilization!).toBeGreaterThan(0.7);
    expect(inc.solution).toEqual([{ edge: 'api->cache', set: { retries: 0 } }]);
  });

  it('gc-pause: the known fix does not send a write again', () => {
    expect(byId['gc-pause'].solution).toEqual([{ edge: 'lb->api', set: { hedgeMs: 60 } }]);
  });
});
