// The custom service (roadmap-next M7, Q16–Q20): a service the user describes. It runs on the
// engine's shared service path, costs what the user says per instance, counts 1 point, and is not
// allowed in practice problems.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Simulation, simulate } from '../src/engine/index.ts';
import { checkDesign, parseDesign, type Design } from '../src/schema/design.ts';
import { CUSTOM_KIND, KINDS, resolveParams } from '../src/schema/kinds.ts';
import { costOf } from '../src/learn/cost.ts';
import { KIND_POINTS, PROBLEMS, brokenStart, complexity } from '../src/learn/constraints.ts';
import { BRIEFS, brokenGivens } from '../src/learn/briefs.ts';
import { judge } from '../src/learn/lesson.ts';
import { LESSONS } from '../src/learn/lessons.ts';
import { INCIDENTS, applyPatches, judgeFix } from '../src/learn/oncall.ts';
import { setLang } from '../src/i18n/index.ts';
import { design, scenario, within } from './helpers.ts';

const root = join(import.meta.dirname, '..');
const example = (name: string) => JSON.parse(readFileSync(join(root, 'examples/designs', `${name}.json`), 'utf8')) as Design;

/** The design with a custom service called from `from`. */
function withCustom(d: Design, from: string): Design {
  const x = structuredClone(d);
  x.nodes.push({ id: 'mine', kind: CUSTOM_KIND, label: 'Search', pos: [0, 0], params: { serviceMs: { mean: 0.1, cv: 0 } } } as Design['nodes'][number]);
  x.edges.push({ from, to: 'mine' });
  return x;
}

describe('custom service: the format', () => {
  it('is a kind with the settings the user fills in, and a design with one reads', () => {
    expect(CUSTOM_KIND).toBe('custom');
    const spec = KINDS[CUSTOM_KIND];
    expect(spec.station).toBe(true);
    expect(spec.routing).toBe('plan');
    expect(Object.keys(spec.params).sort()).toEqual(['calls', 'concurrency', 'errorRate', 'icon', 'instances', 'pricePerHour', 'queueLimit', 'serviceMs'].sort());
    // the default price per instance is the API server's
    expect(resolveParams(CUSTOM_KIND, {}).pricePerHour).toBe(0.08);
    const d = design([['u', 'client'], ['s', CUSTOM_KIND, { icon: 'Search', serviceMs: { mean: 12, cv: 0.5 } }], ['db', 'database']], [['u', 's'], ['s', 'db']]);
    expect(parseDesign(d).ok).toBe(true);
    expect(checkDesign(d).filter((i) => i.level === 'error')).toEqual([]);
    const bad = structuredClone(d);
    bad.nodes[1].params = { icon: 'Spaceship' };
    expect(parseDesign(bad).ok).toBe(false);
  });
});

describe('custom service: the engine', () => {
  const settings = { instances: 3, concurrency: 4, serviceMs: { mean: 8, cv: 1 }, queueLimit: 20 };
  const build = (kind: string, extra: Record<string, unknown> = {}) =>
    design([['u', 'client'], ['s', kind, { ...settings, ...extra }], ['cache', 'cache'], ['db', 'database', { connections: 40 }]], [['u', 's'], ['s', 'cache'], ['s', 'db']]);
  const sc = scenario({ seed: 3, durationS: 40, traffic: { rps: 1800, readRatio: 0.8 } });

  it('with the same settings, it runs exactly like an API server (cache-aside, queueing, rejects)', () => {
    const a = simulate(build('service'), sc);
    const b = simulate(build(CUSTOM_KIND, { icon: 'Bot', pricePerHour: 3 }), sc);
    expect(b.summary).toEqual(a.summary);
    expect(b.nodes.s.arrivals).toBe(a.nodes.s.arrivals);
    expect(b.nodes.db.arrivals).toBe(a.nodes.db.arrivals);
    // it is loaded: some requests are rejected, so the queue limit is used
    expect(a.summary.fail.queue_full).toBeGreaterThan(0);
  });

  it('its error rate fails that share of requests', () => {
    const d = design([['u', 'client'], ['s', CUSTOM_KIND, { instances: 4, concurrency: 64, errorRate: 0.2 }]], [['u', 's']]);
    const r = simulate(d, scenario({ seed: 5, durationS: 60, traffic: { rps: 500 } }));
    expect(within(r.summary.fail.error / r.summary.offered, 0.2, 0.08)).toBe(true);
  });

  it('calls its downstreams in order or all at once', () => {
    const d = (calls: string) =>
      design(
        [['u', 'client'], ['s', CUSTOM_KIND, { instances: 4, concurrency: 64, serviceMs: { mean: 1, cv: 0 }, calls }], ['a', 'service', { instances: 4, concurrency: 64, serviceMs: { mean: 40, cv: 0 } }], ['b', 'service', { instances: 4, concurrency: 64, serviceMs: { mean: 40, cv: 0 } }]],
        [['u', 's'], ['s', 'a'], ['s', 'b']],
      );
    const one = scenario({ seed: 1, durationS: 30, traffic: { rps: 100 } });
    const seq = simulate(d('sequential'), one).summary.latencyMs.p50;
    const par = simulate(d('parallel'), one).summary.latencyMs.p50;
    expect(seq).toBeGreaterThan(80);
    expect(par).toBeLessThan(60);
  });

  it('is scaled down for a big load like the other stations (1/k of the traffic on 1/k of the capacity)', () => {
    // alone, so the stores do not cap k: 64 slots and 20 instances allow k = 4
    const d = design([['u', 'client'], ['s', CUSTOM_KIND, { instances: 20, concurrency: 64 }]], [['u', 's']]);
    const sc = (scale: number) => scenario({ seed: 2, durationS: 6, warmupS: 1, traffic: { rps: 4000, readRatio: 0.8 }, scale });
    const full = new Simulation(d, sc(1)).runToEnd();
    const small = new Simulation(d, sc(4)).runToEnd();
    expect(small.events).toBeLessThan(full.events / 2);
    expect(within(small.summary.offered, full.summary.offered, 0.05)).toBe(true);
    expect(small.summary.errorRate).toBe(0);
  });
});

describe('custom service: cost and complexity (Q19)', () => {
  it('costs instances × the price the user gives, and 1 point', () => {
    const d = design([['u', 'client'], ['s', CUSTOM_KIND, { instances: 3, pricePerHour: 0.5 }]], [['u', 's']]);
    const item = costOf(d).items.find((i) => i.id === 's')!;
    expect(item.perHour).toBe(1.5);
    // the slots do not change the price: the user's price is the whole machine
    const big = design([['u', 'client'], ['s', CUSTOM_KIND, { instances: 3, concurrency: 512, pricePerHour: 0.5 }]], [['u', 's']]);
    expect(costOf(big).items.find((i) => i.id === 's')!.perHour).toBe(1.5);
    expect(costOf(design([['u', 'client'], ['s', CUSTOM_KIND]], [['u', 's']])).items.find((i) => i.id === 's')!.perHour).toBe(0.16);
    expect(KIND_POINTS[CUSTOM_KIND]).toBe(1);
    expect(complexity(d).items.find((i) => i.where === 's')!.points).toBe(1);
  });
});

describe('custom service: not in practice problems (Q20)', () => {
  setLang('zh-TW');
  const ran = (d: Design) => ({ nodes: Object.fromEntries(d.nodes.map((n) => [n.id, { arrivals: 1 }])) }) as unknown as Parameters<typeof brokenStart>[2];

  it('a design brief', () => {
    const b = BRIEFS[0];
    const from = b.reference.nodes.find((n) => n.kind === 'service')!.id;
    expect(brokenGivens(b, b.reference)).toEqual([]);
    expect(brokenGivens(b, withCustom(b.reference, from)).map((x) => x.text)).toContain('練習題不能用自訂服務：「{name}」');
  });

  it('a problem with limits', () => {
    const p = PROBLEMS[0];
    const start = applyPatches(example(p.example), p.start);
    const from = start.nodes.find((n) => n.kind === 'service')!.id;
    expect(brokenStart(start, start, ran(start))).toEqual([]);
    const d = withCustom(start, from);
    expect(brokenStart(start, d, ran(d)).map((x) => x.vars.name)).toContain('Search');
  });

  it('a lesson challenge', () => {
    const lesson = LESSONS['retry-storm'];
    const original = example('retry-storm');
    const d = withCustom(original, 'api');
    const sc = JSON.parse(readFileSync(join(root, 'examples/scenarios/retry-storm.json'), 'utf8'));
    const sim = new Simulation(d, sc);
    const result = sim.runToEnd();
    const v = judge(lesson.challenges[0], { design: d, scenario: sc, result, windows: sim.allWindows() }, original);
    expect(v.passed).toBe(false);
    expect(v.broken.join(' ')).toContain('練習題不能用自訂服務');
  });

  it('an on-call fix', () => {
    const inc = INCIDENTS[0];
    const d = example(inc.example);
    const fixed = applyPatches(d, inc.solution);
    const from = fixed.nodes.find((n) => n.kind === 'service')!.id;
    const result = { summary: { errorRate: 0, latencyMs: { p99: 1 } }, nodes: Object.fromEntries(d.nodes.map((n) => [n.id, { arrivals: 1 }])) };
    expect(judgeFix(inc, d, fixed, result).ok).toBe(true);
    const v = judgeFix(inc, d, withCustom(fixed, from), result);
    expect(v.ok).toBe(false);
    expect(v.custom).toEqual(['mine']);
  });
});
