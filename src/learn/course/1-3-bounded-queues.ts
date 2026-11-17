// 1.3 Bounded queues, timeouts and CoDel (lifo-codel / overload): an unbounded queue is unbounded
// delay; a bounded one trades delay for fast rejections; LIFO + CoDel keeps the served ones fresh.
// The engine has no backpressure (upstream slowing down): rejection stands in for it.
import { t, tx } from '../../i18n/index.ts';
import { noMoreCapacity, type Goal, type Lesson } from '../lesson.ts';
import type { RunData } from '../metrics.ts';
import { errorsUnder, p99Under, paramOf, pct } from '../lessonKit.ts';

const INTRO = tx('Two API servers, 16 requests at a time each. A request holds its slot about 24 ms (20 ms of work plus the database call), so together they serve about 1300 requests a second. From second 20 to 60 users send 2000 a second, more than the servers can do, and each user gives up after 1 s. The queue in front of the servers holds up to 5000 requests. Guess how many fail and how, then press Run.');

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
    return { ok: order === 'fifo' && codel === 0, value: `${String(order)}, ${String(codel)} ms` };
  },
};

const lesson: Lesson = {
  id: '1.3',
  title: tx('Bounded queues, timeouts and CoDel'),
  unit: 1,
  order: 3,
  minutes: 25,
  wave: 1,
  example: 'lifo-codel',
  scenario: 'overload',
  intro: INTRO,
  questions: [
    {
      id: 'overload-fail',
      topic: 'capacity',
      text: tx('From second 20, users ask for 2000 a second and the servers can do about 1300. What share of all requests fail?'),
      options: [
        { id: 'few', text: tx('Under 10%') },
        { id: 'excess', text: tx('About the part above capacity (10% to 40%)') },
        { id: 'most', text: tx('Most of them (over 40%)') },
      ],
      answer: (run) => {
        const e = run.result.summary.errorRate;
        return e < 0.1 ? 'few' : e <= 0.4 ? 'excess' : 'most';
      },
      measured: (run) => t('{e} of requests failed', { e: pct(run.result.summary.errorRate) }),
      explain: tx('About the part above capacity fails, and no more: about 700 of every 2000 a second during the overload. The servers stay busy and work only on requests whose users are still waiting, because this design serves the newest request first when it is congested (adaptive LIFO) and drops a request that waited too long (CoDel).'),
      explainFor: {
        few: tx('Few fail: this design has room for the overload.'),
        most: tx('Most fail: the servers are busy, but with requests whose users already gave up. A long first-in-first-out queue makes every request wait longer than the 1 s timeout, so even the served ones count as failed.'),
      },
    },
    {
      id: 'fail-how',
      topic: 'queueing',
      text: tx('The requests that fail: how do they fail?'),
      options: [
        { id: 'fast', text: tx('Most are turned away at once') },
        { id: 'slow', text: tx('Most wait until the 1 s timeout') },
      ],
      answer: (run) => {
        const k = failKinds(run);
        return k.fast >= k.slow ? 'fast' : 'slow';
      },
      measured: (run) => {
        const k = failKinds(run);
        return t('{fast} turned away at once, {slow} timed out', { fast: k.fast, slow: k.slow });
      },
      explain: tx('CoDel drops a request whose wait passed its target (5 ms) when its turn comes, so a failure costs the user milliseconds, not a whole second. Turning work away early is the only way this engine slows the callers down: it has no backpressure, where the callers themselves send less.'),
      explainFor: {
        slow: tx('Most fail by timeout: the queue is long enough that requests wait the full second before the user gives up. The user waits and still gets nothing, and the server may still do the work for nobody.'),
      },
    },
  ],
  challenges: [
    {
      id: 'queues/bounded-fifo',
      title: tx('A short FIFO queue'),
      text: tx('Use a plain FIFO queue with CoDel off, and change only the queue limit: keep failures under 30% and p99 under 250 ms through the overload.'),
      goals: [fifoPlain, errorsUnder(0.3, tx('Error rate under 30% for the whole run')), p99Under(250, tx('p99 of successful requests under 250 ms'))],
      rules: [noMoreCapacity],
      hint: tx('Every request in the queue waits for the ones ahead of it: with 2 × 16 slots at about 24 ms each, 100 in the queue is about 80 ms of waiting. A limit turns the extra requests away at once instead. Find the largest limit that keeps p99 under 250 ms.'),
    },
  ],
  steps: [
    { kind: 'read', text: INTRO },
    { kind: 'guess', questions: ['overload-fail', 'fail-how'] },
    { kind: 'run' },
    { kind: 'try', text: tx('Set "Queue order" to FIFO and "CoDel queue target" to 0, and run again: the queue grows to its 5000 limit, requests wait seconds, and most fail by timeout although the servers are just as busy.'), patch: [{ node: 'api', params: { queueOrder: 'fifo', codelTargetMs: 0 } }] },
    { kind: 'try', text: tx('Keep FIFO without CoDel, and set the queue limit to 10, then 100, then 300: the failure rate barely changes (the part above capacity), but the wait, and p99, grows with the limit.') },
    { kind: 'try', text: tx('Put CoDel back with a target of 50 ms instead of 5: requests may wait longer before they are dropped, and more of them time out instead.'), patch: [{ node: 'api', params: { codelTargetMs: 50 } }] },
    { kind: 'challenge', challenges: ['queues/bounded-fifo'] },
  ],
};

export default lesson;
