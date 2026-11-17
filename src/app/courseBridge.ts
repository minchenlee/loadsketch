// ?embed=1&course=1: the simulator inside the course page (/learn/, src/course/main.tsx). The page
// shows the lesson's questions and challenges; this frame is the canvas and the run controls.
// The bridge tells the page about every run (its status, and the finished run as RunData) and
// takes two requests from it: start a run, and the learner's guesses (so the guess log records
// them as in the simulator). Messages go only to and from the parent page of the same origin.
import { useEffect } from 'react';
import { EMBEDDED, useApp } from './store.ts';
import type { RunData } from '../learn/metrics.ts';

export const COURSE = EMBEDDED && new URLSearchParams(location.search).get('course') === '1';

/** From this frame to the course page. `example` is the loaded example (null for another design). */
export type ToCourse =
  | { source: 'loadsketch-app'; kind: 'ready'; example: string | null }
  | { source: 'loadsketch-app'; kind: 'status'; example: string | null; status: string }
  | { source: 'loadsketch-app'; kind: 'run'; example: string | null; run: RunData };

/** From the course page to this frame. */
export type FromCourse = { source: 'loadsketch-course'; kind: 'run' } | { source: 'loadsketch-course'; kind: 'guesses'; guesses: Record<string, string> };

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
      } else if (m.kind === 'guesses' && st.ran === null) {
        for (const [q, o] of Object.entries(m.guesses)) if (typeof o === 'string') st.setGuess(q, o);
      }
    };
    window.addEventListener('message', onMessage);
    post({ source: 'loadsketch-app', kind: 'ready', example: useApp.getState().example });
    const off = useApp.subscribe((s, prev) => {
      if (s.status === prev.status) return;
      post({ source: 'loadsketch-app', kind: 'status', example: s.example, status: s.status });
      if (s.status === 'done' && s.result && s.ran) post({ source: 'loadsketch-app', kind: 'run', example: s.example, run: { design: s.ran.design, scenario: s.ran.scenario, result: s.result, windows: s.windows } });
    });
    return () => {
      window.removeEventListener('message', onMessage);
      off();
    };
  }, []);
}
