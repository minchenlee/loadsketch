// --simulate: with the peak traffic from the answer file, run the existing
// engine on the imported design and say pass, fail or "not enough result". No traffic: no simulation
// (static checks only; M28 finds the limit instead).
//
// The peak run itself is general (any design, scenario and limits): simulatePeak() in
// src/engine/limit.ts. Here the answer file gives the peak, the read share, measureS and the SLO.
import { peakScenario, simulatePeak, steadyScenario, type PeakOptions, type SimulateResult } from '../../core/index.ts';
import type { Answers } from './answers.ts';

export { DEFAULT_SLO, warmUpS, type Criterion, type SimulateResult, type Verdict } from '../../core/index.ts';

/** The peak run's base scenario and options from an answer file. */
export function answerPeak(a: Answers): { base: ReturnType<typeof steadyScenario>; o: PeakOptions } {
  return { base: steadyScenario(a.traffic?.readRatio), o: { ...(a.slo ? { slo: a.slo } : {}), ...(a.traffic?.measureS !== undefined ? { measureS: a.traffic.measureS } : {}) } };
}

/** The scenario for the answer file's peak: warm-up and measured load at the peak, then a drain with no new traffic. */
export function importScenario(d: import('../../core/index.ts').Design, a: Answers) {
  if (!a.traffic) return undefined;
  const { base, o } = answerPeak(a);
  return peakScenario(d, base, a.traffic.peakRps, o);
}

export function simulateImport(d: import('../../core/index.ts').Design, a: Answers): SimulateResult | undefined {
  if (!a.traffic) return undefined;
  const { base, o } = answerPeak(a);
  return simulatePeak(d, base, a.traffic.peakRps, o);
}
