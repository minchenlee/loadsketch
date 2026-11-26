// The page drops worker messages from a run that was stopped or replaced.
import { describe, expect, it, vi } from 'vitest';
import type { FromWorker } from '../src/worker/protocol.ts';

class FakeWorker {
  static last: FakeWorker;
  onmessage: ((ev: { data: FromWorker }) => void) | null = null;
  sent: { type: string; run?: number }[] = [];
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(m: { type: string; run?: number }) {
    this.sent.push(m);
  }
}
vi.stubGlobal('Worker', FakeWorker);

const { connect, live, send } = await import('../src/app/runtime.ts');

const error = (run: number, message: string) => ({ type: 'error', message, run }) as FromWorker;
const normalFrame = (run: number, tView: number) =>
  ({ type: 'frame', tView, endMs: 60000, durationMs: 60000, speed: 1, paused: false, lagging: false, scale: 1, snaps: [], windows: [], traces: [], timeline: [], run }) as FromWorker;
const finishingFrame = (run: number, tView: number) =>
  ({ type: 'frame', tView, endMs: 60000, durationMs: 60000, speed: 1, paused: false, lagging: false, finishing: true, scale: 1, snaps: [], windows: [], traces: [], timeline: [], run }) as FromWorker;

describe('run numbers', () => {
  it('messages from a stopped or older run are dropped', () => {
    const got: string[] = [];
    connect((m) => m.type === 'error' && got.push(m.message));
    const start = { type: 'start', design: {}, scenario: {}, speed: 1, lang: 'en' } as never;
    send(start);
    const w = FakeWorker.last;
    const first = w.sent[0].run!;
    w.onmessage!({ data: error(first, 'current') });
    send({ type: 'stop' });
    w.onmessage!({ data: error(first, 'late after stop') });
    send(start);
    const second = w.sent[2].run!;
    expect(second).toBeGreaterThan(first);
    w.onmessage!({ data: error(first, 'late from the first run') });
    w.onmessage!({ data: error(second, 'new run') });
    expect(got).toEqual(['current', 'new run']);
  });

  it('stop and restart clear live.finishing and drop late finishing frames from the stopped run', () => {
    const start = { type: 'start', design: {}, scenario: {}, speed: 1, lang: 'en' } as never;
    send(start);
    const w = FakeWorker.last;
    const first = w.sent.at(-1)!.run!;
    send({ type: 'finish' });
    expect(live.finishing).toBe(true);
    w.onmessage!({ data: finishingFrame(first, 15000) });
    expect(live.clock.tView).toBe(15000);
    send({ type: 'stop' });
    expect(live.finishing).toBe(false);
    // Late finishing frame from the stopped run must be ignored
    w.onmessage!({ data: finishingFrame(first, 30000) });
    expect(live.finishing).toBe(false);
    expect(live.clock.tView).toBe(15000);
  });

  it('in-flight normal playback frame after finish does not clear live.finishing, and worker error clears finishing + running', () => {
    const start = { type: 'start', design: {}, scenario: {}, speed: 1, lang: 'en' } as never;
    send(start);
    const w = FakeWorker.last;
    const id = w.sent.at(-1)!.run!;

    // Normal playback starts, then user clicks Skip to end
    w.onmessage!({ data: normalFrame(id, 1000) });
    expect(live.clock.running).toBe(true);
    expect(live.finishing).toBe(false);

    send({ type: 'finish' });
    expect(live.finishing).toBe(true);

    // An earlier normal playback frame still in flight (finishing: undefined) must NOT clear live.finishing
    w.onmessage!({ data: normalFrame(id, 1033) });
    expect(live.finishing).toBe(true);

    // A worker error during chunked finish must clean up both live.finishing and live.clock.running
    w.onmessage!({ data: error(id, 'boom') });
    expect(live.finishing).toBe(false);
    expect(live.clock.running).toBe(false);
  });
});
