// 4.2 Gray failure, health checks and hedging (gray-failure → gray-failure-outlier; hedged-reads on slow-instance).
import { t, tx } from '../../i18n/index.ts';
import { noMoreCapacity, type Goal, type Lesson, type Question } from '../lesson.ts';
import { failUnder1, p99Under, pct } from '../lessonKit.ts';
import { keepParam } from '../lessonKit2.ts';
import type { RunData } from '../metrics.ts';

/** Extra calls the load balancer sent as hedges, as a share of its first tries. */
const hedgeExtra = (run: RunData) => {
  const e = run.result.edges['lb->api'] as { hedges?: number; attempts?: number; calls: number } | undefined;
  if (!e) return 0;
  const n = e.attempts ?? e.calls;
  return n > 0 ? (e.hedges ?? 0) / n : 0;
};

const extraUnder = (limit: number, text: string): Goal => ({
  text,
  check: (run) => ({ ok: hedgeExtra(run) < limit, value: pct(hedgeExtra(run)) }),
});

const errorOptions = [
  { id: 'few', text: tx('Under 3%') },
  { id: 'some', text: tx('3% to 12%') },
  { id: 'quarter', text: tx('12% to 35%: about the slow instance’s share') },
  { id: 'most', text: tx('More than 35%') },
];
const errorBand = (run: RunData) => {
  const e = run.result.summary.errorRate;
  return e < 0.03 ? 'few' : e < 0.12 ? 'some' : e < 0.35 ? 'quarter' : 'most';
};
const errorsMeasured: Question['measured'] = (run) => t('{p} of the requests failed', { p: pct(run.result.summary.errorRate) });

const grayFailure: Lesson = {
  id: '4.2',
  title: tx('Gray failure, health checks and hedging'),
  unit: 4,
  order: 2,
  minutes: 25,
  wave: 1,
  example: 'gray-failure',
  extraExamples: ['gray-failure-outlier', 'hedged-reads'],
  intro: tx('Four API servers behind a round-robin load balancer, 800 requests a second, a 500 ms timeout. From second 20 to 80, instance 1 becomes 15 times slower, but its process stays up. The load balancer runs a liveness check: “is the process up?”. Guess what users see, then press Run.'),
  scenario: 'gray-failure',
  questions: [
    {
      id: 'gray-errors',
      topic: 'other',
      text: tx('One of the four instances is 15 times slower for 60 of the 90 seconds. What share of all requests fail?'),
      options: errorOptions,
      answer: errorBand,
      measured: errorsMeasured,
      explain: tx('The liveness check says the slow instance is up, so round robin still sends it a quarter of the requests. It can serve only a fifteenth of its share: its queue fills up, and its requests time out or are rejected. A quarter of the requests for two thirds of the run is about a sixth of all of them.'),
      explainFor: {
        few: tx('Almost nothing failed: the load balancer stopped sending to the slow instance (outlier detection, or a policy that looks at how busy each instance is).'),
        some: tx('Fewer failed than the slow instance’s share: something took it out of rotation for part of the time (a deep health check, or ejections).'),
      },
    },
    {
      id: 'outlier-errors',
      example: 'gray-failure-outlier',
      topic: 'recovery',
      text: tx('Now the load balancer also runs outlier detection: 5 failures in a row from one instance eject it for 30 s. What share of all requests fail now?'),
      options: errorOptions,
      answer: errorBand,
      measured: errorsMeasured,
      explain: tx('The liveness check still sees nothing, but the requests do: after 5 failures in a row the slow instance is ejected, tried again after 30 s, and ejected again. Only the few requests in those moments fail. Outlier detection watches real traffic, which is why it finds a gray failure that a health check misses.'),
      explainFor: {
        some: tx('More failed than with the default settings: the instance comes back too often (a short ejection time) or is ejected too late (many failures in a row needed).'),
        quarter: tx('Outlier detection did not eject the slow instance: check that it is on, and how many failures in a row it needs.'),
      },
    },
    {
      id: 'hedge-cost',
      example: 'hedged-reads',
      scenario: 'slow-instance',
      topic: 'capacity',
      text: tx('Another design: one of four instances is 6 times slower, slow but not failing. A read with no reply after 40 ms sends a second copy to another instance (a hedged request); the first answer wins. That cuts p99 almost in half. How many more calls do the API servers get?'),
      options: [
        { id: 'few', text: tx('Under 5%') },
        { id: 'some', text: tx('5% to 30%') },
        { id: 'many', text: tx('More than 30%') },
      ],
      answer: (run) => {
        const x = hedgeExtra(run);
        return x < 0.05 ? 'few' : x < 0.3 ? 'some' : 'many';
      },
      measured: (run) => t('{p} more calls than requests', { p: pct(hedgeExtra(run)) }),
      explain: tx('A hedge goes out only when the first copy is late: here, mostly the requests that went to the slow instance. A quarter of the reads for half the run, and some normal reads that happen to pass 40 ms. The losing copy still runs to the end, so this is real extra load: hedge at about the p95 latency, not lower.'),
      explainFor: {
        many: tx('Many more calls: the hedge delay is close to the normal latency, so many normal reads send a second copy too.'),
        few: tx('Few extra calls: few reads were late, so few hedges went out (a longer hedge delay, or the load balancer avoided the slow instance).'),
      },
    },
  ],
  challenges: [
    {
      id: 'gray-failure/no-outlier',
      title: tx('Without outlier detection'),
      text: tx('Fewer than 1% fail over the whole run. Outlier detection stays off, and no more machines.'),
      goals: [failUnder1],
      rules: [noMoreCapacity, keepParam('lb', 'outlier', tx('No outlier detection'), tx('Outlier detection on the load balancer stays off'))],
      hint: tx('Round robin gives every instance the same share, however slow it is. Another balancing policy looks at how many requests each instance already has: a slow instance has a long line, so it gets fewer new ones. A deep health check helps less: it needs a few checks in a row to fail first.'),
    },
    {
      id: 'hedged-reads/cheaper',
      example: 'hedged-reads',
      scenario: 'slow-instance',
      title: tx('A cheaper tail'),
      text: tx('Keep p99 under 125 ms with fewer than 10% extra calls from hedging. No more machines.'),
      goals: [p99Under(125, tx('p99 of successful requests under 125 ms')), extraUnder(0.1, tx('Fewer than 10% extra calls from hedging')), failUnder1],
      rules: [noMoreCapacity],
      hint: tx('A hedge is a second chance for a request that landed on the slow instance. Send fewer requests there in the first place, and fewer need a second chance: change how the load balancer picks an instance, and keep the hedge.'),
    },
  ],
  steps: [
    { kind: 'read', text: tx('Four API servers behind a round-robin load balancer, 800 requests a second, a 500 ms timeout. From second 20 to 80, instance 1 becomes 15 times slower, but its process stays up. The load balancer runs a liveness check: “is the process up?”. Guess what users see, then press Run.') },
    { kind: 'guess', questions: ['gray-errors'] },
    { kind: 'run' },
    { kind: 'try', text: tx('Change the health check to “Deep (runs a real request)” and run again. Fewer requests fail, but not none: the check has to fail a few times in a row before the instance leaves the rotation.'), patch: [{ node: 'lb', params: { healthCheck: 'deep' } }] },
    { kind: 'guess', questions: ['outlier-errors'] },
    { kind: 'run', example: 'gray-failure-outlier' },
    { kind: 'challenge', challenges: ['gray-failure/no-outlier'] },
    { kind: 'guess', questions: ['hedge-cost'] },
    { kind: 'run', example: 'hedged-reads', scenario: 'slow-instance' },
    { kind: 'try', example: 'hedged-reads', scenario: 'slow-instance', text: tx('Set the hedge to 25 ms and run again: p99 drops a little more, but the API servers get about half again as many calls. The hedge now fires for many normal reads too.'), patch: [{ edge: 'lb->api', set: { hedgeMs: 25 } }] },
    { kind: 'challenge', challenges: ['hedged-reads/cheaper'] },
    { kind: 'practice', items: [{ kind: 'oncall', id: 'gray-errors' }, { kind: 'oncall', id: 'gray-slow' }, { kind: 'oncall', id: 'gc-pause' }] },
  ],
};

export default grayFailure;
