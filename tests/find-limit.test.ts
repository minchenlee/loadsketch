// The app's limit search (roadmap-next M18, Codex and agy review): a design that does not run gets the
// problems and no number; a whole search where nothing failed and nothing did work says so instead of a
// number, and a sample that saw no work never turns a design away; a reply that comes after the search
// was cancelled changes nothing.
import { describe, expect, it } from 'vitest';
import { finalMark, limitBanner, limitLines, limitProblems, limitReply, noWork, searchCanvas, workNodes, type LimitReply, type LimitState } from '../src/app/findLimit.ts';
import { findLimitOf, simulatePeak, type LimitResult } from '../src/engine/limit.ts';
import { setLang } from '../src/i18n/index.ts';
import { DESIGN_SCHEMA, SCENARIO_SCHEMA, type Design, type DesignEdge, type Scenario } from '../src/schema/design.ts';
import { design } from './helpers.ts';

setLang('zh-TW');
const steady: Scenario = { schema: SCENARIO_SCHEMA, name: 's', traffic: { rps: 100 } };
const raw = (nodes: [string, string][], edges: [string, string][]): Design => ({
  schema: DESIGN_SCHEMA,
  name: 'x',
  nodes: nodes.map(([id, kind], i) => ({ id, kind, pos: [i * 200, 0] })),
  edges: edges.map(([from, to]) => ({ from, to })),
});
const FIXED = (mean: number) => ({ mean, cv: 0 });
/** users -> api (2 × 8 slots, 20 ms): about 800 rps; `edge` changes the line. */
const api = (edge: Omit<DesignEdge, 'from' | 'to'> = {}) => design([['users', 'client'], ['api', 'service', { instances: 2, concurrency: 8, serviceMs: FIXED(20) }]], [['users', 'api', edge]]);

describe('before a worker starts', () => {
  it('a client with no edge: the design check of a run, no search (it "held up to 524288 rps")', () => {
    const p = limitProblems(raw([['users', 'client'], ['api', 'service']], []), steady);
    expect(p.join('\n')).toContain('沒有連出去的線');
    expect(searchCanvas(raw([['users', 'client'], ['api', 'service']], []), steady)).toEqual({ problems: p });
  });

  it('an empty canvas: no client, no search', () => {
    expect(limitProblems(raw([], []), steady).join('\n')).toContain('沒有「使用者」節點');
  });

  it('a design that runs can start; the scenario events are not checked (they are left out); a bad setting is a problem', () => {
    const d = design([['users', 'client'], ['lb', 'load_balancer'], ['api', 'service']], [['users', 'lb'], ['lb', 'api']]);
    expect(limitProblems(d, steady)).toEqual([]);
    expect(limitProblems(d, { ...steady, events: [{ type: 'down', node: 'gone', atS: 1 }] })).toEqual([]);
    expect(limitProblems(d, { ...steady, traffic: { rps: -1 } }).length).toBeGreaterThan(0);
  });
});

describe('a search where nothing did work: said at the end of the whole search, never from a sample', () => {
  // the whole search to MAX_RPS takes minutes when the server cannot be scaled down (k stays 1): the
  // tests stop the doubling at 64 rps; the rule is the same
  const SHORT = { maxRps: 64 };
  const cases: [string, Design, Scenario][] = [
    ['a line with weight 0', api({ weight: 0 }), steady],
    ['a write-only line, with reads only', api({ on: 'write' }), { ...steady, traffic: { rps: 100, readRatio: 1 } }],
    ['a CDN with no origin', design([['users', 'client'], ['cdn', 'cdn']], [['users', 'cdn']]), steady],
    // the monitor gets the DNS health checks (a control line), no client request
    ['DNS with nothing behind it, a control line to a monitor', design([['users', 'client'], ['dns', 'dns', { failover: 'on' }], ['mon', 'service']], [['users', 'dns'], ['dns', 'mon', { on: 'control', timeoutMs: 1000 }]]), steady],
  ];
  for (const [name, d, s] of cases) {
    it(name, () => {
      // the design runs (no check stops it): only the whole search shows that no request got anywhere
      expect(limitProblems(d, s)).toEqual([]);
      const seen: number[] = [];
      const r = searchCanvas(d, s, (step) => seen.push(step.rps), SHORT);
      expect(r).toMatchObject({ noWork: true });
      // it ran to the end: every step held
      expect(Math.max(...seen)).toBe(64);
      expect((r as { result: { firstFailRps?: number } }).result.firstFailRps).toBeUndefined();
    });
  }

  it('the control line counts no work: the monitor got requests, but no client request reached it', () => {
    const d = cases[3][1];
    expect([...workNodes(d)]).toEqual([]);
    let monitored = 0;
    findLimitOf(d, steady, { maxRps: 4 }, (_s, run) => (monitored += run.sim.nodes.mon.arrivals));
    expect(monitored).toBeGreaterThan(0);
  });

  it('a load balancer with nothing behind it fails at once: that is the result, not "no work"', () => {
    const r = searchCanvas(design([['users', 'client'], ['lb', 'load_balancer']], [['users', 'lb']]), steady);
    expect(r).toMatchObject({ noWork: false, result: { firstFailRps: 1 } });
  });

  it('a CDN with a 99.9% hit ratio, reads only, seed 4 (Codex): the server gets a request only at higher traffic, so it is searched', () => {
    const d = design([['users', 'client'], ['cdn', 'cdn', { hitRatio: 0.999 }], ['api', 'service', { instances: 1, concurrency: 4, serviceMs: FIXED(50) }]], [['users', 'cdn'], ['cdn', 'api']]);
    // no request reaches the server at 8 rps, some do at 32 rps: by 64 rps the search has seen work
    const seen: number[] = [];
    const r = searchCanvas(d, { ...steady, seed: 4, traffic: { rps: 100, readRatio: 1 } }, (step) => seen.push(step.rps), { maxRps: 64 });
    expect(r).toMatchObject({ noWork: false });
    expect(seen).toContain(8);
    const arrivals = new Map<number, number>();
    findLimitOf(d, { ...steady, seed: 4, traffic: { rps: 100, readRatio: 1 } }, { maxRps: 64 }, (step, run) => arrivals.set(step.rps, run.sim.nodes.api.arrivals));
    expect(arrivals.get(8)).toBe(0);
    expect(Math.max(...arrivals.values())).toBeGreaterThan(0);
  });

  it('a scenario with scale 100: not turned away', () => {
    const r = searchCanvas(api(), { ...steady, scale: 100 });
    expect(r).toMatchObject({ noWork: false });
    expect((r as { result: { firstFailRps?: number } }).result.firstFailRps).toBeGreaterThan(0);
  });

  it('a design whose traffic does reach work gets its limit, with the scale of each step', () => {
    const ks: number[] = [];
    const r = searchCanvas(api(), steady, (_, k) => ks.push(k));
    expect(r).toMatchObject({ noWork: false });
    const l = (r as { result: { holdsRps?: number; firstFailRps?: number; bottleneck?: string } }).result;
    expect(l.holdsRps!).toBeGreaterThan(400);
    expect(l.firstFailRps!).toBeLessThanOrEqual(1024);
    expect(l.bottleneck).toBe('api');
    expect(ks.every((k) => k >= 1)).toBe(true);
  });

  it('the rule: no work and no failing step and not stopped', () => {
    expect(noWork({ nonMonotonic: false, steps: [] }, false)).toBe(true);
    expect(noWork({ nonMonotonic: false, steps: [] }, true)).toBe(false);
    expect(noWork({ firstFailRps: 1, nonMonotonic: false, steps: [] }, false)).toBe(false);
    expect(noWork({ nonMonotonic: false, stopped: { rps: 8, id: 'x' }, steps: [] }, false)).toBe(false);
  });
});

describe('the dialog state', () => {
  const step: LimitReply = { type: 'step', step: { rps: 4, verdict: 'pass', failed: [] }, k: 1, util: { api: 0.1 } };
  const done = { type: 'done', result: { nonMonotonic: false, steps: [] }, noWork: false } satisfies LimitReply;
  it('a running search takes each reply', () => {
    const running: LimitState = { phase: 'running', steps: [] };
    const a = limitReply(running, step);
    expect(a.steps).toEqual([{ rps: 4, verdict: 'pass', failed: [], k: 1, util: { api: 0.1 } }]);
    expect(limitReply(a, done)).toMatchObject({ phase: 'done', result: done.result, noWork: false });
    expect(limitReply(a, { type: 'invalid', problems: ['x'] })).toMatchObject({ phase: 'invalid', problems: ['x'] });
    expect(limitReply(a, { type: 'error', error: 'e' })).toMatchObject({ phase: 'error', error: 'e' });
  });

  it('after a cancel (or any end), a step or a result already on its way changes nothing', () => {
    const cancelled: LimitState = { phase: 'cancelled', steps: [{ rps: 1, verdict: 'pass', failed: [], k: 1, util: {} }] };
    expect(limitReply(cancelled, step)).toBe(cancelled);
    expect(limitReply(cancelled, done)).toBe(cancelled);
    expect(limitReply(cancelled, { type: 'error', error: 'e' })).toBe(cancelled);
    const ended: LimitState = { phase: 'done', steps: [], result: done.result };
    expect(limitReply(ended, step)).toBe(ended);
  });
});

describe('utilization of each step (roadmap-next M23)', () => {
  /** users -> api: 1 instance × 256 slots, 50 ms: busy share rps × 0.05 / 256; from about 2000 rps a
   *  step runs scaled down (256 slots allow k up to 8). */
  const wide = design([['users', 'client'], ['api', 'service', { instances: 1, concurrency: 256, queueLimit: 2000, serviceMs: FIXED(50) }]], [['users', 'api', { latencyMs: 0 }]]);
  const expected = (rps: number) => (rps * 0.05) / 256;

  it('utilization while traffic ran, not the whole measured time with the drain (which shows about half)', () => {
    const run = simulatePeak(wide, steady, 1024);
    expect(run.sim.scale ?? 1).toBe(1);
    expect(run.loadUtil.api).toBeCloseTo(expected(1024), 1);
    expect(Math.abs(run.loadUtil.api - expected(1024))).toBeLessThan(0.02);
    // the engine's figure averages the drain too
    expect(run.sim.nodes.api.utilization).toBeLessThan(run.loadUtil.api * 0.7);
    // components with no instances have none
    expect(Object.keys(run.loadUtil)).toEqual(['api']);
  });

  it('utilization of a step scaled down (k > 1) matches the same step at full size within 0.03', () => {
    for (const rps of [2048, 4096]) {
      const scaled = simulatePeak(wide, steady, rps);
      const full = simulatePeak(wide, { ...steady, scale: 1 }, rps);
      expect(scaled.sim.scale).toBeGreaterThan(1);
      expect(full.sim.scale ?? 1).toBe(1);
      expect(Math.abs(scaled.loadUtil.api - full.loadUtil.api)).toBeLessThan(0.03);
      expect(Math.abs(full.loadUtil.api - expected(rps))).toBeLessThan(0.03);
    }
  });

  it('utilization goes with each step to the dialog', () => {
    const seen: { rps: number; k: number; util: Record<string, number> }[] = [];
    searchCanvas(wide, steady, (step, k, util) => seen.push({ rps: step.rps, k, util }), { maxRps: 4096 });
    expect(seen.some((x) => x.k > 1)).toBe(true);
    for (const x of seen) expect(Math.abs(x.util.api - expected(x.rps))).toBeLessThan(0.03);
    const state = seen.reduce<LimitState>((st, x) => limitReply(st, { type: 'step', step: { rps: x.rps, verdict: 'pass', failed: [] }, k: x.k, util: x.util }), { phase: 'running', steps: [] });
    expect(state.steps.map((x) => x.util.api)).toEqual(seen.map((x) => x.util.api));
  });
});

describe('the conclusion on the canvas page says rates the way the steps do (roadmap-next M24)', () => {
  const step = (rps: number, verdict: 'pass' | 'fail') => ({ rps, verdict, failed: verdict === 'fail' ? ['simulate.p99'] : [], k: 1 });
  it('holds and fails: "/s" in English, 「/秒」 in Chinese, never "rps"', () => {
    const r = { holdsRps: 1280, firstFailRps: 1344, bottleneck: 'api', nonMonotonic: false, steps: [step(1280, 'pass'), step(1344, 'fail')] } as LimitResult;
    setLang('en');
    const en = limitLines(r, (id) => `API server (${id})`);
    expect(en.join(' ')).not.toMatch(/rps|、/);
    expect(en[0]).toContain('1280/s');
    expect(en[0]).toContain('1344/s');
    setLang('zh-TW');
    const zh = limitLines(r, (id) => id);
    expect(zh[0]).toBe('在這些假設下，大約撐到 1280/秒；1344/秒撐不住，最先壞的是 api。');
  });
  it('fails at the start, no fail, not monotonic, stopped', () => {
    setLang('zh-TW');
    expect(limitLines({ firstFailRps: 1, bottleneck: 'db', nonMonotonic: false, steps: [step(1, 'fail')] } as LimitResult, (id) => id)).toEqual(['在這些假設下，1/秒就撐不住（最先壞的是 db）。']);
    expect(limitLines({ holdsRps: 64, nonMonotonic: false, steps: [step(32, 'pass'), step(64, 'pass')] } as LimitResult, (id) => id)).toEqual(['在這些假設下，到 64/秒都撐得住，沒有找到撐不住的點。']);
    const nm = limitLines({ holdsRps: 8, firstFailRps: 16, bottleneck: 'a', nonMonotonic: true, steps: [step(8, 'pass'), step(16, 'fail'), step(24, 'pass'), step(32, 'pass')] } as LimitResult, (id) => id);
    expect(nm[1]).toBe('結果不是單調的：比 16/秒高的 24/秒、32/秒又撐得住；報的是第一個撐不住的點。');
    setLang('en');
    expect(limitLines({ holdsRps: 8, firstFailRps: 16, bottleneck: 'a', nonMonotonic: true, steps: [step(8, 'pass'), step(16, 'fail'), step(24, 'pass'), step(32, 'pass')] } as LimitResult, (id) => id)[1]).not.toMatch(/、|rps/);
    setLang('zh-TW');
  });

  it('finalMark preserves stopped when no step held or when it stopped before failing (P2-3)', () => {
    const tooLong = searchCanvas(
      design([['users', 'client'], ['api', 'service', { autoscale: 'on', scaleEveryS: 1800 }]], [['users', 'api']]),
      steady,
    );
    expect('result' in tooLong && tooLong.noWork).toBe(false);
    const res = (tooLong as { result: LimitResult }).result;
    expect(res.stopped).toEqual({ rps: 1, id: 'simulate.short.tooLong' });
    expect(res.holdsRps).toBeUndefined();
    const steps = res.steps.map((s) => ({ ...s, k: 1, util: { api: 0 } }));
    const mark = finalMark(res, steps, false);
    expect(mark?.done?.stopped).toEqual({ rps: 1, id: 'simulate.short.tooLong' });
    expect(limitBanner(mark!, () => '')).toBe('在 1/秒停下（沒有結論）');
    expect(limitBanner(mark!, () => '')).not.toContain('撐得住');
    setLang('en');
    expect(limitBanner(mark!, () => '')).toBe('Stopped at 1/s (no conclusion)');

    setLang('zh-TW');
    const stoppedAfterHold = finalMark(
      { holdsRps: 40, nonMonotonic: false, stopped: { rps: 80, id: 'simulate.short.tooLong' }, steps: [step(40, 'pass')] },
      [{ ...step(40, 'pass'), k: 1, util: { api: 0.4 } }],
      false,
    );
    expect(limitBanner(stoppedAfterHold!, () => '')).toBe('到 40/秒還撐得住，在 80/秒停下');
    setLang('en');
    expect(limitBanner(stoppedAfterHold!, () => '')).toBe('Holds up to 40/s; stopped at 80/s');
    setLang('zh-TW');

    expect(limitBanner({ rps: 10, util: {}, done: { firstFailRps: 10, node: 'api' } }, () => 'API')).toBe('10/秒就撐不住，最先倒的是 API');
    expect(limitBanner({ rps: 10, util: {}, done: { holdsRps: 8, firstFailRps: 10, node: 'api' } }, () => 'API')).toBe('撐到約 8/秒，最先倒的是 API');
    expect(limitBanner({ rps: 100, util: {}, done: { holdsRps: 100 } }, () => '')).toBe('到 100/秒都撐得住（這不是上限）');
    expect(limitBanner({ rps: 12, util: {} }, () => '')).toBe('現在這一步：12/秒');
  });
});
