// Runs the simulation off the main thread and paces it to the chosen playback speed.
//
// The display time (tView) moves with real time × speed. The simulation runs LOOKAHEAD ms ahead of
// tView: a request's trace is complete only when the request ends, and we want to draw it while it
// is still moving. Snapshots of every node's busy slots and queue are taken on the way, so the page
// can show the state at tView, not at the simulation's own (later) clock.

import { Simulation } from '../engine/index.ts';
import { setLang } from '../i18n/index.ts';
import type { FromWorkerBody, Snapshot, ToWorker } from './protocol.ts';

const TICK_MS = 33;
const MAX_EVENTS_PER_TICK = 1_500_000;
const FINISH_BUDGET_MS = 40;
const FINISH_STEP_MS = 1_000;

let sim: Simulation | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let finishTimer: ReturnType<typeof setTimeout> | null = null;
let speed = 1;
let paused = false;
let finishing = false;
let endSnap: Snapshot | null = null;
let tView = 0;
let lastReal = 0;
let lookahead = 3050;
let simT = 0;
let timelineSent = 0;
let lagging = false;

let run = 0;
const post = (m: FromWorkerBody) => (self as unknown as Worker).postMessage({ ...m, run });

function stopTimers(): void {
  if (timer) clearInterval(timer);
  timer = null;
  if (finishTimer) clearTimeout(finishTimer);
  finishTimer = null;
}

function snapEvery(): number {
  return Math.min(500, Math.max(0.5, speed * TICK_MS));
}

function advance(target: number, snaps: Snapshot[]): void {
  if (!sim) return;
  const start = sim.events;
  const step = snapEvery();
  while (simT < target && !sim.done) {
    simT = Math.min(target, simT + step);
    sim.runUntil(simT);
    snaps.push({ t: simT, live: sim.liveState() });
    if (sim.events - start > MAX_EVENTS_PER_TICK) break;
  }
}

function frame(): void {
  if (!sim) return;
  const now = performance.now();
  const prev = tView;
  // The view stops where the traffic stops (durationMs). Requests still in flight then finish in
  // done(): they count in the result, but they are not animated.
  if (!paused) tView = Math.min(sim.durationMs, tView + (now - lastReal) * speed);
  lastReal = now;
  const snaps: Snapshot[] = [];
  advance(tView + lookahead, snaps);
  // Too slow for this speed: hold the view back so it never passes what has been simulated.
  lagging = !sim.done && simT < tView + lookahead - 1;
  if (lagging) tView = Math.max(prev, simT - lookahead);
  const timeline = sim.drainTimeline(timelineSent);
  timelineSent += timeline.length;
  post({
    type: 'frame',
    tView,
    endMs: sim.endMs,
    durationMs: sim.durationMs,
    speed,
    paused,
    lagging,
    scale: sim.scalePlan.k,
    snaps,
    windows: sim.drainWindows(),
    traces: sim.drainTraces(),
    timeline,
  });
  if (tView >= sim.durationMs) {
    stopTimers();
    paused = false;
    finishing = true;
    finishChunk();
  }
}

function done(extraSnaps?: Snapshot[]): void {
  if (!sim) return;
  stopTimers();
  finishing = false;
  endSnap = null;
  tView = sim.durationMs;
  const snaps: Snapshot[] = extraSnaps ? [...extraSnaps] : [];
  if (simT < tView) {
    // "jump to the end": record the state at the end of the traffic, which is what the view shows
    simT = tView;
    sim.runUntil(tView);
    snaps.push({ t: tView, live: sim.liveState() });
  }
  if (!sim.done) sim.runUntil(Infinity);
  const windows = sim.drainWindows();
  const timeline = sim.drainTimeline(timelineSent);
  timelineSent += timeline.length;
  sim.drainTraces();
  post({ type: 'frame', tView, endMs: sim.endMs, durationMs: sim.durationMs, speed, paused, lagging: false, finishing: false, scale: sim.scalePlan.k, snaps, windows, traces: [], timeline });
  post({ type: 'result', result: sim.result(), tView });
  sim = null;
}

/** Advance through both traffic and the post-traffic drain in ~40 ms chunks so long runs report progress and stay cancellable. */
function finishChunk(): void {
  finishTimer = null;
  if (!sim || !finishing) return;
  try {
    const t0 = performance.now();
    // Phase 1: traffic up to durationMs, capturing the end-of-traffic snapshot once
    if (simT < sim.durationMs) {
      while (simT < sim.durationMs && !sim.done) {
        simT = Math.min(sim.durationMs, simT + FINISH_STEP_MS);
        sim.runUntil(simT);
        if (performance.now() - t0 >= FINISH_BUDGET_MS) break;
      }
      if (simT >= sim.durationMs && !endSnap) {
        endSnap = { t: sim.durationMs, live: sim.liveState() };
      }
    }
    // Phase 2: drain in-flight requests up to endMs in the same ~40 ms chunks so Stop stays responsive
    if (simT >= sim.durationMs && !sim.done) {
      while (!sim.done && simT < sim.endMs) {
        simT = Math.min(sim.endMs, simT + FINISH_STEP_MS);
        sim.runUntil(simT);
        if (performance.now() - t0 >= FINISH_BUDGET_MS) break;
      }
      if (!sim.done && simT >= sim.endMs) sim.runUntil(Infinity);
    }
    if (sim.done) {
      const snaps = endSnap ? [endSnap] : undefined;
      endSnap = null;
      done(snaps);
      return;
    }
    tView = Math.min(simT, sim.durationMs);
    // Discard traces while skipping ahead so memory stays flat; clock and charts keep advancing.
    sim.drainTraces();
    const timeline = sim.drainTimeline(timelineSent);
    timelineSent += timeline.length;
    post({
      type: 'frame',
      tView,
      endMs: sim.endMs,
      durationMs: sim.durationMs,
      speed,
      paused: false,
      lagging: false,
      finishing: true,
      scale: sim.scalePlan.k,
      snaps: simT <= sim.durationMs ? [{ t: simT, live: sim.liveState() }] : [],
      windows: sim.drainWindows(),
      traces: [],
      timeline,
    });
    finishTimer = setTimeout(finishChunk, 0);
  } catch (e) {
    stopTimers();
    finishing = false;
    endSnap = null;
    sim = null;
    post({ type: 'error', message: (e as Error).message });
  }
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  try {
    switch (m.type) {
      case 'start': {
        stopTimers();
        setLang(m.lang);
        run = m.run ?? 0;
        speed = m.speed;
        paused = false;
        finishing = false;
        endSnap = null;
        tView = 0;
        simT = 0;
        timelineSent = 0;
        sim = new Simulation(m.design, m.scenario, { tracesPerSec: 150, maxTraces: 100000 });
        lookahead = sim.sc.clientTimeoutMs + 50;
        lastReal = performance.now();
        frame();
        if (sim && !finishing) timer = setInterval(frame, TICK_MS);
        break;
      }
      case 'speed':
        speed = m.speed;
        break;
      case 'pause':
        if (finishing) break;
        paused = m.paused;
        lastReal = performance.now();
        if (sim) frame();
        break;
      case 'finish':
        if (sim && !finishing) {
          stopTimers();
          paused = false;
          finishing = true;
          finishChunk();
        }
        break;
      case 'stop':
        stopTimers();
        finishing = false;
        endSnap = null;
        sim = null;
        break;
    }
  } catch (e) {
    stopTimers();
    finishing = false;
    endSnap = null;
    post({ type: 'error', message: (e as Error).message });
  }
};
