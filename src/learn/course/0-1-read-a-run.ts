// 0.1 Read a run (three-tier / spike): utilization, p99, the bottleneck note and the theory row.
import { t, tx } from '../../i18n/index.ts';
import type { Goal, Lesson } from '../lesson.ts';
import type { RunData } from '../metrics.ts';
import { failUnder1, p99Under } from '../lessonKit.ts';
import { mostMachines } from '../courseMachines.ts';

const INTRO = tx('A three-tier site: a load balancer, 3 API servers (4 requests at a time each), a Redis cache and a Postgres database. Traffic is 600 requests a second, and from second 20 to 35 it is 3 times higher. Each card on the canvas shows how busy that component is; the Results tab shows p99 (the time 99% of requests finish within) and the bottleneck note. Guess which component fills up first.');

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

const THEORY = tx('After the run, the Results tab will also show a theory row (M/G/c). It predicts how long requests wait in a queue from the average load of the whole run. Guess how the measured wait compares, then press Run.');

const lesson: Lesson = {
  id: '0.1',
  title: tx('Read a run'),
  unit: 0,
  order: 1,
  minutes: 15,
  wave: 1,
  learn: [
    tx("Find the component that fills up first"),
    tx("Compare the measured wait with the theory row (M/G/c)"),
    tx("See why an average hides a spike"),
    tx("Add servers until a spike fits, with room to spare"),
  ],
  learnAt: [4, 5, 6, 7],
  recap: [
    tx("The smallest part fills up first: one server does (requests at a time) ÷ (time per request)."),
    tx("An average hides a spike: read the peak and the bottleneck note, not only the averages."),
    tx("A server that is 100% busy still makes requests queue: leave room."),
  ],
  example: 'three-tier',
  scenario: 'spike',
  intro: INTRO,
  questions: [
    {
      id: 'first-full',
      topic: 'capacity',
      text: tx('During the spike, which component fills up first?'),
      options: [
        { id: 'lb', text: tx('The load balancer') },
        { id: 'api', text: tx('The API servers') },
        { id: 'cache', text: tx('The Redis cache') },
        { id: 'db', text: tx('The database') },
      ],
      answer: first,
      measured: (run) => {
        const b = run.result.bottleneck;
        return b ? t('Bottleneck: {name}, {u} busy at its peak', { name: t(b.label), u: `${Math.round(b.peakUtilization * 100)}%` }) : t('No bottleneck');
      },
      calc: [tx('3 servers × 4 at a time ÷ 9 ms ≈ 1300 requests/s'), tx('Spike: 600/s × 3 = 1800 requests/s, more than 1300')],
      explain: tx('The API servers are the smallest part: they can do about 1300 requests a second, and the spike asks for 1800. Most reads stop at Redis, so the database sees only the misses and the writes, and stays far from full. The bottleneck note on the Results tab says this in words, with the second it happened.'),
      explainFor: {
        lb: tx('Here the load balancer is the bottleneck: it forwards every request, so check its own settings.'),
        cache: tx('Here the cache is the bottleneck: check its capacity and the number of requests it can serve at a time.'),
        db: tx('Here the database is the bottleneck: the reads that miss the cache and all the writes land on it. Check its connections and replicas.'),
      },
    },
    {
      id: 'theory-gap',
      topic: 'queueing',
      text: tx('The theory row (M/G/c) predicts how long requests wait in the API queue, from the average load of the whole run. How does the measured wait compare?'),
      options: [
        { id: 'lower', text: tx('Lower than the theory') },
        { id: 'close', text: tx('Close to the theory (within 2 times)') },
        { id: 'higher', text: tx('2 to 10 times the theory') },
        { id: 'far', text: tx('More than 10 times the theory') },
      ],
      answer: (run) => {
        const g = gap(run);
        return g < 0.5 ? 'lower' : g <= 2 ? 'close' : g <= 10 ? 'higher' : 'far';
      },
      measured: (run) => {
        const w = waits(run);
        return t('Measured wait {sim} ms; theory {theory} ms', { sim: fmtMs(w.sim), theory: fmtMs(w.theory) });
      },
      explain: tx('The theory row sees only the average: over the whole minute the API servers are busy about 60% of the time, and at 60% almost nobody waits. But for 15 seconds the spike asks for more than they can do, the queue fills up, and requests wait more than a second. An average hides a spike: read the peak and the bottleneck note, not only the averages.'),
      explainFor: {
        lower: tx('Measured is below the theory: the theory assumes requests are spread at random, but the load balancer sends each one to the least busy server, so fewer wait.'),
        close: tx('Measured is close to the theory: the API servers never ran out of room, so the average load tells the whole story.'),
        higher: tx('Measured is a few times the theory: for part of the run the API servers were near full, and short queues formed that the average does not show.'),
      },
    },
  ],
  challenges: [
    {
      id: 'read-run/hold-spike',
      title: tx('Hold the spike'),
      text: tx('Keep the error rate under 1% and p99 under 100 ms through the spike, with at most 5 API servers.'),
      goals: [apiAtMost5, failUnder1, p99Under(100, tx('p99 of successful requests under 100 ms'))],
      rules: [],
      hint: tx('The spike asks for about 1800 requests a second. Work out how many requests a second one API server can do (requests at a time ÷ time per request), and add servers until the spike fits with some room to spare: a server that is 100% busy still makes requests queue.'),
    },
  ],
  steps: [
    { kind: 'read', title: tx('A three-tier site'), text: INTRO, key: tx('The busiest component fills up first, and sets how much the site can take.') },
    { kind: 'guess', title: tx('Which part fills up first'), questions: ['first-full'] },
    { kind: 'read', title: tx('The theory row'), text: THEORY, key: tx('The theory row sees only the average load of the whole run.') },
    { kind: 'guess', title: tx('Measured wait or theory'), questions: ['theory-gap'] },
    { kind: 'run', title: tx('Run the spike'), look: { tab: 'results', panel: 'bottom' } },
    { kind: 'try', title: tx('6 API servers'), text: tx('Set the API servers to 6 instances and run again. Does the spike fit now, and how close is the measured wait to the theory? The challenge below asks for the same with at most 5.'), patch: [{ node: 'api', params: { instances: 6 } }] },
    { kind: 'try', title: tx('No spike'), text: tx('This switches to the steady scenario (no spike) with the original design. Run it: with the load flat, how close is the measured wait to the theory?'), scenario: 'steady', look: { tab: 'results' } },
    { kind: 'challenge', title: tx('Hold the spike'), challenges: ['read-run/hold-spike'] },
  ],
};

export default lesson;
