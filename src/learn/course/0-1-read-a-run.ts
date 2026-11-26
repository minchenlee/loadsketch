// 0.1 Read a run (three-tier / spike): utilization, p99, the bottleneck note and the theory row.
import { t, tx } from '../../i18n/index.ts';
import type { Goal, Lesson } from '../lesson.ts';
import type { RunData } from '../metrics.ts';
import { failUnder1, p99Under } from '../lessonKit.ts';
import { mostMachines, onlyMachinesOf } from '../courseMachines.ts';

const INTRO = tx(
  'Every time someone opens a webpage or taps a button, their device sends a request to a website’s computers. Those computers are called servers (or instances in the settings). When too many requests arrive at once, a site slows down or shows errors. Reading a simulation run lets you spot the weak link before real users hit it.\n\nThis site has four parts in a row. First, a load balancer acts like a restaurant host at the door and spreads incoming requests across 3 API servers. Each API server handles up to 4 requests at once (4 slots). To answer a request, an API server checks a cache (Redis, a fast notepad in memory that keeps popular answers handy) and a database (Postgres, the main filing cabinet on disk). Most requests are reads, and 85% of them find their answer right in Redis, so Postgres only handles the remaining 15% misses and the updates.\n\nNormally, 600 requests arrive every second. From second 20 to second 35, traffic jumps 3 times higher to 1,800 requests per second (a spike). Each API server holds one slot for about 9 ms per request (6 ms of its own processing time plus about 3 ms waiting on Redis or Postgres). Since 1 second equals 1,000 ms, one slot handles about 111 requests per second (1,000 ÷ 9). Three servers with 4 slots each give 12 slots total, or roughly 1,300 requests per second.\n\nWhen all slots on a component are busy, new requests wait in a queue (a waiting line, like at a coffee shop). Each card on the canvas shows how busy that part is. After a run, the Results tab shows latency (total time from start to finish for successful requests), p99 (the time 99% of successful requests finish within, catching slowdowns an average hides), error rate (the share of requests that fail), and the bottleneck (the part that fills up first and limits the whole site). Guess which part fills up first during the spike.',
);

const LAYERS = ['lb', 'api', 'cache', 'db'];

/** The component the run names as its bottleneck (one of the four layers). */
const first = (run: RunData) => {
  const b = run.result.bottleneck?.node;
  return b && LAYERS.includes(b) ? b : 'api';
};

/** Measured waiting time in the API queue ÷ what the theory row (M/G/c on the average load) predicts. */
const waits = (run: RunData) => {
  const n = run.result.nodes.api;
  return { sim: n?.waitMs ?? 0, theory: n?.theory?.waitMs ?? 0 };
};
const gap = (run: RunData) => {
  const { sim, theory } = waits(run);
  // both under a millisecond: nobody waits, and the two agree
  if (sim < 1 && theory < 1) return 1;
  return theory > 0 ? sim / theory : Infinity;
};
const fmtMs = (x: number) => (x < 10 ? x.toFixed(2) : Math.round(x).toString());

const apiAtMost5: Goal = {
  text: tx('At most 5 API servers'),
  check: (run) => {
    const n = mostMachines(run, 'api');
    return { ok: n > 0 && n <= 5, value: String(n) };
  },
};

const THEORY = tx(
  'After the run, click the API server card on the canvas: its Settings panel also shows a queueing theory comparison (labeled M/G/c, a standard math formula for waiting lines).\n\nThat formula uses only the average traffic across the whole 60-second run. It ignores whether requests arrive smoothly or rush in during one busy burst—just like saying a coffee shop averages 1 customer a minute when 60 people actually walk in during a single 15-minute rush.\n\nGuess how the real waiting time in the API queue compares with that average-based estimate, then press Run.',
);

const lesson: Lesson = {
  id: '0.1',
  title: tx('Read a run'),
  unit: 0,
  order: 1,
  minutes: 15,
  wave: 1,
  learn: [
    tx('Spot the bottleneck that fills up first during a spike'),
    tx('Compare real queue wait times with an average-based estimate'),
    tx('See why an average hides a short traffic spike'),
    tx('Add servers so a spike fits with spare room'),
  ],
  learnAt: [4, 5, 6, 7],
  recap: [
    tx('The busiest part is the bottleneck: it fills up first and limits the whole site.'),
    tx('An average hides a spike. Always read peak busyness, p99 latency, and the bottleneck note.'),
    tx('A server at 100% busy still builds a waiting line. Always leave spare room.'),
  ],
  terms: [
    {
      term: tx('Bottleneck'),
      plain: tx('The single narrowest part of a system that fills up first and caps how much traffic the whole site can handle.'),
      example: tx('A 4-lane highway narrowing to 1 tollbooth—that tollbooth sets the speed for everyone.'),
    },
    {
      term: tx('Traffic spike'),
      plain: tx('A sudden, temporary jump in requests per second far above normal traffic.'),
      example: tx('Hundreds of fans clicking “Buy” at the exact second concert tickets go on sale.'),
    },
    {
      term: tx('Instance'),
      plain: tx('One running copy of a server in your design settings—adding instances means adding more servers to share the work.'),
      example: tx('Opening 5 identical checkout lanes instead of 3.'),
    },
    {
      term: tx('Theory row (M/G/c)'),
      plain: tx('A classic waiting-line math formula (shown under a component’s Settings tab after a run) that estimates average queue wait using only the run’s average load.'),
      example: tx('Guessing coffee shop wait times from the daily average while ignoring the morning rush hour.'),
    },
  ],
  example: 'three-tier',
  scenario: 'spike',
  intro: INTRO,
  questions: [
    {
      id: 'first-full',
      topic: 'capacity',
      text: tx('During the 1,800 requests/s spike, which part of the site fills up first?'),
      options: [
        { id: 'lb', text: tx('The load balancer') },
        { id: 'api', text: tx('The API servers') },
        { id: 'cache', text: tx('The Redis cache') },
        { id: 'db', text: tx('The Postgres database') },
      ],
      answer: first,
      measured: (run) => {
        const b = run.result.bottleneck;
        return b ? t('Bottleneck: {name}, {u} busy at its peak', { name: t(b.label), u: `${Math.round(b.peakUtilization * 100)}%` }) : t('No bottleneck');
      },
      calc: [
        tx('1 slot at ~9 ms hold time (6 ms work + ~3 ms waiting on Redis/Postgres): 1000 ÷ 9 ≈ 111 requests/s'),
        tx('3 API servers × 4 slots = 12 slots → about 1300 requests/s'),
        tx('Spike: 600/s × 3 = 1800 requests/s, over the 1300/s limit'),
      ],
      explain: tx(
        'The API servers are the bottleneck. Together, their 12 slots can finish about 1,300 requests per second, while the spike sends 1,800.\n\nMeanwhile, 85% of reads finish right at the fast Redis cache, so Postgres only sees the leftover misses and writes and stays calm. The bottleneck note on the Results tab names this component and the exact second it filled up.',
      ),
      explainFor: {
        lb: tx('Here the load balancer is the bottleneck: it forwards every request, so check its own settings.'),
        cache: tx('Here the cache is the bottleneck: check its capacity and how many operations it handles at once.'),
        db: tx('Here the database is the bottleneck: the reads that miss the cache and all the writes land on it. Check its connections and read replicas.'),
      },
    },
    {
      id: 'theory-gap',
      topic: 'queueing',
      text: tx('The theory row estimates how long requests wait in the API queue using only the 60-second average traffic. How does the real measured wait compare?'),
      options: [
        { id: 'lower', text: tx('Lower than the theory estimate') },
        { id: 'close', text: tx('Close to the theory estimate (within 2 times)') },
        { id: 'higher', text: tx('2 to 10 times the theory estimate') },
        { id: 'far', text: tx('More than 10 times the theory estimate') },
      ],
      answer: (run) => {
        const g = gap(run);
        return g < 0.5 ? 'lower' : g <= 2 ? 'close' : g <= 10 ? 'higher' : 'far';
      },
      measured: (run) => {
        const w = waits(run);
        return t('Measured wait {sim} ms; theory {theory} ms', { sim: fmtMs(w.sim), theory: fmtMs(w.theory) });
      },
      explain: tx(
        'Averaged over the whole 60 seconds, traffic sits comfortably below the API servers’ 1,300/s capacity, so the average-only formula predicts almost no waiting.\n\nDuring the 15-second spike, however, 1,800 requests/s slam into servers that can only finish 1,300/s. A long queue forms and real wait times soar far above the theory estimate. An average hides a spike: always read peak busyness, p99 latency, and the bottleneck note.',
      ),
      explainFor: {
        lower: tx('Measured wait is below the theory estimate: the formula assumes requests are spread at random, while the load balancer sends each request to the least busy server, so fewer requests wait.'),
        close: tx('Measured wait is close to the theory estimate: the API servers never ran out of room, so the average load tells the whole story.'),
        higher: tx('Measured wait is a few times the theory estimate: for part of the run the API servers came close to full, creating short queues that the average hides.'),
      },
    },
  ],
  challenges: [
    {
      id: 'read-run/hold-spike',
      title: tx('Hold the spike'),
      text: tx('Handle the 1,800 requests/s spike using at most 5 API servers. Keep the error rate under 1% and p99 latency under 100 ms.'),
      goals: [apiAtMost5, failUnder1, p99Under(100, tx('p99 of successful requests under 100 ms'))],
      rules: [onlyMachinesOf('api')],
      hint: tx(
        'One API server has 4 slots taking about 9 ms per request, so 1 server handles about 4 × (1000 ÷ 9) ≈ 440 requests/s.\n\nDivide the 1,800/s spike by 440/s per server, then leave spare room: a server running near 100% busy still builds a queue and raises p99.',
      ),
    },
  ],
  steps: [
    { kind: 'read', title: tx('A three-tier site'), text: INTRO, key: tx('The busiest part is the bottleneck: it fills up first and sets how much traffic the site can take.') },
    { kind: 'guess', title: tx('Which part fills up first'), questions: ['first-full'] },
    { kind: 'read', title: tx('The theory row'), text: THEORY, key: tx('An average smooths out rush hours, so it can hide a short, severe jam.') },
    { kind: 'guess', title: tx('Measured wait or theory'), questions: ['theory-gap'] },
    { kind: 'run', title: tx('Run the spike'), look: { tab: 'results', panel: 'bottom' } },
    { kind: 'try', title: tx('6 API servers'), text: tx('Change the API servers’ Instances setting from 3 to 6 and run again. With twice as many servers, does the spike fit now, and how close is the measured wait to the theory estimate? (The challenge below asks you to hold the same spike with at most 5 servers.)'), patch: [{ node: 'api', params: { instances: 6 } }] },
    { kind: 'try', title: tx('No spike'), text: tx('This switches back to 3 API servers and uses the Steady scenario (a flat 800 requests/s with no spike). Run it, then check the Settings tab of the API server card: when traffic stays steady, how close is the measured wait to the theory estimate?'), scenario: 'steady', look: { node: 'api', tab: 'design' } },
    { kind: 'challenge', title: tx('Hold the spike'), challenges: ['read-run/hold-spike'] },
  ],
};

export default lesson;
