// Ways round a challenge that every challenge of every course lesson must refuse (lead's rule,
// review of bddad6f): delete a component of the example, give it a new id, make the work take
// forever (nothing finishes, so nothing "fails" and the latency histogram is empty), make it take
// the shortest time a part allows, let every part take 8 times as many requests at a time, or drop
// queued messages at once. Each cheat is applied to the example as it is.
import { describe, expect, it } from 'vitest';
import { COURSE } from '../../src/learn/course.ts';
import { judge, type Challenge, type Lesson } from '../../src/learn/lesson.ts';
import { KINDS } from '../../src/schema/kinds.ts';
import type { Design } from '../../src/schema/design.ts';
import { design, runOf, scenario, type Change } from './run.ts';

const removeNode = (id: string): Change => ({
  key: `cheat:remove:${id}`,
  apply: (d) => {
    d.nodes = d.nodes.filter((n) => n.id !== id);
    d.edges = d.edges.filter((e) => e.from !== id && e.to !== id);
  },
});
const renameNode = (id: string): Change => ({
  key: `cheat:rename:${id}`,
  apply: (d) => {
    const to = `${id}-new`;
    for (const n of d.nodes) if (n.id === id) n.id = to;
    for (const e of d.edges) {
      if (e.from === id) e.from = to;
      if (e.to === id) e.to = to;
    }
  },
});
const TIME_KEYS = ['serviceMs', 'readMs', 'writeMs', 'opMs', 'processMs'];
/** Every processing time at its maximum. */
const forever: Change = {
  key: 'cheat:forever',
  apply: (d) => {
    for (const n of d.nodes)
      for (const k of TIME_KEYS) {
        const spec = KINDS[n.kind]?.params[k];
        if (spec) n.params = { ...n.params, [k]: { mean: (spec as { max?: number }).max ?? 600000, cv: 0 } };
      }
  },
};
/** Every processing time at its minimum: faster code or hardware than the example has. */
const fastest: Change = {
  key: 'cheat:fastest',
  apply: (d) => {
    for (const n of d.nodes)
      for (const k of TIME_KEYS) {
        const spec = KINDS[n.kind]?.params[k];
        if (spec) n.params = { ...n.params, [k]: { mean: (spec as { min?: number }).min ?? 0, cv: 0 } };
      }
  },
};
/** Every component that has slots takes 8 times as many requests at a time (within the kind's maximum). */
const moreSlots: Change = {
  key: 'cheat:concurrency',
  apply: (d) => {
    for (const n of d.nodes) {
      const spec = KINDS[n.kind]?.params.concurrency as { default?: number; max?: number } | undefined;
      if (!spec) continue;
      const was = typeof n.params?.concurrency === 'number' ? n.params.concurrency : (spec.default ?? 1);
      n.params = { ...n.params, concurrency: Math.min(spec.max ?? Infinity, was * 8) };
    }
  },
};
/**
 * A second copy of every component that runs on machines, under a new id, wired like the first:
 * more capacity that no rule about the original ids sees.
 */
const copies: Change = {
  key: 'cheat:copies',
  apply: (d) => {
    const ids = d.nodes.filter((n) => n.kind !== 'client' && KINDS[n.kind]?.params.instances).map((n) => n.id);
    for (const id of ids) {
      const n = d.nodes.find((x) => x.id === id)!;
      d.nodes.push({ ...structuredClone(n), id: id + '-copy' });
      for (const e of [...d.edges]) {
        if (e.to === id) d.edges.push({ ...structuredClone(e), to: id + '-copy' });
        if (e.from === id) d.edges.push({ ...structuredClone(e), from: id + '-copy' });
      }
    }
  },
};
/** Every queue drops its messages almost at once. */
const dropMessages: Change = {
  key: 'cheat:ttl',
  apply: (d) => {
    for (const n of d.nodes) if (KINDS[n.kind]?.params.messageTtlS) n.params = { ...n.params, messageTtlS: 0.001 };
  },
};

/** Every component that can autoscale does, as fast as it can (instances is then only the floor). */
const autoscaleAll: Change = {
  key: 'cheat:autoscale',
  apply: (d) => {
    for (const n of d.nodes)
      if (KINDS[n.kind]?.params.autoscale && n.params?.autoscale !== 'on') n.params = { ...n.params, autoscale: 'on', maxInstances: 12, scaleEveryS: 1, bootS: 0, coldFactor: 1, targetUtil: 0.3 };
  },
};

function cheatsFor(d: Design, c: Challenge): { name: string; change: Change }[] {
  const out: { name: string; change: Change }[] = [];
  for (const n of d.nodes) {
    if (n.kind === 'client') continue;
    if (!c.mayRemove?.includes(n.id)) out.push({ name: `remove ${n.id}`, change: removeNode(n.id) });
    out.push({ name: `rename ${n.id}`, change: renameNode(n.id) });
  }
  out.push({ name: 'processing takes forever', change: forever });
  out.push({ name: 'processing at the minimum time', change: fastest });
  out.push({ name: 'a second copy of each component', change: copies });
  if (d.nodes.some((n) => KINDS[n.kind]?.params.concurrency)) out.push({ name: 'more requests at a time', change: moreSlots });
  if (d.nodes.some((n) => KINDS[n.kind]?.params.autoscale && n.params?.autoscale !== 'on')) out.push({ name: 'autoscale past the machine limit', change: autoscaleAll });
  if (d.nodes.some((n) => KINDS[n.kind]?.params.messageTtlS)) out.push({ name: 'messages expire at once', change: dropMessages });
  return out;
}

/**
 * A cheat that takes away a component of the example (removed or renamed) is refused by judge()
 * from the design alone: its "Removed" check reads only run.design. That is checked first, with
 * the example's own run and the cheat's design, so these cheats need no run of their own (6.2 has
 * 14 components, about 20 s a run). judge() must then name the removal; anything else is run.
 */
function refusedByDesign(c: Challenge, ex: string, sc: string, change: Change) {
  const d = structuredClone(design(ex));
  change.apply(d, structuredClone(scenario(sc)));
  const original = design(ex);
  const gone = original.nodes.filter((o) => !c.mayRemove?.includes(o.id) && !d.nodes.some((n) => n.id === o.id && n.kind === o.kind));
  if (!gone.length) return false;
  const v = judge(c, { ...runOf(ex, sc), design: d }, original);
  return !v.passed && v.broken.length > 0;
}

/** Runs a cheat; a design the engine cannot run cannot pass either. */
function verdict(c: Challenge, l: Lesson, change: Change) {
  const ex = c.example ?? l.example;
  const sc = c.scenario ?? l.scenario ?? ex;
  if (refusedByDesign(c, ex, sc, change)) return false;
  let run;
  try {
    run = runOf(ex, sc, change);
  } catch {
    return false;
  }
  return judge(c, run, design(ex)).passed;
}

describe('no challenge passes a cheat', () => {
  for (const l of COURSE) {
    it(`lesson ${l.id}`, () => {
      const passedBy: string[] = [];
      for (const c of l.challenges)
        for (const { name, change } of cheatsFor(design(c.example ?? l.example), c)) if (verdict(c, l, change)) passedBy.push(`${c.id}: ${name}`);
      expect(passedBy).toEqual([]);
    }, 900_000);
  }
});
