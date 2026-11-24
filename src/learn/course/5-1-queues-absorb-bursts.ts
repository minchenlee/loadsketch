// 5.1 Queues absorb bursts (async-queue with the spike scenario).
import { t, tx } from '../../i18n/index.ts';
import type { Goal, Lesson } from '../lesson.ts';
import { failUnder1, ms, p99Under } from '../lessonKit.ts';
import { givenParts, slotsAtMost } from '../lessonKit2.ts';
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
  intro: tx('When a user uploads a photo, making a thumbnail is slow. Waiting for it before replying is synchronous—like staying on the phone until someone finishes a task.\n\nInstead, this upload service works asynchronously—like dropping a letter in a mailbox and walking away. The Upload API saves the file, drops a ticket into a message queue (a durable inbox holding jobs for later), and replies right away. Behind the queue, a thumbnail worker (background staff processing the inbox) picks up tickets and makes the thumbnails.\n\nTraffic is 600 requests a second, and 1 in 10 is an upload (about 60 uploads a second). The worker has 2 machines × 4 slots (8 slots total), and each job takes about 50 ms (up to 160 jobs a second). From second 20 to 35, traffic triples to about 180 uploads a second. Guess where the burst goes, then press Run.'),
  scenario: 'spike',
  questions: [
    {
      id: 'users-p99',
      topic: 'queueing',
      text: tx('During the 15-second spike, how does the users’ p99 latency compare with before the spike?'),
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
      explain: tx('Users only wait for the Upload API to save the file and drop a ticket in the message queue. That work stays fast during the spike.\n\nThe extra thumbnail jobs pile up inside the queue and wait for the worker. Users do not feel the burst; the background thumbnails absorb it.'),
      look: { panel: 'bottom' },
      explainFor: {
        double: tx('Users felt the spike because a component on their synchronous path got busy. Look for a component users wait on directly, not behind the queue.'),
        worse: tx('Users felt the spike badly because a component on their synchronous path filled up. A message queue protects only the work behind it.'),
      },
    },
    {
      id: 'queue-peak',
      topic: 'queueing',
      text: tx('At the peak of the spike, how big is the backlog (messages waiting in the work queue)?'),
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
      explain: tx('During the spike, uploads arrive faster than the worker can finish them. Every second, the leftover jobs add to the backlog (the pile of unfinished tickets).\n\nThe growth rate is simple: arrival rate minus worker finish rate. Over 15 seconds, a small per-second gap builds up to a few hundred waiting messages.'),
      calc: [tx('Worker speed: 8 slots ÷ 0.05 s per job = 160 jobs/s'), tx('Spike arrivals: 60 uploads/s × 3 = 180 uploads/s'), tx('Backlog growth: (180 − 160) jobs/s × 15 s = 300 messages')],
      look: { node: 'jobs' },
      explainFor: {
        few: tx('The backlog stays tiny because the worker finishes jobs faster than they arrive, even during the spike.'),
        thousands: tx('The backlog grows into the thousands because the worker finishes far fewer jobs per second than arrive. The pile grows for as long as arrivals beat worker speed.'),
      },
    },
    {
      id: 'drain',
      topic: 'recovery',
      text: tx('After the spike ends at second 35, how long does it take to clear the backlog?'),
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
      explain: tx('Once traffic returns to normal, the worker finishes jobs faster than new uploads arrive. That leftover speed is spare capacity, and it eats away at the backlog.\n\nDrain time equals backlog size divided by spare capacity. With plenty of spare capacity, a few hundred tickets clear in seconds. With little spare capacity, even a small backlog lingers.'),
      calc: [tx('After the spike: 60 uploads/s arrive, 160 jobs/s finish'), tx('Spare capacity: 160 − 60 = 100 jobs/s'), tx('Drain time: 300 messages ÷ 100 jobs/s = 3 s')],
      look: { panel: 'bottom' },
      explainFor: {
        slow: tx('The worker has little spare capacity after the spike, so it clears the backlog slowly.'),
        never: tx('The worker is slower than the normal upload rate even after the spike (or barely faster). The backlog never clears, and wait times keep growing.'),
      },
    },
  ],
  challenges: [
    {
      id: 'async-queue/ready-in-1s',
      title: tx('Thumbnails within a second'),
      text: tx('Users already get fast replies, but thumbnails also need to finish quickly. Keep async p99 (the time from entering the queue until the worker finishes) under 1000 ms, even during the spike.\n\nYou may add worker capacity, using at most 10 worker slots in total (machines × slots per machine). Keep users’ p99 under 200 ms.'),
      goals: [
        { text: tx('Async p99 (queued to done) under 1000 ms'), check: (run) => ({ ok: asyncP99(run) < 1000, value: ms(asyncP99(run)) }) },
        slotsAtMost('jobs', 10, tx('Worker slots (machines × slots) ≤ 10'), tx('Work queue')),
        p99Under(200, tx('p99 of successful requests under 200 ms')),
        failUnder1,
        everyMessageDone,
      ],
      rules: [givenParts],
      hint: tx('Calculate the worker slots the spike needs: arrival rate × job time. During the spike, about 180 jobs/s × 0.05 s ≈ 9 slots.\n\nWith fewer than 9 slots, a backlog builds up and slows async p99. With 9 or 10 slots, the worker keeps up. Change “Instances” or “Concurrency per instance” on the Thumbnail worker.'),
    },
  ],
  terms: [
    {
      term: tx('Synchronous vs asynchronous'),
      plain: tx('Synchronous work makes the caller wait until the task finishes; asynchronous work replies right away and finishes the task in the background.'),
      example: tx('Synchronous is waiting on the phone for an answer. Asynchronous is dropping a letter in a mailbox and walking away.'),
    },
    {
      term: tx('Message queue'),
      plain: tx('A durable inbox that stores work tickets until background workers are ready to handle them.'),
      example: tx('An inbox tray on a desk that holds incoming orders until staff pick them up.'),
    },
    {
      term: tx('Worker'),
      plain: tx('A background server that pulls jobs from a message queue and processes them out of sight of the user.'),
      example: tx('Kitchen staff cooking orders from the ticket rail while the cashier keeps serving new customers.'),
    },
    {
      term: tx('Backlog'),
      plain: tx('The pile of unfinished tickets waiting inside a message queue.'),
      example: tx('A stack of unread support tickets that grows during a busy hour and shrinks when traffic calms down.'),
    },
  ],
  learn: [tx('Why users do not feel a burst that goes into a message queue'), tx('How fast a backlog grows: arrival rate minus worker finish rate'), tx('How long a backlog takes to drain: backlog ÷ spare capacity'), tx('What happens when a worker is slower than normal uploads'), tx('How to size worker slots for a traffic burst')],
  learnAt: [2, 2, 2, 3, 4],
  recap: [tx('Async work keeps users fast: the API drops a ticket in the message queue and replies right away.'), tx('A backlog grows when arrivals beat worker speed, and drains only as fast as spare capacity allows.'), tx('Worker slots needed = arrival rate × seconds per job.')],
  steps: [
    { kind: 'read', title: tx('An upload service'), text: tx('When a user uploads a photo, making a thumbnail is slow. Waiting for it before replying is synchronous—like staying on the phone until someone finishes a task.\n\nInstead, this upload service works asynchronously—like dropping a letter in a mailbox and walking away. The Upload API saves the file, drops a ticket into a message queue (a durable inbox holding jobs for later), and replies right away. Behind the queue, a thumbnail worker (background staff processing the inbox) picks up tickets and makes the thumbnails.\n\nTraffic is 600 requests a second, and 1 in 10 is an upload (about 60 uploads a second). The worker has 2 machines × 4 slots (8 slots total), and each job takes about 50 ms (up to 160 jobs a second). From second 20 to 35, traffic triples to about 180 uploads a second. Guess where the burst goes, then press Run.'), key: tx('A message queue moves the wait off the user’s request and onto background workers.') },
    { kind: 'guess', title: tx('Guess: where the spike goes'), questions: ['users-p99', 'queue-peak', 'drain'] },
    { kind: 'run', title: tx('Run the upload spike'), look: { panel: 'bottom' }, show: ['p99', 'asyncP99', 'queuePeak'] },
    { kind: 'try', title: tx('One worker machine'), text: tx('Remove one worker machine (set “Instances” to 1 on the Thumbnail worker) and run again. That cuts the worker from 8 slots to 4.\n\nWatch the charts: how big does the backlog grow, and does it drain after the spike? Do users feel any slowdown?'), patch: [{ node: 'thumb', params: { instances: 1 } }], look: { panel: 'bottom' }, show: ['p99', 'asyncP99', 'queuePeak'] },
    { kind: 'challenge', title: tx('Thumbnails within a second'), challenges: ['async-queue/ready-in-1s'] },
    { kind: 'practice', title: tx('Practice'), items: [{ kind: 'brief', id: 'brief-sale' }, { kind: 'brief', id: 'brief-notify' }, { kind: 'oncall', id: 'db-errors' }] },
  ],
};

export default queuesAbsorb;
