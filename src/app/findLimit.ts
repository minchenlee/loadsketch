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

export const NO_WORK = () => t('流量到不了任何處理請求的元件（伺服器、資料庫、worker 等）：沒有元件在做事，所以找不到上限。');

/** No step failed or stopped the search, and in no step did a component that does work get a request:
 *  every step up to the highest held only because nothing did any work. Said instead of a number. A
 *  search with a failing step is a result as it is (nothing behind a load balancer: it fails at once). */
export const noWork = (r: LimitResult, worked: boolean): boolean => !worked && r.firstFailRps === undefined && !r.stopped;

/** The search the worker runs: the checks of a run (the only thing that turns a design away before it
 *  runs), then the whole search, noting whether any step reached a component that does work. A sample
 *  that saw no work is not a reason to stop: a rare path (a CDN miss) can show up at higher traffic. */
export function searchCanvas(d: Design, s: Scenario, onStep?: (step: LimitStep, k: number) => void, o: LimitOptions = {}): { result: LimitResult; noWork: boolean } | { problems: string[] } {
  const problems = limitProblems(d, s);
  if (problems.length) return { problems };
  const work = workNodes(d);
  let worked = false;
  const result = findLimitOf(d, s, o, (step, run) => {
    worked ||= reachesWork(run, work);
    onStep?.(step, run.sim.scale ?? 1);
  });
  return { result, noWork: noWork(result, worked) };
}

/** The dialog's state; `k` of a step: it ran at 1/k of the traffic and capacity. */
export type LimitState = { phase: 'running' | 'done' | 'cancelled' | 'error' | 'invalid'; steps: (LimitStep & { k: number })[]; result?: LimitResult; noWork?: boolean; error?: string; problems?: string[] };
/** What the worker sends (src/worker/limit.worker.ts). */
export type LimitReply = { type: 'step'; step: LimitStep; k: number } | { type: 'done'; result: LimitResult; noWork: boolean } | { type: 'invalid'; problems: string[] } | { type: 'error'; error: string };

/** The state after a reply: only a running search changes (a reply already queued when it was
 *  cancelled or closed changes nothing). */
export function limitReply(x: LimitState, r: LimitReply): LimitState {
  if (x.phase !== 'running') return x;
  switch (r.type) {
    case 'step':
      return { ...x, steps: [...x.steps, { ...r.step, k: r.k }] };
    case 'done':
      return { ...x, phase: 'done', result: r.result, noWork: r.noWork };
    case 'invalid':
      return { ...x, phase: 'invalid', problems: r.problems };
    case 'error':
      return { ...x, phase: 'error', error: r.error };
  }
}
