// Messages between the page and the simulation worker.
import type { LiveNode, SimResult, TimelineEvent, Trace, WindowStat } from '../engine/index.ts';
import type { Design, Scenario } from '../schema/design.ts';
import type { Lang } from '../i18n/index.ts';

export type ToWorker =
  | { type: 'start'; design: Design; scenario: Scenario; speed: number; lang: Lang; /** Set by runtime.ts. */ run?: number }
  | { type: 'speed'; speed: number }
  | { type: 'pause'; paused: boolean }
  | { type: 'finish' }
  | { type: 'stop' };

export interface Snapshot {
  t: number; // ms
  live: Record<string, LiveNode>;
}

/** Every message carries the run number of its 'start', so the page can drop messages from a stopped run. */
export type FromWorker = FromWorkerBody & { run: number };
export type FromWorkerBody =
  | {
      type: 'frame';
      /** Display time (ms). The simulation itself runs ahead of it so finished request traces can be drawn. */
      tView: number;
      endMs: number;
      durationMs: number;
      speed: number;
      paused: boolean;
      /** The simulation could not keep up with the chosen speed. */
      lagging: boolean;
      /** Simulated at 1/scale of the traffic and capacity; counts are multiplied back (1: full size). */
      scale: number;
      snaps: Snapshot[];
      windows: WindowStat[];
      traces: Trace[];
      timeline: TimelineEvent[];
    }
  | { type: 'result'; result: SimResult; tView: number }
  | { type: 'error'; message: string };
