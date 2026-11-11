// Live run data that changes every frame. It lives outside React; components read it in their own
// animation callbacks, so 60 fps drawing does not re-render the tree.
import type { LiveNode, TimelineEvent, Trace, WindowStat } from '../engine/index.ts';
import type { FromWorker, Snapshot, ToWorker } from '../worker/protocol.ts';

export interface Clock {
  tView: number; // ms, as last reported by the worker
  at: number; // performance.now() when it was reported
  speed: number;
  paused: boolean;
  running: boolean;
}

export const live = {
  clock: { tView: 0, at: 0, speed: 1, paused: false, running: false } as Clock,
  snaps: [] as Snapshot[],
  windows: [] as WindowStat[],
  traces: [] as Trace[],
  timeline: [] as TimelineEvent[],
  endMs: 0,
  durationMs: 0,
  lagging: false,
  /** Simulated at 1/scale; counts already multiplied back. */
  scale: 1,
};

/** Current display time, interpolated between worker frames. */
export function viewTime(now = performance.now()): number {
  const c = live.clock;
  if (!c.running || c.paused) return c.tView;
  // never extrapolate more than ~3 worker ticks
  return c.tView + Math.min(now - c.at, 100) * c.speed;
}

/** Node state at time t: the last snapshot at or before t. */
export function liveAt(t: number): Record<string, LiveNode> | null {
  const s = live.snaps;
  if (!s.length) return null;
  let lo = 0;
  let hi = s.length - 1;
  if (s[0].t > t) return s[0].live;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return s[lo].live;
}

/** The time-series window that contains t (or the last finished one). */
/**
 * The last window that has ended at or before t: what a dashboard would show at time t.
 * (The simulation runs ahead of the view, so the window that contains t already exists,
 * but it would show requests that have not happened yet on screen.) The KPIs use the same window.
 */
export function windowAt(t: number): WindowStat | null {
  const w = live.windows;
  for (let i = w.length - 1; i >= 0; i--) {
    if (w[i].t * 1000 <= t + 1e-6) return w[i];
  }
  return null;
}

export function resetLive(): void {
  live.snaps = [];
  live.windows = [];
  live.traces = [];
  live.timeline = [];
  live.endMs = 0;
  live.durationMs = 0;
  live.lagging = false;
  live.scale = 1;
  live.clock = { tView: 0, at: performance.now(), speed: live.clock.speed, paused: false, running: false };
}

// ---------------------------------------------------------------------------------------------

let worker: Worker | null = null;
let onMessage: ((m: FromWorker) => void) | null = null;

export function connect(handler: (m: FromWorker) => void): void {
  onMessage = handler;
}

/** The current run. 'start' and 'stop' change it; messages from an older run are dropped. */
let run = 0;

export function send(m: ToWorker): void {
  if (m.type === 'start') m = { ...m, run: ++run };
  else if (m.type === 'stop') run++;
  if (!worker) {
    worker = new Worker(new URL('../worker/sim.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<FromWorker>) => {
      if (ev.data.run !== run) return;
      absorb(ev.data);
      onMessage?.(ev.data);
    };
  }
  worker.postMessage(m);
}

/** Fold a worker message into the live buffers. */
function absorb(m: FromWorker): void {
  if (m.type === 'frame') {
    live.clock = { tView: m.tView, at: performance.now(), speed: m.speed, paused: m.paused, running: true };
    live.endMs = m.endMs;
    live.durationMs = m.durationMs;
    live.lagging = m.lagging;
    live.scale = m.scale;
    if (m.snaps.length) live.snaps.push(...m.snaps);
    if (m.windows.length) live.windows.push(...m.windows);
    if (m.timeline.length) live.timeline.push(...m.timeline);
    if (m.traces.length) live.traces.push(...m.traces);
    // drop what is already in the past
    const keepFrom = m.tView - 1000 * Math.max(1, m.speed);
    let i = 0;
    while (i < live.snaps.length - 1 && live.snaps[i + 1].t < keepFrom) i++;
    if (i > 0) live.snaps.splice(0, i);
    if (live.traces.length > 3000) live.traces = live.traces.filter((tr) => tr.t1 >= m.tView);
  } else if (m.type === 'result') {
    live.clock = { ...live.clock, tView: m.tView, at: performance.now(), running: false };
  }
}

// A single 10 Hz ticker for React components that show live numbers.
let tick = 0;
const tickers = new Set<() => void>();
setInterval(() => {
  if (!live.clock.running && tick > 0 && live.snaps.length === 0) return;
  tick++;
  for (const f of tickers) f();
}, 100);
export function subscribeTick(f: () => void): () => void {
  tickers.add(f);
  return () => tickers.delete(f);
}
export const getTick = () => tick;
