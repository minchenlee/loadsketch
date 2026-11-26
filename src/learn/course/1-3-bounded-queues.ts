// 1.3 Bounded queues, timeouts and CoDel (lifo-codel / overload): an unbounded queue is unbounded
// delay; a bounded one trades delay for fast rejections; LIFO + CoDel keeps the served ones fresh.
// The engine has no backpressure (upstream slowing down): rejection stands in for it.
import { t, tx } from '../../i18n/index.ts';
import { noMoreCapacity, type Goal, type Lesson } from '../lesson.ts';
import type { RunData } from '../metrics.ts';
import { errorsUnder, failShareOf, p99Under, paramOf, pct } from '../lessonKit.ts';
import { KINDS } from '../../schema/kinds.ts';

const INTRO = tx(
  'When traffic exceeds a site’s ceiling, some requests are guaranteed to fail. Without adding more servers, you cannot save those extra requests—so the real question is how the site fails. Every user has a timeout: a patience limit after which they give up and leave. Here, users give up after 1 second (1,000 ms).\n\nThis site has 2 API servers with 16 slots each (32 slots total). Each request holds a slot for about 24 ms (20 ms of work plus a database query), so together they finish about 1,300 requests per second (32 × 1,000 ÷ 24). From second 20 to second 60, users send 2,000 requests/s—roughly 700/s more than the servers can handle.\n\nNormally, a waiting line serves requests in arrival order (First-In, First-Out, or FIFO). Capping that line’s length creates a bounded queue: once full, new requests are rejected at arrival before they ever enter the queue. Turning away excess work early to protect the rest is called load shedding.\n\nIn this starting design, the queue cap is huge (5,000), so requests do enter the queue instead of being rejected at the door. However, the servers turn on two smart overload rules once the queue stays continuously non-empty for 100 ms: they switch to serving the newest request first (adaptive LIFO, Last-In First-Out) so fresh users get answered before their 1-second timeout; and when a slot pulls a request out of the queue, CoDel (Controlled Delay) checks how long it has waited and drops it early—without wasting a slot to process it—if its wait exceeds the target (100 ms at first, tightening to 5 ms after 100 ms of sustained backlog). Guess how many requests fail and how they fail, then press Run.',
);

/** Failed requests that were turned away at once (queue full, CoDel) vs ones that waited for the timeout. */
const failKinds = (run: RunData) => {
  const f = run.result.summary.fail;
  const fast = (f.queue_full ?? 0) + (f.codel ?? 0);
  const slow = f.timeout ?? 0;
  return { fast, slow, all: Object.values(f).reduce((a, b) => a + b, 0) };
};

const fifoPlain: Goal = {
  text: tx('Queue order FIFO and CoDel off'),
  check: (run) => {
    const order = paramOf(run.design, 'api', 'queueOrder');
    const codel = paramOf(run.design, 'api', 'codelTargetMs');
    const kind = run.design.nodes.find((n) => n.id === 'api')?.kind;
    const spec = kind ? KINDS[kind]?.params.queueOrder : undefined;
    const label = spec && 'options' in spec ? spec.options?.find((o) => o.value === order)?.label : undefined;
    return { ok: order === 'fifo' && codel === 0, value: `${label ? t(label) : String(order)}, ${String(codel)} ms` };
  },
};

const lesson: Lesson = {
  id: '1.3',
  title: tx('Bounded queues, timeouts and CoDel'),
  unit: 1,
  order: 3,
  minutes: 25,
  wave: 1,
  learn: [
    tx('See why traffic above the ceiling must fail one way or another'),
    tx('Watch a long FIFO queue push every request past the user’s timeout'),
    tx('Use a bounded queue to trade long waits for fast rejections'),
    tx('Keep served requests fresh with LIFO and CoDel load shedding'),
  ],
  learnAt: [2, 3, 4, 5],
  recap: [
    tx('Past capacity, excess requests must fail; your queue rules decide who fails and how long they wait.'),
    tx('A huge FIFO queue makes even served requests wait past the user’s timeout, wasting server work.'),
    tx('A bounded queue rejects excess requests on arrival, while CoDel drops stale queued requests early before wasting a slot: both cost users far less than a slow timeout.'),
  ],
  terms: [
    {
      term: tx('Bounded queue'),
      plain: tx('A waiting line with a strict maximum length that rejects new arrivals at the door once full.'),
      example: tx('A restaurant with 10 waiting chairs that tells new guests “we’re full” instead of creating a 2-hour line.'),
    },
    {
      term: tx('Timeout'),
      plain: tx('The longest time a user or caller will wait before giving up and treating the request as failed.'),
      example: tx('Hanging up the phone after being left on hold for 5 minutes.'),
    },
    {
      term: tx('LIFO'),
      plain: tx('Last-In, First-Out—serving the newest request in the queue first when overloaded so fresh users get answers before timing out.'),
      example: tx('Answering the newest live customer call first instead of calling back someone who already hung up.'),
    },
    {
      term: tx('CoDel'),
      plain: tx('Controlled Delay—a rule checked when pulling a request from the queue that drops stale requests early (using the target wait once the queue stays non-empty for 100 ms) so servers do not waste slots on them.'),
      example: tx('Throwing out a 1-hour-old cold food ticket when pulling the next order so the kitchen cooks fresh orders for people still in the room.'),
    },
    {
      term: tx('Load shedding'),
      plain: tx('Deliberately rejecting excess requests early during overload so the remaining requests succeed quickly.'),
      example: tx('A theme park pausing ticket sales at the gate so guests inside still have reasonable wait times.'),
    },
  ],
  example: 'lifo-codel',
  scenario: 'overload',
  intro: INTRO,
  questions: [
    {
      id: 'overload-fail',
      topic: 'capacity',
      text: tx('From second 20 to 60, users send 2,000 requests/s while the servers can finish about 1,300/s. With adaptive LIFO and CoDel turned on, what share of all requests fail?'),
      options: [
        { id: 'few', text: tx('Under 10%') },
        { id: 'excess', text: tx('About the excess above capacity (10% to 40%)') },
        { id: 'most', text: tx('Most of them (over 40%)') },
      ],
      answer: (run) => {
        const e = failShareOf(run);
        return e < 0.1 ? 'few' : e <= 0.4 ? 'excess' : 'most';
      },
      measured: (run) => t('{e} of requests failed', { e: pct(failShareOf(run)) }),
      calc: [
        tx('Hold time per request ≈ 24 ms (20 ms own processing + ~4 ms waiting on Postgres)'),
        tx('2 servers × 16 slots × (1000 ÷ 24 ms) ≈ 1300 requests/s max'),
        tx('2000/s arriving − 1300/s served ≈ 700/s that must fail'),
      ],
      explain: tx(
        'Only the excess above capacity fails—not the whole site. Because adaptive LIFO picks the newest requests during overload, the servers spend their slots on users who are still waiting.\n\nAt the same time, CoDel drops requests that waited too long so no server work is wasted on users who already gave up.',
      ),
      explainFor: {
        few: tx('Few fail: this design has enough capacity to absorb the overload.'),
        most: tx('Most fail: the servers stay 100% busy, but they are working on requests whose users already timed out. A long FIFO queue pushes nearly every request past the 1-second timeout, so even finished work counts as failed.'),
      },
    },
    {
      id: 'fail-how',
      topic: 'queueing',
      text: tx('Of the requests that fail, how do most of them fail?'),
      options: [
        { id: 'fast', text: tx('Most are shed early (rejected on arrival or dropped from the queue before timing out)') },
        { id: 'slow', text: tx('Most wait until the 1-second timeout') },
      ],
      answer: (run) => {
        const k = failKinds(run);
        return k.fast >= k.slow ? 'fast' : 'slow';
      },
      measured: (run) => {
        const k = failKinds(run);
        return t('{fast} shed early (queue full or CoDel), {slow} timed out', { fast: k.fast, slow: k.slow });
      },
      explain: tx(
        'Requests can fail in three ways here: rejected on arrival when the queue is full, entered into the queue and dropped early by CoDel when pulled for a slot, or waiting all the way to the 1-second client timeout.\n\nWith Max queue at 5,000, arrivals enter the queue instead of being rejected at the door. Once the queue stays continuously non-empty for 100 ms, CoDel tightens its threshold to 5 ms and drops stale queued requests as soon as a slot pulls them—much earlier than the 1-second timeout, and without wasting server slots on them.',
      ),
      explainFor: {
        slow: tx('Most fail by timeout: the queue is so long that requests sit for a full second until the user gives up. The user waits for nothing, and the server may even waste work finishing a request nobody wants anymore.'),
      },
    },
  ],
  challenges: [
    {
      id: 'queues/bounded-fifo',
      title: tx('A short FIFO queue'),
      text: tx('Keep plain FIFO order with CoDel off, and change only “Max queue” on the API servers. Through the overload, keep the error rate under 30% and p99 latency under 250 ms.'),
      goals: [fifoPlain, errorsUnder(0.3, tx('Error rate under 30% for the whole run')), p99Under(250, tx('p99 of successful requests under 250 ms'))],
      rules: [noMoreCapacity],
      hint: tx(
        'Every request waiting in line must wait for the requests ahead of it. At 1,300 requests/s (1.3 per ms), a line of 100 requests adds roughly 100 ÷ 1.3 ≈ 80 ms of wait time.\n\nA smaller “Max queue” sheds excess requests right away so the ones allowed in finish fast. Find the largest queue cap that keeps p99 under 250 ms.',
      ),
    },
  ],
  steps: [
    { kind: 'read', title: tx('An overload'), text: INTRO, key: tx('When traffic exceeds capacity, the excess must fail—your queue rules decide how.') },
    { kind: 'guess', title: tx('How many fail, and how'), questions: ['overload-fail', 'fail-how'] },
    { kind: 'run', title: tx('Run the overload'), look: { panel: 'bottom' }, show: ['failRate', 'rejected', 'timedOut', 'p99'] },
    { kind: 'try', title: tx('A plain FIFO queue'), text: tx('Turn off both protections: set “Queue order” to First in, first out (FIFO) and “CoDel queue target” to 0, then run again.\n\nThe servers stay just as busy as before—how many requests fail now, and how long do the surviving ones wait?'), patch: [{ node: 'api', params: { queueOrder: 'fifo', codelTargetMs: 0 } }], look: { panel: 'bottom' }, show: ['failRate', 'rejected', 'timedOut', 'p99'] },
    { kind: 'try', title: tx('A shorter queue'), text: tx('Keep plain FIFO with CoDel off, and turn the line into a bounded queue by setting “Max queue” to 10, then 100, then 300 (press Run after each change).\n\nAs the queue cap grows, what happens to the error rate and to p99 latency?'), show: ['failRate', 'rejected', 'timedOut', 'p99'] },
    { kind: 'try', title: tx('A looser CoDel'), text: tx('This restores adaptive LIFO and Max queue 5,000, but loosens “CoDel queue target” from 5 ms to 50 ms.\n\nRun it: are most failed requests still dropped early by CoDel, or do more wait until the 1-second timeout?'), patch: [{ node: 'api', params: { queueOrder: 'adaptive_lifo', queueLimit: 5000, codelTargetMs: 50 } }], look: { panel: 'bottom' }, show: ['failRate', 'rejected', 'timedOut', 'p99'] },
    { kind: 'challenge', title: tx('A short FIFO queue'), challenges: ['queues/bounded-fifo'] },
  ],
};

export default lesson;
