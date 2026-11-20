// Every challenge of every course lesson must refuse a component that fails most requests
// (reviews of 9fd99c3 and 41fe433): when requests fail, fewer reach the components behind, so
// nothing is stale, busy or over a limit, and a goal that only counts bad outcomes would pass.
// Error rates 1, 0.99 and 0.5, applied to the example as it is, one component at a time and to
// every component at once.
import { describe, expect, it } from 'vitest';
import { COURSE } from '../../src/learn/course.ts';
import { judge, type Challenge, type Lesson } from '../../src/learn/lesson.ts';
import { KINDS } from '../../src/schema/kinds.ts';
import { design, runOf, sample, type Change } from './run.ts';

const RATES = [1, 0.99, 0.5];
const failing = (ids: string[], rate: number): Change => ({
  key: `cheat:errors:${rate}:${ids.join(',')}`,
  apply: (d) => {
    for (const n of d.nodes) if (ids.includes(n.id)) n.params = { ...n.params, errorRate: rate };
  },
});

/** Components whose kind has an error rate. */
const withErrors = (ex: string) => design(ex).nodes.filter((n) => KINDS[n.kind]?.params.errorRate);

function passes(c: Challenge, l: Lesson, change: Change) {
  const ex = c.example ?? l.example;
  const sc = c.scenario ?? l.scenario ?? ex;
  let run;
  try {
    run = runOf(ex, sc, change);
  } catch {
    return false;
  }
  return judge(c, run, design(ex)).passed;
}

describe('no challenge passes with a component that fails most requests', () => {
  // one test per lesson and rate: 6.2 takes about 4 runs of 20 s for each rate
  for (const l of COURSE)
    for (const rate of RATES) {
    it(`lesson ${l.id}, errorRate ${rate}`, () => {
      const passedBy: string[] = [];
      for (const c of l.challenges) {
        const all = withErrors(c.example ?? l.example);
        const ids = all.map((n) => n.id);
        // one at a time: every component, or one of each kind in a big design (see sample())
        const one = sample(all).map((n) => n.id);
        for (const id of one) if (passes(c, l, failing([id], rate))) passedBy.push(`${c.id}: ${id} errorRate ${rate}`);
        if (ids.length > 1 && passes(c, l, failing(ids, rate))) passedBy.push(`${c.id}: every component errorRate ${rate}`);
      }
      expect(passedBy, passedBy.join('; ')).toEqual([]);
    }, 900_000);
  }
});
