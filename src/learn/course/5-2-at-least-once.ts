// 5.2 At-least-once, duplicates and the DLQ (async-reliable with the worker-crash scenario).
import { t, tx } from '../../i18n/index.ts';
import type { Goal, Lesson } from '../lesson.ts';
import { failUnder1, ms, pct } from '../lessonKit.ts';
import { givenParts, keepParam, slotsAtMost } from '../lessonKit2.ts';
import type { RunData } from '../metrics.ts';

type QueueStats = { arrivals: number; asyncFail?: number; redelivered?: number; duplicates?: number; dlq?: number };
const jobs = (run: RunData) => (run.result.nodes.jobs ?? { arrivals: 0 }) as QueueStats;
const dlqShare = (run: RunData) => {
  const j = jobs(run);
  return j.arrivals > 0 ? (j.dlq ?? 0) / j.arrivals : 0;
};
const duplicates = (run: RunData) => jobs(run).duplicates ?? 0;
/** Messages that never finished and are not in the DLQ either: lost. */
const lost = (run: RunData) => Math.max(0, (jobs(run).asyncFail ?? 0) - (jobs(run).dlq ?? 0));
const asyncP99 = (run: RunData) => (run.result.summary.asyncLatencyMs.count > 0 ? run.result.summary.asyncLatencyMs.p99 : Infinity); // an empty histogram is not fast

/** Zero of something counted at the work queue; a missing queue fails (nothing was counted). */
const noneAt = (text: string, n: (run: RunData) => number): Goal => ({
  text,
  check: (run) => {
    if (!run.result.nodes.jobs || !run.design.nodes.some((x) => x.id === 'jobs')) return { ok: false, value: '—' };
    return { ok: n(run) === 0, value: String(n(run)) };
  },
});
const noDuplicates = noneAt(tx('No message is processed twice'), duplicates);
const nothingLost = noneAt(tx('No message is lost'), lost);

const atLeastOnce: Lesson = {
  id: '5.2',
  title: tx('At-least-once, duplicates and the DLQ'),
  unit: 5,
  order: 2,
  minutes: 25,
  wave: 1,
  example: 'async-reliable',
  intro: tx('The upload service again, now with a queue that deletes a message only when the worker says it is done (like SQS). A message a worker takes is hidden for 2 s (the visibility timeout); if the worker does not finish, the message appears again for another try. 1% of the messages are “poison”: they fail every time. After 3 tries a message moves to the dead-letter queue (DLQ). At second 20 one of the two worker machines crashes for 20 s. Guess, then press Run.'),
  scenario: 'worker-crash',
  questions: [
    {
      id: 'crash-wait',
      topic: 'queueing',
      text: tx('One of two worker machines is down for 20 s. What happens to the async p99 (from queued to done)?'),
      options: [
        { id: 'same', text: tx('About the same: the other machine takes over') },
        { id: 'seconds', text: tx('It grows to several seconds') },
      ],
      answer: (run) => (asyncP99(run) < 1000 ? 'same' : 'seconds'),
      measured: (run) => t('Async p99: {v}', { v: ms(asyncP99(run)) }),
      explain: tx('The one machine left has fewer slots than the uploads keep busy. For 20 s the worker is slower than the uploads, and the queue grows to hundreds of messages. Nothing is lost, but the thumbnails are seconds late. Spare capacity is what lets the others take over.'),
      calc: [tx('Busy slots: about 100 uploads a second × 0.05 s = 5'), tx('One machine left: 4 slots')],
      look: { panel: 'bottom' },
      explainFor: {
        same: tx('The async p99 stayed short: the machines left have enough slots for all the uploads.'),
      },
    },
    {
      id: 'dlq-share',
      topic: 'recovery',
      text: tx('What share of the messages end up in the DLQ?'),
      options: [
        { id: 'none', text: tx('None of them') },
        { id: 'poison', text: tx('About 1%: the poison messages') },
        { id: 'more', text: tx('More than 3%: the crash sent some there too') },
      ],
      answer: (run) => {
        const s = dlqShare(run);
        return s === 0 ? 'none' : s < 0.03 ? 'poison' : 'more';
      },
      measured: (run) => t('{p} of the messages in the DLQ ({n} messages)', { p: pct(dlqShare(run)), n: jobs(run).dlq ?? 0 }),
      explain: tx('Only the poison messages: each fails 3 times and then moves to the DLQ, where someone can look at it. The messages in the worker’s hands when it crashed appear again after 2 s, and the other machine finishes them. The crash costs time, not messages. Without a DLQ, a poison message would come back forever and waste a slot each time.'),
      look: { node: 'jobs' },
      explainFor: {
        none: tx('Nothing went to the DLQ: there are no poison messages, or there is no limit on tries, and a poison message comes back forever.'),
        more: tx('More than the poison messages: normal messages also failed 3 times. Look at the visibility timeout and the number of tries.'),
      },
    },
    {
      id: 'duplicates',
      topic: 'recovery',
      text: tx('At-least-once can deliver a message twice. How many messages does the worker process twice here?'),
      options: [
        { id: 'none', text: tx('None: each message is processed once') },
        { id: 'some', text: tx('Tens to hundreds') },
        { id: 'many', text: tx('More than a thousand') },
      ],
      answer: (run) => {
        const d = duplicates(run);
        return d === 0 ? 'none' : d <= 1000 ? 'some' : 'many';
      },
      measured: (run) => t('{n} messages processed twice', { n: duplicates(run) }),
      explain: tx('A duplicate happens when a message appears again while its first worker is still working on it: the job takes longer than the visibility timeout. Here a job takes about 50 ms and the timeout is 2 s, so that does not happen. A crashed worker never finishes, so its retry is not a duplicate. Set the timeout well above the longest job, and still make the work idempotent: a real network can lose the “done”.'),
      look: { node: 'jobs' },
      explainFor: {
        some: tx('Some messages were processed twice: some jobs took longer than the visibility timeout, and the message appeared again while the first worker was still busy.'),
        many: tx('Many messages were processed twice: the visibility timeout is about as short as a job, so many jobs outlive it.'),
      },
    },
  ],
  challenges: [
    {
      id: 'async-reliable/crash-safe',
      title: tx('Crash-safe and on time'),
      text: tx('One worker machine still crashes. Keep the async p99 under 1000 ms, lose no message, and process none twice. Delivery stays at-least-once and the limit of tries stays as it is. At most 12 worker slots.'),
      goals: [
        { text: tx('Async p99 (queued to done) under 1000 ms'), check: (run) => ({ ok: asyncP99(run) < 1000, value: ms(asyncP99(run)) }) },
        nothingLost,
        noDuplicates,
        failUnder1,
        slotsAtMost('jobs', 12, tx('Worker slots (machines × slots) ≤ 12'), tx('Work queue')),
      ],
      rules: [
        givenParts,
        keepParam('jobs', 'delivery', tx('At-least-once delivery'), tx('The queue’s delivery stays at-least-once')),
        keepParam('jobs', 'maxReceives', tx('Same limit of tries'), tx('The queue’s limit of tries before the DLQ stays as it is')),
      ],
      hint: tx('The crash takes away half the slots, and the half left is fewer than the uploads need. Size the worker so that what is left after a crash still keeps up: N + 1. A shorter visibility timeout gets a crashed job back sooner, but if it is shorter than a job, messages are processed twice.'),
    },
  ],
  learn: [tx('How at-least-once delivery brings a message back after a crash'), tx('When a message is processed twice: a job longer than the visibility timeout'), tx('What the DLQ is for: poison messages'), tx('Why the machines left after a crash must still keep up (N + 1)')],
  learnAt: [4, 5, 6, 7],
  recap: [tx('A crash costs time, not messages: what the worker held appears again after the visibility timeout.'), tx('Set the visibility timeout well above the longest job, and still make the work idempotent.'), tx('A DLQ stops a poison message from coming back forever.'), tx('Size the worker so that what is left after a crash still keeps up: N + 1.')],
  steps: [
    { kind: 'read', title: tx('At-least-once'), text: tx('The upload service again, now with a queue that deletes a message only when the worker says it is done (like SQS). A message a worker takes is hidden for 2 s (the visibility timeout); if the worker does not finish, the message appears again for another try.'), key: tx('A message is deleted only when the worker says it is done.') },
    { kind: 'read', title: tx('Poison messages and the DLQ'), text: tx('1% of the messages are “poison”: they fail every time. After 3 tries a message moves to the dead-letter queue (DLQ), where someone can look at it later.') },
    { kind: 'read', title: tx('The crash'), text: tx('At second 20 one of the two worker machines crashes for 20 s. Guess, then press Run.') },
    { kind: 'guess', title: tx('Guess: crash, DLQ, duplicates'), questions: ['crash-wait', 'dlq-share', 'duplicates'] },
    { kind: 'run', title: tx('Run the crash'), look: { panel: 'bottom' }, show: ['asyncP99', 'dlq', 'duplicates'] },
    { kind: 'try', title: tx('A short visibility timeout'), text: tx('Set “Visibility timeout” to 100 ms and run again. Are any messages processed twice now? Why would a job outlive 100 ms?'), patch: [{ node: 'jobs', params: { visibilityTimeoutMs: 100 } }], show: ['duplicates', 'asyncP99'] },
    { kind: 'try', title: tx('No DLQ'), text: tx('Set “Visibility timeout” back to 2 s, and set “Max receive count (DLQ)” to 0 (no DLQ, retry forever). Run again. Does anything go to the DLQ? What do the poison messages do to the worker and to the async p99?'), patch: [{ node: 'jobs', params: { visibilityTimeoutMs: 2000, maxReceives: 0 } }], look: { node: 'thumb' }, show: ['dlq', 'asyncP99', 'busiest'] },
    { kind: 'challenge', title: tx('Crash-safe and on time'), challenges: ['async-reliable/crash-safe'] },
    { kind: 'practice', title: tx('Practice'), items: [{ kind: 'brief', id: 'brief-notify' }, { kind: 'oncall', id: 'db-errors' }] },
  ],
};

export default atLeastOnce;
