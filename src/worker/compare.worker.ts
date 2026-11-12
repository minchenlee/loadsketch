// Runs one version of a comparison again, off the main thread (roadmap-next M2; M14: one worker per
// version, so the versions run at the same time). The same design, scenario and seed give the same
// result, so a version keeps only its summary and its charts come from this run (or from the curve
// this tab kept, src/app/curves.ts).
import { Simulation } from '../engine/index.ts';
import { setLang, type Lang } from '../i18n/index.ts';
import type { Design, Scenario } from '../schema/design.ts';
import { summarize, type VersionSummary } from '../app/versions.ts';
import { seriesUpTo, type RunSeries } from '../app/compare.ts';

export interface CompareRequest {
  lang: Lang;
  /** The item's place in the comparison, sent back with the reply. */
  i: number;
  design: Design;
  scenario: Scenario;
}
export type CompareReply = { i: number; summary: VersionSummary; series: RunSeries } | { i: number; error: string };

self.onmessage = (ev: MessageEvent<CompareRequest>) => {
  const { lang, i, design, scenario } = ev.data;
  setLang(lang);
  let reply: CompareReply;
  try {
    const sim = new Simulation(design, scenario);
    const result = sim.runToEnd();
    const windows = sim.drainWindows();
    // the series up to the end of the traffic, like the live run (a kept curve is the same)
    reply = { i, summary: summarize(design, result, windows), series: seriesUpTo(windows, sim.durationMs) };
  } catch (e) {
    reply = { i, error: (e as Error).message };
  }
  (self as unknown as Worker).postMessage(reply);
};
