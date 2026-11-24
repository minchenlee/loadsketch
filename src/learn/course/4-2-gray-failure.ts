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
  intro: tx('When a server crashes completely, a load balancer notices and stops sending it traffic. Much harder to catch is a gray failure: a server that is still running, yet too slow or sick to serve users—like a grocery checkout lane whose "Open" light is on even though the register is crawling.\n\nLoad balancers rely on health checks (periodic probes) to see which servers are healthy. A basic liveness check only asks "is the process alive?", while a deep health check runs a real test request.\n\nHere, four API servers sit behind a round-robin load balancer (sending requests to each server in turn: 1, 2, 3, 4) at 800 requests a second with a 500 ms timeout. From second 20 to 80, instance 1 becomes 15 times slower, while staying alive. The load balancer uses a liveness check. Guess what users see, then press Run.'),
  scenario: 'gray-failure',
  terms: [
    {
      term: tx('Gray failure'),
      plain: tx('A partial failure where a server stays running and looks alive to simple checks, yet is too slow or broken to serve real traffic.'),
      example: tx('A supermarket checkout lane whose "Open" light is still lit even though the scanner is jammed.'),
    },
    {
      term: tx('Health check'),
      plain: tx('A periodic test sent by a load balancer to verify whether a server should keep receiving traffic (liveness checks if it is alive; deep checks test real work).'),
      example: tx('A store manager walking past each register to see if it is open (liveness) or scanning a test item (deep).'),
    },
    {
      term: tx('Outlier detection'),
      plain: tx('Automatically removing a server from the pool when real user requests to it fail repeatedly in a row.'),
      example: tx('Spotting a broken checkout lane automatically because five shoppers in a row leave it empty-handed.'),
    },
    {
      term: tx('Hedging'),
      plain: tx('Sending a duplicate copy of a slow read request to a second server after a short delay and taking whichever reply arrives first.'),
      example: tx('Asking a second clerk to look up a price if the first clerk takes too long, and using the first answer back.'),
    },
  ],
  questions: [
    {
      id: 'gray-errors',
      topic: 'other',
      text: tx('Round robin sends each of the four servers an equal 1/4 share of traffic. Instance 1 is 15 times slower for 60 of the 90 seconds, while the liveness check still sees it as alive. What share of all requests fail?'),
      options: errorOptions,
      answer: errorBand,
      measured: errorsMeasured,
      explain: tx('Because the process has not crashed, the liveness check keeps saying instance 1 is healthy. Round robin keeps sending it 1/4 of every request.\n\nAt 15× slower speed, instance 1 falls far behind, its queue fills up, and almost every request sent to it times out or gets rejected for two-thirds of the run.'),
      calc: [tx('Slow instance share: 1 of 4 servers = 1/4 of traffic'), tx('Slow duration: 60 of 90 s = 2/3 of the run'), tx('Failed share: about 1/4 × 2/3 = 1/6 ≈ 17%')],
      look: { node: 'lb' },
      explainFor: {
        few: tx('Almost no requests failed because the load balancer stopped sending traffic to the slow instance (using outlier detection, or a policy that avoids busy servers).'),
        some: tx('Fewer requests failed than the slow instance’s full share because something removed it for part of the time (such as a deep health check or temporary ejections).'),
      },
    },
    {
      id: 'outlier-errors',
      example: 'gray-failure-outlier',
      topic: 'recovery',
      text: tx('Instead of waiting for periodic probes, outlier detection watches real user traffic—like spotting a jammed checkout lane automatically when five customers in a row walk away empty-handed.\n\nNow the load balancer ejects any server for 30 seconds after 5 failures in a row. What share of all requests fail now?'),
      options: errorOptions,
      answer: errorBand,
      measured: errorsMeasured,
      explain: tx('The liveness check still misses the gray failure, but real user requests catch it right away. After 5 failures in a row, outlier detection ejects instance 1 for 30 seconds, tests it again later, and ejects it again if it is still slow.\n\nOnly the handful of requests sent right before each ejection fail. Watching real traffic finds gray failures far faster than simple probes.'),
      look: { node: 'lb' },
      explainFor: {
        some: tx('More requests failed than with default settings: either the server comes back too quickly (short ejection time) or it takes too many failures in a row to eject.'),
        quarter: tx('Outlier detection did not eject the slow server. Check that it is turned on and how many failures in a row it requires.'),
      },
    },
    {
      id: 'hedge-cost',
      example: 'hedged-reads',
      scenario: 'slow-instance',
      topic: 'capacity',
      text: tx('What if a server is just slow—not failing—so outlier detection never trips? One fix for read requests is hedging: if the first server has not answered after a short wait, send a second copy to another server and use whichever reply arrives first (like asking a second clerk if the first takes too long). We only hedge reads, because sending a write twice could double-charge a user.\n\nHere, normal API reads take 20 ms. For half of the 80-second run, 1 of 4 servers is 6× slower (~120 ms). Any read with no reply after 40 ms sends a hedged copy. How many extra calls do the API servers receive?'),
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
      explain: tx('A hedged copy only goes out when a request has not finished after 40 ms. Since normal reads average 20 ms, most extra calls come from the 1/4 of reads that hit the slow server during half the run (about 12.5%), plus a small slice of normal reads that happen to run past 40 ms.\n\nRemember: the slower losing copy still runs to completion on the server, so hedging creates real extra load. In practice, set the hedge delay near the p95 latency (the time 95% of normal requests finish within), not lower.'),
      look: { node: 'api' },
      explainFor: {
        many: tx('Many extra calls went out because the hedge delay is close to normal latency, causing healthy reads to trigger duplicate copies too.'),
        few: tx('Very few extra calls went out because few reads waited past the hedge delay (either a longer delay, or the load balancer avoided the slow server).'),
      },
    },
  ],
  challenges: [
    {
      id: 'gray-failure/no-outlier',
      title: tx('Without outlier detection'),
      text: tx('Keep total failures under 1% over the whole run. Outlier detection must stay off, and add no machines.'),
      goals: [failUnder1],
      rules: [noMoreCapacity, keepParam('lb', 'outlier', tx('No outlier detection'), tx('Outlier detection on the load balancer stays off'))],
      hint: tx('Round robin blindly hands every server the same share, even when one server is backed up.\n\nClick the load balancer and change "Distribution policy" to one that checks how busy each server already is (such as "Least connections"): a slow server builds a long line, so new requests naturally go to the fast servers. A deep health check alone reacts more slowly because it waits for several probes to fail.'),
    },
    {
      id: 'hedged-reads/cheaper',
      example: 'hedged-reads',
      scenario: 'slow-instance',
      title: tx('A cheaper tail'),
      text: tx('Keep p99 under 125 ms with fewer than 10% extra calls from hedging, and under 1% failures. Add no machines.'),
      goals: [p99Under(125, tx('p99 of successful requests under 125 ms')), extraUnder(0.1, tx('Fewer than 10% extra calls from hedging')), failUnder1],
      rules: [noMoreCapacity],
      hint: tx('A hedge rescues a request that landed on the slow server, but every hedge adds extra load.\n\nIf you send fewer requests to the slow server in the first place, fewer requests ever need a hedge! Change the load balancer’s "Distribution policy" so busy servers get fewer requests, and keep hedging enabled.'),
    },
  ],
  learn: [
    tx('Why a basic liveness health check misses a gray failure'),
    tx('How a deep health check catches slow servers, and why it still reacts with a delay'),
    tx('How outlier detection catches gray failures quickly from real traffic'),
    tx('How hedged reads cut tail latency, what extra load they cost, and where to set the delay'),
  ],
  learnAt: [2, 3, 5, 8],
  recap: [
    tx('Round robin keeps sending a slow server its full share, and a liveness check cannot see that it is slow.'),
    tx('Outlier detection—or a load-balancing policy that avoids busy servers—reacts directly to real traffic.'),
    tx('Hedging cuts tail latency for reads, but creates real extra load: set the delay near normal p95 latency, not lower.'),
  ],
  steps: [
    {
      kind: 'read',
      title: tx('One slow instance'),
      text: tx('A crashed server is easy to spot. A gray failure is trickier: the server is still running, so it looks alive, yet it is far too slow to serve real users—like one checkout lane whose "Open" light is still lit even though the scanner is broken.\n\nLoad balancers use health checks to monitor servers. A liveness check only asks "is the process alive?", while a deep health check runs a real request.\n\nHere, four API servers sit behind a round-robin load balancer (sending requests to servers 1, 2, 3, 4 in turn) at 800 requests a second with a 500 ms timeout. From second 20 to 80, instance 1 becomes 15 times slower, but its process stays alive. The load balancer only runs a liveness check. Guess what users see, then press Run.'),
      key: tx('A process that is up is not the same as a process that works.'),
    },
    { kind: 'guess', title: tx('Guess: what users see'), questions: ['gray-errors'] },
    { kind: 'run', title: tx('Run the gray failure'), look: { panel: 'bottom' }, show: ['failRate', 'timedOut', 'busiestInstance'] },
    {
      kind: 'try',
      title: tx('A deep health check'),
      text: tx('Switch "Health check" to "Deep (runs a real request)" (or use the button below) and run again.\n\nDo fewer requests fail? Do none fail? Watch the charts to see how quickly the slow server stops receiving traffic.'),
      patch: [{ node: 'lb', params: { healthCheck: 'deep' } }],
      look: { panel: 'bottom' },
      show: ['failRate', 'busiestInstance'],
    },
    { kind: 'guess', title: tx('Guess: outlier detection'), questions: ['outlier-errors'] },
    { kind: 'run', title: tx('Run with outlier detection'), example: 'gray-failure-outlier', show: ['failRate', 'busiestInstance'] },
    { kind: 'challenge', title: tx('Without outlier detection'), challenges: ['gray-failure/no-outlier'] },
    { kind: 'guess', title: tx('Guess: the cost of hedging'), questions: ['hedge-cost'] },
    { kind: 'run', title: tx('Run hedged reads'), example: 'hedged-reads', scenario: 'slow-instance', show: ['p99', 'hedgeExtra'] },
    {
      kind: 'try',
      title: tx('A shorter hedge'),
      text: tx('Shorten "Hedged request" from 40 ms to 25 ms—barely above the 20 ms normal speed (or use the button below)—and run again.\n\nHow much more does p99 drop? How many extra calls hit the API servers?'),
      example: 'hedged-reads',
      scenario: 'slow-instance',
      patch: [{ edge: 'lb->api', set: { hedgeMs: 25 } }],
      show: ['p99', 'hedgeExtra'],
    },
    { kind: 'challenge', title: tx('A cheaper tail'), challenges: ['hedged-reads/cheaper'] },
    { kind: 'practice', title: tx('Practice'), items: [{ kind: 'oncall', id: 'gray-errors' }, { kind: 'oncall', id: 'gray-slow' }, { kind: 'oncall', id: 'gc-pause' }] },
  ],
};

export default grayFailure;
