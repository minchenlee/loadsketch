// ?embed=1&course=1: the simulator inside the course page (/learn/, src/course/main.tsx). The page
// shows the lesson's questions and challenges; this frame is the canvas and the run controls.
// The bridge tells the page about every run (its status, and the finished run as RunData) and
// takes requests from it: start a run or skip to its end, the learner's guesses (so the guess log records
// them as in the simulator), and a change to the design that a lesson step offers (a patch). Messages go only to and from the parent page of the same origin.
import { useEffect } from 'react';
import { EMBEDDED, EXAMPLES, SCENARIOS, useApp } from './store.ts';
import { isPhone } from './phone.ts';
import type { RunData } from '../learn/metrics.ts';
import type { Patch } from '../learn/oncall.ts';
import type { Lang } from '../i18n/index.ts';
import type { DesignEdge, ParamValue } from '../schema/design.ts';

export const COURSE = EMBEDDED && new URLSearchParams(location.search).get('course') === '1';

/**
 * The lesson context this frame was opened with: the example and scenario in its address. It does
 * not change when the learner opens or pastes another design (that drops the store's example), so
 * the page routes every message by it.
 */
export interface CourseCtx {
  example: string;
  scenario: string;
}
const CTX: CourseCtx = (() => {
  const q = new URLSearchParams(location.search);
  return { example: q.get('example') ?? '', scenario: q.get('scenario') ?? '' };
})();

/** From this frame to the course page. */
export type ToCourse =
  | { source: 'loadsketch-app'; kind: 'ready'; ctx: CourseCtx }
  /**
   * The run's status, and while it runs or is paused its simulated time: `atS` of `ofS` seconds of
   * traffic. Sent on every change of status and, while running, about twice a second.
   */
  | { source: 'loadsketch-app'; kind: 'status'; ctx: CourseCtx; status: string; atS?: number; ofS?: number; finishing?: boolean }
  /** Another design loaded (it drops the guesses): the page sends them again. */
  | { source: 'loadsketch-app'; kind: 'loaded'; ctx: CourseCtx }
  | { source: 'loadsketch-app'; kind: 'run'; ctx: CourseCtx; run: RunData };

/** From the course page to this frame. */
export type FromCourse =
  | { source: 'loadsketch-course'; kind: 'run' }
  /** Skip to the end of the run that goes (the run bar's Skip to end). */
  | { source: 'loadsketch-course'; kind: 'skip' }
  /** The guesses a run started now answers, and the course lesson they belong to (the guess log records them under it). */
  | { source: 'loadsketch-course'; kind: 'guesses'; lesson: string; guesses: Record<string, string> }
  | { source: 'loadsketch-course'; kind: 'patch'; patches: Patch[] }
  /** Restore this frame's original example design and scenario in place (keeping logged guesses). */
  | { source: 'loadsketch-course'; kind: 'reset' }
  /** The page's theme and language changed: the simulator follows without reloading (the design stays). */
  | { source: 'loadsketch-course'; kind: 'look'; theme: 'light' | 'dark'; lang: Lang }
  /**
   * The charts under the canvas (the course page's Charts toggle, or a step that opens them). On a
   * phone layout they are the charts drawer: `show` opens or closes it now (a toggle or a step);
   * without it (a new frame) the drawer is left as it is, so a saved choice does not cover the canvas.
   */
  | { source: 'loadsketch-course'; kind: 'panels'; bottom: boolean; show?: boolean }
  /**
   * Look here (a step's or a question's look, or the node a lesson's change touched): select and
   * centre `node`, open `tab` of the settings panel (default with a node: its settings). On a
   * phone the settings drawer opens. An unknown node or tab is ignored.
   */
  | { source: 'loadsketch-course'; kind: 'focus'; node?: string; tab?: 'design' | 'scenario' | 'results' | 'versions' };

const TABS = { design: 'design', scenario: 'scenario', results: 'learn', versions: 'versions' } as const;

function post(m: ToCourse) {
  if (window.parent !== window) window.parent.postMessage(m, location.origin);
}

export function useCourseBridge(): void {
  useEffect(() => {
    if (!COURSE) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== window.parent) return;
      const m = e.data as FromCourse | null;
      if (!m || m.source !== 'loadsketch-course') return;
      const st = useApp.getState();
      if (m.kind === 'run') {
        if (st.status === 'idle' || st.status === 'done') st.run();
      } else if (m.kind === 'skip') {
        st.finish();
      } else if (m.kind === 'focus') {
        const node = typeof m.node === 'string' && st.nodes.some((n) => n.id === m.node) ? m.node : undefined;
        const asked = typeof m.tab === 'string' && Object.hasOwn(TABS, m.tab) ? TABS[m.tab] : undefined;
        const tab = asked ?? (node ? 'design' : undefined);
        if (node) {
          st.focus({ type: 'node', id: node });
          useApp.setState({ centreAsked: { node } });
        }
        if (tab) useApp.setState({ tabAsked: tab });
        if (tab && isPhone() && !useApp.getState().limitOpen) useApp.setState({ drawer: 'inspector' });
      } else if (m.kind === 'panels') {
        useApp.setState({ courseBottom: !!m.bottom });
        if (m.show && isPhone()) {
          const { drawer, limitOpen } = useApp.getState();
          if (m.bottom && !limitOpen) useApp.setState({ drawer: 'metrics' });
          else if (!m.bottom && drawer === 'metrics') useApp.setState({ drawer: null });
        }
      } else if (m.kind === 'look') {
        if (m.theme !== st.theme) st.setTheme(m.theme);
        st.setLang(m.lang);
      } else if (m.kind === 'patch' && (st.status === 'idle' || st.status === 'done')) {
        for (const p of m.patches) {
          if ('node' in p) st.updateNode(p.node, { params: p.params as Record<string, ParamValue> });
          else st.updateEdge(p.edge, p.set as Partial<Omit<DesignEdge, 'from' | 'to'>>);
        }
      } else if (m.kind === 'reset' && (st.status === 'idle' || st.status === 'done')) {
        const { courseLesson, loggedGuesses, guesses, guessesLogged } = st;
        if (CTX.example && EXAMPLES[CTX.example]) st.loadExample(CTX.example);
        const sc = CTX.scenario ? SCENARIOS[CTX.scenario] : undefined;
        useApp.setState({
          ...(sc ? { scenario: structuredClone(sc) } : {}),
          courseLesson,
          loggedGuesses,
          guesses,
          guessesLogged,
        });
      } else if (m.kind === 'guesses' && st.status !== 'running' && st.status !== 'paused' && typeof m.lesson === 'string') {
        // the page's open guesses replace those not logged yet; a later step's guesses come after a run
        const guesses: Record<string, string> = {};
        for (const q of st.loggedGuesses) if (st.guesses[q] !== undefined) guesses[q] = st.guesses[q];
        for (const [q, o] of Object.entries(m.guesses ?? {})) if (typeof o === 'string' && !st.loggedGuesses.includes(q)) guesses[q] = o;
        useApp.setState({ courseLesson: m.lesson, guesses });
      }
    };
    window.addEventListener('message', onMessage);
    post({ source: 'loadsketch-app', kind: 'ready', ctx: CTX });
    // the simulated time of the run that goes: the traffic's length, and the time shown (it runs on
    // past the traffic to drain the last requests: clamped)
    const clock = (s: ReturnType<typeof useApp.getState>) => {
      if (s.status !== 'running' && s.status !== 'paused') return {};
      const ofS = (s.ran ?? s).scenario.durationS ?? 60;
      return { atS: Math.min(ofS, Math.floor(s.tView / 1000)), ofS, finishing: s.finishing };
    };
    let ticked = 0;
    const off = useApp.subscribe((s, prev) => {
      if (s.loads !== prev.loads) post({ source: 'loadsketch-app', kind: 'loaded', ctx: CTX });
      if (s.status === prev.status && s.finishing === prev.finishing) {
        const gap = s.finishing ? 250 : 400;
        if (s.status === 'running' && s.tView !== prev.tView && performance.now() - ticked >= gap) {
          ticked = performance.now();
          post({ source: 'loadsketch-app', kind: 'status', ctx: CTX, status: s.status, ...clock(s) });
        }
        return;
      }
      ticked = performance.now();
      post({ source: 'loadsketch-app', kind: 'status', ctx: CTX, status: s.status, ...clock(s) });
      if (s.status === 'done' && s.result && s.ran) post({ source: 'loadsketch-app', kind: 'run', ctx: CTX, run: { design: s.ran.design, scenario: s.ran.scenario, result: s.result, windows: s.windows } });
    });
    return () => {
      window.removeEventListener('message', onMessage);
      off();
    };
  }, []);
}
