// Deploys: a staged rollout with automatic rollback (#63), a global config push (#8, #59),
// and instances that must call a dependency to boot (#15).
import { describe, expect, it } from 'vitest';
import { simulate, Simulation } from '../src/engine/index.ts';
import { checkDesign, checkScenario, type Scenario } from '../src/schema/design.ts';
import { design, scenario } from './helpers.ts';

type Ev = NonNullable<Scenario['events']>[number];

describe('rollout', () => {
  // 8 API servers behind a load balancer, plus a gateway in front: a global push hits both
  const d = design(
    [
      ['users', 'client'],
      ['gw', 'api_gateway', { instances: 2, concurrency: 200, serviceMs: { mean: 1, cv: 0 } }],
      ['lb', 'load_balancer'],
      ['svc', 'service', { instances: 8, concurrency: 50, serviceMs: { mean: 10, cv: 0 }, queueLimit: 100000 }],
    ],
    [['users', 'gw'], ['gw', 'lb'], ['lb', 'svc']],
  );
  const run = (ev: Partial<Extract<Ev, { type: 'rollout' }>>, extra: Partial<Scenario> = {}) =>
    simulate(d, scenario({ seed: 7, durationS: 40, warmupS: 0, traffic: { rps: 400 }, events: [{ type: 'rollout', atS: 5, ...ev }], ...extra }));
  const types = (r: ReturnType<typeof simulate>) => r.timeline.map((e) => e.type);
  const failed = (r: { offered: number; ok: number }) => r.offered - r.ok;
  const windowFails = (w: { fail: Record<string, number> }) => Object.values(w.fail).reduce((a, b) => a + b, 0);

  it('one wave to every server is a global push: everything fails together', () => {
    const r = run({ errorRate: 0.5 });
    // gateway and API servers both fail half: 1 − 0.5 × 0.5 = 75% of the requests after 5 s
    const share = failed(r.summary) / r.summary.offered;
    expect(share).toBeGreaterThan(0.75 * (35 / 40) * 0.9);
    expect(share).toBeLessThan(0.75 * (35 / 40) * 1.1);
    expect(types(r)).toContain('rollout');
    expect(types(r)).toContain('rollout_done');
    expect(types(r)).not.toContain('rollback');
  });

  it('staged waves with a halt check roll back after the first wave: a small blast radius', () => {
    const staged = run({ node: 'svc', waves: 4, waveS: 5, errorRate: 0.5, haltAt: 0.05 });
    const global = run({ node: 'svc', waves: 1, waveS: 5, errorRate: 0.5, haltAt: 0.05 });
    const unchecked = run({ node: 'svc', waves: 4, waveS: 5, errorRate: 0.5 });
    // wave 1 = 2 of 8 servers for 5 s: 400 × 5 × 25% × 50% = 250 failures
    expect(failed(staged.summary)).toBeGreaterThan(150);
    expect(failed(staged.summary)).toBeLessThan(400);
    expect(types(staged)).toContain('rollback');
    expect(types(staged)).not.toContain('rollout_wave');
    // the same check after one wave to all 8: 400 × 5 × 50% = 1000
    expect(failed(global.summary)).toBeGreaterThan(failed(staged.summary) * 3);
    // no check: every wave goes out and the bad version stays
    expect(types(unchecked)).toContain('rollout_done');
    expect(failed(unchecked.summary)).toBeGreaterThan(failed(global.summary) * 3);
    // after the rollback nothing fails any more
    const sim = new Simulation(d, scenario({ seed: 7, durationS: 40, warmupS: 0, traffic: { rps: 400 }, events: [{ type: 'rollout', atS: 5, node: 'svc', waves: 4, waveS: 5, errorRate: 0.5, haltAt: 0.05 }] }));
    sim.runToEnd();
    const late = sim.allWindows().filter((w) => w.t >= 12);
    expect(late.reduce((a, w) => a + windowFails(w), 0)).toBe(0);
  });

  it('a good version passes the check and finishes every wave', () => {
    const r = run({ node: 'svc', waves: 4, waveS: 5, haltAt: 0.05 });
    expect(failed(r.summary)).toBe(0);
    expect(types(r).filter((x) => x === 'rollout_wave')).toHaveLength(3);
    expect(types(r)).toContain('rollout_done');
  });

  it('a slow version makes p99 slower', () => {
    const base = run({ node: 'svc', slow: 1 });
    const slow = run({ node: 'svc', slow: 5 });
    expect(slow.summary.latencyMs.p99).toBeGreaterThan(base.summary.latencyMs.p99 * 3);
  });

  it('a version that crashes at start takes its wave down; the rollback brings it back', () => {
    const sim = new Simulation(d, scenario({ seed: 7, durationS: 40, warmupS: 0, traffic: { rps: 400 }, events: [{ type: 'rollout', atS: 5, node: 'svc', waves: 4, waveS: 5, crash: true, haltAt: 0.05 }] }));
    const r = sim.runToEnd();
    expect(types(r)).toContain('rollback');
    const w = sim.allWindows();
    // during wave 1 the 2 crashed servers do no work (the load balancer sends around them);
    // after the rollback all 8 serve again
    expect(w.find((x) => x.t === 8)!.nodes.svc.instUtil!.filter((u) => u === 0)).toHaveLength(2);
    expect(w.filter((x) => x.t > 12).reduce((a, x) => a + windowFails(x), 0)).toBe(0);
    expect(w.find((x) => x.t === 20)!.nodes.svc.instUtil!.every((u) => u > 0)).toBe(true);
  });

  it('the scaled run keeps every instance of a rollout target', () => {
    // 40 servers of 64 slots: a scaled run could cut slots to 32 (k 2) and then servers to 10 (k 8)
    const many = design([['users', 'client'], ['svc', 'service', { instances: 40, concurrency: 64 }]], [['users', 'svc']]);
    const big = scenario({ durationS: 600, traffic: { rps: 20000 } });
    expect(new Simulation(many, big).scalePlan.k).toBeGreaterThan(2);
    // a rollout updates ceil(w / waves) of the servers: the run keeps all 40
    const withRollout = { ...big, events: [{ type: 'rollout', atS: 5, waves: 4 } as Ev] };
    expect(new Simulation(many, withRollout).scalePlan.k).toBeLessThanOrEqual(2);
  });

  it('checks: a rollout needs a component with instances', () => {
    const bad = scenario({ traffic: { rps: 1 }, events: [{ type: 'rollout', atS: 1, node: 'lb' }] });
    expect(checkScenario(bad, d).map((i) => i.code)).toContain('event-rollout-kind');
    const missing = scenario({ traffic: { rps: 1 }, events: [{ type: 'rollout', atS: 1, node: 'nope' }] });
    expect(checkScenario(missing, d).map((i) => i.code)).toContain('event-node');
    const all = scenario({ traffic: { rps: 1 }, events: [{ type: 'rollout', atS: 1 }] });
    expect(checkScenario(all, d).filter((i) => i.level === 'error')).toEqual([]);
  });
});

describe('boot dependency (provisioning)', () => {
  // an autoscaled service whose new instances fetch their config from a config store at boot
  const d = (bootEdge = true) =>
    design(
      [
        ['users', 'client'],
        ['svc', 'service', {
          instances: 2, concurrency: 10, serviceMs: { mean: 50, cv: 0 }, queueLimit: 100000,
          autoscale: 'on', maxInstances: 10, targetUtil: 0.6, scaleEveryS: 5, bootS: 10, warmS: 0, scaleDownS: 0,
        }],
        ['cfg', 'database', { connections: 10, readMs: { mean: 2, cv: 0 } }],
      ],
      [['users', 'svc'], ...(bootEdge ? [['svc', 'cfg', { on: 'boot' as const, timeoutMs: 1000 }] as [string, string, { on: 'boot'; timeoutMs: number }]] : [])],
    );
  const sc = (events: Ev[] = []) => scenario({ seed: 1, durationS: 120, warmupS: 0, traffic: { rps: 300 }, events: [{ type: 'spike', atS: 10, forS: 110, multiplier: 2 }, ...events] });

  it('requests do not take a boot edge', () => {
    const r = simulate(d(), sc());
    // only the boot calls of the new instances reach the config store
    expect(r.edges['svc->cfg:boot'].calls).toBe(r.nodes.svc.autoscale!.launches);
  });

  it('while the boot dependency is down, new instances cannot come up', () => {
    const r = simulate(d(), sc([{ type: 'down', node: 'cfg', atS: 0, forS: 60 }]));
    const free = simulate(d(false), sc([{ type: 'down', node: 'cfg', atS: 0, forS: 60 }]));
    expect(r.nodes.svc.autoscale!.bootFails!).toBeGreaterThan(0);
    expect(free.nodes.svc.autoscale!.bootFails).toBeUndefined();
    const tl = r.timeline.filter((e) => e.node === 'svc');
    const firstReady = tl.find((e) => e.type === 'scale_ready')!;
    // ready only after the store is back at 60 s (the first try at 20 s failed)
    expect(firstReady.t).toBeGreaterThanOrEqual(60);
    expect(tl.some((e) => e.type === 'boot_fail')).toBe(true);
    const freeReady = free.timeline.find((e) => e.node === 'svc' && e.type === 'scale_ready')!;
    expect(freeReady.t).toBeLessThan(30);
    // stuck at 2 for longer: more requests fail or wait
    expect(r.summary.latencyMs.p99).toBeGreaterThan(free.summary.latencyMs.p99);
  });

  it('a failed boot does not launch extra instances', () => {
    const r = simulate(d(), sc([{ type: 'down', node: 'cfg', atS: 0 }]));
    expect(r.nodes.svc.autoscale!.peakActive).toBe(2);
    expect(r.nodes.svc.autoscale!.launches).toBeLessThanOrEqual(8);
  });

  it('checks: a boot edge needs autoscaling on its caller, and makes no loop', () => {
    const fixed = design([['users', 'client'], ['svc', 'service'], ['cfg', 'database']], [['users', 'svc'], ['svc', 'cfg', { on: 'boot' }]]);
    expect(checkDesign(fixed).map((i) => i.code)).toContain('boot-no-autoscale');
    const loop = design([['users', 'client'], ['a', 'service', { autoscale: 'on' }], ['b', 'service']], [['users', 'a'], ['a', 'b'], ['b', 'a', { on: 'boot' }]]);
    expect(checkDesign(loop).map((i) => i.code)).not.toContain('cycle');
  });
});

describe('review fixes', () => {
  const svc = (p: Record<string, unknown> = {}) =>
    design(
      [
        ['users', 'client'],
        ['lb', 'load_balancer'],
        ['svc', 'service', { instances: 8, concurrency: 50, serviceMs: { mean: 10, cv: 0 }, queueLimit: 100000, ...p }],
      ],
      [['users', 'lb'], ['lb', 'svc']],
    );
  const types = (r: ReturnType<typeof simulate>) => r.timeline.map((e) => e.type);
  const boot = (edge: Record<string, unknown>, p: Record<string, unknown> = {}) =>
    design(
      [
        ['users', 'client'],
        ['svc', 'service', {
          instances: 2, concurrency: 10, serviceMs: { mean: 50, cv: 0 }, queueLimit: 100000,
          autoscale: 'on', maxInstances: 10, targetUtil: 0.6, scaleEveryS: 5, bootS: 10, warmS: 0, scaleDownS: 0, ...p,
        }],
        ['cfg', 'database', { connections: 10, readMs: { mean: 2, cv: 0 } }],
      ],
      [['users', 'svc'], ['svc', 'cfg', { on: 'boot', timeoutMs: 1000, ...edge }] as never],
    );
  const bootSc = (events: Ev[]) => scenario({ seed: 1, durationS: 120, warmupS: 0, traffic: { rps: 300 }, events: [{ type: 'spike', atS: 10, forS: 110, multiplier: 2 }, ...events] });

  it('a fallback on a boot edge does not make a failed boot succeed', () => {
    const r = simulate(boot({ fallback: 'on' }), bootSc([{ type: 'down', node: 'cfg', atS: 0, forS: 60 }]));
    expect(r.nodes.svc.autoscale!.bootFails!).toBeGreaterThan(0);
    const ready = r.timeline.find((e) => e.node === 'svc' && e.type === 'scale_ready')!;
    expect(ready.t).toBeGreaterThanOrEqual(60);
  });

  it('bootS 0 with a down boot dependency does not retry at the same instant forever', () => {
    const r = simulate(boot({}, { bootS: 0 }), bootSc([{ type: 'down', node: 'cfg', atS: 0 }]));
    expect(r.truncated).toBeFalsy();
    expect(r.nodes.svc.autoscale!.bootFails!).toBeGreaterThan(0);
  });

  it('a second rollout to the same node updates it again; its rollback goes back to the first version', () => {
    const r = simulate(svc(), scenario({
      seed: 7, durationS: 60, warmupS: 0, traffic: { rps: 400 },
      events: [
        { type: 'rollout', atS: 5, node: 'svc', waves: 2, waveS: 5, haltAt: 0.05 },
        { type: 'rollout', atS: 30, node: 'svc', waves: 2, waveS: 5, errorRate: 0.5, haltAt: 0.05 },
      ],
    }));
    expect(types(r).filter((x) => x === 'rollout_done')).toHaveLength(1);
    expect(types(r)).toContain('rollback');
    // the second deploy updated 4 servers (wave 1 of 2) and they failed half
    expect(r.summary.offered - r.summary.ok).toBeGreaterThan(200);
    const sim = new Simulation(svc(), scenario({
      seed: 7, durationS: 60, warmupS: 0, traffic: { rps: 400 },
      events: [
        { type: 'rollout', atS: 5, node: 'svc', errorRate: 0.1 },
        { type: 'rollout', atS: 30, node: 'svc', waves: 2, waveS: 5, errorRate: 0.5, haltAt: 0.2 },
      ],
    }));
    sim.runToEnd();
    // after the rollback at 35 s the first version (10% errors) is back, not a clean one
    const late = sim.allWindows().filter((w) => w.t > 40);
    const fails = late.reduce((a, w) => a + Object.values(w.fail).reduce((x, y) => x + y, 0), 0);
    const calls = late.reduce((a, w) => a + w.offered, 0);
    expect(fails / calls).toBeGreaterThan(0.07);
    expect(fails / calls).toBeLessThan(0.13);
  });

  it('requests a new version turns away (queue full, timeouts) count in the rollback check', () => {
    // the new version is 1000× slower: its servers fill their queues and reject, nothing finishes
    const d = svc({ concurrency: 5, queueLimit: 10 });
    const r = simulate(d, scenario({ seed: 7, durationS: 30, warmupS: 0, traffic: { rps: 400 }, events: [{ type: 'rollout', atS: 5, node: 'svc', waves: 4, waveS: 5, slow: 1000, haltAt: 0.05 }] }));
    expect(types(r)).toContain('rollback');
  });

  it('the rollback check counts real requests in a scaled run', () => {
    // 20 real rps, one of 4 servers per wave: 25 real requests in the 5 s bake, about 12 simulated at scale 2
    const d = design([['users', 'client'], ['lb', 'load_balancer'], ['svc', 'service', { instances: 4, concurrency: 64, serviceMs: { mean: 10, cv: 0 } }]], [['users', 'lb'], ['lb', 'svc']]);
    const sim = new Simulation(d, scenario({ seed: 7, durationS: 30, warmupS: 0, scale: 4, traffic: { rps: 20 }, events: [{ type: 'rollout', atS: 5, node: 'svc', waves: 4, waveS: 5, errorRate: 1, haltAt: 0.05 }] }));
    expect(sim.scalePlan.k).toBe(2);
    // rolled back after wave 1 (5 s + its 5 s bake), not after a later, bigger wave
    expect(sim.runToEnd().timeline.find((e) => e.type === 'rollback')?.t).toBe(10);
  });

  it('a rollout to a cache applies its error rate, and rolls back', () => {
    const d = design(
      [
        ['users', 'client'],
        ['svc', 'service', { instances: 2, concurrency: 100, serviceMs: { mean: 1, cv: 0 } }],
        ['cache', 'cache', { instances: 2 }],
      ],
      [['users', 'svc'], ['svc', 'cache']],
    );
    const r = simulate(d, scenario({ seed: 7, durationS: 30, warmupS: 0, traffic: { rps: 200 }, events: [{ type: 'rollout', atS: 5, node: 'cache', waves: 2, waveS: 5, errorRate: 1, haltAt: 0.05 }] }));
    expect(r.summary.offered - r.summary.ok).toBeGreaterThan(0);
    expect(types(r)).toContain('rollback');
  });
});
