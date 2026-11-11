// M3: times close to real systems. Defaults from real autoscalers and databases, the scale-down
// stabilization window, and 30-minute scenarios that still run in seconds.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Simulation, simulate } from '../src/engine/index.ts';
import { planScale, scaleDesign } from '../src/engine/scale.ts';
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
