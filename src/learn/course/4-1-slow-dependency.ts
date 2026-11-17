// 4.1 Slow dependency: timeout, bulkhead, fallback, breaker (slow-dependency → bulkhead-fallback; resilience).
import { t, tx } from '../../i18n/index.ts';
import { noMoreCapacity, type Goal, type Lesson } from '../lesson.ts';
import { failUnder1, p99Under, pct } from '../lessonKit.ts';
import type { RunData } from '../metrics.ts';

/** Share of the users' requests answered with a degraded answer: each response counted once (summary.degraded), not each fallback on the way. */
const degraded = (run: RunData) => {
  const s = run.result.summary as { degraded?: number; offered: number };
  return s.offered > 0 ? (s.degraded ?? 0) / s.offered : 0;
};

const degradedUnder = (limit: number, text: string): Goal => ({
  text,
  check: (run) => ({ ok: degraded(run) < limit, value: pct(degraded(run)) }),
});

const failBands = (run: RunData) => {
  const e = run.result.summary.errorRate;
  return e < 0.05 ? 'few' : e < 0.25 ? 'some' : e < 0.6 ? 'half' : 'most';
};

const slowDependency: Lesson = {
  id: '4.1',
  title: tx('Slow dependency: timeout, bulkhead, fallback, breaker'),
  unit: 4,
  order: 1,
  minutes: 30,
  wave: 1,
  example: 'slow-dependency',
  extraExamples: ['bulkhead-fallback', 'resilience'],
  intro: tx('A product page: 1500 requests a second into 4 API servers with 32 slots each. Every request reads Postgres, then asks the recommendation service for a list (timeout 1 s). Recommendations are only a nice extra. From second 20 to 60 they become 50 times slower: about 1 s a call. Guess what that does to the product page, then press Run.'),
  scenario: 'slow-dependency',
  questions: [
    {
      id: 'slow-fail',
      topic: 'recovery',
      text: tx('Recommendations are slow for 40 of the 80 seconds. What share of all product page requests fail?'),
      options: [
        { id: 'few', text: tx('Under 5%: only the recommendations are late') },
        { id: 'some', text: tx('5% to 25%') },
        { id: 'half', text: tx('25% to 60%: about every request while they are slow') },
        { id: 'most', text: tx('More than 60%') },
      ],
      answer: failBands,
      measured: (run) => t('{p} of the requests failed', { p: pct(run.result.summary.errorRate) }),
      explain: tx('A slow call is worse than a failed one: it holds an API slot while it waits. Each call now takes about 1 s, so 1500 a second need about 1500 slots, and there are 128. The slots fill with waiting calls, the queue fills up, and requests that never needed recommendations are rejected too. One extra feature takes down the whole page.'),
      explainFor: {
        few: tx('Almost nothing failed: this design does not let the slow calls hold the slots (a short timeout with a fallback, or a bulkhead with a fallback).'),
        some: tx('Some requests failed: the slow calls held part of the slots. Look for what still waits on recommendations for long.'),
      },
    },
    {
      id: 'degraded',
      example: 'bulkhead-fallback',
      topic: 'capacity',
      text: tx('Now with a bulkhead (at most 4 calls to recommendations at a time per API server) and a fallback (a default list when the call is not made or fails). Over the whole run, what share of requests get the default list instead of real recommendations?'),
      options: [
        { id: 'few', text: tx('Under 10%') },
        { id: 'half', text: tx('About half: every request while recommendations are slow') },
        { id: 'most', text: tx('More than half: some even while they are fast') },
      ],
      answer: (run) => {
        const d = degraded(run);
        return d < 0.1 ? 'few' : d < 0.55 ? 'half' : 'most';
      },
      measured: (run) => t('{p} of the requests got the fallback', { p: pct(degraded(run)) }),
      explain: tx('Nothing fails any more, but the bulkhead is too small. At normal speed each API server makes about 375 calls a second of 20 ms each: about 7.5 at a time on average, and 4 are allowed. So even while recommendations are fast, many calls are turned away and get the default list. A bulkhead must be larger than the normal concurrency; to cut a slow call short, use the timeout.'),
      explainFor: {
        half: tx('About half got the fallback: every request while recommendations were slow, and almost none before or after. The bulkhead (or the timeout) is sized right for normal speed.'),
        few: tx('Few got the fallback: recommendations were rarely cut off. Check that the API servers still hold up while they are slow.'),
      },
    },
  ],
  challenges: [
    {
      id: 'slow-dependency/hold',
      title: tx('Keep the page up'),
      text: tx('Fewer than 1% of requests fail over the whole run, without adding machines.'),
      goals: [failUnder1],
      rules: [noMoreCapacity],
      hint: tx('Look at the connection from the API to recommendations. Two settings together: one stops the API from waiting long (a shorter timeout, or a bulkhead that limits how many calls wait), and one turns a failed call into a default answer (fallback). Either one alone is not enough: try each and see why.'),
    },
    {
      id: 'bulkhead-fallback/degrade-less',
      example: 'bulkhead-fallback',
      title: tx('Degrade less'),
      text: tx('On “Bulkhead + fallback”: still fewer than 1% fail, fewer than 55% of requests get the default list, and p99 stays under 200 ms. No more machines.'),
      goals: [failUnder1, degradedUnder(0.55, tx('Fewer than 55% get the fallback')), p99Under(200, tx('p99 of successful requests under 200 ms'))],
      rules: [noMoreCapacity],
      hint: tx('At normal speed the bulkhead of 4 is already full. Make it larger than the normal number of calls in flight, and let the timeout cut slow calls short instead: a call that waits 1 s holds a slot for 1 s. A larger bulkhead alone lets slow calls wait the whole second, and p99 goes up.'),
    },
  ],
  steps: [
    { kind: 'read', text: tx('A product page: 1500 requests a second into 4 API servers with 32 slots each. Every request reads Postgres, then asks the recommendation service for a list (timeout 1 s). Recommendations are only a nice extra. From second 20 to 60 they become 50 times slower: about 1 s a call. Guess what that does to the product page, then press Run.') },
    { kind: 'guess', questions: ['slow-fail'] },
    { kind: 'run' },
    { kind: 'try', text: tx('Turn on only the fallback on the connection to recommendations, and run again. Almost as many requests fail: the calls still wait up to 1 s and hold the slots. Then try only a bulkhead of 4: more fail, because a call the bulkhead turns away is an error.'), patch: [{ edge: 'api->recs', set: { fallback: 'on' } }] },
    { kind: 'challenge', challenges: ['slow-dependency/hold'] },
    { kind: 'guess', questions: ['degraded'] },
    { kind: 'run', example: 'bulkhead-fallback' },
    { kind: 'challenge', challenges: ['bulkhead-fallback/degrade-less'] },
    { kind: 'run', example: 'resilience', scenario: 'slow-payments', text: tx('One more layer: a circuit breaker. Here the order service calls payments through a breaker; when payments slow down, the breaker opens after enough calls fail and rejects at once for a few seconds, then lets a few calls try again. Run it and look at the breaker card: how often it opened, and how many calls it turned away.') },
    { kind: 'practice', items: [{ kind: 'oncall', id: 'slow-dependency' }, { kind: 'oncall', id: 'db-slow' }, { kind: 'brief', id: 'brief-checkout' }] },
  ],
};

export default slowDependency;
