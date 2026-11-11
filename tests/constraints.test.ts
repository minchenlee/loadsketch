// M8: constraint problems (Q11=A: targets are gates, then cheaper is better; Q12=A: a small team or a
// short deadline is a lower complexity limit).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/engine/index.ts';
import { parseScenario, type Design } from '../src/schema/design.ts';
import { MULTI_REGION_POINTS, PROBLEMS, complexity, judgeProblem, type Problem } from '../src/learn/constraints.ts';
import { applyPatches, type Patch } from '../src/learn/oncall.ts';
import { design } from './helpers.ts';

const example = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, '..', 'examples/designs', `${name}.json`), 'utf8')) as Design;

function verdict(p: Problem, patches: Patch[]) {
  const d = applyPatches(applyPatches(example(p.example), p.start), patches);
  const sim = new Simulation(d, p.scenario);
  const result = sim.runToEnd();
  return judgeProblem(p, d, { result, windows: sim.drainWindows() });
}

const failed = (v: ReturnType<typeof verdict>) => v.checks.filter((c) => !c.ok).map((c) => c.id);

describe('complexity points', () => {
  it('each component and each mechanism costs points', () => {
    const plain = design([['u', 'client'], ['lb', 'load_balancer'], ['api', 'service'], ['db', 'database']], [['u', 'lb'], ['lb', 'api'], ['api', 'db']]);
    expect(complexity(plain).total).toBe(1 + 1 + 2);
    const more = design(
      [['u', 'client'], ['lb', 'load_balancer', { outlier: 'on' }], ['api', 'service', { autoscale: 'on' }], ['db', 'database', { replicas: 1 }], ['c', 'cache']],
      [['u', 'lb'], ['lb', 'api', { hedgeMs: 20 }], ['api', 'db', { fallback: 'on' }], ['api', 'c']],
    );
    const pts = complexity(more);
    expect(pts.total).toBe(4 + 2 + 1 + 1 + 1 + 1 + 1);
    expect(pts.items.map((i) => i.text)).toEqual(expect.arrayContaining(['outlier detection', '自動擴充', '讀副本', '對沖請求', '降級回應']));
  });

  it('more than one region costs extra', () => {
    const one = design([['u', 'client'], ['api', 'service']], [['u', 'api']]);
    const two = structuredClone(one);
    two.nodes[1].region = 'us-east';
    two.nodes[0].region = 'eu-west';
    expect(complexity(two).total - complexity(one).total).toBe(MULTI_REGION_POINTS);
  });
});

describe('problems', () => {
  it('there are some, with valid scenarios', () => {
    expect(PROBLEMS.length).toBeGreaterThanOrEqual(3);
    for (const p of PROBLEMS) expect(parseScenario(p.scenario, example(p.example)).ok).toBe(true);
  });

  it.each(PROBLEMS.map((p) => [p.id, p] as const))('%s: the start fails, the obvious fix breaks a limit, and the known solution passes', (_, p) => {
    const start = verdict(p, []);
    expect(start.passed).toBe(false);
    expect(start.score).toBe(0);
    // the obvious fix meets the targets but costs too much or is too complex
    const naive = verdict(p, p.naive);
    expect(naive.passed).toBe(false);
    expect(failed(naive).some((id) => id === 'budget' || id === 'points')).toBe(true);
    const sol = verdict(p, p.solution);
    expect(failed(sol)).toEqual([]);
    expect(sol.passed).toBe(true);
    expect(sol.score).toBeGreaterThanOrEqual(50);
    expect(sol.score).toBeLessThanOrEqual(100);
  }, 60_000);

  it('past the gates, a cheaper design scores higher', () => {
    const p = PROBLEMS.find((x) => x.id === 'solo-shortener')!;
    const a = verdict(p, [{ node: 'db', params: { replicas: 0, connections: 32 } }]);
    const b = verdict(p, [{ node: 'db', params: { replicas: 0, connections: 64 } }]);
    expect(a.passed && b.passed).toBe(true);
    expect(a.cost.perMonth).toBeLessThan(b.cost.perMonth);
    expect(a.score).toBeGreaterThan(b.score);
    expect(a.score).toBe(50 + Math.round((50 * (p.limits.budgetPerMonth - a.cost.perMonth)) / p.limits.budgetPerMonth));
  }, 60_000);
});
