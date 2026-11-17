// ?embed=1&course=1: the simulator inside the course page (/learn/, src/course/main.tsx). The page
// shows the lesson's questions and challenges; this frame is the canvas and the run controls.
// The bridge tells the page about every run (its status, and the finished run as RunData) and
// takes three requests from it: start a run, the learner's guesses (so the guess log records
// them as in the simulator), and a change to the design that a lesson step offers (a patch). Messages go only to and from the parent page of the same origin.
import { useEffect } from 'react';
import { EMBEDDED, useApp } from './store.ts';
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
  | { source: 'loadsketch-app'; kind: 'status'; ctx: CourseCtx; status: string }
  | { source: 'loadsketch-app'; kind: 'run'; ctx: CourseCtx; run: RunData };

/** From the course page to this frame. */
export type FromCourse =
  | { source: 'loadsketch-course'; kind: 'run' }
  | { source: 'loadsketch-course'; kind: 'guesses'; guesses: Record<string, string> }
  | { source: 'loadsketch-course'; kind: 'patch'; patches: Patch[] }
  /** The page's theme and language changed: the simulator follows without reloading (the design stays). */
  | { source: 'loadsketch-course'; kind: 'look'; theme: 'light' | 'dark'; lang: Lang };

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
      } else if (m.kind === 'look') {
        if (m.theme !== st.theme) st.setTheme(m.theme);
        st.setLang(m.lang);
      } else if (m.kind === 'patch' && (st.status === 'idle' || st.status === 'done')) {
        for (const p of m.patches) {
          if ('node' in p) st.updateNode(p.node, { params: p.params as Record<string, ParamValue> });
          else st.updateEdge(p.edge, p.set as Partial<Omit<DesignEdge, 'from' | 'to'>>);
        }
      } else if (m.kind === 'guesses' && st.ran === null) {
        for (const [q, o] of Object.entries(m.guesses)) if (typeof o === 'string') st.setGuess(q, o);
      }
    };
    window.addEventListener('message', onMessage);
    post({ source: 'loadsketch-app', kind: 'ready', ctx: CTX });
    const off = useApp.subscribe((s, prev) => {
      if (s.status === prev.status) return;
      post({ source: 'loadsketch-app', kind: 'status', ctx: CTX, status: s.status });
      if (s.status === 'done' && s.result && s.ran) post({ source: 'loadsketch-app', kind: 'run', ctx: CTX, run: { design: s.ran.design, scenario: s.ran.scenario, result: s.result, windows: s.windows } });
    });
    return () => {
      window.removeEventListener('message', onMessage);
      off();
    };
  }, []);
}
