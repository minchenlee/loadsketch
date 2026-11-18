// 5.1 Queues absorb bursts (async-queue with the spike scenario).
import { t, tx } from '../../i18n/index.ts';
import type { Goal, Lesson } from '../lesson.ts';
import { failUnder1, ms, p99Under } from '../lessonKit.ts';
import { slotsAtMost } from '../lessonKit2.ts';
import { spikeEnd, type RunData } from '../metrics.ts';

const SPIKE_FROM = 20;

/** The highest one-second p99 of the users' requests in (from, to]. */
const windowP99 = (run: RunData, from: number, to: number) => {
  const ws = run.windows.filter((w) => w.t > from && w.t <= to && w.latency.count > 0);
  return ws.length ? Math.max(...ws.map((w) => w.latency.p99)) : 0;
};
/** How much worse the users' p99 is during the spike than before it. */
const userRatio = (run: RunData) => {
  const before = windowP99(run, 5, SPIKE_FROM);
  return before > 0 ? windowP99(run, SPIKE_FROM, spikeEnd(run.scenario)) / before : 0;
};

const depthOf = (run: RunData, t: number) => (run.windows.find((w) => w.t === t)?.nodes.jobs as { depth?: number } | undefined)?.depth ?? 0;
/** Most messages waiting in the work queue at once. */
const peakDepth = (run: RunData) => (run.result.nodes.jobs as { queueDepthMax?: number } | undefined)?.queueDepthMax ?? 0;
/** Seconds after the spike until the queue holds fewer than 5 messages (Infinity: not before the end). */
const drainS = (run: RunData) => {
  const end = spikeEnd(run.scenario);
  const w = run.windows.find((x) => x.t > end && depthOf(run, x.t) < 5);
  return w ? w.t - end : Infinity;
};
const asyncP99 = (run: RunData) => (run.result.summary.asyncLatencyMs.count > 0 ? run.result.summary.asyncLatencyMs.p99 : Infinity); // an empty histogram is not fast

/** Every message on the work queue is done: none expired or failed (a missing queue fails). */
const everyMessageDone: Goal = {
  text: tx('Every message is done: none expired or failed'),
  check: (run) => {
    const j = run.result.nodes.jobs as { asyncFail?: number } | undefined;
    if (!j || !run.design.nodes.some((n) => n.id === 'jobs')) return { ok: false, value: '—' };
    return { ok: (j.asyncFail ?? 0) === 0, value: t('{n} not done', { n: j.asyncFail ?? 0 }) };
  },
};


const queuesAbsorb: Lesson = {
  id: '5.1',
  title: tx('Queues absorb bursts'),
  unit: 5,
  order: 1,
  minutes: 20,
  wave: 1,
  example: 'async-queue',
  intro: tx('An upload service: 600 requests a second, 1 in 10 is an upload. The API stores the file, puts one message on a work queue and answers at once; a thumbnail worker (2 machines × 4 slots, about 50 ms a job) takes the messages later. From second 20 to 35, traffic triples. Guess where the spike goes, then press Run.'),
  scenario: 'spike',
  questions: [
    {
      id: 'users-p99',
      topic: 'queueing',
      text: tx('During the spike, how does the users’ p99 compare with before it?'),
      options: [
        { id: 'same', text: tx('About the same') },
        { id: 'double', text: tx('About twice as slow') },
        { id: 'worse', text: tx('More than three times as slow') },
      ],
      answer: (run) => {
        const r = userRatio(run);
        return r < 1.5 ? 'same' : r < 3 ? 'double' : 'worse';
      },
      measured: (run) => t('Highest p99 in one second: {a} before the spike, {b} during it', { a: ms(windowP99(run, 5, SPIKE_FROM)), b: ms(windowP99(run, SPIKE_FROM, spikeEnd(run.scenario))) }),
      explain: tx('The users wait only for the API, and the API only puts a message on the queue: that is as fast during the spike as before. The extra work goes into the queue and waits for the worker. The users do not see the spike; the thumbnails do.'),
      explainFor: {
        double: tx('The users felt the spike: something they wait for got busy. Look for a component on the path of the request, not behind the queue.'),
        worse: tx('The users felt the spike badly: something they wait for is full. A queue protects only what is behind it.'),
      },
    },
    {
      id: 'queue-peak',
      topic: 'queueing',
      text: tx('At most, how many messages wait in the work queue?'),
      options: [
        { id: 'few', text: tx('Fewer than 50: the worker keeps up') },
        { id: 'hundreds', text: tx('50 to 1000') },
        { id: 'thousands', text: tx('More than 1000') },
      ],
      answer: (run) => {
        const d = peakDepth(run);
        return d < 50 ? 'few' : d < 1000 ? 'hundreds' : 'thousands';
      },
      measured: (run) => t('At most {n} messages waiting', { n: Math.round(peakDepth(run)) }),
      explain: tx('A job holds a worker slot for about 50 ms (the thumbnail and the database write), so 8 slots finish about 160 a second. During the spike about 180 uploads a second arrive. The queue grows by the difference, about 20 a second, for 15 seconds: a few hundred messages. The growth rate is arrivals minus service, λ − μ.'),
      explainFor: {
        few: tx('The queue stays short: the worker finishes more jobs a second than arrive, even during the spike.'),
        thousands: tx('The queue grows by thousands: the worker finishes far fewer jobs a second than arrive. It grows as long as arrivals are higher than service.'),
      },
    },
    {
      id: 'drain',
      topic: 'recovery',
      text: tx('When the spike ends at second 35, how long until the queue is empty again?'),
      options: [
        { id: 'fast', text: tx('Within 10 seconds') },
        { id: 'slow', text: tx('10 seconds or more') },
        { id: 'never', text: tx('Not before the end of the run') },
      ],
      answer: (run) => {
        const s = drainS(run);
        return s < 10 ? 'fast' : s === Infinity ? 'never' : 'slow';
      },
      measured: (run) => {
        const s = drainS(run);
        return s === Infinity ? t('Still not empty at the end') : t('Empty {s} seconds after the spike', { s: Math.round(s) });
      },
      explain: tx('After the spike, about 60 uploads a second arrive and the worker finishes about 160: it gains 100 a second on the queue, so a few hundred messages are gone in a few seconds. The time to drain is the backlog divided by the spare capacity (μ − λ). With little spare capacity, a small backlog takes a long time.'),
      explainFor: {
        slow: tx('The worker has little spare capacity after the spike: it drains the backlog slowly.'),
        never: tx('The worker is slower than the uploads even after the spike (or barely faster): the queue never empties, and the wait keeps growing.'),
      },
    },
  ],
  challenges: [
    {
      id: 'async-queue/ready-in-1s',
      title: tx('Thumbnails within a second'),
      text: tx('Thumbnails must be ready within a second, spike included: async p99 under 1000 ms. You may add worker capacity, but at most 10 worker slots in all (machines × slots per machine). Users’ p99 stays under 200 ms.'),
      goals: [
        { text: tx('Async p99 (queued to done) under 1000 ms'), check: (run) => ({ ok: asyncP99(run) < 1000, value: ms(asyncP99(run)) }) },
        slotsAtMost('jobs', 10, tx('Worker slots (machines × slots) ≤ 10')),
        p99Under(200, tx('p99 of successful requests under 200 ms')),
        failUnder1,
        everyMessageDone,
      ],
      rules: [],
      hint: tx('Work out the slots the spike needs: arrivals a second × seconds a job holds a slot. About 180 a second × 0.05 s ≈ 9 slots. With fewer, the queue grows during the spike; with a bit more, it stays short. Change “Concurrency per instance” or “Instances” of the worker.'),
    },
  ],
  steps: [
    { kind: 'read', text: tx('An upload service: 600 requests a second, 1 in 10 is an upload. The API stores the file, puts one message on a work queue and answers at once; a thumbnail worker (2 machines × 4 slots, about 50 ms a job) takes the messages later. From second 20 to 35, traffic triples. Guess where the spike goes, then press Run.') },
    { kind: 'guess', questions: ['users-p99', 'queue-peak', 'drain'] },
    { kind: 'run' },
    { kind: 'try', text: tx('Take one worker machine away (“Instances” 1) and run again. Now the worker is slower than the uploads during the spike by about 100 a second, and only a little faster after it: the queue grows past a thousand, and the async p99 becomes many seconds. The users still do not notice.'), patch: [{ node: 'thumb', params: { instances: 1 } }] },
    { kind: 'challenge', challenges: ['async-queue/ready-in-1s'] },
    { kind: 'practice', items: [{ kind: 'brief', id: 'brief-sale' }, { kind: 'brief', id: 'brief-notify' }, { kind: 'oncall', id: 'db-errors' }] },
  ],
};

export default queuesAbsorb;
