// P3: client-side adaptive throttling (Google SRE book, "Handling Overload").
import { describe, expect, it } from 'vitest';
import { Simulation, simulate } from '../src/engine/index.ts';
import { checkDesign } from '../src/schema/design.ts';
import { design, scenario, within } from './helpers.ts';

/** users → api; one api instance holds 10 requests at a time and rejects the rest (no queue): 200 rps capacity. */
const small = (throttleK: number) =>
  design(
    [['u', 'client'], ['api', 'service', { instances: 1, concurrency: 10, queueLimit: 0, serviceMs: { mean: 50, cv: 0 } }]],
    [['u', 'api', { throttleK }]],
  );

describe('client adaptive throttling', () => {
  it('in steady overload the client sends about K × accepts and rejects the rest itself', () => {
    for (const K of [1.5, 2, 3]) {
      const r = simulate(small(K), scenario({ durationS: 60, warmupS: 20, traffic: { rps: 1000, readRatio: 1 } }));
      const e = r.edges['u->api'];
      // without throttling the client would send 1000 / 200 = 5 calls per success
      expect(within(e.calls / e.ok, K, 0.05)).toBe(true);
      expect(e.throttled).toBeGreaterThan(0);
      expect(r.summary.fail.throttled).toBe(e.throttled);
      expect(r.nodes.u.origin.throttled).toBe(e.throttled);
    }
  });

  it('throttling cuts the wasted calls the backend has to reject', () => {
    const off = simulate(small(0), scenario({ durationS: 60, warmupS: 20, traffic: { rps: 1000, readRatio: 1 } }));
    const on = simulate(small(2), scenario({ durationS: 60, warmupS: 20, traffic: { rps: 1000, readRatio: 1 } }));
    // 800 of 1000 rps rejected by the api vs. about 200 (K × accepts − accepts)
    expect(off.nodes.api.origin.queue_full).toBeGreaterThan(30000);
    expect(on.nodes.api.origin.queue_full).toBeLessThan(off.nodes.api.origin.queue_full / 3);
    // the backend serves a little less: some calls rejected locally would have found a free slot
    expect(on.summary.ok).toBeGreaterThan(0.9 * off.summary.ok);
    expect(on.summary.ok).toBeLessThan(off.summary.ok);
  });

  it('a healthy backend is never throttled', () => {
    const d = design([['u', 'client'], ['api', 'service', { concurrency: 100, serviceMs: { mean: 5, cv: 0 } }]], [['u', 'api', { throttleK: 2 }]]);
    const r = simulate(d, scenario({ durationS: 30, warmupS: 0, traffic: { rps: 200, readRatio: 1 } }));
    expect(r.summary.fail.throttled).toBe(0);
  });

  it('during a full outage only a trickle is sent; afterwards sending grows back as successes return', () => {
    const d = design([['u', 'client'], ['api', 'service', { concurrency: 100, serviceMs: { mean: 5, cv: 0 } }]], [['u', 'api', { throttleK: 2 }]]);
    const sim = new Simulation(d, scenario({ durationS: 60, warmupS: 0, traffic: { rps: 200, readRatio: 1 }, events: [{ type: 'errors', atS: 5, forS: 10, node: 'api', rate: 1 }] }));
    sim.runToEnd();
    const w = sim.allWindows();
    const calls = (a: number, b: number) => w.filter((x) => x.t > a && x.t <= b).reduce((n, x) => n + x.edges['u->api'].calls, 0);
    // once the window holds only failures, p = requests / (requests + 1): almost nothing goes out
    expect(calls(15, 20)).toBeLessThan(5);
    // each success lets about K more calls through, so sending grows back (slowly: see docs/model.md)
    expect(calls(50, 55)).toBeGreaterThan(4 * Math.max(1, calls(30, 35)));
    expect(calls(55, 60)).toBeGreaterThan(calls(50, 55));
  });

  it('a throttled call is not retried, by this edge or one upstream', () => {
    const d = design(
      [['u', 'client'], ['gw', 'api_gateway'], ['api', 'service', { concurrency: 100, serviceMs: { mean: 5, cv: 0 } }]],
      [['u', 'gw', { retries: 3 }], ['gw', 'api', { throttleK: 2, retries: 3 }]],
    );
    // the api fails every call, so retries would be made for every request if throttled calls were retried
    const r = simulate(d, scenario({ durationS: 30, warmupS: 10, traffic: { rps: 200, readRatio: 1 }, events: [{ type: 'errors', atS: 0, node: 'api', rate: 1 }] }));
    const e = r.edges['gw->api'];
    expect(r.summary.fail.throttled).toBeGreaterThan(0.95 * r.summary.offered);
    expect(e.retries).toBeLessThanOrEqual(e.calls);
    // u->gw retries only after an error, and an error needs a call that went out
    expect(r.edges['u->gw'].retries).toBeLessThanOrEqual(3 * e.calls);
    expect(r.edges['u->gw'].retries).toBeLessThan(0.05 * r.summary.offered);
  });

  it('K = 0 (the default) never throttles', () => {
    const r = simulate(small(0), scenario({ durationS: 10, warmupS: 0, traffic: { rps: 1000, readRatio: 1 } }));
    expect(r.summary.fail.throttled).toBe(0);
    expect(r.edges['u->api'].throttled).toBeUndefined();
  });
});

describe('review fixes', () => {
  it('calls that never answer still count as requests, so throttling starts', () => {
    // no edge timeout and a service that takes 100 s: no call ends within the run
    const d = design(
      [['u', 'client'], ['api', 'service', { instances: 1, concurrency: 100000, serviceMs: { mean: 100000, cv: 0 } }]],
      [['u', 'api', { throttleK: 2 }]],
    );
    const r = simulate(d, scenario({ durationS: 20, warmupS: 0, traffic: { rps: 100, readRatio: 1, clientTimeoutMs: 60000 } }));
    const e = r.edges['u->api'];
    expect(e.throttled).toBeGreaterThan(0);
    // after the first 5 s almost every new call is rejected locally
    expect(e.calls).toBeLessThan(800);
  });

  it('throttleK on an edge from a queue is flagged: queue delivery does not use it', () => {
    const d = design(
      [['u', 'client'], ['q', 'queue'], ['w', 'worker']],
      [['u', 'q'], ['q', 'w', { throttleK: 2 }]],
    );
    expect(checkDesign(d).map((i) => i.code)).toContain('queue-edge-timeout');
  });
});

describe('review fixes', () => {
  it('a call bounded by a short timeout schedules no hung-call timer (no extra events)', () => {
    const d = (k: number) =>
      design([['u', 'client'], ['a', 'service', { instances: 1, concurrency: 100, serviceMs: { mean: 5, cv: 0 } }], ['b', 'service', { instances: 1, concurrency: 100, serviceMs: { mean: 5, cv: 0 } }]], [['u', 'a'], ['a', 'b', { timeoutMs: 150, throttleK: k }]]);
    const run = (k: number) => simulate(d(k), scenario({ durationS: 5, warmupS: 0, traffic: { rps: 100, readRatio: 1, arrivals: 'constant' } }));
    // nothing fails, so the throttle never rejects: the event count is the same with and without it
    expect(run(2).events).toBe(run(0).events);
  });
});
