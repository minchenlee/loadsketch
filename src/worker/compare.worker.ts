// Runs the versions of a comparison again, one after another, off the main thread (roadmap-next M2).
// The same design, scenario and seed give the same result, so a version keeps only its summary and
// its charts come from this run.
import { Simulation } from '../engine/index.ts';
import { setLang, type Lang } from '../i18n/index.ts';
import type { Design, Scenario } from '../schema/design.ts';
import { summarize, type VersionSummary } from '../app/versions.ts';
import { seriesOf, type RunSeries } from '../app/compare.ts';

export interface CompareRequest {
  lang: Lang;
  runs: { design: Design; scenario: Scenario }[];
}
export type CompareReply = { i: number; summary: VersionSummary; series: RunSeries } | { i: number; error: string };

self.onmessage = (ev: MessageEvent<CompareRequest>) => {
  setLang(ev.data.lang);
  ev.data.runs.forEach((r, i) => {
    let reply: CompareReply;
    try {
      const sim = new Simulation(r.design, r.scenario);
      const result = sim.runToEnd();
      const windows = sim.drainWindows();
      reply = { i, summary: summarize(r.design, result, windows), series: seriesOf(windows) };
    } catch (e) {
      reply = { i, error: (e as Error).message };
    }
    (self as unknown as Worker).postMessage(reply);
  });
};
