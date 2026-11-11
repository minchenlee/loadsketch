// Guess-then-run questions, challenges and the "why it broke" story, on the retry-storm lesson.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Simulation } from '../src/engine/index.ts';
import type { Design, Scenario } from '../src/schema/design.ts';
import { setLang } from '../src/i18n/index.ts';
import { localizeDesign, localizeScenario } from '../src/i18n/content.ts';
import { diagnose } from '../src/learn/diagnose.ts';
import { judge, sameScenario } from '../src/learn/lesson.ts';
import { LESSONS } from '../src/learn/lessons.ts';
import { measured, recoveryS, type RunData } from '../src/learn/metrics.ts';

const root = join(import.meta.dirname, '..');
const read = <T,>(p: string) => JSON.parse(readFileSync(join(root, p), 'utf8')) as T;
const lesson = LESSONS['retry-storm'];
const original = read<Design>('examples/designs/retry-storm.json');
const scenario = read<Scenario>('examples/scenarios/retry-storm.json');

type Change = (d: Design) => void;
const api = (d: Design) => d.nodes.find((n) => n.id === 'api')!;
const retried = (d: Design) => d.edges.filter((e) => e.retries);
const budget: Change = (d) => retried(d).forEach((e) => (e.retryBudget = 0.1));
const smallQueue: Change = (d) => (api(d).params = { ...api(d).params, queueLimit: 20 });
const noRetries: Change = (d) => retried(d).forEach((e) => (e.retries = 0));

const runs = new Map<string, RunData>();
function run(...changes: Change[]): RunData {
  const key = changes.map((c) => c.name || c.toString()).join('+');
  if (!runs.has(key)) {
    const design = structuredClone(original);
    for (const c of changes) c(design);
    const sim = new Simulation(design, scenario);
    const result = sim.runToEnd();
    runs.set(key, { design, scenario, result, windows: sim.allWindows() });
  }
  return runs.get(key)!;
}
const passed = (r: RunData) => lesson.challenges.filter((c) => judge(c, r, original).passed).map((c) => c.id);

afterEach(() => setLang('zh-TW'));

describe('retry-storm lesson: questions', () => {
  it('the answers are read from the run', () => {
    const [recover, amp] = lesson.questions;
    expect(recover.answer(run())).toBe('never');
    expect(amp.answer(run())).toBe('x10');
    expect(recover.answer(run(budget))).toBe('fast');
    expect(amp.answer(run(budget))).toBe('x3');
  });

  it('recovery is measured from the end of the spike', () => {
    expect(recoveryS(run(), 30)).toBe(Infinity);
    const s = recoveryS(run(budget), 30);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(5);
  });
});

describe('retry-storm lesson: challenges', () => {
  it('the example as it ships passes none', () => {
    expect(passed(run())).toEqual([]);
  });

  it('a retry budget recovers but still fails a quarter of the requests', () => {
    expect(passed(run(budget))).toEqual(['retry-storm/recover']);
  });

  it('a short queue fails fast and keeps failures under 10%; with a budget it also keeps p99 low', () => {
    expect(passed(run(smallQueue))).toEqual(['retry-storm/recover', 'retry-storm/fail-less']);
    expect(passed(run(smallQueue, budget))).toEqual(['retry-storm/recover', 'retry-storm/fail-less', 'retry-storm/keep-retries']);
  });

  it('a weight-0 connection out of the users (nothing reaches the system) passes no challenge', () => {
    const round: Change = (d) => {
      for (const e of d.edges) if (e.from === 'users') e.weight = 0;
    };
    expect(passed(run(round))).toEqual([]);
  });

  it('removing the retries breaks the "keep retries" rule', () => {
    const v = judge(lesson.challenges[2], run(smallQueue, noRetries), original);
    expect(v.goals.every((g) => g.ok)).toBe(true);
    expect(v.passed).toBe(false);
    expect(v.broken.length).toBe(retried(original).length);
  });

  it('more capacity, faster parts, a removed component or a new server break "no more capacity"', () => {
    const rule = lesson.challenges[0].rules[0];
    const more = structuredClone(original);
    api(more).params = { ...api(more).params, instances: 4 };
    expect(rule.check(more, original)).toHaveLength(1);
    const faster = structuredClone(original);
    api(faster).params = { ...api(faster).params, serviceMs: { mean: 3, cv: 1 } };
    expect(rule.check(faster, original)).toHaveLength(1);
    const hits = structuredClone(original);
    hits.nodes.find((n) => n.id === 'cache')!.params = { hitRatio: 0.99 };
    expect(rule.check(hits, original)).toHaveLength(1);
    const gone = structuredClone(original);
    gone.nodes = gone.nodes.filter((n) => n.id !== 'cache');
    gone.edges = gone.edges.filter((e) => e.to !== 'cache');
    expect(rule.check(gone, original).length).toBeGreaterThanOrEqual(2);
    const added = structuredClone(original);
    added.nodes.push({ id: 'api2', kind: 'service', pos: [0, 0] });
    expect(rule.check(added, original)).toHaveLength(1);
    // a rate limiter or a smaller queue is allowed
    const limiter = structuredClone(original);
    limiter.nodes.push({ id: 'rl', kind: 'rate_limiter', pos: [0, 0] });
    smallQueue(limiter);
    expect(rule.check(limiter, original)).toEqual([]);
  });

  it('challenges count only with the lesson scenario', () => {
    expect(sameScenario({ ...scenario, name: 'translated' }, scenario)).toBe(true);
    expect(sameScenario({ ...scenario, traffic: { ...scenario.traffic, rps: 300 } }, scenario)).toBe(false);
  });
});

describe('why it broke', () => {
  it('the retry storm: overload, retries multiply the load, and it never recovers', () => {
    const s = diagnose(run());
    const kinds = s.map((x) => x.kind);
    expect(kinds).toContain('saturate');
    expect(kinds).toContain('stuck');
    const amp = s.find((x) => x.kind === 'amplify' && x.node === 'api')!;
    expect(amp.text).toContain('重試');
    expect(amp.why).toBeDefined();
    // in time order
    expect(s.map((x) => x.t)).toEqual([...s.map((x) => x.t)].sort((a, b) => a - b));
    const stuck = s.find((x) => x.kind === 'stuck')!;
    expect(stuck.node).toBe('api');
    expect(stuck.t).toBe(40);
  });

  it('with a retry budget it recovers, and no stuck story is told', () => {
    const kinds = diagnose(run(budget)).map((x) => x.kind);
    expect(kinds).toContain('recover');
    expect(kinds).not.toContain('stuck');
  });

  it('every example gets a story without non-finite numbers, in English too', () => {
    setLang('en');
    const designs = readdirSync(join(root, 'examples/designs')).filter((f) => f.endsWith('.json'));
    for (const f of designs) {
      const design = localizeDesign(read<Design>(`examples/designs/${f}`));
      const own = `examples/scenarios/${f}`;
      const sc = localizeScenario(read<Scenario>(existsSync(join(root, own)) ? own : 'examples/scenarios/spike.json'));
      const sim = new Simulation(design, { ...sc, durationS: Math.min(sc.durationS ?? 60, 40) });
      const result = sim.runToEnd();
      for (const x of diagnose({ design, scenario: sc, result, windows: sim.allWindows() })) {
        expect(`${f}: ${x.text}`).not.toMatch(/[一-鿿]|NaN|Infinity|undefined/);
        if (x.why) expect(x.why).not.toMatch(/[一-鿿]/);
      }
    }
  }, 180_000); // the incident examples are large (Slack: 16 parts at 8000 requests per second)
});

describe('review fixes', () => {
  const tier = read<Design>('examples/designs/three-tier.json');
  const story = (design: Design, sc: Scenario) => {
    const sim = new Simulation(design, sc);
    const result = sim.runToEnd();
    return { result, story: diagnose({ design, scenario: sc, result, windows: sim.allWindows() }) };
  };

  it('a cron burst is told as a trigger', () => {
    const sc = read<Scenario>('examples/scenarios/cron-jitter.json');
    const { result, story: s } = story(read<Design>('examples/designs/periodic.json'), { ...sc, durationS: 100 });
    const cron = result.timeline.find((e) => e.type === 'cron')!;
    expect(cron).toBeDefined();
    expect(s.some((x) => x.kind === 'trigger' && x.text === cron.text)).toBe(true);
  });

  it('failures in the warm-up, which the summary leaves out, are not told', () => {
    const sc: Scenario = {
      schema: 'loadsketch/scenario@1', name: 'w', seed: 1, durationS: 30, warmupS: 5,
      traffic: { rps: 200, readRatio: 0.9, clientTimeoutMs: 2000 },
      events: [{ type: 'down', atS: 1, forS: 2, node: 'api' }],
    };
    const { result, story: s } = story(tier, sc);
    expect(result.summary.errorRate).toBe(0);
    expect(s.filter((x) => x.kind === 'fail' || x.kind === 'stuck' || x.kind === 'trigger')).toEqual([]);
  });

  it('an event after the traffic ends is not told', () => {
    const sc: Scenario = {
      schema: 'loadsketch/scenario@1', name: 'late', seed: 1, durationS: 20, warmupS: 0,
      traffic: { rps: 200, readRatio: 0.9, clientTimeoutMs: 2000 },
      events: [{ type: 'down', atS: 20.5, node: 'api' }],
    };
    const { result, story: s } = story(tier, sc);
    expect(result.timeline.some((e) => e.type === 'down')).toBe(true);
    expect(s.every((x) => x.t <= 20)).toBe(true);
    expect(s.some((x) => x.kind === 'trigger')).toBe(false);
  });
  it('the story ends where the engine stops measuring: the last whole window', () => {
    const sc: Scenario = {
      schema: 'loadsketch/scenario@1', name: 'tail', seed: 1, durationS: 20.5, warmupS: 0,
      traffic: { rps: 200, readRatio: 0.9, clientTimeoutMs: 2000 },
      events: [{ type: 'down', atS: 20.2, node: 'api' }],
    };
    const { result, story: s } = story(tier, sc);
    expect(result.measuredFromS + result.measuredS).toBe(20);
    expect(s.some((x) => x.kind === 'trigger')).toBe(false);
    expect(s.every((x) => x.t <= 20)).toBe(true);
  });
  it('the end is the exact traffic end, not the rounded measured time', () => {
    const sc: Scenario = {
      schema: 'loadsketch/scenario@1', name: 'exact', seed: 1, durationS: 20.98765, warmupS: 0, windowS: 60,
      traffic: { rps: 200, readRatio: 0.9, clientTimeoutMs: 2000 },
      events: [{ type: 'down', atS: 20.9878, node: 'api' }],
    };
    const { result, story: s } = story(tier, sc);
    expect(result.timeline.some((e) => e.type === 'down')).toBe(true);
    expect(s.some((x) => x.kind === 'trigger')).toBe(false);
  });
});

describe('review fixes: the engine marks the measured windows', () => {
  const tier = read<Design>('examples/designs/three-tier.json');
  const runOf = (sc: Scenario): RunData => {
    const sim = new Simulation(tier, sc);
    const result = sim.runToEnd();
    return { design: tier, scenario: sc, result, windows: sim.allWindows() };
  };

  it('a fractional window keeps its last whole window, though t is rounded past measuredS', () => {
    const sc: Scenario = { schema: 'loadsketch/scenario@1', name: 'frac', seed: 1, durationS: 3, warmupS: 0.1, windowS: 0.3333, traffic: { rps: 200, readRatio: 0.9, clientTimeoutMs: 2000 } };
    const run = runOf(sc);
    const ws = measured(run).windows;
    const last = ws[ws.length - 1];
    // the rounded end (3.000 s) is after measuredFromS + measuredS (2.9993 s): it still counts
    expect(last.t).toBeGreaterThan(run.result.measuredFromS + run.result.measuredS);
    expect(Math.abs(last.t - 3)).toBeLessThan(1e-3);
    expect(ws).toHaveLength(8); // windows 2–9 of 0.3333 s: the first is warm-up
    expect(ws.every((w) => w.measured)).toBe(true);
  });

  it('windows in the warm-up and after the traffic stay out', () => {
    const sc: Scenario = { schema: 'loadsketch/scenario@1', name: 'w', seed: 1, durationS: 10, warmupS: 2, traffic: { rps: 200, readRatio: 0.9, clientTimeoutMs: 2000 } };
    const run = runOf(sc);
    const ws = measured(run).windows;
    expect(run.windows.length).toBeGreaterThan(ws.length);
    expect(ws[0].t - ws[0].dt).toBeGreaterThanOrEqual(2 - 1e-9);
    expect(ws[ws.length - 1].t).toBeLessThanOrEqual(10 + 1e-9);
  });
});
