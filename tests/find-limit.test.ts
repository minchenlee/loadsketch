// The app's limit search (roadmap-next M18, Codex and agy review): a design that does not run gets the
// problems and no number; a whole search where nothing failed and nothing did work says so instead of a
// number, and a sample that saw no work never turns a design away; a reply that comes after the search
// was cancelled changes nothing.
import { describe, expect, it } from 'vitest';
import { limitProblems, limitReply, noWork, searchCanvas, workNodes, type LimitReply, type LimitState } from '../src/app/findLimit.ts';
import { findLimitOf } from '../src/engine/limit.ts';
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
  const step: LimitReply = { type: 'step', step: { rps: 4, verdict: 'pass', failed: [] }, k: 1 };
  const done = { type: 'done', result: { nonMonotonic: false, steps: [] }, noWork: false } satisfies LimitReply;
  it('a running search takes each reply', () => {
    const running: LimitState = { phase: 'running', steps: [] };
    const a = limitReply(running, step);
    expect(a.steps).toEqual([{ rps: 4, verdict: 'pass', failed: [], k: 1 }]);
    expect(limitReply(a, done)).toMatchObject({ phase: 'done', result: done.result, noWork: false });
    expect(limitReply(a, { type: 'invalid', problems: ['x'] })).toMatchObject({ phase: 'invalid', problems: ['x'] });
    expect(limitReply(a, { type: 'error', error: 'e' })).toMatchObject({ phase: 'error', error: 'e' });
  });

  it('after a cancel (or any end), a step or a result already on its way changes nothing', () => {
    const cancelled: LimitState = { phase: 'cancelled', steps: [{ rps: 1, verdict: 'pass', failed: [], k: 1 }] };
    expect(limitReply(cancelled, step)).toBe(cancelled);
    expect(limitReply(cancelled, done)).toBe(cancelled);
    expect(limitReply(cancelled, { type: 'error', error: 'e' })).toBe(cancelled);
    const ended: LimitState = { phase: 'done', steps: [], result: done.result };
    expect(limitReply(ended, step)).toBe(ended);
  });
});
