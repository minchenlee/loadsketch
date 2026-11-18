// Every course challenge limits how many requests may fail (review of 41fe433). Failing
// requests take load off everything behind them, so a goal about load, staleness or latency
// alone can be met by a design that fails. A goal counts as an error limit when it passes a run
// where every request succeeded and fails the same run with half of the requests failed.
import { describe, expect, it } from 'vitest';
import { COURSE } from '../../src/learn/course.ts';
import type { Goal } from '../../src/learn/lesson.ts';
import type { RunData } from '../../src/learn/metrics.ts';
import { runOf, setScenario } from './run.ts';

/** Challenges that need no error limit, each with the reason. */
const NO_LIMIT: Record<string, string> = {};

/**
 * withOk() sets the counts of the summary, so the run only has to be a run of the example: two
 * seconds of the scenario, no events. (6.2 takes about 20 s a full run, much more when the course
 * suite runs many files at once.)
 */
const short = setScenario('short', (s) => {
  s.durationS = 2;
  s.warmupS = 0;
  s.events = [];
});
const withOk = (run: RunData, share: number): RunData => {
  const s = run.result.summary;
  const ok = Math.round(s.offered * share);
  const failed = s.offered - ok;
  const fail = Object.fromEntries(Object.keys(s.fail).map((k) => [k, k === 'error' ? failed : 0])) as typeof s.fail;
  return { ...run, result: { ...run.result, summary: { ...s, ok, fail, errorRate: s.offered ? failed / s.offered : 0 } } };
};
const limitsErrors = (g: Goal, run: RunData) => {
  try {
    return g.check(withOk(run, 1)).ok && !g.check(withOk(run, 0.5)).ok;
  } catch {
    return false;
  }
};

describe('every challenge limits failed requests', () => {
  for (const l of COURSE) {
    it(`lesson ${l.id}`, () => {
      const missing: string[] = [];
      for (const c of l.challenges) {
        if (NO_LIMIT[c.id]) continue;
        const ex = c.example ?? l.example;
        const run = runOf(ex, c.scenario ?? l.scenario ?? ex, short);
        if (!c.goals.some((g) => limitsErrors(g, run))) missing.push(c.id);
      }
      expect(missing, missing.join('; ')).toEqual([]);
    }, 300_000);
  }
});

it('every challenge on the no-limit list exists and gives a reason', () => {
  const ids = new Set(COURSE.flatMap((l) => l.challenges.map((c) => c.id)));
  for (const [id, why] of Object.entries(NO_LIMIT)) {
    expect(ids.has(id)).toBe(true);
    expect(why.length).toBeGreaterThan(10);
  }
});
