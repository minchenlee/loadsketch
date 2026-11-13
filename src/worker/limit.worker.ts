// Finds the limit of the canvas design off the main thread (roadmap-next M18): searchCanvas()
// (src/app/findLimit.ts: the checks, then src/engine/limit.ts) with the canvas scenario's settings and
// none of its events. Each step is posted as it ends (the dialog shows the progress); to cancel, the
// app ends the worker.
import { searchCanvas, type LimitReply } from '../app/findLimit.ts';
import { setLang, type Lang } from '../i18n/index.ts';
import type { Design, Scenario } from '../schema/design.ts';

export type { LimitReply } from '../app/findLimit.ts';
export interface LimitRequest { lang: Lang; design: Design; scenario: Scenario }

const post = (r: LimitReply) => (self as unknown as Worker).postMessage(r);

self.onmessage = (ev: MessageEvent<LimitRequest>) => {
  const { lang, design, scenario } = ev.data;
  setLang(lang);
  try {
    const r = searchCanvas(design, scenario, (step, k, util) => post({ type: 'step', step, k, util }));
    post('problems' in r ? { type: 'invalid', problems: r.problems } : { type: 'done', result: r.result, noWork: r.noWork });
  } catch (e) {
    post({ type: 'error', error: (e as Error).message });
  }
};
