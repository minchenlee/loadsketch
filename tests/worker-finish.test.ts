// Verifies that chunked "Skip to end" execution in sim.worker.ts produces the exact same
// SimResult, windows, timeline, and end-of-traffic liveState as one-shot execution, and that
// stopping or restarting mid-finish has no race conditions.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/engine/index.ts';
import type { Design, Scenario } from '../src/schema/design.ts';
import type { FromWorker, ToWorker } from '../src/worker/protocol.ts';

const root = join(import.meta.dirname, '..');
const loadDesign = (name: string): Design => JSON.parse(readFileSync(join(root, 'examples/designs', `${name}.json`), 'utf8'));
const loadScenario = (name: string): Scenario => JSON.parse(readFileSync(join(root, 'examples/scenarios', `${name}.json`), 'utf8'));

describe('chunked Skip to end matches one-shot simulation', () => {
  const cases: { label: string; design: Design; scenario: Scenario }[] = [
    { label: 'three-tier / spike', design: loadDesign('three-tier'), scenario: loadScenario('spike') },
    { label: 'async-reliable / worker-crash', design: loadDesign('async-reliable'), scenario: loadScenario('worker-crash') },
    {
      label: 'autoscale / 10-min flash-crowd (scale-out + scale-in)',
      design: loadDesign('autoscale'),
      scenario: { ...loadScenario('flash-crowd'), durationS: 600, events: [{ type: 'spike', atS: 60, forS: 240, multiplier: 3 }] },
    },
  ];

  for (const { label, design, scenario } of cases) {
    it(`${label}: 1s chunked stepping + drain equals one-shot run`, { timeout: 30_000 }, () => {

      // Reference: one-shot (same as original done() from t=0)
      const oneShot = new Simulation(design, scenario, { tracesPerSec: 150, maxTraces: 100000 });
      oneShot.runUntil(oneShot.durationMs);
      const oneShotSnap = oneShot.liveState();
      oneShot.runUntil(Infinity);
      const oneShotWindows = oneShot.drainWindows();
      const oneShotTimeline = oneShot.drainTimeline(0);
      const oneShotResult = oneShot.result();

      // Chunked: a few normal playback ticks with lookahead, then 1,000 ms chunks like finishChunk()
      const chunked = new Simulation(design, scenario, { tracesPerSec: 150, maxTraces: 100000 });
      const windows: ReturnType<Simulation['drainWindows']> = [];
      const timeline: ReturnType<Simulation['drainTimeline']> = [];
      let timelineSent = 0;
      let simT = 0;
      const drain = () => {
        windows.push(...chunked.drainWindows());
        const tl = chunked.drainTimeline(timelineSent);
        timelineSent += tl.length;
        timeline.push(...tl);
        chunked.drainTraces();
      };
      // Simulate initial lookahead ticks before the user clicks Skip to end
      for (const t of [33, 66, 3050]) {
        if (t < chunked.durationMs) {
          simT = t;
          chunked.runUntil(simT);
          drain();
        }
      }
      // Now chunked Skip to end (FINISH_STEP_MS = 1_000)
      while (simT < chunked.durationMs && !chunked.done) {
        simT = Math.min(chunked.durationMs, simT + 1_000);
        chunked.runUntil(simT);
        drain();
      }
      const chunkedSnap = chunked.liveState();
      chunked.runUntil(Infinity);
      drain();
      const chunkedResult = chunked.result();

      expect(chunkedResult).toEqual(oneShotResult);
      expect(windows).toEqual(oneShotWindows);
      expect(timeline).toEqual(oneShotTimeline);
      expect(chunkedSnap).toEqual(oneShotSnap);
    });
  }
});

describe('sim.worker.ts finish / stop / restart protocol', () => {
  it('streams progress frames on a 30-min run, cancels cleanly on stop, and restarts without cross-run leaks', async () => {
    const messages: FromWorker[] = [];
    const fakeSelf: { onmessage: ((ev: MessageEvent<ToWorker>) => void) | null; postMessage: (m: FromWorker) => void } = {
      onmessage: null,
      postMessage: (m: FromWorker) => messages.push(m),
    };
    const origSelf = (globalThis as Record<string, unknown>).self;
    (globalThis as Record<string, unknown>).self = fakeSelf;

    try {
      await import('../src/worker/sim.worker.ts');
      const dispatch = (data: ToWorker) => fakeSelf.onmessage!({ data } as MessageEvent<ToWorker>);

      // Run 1: 30-minute scenario -> start -> finish -> stop mid-finish
      dispatch({ type: 'start', design: loadDesign('autoscale'), scenario: loadScenario('flash-crowd'), speed: 1, lang: 'en', run: 1 });
      dispatch({ type: 'finish' });

      // Wait for at least one finishing progress frame
      await new Promise((r) => setTimeout(r, 80));
      const run1Finishing = messages.filter((m) => m.run === 1 && m.type === 'frame' && m.finishing);
      expect(run1Finishing.length).toBeGreaterThan(0);

      // Stop mid-finish: no more messages for run 1 should arrive afterward
      dispatch({ type: 'stop' });
      const countAtStop = messages.filter((m) => m.run === 1).length;
      await new Promise((r) => setTimeout(r, 120));
      expect(messages.filter((m) => m.run === 1).length).toBe(countAtStop);
      expect(messages.some((m) => m.run === 1 && m.type === 'result')).toBe(false);

      // Run 2: immediately start a new run and finish it -> must match one-shot Simulation.runToEnd()
      const d2 = loadDesign('three-tier');
      const s2 = loadScenario('spike');
      dispatch({ type: 'start', design: d2, scenario: s2, speed: 1, lang: 'en', run: 2 });
      dispatch({ type: 'finish' });

      const deadline = Date.now() + 10_000;
      while (!messages.some((m) => m.run === 2 && m.type === 'result') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const resMsg = messages.find((m) => m.run === 2 && m.type === 'result');
      expect(resMsg).toBeDefined();
      const ref = new Simulation(d2, s2, { tracesPerSec: 150, maxTraces: 100000 }).runToEnd();
      expect((resMsg as Extract<FromWorker, { type: 'result' }>).result).toEqual(ref);

      // Ensure run 1 still received nothing while run 2 ran
      expect(messages.filter((m) => m.run === 1).length).toBe(countAtStop);
    } finally {
      fakeSelf.onmessage?.({ data: { type: 'stop' } } as MessageEvent<ToWorker>);
      if (origSelf === undefined) delete (globalThis as Record<string, unknown>).self;
      else (globalThis as Record<string, unknown>).self = origSelf;
    }
  });
});
