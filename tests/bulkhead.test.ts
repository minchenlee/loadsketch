// P3: degraded responses (fallback) and bulkheads on the calls to a slow, non-essential dependency.
import { describe, expect, it } from 'vitest';
import { simulate } from '../src/engine/index.ts';
import { checkDesign, type Scenario } from '../src/schema/design.ts';
import { design, scenario } from './helpers.ts';

/** users → api (1 instance, 20 slots) → db, and → recs (the optional dependency). */
const shop = (rec: Record<string, unknown> = {}, apiExtra: Record<string, unknown> = {}) =>
  design(
    [
      ['u', 'client'],
      ['api', 'service', { instances: 1, concurrency: 20, queueLimit: 20, serviceMs: { mean: 2, cv: 0 }, ...apiExtra }],
      ['db', 'database', { readMs: { mean: 2, cv: 0 }, connections: 100 }],
      ['recs', 'service', { instances: 1, concurrency: 1000, serviceMs: { mean: 5, cv: 0 } }],
    ],
    [['u', 'api'], ['api', 'db'], ['api', 'recs', { timeoutMs: 1000, ...rec }]],
  );
type Ev = NonNullable<Scenario['events']>[number];
const slowRecs: Ev[] = [{ type: 'slow', atS: 5, forS: 10, node: 'recs', multiplier: 200 }];
const run = (d: ReturnType<typeof design>, events: Ev[] = slowRecs) =>
  simulate(d, scenario({ durationS: 20, warmupS: 0, traffic: { rps: 200, readRatio: 1, clientTimeoutMs: 3000 }, events }));

describe('fallback and bulkhead', () => {
  it('a failed call with a fallback is a successful, degraded response all the way up', () => {
    const r = run(shop({ fallback: 'on' }), [{ type: 'errors', atS: 0, node: 'recs', rate: 1 }]);
    expect(r.summary.fail.error).toBe(0);
    expect(r.summary.ok).toBe(r.summary.offered);
    expect(r.summary.degraded).toBe(r.summary.offered);
    expect(r.edges['api->recs'].fallbacks).toBe(r.summary.offered);
    // without a fallback, every request fails
    const plain = run(shop(), [{ type: 'errors', atS: 0, node: 'recs', rate: 1 }]);
    expect(plain.summary.ok).toBe(0);
    expect(plain.summary.degraded).toBeUndefined();
  });

  it('without a bulkhead, a slow dependency takes every slot of its caller', () => {
    const r = run(shop());
    // 20 slots each held ~1 s by the call to recs: about 20 rps get through out of 200
    expect(r.summary.fail.queue_full).toBeGreaterThan(1000);
  });

  it('a bulkhead caps the slots a slow dependency can take; calls over the cap fail at once', () => {
    const r = run(shop({ bulkhead: 5 }));
    expect(r.edges['api->recs'].bulkhead).toBeGreaterThan(1000);
    expect(r.summary.fail.bulkhead).toBeGreaterThan(1000);
    expect(r.summary.fail.queue_full).toBe(0);
    // never more than 5 calls in flight to recs: at most 5 of the 20 slots wait on it
    expect(r.edges['api->recs'].fail).toBeLessThanOrEqual(5 * 11 + 5);
  });

  it('bulkhead plus fallback: no failures, the excess gets a degraded response quickly', () => {
    const r = run(shop({ bulkhead: 5, fallback: 'on' }));
    expect(r.summary.ok).toBe(r.summary.offered);
    expect(r.summary.degraded).toBeGreaterThan(1500);
    expect(r.summary.latencyMs.p95).toBeLessThan(50);
  });

  it('a bulkhead limit is per caller instance', () => {
    const one = run(shop({ bulkhead: 3 }, { instances: 1, concurrency: 40 }), [{ type: 'slow', atS: 0, node: 'recs', multiplier: 1000 }]);
    const two = run(shop({ bulkhead: 3 }, { instances: 2, concurrency: 20 }), [{ type: 'slow', atS: 0, node: 'recs', multiplier: 1000 }]);
    // calls that end (time out after 1 s) while the 3 or 6 slots are held: twice as many with two instances
    const sent = (r: typeof one) => r.edges['api->recs'].calls;
    expect(sent(two)).toBeGreaterThanOrEqual(2 * sent(one) - 6);
    expect(sent(two)).toBeLessThanOrEqual(2 * sent(one) + 6);
  });

  it('a call rejected by the bulkhead is not retried and is not counted as a sent call', () => {
    const r = run(shop({ bulkhead: 1, retries: 3 }));
    const e = r.edges['api->recs'];
    expect(e.bulkhead).toBeGreaterThan(1000);
    // only sent calls that failed (timeouts) are retried
    expect(e.retries).toBeLessThanOrEqual(e.fail);
    expect(e.calls).toBeLessThan(r.summary.offered);
  });

  it('bulkhead or fallback on an edge from a queue is flagged', () => {
    const d = design([['u', 'client'], ['q', 'queue'], ['w', 'worker']], [['u', 'q'], ['q', 'w', { fallback: 'on' }]]);
    expect(checkDesign(d).map((i) => i.code)).toContain('queue-edge-timeout');
  });
});

describe('review fixes', () => {
  const errs = (node: string): Ev[] => [{ type: 'errors', atS: 0, node, rate: 1 }];

  it('a fallback on the breaker\'s own call still counts as a failure, so the breaker opens', () => {
    const d = design(
      [['u', 'client'], ['cb', 'circuit_breaker', { minCalls: 20, windowS: 5, openMs: 2000 }], ['dep', 'service', { instances: 1, concurrency: 1000, serviceMs: { mean: 5, cv: 0 } }]],
      [['u', 'cb'], ['cb', 'dep', { fallback: 'on' }]],
    );
    const r = run(d, errs('dep'));
    // the breaker opens and stops most calls; every answer is still a degraded success
    expect(r.edges['cb->dep'].calls).toBeLessThan(r.summary.offered / 2);
    expect(r.summary.ok).toBe(r.summary.offered);
  });

  it('a gateway\'s bulkhead is per instance', () => {
    // 2 gateway instances, round robin, 10 rps each; each call takes 90 ms, so one per instance is in flight
    const d = design(
      [['u', 'client'], ['gw', 'api_gateway', { instances: 2, serviceMs: { mean: 0.001, cv: 0 } }], ['s', 'service', { instances: 1, concurrency: 1000, serviceMs: { mean: 90, cv: 0 } }]],
      [['u', 'gw'], ['gw', 's', { bulkhead: 1 }]],
    );
    const r = simulate(d, scenario({ durationS: 10, warmupS: 0, traffic: { rps: 20, readRatio: 1, arrivals: 'constant' } }));
    expect(r.edges['gw->s'].bulkhead).toBeUndefined();
    expect(r.summary.ok).toBe(r.summary.offered);
  });

  it('a fallback on a cache edge does nothing (cache-aside already reads the store) and is warned about', () => {
    const d = design(
      [['u', 'client'], ['api', 'service', { instances: 1, concurrency: 100 }], ['c', 'cache'], ['db', 'database']],
      [['u', 'api'], ['api', 'c', { fallback: 'on' }], ['api', 'db']],
    );
    expect(checkDesign(d).some((i) => i.code === 'fallback-cache')).toBe(true);
    const r = run(d, [{ type: 'down', atS: 0, node: 'c' }]);
    expect(r.edges['api->c'].fallbacks).toBeUndefined();
    expect(r.summary.degraded ?? 0).toBe(0);
  });
});

describe('review fixes', () => {
  const errs = (node: string): Ev[] => [{ type: 'errors', atS: 0, node, rate: 1 }];

  it('an open breaker answers with the fallback of its outbound edge, not circuit_open', () => {
    const d = design(
      [['u', 'client'], ['cb', 'circuit_breaker', { minCalls: 20, windowS: 5, openMs: 2000 }], ['dep', 'service', { instances: 1, concurrency: 1000, serviceMs: { mean: 5, cv: 0 } }]],
      [['u', 'cb'], ['cb', 'dep', { fallback: 'on' }]],
    );
    const r = run(d, errs('dep'));
    expect(r.nodes.cb.origin.circuit_open).toBe(0);
    expect(r.summary.fail.circuit_open).toBe(0);
    expect(r.edges['cb->dep'].fallbacks).toBe(r.summary.offered);
  });

  it('a fallback on the edge to a read-through cache works when the cache is down, and is not warned about', () => {
    const d = design(
      [['u', 'client'], ['api', 'service', { instances: 1, concurrency: 100 }], ['c', 'cache'], ['db', 'database']],
      [['u', 'api'], ['api', 'c', { fallback: 'on' }], ['c', 'db']],
    );
    expect(checkDesign(d).some((i) => i.code === 'fallback-cache')).toBe(false);
    const r = run(d, [{ type: 'down', atS: 0, node: 'c' }]);
    expect(r.summary.fail.down ?? 0).toBe(0);
    expect(r.edges['api->c'].fallbacks).toBe(r.summary.offered);
  });
});
