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
// status running            | loading/idle/done   | running     | a new run: it started on this page; lock
//                           |                     |             | the guesses it answers
// status paused             | any                 | paused      |
// status idle / done        | any                 | idle / done | send the guesses (those sent while it ran
//                           |                     |             | were not taken: the frame keeps the guesses
//                           |                     |             | a run started with)
// finished (a run's result) | any                 | unchanged   | answer the questions of the run's page (or
//                           |                     |             | this page, if its start was not seen)
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

export const INITIAL: RunState = { frame: 'loading', runPage: null, locked: [] };

/** The frame takes guesses now (not while it loads or runs). */
export const takesGuesses = (s: RunState): boolean => s.frame === 'idle' || s.frame === 'done';

/** `answerable(page)`: the questions a run started on that page answers (answerable() in steps.ts). */
export function runStep(s: RunState, e: RunEvent, answerable: (page: number) => string[]): RunStep {
  const out = (state: RunState, send = false, answer: string[] | null = null): RunStep => ({ state, send, answer });
  switch (e.kind) {
    case 'gone':
      return out({ ...s, frame: 'loading', runPage: null });
    case 'ready':
      return out({ ...s, frame: 'idle', runPage: null }, true);
    case 'status':
      if (e.status === 'running') {
        if (s.frame === 'paused' || s.frame === 'running') return out({ ...s, frame: 'running' });
        return out({ frame: 'running', runPage: e.page, locked: [...new Set([...s.locked, ...answerable(e.page)])] });
      }
      if (e.status === 'paused') return out({ ...s, frame: 'paused' });
      return out({ ...s, frame: e.status }, true);
    case 'finished':
      return out(s, false, answerable(s.runPage ?? e.page));
    case 'loaded':
    case 'page':
    case 'guess':
      return out(s, takesGuesses(s));
    case 'restart':
      return out(INITIAL);
  }
}
