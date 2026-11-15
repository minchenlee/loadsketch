// M3: times close to real systems. Defaults from real autoscalers and databases, the scale-down
// stabilization window, and 30-minute scenarios that still run in seconds.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Simulation, simulate } from '../src/engine/index.ts';
import { simulatePeak } from '../src/engine/limit.ts';
import { planScale, scaleDesign, scaleLive } from '../src/engine/scale.ts';
import { KINDS } from '../src/schema/kinds.ts';
import { fmtAxisTime, fmtClock, timeIncrs } from '../src/app/ui.ts';
import { cpuMs, design, scenario, type EdgeSpec, type NodeSpec } from './helpers.ts';

const root = join(import.meta.dirname, '..');
const load = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'));

describe('defaults are real-world times', () => {
  it('autoscaling: check every minute, boot 2 minutes, scale in after 5 quiet minutes; failover 90 s', () => {
    const p = KINDS.service.params;
    expect(p.scaleEveryS.default).toBe(60);
    expect(p.bootS.default).toBe(120);
    expect(p.scaleDownS.default).toBe(300);
    expect(KINDS.database.params.failoverS.default).toBe(90);
  });
});

describe('scale-down stabilization window', () => {
  // 4× traffic for the first 10 minutes, then back to normal
  const run = (scaleDownS: number) =>
    simulate(
      design(
        [
          ['u', 'client'],
          ['api', 'service', { instances: 2, concurrency: 8, serviceMs: { mean: 20, cv: 0 }, queueLimit: 200, autoscale: 'on', maxInstances: 12, scaleEveryS: 15, bootS: 10, warmS: 0, scaleDownS }],
        ],
        [['u', 'api']],
      ),
      scenario({ durationS: 1200, warmupS: 0, traffic: { rps: 300, readRatio: 1, clientTimeoutMs: 2000 }, events: [{ type: 'spike', atS: 0, forS: 600, multiplier: 4 }] }),
    );
  const firstScaleIn = (r: ReturnType<typeof run>) => r.timeline.find((e) => e.type === 'scale_in')?.t ?? Infinity;

  it('without a window, it gives back the extra instances right away; with one, only after the window', () => {
    const scaleIns = (r: ReturnType<typeof run>) => r.timeline.filter((e) => e.type === 'scale_in').map((e) => e.t);
    const lastBackTo2 = (r: ReturnType<typeof run>) => r.timeline.filter((e) => e.type === 'scale_in' && /剩 2 台/.test(e.text)).at(-1)?.t ?? Infinity;
    // while the instances boot, the checks overshoot to 7; the load needs 5
    const quick = run(0);
    const calm = run(300);
    expect(firstScaleIn(quick)).toBeLessThan(120);
    expect(firstScaleIn(calm)).toBeGreaterThanOrEqual(30 + 300);
    // after the crowd leaves at 600 s: back to 2 at the next check, or 300 s later
    expect(lastBackTo2(quick)).toBeLessThanOrEqual(630);
    expect(lastBackTo2(calm)).toBeGreaterThanOrEqual(900);
    expect(scaleIns(calm).length).toBeLessThanOrEqual(scaleIns(quick).length);
  }, 30_000);

  it('then it removes several at once, down to what the window needed', () => {
    const r = run(300);
    const ins = r.timeline.filter((e) => e.type === 'scale_in');
    expect(ins.length).toBeGreaterThan(0);
    expect(r.nodes.api.autoscale!.retires).toBeGreaterThan(ins.length);
  }, 30_000);
});

describe('a 30-minute scenario', () => {
  it('flash crowd on the autoscaling example: 1.26 M requests in seconds; fails while machines boot, then recovers', () => {
    let r!: ReturnType<typeof simulate>;
    // a speed budget in CPU time, so a busy machine does not fail it
    expect(cpuMs(() => (r = simulate(load('examples/designs/autoscale.json'), load('examples/scenarios/flash-crowd.json'))))).toBeLessThan(15_000);
    expect(r.summary.offered).toBeGreaterThan(1_200_000);
    expect(r.simulatedS).toBeGreaterThanOrEqual(1800);
    // the first new instances come 2 minutes after the first check that sees the crowd
    const ready = r.timeline.find((e) => e.type === 'scale_ready')!;
    expect(ready.t).toBeGreaterThanOrEqual(300 + 120);
    expect(r.summary.errorRate).toBeGreaterThan(0.01);
    expect(r.summary.errorRate).toBeLessThan(0.1);
  }, 30_000);
});

describe('time labels', () => {
  it('long runs show minutes', () => {
    expect(fmtClock(125)).toBe('2:05');
    expect(fmtAxisTime(300, true)).toBe('5m');
    expect(fmtAxisTime(90, true)).toBe('1:30');
    expect(fmtAxisTime(30, false)).toBe('30s');
    expect(timeIncrs(1800)[0]).toBe(60);
    expect(timeIncrs(60)[0]).toBe(1);
  });
});

describe('scale factor k (Q3): 1/k of the traffic on 1/k of the capacity, counts multiplied back', () => {
  /** users → lb → 10 API servers × 256 slots (1 s each) → db with 512 connections. */
  const big = (extra: Record<string, unknown> = {}) =>
    design(
      [
        ['u', 'client'],
        ['lb', 'load_balancer'],
        ['api', 'service', { instances: 10, concurrency: 256, queueLimit: 1000, serviceMs: { mean: 1000, cv: 1 }, ...extra }],
        ['db', 'database', { connections: 512, readMs: { mean: 2, cv: 1 }, writeMs: { mean: 2, cv: 1 } }],
      ],
      [['u', 'lb'], ['lb', 'api'], ['api', 'db']],
    );

  it('auto picks k from the request count, capped where slots reach 32 and then instances reach 10', () => {
    const d = big({ instances: 20 });
    // 9 million requests want k = 30; api allows 256/32 × 20/10 = 16, db 512/32 = 16
    const plan = planScale(d, 9_000_000);
    expect(plan.k).toBe(16);
    expect(plan.maxK).toBe(16);
    const s = scaleDesign(d, plan);
    const api = s.nodes.find((n) => n.id === 'api')!.params!;
    expect(api.concurrency).toBe(32);
    expect(api.instances).toBe(10);
    expect(api.queueLimit).toBe(125);
    expect(s.nodes.find((n) => n.id === 'db')!.params!.connections).toBe(32);
    // the input is not changed
    expect(d.nodes.find((n) => n.id === 'api')!.params!.concurrency).toBe(256);
  });

  it('a small run, or a design with few slots, stays at full size', () => {
    expect(planScale(big(), 200_000).k).toBe(1);
    const auto = load('examples/designs/autoscale.json');
    // 2 instances × 8 slots: nothing to cut without changing how requests queue
    expect(planScale(auto, 1_260_000).maxK).toBe(1);
    const r = simulate(design([['u', 'client'], ['s', 'service']], [['u', 's']]), scenario({ durationS: 5, traffic: { rps: 100 } }));
    expect(r.scale).toBeUndefined();
  });

  for (const [name, rps] of [['under load (ρ ≈ 0.8)', 2000], ['overloaded (ρ ≈ 1.2)', 3000]] as const) {
    it(`k = 8 gives the same rates and latency as full size, ${name}`, () => {
      const sc = (k: number) => scenario({ durationS: 40, warmupS: 10, traffic: { rps, clientTimeoutMs: 5000 }, scale: k });
      const full = simulate(big(), sc(1));
      const cut = simulate(big(), sc(8));
      expect(full.scale).toBeUndefined();
      expect(cut.scale).toBe(8);
      expect(cut.scenario.rps).toBe(rps);
      // counts are multiplied back: about the same number of requests as at full size
      expect(Math.abs(cut.summary.offered - full.summary.offered)).toBeLessThan(full.summary.offered * 0.05);
      expect(Math.abs(cut.summary.throughputRps - full.summary.throughputRps)).toBeLessThan(full.summary.throughputRps * 0.05);
      expect(Math.abs(cut.nodes.api.arrivals - full.nodes.api.arrivals)).toBeLessThan(full.nodes.api.arrivals * 0.05);
      expect(Math.abs(cut.summary.errorRate - full.summary.errorRate)).toBeLessThan(0.03);
      expect(Math.abs(cut.summary.latencyMs.p50 - full.summary.latencyMs.p50)).toBeLessThan(full.summary.latencyMs.p50 * 0.1);
      expect(Math.abs(cut.nodes.api.utilization! - full.nodes.api.utilization!)).toBeLessThan(0.05);
    });
  }

  it('windows and live state are at full size too', () => {
    const sim = new Simulation(big(), scenario({ durationS: 20, warmupS: 0, traffic: { rps: 2000 }, scale: 8 }));
    sim.runUntil(15_000);
    const live = sim.liveState().api;
    // 10 instances × 256 slots, as in the design
    expect(live.slots).toBe(2560);
    expect(live.inst![0][1]).toBe(256);
    const w = sim.drainWindows().at(-1)!;
    expect(w.targetRps).toBe(2000);
    expect(Math.abs(w.offered - 2000)).toBeLessThan(400);
  });
});

describe('review fixes: the scale-down window does not rescan its history', () => {
  it('298 autoscaled services, a check every second, a one-hour window, one hour: runs in seconds', () => {
    const nodes: NodeSpec[] = [['u', 'client'], ['lb', 'load_balancer']];
    const edges: EdgeSpec[] = [['u', 'lb']];
    for (let i = 0; i < 298; i++) {
      nodes.push([`s${i}`, 'service', { instances: 1, autoscale: 'on', maxInstances: 4, scaleEveryS: 1, scaleDownS: 3600, serviceMs: { mean: 1, cv: 0 } }]);
      edges.push(['lb', `s${i}`]);
    }
    expect(cpuMs(() => simulate(design(nodes, edges), scenario({ durationS: 3600, warmupS: 0, windowS: 60, traffic: { rps: 1 } })))).toBeLessThan(4000);
  });
});

describe('review fixes: the scale factor keeps events, rate caps, bulkheads and per-instance numbers right', () => {
  /** users → lb → 20 API servers × 256 slots → db with 512 connections. */
  const big20 = (edgeExtra: EdgeSpec[2] = undefined) =>
    design(
      [
        ['u', 'client'],
        ['lb', 'load_balancer'],
        ['api', 'service', { instances: 20, concurrency: 256, queueLimit: 1000, serviceMs: { mean: 1000, cv: 1 } }],
        ['db', 'database', { connections: 512, readMs: { mean: 2, cv: 1 }, writeMs: { mean: 2, cv: 1 } }],
      ],
      [['u', 'lb', edgeExtra], ['lb', 'api'], ['api', 'db']],
    );

  it('an event aimed at one instance keeps every instance of that node', () => {
    const d = big20();
    const events = [{ type: 'slow' as const, atS: 5, node: 'api', instance: 15, multiplier: 10 }];
    const plan = planScale(d, 9_000_000, 'auto', events);
    // only the slots can shrink: 256 / 32 = 8
    expect(plan.maxK).toBe(8);
    const api = scaleDesign(d, plan).nodes.find((n) => n.id === 'api')!.params!;
    expect(api.instances).toBe(20);
  });

  it('short bursts count in the request estimate', () => {
    // 5000 rps for 60 s is 300 000; a 1000× burst of 0.1 s every second adds ~30 M
    const sim = new Simulation(
      big20(),
      scenario({ durationS: 60, warmupS: 0, traffic: { rps: 5000 }, events: [{ type: 'cron', atS: 0, everyS: 1, burstS: 0.1, multiplier: 1000 }] }),
    );
    expect(sim.scalePlan.k).toBeGreaterThan(1);
  });

  it('the rate cap applies at full size, not at the simulated size', () => {
    const sc = (k: number) => scenario({ durationS: 2, warmupS: 0, traffic: { rps: 1_000_000, clientTimeoutMs: 1000 }, events: [{ type: 'spike', atS: 0, multiplier: 2 }], scale: k });
    const full = simulate(big20(), sc(1));
    const cut = simulate(big20(), sc(8));
    expect(Math.abs(cut.summary.offered - full.summary.offered)).toBeLessThan(full.summary.offered * 0.05);
  }, 60_000);

  it('a bulkhead on a caller without instances is divided by k', () => {
    const d = big20({ bulkhead: 100 });
    const plan = planScale(d, 0, 8);
    expect(plan.k).toBe(8);
    expect(scaleDesign(d, plan).edges.find((e) => e.from === 'u')!.bulkhead).toBe(13);
  });

  it('a node run with fewer instances shows every instance of the design', () => {
    const sim = new Simulation(big20(), scenario({ durationS: 10, warmupS: 0, traffic: { rps: 2000 }, scale: 16 }));
    expect(sim.scalePlan.nodes.api.to).toBeLessThan(20);
    sim.runUntil(5000);
    expect(sim.liveState().api.inst).toHaveLength(20);
    sim.runUntil(10_000);
    const r = sim.result();
    expect(r.nodes.api.instances).toHaveLength(20);
    expect(r.nodes.api.instances!.map((x) => x.idx)).toEqual([...Array(20).keys()]);
    if (r.bottleneck?.node === 'api' && r.bottleneck.instance !== undefined) expect(r.bottleneck.instance).toBeLessThan(20);
  });

  it('the largest queue is per instance: at most the queue limit of the design', () => {
    // overloaded: queues fill up to the limit
    const r = simulate(big20(), scenario({ durationS: 20, warmupS: 0, traffic: { rps: 8000, clientTimeoutMs: 60_000 }, scale: 16 }));
    expect(r.nodes.api.maxQueue).toBeGreaterThan(0);
    expect(r.nodes.api.maxQueue).toBeLessThanOrEqual(1000);
  });
});

describe('review fixes: rows of a scaled node are design instances', () => {
  const node = (extra: Record<string, unknown>) =>
    design(
      [
        ['u', 'client'],
        ['api', 'service', { instances: 20, concurrency: 256, serviceMs: { mean: 1000, cv: 1 }, ...extra }],
      ],
      [['u', 'api']],
    );

  it('an autoscaled 20–100 node keeps a row for each of its 100 possible instances', () => {
    const sim = new Simulation(node({ autoscale: 'on', maxInstances: 100 }), scenario({ durationS: 10, warmupS: 0, traffic: { rps: 2000 }, scale: 16 }));
    expect(sim.scalePlan.nodes.api).toMatchObject({ from: 100 });
    sim.runUntil(5000);
    expect(sim.liveState().api.inst).toHaveLength(100);
    sim.runUntil(10_000);
    expect(sim.result().nodes.api.instances).toHaveLength(100);
  });

  it('each row has its own name, not the name of the run instance it stands for', () => {
    const r = new Simulation(node({}), scenario({ durationS: 10, warmupS: 0, traffic: { rps: 2000 }, scale: 16 })).runToEnd();
    const rows = r.nodes.api.instances!;
    expect(rows.map((x) => x.role)).toEqual(rows.map((x) => `#${x.idx}`));
  });
});

describe('Item 1: slot and instance rounding preserves total capacity', () => {
  it('20 instances x 40 slots at k = 2 scales to 10 x 40 = 400 slots with consistent NodeScale factors', () => {
    const d = design(
      [
        ['u', 'client'],
        ['api', 'service', { instances: 20, concurrency: 40, queueLimit: 200, serviceMs: { mean: 100, cv: 1 } }],
        ['db', 'database', { connections: 512, readMs: { mean: 2, cv: 0 }, writeMs: { mean: 2, cv: 0 } }],
      ],
      [
        ['u', 'api'],
        ['api', 'db', { bulkhead: 20 }],
      ],
    );
    const plan = planScale(d, 0, 2);
    expect(plan.k).toBe(2);
    const scaled = scaleDesign(d, plan);
    const api = scaled.nodes.find((n) => n.id === 'api')!.params!;
    expect(api.instances).toBe(10);
    expect(api.concurrency).toBe(40);
    expect((api.instances as number) * (api.concurrency as number) * plan.k).toBe(20 * 40);
    expect(plan.nodes.api.slots).toBe(1);
    expect(plan.nodes.api.instances).toBe(2);
    expect(api.queueLimit).toBe(200);
    expect(scaled.edges.find((e) => e.from === 'api')!.bulkhead).toBe(20);
  });

  it('8200 rps on 20 x 40 (100 ms) fails simulatePeak at k = 2 just as at k = 1', () => {
    const d = design(
      [
        ['u', 'client'],
        ['lb', 'load_balancer'],
        ['api', 'service', { instances: 20, concurrency: 40, queueLimit: 1000, serviceMs: { mean: 100, cv: 1 } }],
      ],
      [
        ['u', 'lb'],
        ['lb', 'api'],
      ],
    );
    const full = simulatePeak(d, scenario({ seed: 1, scale: 1, traffic: { rps: 1, clientTimeoutMs: 10_000 } }), 8200);
    const cut = simulatePeak(d, scenario({ seed: 1, scale: 2, traffic: { rps: 1, clientTimeoutMs: 10_000 } }), 8200);
    expect(full.verdict).toBe('fail');
    expect(full.sim.summary.latencyMs.p99).toBeGreaterThan(1000);
    expect(cut.verdict).toBe('fail');
    expect(cut.sim.summary.latencyMs.p99).toBeGreaterThan(1000);
  }, 60_000);

  it('property: across varied (instances, slots, k), capacity error stays strictly bounded and factors match scaleDesign', () => {
    // Upper bound reason:
    // - Whenever inst / k < MIN_INSTANCES (10), i = MIN_INSTANCES gives target / i in [MIN_SLOTS, slot),
    //   so slot2 rounds to within ±0.5 and relative error <= 0.5 / MIN_SLOTS = 1 / (2 * 32) ≈ 1.5625%.
    // - Whenever inst / k >= MIN_INSTANCES, keeping slot2 = slot already allows i = round(inst / k) within ±0.5,
    //   and fitSlotScale checks all i in [MIN_INSTANCES, min(inst, ceil(target / MIN_SLOTS))], so relative error
    //   never exceeds 0.5 / MIN_INSTANCES = 1 / (2 * 10) = 5%.
    const MAX_REL_ERR = 1 / (2 * 10);
    const MAX_REL_ERR_SUB_MIN_INST = 1 / (2 * 32);
    const instCases = [10, 11, 13, 17, 20, 25, 31, 40, 64];
    const slotCases = [32, 33, 40, 48, 50, 64, 100, 128];
    for (const inst of instCases) {
      for (const slot of slotCases) {
        const d = design(
          [
            ['u', 'client'],
            ['api', 'service', { instances: inst, concurrency: slot, queueLimit: 200 }],
            ['db', 'database', { connections: 64 }],
          ],
          [
            ['u', 'api'],
            ['api', 'db', { bulkhead: 20 }],
          ],
        );
        const maxK = planScale(d, 0, 1000).maxK;
        const ks = [...new Set([2, 3, 4, 5, Math.min(maxK, 8), maxK].filter((x) => x >= 2 && x <= maxK))];
        for (const k of ks) {
          const plan = planScale(d, 0, k);
          const scaled = scaleDesign(d, plan);
          const api = scaled.nodes.find((n) => n.id === 'api')!.params!;
          const inst2 = api.instances as number;
          const slot2 = api.concurrency as number;
          expect(inst2).toBeGreaterThanOrEqual(10);
          expect(slot2).toBeGreaterThanOrEqual(32);
          expect(slot2).toBeLessThanOrEqual(slot);
          const relErr = Math.abs(inst2 * slot2 * plan.k - inst * slot) / (inst * slot);
          const bound = inst / plan.k < 10 ? MAX_REL_ERR_SUB_MIN_INST : MAX_REL_ERR;
          expect(relErr).toBeLessThanOrEqual(bound + 1e-12);
          const ns = plan.nodes.api;
          expect(Math.round(inst / ns.instances)).toBe(inst2);
          expect(Math.round(slot / ns.slots)).toBe(slot2);
          expect(api.queueLimit).toBe(Math.max(1, Math.round(200 / ns.slots)));
          expect(scaled.edges.find((e) => e.from === 'api')!.bulkhead).toBe(Math.max(1, Math.round(20 / ns.slots)));
        }
      }
    }
  });

  it('autoscaler min/max instances, scaleLive, and PlanScale rows use the same instance factor', () => {
    const d = design(
      [
        ['u', 'client'],
        ['api', 'service', { instances: 20, autoscale: 'on', maxInstances: 60, concurrency: 40, queueLimit: 200 }],
      ],
      [['u', 'api']],
    );
    const plan = planScale(d, 0, 2);
    const scaled = scaleDesign(d, plan);
    const api = scaled.nodes.find((n) => n.id === 'api')!.params!;
    expect(api.instances).toBe(10);
    expect(api.maxInstances).toBe(30);
    expect(api.concurrency).toBe(40);
    expect(plan.nodes.api.from).toBe(60);
    expect(plan.nodes.api.to).toBe(30);

    // scaleLive scales per-instance rows by slots factor and expands ns.to (30) back to ns.from (60)
    const live = {
      api: {
        busy: 10,
        slots: 400,
        queued: 2,
        down: 1,
        inst: Array.from({ length: 30 }, (_, idx) => [idx < 10 ? 5 : 0, 40, 0, 0, 0] as [number, number, number, number, number]),
      },
    };
    scaleLive(live as never, plan);
    expect(live.api.down).toBe(2);
    expect(live.api.inst).toHaveLength(60);

    // Non-divisible case: 25 * 50 / 2 -> fitSlotScale picks 16 * 39 (inst factor 25/16, slot factor 50/39)
    const d2 = design(
      [
        ['u', 'client'],
        ['api', 'service', { instances: 25, autoscale: 'on', maxInstances: 60, concurrency: 50 }],
      ],
      [['u', 'api']],
    );
    const plan2 = planScale(d2, 0, 2);
    const scaled2 = scaleDesign(d2, plan2);
    const api2 = scaled2.nodes.find((n) => n.id === 'api')!.params!;
    expect(api2.instances).toBe(16);
    expect(api2.concurrency).toBe(39);
    expect(api2.maxInstances).toBe(Math.max(10, Math.round(60 / plan2.nodes.api.instances)));
  });
});

describe('Item 2: rate_limiter burst minimum floor', () => {
  it('scaleDesign clamps scaled burst to at least Math.min(origBurst, 32) only for spike-free fast-refill limiters', () => {
    const spike = [{ type: 'spike' as const, atS: 5, forS: 2, multiplier: 10 }];
    const ramp = [{ type: 'ramp' as const, atS: 5, forS: 2, toMultiplier: 10 }];
    const wave = [{ type: 'wave' as const, atS: 0, periodS: 10, amplitude: 0.5 }];
    const cron = [{ type: 'cron' as const, atS: 1, everyS: 5, burstS: 0.1, multiplier: 20 }];
    const down = [{ type: 'down' as const, atS: 5, forS: 2, node: 'rl' }];

    const rl = (ratePerSec: number, burst: number) =>
      design(
        [
          ['u', 'client'],
          ['rl', 'rate_limiter', { limit: 'rate', ratePerSec, burst }],
        ],
        [['u', 'rl']],
      );
    const scaledBurst = (ratePerSec: number, burst: number, k: number, evs: Parameters<typeof planScale>[3] = []) =>
      scaleDesign(rl(ratePerSec, burst), planScale(rl(ratePerSec, burst), 0, k, evs)).nodes.find((n) => n.id === 'rl')!.params!.burst;

    // Steady (no events) + fast refill (burst / ratePerSec <= 1 s): floor at min(orig, 32)
    expect(scaledBurst(800, 4, 8)).toBe(4);
    expect(scaledBurst(800, 32, 8)).toBe(32);
    expect(scaledBurst(800, 100, 8)).toBe(32);
    expect(scaledBurst(800, 400, 8)).toBe(50);
    expect(scaledBurst(800, 32, 2)).toBe(32);
    expect(scaledBurst(800, 1, 8)).toBe(1);
    // Exact 1 s boundary: burst / ratePerSec === 1 -> floor applies; > 1 s -> scales by 1/k
    expect(scaledBurst(100, 100, 8)).toBe(32);
    expect(scaledBurst(99, 100, 8)).toBe(13);

    // Non-spike events still apply floor when refill is fast
    for (const burst of [4, 32, 100, 400]) {
      expect(scaledBurst(800, burst, 8, down)).toBe(Math.max(Math.min(burst, 32), Math.round(burst / 8)));
    }

    // Slow / zero refill (no events) or any spike-like event: burst scales by 1/k (min 1)
    for (const burst of [4, 32, 100, 400]) {
      const divK = Math.max(1, Math.round(burst / 8));
      expect(scaledBurst(0, burst, 8), `rate=0 burst=${burst}`).toBe(divK);
      expect(scaledBurst(2, burst, 8), `rate=2 burst=${burst}`).toBe(divK);
      expect(scaledBurst(800, burst, 8, spike), `spike burst=${burst}`).toBe(divK);
      expect(scaledBurst(800, burst, 8, ramp), `ramp burst=${burst}`).toBe(divK);
      expect(scaledBurst(800, burst, 8, wave), `wave burst=${burst}`).toBe(divK);
      expect(scaledBurst(800, burst, 8, cron), `cron burst=${burst}`).toBe(divK);
    }
    // rate=10: fast for burst=4 (0.4s <= 1s -> 4), slow for burst=32/100/400 (> 1s -> divK)
    expect(scaledBurst(10, 4, 8)).toBe(4);
    expect(scaledBurst(10, 32, 8)).toBe(4);
    expect(scaledBurst(10, 100, 8)).toBe(13);
    expect(scaledBurst(10, 400, 8)).toBe(50);
  });

  it('steady traffic (no events): rate=800 with burst=4 (600 & 750 rps) and burst=400 (600 rps) preserve k = 8 vs k = 1', () => {
    for (const [burst, rps, maxErr, maxDiff] of [
      [4, 600, 0.15, 0.05],
      [4, 750, 0.25, 0.05],
      [400, 600, 0.001, 0.001],
    ] as const) {
      const d = design(
        [
          ['u', 'client'],
          ['rl', 'rate_limiter', { limit: 'rate', ratePerSec: 800, burst }],
          ['api', 'service', { instances: 20, concurrency: 64, serviceMs: { mean: 1, cv: 0 } }],
        ],
        [
          ['u', 'rl'],
          ['rl', 'api'],
        ],
      );
      const full = simulate(d, scenario({ seed: 1, durationS: 30, scale: 1, traffic: { rps } }));
      const scaled = simulate(d, scenario({ seed: 1, durationS: 30, scale: 8, traffic: { rps } }));
      expect(scaled.summary.errorRate, `burst=${burst} rps=${rps}`).toBeLessThan(maxErr);
      expect(Math.abs(scaled.summary.errorRate - full.summary.errorRate), `burst=${burst} rps=${rps}`).toBeLessThan(maxDiff);
    }
  });

  it('short spike / cron bursts: k = 8 matches k = 1 rejection rate instead of letting bursts slip through', () => {
    const mk = (burst = 32) =>
      design(
        [
          ['u', 'client'],
          ['rl', 'rate_limiter', { limit: 'rate', ratePerSec: 800, burst }],
          ['api', 'service', { instances: 20, concurrency: 64, serviceMs: { mean: 1, cv: 0 } }],
        ],
        [
          ['u', 'rl'],
          ['rl', 'api'],
        ],
      );

    // Cron burst: 10 rps base, every 1 s a 10 ms 800x burst (~80 req/s burst vs burst=32 -> ~45% rejected at k=1;
    // with floor=32 at k=8 it rejected 0%; dividing burst/8 -> 4 preserves rejection within ±0.10 of k=1).
    const cronSc = (scale: number) =>
      scenario({
        seed: 1,
        durationS: 30,
        warmupS: 0,
        scale,
        traffic: { rps: 10 },
        events: [{ type: 'cron', atS: 1, everyS: 1, burstS: 0.01, multiplier: 800 }],
      });
    const cronFull = simulate(mk(), cronSc(1));
    const cronScaled = simulate(mk(), cronSc(8));
    expect(cronFull.summary.errorRate).toBeGreaterThan(0.25);
    expect(cronScaled.summary.errorRate).toBeGreaterThan(0.25);
    expect(Math.abs(cronScaled.summary.errorRate - cronFull.summary.errorRate)).toBeLessThan(0.1);

    // Spike burst: 100 rps base over 1 s, 50x for 0.1 s -> ~66% rejected at k=1, ~55% at k=8 (single 0.1s scaled window has ~62 Poisson draws)
    const spikeSc = (scale: number) =>
      scenario({
        seed: 1,
        durationS: 1,
        warmupS: 0,
        scale,
        traffic: { rps: 100 },
        events: [{ type: 'spike', atS: 0.2, forS: 0.1, multiplier: 50 }],
      });
    const spikeFull = simulate(mk(), spikeSc(1));
    const spikeScaled = simulate(mk(), spikeSc(8));
    expect(spikeFull.summary.errorRate).toBeGreaterThan(0.5);
    expect(spikeScaled.summary.errorRate).toBeGreaterThan(0.45);
    expect(Math.abs(spikeScaled.summary.errorRate - spikeFull.summary.errorRate)).toBeLessThan(0.15);
  });

  it('slow or zero refill (no events): burst acts as total budget and scales by 1/k (rate=0 and rate=1)', () => {
    const mk = (ratePerSec: number) =>
      design(
        [
          ['u', 'client'],
          ['rl', 'rate_limiter', { limit: 'rate', ratePerSec, burst: 32 }],
          ['api', 'service', { instances: 20, concurrency: 256, serviceMs: { mean: 1, cv: 0 } }],
        ],
        [
          ['u', 'rl'],
          ['rl', 'api'],
        ],
      );

    // rate=0: exact initial budget = 32 tokens at k=1 and 4*8 = 32 at k=8 (without fix, floor=32 gave 32*8 = 256)
    const r0Full = simulate(mk(0), scenario({ seed: 1, durationS: 5, warmupS: 0, scale: 1, traffic: { rps: 100 } }));
    const r0Scaled = simulate(mk(0), scenario({ seed: 1, durationS: 5, warmupS: 0, scale: 8, traffic: { rps: 100 } }));
    expect(r0Full.summary.ok).toBe(32);
    expect(r0Scaled.summary.ok).toBe(32);

    // rate=1: ~36 ok at k=1 and same order of magnitude (~32-40) at k=8
    const r1Full = simulate(mk(1), scenario({ seed: 1, durationS: 5, warmupS: 0, scale: 1, traffic: { rps: 100 } }));
    const r1Scaled = simulate(mk(1), scenario({ seed: 1, durationS: 5, warmupS: 0, scale: 8, traffic: { rps: 100 } }));
    expect(r1Full.summary.ok).toBeGreaterThanOrEqual(32);
    expect(r1Full.summary.ok).toBeLessThanOrEqual(40);
    expect(Math.abs(r1Scaled.summary.ok - r1Full.summary.ok)).toBeLessThanOrEqual(10);
  });
});

describe('Item 1 review P2: hash-routed nodes cut slots per instance first', () => {
  it('cache 20 x 65 at k = 2 scales to 20 x 33 instead of shrinking instances to 13 x 50', () => {
    const d = design(
      [
        ['u', 'client'],
        ['c', 'cache', { instances: 20, concurrency: 65, queueLimit: 500 }],
      ],
      [['u', 'c']],
    );
    const plan = planScale(d, 0, 2);
    const scaled = scaleDesign(d, plan);
    const cp = scaled.nodes.find((n) => n.id === 'c')!.params!;
    expect(plan.nodes.c.slots).toBe(2);
    expect(plan.nodes.c.instances).toBe(1);
    expect(cp.instances).toBe(20);
    expect(cp.concurrency).toBe(33);
    expect(cp.queueLimit).toBe(250);
  });

  it('single hot key on cache 20 x 65 at 800 rps (100 ms) still overflows at k = 2', () => {
    // At k = 1, all 800 rps hit 1 instance of 65 slots (650 rps capacity -> ~18.75% overflow).
    // Preserving slots = 65/2 -> 33 keeps capacity = 330 rps < 400 rps (~17.5% overflow),
    // whereas shrinking instances to 13 x 50 gave 500 rps capacity > 400 rps (~0% error).
    const d = design(
      [
        ['u', 'client'],
        ['c', 'cache', { instances: 20, concurrency: 65, queueLimit: 20, opMs: { mean: 100, cv: 1 } }],
      ],
      [['u', 'c']],
    );
    const full = simulate(d, scenario({ seed: 1, durationS: 30, warmupS: 5, scale: 1, traffic: { rps: 800 }, keys: { count: 1 } }));
    const scaled = simulate(d, scenario({ seed: 1, durationS: 30, warmupS: 5, scale: 2, traffic: { rps: 800 }, keys: { count: 1 } }));
    expect(full.summary.errorRate).toBeGreaterThan(0.1);
    expect(scaled.summary.errorRate).toBeGreaterThan(0.1);
    expect(Math.abs(scaled.summary.errorRate - full.summary.errorRate)).toBeLessThan(0.05);
  });

  it('cache, database, and sharded_db match the pre-fix slots-first scaling table', () => {
    const cacheCases: Array<[number, number, number]> = [
      [20, 65, 2],
      [20, 40, 2],
      [25, 50, 2],
      [30, 80, 3],
      [16, 128, 4],
      [12, 32, 1],
    ];
    for (const [inst, slot, k] of cacheCases) {
      const d = design(
        [
          ['u', 'client'],
          ['c', 'cache', { instances: inst, concurrency: slot, queueLimit: 400 }],
        ],
        [['u', 'c']],
      );
      const plan = planScale(d, 0, k);
      const scaled = scaleDesign(d, plan);
      const cp = scaled.nodes.find((n) => n.id === 'c')!.params!;
      const expectedSlotsFactor = Math.min(k, Math.max(1, slot / 32));
      const expectedInstFactor = k / expectedSlotsFactor;
      expect(plan.nodes.c.slots).toBeCloseTo(expectedSlotsFactor, 12);
      expect(plan.nodes.c.instances).toBeCloseTo(expectedInstFactor, 12);
      expect(cp.instances).toBe(Math.max(1, Math.round(inst / expectedInstFactor)));
      expect(cp.concurrency).toBe(Math.max(1, Math.round(slot / expectedSlotsFactor)));
    }

    for (const kind of ['database', 'sharded_db'] as const) {
      const params: Record<string, number> = kind === 'sharded_db'
        ? { connections: 100, queueLimit: 500, shards: 4 }
        : { connections: 100, queueLimit: 500 };
      const d = design(
        [
          ['u', 'client'],
          ['db', kind, params],
        ],
        [['u', 'db']],
      );
      const plan = planScale(d, 0, 3);
      const scaled = scaleDesign(d, plan);
      const dp = scaled.nodes.find((n) => n.id === 'db')!.params!;
      expect(plan.nodes.db.slots).toBe(3);
      expect(dp.connections).toBe(33);
      expect(dp.queueLimit).toBe(167);
    }
  });
});

describe('Item 1 review P2-1: nodes sharing an upstream instance pool use slots-first scaling', () => {
  it('LB -> two services (20x65 and 20x64) at k = 2 preserves 20:20 instance ratio (20x33 and 20x32)', () => {
    const d = design(
      [
        ['u', 'client'],
        ['lb', 'load_balancer', { policy: 'least_conn' }],
        ['a', 'service', { instances: 20, concurrency: 65, queueLimit: 0, serviceMs: { mean: 100, cv: 1 } }],
        ['b', 'service', { instances: 20, concurrency: 64, queueLimit: 0, serviceMs: { mean: 100, cv: 1 } }],
      ],
      [
        ['u', 'lb'],
        ['lb', 'a'],
        ['lb', 'b'],
      ],
    );
    const plan = planScale(d, 0, 2);
    const scaled = scaleDesign(d, plan);
    const a = scaled.nodes.find((n) => n.id === 'a')!.params!;
    const b = scaled.nodes.find((n) => n.id === 'b')!.params!;
    expect(a.instances).toBe(20);
    expect(a.concurrency).toBe(33);
    expect(b.instances).toBe(20);
    expect(b.concurrency).toBe(32);
    expect((a.instances as number) / (b.instances as number)).toBe(1);
  });

  it('simulation: LB -> 20x65 and 20x64 at 25000 rps keeps k = 2 error rate close to k = 1', () => {
    // At k = 1, both receive 50% of 25000 rps across 2580 slots (rho ≈ 0.969, low Erlang B loss).
    // With 13x50 + 20x32, the 39/61 instance split sends ~60.6% traffic to b (rho > 1.18 -> ~10%+ error).
    // Preserving 20x33 + 20x32 keeps the 50/50 split (~1.3% error, within 0.02 of k = 1).
    const d = design(
      [
        ['u', 'client'],
        ['lb', 'load_balancer', { policy: 'least_conn' }],
        ['a', 'service', { instances: 20, concurrency: 65, queueLimit: 0, serviceMs: { mean: 100, cv: 1 } }],
        ['b', 'service', { instances: 20, concurrency: 64, queueLimit: 0, serviceMs: { mean: 100, cv: 1 } }],
      ],
      [
        ['u', 'lb'],
        ['lb', 'a'],
        ['lb', 'b'],
      ],
    );
    const full = simulate(d, scenario({ seed: 1, durationS: 10, warmupS: 2, scale: 1, traffic: { rps: 25_000 } }));
    const scaled = simulate(d, scenario({ seed: 1, durationS: 10, warmupS: 2, scale: 2, traffic: { rps: 25_000 } }));
    expect(full.summary.errorRate).toBeLessThan(0.03);
    expect(scaled.summary.errorRate).toBeLessThan(0.03);
    expect(Math.abs(scaled.summary.errorRate - full.summary.errorRate)).toBeLessThan(0.02);
  });

  it('solo service behind LB (20x40) still uses joint optimization -> 10x40 at k = 2', () => {
    const d = design(
      [
        ['u', 'client'],
        ['lb', 'load_balancer'],
        ['a', 'service', { instances: 20, concurrency: 40 }],
      ],
      [
        ['u', 'lb'],
        ['lb', 'a'],
      ],
    );
    const scaled = scaleDesign(d, planScale(d, 0, 2));
    const a = scaled.nodes.find((n) => n.id === 'a')!.params!;
    expect(a.instances).toBe(10);
    expect(a.concurrency).toBe(40);
  });

  it('queue feeding two consumer workers (20x65 and 20x64) also preserves 20:20 ratio', () => {
    const d = design(
      [
        ['u', 'client'],
        ['q', 'queue'],
        ['w1', 'worker', { instances: 20, concurrency: 65 }],
        ['w2', 'worker', { instances: 20, concurrency: 64 }],
      ],
      [
        ['u', 'q'],
        ['q', 'w1'],
        ['q', 'w2'],
      ],
    );
    const scaled = scaleDesign(d, planScale(d, 0, 2));
    const w1 = scaled.nodes.find((n) => n.id === 'w1')!.params!;
    const w2 = scaled.nodes.find((n) => n.id === 'w2')!.params!;
    expect(w1.instances).toBe(20);
    expect(w1.concurrency).toBe(33);
    expect(w2.instances).toBe(20);
    expect(w2.concurrency).toBe(32);
  });

  it('LB -> service 20x67 alongside single-entry target (function, queue, cache, database) scales service to 20x34', () => {
    for (const [otherId, otherKind, extra] of [
      ['fn', 'function', {}],
      ['q', 'queue', {}],
      ['c', 'cache', { instances: 4, concurrency: 64 }],
      ['db', 'database', { connections: 64 }],
    ] as const) {
      const d = design(
        [
          ['u', 'client'],
          ['lb', 'load_balancer'],
          ['a', 'service', { instances: 20, concurrency: 67 }],
          [otherId, otherKind, extra],
        ],
        [
          ['u', 'lb'],
          ['lb', 'a'],
          ['lb', otherId],
        ],
      );
      const scaled = scaleDesign(d, planScale(d, 0, 2));
      const a = scaled.nodes.find((n) => n.id === 'a')!.params!;
      expect(a.instances, `sibling ${otherKind}`).toBe(20);
      expect(a.concurrency, `sibling ${otherKind}`).toBe(34);
    }
  });

  it('LB edge filtering: disjoint ops/apis stay independent; overlapping op/api shares pool regardless of edge weights', () => {
    // Disjoint on ('read' vs 'write'): pools never overlap
    const disjointOp = design(
      [
        ['u', 'client'],
        ['lb', 'load_balancer'],
        ['a', 'service', { instances: 20, concurrency: 40 }],
        ['fn', 'function'],
      ],
      [
        ['u', 'lb'],
        ['lb', 'a', { on: 'read' }],
        ['lb', 'fn', { on: 'write' }],
      ],
    );
    const aOp = scaleDesign(disjointOp, planScale(disjointOp, 0, 2)).nodes.find((n) => n.id === 'a')!.params!;
    expect(aOp.instances).toBe(10);
    expect(aOp.concurrency).toBe(40);

    // Disjoint APIs: never share a pool
    const disjointApi = design(
      [
        ['u', 'client'],
        ['lb', 'load_balancer'],
        ['a', 'service', { instances: 20, concurrency: 40 }],
        ['fn', 'function'],
      ],
      [
        ['u', 'lb'],
        ['lb', 'a', { apis: ['r'] }],
        ['lb', 'fn', { apis: ['w'] }],
      ],
      'test',
      [
        { name: 'r', op: 'read' },
        { name: 'w', op: 'write' },
      ],
    );
    const aApi = scaleDesign(disjointApi, planScale(disjointApi, 0, 2)).nodes.find((n) => n.id === 'a')!.params!;
    expect(aApi.instances).toBe(10);
    expect(aApi.concurrency).toBe(40);

    // Overlapping op ('all' + 'read'): shares the READ pool -> slots-first (20x34)
    const overlap = design(
      [
        ['u', 'client'],
        ['lb', 'load_balancer'],
        ['a', 'service', { instances: 20, concurrency: 67 }],
        ['fn', 'function'],
      ],
      [
        ['u', 'lb'],
        ['lb', 'a', { on: 'all' }],
        ['lb', 'fn', { on: 'read' }],
      ],
    );
    const aOverlap = scaleDesign(overlap, planScale(overlap, 0, 2)).nodes.find((n) => n.id === 'a')!.params!;
    expect(aOverlap.instances).toBe(20);
    expect(aOverlap.concurrency).toBe(34);

    // Unequal weights still share the slots-first pool because `shift` events can equalize weights mid-run (20x40 slots-first at k = 2 -> 13x32)
    const weighted = design(
      [
        ['u', 'client'],
        ['lb', 'load_balancer'],
        ['a', 'service', { instances: 20, concurrency: 40 }],
        ['b', 'service', { instances: 20, concurrency: 64 }],
      ],
      [
        ['u', 'lb'],
        ['lb', 'a', { weight: 3 }],
        ['lb', 'b', { weight: 1 }],
      ],
    );
    const aWeighted = scaleDesign(weighted, planScale(weighted, 0, 2)).nodes.find((n) => n.id === 'a')!.params!;
    expect(aWeighted.instances).toBe(13);
    expect(aWeighted.concurrency).toBe(32);

    // Queue -> sole worker + overflow function: dispatch spills to fns only when all worker slots are busy -> joint (10x67)
    const qOverflow = design(
      [
        ['u', 'client'],
        ['q', 'queue'],
        ['w', 'worker', { instances: 20, concurrency: 67 }],
        ['fn', 'function'],
      ],
      [
        ['u', 'q'],
        ['q', 'w'],
        ['q', 'fn'],
      ],
    );
    const wSolo = scaleDesign(qOverflow, planScale(qOverflow, 0, 2)).nodes.find((n) => n.id === 'w')!.params!;
    expect(wSolo.instances).toBe(10);
    expect(wSolo.concurrency).toBe(67);
  });

  it('LB -> 20x65 (weight 3) + 20x64 (weight 1) at k = 2 ignores weights -> 20x33 + 20x32', () => {
    const d = design(
      [
        ['u', 'client'],
        ['lb', 'load_balancer'],
        ['a', 'service', { instances: 20, concurrency: 65 }],
        ['b', 'service', { instances: 20, concurrency: 64 }],
      ],
      [
        ['u', 'lb'],
        ['lb', 'a', { weight: 3 }],
        ['lb', 'b', { weight: 1 }],
      ],
    );
    const scaled = scaleDesign(d, planScale(d, 0, 2));
    const a = scaled.nodes.find((n) => n.id === 'a')!.params!;
    const b = scaled.nodes.find((n) => n.id === 'b')!.params!;
    expect(a.instances).toBe(20);
    expect(a.concurrency).toBe(33);
    expect(b.instances).toBe(20);
    expect(b.concurrency).toBe(32);
  });

  it('LB -> 20x65 (weight 3) + 20x64 (weight 0) at k = 2 ignores zero weights -> 20x33 + 20x32', () => {
    const d = design(
      [
        ['u', 'client'],
        ['lb', 'load_balancer'],
        ['a', 'service', { instances: 20, concurrency: 65 }],
        ['b', 'service', { instances: 20, concurrency: 64 }],
      ],
      [
        ['u', 'lb'],
        ['lb', 'a', { weight: 3 }],
        ['lb', 'b', { weight: 0 }],
      ],
    );
    const scaled = scaleDesign(d, planScale(d, 0, 2));
    const a = scaled.nodes.find((n) => n.id === 'a')!.params!;
    const b = scaled.nodes.find((n) => n.id === 'b')!.params!;
    expect(a.instances).toBe(20);
    expect(a.concurrency).toBe(33);
    expect(b.instances).toBe(20);
    expect(b.concurrency).toBe(32);
  });
});
