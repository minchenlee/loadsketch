// Machine counts and parameter means for course challenges (src/learn/course/). Not in lessonKit.ts: that file is being
// merged on feat/course-preview, so new shared parts of the wave-1 lessons live here.
import type { RunData } from './metrics.ts';
import { paramOf } from './lessonKit.ts';

const num = (v: unknown) => (typeof v === 'number' ? v : 0);

/**
 * The most machines component `id` can run: its instances, its autoscaling limit when autoscaling
 * is on (instances is then only the floor), and the most the run measured. A limit on machines
 * checks this, so turning autoscaling on cannot get round it.
 */
export function mostMachines(run: RunData, id: string): number {
  const auto = paramOf(run.design, id, 'autoscale') === 'on';
  return Math.max(
    num(paramOf(run.design, id, 'instances')),
    auto ? num(paramOf(run.design, id, 'maxInstances')) : 0,
    num(run.result.nodes[id]?.autoscale?.peakActive),
  );
}

/**
 * The mean of a time parameter: a design may give it as a number (the mean) or as a
 * distribution { mean, cv }; the engine runs both the same. Undefined when it is neither.
 */
export function meanOf(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && 'mean' in v && typeof (v as { mean: unknown }).mean === 'number') return (v as { mean: number }).mean;
  return undefined;
}
