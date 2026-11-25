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
  intro: tx('What if a worker crashes halfway through a job? To avoid losing tickets, this queue uses at-least-once delivery: it deletes a message only after the worker sends an acknowledgment (ack). While a worker handles a ticket, the queue hides it for a 2 s (2000 ms) visibility timeout. If no ack arrives in time, the ticket reappears for another worker.\n\n1% of messages are broken “poison” messages that fail every time. After 3 failed tries, a ticket moves to the dead-letter queue (DLQ)—a separate box for broken tickets. Traffic is 100 uploads a second across 2 worker machines (4 slots each, ~50 ms hold time per job: 40 ms of thumbnail work plus ~10 ms writing back to Postgres). At second 20, one worker machine crashes for 20 s. Guess, then press Run.'),
  scenario: 'worker-crash',
  questions: [
    {
      id: 'crash-wait',
      topic: 'queueing',
      text: tx('One of the two worker machines crashes for 20 s. What happens to async p99 (from queued to done)?'),
      options: [
        { id: 'same', text: tx('About the same: the other machine takes over') },
        { id: 'seconds', text: tx('It grows to several seconds') },
      ],
      answer: (run) => (asyncP99(run) < 1000 ? 'same' : 'seconds'),
      measured: (run) => t('Async p99: {v}', { v: ms(asyncP99(run)) }),
      explain: tx('The one surviving machine has only 4 slots, while 100 uploads a second keep about 5 slots busy. For 20 seconds, the worker falls behind and a backlog of hundreds of tickets builds up.\n\nNo message is lost, because the crashed worker’s tickets reappear after the visibility timeout. Thumbnails just arrive seconds late. Surviving a crash smoothly requires spare capacity.'),
      calc: [tx('Hold time per job ≈ 50 ms (40 ms own work + ~10 ms writing to Postgres)'), tx('Slots needed: 100 uploads/s × 0.05 s = 5 slots'), tx('Surviving machine: 4 slots')],
      look: { panel: 'bottom' },
      explainFor: {
        same: tx('Async p99 stayed short because the surviving machines had enough slots to handle all uploads on their own.'),
      },
    },
    {
      id: 'dlq-share',
      topic: 'recovery',
      text: tx('What share of all messages end up in the dead-letter queue (DLQ)?'),
      options: [
        { id: 'none', text: tx('None of them') },
        { id: 'poison', text: tx('About 1%: only the poison messages') },
        { id: 'more', text: tx('More than 3%: the crash sent normal messages there too') },
      ],
      answer: (run) => {
        const s = dlqShare(run);
        return s === 0 ? 'none' : s < 0.03 ? 'poison' : 'more';
      },
      measured: (run) => t('{p} of the messages in the DLQ ({n} messages)', { p: pct(dlqShare(run)), n: jobs(run).dlq ?? 0 }),
      explain: tx('Only the poison messages reach the DLQ. Each poison message fails 3 times and moves into the separate DLQ box for inspection.\n\nMessages held by the crashed worker reappear after the 2 s visibility timeout, and the healthy worker finishes them on the second try. A crash costs time, not messages. Without a DLQ, poison messages would loop forever and waste worker slots.'),
      look: { node: 'jobs' },
      explainFor: {
        none: tx('Nothing entered the DLQ. Either there are no poison messages, or the try limit is turned off so poison messages retry forever.'),
        more: tx('Normal messages also hit the 3-try limit and went to the DLQ. Check the visibility timeout and the max receive count.'),
      },
    },
    {
      id: 'duplicates',
      topic: 'recovery',
      text: tx('At-least-once delivery can redeliver a message after a crash or timeout. In this simulator, a duplicate means a message is completed and acked twice. How many duplicate completions happen in this run?'),
      options: [
        { id: 'none', text: tx('None: 0 messages are completed twice') },
        { id: 'some', text: tx('Tens to hundreds') },
        { id: 'many', text: tx('More than a thousand') },
      ],
      answer: (run) => {
        const d = duplicates(run);
        return d === 0 ? 'none' : d <= 1000 ? 'some' : 'many';
      },
      measured: (run) => t('{n} duplicate completions ({r} redeliveries)', { n: duplicates(run), r: jobs(run).redelivered ?? 0 }),
      explain: tx('Separate three things here: redelivery, duplicate completion in the simulator, and real-world side effects.\n\nFirst, whenever a worker crashes or a visibility timeout expires, the queue redelivers the message (see Measured above). Second, the simulator only counts a duplicate completion when one delivery already succeeded and acked, and a second delivery also finishes successfully—for instance, if a slow job runs past the visibility timeout and a second worker finishes it too. Here, normal jobs take ~50 ms while the visibility timeout is 2,000 ms (2 s), and the crashed worker fails before acking, so duplicate completions stay at 0.\n\nIn production, however, a worker can write a side effect (such as charging a card) and crash before sending the ack, or a network glitch can drop the ack. The redelivered message would run that side effect again—so set the visibility timeout well above your slowest job and make workers idempotent.'),
      look: { node: 'jobs' },
      explainFor: {
        some: tx('Some messages were processed twice because a few jobs took longer than the visibility timeout. The ticket reappeared while the first worker was still busy.'),
        many: tx('Many messages were processed twice because the visibility timeout is close to the job time, so lots of jobs outlived it.'),
      },
    },
  ],
  challenges: [
    {
      id: 'async-reliable/crash-safe',
      title: tx('Crash-safe and on time'),
      text: tx('One worker machine still crashes for 20 seconds. Keep async p99 under 1000 ms, lose no messages, and process no message twice.\n\nKeep at-least-once delivery and the same max receive count, and use at most 12 worker slots in total.'),
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
      hint: tx('When 1 of 2 machines crashes, you lose half your slots, leaving fewer than the 5 slots uploads need.\n\nUse the N + 1 rule: if normal traffic needs N machines, run N + 1 so the surviving machines still keep up when one dies (or give each machine enough slots). Keep the visibility timeout well above the longest job so no duplicates appear.'),
    },
  ],
  terms: [
    {
      term: tx('At-least-once delivery'),
      plain: tx('A queue guarantee that every message is delivered one or more times until a worker confirms it is done—or until it hits the retry limit and moves to a dead-letter queue (DLQ).'),
      example: tx('A manager who keeps reassigning an unfinished task until someone reports back that it is complete, or moves an unsolvable task to a review box after 3 failed tries.'),
    },
    {
      term: tx('Acknowledgment (ack)'),
      plain: tx('A confirmation signal a worker sends to the queue saying a message is finished and safe to delete.'),
      example: tx('Signing a delivery slip so the courier marks your package as delivered.'),
    },
    {
      term: tx('Visibility timeout'),
      plain: tx('How long a queue hides a message after handing it to a worker; if no ack arrives in time, the message becomes visible again.'),
      example: tx('Hiding a ticket while one person handles it, then putting it back on the board if they disappear.'),
    },
    {
      term: tx('Idempotency'),
      plain: tx('Designing a job so running it twice produces the exact same result as running it once.'),
      example: tx('Pressing an elevator call button twice: the elevator still comes only once.'),
    },
    {
      term: tx('Dead-letter queue (DLQ)'),
      plain: tx('A separate queue where messages go after failing too many times, so they stop blocking healthy work.'),
      example: tx('A separate box at a post office for damaged letters with unreadable addresses.'),
    },
  ],
  learn: [tx('How at-least-once delivery and acks recover messages after a crash'), tx('Why a short visibility timeout causes duplicate processing'), tx('How a dead-letter queue (DLQ) isolates poison messages'), tx('Why surviving a crash needs N + 1 spare capacity')],
  learnAt: [4, 5, 6, 7],
  recap: [tx('A crash costs time, not messages: unacknowledged jobs reappear after the visibility timeout.'), tx('Set the visibility timeout well above the slowest job, and make workers idempotent.'), tx('A dead-letter queue (DLQ) stops poison messages from looping forever.'), tx('Size workers with N + 1 capacity so the surviving machines still keep up during a crash.')],
  steps: [
    { kind: 'read', title: tx('At-least-once delivery'), text: tx('What if a worker crashes halfway through making a thumbnail? If the queue deleted the ticket on pickup, that job would vanish forever.\n\nReliable queues prevent lost work with at-least-once delivery. The queue keeps each ticket until the worker sends an acknowledgment (ack)—a short “done!” reply. While a worker handles a ticket, the queue hides it for a visibility timeout (like hiding a ticket while one person works on it, then putting it back if they disappear).\n\nHere, the visibility timeout is 2000 ms (2 s), and a normal job takes about 50 ms (40 ms of worker processing plus ~10 ms writing back to Postgres).'), key: tx('With at-least-once delivery, a queue deletes a message only after the worker sends an acknowledgment (ack).') },
    { kind: 'read', title: tx('Duplicates, idempotency, and the DLQ'), text: tx('At-least-once delivery has one catch: a message’s work can run twice if a job outlives the visibility timeout, if a worker writes a side effect (like charging a card) and crashes before sending the ack, or if a network glitch drops the ack. That is why workers should be idempotent—safe to run twice with the same result, like pressing an elevator button twice.\n\nWhat if a ticket is broken (like a corrupted image that crashes the worker every time)? We call that a poison message. Here, 1% of messages are poison. After 3 failed tries, a ticket moves to a dead-letter queue (DLQ)—a separate box for broken tickets that keep failing—so someone can inspect it later.') },
    { kind: 'read', title: tx('The worker crash'), text: tx('Now add a real failure. Traffic is 100 uploads a second. Two thumbnail worker machines share the work, with 4 slots each (8 slots total, about 50 ms hold time per job—40 ms of work plus ~10 ms writing to Postgres—so 100 uploads a second keeps about 5 slots busy).\n\nAt second 20, one of the two worker machines crashes for 20 seconds, leaving only 1 machine (4 slots). Guess what happens to wait times, the DLQ, and duplicates, then press Run.') },
    { kind: 'guess', title: tx('Guess: crash, DLQ, duplicates'), questions: ['crash-wait', 'dlq-share', 'duplicates'] },
    { kind: 'run', title: tx('Run the crash'), look: { panel: 'bottom' }, show: ['asyncP99', 'dlq', 'duplicates'] },
    { kind: 'try', title: tx('A short visibility timeout'), text: tx('Set “Visibility timeout” on the Work queue to 100 ms and run again. Are any duplicate completions counted now? Even though the average job takes about 50 ms, why would some jobs outlive 100 ms?'), patch: [{ node: 'jobs', params: { visibilityTimeoutMs: 100 } }], show: ['duplicates', 'asyncP99'] },
    { kind: 'try', title: tx('No DLQ'), text: tx('Set “Visibility timeout” back to 2000 ms (2 s), and set “Max receive count (DLQ)” to 0 (no DLQ—retry forever). Run again.\n\nDoes anything move to the DLQ now? What do the looping poison messages do to the worker and to async p99?'), patch: [{ node: 'jobs', params: { visibilityTimeoutMs: 2000, maxReceives: 0 } }], look: { node: 'thumb' }, show: ['dlq', 'asyncP99', 'busiest'] },
    { kind: 'challenge', title: tx('Crash-safe and on time'), challenges: ['async-reliable/crash-safe'] },
    { kind: 'practice', title: tx('Practice'), items: [{ kind: 'brief', id: 'brief-notify' }, { kind: 'oncall', id: 'db-errors' }] },
  ],
};

export default atLeastOnce;
