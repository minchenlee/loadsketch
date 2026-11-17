// The limit search on the canvas (roadmap-next M18): the checks around findLimitOf() and the dialog's
// state. A design that does not run gets the problems and no number. A search where nothing ever failed
// because no request reached a component that does work says so instead of a number (Codex and agy
// review of M18: a client with no edge, a weight-0 edge, a write-only edge with reads only, a CDN with
// no origin all "held up to 524288 rps"). No sample is a reason to turn a design away: only the end of
// the whole search is.
import { findLimitOf, type LimitOptions, type LimitResult, type LimitStep, type SimulateResult } from '../engine/limit.ts';
import { KINDS } from '../schema/kinds.ts';
import { parseDesign, parseScenario, sideEdge, type Design, type Scenario } from '../schema/design.ts';
import { t } from '../i18n/index.ts';
import { importMessage } from '../i18n/importMessages.ts';

/** Before a worker starts: the same check as a run (store.ts run()), and the scenario's settings
 *  without its events (the search leaves them out). Messages; empty: the search can start. */
export function limitProblems(d: Design, s: Scenario): string[] {
  const r = parseDesign(d);
  if (!r.ok) return r.issues.filter((i) => i.level === 'error').map((i) => i.message);
  const sc = parseScenario({ ...s, events: [] }, d);
  if (!sc.ok) return sc.issues.filter((i) => i.level === 'error').map((i) => i.message);
  return [];
}

/** The components that do work (KINDS `station`: instances, slots or a queue) that a client reaches
 *  along request lines. Boot and control lines (sideEdge()) carry no client request. */
export function workNodes(d: Design): Set<string> {
  const kind = new Map(d.nodes.map((n) => [n.id, n.kind]));
  const seen = new Set(d.nodes.filter((n) => n.kind === 'client').map((n) => n.id));
  const todo = [...seen];
  while (todo.length) {
    const id = todo.pop()!;
    for (const e of d.edges) {
      if (e.from !== id || sideEdge(e) || seen.has(e.to)) continue;
      seen.add(e.to);
      todo.push(e.to);
    }
  }
  return new Set([...seen].filter((id) => KINDS[kind.get(id) ?? '']?.station));
}

/** One of `work` got requests in this run. Whether traffic gets there is known only by running:
 *  weights, read/write and API filters, a CDN's hits. */
export function reachesWork(run: SimulateResult, work: Set<string>): boolean {
  return [...work].some((id) => (run.sim.nodes[id]?.arrivals ?? 0) > 0);
}

export const NO_WORK = () => t('The traffic reaches no component that handles requests (a server, a database, a worker and so on). No component does any work, so there is no limit to find.');

/** No step failed or stopped the search, and in no step did a component that does work get a request:
 *  every step up to the highest held only because nothing did any work. Said instead of a number. A
 *  search with a failing step is a result as it is (nothing behind a load balancer: it fails at once). */
export const noWork = (r: LimitResult, worked: boolean): boolean => !worked && r.firstFailRps === undefined && !r.stopped;

/** The search the worker runs: the checks of a run (the only thing that turns a design away before it
 *  runs), then the whole search, noting whether any step reached a component that does work. A sample
 *  that saw no work is not a reason to stop: a rare path (a CDN miss) can show up at higher traffic. */
export function searchCanvas(d: Design, s: Scenario, onStep?: (step: LimitStep, k: number, util: Record<string, number>) => void, o: LimitOptions = {}): { result: LimitResult; noWork: boolean } | { problems: string[] } {
  const problems = limitProblems(d, s);
  if (problems.length) return { problems };
  const work = workNodes(d);
  let worked = false;
  const result = findLimitOf(d, s, o, (step, run) => {
    worked ||= reachesWork(run, work);
    onStep?.(step, run.sim.scale ?? 1, run.loadUtil);
  });
  return { result, noWork: noWork(result, worked) };
}

/** The dialog's state; `k` of a step: it ran at 1/k of the traffic and capacity; `util`: each
 *  component's busy share while the step's traffic ran (loadUtilization()). */
export type LimitState = { phase: 'running' | 'done' | 'cancelled' | 'error' | 'invalid'; steps: (LimitStep & { k: number; util: Record<string, number> })[]; result?: LimitResult; noWork?: boolean; error?: string; problems?: string[] };
/** What the worker sends (src/worker/limit.worker.ts). */
export type LimitReply = { type: 'step'; step: LimitStep; k: number; util: Record<string, number> } | { type: 'done'; result: LimitResult; noWork: boolean } | { type: 'invalid'; problems: string[] } | { type: 'error'; error: string };

/** The state after a reply: only a running search changes (a reply already queued when it was
 *  cancelled or closed changes nothing). */
export function limitReply(x: LimitState, r: LimitReply): LimitState {
  if (x.phase !== 'running') return x;
  switch (r.type) {
    case 'step':
      return { ...x, steps: [...x.steps, { ...r.step, k: r.k, util: r.util }] };
    case 'done':
      return { ...x, phase: 'done', result: r.result, noWork: r.noWork };
    case 'invalid':
      return { ...x, phase: 'invalid', problems: r.problems };
    case 'error':
      return { ...x, phase: 'error', error: r.error };
  }
}

/** What the canvas shows of a limit search (roadmap-next M24): the step on screen, each component's
 *  busy share in it, and, once the search is over, where it ended. */
export interface LimitMark {
  rps: number;
  util: Record<string, number>;
  done?: { holdsRps?: number; firstFailRps?: number; node?: string; stopped?: LimitResult['stopped'] };
}

/** Each step stays on the canvas at least this long: a step usually takes 0.3–0.5 s, too fast to see. */
export const STEP_SHOW_MS = 400;

/** The canvas after a search: the colours of the step it holds up to (or the first that failed, or the
 *  highest), and the component that went first. Nothing when no component did any work. */
export function finalMark(r: LimitResult, steps: LimitState['steps'], noWork: boolean): LimitMark | null {
  if (noWork || !steps.length) return null;
  const at = (rps?: number) => (rps === undefined ? undefined : steps.find((x) => x.rps === rps));
  const shown = at(r.holdsRps) ?? at(r.firstFailRps) ?? [...steps].sort((a, b) => b.rps - a.rps)[0];
  const done: NonNullable<LimitMark['done']> = {};
  if (r.holdsRps !== undefined) done.holdsRps = r.holdsRps;
  if (r.firstFailRps !== undefined) done.firstFailRps = r.firstFailRps;
  if (r.bottleneck) done.node = r.bottleneck;
  if (r.stopped) done.stopped = r.stopped;
  return { rps: shown.rps, util: shown.util, done };
}

/** The banner text on the canvas for a limit step or its final mark (roadmap-next M24). */
export function limitBanner(mark: LimitMark, name: (id: string) => string): string {
  const d = mark.done;
  if (!d) return t('This step: {rps}/s', { rps: mark.rps });
  if (d.firstFailRps !== undefined) {
    const who = d.node ? name(d.node) : '';
    return d.holdsRps !== undefined
      ? t('Holds up to about {rps}/s; {name} goes first', { rps: d.holdsRps, name: who })
      : t('Fails at {rps}/s; {name} goes first', { rps: d.firstFailRps, name: who });
  }
  if (d.stopped) {
    return d.holdsRps !== undefined
      ? t('Holds up to {holds}/s; stopped at {stop}/s', { holds: d.holdsRps, stop: d.stopped.rps })
      : t('Stopped at {rps}/s (no conclusion)', { rps: d.stopped.rps });
  }
  return t('Holds up to {rps}/s (this is not the limit)', { rps: d.holdsRps ?? mark.rps });
}

/** The search's conclusion on the canvas page (roadmap-next M24): what limitConclusion() says for the
 *  CLI, with rates written as the steps write them ("/s", 「/秒」) and lists joined in the page's
 *  language. The CLI's report does not change. */
export function limitLines(l: LimitResult, name: (id: string) => string): string[] {
  const L: string[] = [];
  const node = l.bottleneck ? name(l.bottleneck) : '?';
  if (l.firstFailRps !== undefined && l.holdsRps !== undefined) L.push(t('Under these assumptions it holds up to about {holds}/s; at {fail}/s it does not, and {node} goes first.', { holds: l.holdsRps, fail: l.firstFailRps, node }));
  else if (l.firstFailRps !== undefined) L.push(t('Under these assumptions it does not hold even at {fail}/s ({node} goes first).', { fail: l.firstFailRps, node }));
  else if (!l.stopped) L.push(t('Under these assumptions it holds up to {rps}/s; no point where it does not hold was found.', { rps: Math.max(...l.steps.map((s) => s.rps)) }));
  if (l.nonMonotonic) {
    const passes = l.steps.filter((s) => s.verdict === 'pass' && s.rps > l.firstFailRps!).map((s) => t('{rps}/s', { rps: s.rps }));
    L.push(t('The results are not monotonic: at {passes}, above {fail}/s, it holds again; the first point where it does not hold is reported.', { fail: l.firstFailRps!, passes: passes.join(t(', @@list')) }));
  }
  if (l.stopped) L.push(t('Stopped at {rps}/s: {why}', { rps: l.stopped.rps, why: importMessage(l.stopped.id, {}) }));
  return L;
}
