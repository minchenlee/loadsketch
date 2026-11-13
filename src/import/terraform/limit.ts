// --find-limit: with no peak in the answer file, raise the traffic until the design
// stops holding and say where, and which component goes first. Every step is one full --simulate run
// (simulate.ts: warm-up of the autoscaled nodes, measured load, drain, the same SLO), with a fixed seed.
// The search is general (any design, scenario and limits): findLimitOf() in src/engine/limit.ts.
import { assumptionsOf as designAssumptions, findLimitOf, type Assumption, type Design, type LimitResult, type LimitStep } from '../../core/index.ts';
import type { Answers } from './answers.ts';
import type { ImportResult } from './result.ts';
import { answerPeak } from './simulate.ts';

export { BISECT, MAX_RPS, START_RPS, searchLimit, stepOf, type LimitResult, type LimitStep } from '../../core/index.ts';

/** The step for one rps: the answer file with that peak (and its SLO, readRatio, measureS). */
export function limitAnswers(a: Answers, rps: number): Answers {
  return { ...a, traffic: { ...a.traffic, peakRps: rps } };
}

/** Find the limit of a design; `onStep` sees each step as it ends (the CLI prints progress). */
export function findLimit(d: Design, a: Answers, onStep?: (s: LimitStep) => void): LimitResult {
  const { base, o } = answerPeak(a);
  return findLimitOf(d, base, o, onStep);
}

/** The guessed values the simulation used: params whose origin is an estimate (the result depends on them). */
export const assumptionsOf = (res: Pick<ImportResult, 'design'>): Assumption[] => designAssumptions(res.design);
