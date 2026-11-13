// Shared accuracy benchmark cases for tests/accuracy.test.ts and scripts/accuracy.ts.
import {
  Simulation,
  ekm1Wait,
  erlangC,
  mgc,
  mm1SojournQuantileMs,
  mm1TimeoutProb,
  mmckBlocking,
  retryAmplification,
  retryFailureRate,
  simulate,
  type SimResult,
} from '../src/engine/index.ts';
import { design, scenario, slope, within } from './helpers.ts';

export interface AccuracyCase {
  id: string;
  name: string;
  category: string;
  metric: string;
  unit: 'ms' | 'rps' | 'ratio' | 'req/s';
  tolerance: number;
  measure: () => { expected: number; actual: number };
  knownDeviation?: {
    expectedActual: number;
    actualTolerance: number;
    reason: string;
  };
}

export interface AccuracyMeasurement {
  id: string;
  name: string;
  category: string;
  metric: string;
  unit: AccuracyCase['unit'];
  expected: number;
  actual: number;
  relError: number;
  tolerance: number;
  status: 'pass' | 'known-deviation' | 'fail';
  knownDeviation?: AccuracyCase['knownDeviation'];
}

const simCache = new Map<string, SimResult>();
function cachedSim(key: string, fn: () => SimResult): SimResult {
  let r = simCache.get(key);
  if (!r) {
    r = fn();
    simCache.set(key, r);
  }
  return r;
}

/** Single queueing station with no downstream calls. */
function single(c: number, meanMs: number, cv: number, queueLimit = 100000) {
  return design(
    [
      ['users', 'client'],
      ['svc', 'service', { instances: 1, concurrency: c, serviceMs: { mean: meanMs, cv }, queueLimit }],
    ],
    [['users', 'svc']],
  );
}

/** Large 10×256 API → 512 DB design from tests/timescale.test.ts for scale factor k tests. */
function bigDesign() {
  return design(
    [
      ['u', 'client'],
      ['lb', 'load_balancer'],
      ['api', 'service', { instances: 10, concurrency: 256, queueLimit: 1000, serviceMs: { mean: 1000, cv: 1 } }],
      ['db', 'database', { connections: 512, readMs: { mean: 2, cv: 1 }, writeMs: { mean: 2, cv: 1 } }],
    ],
    [['u', 'lb'], ['lb', 'api'], ['api', 'db']],
  );
}

export const ACCURACY_CASES: AccuracyCase[] = [
  // --- M/M/1 (from tests/queueing.test.ts) ---
  {
    id: 'mm1-rho05-mean',
    name: 'M/M/1 (rho = 0.5)',
    category: 'M/M/1',
    metric: 'Mean latency',
    unit: 'ms',
    tolerance: 0.05,
    measure: () => {
      const r = cachedSim('mm1-05', () =>
        simulate(single(1, 10, 1), scenario({ seed: 7, durationS: 3000, warmupS: 50, traffic: { rps: 50, clientTimeoutMs: 600000 } })),
      );
      return { expected: 1 / (0.1 - 0.05), actual: r.summary.latencyMs.mean };
    },
  },
  {
    id: 'mm1-rho05-p99',
    name: 'M/M/1 (rho = 0.5)',
    category: 'M/M/1',
    metric: 'p99 latency',
    unit: 'ms',
    tolerance: 0.1,
    measure: () => {
      const r = cachedSim('mm1-05', () =>
        simulate(single(1, 10, 1), scenario({ seed: 7, durationS: 3000, warmupS: 50, traffic: { rps: 50, clientTimeoutMs: 600000 } })),
      );
      return { expected: mm1SojournQuantileMs(0.05, 0.1, 0.99), actual: r.summary.latencyMs.p99 };
    },
  },
  {
    id: 'mm1-rho08-mean',
    name: 'M/M/1 (rho = 0.8)',
    category: 'M/M/1',
    metric: 'Mean latency',
    unit: 'ms',
    tolerance: 0.05,
    measure: () => {
      const r = cachedSim('mm1-08', () =>
        simulate(single(1, 10, 1), scenario({ seed: 7, durationS: 3000, warmupS: 50, traffic: { rps: 80, clientTimeoutMs: 600000 } })),
      );
      return { expected: 1 / (0.1 - 0.08), actual: r.summary.latencyMs.mean };
    },
  },
  {
    id: 'mm1-rho08-p99',
    name: 'M/M/1 (rho = 0.8)',
    category: 'M/M/1',
    metric: 'p99 latency',
    unit: 'ms',
    tolerance: 0.1,
    measure: () => {
      const r = cachedSim('mm1-08', () =>
        simulate(single(1, 10, 1), scenario({ seed: 7, durationS: 3000, warmupS: 50, traffic: { rps: 80, clientTimeoutMs: 600000 } })),
      );
      return { expected: mm1SojournQuantileMs(0.08, 0.1, 0.99), actual: r.summary.latencyMs.p99 };
    },
  },

  // --- M/M/c (from tests/queueing.test.ts + Queue/Worker) ---
  {
    id: 'mm4-rho08-wait',
    name: 'M/M/4 (rho = 0.8)',
    category: 'M/M/c',
    metric: 'Mean wait',
    unit: 'ms',
    tolerance: 0.1,
    measure: () => {
      const r = cachedSim('mm4-08', () =>
        simulate(single(4, 10, 1), scenario({ seed: 3, durationS: 2000, warmupS: 50, traffic: { rps: 320, clientTimeoutMs: 600000 } })),
      );
      return { expected: mgc(0.32, 10, 4, 1, 1).waitMs, actual: r.nodes.svc.waitMs! };
    },
  },
  {
    id: 'mm4-rho08-pwait',
    name: 'M/M/4 (rho = 0.8)',
    category: 'M/M/c',
    metric: 'P(wait)',
    unit: 'ratio',
    tolerance: 0.1,
    measure: () => {
      const r = cachedSim('mm4-08', () =>
        simulate(single(4, 10, 1), scenario({ seed: 3, durationS: 2000, warmupS: 50, traffic: { rps: 320, clientTimeoutMs: 600000 } })),
      );
      return { expected: erlangC(4, 3.2), actual: r.nodes.svc.theory!.simPWait };
    },
  },
  {
    id: 'queue-worker-mm4-wait',
    name: 'Queue + 2x2 Workers (rho = 0.8)',
    category: 'M/M/c',
    metric: 'Async mean wait',
    unit: 'ms',
    tolerance: 0.1,
    measure: () => {
      const d = design(
        [
          ['u', 'client'],
          ['q', 'queue', { enqueueMs: { mean: 0, cv: 0 }, maxDepth: 100000 }],
          ['w', 'worker', { instances: 2, concurrency: 2, serviceMs: { mean: 10, cv: 1 }, queueLimit: 100 }],
        ],
        [['u', 'q'], ['q', 'w']],
      );
      const r = simulate(d, scenario({ seed: 7, durationS: 1000, warmupS: 50, traffic: { rps: 320, clientTimeoutMs: 600000 } }));
      return { expected: mgc(0.32, 10, 4, 1, 1).waitMs, actual: r.summary.asyncLatencyMs.mean - 10 };
    },
  },

  // --- M/D/1 (from tests/queueing.test.ts) ---
  {
    id: 'md1-rho07-wait',
    name: 'M/D/1 (rho = 0.7)',
    category: 'M/D/1',
    metric: 'Mean wait',
    unit: 'ms',
    tolerance: 0.08,
    measure: () => {
      const r = simulate(single(1, 10, 0), scenario({ seed: 5, durationS: 2000, warmupS: 50, traffic: { rps: 70, clientTimeoutMs: 600000 } }));
      return { expected: mgc(0.07, 10, 1, 0, 1).waitMs, actual: r.nodes.svc.waitMs! };
    },
  },

  // --- Overload (from tests/queueing.test.ts) ---
  {
    id: 'overload-queue-growth',
    name: 'Overload (lambda = 1.2 mu)',
    category: 'Overload',
    metric: 'Queue growth rate',
    unit: 'req/s',
    tolerance: 0.1,
    measure: () => {
      const sim = new Simulation(single(1, 1, 1), scenario({ seed: 11, durationS: 100, warmupS: 1, traffic: { rps: 1200, clientTimeoutMs: 600000 } }));
      sim.runUntil(100_000);
      const ws = sim.allWindows().filter((w) => w.t >= 10 && w.t <= 100);
      const k = slope(ws.map((w) => w.t), ws.map((w) => w.nodes.svc.queue!));
      return { expected: 200, actual: k };
    },
  },

  // --- M/M/c/K (bounded queue rejection) ---
  {
    id: 'mm1k-blocking',
    name: 'M/M/1/5 (c = 1, queueLimit = 4, rho = 1.0)',
    category: 'M/M/c/K',
    metric: 'Rejection ratio',
    unit: 'ratio',
    tolerance: 0.05,
    measure: () => {
      const r = simulate(single(1, 10, 1, 4), scenario({ seed: 7, durationS: 1000, warmupS: 20, traffic: { rps: 100, clientTimeoutMs: 600000 } }));
      return { expected: mmckBlocking(1, 5, 1.0), actual: r.summary.fail.queue_full / r.summary.offered };
    },
  },
  {
    id: 'mmck-blocking',
    name: 'M/M/4/10 (c = 4, queueLimit = 6, rho = 1.2)',
    category: 'M/M/c/K',
    metric: 'Rejection ratio',
    unit: 'ratio',
    tolerance: 0.05,
    measure: () => {
      const r = simulate(single(4, 10, 1, 6), scenario({ seed: 7, durationS: 1000, warmupS: 20, traffic: { rps: 480, clientTimeoutMs: 600000 } }));
      return { expected: mmckBlocking(4, 10, 4.8), actual: r.summary.fail.queue_full / r.summary.offered };
    },
  },

  // --- Two stations in series ---
  {
    id: 'series-unblocked-latency',
    name: 'Series: c1 = 64 (5 ms) -> c2 = 1 (10 ms), 80 rps',
    category: 'Series',
    metric: 'Mean latency',
    unit: 'ms',
    tolerance: 0.05,
    measure: () => {
      const r = cachedSim('series-64-1', () => {
        const d = design(
          [
            ['u', 'client'],
            ['s1', 'service', { instances: 1, concurrency: 64, serviceMs: { mean: 5, cv: 1 }, queueLimit: 100000 }],
            ['s2', 'service', { instances: 1, concurrency: 1, serviceMs: { mean: 10, cv: 1 }, queueLimit: 100000 }],
          ],
          [['u', 's1'], ['s1', 's2']],
        );
        return simulate(d, scenario({ seed: 7, durationS: 1000, warmupS: 50, traffic: { rps: 80, clientTimeoutMs: 600000 } }));
      });
      return { expected: 5 + 1 / (0.1 - 0.08), actual: r.summary.latencyMs.mean };
    },
  },
  {
    id: 'series-unblocked-hold',
    name: 'Series: c1 = 64 (5 ms) -> c2 = 1 (10 ms), 80 rps',
    category: 'Series',
    metric: 'Upstream hold time',
    unit: 'ms',
    tolerance: 0.05,
    measure: () => {
      const r = cachedSim('series-64-1', () => {
        const d = design(
          [
            ['u', 'client'],
            ['s1', 'service', { instances: 1, concurrency: 64, serviceMs: { mean: 5, cv: 1 }, queueLimit: 100000 }],
            ['s2', 'service', { instances: 1, concurrency: 1, serviceMs: { mean: 10, cv: 1 }, queueLimit: 100000 }],
          ],
          [['u', 's1'], ['s1', 's2']],
        );
        return simulate(d, scenario({ seed: 7, durationS: 1000, warmupS: 50, traffic: { rps: 80, clientTimeoutMs: 600000 } }));
      });
      return { expected: 5 + 1 / (0.1 - 0.08), actual: r.nodes.s1.holdMs! };
    },
  },
  {
    id: 'series-blocking-mg1',
    name: 'Series blocking: c1 = 1 (5 ms) -> c2 = 1 (5 ms), 50 rps',
    category: 'Series',
    metric: 'Mean latency (blocking M/G/1)',
    unit: 'ms',
    tolerance: 0.05,
    measure: () => {
      const d = design(
        [
          ['u', 'client'],
          ['s1', 'service', { instances: 1, concurrency: 1, serviceMs: { mean: 5, cv: 1 }, queueLimit: 100000 }],
          ['s2', 'service', { instances: 1, concurrency: 1, serviceMs: { mean: 5, cv: 1 }, queueLimit: 100000 }],
        ],
        [['u', 's1'], ['s1', 's2']],
      );
      const r = simulate(d, scenario({ seed: 7, durationS: 1000, warmupS: 50, traffic: { rps: 50, clientTimeoutMs: 600000 } }));
      // Blocking slot means c1=1 serializes s1+s2 into a single M/G/1 with S = S1 + S2 (mean 10 ms, cs2 = 0.5).
      return { expected: mgc(0.05, 10, 1, 0.5, 1).sojournMs, actual: r.summary.latencyMs.mean };
    },
  },

  // --- Retries ---
  {
    id: 'retry-amplification',
    name: 'Retries (errorRate = 0.2, retries = 2)',
    category: 'Retries',
    metric: 'Calls / request',
    unit: 'ratio',
    tolerance: 0.03,
    measure: () => {
      const d = design(
        [
          ['u', 'client'],
          ['s', 'service', { instances: 1, concurrency: 100, serviceMs: { mean: 1, cv: 0 }, errorRate: 0.2, queueLimit: 100000 }],
        ],
        [['u', 's', { retries: 2, backoffMs: 0 }]],
      );
      const r = simulate(d, scenario({ seed: 7, durationS: 1000, warmupS: 10, traffic: { rps: 100, clientTimeoutMs: 600000 } }));
      return { expected: retryAmplification(0.2, 2), actual: r.edges['u->s'].calls / r.summary.offered };
    },
  },
  {
    id: 'retry-final-error',
    name: 'Retries (errorRate = 0.5, retries = 2)',
    category: 'Retries',
    metric: 'Final failure rate',
    unit: 'ratio',
    tolerance: 0.05,
    measure: () => {
      const d = design(
        [
          ['u', 'client'],
          ['s', 'service', { instances: 1, concurrency: 100, serviceMs: { mean: 1, cv: 0 }, errorRate: 0.5, queueLimit: 100000 }],
        ],
        [['u', 's', { retries: 2, backoffMs: 0 }]],
      );
      const r = simulate(d, scenario({ seed: 7, durationS: 1000, warmupS: 10, traffic: { rps: 100, clientTimeoutMs: 600000 } }));
      return { expected: retryFailureRate(0.5, 2), actual: r.summary.errorRate };
    },
  },

  // --- Load balancing ---
  {
    id: 'lb-weighted-split',
    name: 'LB weighted split (3:1)',
    category: 'Load balancing',
    metric: 'Primary backend share',
    unit: 'ratio',
    tolerance: 0.02,
    measure: () => {
      const d = design(
        [
          ['u', 'client'],
          ['lb', 'load_balancer', { policy: 'round_robin', latencyMs: { mean: 0, cv: 0 } }],
          ['a', 'service', { instances: 1, concurrency: 100, serviceMs: { mean: 1, cv: 0 }, queueLimit: 100000 }],
          ['b', 'service', { instances: 1, concurrency: 100, serviceMs: { mean: 1, cv: 0 }, queueLimit: 100000 }],
        ],
        [['u', 'lb'], ['lb', 'a', { weight: 3 }], ['lb', 'b', { weight: 1 }]],
      );
      const r = simulate(d, scenario({ seed: 7, durationS: 500, warmupS: 10, traffic: { rps: 100, clientTimeoutMs: 600000 } }));
      return { expected: 0.75, actual: r.nodes.a.arrivals / r.nodes.lb.arrivals };
    },
  },
  {
    id: 'lb-random-wait',
    name: 'LB random (4x1 instances, rho = 0.5)',
    category: 'Load balancing',
    metric: 'Mean wait',
    unit: 'ms',
    tolerance: 0.08,
    measure: () => {
      const d = design(
        [
          ['u', 'client'],
          ['lb', 'load_balancer', { policy: 'random', latencyMs: { mean: 0, cv: 0 } }],
          ['s', 'service', { instances: 4, concurrency: 1, serviceMs: { mean: 10, cv: 1 }, queueLimit: 100000 }],
        ],
        [['u', 'lb'], ['lb', 's']],
      );
      const r = simulate(d, scenario({ seed: 7, durationS: 1000, warmupS: 50, traffic: { rps: 200, clientTimeoutMs: 600000 } }));
      return { expected: mgc(0.05, 10, 1, 1, 1).waitMs, actual: r.nodes.s.waitMs! };
    },
  },
  {
    id: 'lb-round-robin-ekm1',
    name: 'LB round-robin (4x1 instances, rho = 0.5)',
    category: 'Load balancing',
    metric: 'Mean wait vs E_4/M/1',
    unit: 'ms',
    tolerance: 0.08,
    measure: () => {
      const r = cachedSim('lb-rr-4x1', () => {
        const d = design(
          [
            ['u', 'client'],
            ['lb', 'load_balancer', { policy: 'round_robin', latencyMs: { mean: 0, cv: 0 } }],
            ['s', 'service', { instances: 4, concurrency: 1, serviceMs: { mean: 10, cv: 1 }, queueLimit: 100000 }],
          ],
          [['u', 'lb'], ['lb', 's']],
        );
        return simulate(d, scenario({ seed: 7, durationS: 1000, warmupS: 50, traffic: { rps: 200, clientTimeoutMs: 600000 } }));
      });
      return { expected: ekm1Wait(4, 0.05, 0.1).waitMs, actual: r.nodes.s.waitMs! };
    },
  },
  {
    id: 'lb-round-robin-node-theory',
    name: 'LB round-robin (4x1) vs reported node.theory',
    category: 'Load balancing',
    metric: 'Mean wait vs Poisson theory row',
    unit: 'ms',
    tolerance: 0.1,
    measure: () => {
      const r = cachedSim('lb-rr-4x1', () => {
        const d = design(
          [
            ['u', 'client'],
            ['lb', 'load_balancer', { policy: 'round_robin', latencyMs: { mean: 0, cv: 0 } }],
            ['s', 'service', { instances: 4, concurrency: 1, serviceMs: { mean: 10, cv: 1 }, queueLimit: 100000 }],
          ],
          [['u', 'lb'], ['lb', 's']],
        );
        return simulate(d, scenario({ seed: 7, durationS: 1000, warmupS: 50, traffic: { rps: 200, clientTimeoutMs: 600000 } }));
      });
      return { expected: r.nodes.s.theory!.waitMs!, actual: r.nodes.s.waitMs! };
    },
    knownDeviation: {
      expectedActual: 4.283,
      actualTolerance: 0.05,
      reason: 'Station theory() assumes Poisson arrivals (ca2 = 1), whereas round-robin feeds each of the 4 instances an Erlang-4 stream (ca2 = 0.25) with far less queueing.',
    },
  },

  // --- Scale factor k > 1 vs k = 1 ---
  {
    id: 'scale-k8-throughput',
    name: 'Scale k = 8 vs k = 1 (rho ~ 0.78)',
    category: 'Scale',
    metric: 'Throughput',
    unit: 'rps',
    tolerance: 0.05,
    measure: () => {
      const full = cachedSim('scale-2000-1', () =>
        simulate(bigDesign(), scenario({ seed: 1, durationS: 120, warmupS: 10, traffic: { rps: 2000, clientTimeoutMs: 600000 }, scale: 1 })),
      );
      const cut = cachedSim('scale-2000-8', () =>
        simulate(bigDesign(), scenario({ seed: 1, durationS: 120, warmupS: 10, traffic: { rps: 2000, clientTimeoutMs: 600000 }, scale: 8 })),
      );
      return { expected: full.summary.throughputRps, actual: cut.summary.throughputRps };
    },
  },
  {
    id: 'scale-k8-latency',
    name: 'Scale k = 8 vs k = 1 (rho ~ 0.78)',
    category: 'Scale',
    metric: 'Mean latency',
    unit: 'ms',
    tolerance: 0.05,
    measure: () => {
      const full = cachedSim('scale-2000-1', () =>
        simulate(bigDesign(), scenario({ seed: 1, durationS: 120, warmupS: 10, traffic: { rps: 2000, clientTimeoutMs: 600000 }, scale: 1 })),
      );
      const cut = cachedSim('scale-2000-8', () =>
        simulate(bigDesign(), scenario({ seed: 1, durationS: 120, warmupS: 10, traffic: { rps: 2000, clientTimeoutMs: 600000 }, scale: 8 })),
      );
      return { expected: full.summary.latencyMs.mean, actual: cut.summary.latencyMs.mean };
    },
  },
  {
    id: 'scale-k8-high-load-wait',
    name: 'Scale k = 8 vs k = 1 near saturation (rho ~ 0.93)',
    category: 'Scale',
    metric: 'API mean wait',
    unit: 'ms',
    tolerance: 0.25,
    measure: () => {
      const full = cachedSim('scale-2375-1', () =>
        simulate(bigDesign(), scenario({ seed: 1, durationS: 120, warmupS: 10, traffic: { rps: 2375, clientTimeoutMs: 600000 }, scale: 1 })),
      );
      const cut = cachedSim('scale-2375-8', () =>
        simulate(bigDesign(), scenario({ seed: 1, durationS: 120, warmupS: 10, traffic: { rps: 2375, clientTimeoutMs: 600000 }, scale: 8 })),
      );
      return { expected: full.nodes.api.waitMs!, actual: cut.nodes.api.waitMs! };
    },
    knownDeviation: {
      expectedActual: 83.446,
      actualTolerance: 0.1,
      reason: 'scale.ts cuts slots per instance (256 -> 32) at constant utilization rho; near saturation, Erlang C wait grows steeply as server count c shrinks.',
    },
  },

  // --- Timeouts ---
  {
    id: 'timeout-mm1-edge',
    name: 'M/M/1 edge timeout (20 ms, rho = 0.5)',
    category: 'Timeouts',
    metric: 'Edge timeout ratio',
    unit: 'ratio',
    tolerance: 0.05,
    measure: () => {
      const d = design(
        [
          ['u', 'client'],
          ['s', 'service', { instances: 1, concurrency: 1, serviceMs: { mean: 10, cv: 1 }, queueLimit: 100000 }],
        ],
        [['u', 's', { timeoutMs: 20 }]],
      );
      const r = simulate(d, scenario({ seed: 7, durationS: 1000, warmupS: 50, traffic: { rps: 50, clientTimeoutMs: 600000 } }));
      return { expected: mm1TimeoutProb(0.05, 0.1, 20), actual: r.edges['u->s'].fail / r.edges['u->s'].calls };
    },
  },
  {
    id: 'timeout-mm1-client',
    name: 'M/M/1 client timeout (40 ms, rho = 0.5)',
    category: 'Timeouts',
    metric: 'Client timeout ratio',
    unit: 'ratio',
    tolerance: 0.08,
    measure: () => {
      const r = simulate(single(1, 10, 1), scenario({ seed: 7, durationS: 1000, warmupS: 50, traffic: { rps: 50, clientTimeoutMs: 40 } }));
      return { expected: mm1TimeoutProb(0.05, 0.1, 40), actual: r.summary.fail.timeout / r.summary.offered };
    },
  },
];

export function measureAccuracyCase(c: AccuracyCase): AccuracyMeasurement {
  const { expected, actual } = c.measure();
  const relError = expected !== 0 ? (actual - expected) / expected : actual === 0 ? 0 : Infinity;
  const inTol = within(actual, expected, c.tolerance);
  const status: AccuracyMeasurement['status'] = inTol ? 'pass' : c.knownDeviation ? 'known-deviation' : 'fail';
  return {
    id: c.id,
    name: c.name,
    category: c.category,
    metric: c.metric,
    unit: c.unit,
    expected,
    actual,
    relError,
    tolerance: c.tolerance,
    status,
    ...(c.knownDeviation ? { knownDeviation: c.knownDeviation } : {}),
  };
}

export function measureAllAccuracyCases(): AccuracyMeasurement[] {
  return ACCURACY_CASES.map(measureAccuracyCase);
}
