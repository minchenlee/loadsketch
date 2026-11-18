// Machine counts and parameter means for course challenges (src/learn/course/). Not in lessonKit.ts: that file is being
// merged on feat/course-preview, so new shared parts of the wave-1 lessons live here.
import { t, tx } from '../i18n/index.ts';
import type { Design } from '../schema/design.ts';
import { noMoreCapacity, type Rule } from './lesson.ts';
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

/** The parameters that set how many machines a component runs. */
const MACHINES = ['instances', 'maxInstances', 'autoscale'];

/**
 * Only the machines of component `id` may change (a goal limits how many): no new component, no
 * faster part, no more requests at a time or connections anywhere, nothing removed. Without it, a
 * challenge that limits only the machines of `id` passes with faster servers, more requests at a
 * time per server, or a second group of servers under a new id.
 */
export const onlyMachinesOf = (id: string): Rule => ({
  short: tx('Only more machines'),
  text: tx('Only the number of API servers can change: no new component, processing times cannot get shorter, requests at a time and connections cannot grow, and nothing can be removed'),
  check: (d, original) => {
    const out = d.nodes.filter((n) => !original.nodes.some((o) => o.id === n.id)).map((n) => t('Added component "{name}"', { name: n.label ? t(n.label) : n.id }));
    // the machines of id are the goal's to judge: compare the rest with them as they were
    const rest: Design = structuredClone(d);
    const was = original.nodes.find((n) => n.id === id);
    const now = rest.nodes.find((n) => n.id === id);
    if (was && now) {
      const params = { ...now.params };
      for (const k of MACHINES) {
        if (was.params && k in was.params) params[k] = was.params[k];
        else delete params[k];
      }
      now.params = params;
    }
    return [...out, ...noMoreCapacity.check(rest, original)];
  },
});
