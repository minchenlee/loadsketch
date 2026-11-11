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

const { connect, send } = await import('../src/app/runtime.ts');

const error = (run: number, message: string) => ({ type: 'error', message, run }) as FromWorker;

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
});
