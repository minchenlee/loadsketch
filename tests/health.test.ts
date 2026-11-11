// P3: gray failure (one instance slow or failing) and how a load balancer finds out:
// instant knowledge, liveness probes, deep probes, outlier detection (passive), fail open.
import { describe, expect, it } from 'vitest';
import { simulate, Simulation } from '../src/engine/index.ts';
import { checkDesign, parseScenario, type Scenario } from '../src/schema/design.ts';
import { whenHolds } from '../src/schema/kinds.ts';
import { design, scenario, within } from './helpers.ts';

type Ev = NonNullable<Scenario['events']>[number];
const lbDesign = (lb: Record<string, unknown> = {}) =>
  design(
    [['u', 'client'], ['lb', 'load_balancer', { policy: 'round_robin', ...lb }], ['a', 'service', { instances: 4, concurrency: 50, serviceMs: { mean: 10, cv: 0 } }]],
    [['u', 'lb'], ['lb', 'a', { timeoutMs: 500 }]],
  );
const run = (lb: Record<string, unknown>, events: Ev[], durationS = 40) =>
  simulate(lbDesign(lb), scenario({ durationS, warmupS: 0, traffic: { rps: 400, readRatio: 1, clientTimeoutMs: 2000 }, events }));

describe('gray failure and health checks', () => {
  it('slow and errors events can target one instance', () => {
    const d = lbDesign();
    const check = (events: unknown[]) => parseScenario({ schema: 'loadsketch/scenario@1', traffic: { rps: 1 }, events }, d);
    expect(check([{ type: 'slow', atS: 0, node: 'a', instance: 3, multiplier: 5 }]).ok).toBe(true);
    expect(check([{ type: 'errors', atS: 0, node: 'a', instance: 0, rate: 0.5 }]).ok).toBe(true);
    const bad = check([{ type: 'errors', atS: 0, node: 'a', instance: 4, rate: 0.5 }]);
    expect(bad.ok).toBe(false);
    expect(bad.issues.some((i) => i.code === 'event-instance')).toBe(true);
  });

  it('a per-instance error rate hits only that instance: a quarter of the requests under round robin', () => {
    const r = run({}, [{ type: 'errors', atS: 0, node: 'a', instance: 1, rate: 1 }]);
    expect(within(r.summary.fail.error / r.summary.offered, 0.25, 0.02)).toBe(true);
  });

  it('a liveness check does not see a gray failure; a deep check takes the instance out', () => {
    const ev: Ev[] = [{ type: 'errors', atS: 5, node: 'a', instance: 1, rate: 1 }];
    const live = run({ healthCheck: 'liveness' }, ev);
    const deep = run({ healthCheck: 'deep' }, ev);
    expect(live.nodes.lb.hcRemoved).toBe(0);
    expect(deep.nodes.lb.hcRemoved).toBe(1);
    // probes of instance 1 run at 2.5 + 5k s: they fail at 7.5 and 12.5, so it is out at 12.5
    expect(deep.timeline.find((e) => e.type === 'hc_out')?.t).toBe(12.5);
    expect(deep.summary.fail.error).toBeLessThan(live.summary.fail.error / 3);
  });

  it('a deep check also takes out an instance that is too slow, and puts it back when it recovers', () => {
    const r = run({ healthCheck: 'deep', hcTimeoutMs: 100 }, [{ type: 'slow', atS: 5, forS: 15, node: 'a', instance: 2, multiplier: 30 }]);
    const hc = r.timeline.filter((e) => e.type === 'hc_out' || e.type === 'hc_in').map((e) => e.type);
    expect(hc).toEqual(['hc_out', 'hc_in']);
  });

  it('with only a liveness check, a crashed instance keeps getting requests until enough probes fail', () => {
    const ev: Ev[] = [{ type: 'down', atS: 20, forS: 10, node: 'a', instance: 1 }];
    const instant = run({}, ev);
    const live = run({ healthCheck: 'liveness' }, ev);
    expect(instant.summary.fail.down).toBeLessThanOrEqual(5); // only the requests in flight at the crash
    // out at 27.5 (probes at 22.5 and 27.5 fail): about 7.5 s × 100 rps sent to the dead instance
    expect(live.timeline.find((e) => e.type === 'hc_out')?.t).toBe(27.5);
    expect(within(live.summary.fail.down, 750, 0.1)).toBe(true);
    // back after two good probes: 32.5 and 37.5
    expect(live.timeline.find((e) => e.type === 'hc_in')?.t).toBe(37.5);
  });

  it('outlier detection ejects a failing instance after a few failed replies, then tries it again', () => {
    const r = run({ outlier: 'on', outlierErrors: 5, ejectS: 10 }, [{ type: 'errors', atS: 5, node: 'a', instance: 1, rate: 1 }]);
    const ej = r.timeline.filter((e) => e.type === 'eject').map((e) => e.t);
    expect(ej[0]).toBeGreaterThan(5);
    expect(ej[0]).toBeLessThan(5.2); // the 5th request to instance 1 after 5 s
    expect(ej.length).toBe(4); // 5, ~15, ~25, ~35 s
    expect(r.nodes.lb.ejections).toBe(4);
    expect(r.summary.fail.error).toBeLessThanOrEqual(4 * 5 + 4); // about 5 failed replies per ejection
  });

  it('outlier detection ejects at most half of the instances at once', () => {
    const r = run({ outlier: 'on', ejectS: 100 }, [{ type: 'errors', atS: 1, node: 'a', rate: 1 }], 10);
    expect(r.nodes.lb.ejections).toBe(2);
  });

  it('fails open: when every instance fails its checks, the load balancer still sends to all of them', () => {
    const r = run({ healthCheck: 'deep' }, [{ type: 'errors', atS: 1, node: 'a', rate: 1 }], 20);
    expect(r.nodes.lb.hcRemoved).toBe(4);
    // the requests still reach the instances (and fail there), not "no healthy target"
    expect(r.summary.fail.down).toBe(0);
    expect(r.summary.fail.error).toBeGreaterThan(0.9 * r.summary.offered);
  });

  it('a parameter can be shown for several values of another one', () => {
    expect(whenHolds({ param: 'healthCheck', value: ['liveness', 'deep'] }, 'deep')).toBe(true);
    expect(whenHolds({ param: 'healthCheck', value: ['liveness', 'deep'] }, 'instant')).toBe(false);
    expect(whenHolds({ param: 'mode', value: 'lru' }, 'lru')).toBe(true);
  });
});

describe('review fixes', () => {
  it('health checks behind a load balancer only cover instance targets: a database target gets a warning', () => {
    const toDb = design([['u', 'client'], ['lb', 'load_balancer', { healthCheck: 'liveness' }], ['db', 'database']], [['u', 'lb'], ['lb', 'db']]);
    expect(checkDesign(toDb).some((i) => i.code === 'lb-health-logical')).toBe(true);
    expect(checkDesign(lbDesign({ healthCheck: 'deep', outlier: 'on' })).some((i) => i.code === 'lb-health-logical')).toBe(false);
  });

  it('an instance event on a node without instances is an error, not silently ignored', () => {
    const d = lbDesign();
    const r = parseScenario({ schema: 'loadsketch/scenario@1', traffic: { rps: 1 }, events: [{ type: 'slow', atS: 0, node: 'lb', instance: 0, multiplier: 5 }] }, d);
    expect(r.ok).toBe(false);
  });

  it('the ejection cap counts serving instances, not the extra ones an autoscaled node keeps off', () => {
    const d = design(
      [['u', 'client'], ['lb', 'load_balancer', { policy: 'round_robin', outlier: 'on', ejectS: 100 }], ['a', 'service', { instances: 2, autoscale: 'on', maxInstances: 10, concurrency: 50, serviceMs: { mean: 10, cv: 0 } }]],
      [['u', 'lb'], ['lb', 'a', { timeoutMs: 500 }]],
    );
    const r = simulate(d, scenario({ durationS: 10, warmupS: 0, traffic: { rps: 100, readRatio: 1 }, events: [{ type: 'errors', atS: 1, node: 'a', rate: 1 }] }));
    expect(r.nodes.lb.ejections).toBe(1);
  });

  it('a reply that does not count (429) breaks the run of consecutive failures; an overload reply (503) counts', () => {
    const sim = new Simulation(lbDesign({ outlier: 'on', outlierErrors: 2 }), scenario({ durationS: 1, traffic: { rps: 1 } }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = sim as any;
    const lb = s.nodes.find((n: { id: string }) => n.id === 'lb');
    const insts = s.nodes.find((n: { id: string }) => n.id === 'a').insts;
    for (const reason of ['error', 'rate_limited', 'error']) s.outlierNote(lb, insts[0], { ok: false, reason }, insts);
    expect(lb.w.ejections).toBe(0);
    s.outlierNote(lb, insts[0], { ok: false, reason: 'queue_full' }, insts);
    expect(lb.w.ejections).toBe(1);
  });
});

describe('review fixes', () => {
  it('crashed instances do not count toward the ejection cap', () => {
    // instances 0 and 1 crash, 2 and 3 fail every request: at most one of the two live ones is ejected
    const ev: Ev[] = [
      { type: 'down', atS: 1, node: 'a', instance: 0 },
      { type: 'down', atS: 1, node: 'a', instance: 1 },
      { type: 'errors', atS: 1, node: 'a', instance: 2, rate: 1 },
      { type: 'errors', atS: 1, node: 'a', instance: 3, rate: 1 },
    ];
    const r = run({ outlier: 'on', ejectS: 100 }, ev, 10);
    expect(r.nodes.lb.ejections).toBeLessThanOrEqual(1);
  });
  it('an ejected instance that crashes still counts toward the cap', () => {
    const sim = new Simulation(lbDesign({ outlier: 'on', outlierErrors: 1, ejectS: 100 }), scenario({ durationS: 1, traffic: { rps: 1 } }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = sim as any;
    const lb = s.nodes.find((n: { id: string }) => n.id === 'lb');
    const insts = s.nodes.find((n: { id: string }) => n.id === 'a').insts;
    expect(insts).toHaveLength(4);
    const fail = (i: number) => s.outlierNote(lb, insts[i], { ok: false, reason: 'error' }, insts);
    fail(0);
    expect(lb.w.ejections).toBe(1);
    // instance 0 crashes while ejected: 3 live, cap 1, and the ejection is still active
    insts[0].down = true;
    fail(1);
    fail(2);
    expect(lb.w.ejections).toBe(1);
    // it comes back: 4 live, cap 2, one more may go
    insts[0].down = false;
    fail(1);
    expect(lb.w.ejections).toBe(2);
    fail(2);
    expect(lb.w.ejections).toBe(2);
  });
});
