// --find-limit: with no peak in the answer file, raise the traffic until the design
// stops holding and say where, and which component goes first. Every step is one full --simulate run
// (simulate.ts: warm-up of the autoscaled nodes, measured load, drain, the same SLO), with a fixed seed.
//
// Search: double from START_RPS until the first fail, one more step past it (a pass there means the
// results are not monotonic), then bisect between the last pass and the first fail BISECT times.
// The answer is "under these assumptions it holds up to about X rps", never "the limit is X".
import type { Design } from '../../core/index.ts';
import type { Answers } from './answers.ts';
import type { ImportResult } from './result.ts';
import { simulateImport, type SimulateResult, type Verdict } from './simulate.ts';

export const START_RPS = 1;
export const MAX_RPS = 1_000_000;
export const BISECT = 4;

export interface LimitStep { rps: number; verdict: Verdict; bottleneck?: string; failed: string[]; insufficient?: string }
export interface LimitResult {
  /** The most traffic that held, below the first fail (undefined: not even START_RPS held). */
  holdsRps?: number;
  /** The lowest traffic that failed (undefined: nothing failed up to MAX_RPS). */
  firstFailRps?: number;
  /** The busiest component at the first fail. */
  bottleneck?: string;
  /** A step passed above a step that failed. */
  nonMonotonic: boolean;
  /** The search stopped: a step could not give a result (too long, truncated). */
  stopped?: { rps: number; id: string };
  steps: LimitStep[];
}

/** rps for a step: whole numbers from 10 up, two decimals below. */
const tidy = (x: number) => (x >= 10 ? Math.round(x) : Math.round(x * 100) / 100);

/** The search, with the step run given (tests pass a fake one). */
export function searchLimit(evaluate: (rps: number) => LimitStep): LimitResult {
  const steps: LimitStep[] = [];
  const run = (rps: number) => {
    const s = evaluate(rps);
    steps.push(s);
    return s;
  };
  const result = (stopped?: LimitResult['stopped']): LimitResult => {
    const fails = steps.filter((s) => s.verdict === 'fail').sort((a, b) => a.rps - b.rps);
    const first = fails[0];
    const passes = steps.filter((s) => s.verdict === 'pass' && (!first || s.rps < first.rps));
    const holds = passes.length ? Math.max(...passes.map((s) => s.rps)) : undefined;
    const nonMonotonic = !!first && steps.some((s) => s.verdict === 'pass' && s.rps > first.rps);
    return { ...(holds !== undefined ? { holdsRps: holds } : {}), ...(first ? { firstFailRps: first.rps, ...(first.bottleneck ? { bottleneck: first.bottleneck } : {}) } : {}), nonMonotonic, ...(stopped ? { stopped } : {}), steps: [...steps].sort((a, b) => a.rps - b.rps) };
  };
  // An `insufficient` step from too few samples is neither pass nor fail: keep raising. One that
  // could not run (too long, truncated) stops the search.
  const stop = (s: LimitStep) => s.verdict === 'insufficient' && s.insufficient !== 'simulate.short.samples';

  let lo: number | undefined;
  let hi: number | undefined;
  for (let rps = START_RPS; rps <= MAX_RPS; rps *= 2) {
    const s = run(rps);
    if (stop(s)) return result({ rps, id: s.insufficient! });
    if (s.verdict === 'pass') lo = rps;
    if (s.verdict === 'fail') {
      hi = rps;
      // One step past the first fail: a pass there shows the results are not monotonic.
      if (rps * 2 <= MAX_RPS) {
        const after = run(rps * 2);
        if (stop(after)) return result({ rps: rps * 2, id: after.insufficient! });
      }
      break;
    }
  }
  if (hi === undefined || lo === undefined) return result();
  for (let i = 0; i < BISECT; i++) {
    const mid = tidy((lo + hi) / 2);
    if (mid <= lo || mid >= hi) break;
    const s = run(mid);
    if (stop(s)) return result({ rps: mid, id: s.insufficient! });
    if (s.verdict === 'pass') lo = mid;
    else if (s.verdict === 'fail') hi = mid;
    else break; // too few samples inside the bracket: no finer answer
  }
  return result();
}

export const stepOf = (rps: number, s: SimulateResult): LimitStep => ({
  rps,
  verdict: s.verdict,
  ...(s.bottleneck ? { bottleneck: s.bottleneck.node } : {}),
  failed: s.criteria.filter((c) => !c.ok).map((c) => c.id),
  ...(s.insufficient ? { insufficient: s.insufficient.id } : {}),
});

/** The step for one rps: the answer file with that peak (and its SLO, readRatio, measureS). */
export function limitAnswers(a: Answers, rps: number): Answers {
  return { ...a, traffic: { ...a.traffic, peakRps: rps } };
}

/** Find the limit of a design; `onStep` sees each step as it ends (the CLI prints progress). */
export function findLimit(d: Design, a: Answers, onStep?: (s: LimitStep) => void): LimitResult {
  return searchLimit((rps) => {
    const s = stepOf(rps, simulateImport(d, limitAnswers(a, rps))!);
    onStep?.(s);
    return s;
  });
}

/** The guessed values the simulation used: params whose origin is an estimate (the result depends on them). */
export function assumptionsOf(res: ImportResult): { node: string; param: string; value: string; from?: string }[] {
  const out: { node: string; param: string; value: string; from?: string }[] = [];
  for (const n of res.design.nodes) {
    for (const [param, o] of Object.entries(res.origins[n.id] ?? {})) {
      if (o.evidence !== 'estimate') continue;
      const v = n.params?.[param];
      out.push({ node: n.id, param, value: typeof v === 'object' ? JSON.stringify(v) : String(v), ...(o.from ? { from: o.from } : {}) });
    }
  }
  for (const [edge, ps] of Object.entries(res.edgeOrigins)) {
    for (const [param, o] of Object.entries(ps)) if (o.evidence === 'estimate') out.push({ node: edge, param, value: String((res.design.edges.find((e) => e.id === edge) as Record<string, unknown> | undefined)?.[param]), ...(o.from ? { from: o.from } : {}) });
  }
  return out;
}
