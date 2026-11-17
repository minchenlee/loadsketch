// The course page's run state (src/course/runState.ts): every row of its table.
import { describe, expect, it } from 'vitest';
import { LESSONS } from '../src/learn/lessons.ts';
import type { Lesson } from '../src/learn/lesson.ts';
import { answerable, ctxOf, pagesOf } from '../src/course/steps.ts';
import { INITIAL, runStep, takesGuesses, type Frame, type RunEvent, type RunState } from '../src/course/runState.ts';

// page 2 answers a; page 4 answers a and b
const at = (p: number) => (p >= 4 ? ['a', 'b'] : p >= 2 ? ['a'] : []);
const st = (frame: Frame, runPage: number | null = null, locked: string[] = [], runAnswers: string[] | null = null): RunState => ({ frame, runPage, locked, runAnswers });
const go = (s: RunState, ...es: RunEvent[]) => es.reduce((x, e) => runStep(x, e, at).state, s);
const FRAMES: Frame[] = ['loading', 'idle', 'running', 'paused', 'done'];

describe('course run state', () => {
  it('starts loading, with nothing locked', () => {
    expect(INITIAL).toEqual(st('loading'));
  });

  it('gone: any frame is loading again, and its run is forgotten', () => {
    for (const f of FRAMES) expect(runStep(st(f, 2, ['a']), { kind: 'gone' }, at)).toEqual({ state: st('loading', null, ['a']), send: false, answer: null });
  });

  it('ready: idle, and the guesses are sent', () => {
    for (const f of FRAMES) expect(runStep(st(f, 2, ['a']), { kind: 'ready' }, at)).toEqual({ state: st('idle', null, ['a']), send: true, answer: null });
  });

  it('a new run starts on this page and locks what it answers', () => {
    for (const f of ['loading', 'idle', 'done'] as Frame[]) {
      const r = runStep(st(f, 1), { kind: 'status', status: 'running', page: 2 }, at);
      expect(r).toEqual({ state: st('running', 2, ['a'], ['a']), send: false, answer: null });
    }
  });

  it('running after paused is the same run: its page stays', () => {
    const r = runStep(st('paused', 2, ['a']), { kind: 'status', status: 'running', page: 1 }, at);
    expect(r).toEqual({ state: st('running', 2, ['a']), send: false, answer: null });
  });

  it('running again while running changes nothing', () => {
    expect(runStep(st('running', 2, ['a']), { kind: 'status', status: 'running', page: 4 }, at).state).toEqual(st('running', 2, ['a']));
  });

  it('paused keeps the run', () => {
    for (const f of FRAMES) expect(runStep(st(f, 2, ['a']), { kind: 'status', status: 'paused', page: 1 }, at)).toEqual({ state: st('paused', 2, ['a']), send: false, answer: null });
  });

  it('idle or done: the guesses are sent again (the frame did not take them while it ran)', () => {
    for (const f of FRAMES)
      for (const status of ['idle', 'done'] as const) expect(runStep(st(f, 2), { kind: 'status', status, page: 4 }, at)).toEqual({ state: st(status, 2), send: true, answer: null });
  });

  it('a finished run answers the questions fixed when it started', () => {
    expect(runStep(st('done', 2, ['a'], ['a']), { kind: 'finished', page: 4 }, at).answer).toEqual(['a']);
    // its start was not seen: this page
    expect(runStep(st('done', null), { kind: 'finished', page: 4 }, at).answer).toEqual(['a', 'b']);
  });

  it('a page or a guess is sent only when the frame takes guesses', () => {
    for (const f of FRAMES)
      for (const kind of ['page', 'guess'] as const) {
        const r = runStep(st(f), { kind }, at);
        expect(r.send, `${f} ${kind}`).toBe(f === 'idle' || f === 'done');
        expect(r.state).toEqual(st(f));
      }
    expect(FRAMES.filter((f) => takesGuesses(st(f)))).toEqual(['idle', 'done']);
  });

  it('loaded (the frame loaded another design and dropped its guesses): sent again when it takes guesses', () => {
    for (const f of FRAMES) {
      const r = runStep(st(f, 2, ['a']), { kind: 'loaded' }, at);
      expect(r.send, f).toBe(f === 'idle' || f === 'done');
      expect(r.state).toEqual(st(f, 2, ['a']));
    }
  });

  it('a run that ends without a result keeps its locks (the guess log has its guesses)', () => {
    const s = go(st('idle'), { kind: 'status', status: 'running', page: 2 }, { kind: 'gone' });
    expect(s.locked).toEqual(['a']);
    expect(go(st('idle'), { kind: 'status', status: 'running', page: 2 }, { kind: 'status', status: 'idle', page: 2 }).locked).toEqual(['a']);
  });

  it('restart: nothing run, nothing locked', () => {
    for (const f of FRAMES) expect(runStep(st(f, 2, ['a', 'b']), { kind: 'restart' }, at).state).toEqual(INITIAL);
  });

  // the three cases Codex found, as sequences
  it('pause, go back, resume: the run still answers its page (round 3)', () => {
    const s = go(st('idle'), { kind: 'status', status: 'running', page: 2 }, { kind: 'status', status: 'paused', page: 2 }, { kind: 'page' }, { kind: 'status', status: 'running', page: 1 });
    expect(runStep(s, { kind: 'finished', page: 1 }, at).answer).toEqual(['a']);
  });

  it('pause, then a new frame: its first run is a new run (round 4)', () => {
    const s = go(st('idle'), { kind: 'status', status: 'running', page: 2 }, { kind: 'status', status: 'paused', page: 2 }, { kind: 'gone' }, { kind: 'ready' }, { kind: 'status', status: 'running', page: 4 });
    expect(s).toEqual(st('running', 4, ['a', 'b'], ['a', 'b']));
  });

  it('guesses made while a run goes are sent when it ends (round 5)', () => {
    let s = go(st('idle'), { kind: 'status', status: 'running', page: 2 });
    expect(runStep(s, { kind: 'page' }, at).send).toBe(false);
    expect(runStep(s, { kind: 'guess' }, at).send).toBe(false);
    s = go(s, { kind: 'page' }, { kind: 'guess' });
    expect(runStep(s, { kind: 'status', status: 'done', page: 4 }, at).send).toBe(true);
  });

  it('a run started on a guess page, before Next, locks and answers the guesses made there (round 6)', () => {
    const base = LESSONS['retry-storm'];
    const l: Lesson = { ...base, steps: [{ kind: 'read', text: 'x' }, { kind: 'guess', questions: ['recover'] }, { kind: 'run' }] };
    const pages = pagesOf(l);
    const ctx = ctxOf(l, pages, 1);
    const real = (guesses: Record<string, string>) => (p: number) => answerable(l, pages, p, ctx, guesses);
    const s = runStep(st('idle'), { kind: 'status', status: 'running', page: 1 }, real({ recover: 'fast' })).state;
    expect(s).toEqual(st('running', 1, ['recover'], ['recover']));
    expect(runStep(s, { kind: 'finished', page: 1 }, real({ recover: 'fast' })).answer).toEqual(['recover']);
    // no guess yet: nothing locked, the question stays open
    expect(runStep(st('idle'), { kind: 'status', status: 'running', page: 1 }, real({})).state.locked).toEqual([]);
  });

  it('a guess made on the guess page while its run goes waits for the next run (round 6)', () => {
    const base = LESSONS['retry-storm'];
    const l: Lesson = { ...base, steps: [{ kind: 'read', text: 'x' }, { kind: 'guess', questions: ['recover', 'amp'] }, { kind: 'run' }] };
    const pages = pagesOf(l);
    const ctx = ctxOf(l, pages, 1);
    const g: Record<string, string> = { recover: 'fast' };
    const at2 = (p: number) => answerable(l, pages, p, ctx, g);
    let s = runStep(st('idle'), { kind: 'status', status: 'running', page: 1 }, at2).state;
    g.amp = 'x';
    s = runStep(s, { kind: 'guess' }, at2).state;
    expect(runStep(s, { kind: 'finished', page: 1 }, at2).answer).toEqual(['recover']);
    // the next run takes it
    s = runStep(s, { kind: 'status', status: 'done', page: 1 }, at2).state;
    s = runStep(s, { kind: 'status', status: 'running', page: 1 }, at2).state;
    expect(runStep(s, { kind: 'finished', page: 1 }, at2).answer).toEqual(['recover', 'amp']);
  });
});
