// The course page's view of the simulator frame and its runs (src/course/main.tsx). One reducer,
// so every message, page change and guess goes through the same table. Pure: no React, no DOM.
//
// frame: what the page knows about the frame.
//   loading  the frame is (re)loading: a new example or scenario, or the lesson started again
//   idle     ready, nothing run yet in this frame
//   running  a run is going
//   paused   a run is paused
//   done     the last run ended
//
// Event                     | frame before        | frame after | also
// --------------------------|---------------------|-------------|-------------------------------------------
// gone (new frame address)  | any                 | loading     | the run of the old frame is forgotten
// ready                     | any                 | idle        | send the guesses
// status running            | paused              | running     | the same run goes on: its page stays
// status running            | running             | running     | nothing (the same message again)
// status running            | loading/idle/done   | running     | a new run: it started on this page; it
//                           |                     |             | answers the guesses made before this page,
//                           |                     |             | and on it if it is a guess page; lock them
// status paused             | any                 | paused      |
// status idle / done        | any                 | idle / done | send the guesses (those sent while it ran
//                           |                     |             | were not taken: the frame keeps the guesses
//                           |                     |             | a run started with)
// finished (a run's result) | any                 | unchanged   | answer the questions fixed when the run
//                           |                     |             | started (or this page's, if its start was
//                           |                     |             | not seen)
// loaded (another design   | idle / done         | unchanged   | send the guesses (load() in the frame drops
//   in the frame)           |                     |             | them, with no status change)
// loaded                    | loading/running/    | unchanged   | nothing now: the end of the run sends them
//                           | paused              |             |
// page / guess              | idle / done         | unchanged   | send the guesses
// page / guess              | loading/running/    | unchanged   | nothing now: ready or the end of the run
//                           | paused              |             | sends them
// restart                   | any                 | loading     | no run, nothing locked
//
// Locks stay when a run ends without a result (gone, or stopped: idle). The simulator logged the
// guesses when the run started, so the guess log already has them; unlocking would let the page
// show a guess the log does not have.

export type Frame = 'loading' | 'idle' | 'running' | 'paused' | 'done';

export interface RunState {
  frame: Frame;
  /** The page the current or last run of this frame started on. */
  runPage: number | null;
  /** Questions a run started in this visit answers: their guesses are locked. */
  locked: string[];
  /** The questions the current or last run answers, fixed when it starts (a guess made while it
   *  runs was not in the guesses it started with, so it waits for the next run). */
  runAnswers: string[] | null;
}

export type RunEvent =
  | { kind: 'gone' }
  | { kind: 'ready' }
  | { kind: 'status'; status: 'idle' | 'running' | 'paused' | 'done'; page: number }
  | { kind: 'finished'; page: number }
  | { kind: 'loaded' }
  | { kind: 'page' }
  | { kind: 'guess' }
  | { kind: 'restart' };

export interface RunStep {
  state: RunState;
  /** Send the open guesses of the current page to the frame. */
  send: boolean;
  /** For 'finished': the questions the run answers. */
  answer: string[] | null;
}

export const INITIAL: RunState = { frame: 'loading', runPage: null, locked: [], runAnswers: null };

/** The frame takes guesses now (not while it loads or runs). */
export const takesGuesses = (s: RunState): boolean => s.frame === 'idle' || s.frame === 'done';

/** `answerable(page)`: the questions a run started on that page answers (answerable() in steps.ts: the guesses made before it, and on it when it is a guess page). */
export function runStep(s: RunState, e: RunEvent, answerable: (page: number) => string[]): RunStep {
  const out = (state: RunState, send = false, answer: string[] | null = null): RunStep => ({ state, send, answer });
  switch (e.kind) {
    case 'gone':
      return out({ ...s, frame: 'loading', runPage: null, runAnswers: null });
    case 'ready':
      return out({ ...s, frame: 'idle', runPage: null, runAnswers: null }, true);
    case 'status':
      if (e.status === 'running') {
        if (s.frame === 'paused' || s.frame === 'running') return out({ ...s, frame: 'running' });
        const ids = answerable(e.page);
        return out({ frame: 'running', runPage: e.page, locked: [...new Set([...s.locked, ...ids])], runAnswers: ids });
      }
      if (e.status === 'paused') return out({ ...s, frame: 'paused' });
      return out({ ...s, frame: e.status }, true);
    case 'finished':
      return out(s, false, s.runAnswers ?? answerable(e.page));
    case 'loaded':
    case 'page':
    case 'guess':
      return out(s, takesGuesses(s));
    case 'restart':
      return out(INITIAL);
  }
}
