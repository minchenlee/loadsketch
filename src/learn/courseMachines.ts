// Machine counts for course challenges (src/learn/course/). Not in lessonKit.ts: that file is being
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
