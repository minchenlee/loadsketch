// Find the limit of the canvas design (roadmap-next M18, M24): steady traffic, raised step by step until
// the design stops meeting the limits (src/engine/limit.ts, in src/worker/limit.worker.ts). A panel
// beside the canvas, not over it: each step, as it ends, colours the components by how busy they were
// (the store's `limit`, shown on the cards for at least STEP_SHOW_MS), and the search's end marks the
// component that went first. Cancel ends the worker. The answer is "under these assumptions it holds up
// to about X", with the limits and the assumptions it rests on, said as the CLI says it, with
// rates written as the steps write them (limitLines()). An edit of the design or a run while it searches cancels it. The result is not
// kept as a version.
import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleCheck, CircleX, Hourglass, TrendingUp, TriangleAlert, X } from 'lucide-react';
import { useApp } from '../store.ts';
import { assumptionsOf, sloOf, type Design, type Scenario } from '../../core/index.ts';
import { finalMark, limitLines, limitProblems, limitReply, NO_WORK, STEP_SHOW_MS, type LimitState } from '../findLimit.ts';
import { importMessage } from '../../i18n/importMessages.ts';
import { getLang, t, tx } from '../../i18n/index.ts';
import type { LimitReply, LimitRequest } from '../../worker/limit.worker.ts';

const VERDICT = { pass: tx('Holds'), fail: tx('Does not hold'), insufficient: tx('Not enough result') } as const;

type State = LimitState;
/** Why a search was cancelled by something else than its Cancel button. */
type Why = 'edit' | 'run';

/** The panel beside the canvas (desktop; App.tsx, in a Slide that removes it once closed): one search
 *  per `limitKey`. */
export function FindLimitPanel() {
  const key = useApp((st) => st.limitKey);
  return key ? <FindLimit key={key} /> : null;
}

export function FindLimit() {
  const worker = useRef<Worker | null>(null);
  // the canvas as it was when the search started
  const [{ design, scenario }] = useState<{ design: Design; scenario: Scenario }>(() => {
    const st = useApp.getState();
    return { design: st.design(), scenario: structuredClone(st.scenario) };
  });
  // a design that does not run has no limit to find (the only check before a run); a search where no
  // step failed and nothing did work says so at the end (searchCanvas())
  const [problems] = useState(() => limitProblems(design, scenario));
  const [s, setS] = useState<State>(() => (problems.length ? { phase: 'invalid', steps: [], problems } : { phase: 'running', steps: [] }));
  const [why, setWhy] = useState<Why | null>(null);
  const stateRef = useRef<State>(s);
  stateRef.current = s;
  const [stopped, setStopped] = useState(false);
  const stoppedRef = useRef(false);
  const finishedRef = useRef(false);
  const closedRef = useRef(false);

  // closing ends the search at once: a completed search whose playback did not catch up yet puts its
  // final mark on the canvas (with Clear); a search that did not end leaves no marks
  const close = () => {
    if (closedRef.current) return;
    closedRef.current = true;
    const wasStopped = stoppedRef.current;
    stoppedRef.current = true;
    setStopped(true);
    if (worker.current) stop(worker.current);
    const st = useApp.getState();
    const cur = stateRef.current;
    if (cur.phase === 'running') st.setLimit(null);
    else if (cur.phase === 'done' && cur.result && !wasStopped && !finishedRef.current) {
      finishedRef.current = true;
      st.setLimit(finalMark(cur.result, cur.steps, !!cur.noWork));
    }
    st.closeLimit();
    document.querySelector<HTMLElement>('[data-testid="find-limit-open"]')?.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (problems.length) return;
    const w = new Worker(new URL('../../worker/limit.worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    // a reply already queued when the search was cancelled or closed changes nothing
    w.onmessage = (ev: MessageEvent<LimitReply>) => {
      const r = ev.data;
      setS((x) => limitReply(x, r));
      if (r.type !== 'step') stop(w);
    };
    // a worker that cannot start or load: say why (as the compare view does), not an unhandled page error
    w.onerror = (ev) => {
      ev.preventDefault();
      setS((x) => (x.phase === 'running' ? { ...x, phase: 'error', error: ev.message || t('could not start') } : x));
      stop(w);
    };
    const req: LimitRequest = { lang: getLang(), design, scenario };
    w.postMessage(req);
    return () => stop(w);
  }, [design, scenario, problems]);

  const cancel = (reason?: Why) => {
    if (stateRef.current.phase !== 'running') return;
    if (worker.current) stop(worker.current);
    if (reason) setWhy(reason);
    setS((x) => (x.phase === 'running' ? { ...x, phase: 'cancelled' } : x));
  };

  // the canvas can be edited and run while the panel is open: stop any playback (even after the
  // worker finished) and cancel a running search
  useEffect(
    () =>
      useApp.subscribe((st, prev) => {
        if (closedRef.current) return;
        const edit = st.issues !== prev.issues;
        const run = st.status === 'running' && prev.status !== 'running';
        if (!edit && !run) return;
        stoppedRef.current = true;
        setStopped(true);
        cancel(edit ? 'edit' : 'run');
      }),
    [],
  );

  // the canvas follows the steps, each for at least STEP_SHOW_MS, then shows where the search ended
  const [shown, setShown] = useState(0);
  const shownAt = useRef(0);
  useEffect(() => {
    if (stopped) return;
    const st = useApp.getState();
    if (s.phase === 'cancelled' || s.phase === 'error' || s.phase === 'invalid') {
      if (st.limit) st.setLimit(null);
      return;
    }
    if (shown < s.steps.length) {
      const h = setTimeout(() => {
        if (stoppedRef.current) return;
        const x = s.steps[shown];
        shownAt.current = Date.now();
        useApp.getState().setLimit({ rps: x.rps, util: x.util });
        setShown(shown + 1);
      }, Math.max(0, shownAt.current + STEP_SHOW_MS - Date.now()));
      return () => clearTimeout(h);
    }
    if (s.phase === 'done' && s.result && !finishedRef.current) {
      const h = setTimeout(() => {
        if (stoppedRef.current) return;
        finishedRef.current = true;
        useApp.getState().setLimit(finalMark(s.result!, s.steps, !!s.noWork));
      }, Math.max(0, shownAt.current + STEP_SHOW_MS - Date.now()));
      return () => clearTimeout(h);
    }
  }, [s, shown, stopped]);

  // focus the panel without scrolling: autoFocus scrolls every parent that hides overflow to show the
  // button while the panel slides in, which cut off the panel's first line
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus({ preventScroll: true }), []);

  const slo = sloOf();
  const background = design.nodes.some((n) => n.kind === 'queue');
  const events = scenario.events?.length ?? 0;
  const assumptions = useMemo(() => assumptionsOf(design), [design]);
  const name = (id: string) => {
    const n = design.nodes.find((x) => x.id === id);
    return n?.label && n.label !== id ? t('{label} ({id})', { label: n.label, id }) : id;
  };
  const sorted = [...s.steps].sort((a, b) => a.rps - b.rps);
  // the steps that ran scaled down (src/engine/scale.ts): near full load they wait longer than full size
  const ks = s.noWork ? [] : [...new Set(s.steps.map((x) => x.k).filter((k) => k > 1))].sort((a, b) => a - b);

  return (
    // not a dialog: the canvas stays in use; Escape inside the panel closes it, as it closed the dialog
    <aside role="region" aria-label={t('Find limit')} className="flex h-full w-[380px] flex-col border-l border-[var(--line)] bg-[var(--chrome)]" data-testid="find-limit" onKeyDown={(e) => e.key === 'Escape' && close()}>
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--line)] px-4 py-3">
        <TrendingUp size={18} className="muted" />
        <div className="text-[16px] font-semibold">{t('Find limit')}</div>
        <button ref={first} className="btn ml-auto" onClick={close} aria-label={t('Close')}>
          <X size={16} />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 text-[14px] leading-relaxed">
          <p>{t('Steady traffic, doubled from 1 request per second, then narrowed down after the first step that does not hold. Each step warms up, measures for a while, then stops the traffic to see if all the work gets done.')}</p>
          <div data-testid="find-limit-conditions">
            <div className="mb-1 font-medium">{t('Limits:')}</div>
            <ul className="list-disc space-y-0.5 pl-5">
              <li>{t('Front-end p99 ≤ {ms} ms', { ms: slo.p99Ms })}</li>
              <li>{t('Front-end failures ≤ {p}%', { p: slo.errorRate * 100 })}</li>
              {background && <li>{t('Background failures ≤ {p}% (a message moved to the DLQ or expired is a failure)', { p: slo.asyncFailRate * 100 })}</li>}
              <li>{t('All work done within {s} s after the traffic stops', { s: slo.drainS })}</li>
            </ul>
          </div>
          <p className="muted" data-testid="find-limit-traffic">
            {t('Traffic: the settings of the current scenario "{name}" (read share, timeout, seed and so on); the search sets the requests per second. The scenario\'s events (spikes, ramps, failures and so on) are not included.', { name: t(scenario.name || 'Custom') })}
            {events > 0 && ` ${t('This scenario has {n} events; the limit search leaves them all out.', { n: events })}`}
          </p>

          <div className="border-t border-[var(--line)] pt-3" aria-live="polite" data-testid="find-limit-progress">
            {s.phase === 'running' && (
              <div className="flex items-center gap-1.5" data-testid="find-limit-running">
                <Hourglass size={14} className="muted shrink-0" />
                {t('Running step {n}…', { n: s.steps.length + 1 })}
              </div>
            )}
            {s.phase === 'cancelled' && (
              <p data-testid="find-limit-cancelled">
                {why === 'edit' ? t('The design changed, so the search was cancelled.') + ' ' : why === 'run' ? t('A run started, so the search was cancelled.') + ' ' : ''}
                {t('Cancelled after {n} steps: no conclusion.', { n: s.steps.length })}
              </p>
            )}
            {s.phase === 'invalid' && (
              <div data-testid="find-limit-problems">
                <div className="mb-1 font-medium">{t('The limit cannot be searched yet. Fix these first:')}</div>
                <ul className="space-y-1">
                  {s.problems!.map((p, i) => (
                    <li key={i} className="flex gap-1.5">
                      <CircleX size={14} className="mt-[3px] shrink-0" style={{ color: 'var(--bad)' }} />
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {s.phase === 'error' && (
              <p style={{ color: 'var(--bad-ink)' }} data-testid="find-limit-error">
                {t('The limit search failed: {e}', { e: s.error ?? '' })}
              </p>
            )}
            {s.noWork && (
              <p className="font-medium" data-testid="find-limit-no-work">
                {NO_WORK()}
              </p>
            )}
            {s.result && !s.noWork && (
              <div className="space-y-1 font-medium" data-testid="find-limit-result">
                {limitLines(s.result, name).map((x, i) => (
                  <p key={i}>{x}</p>
                ))}
                {s.result.firstFailRps === undefined && !s.result.stopped && (
                  <p className="font-normal" data-testid="find-limit-no-fail">
                    {t('The search stopped at {rps}/s. This is not a limit: the design may hold more, or something that would break is not simulated.', { rps: Math.max(...s.result.steps.map((x) => x.rps)) })}
                  </p>
                )}
              </div>
            )}
            {!!sorted.length && !s.noWork && s.phase !== 'invalid' && (
              <ul className="mt-2 space-y-0.5 text-[13px]" data-testid="find-limit-steps">
                {sorted.map((x) => (
                  <li key={x.rps} data-verdict={x.verdict}>
                    {/* the rate and the verdict never wrap; the reason goes on its own line and wraps */}
                    <div className="flex items-center gap-1.5 whitespace-nowrap" data-testid="find-limit-step-head">
                      {x.verdict === 'pass' ? <CircleCheck size={14} className="shrink-0" style={{ color: 'var(--ok)' }} /> : x.verdict === 'fail' ? <CircleX size={14} className="shrink-0" style={{ color: 'var(--bad)' }} /> : <TriangleAlert size={14} className="shrink-0" style={{ color: 'var(--warn)' }} />}
                      <span className="num" data-testid="find-limit-step-rps">{t('{rps}/s', { rps: x.rps })}</span>
                      <span data-testid="find-limit-step-verdict">{t(VERDICT[x.verdict])}</span>
                      {x.k > 1 && <span className="faint num" title={t('This step ran at 1/{k} of the traffic and capacity, then multiplied the numbers back', { k: x.k })}>1/{x.k}</span>}
                    </div>
                    {x.verdict === 'fail' && (
                      <div className="faint pl-5 [overflow-wrap:anywhere]" data-testid="find-limit-step-why">
                        {x.failed.map(criterionName).join(t(', @@list'))}
                        {x.bottleneck ? ` · ${t('busiest: {node}', { node: name(x.bottleneck) })}` : ''}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-2 border-t border-[var(--line)] pt-3" data-testid="find-limit-assumptions">
            {ks.length > 0 && (
              <p data-testid="find-limit-scale">
                {t('This search ran scaled down ({ks}): traffic and capacity at 1/k, the numbers multiplied back. Near full load a scaled-down run waits longer than full size, so the limit may be on the low side.', { ks: ks.map((k) => `1/${k}`).join(t(', @@list')) })}
              </p>
            )}
            {assumptions.length ? (
              <>
                <p>{importMessage('limit.assumptions', { n: assumptions.length })}</p>
                <ul className="mt-1 max-h-[160px] list-disc space-y-0.5 overflow-y-auto pl-5 text-[13px]">
                  {assumptions.map((a) => (
                    <li key={`${a.node}.${a.param}`}>
                      <code>
                        {a.node}.{a.param}
                      </code>{' '}
                      = {a.value}
                      {a.from ? <span className="faint">（{a.from}）</span> : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="muted">{t('Assumption: each component\'s speed and capacity are the values on the canvas. A real system has other numbers, and another limit.')}</p>
            )}
          </div>
        </div>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--line)] px-4 py-3">
        {s.phase === 'running' ? (
          <button className="btn" onClick={() => cancel()} data-testid="find-limit-cancel">
            {t('Cancel')}
          </button>
        ) : (
          <button className="btn btn-primary" onClick={close} data-testid="find-limit-close">
            {t('Close')}
          </button>
        )}
      </div>
    </aside>
  );
}

const CRITERION: Record<string, string> = {
  'simulate.p99': tx('p99 too slow'),
  'simulate.errorRate': tx('too many failures'),
  'simulate.asyncFail': tx('background failures'),
  'simulate.asyncP99': tx('background too slow'),
  'simulate.asyncNoSample': tx('no successful background message'),
  'simulate.drain': tx('work left after the traffic stopped'),
};
const criterionName = (id: string) => (CRITERION[id] ? t(CRITERION[id]) : id);

/** End a worker and drop its handlers, so nothing it already sent is read. */
function stop(w: Worker) {
  w.onmessage = null;
  w.onerror = null;
  w.terminate();
}
