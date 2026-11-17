// Lessons in the side panel of /app/, by example: the retry storm, and course lesson 2.1. Course
// lessons live in src/learn/course/ (COURSE in course.ts); only the ones listed here open on the
// Learn tab of their example (three-tier, the example most e2e tests open, stays without one).
import { t, tx } from '../i18n/index.ts';
import { keepRetries, noMoreCapacity, type Goal, type Lesson } from './lesson.ts';
import { peakAmp, recoveryS, spikeEnd, type RunData } from './metrics.ts';
import { COURSE_BY_ID } from './course.ts';

const ms = (x: number) => `${Math.round(x)} ms`;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

const recovery = (run: RunData) => recoveryS(run, spikeEnd(run.scenario));
const recoveryText = (run: RunData) => {
  const s = recovery(run);
  if (s === Infinity) return t('No recovery before the end');
  if (s === 0) return t('No failures left when the spike ended');
  return t('Recovered {s} seconds after the spike', { s: Math.round(s) });
};

const failUnder10: Goal = {
  text: tx('Failure rate of the whole run below 10%'),
  check: (run) => ({ ok: run.result.summary.errorRate < 0.1, value: pct(run.result.summary.errorRate) }),
};

const retryStorm: Lesson = {
  example: 'retry-storm',
  intro: tx('A three-tier site with a 150 ms timeout and 3 retries on every hop. From second 20 to 30, traffic is 3 times higher. Guess what happens, then press Run.'),
  scenario: 'retry-storm',
  questions: [
    {
      id: 'recover',
      topic: 'recovery',
      text: tx('From second 20 to 30, traffic is 3 times higher. After traffic goes back to normal at second 30, what happens?'),
      options: [
        { id: 'fast', text: tx('It recovers within a few seconds') },
        { id: 'slow', text: tx('It recovers slowly, in 10 seconds or more') },
        { id: 'never', text: tx('It stays broken') },
      ],
      answer: (run) => {
        const s = recovery(run);
        return s <= 5 ? 'fast' : s === Infinity ? 'never' : 'slow';
      },
      measured: recoveryText,
      explain: tx('During the spike, calls that time out are retried, so each request is sent up to 4 times. After the spike, the queues are still full of retries. New requests also wait too long, time out and are retried: the system stays in the bad state.'),
      explainFor: {
        fast: tx('This design did not let retries pile up during the spike (it limited retries or rejected fast). The queues did not fill up, so it recovered as soon as traffic went back to normal.'),
        slow: tx('Retries piled up during the spike, but not enough to keep the system stuck: it recovered after the queues slowly drained.'),
      },
    },
    {
      id: 'amp',
      topic: 'retry',
      text: tx('During the spike, at most how many times the usual requests per second do the API servers receive?'),
      options: [
        { id: 'x3', text: tx('About 3 times, the same as user traffic') },
        { id: 'x6', text: tx('About 6 times') },
        { id: 'x10', text: tx('More than 10 times') },
      ],
      answer: (run) => {
        const x = peakAmp(run, 'api', 20, 30);
        return x < 4.5 ? 'x3' : x < 9 ? 'x6' : 'x10';
      },
      measured: (run) => t('At most {x} times the usual', { x: peakAmp(run, 'api', 20, 30).toFixed(1) }),
      explain: tx('A call from the load balancer to the API is retried 3 times when it fails (a timeout or a rejection). When the API is full, most calls fail, so the API receives several times the user traffic.'),
      explainFor: { x3: tx('Retries did not multiply the traffic: the API receives about as many requests as the users send.') },
    },
  ],
  challenges: [
    {
      id: 'retry-storm/recover',
      title: tx('Recover on its own'),
      text: tx('Recover within 5 seconds after the spike, with no more machines.'),
      goals: [{ text: tx('Recovered within 5 seconds after the spike (then fewer than 5% fail in every second)'), check: (run) => ({ ok: recovery(run) <= 5, value: recoveryText(run) }) }],
      rules: [noMoreCapacity],
      hint: tx('Look at the retry settings on the connections. A retry budget limits retries to a share of the calls, so retries cannot snowball during the spike.'),
    },
    {
      id: 'retry-storm/fail-less',
      title: tx('Fail less'),
      text: tx('Keep the failure rate of the whole run below 10%, with no more machines.'),
      goals: [failUnder10],
      rules: [noMoreCapacity],
      hint: tx('During the spike the API servers do not have enough capacity, so some requests must fail. Rejecting them at once is better than letting them wait 150 ms and time out: try a smaller queue limit on the API servers, or a CoDel queue.'),
    },
    {
      id: 'retry-storm/keep-retries',
      title: tx('Keep the retries'),
      text: tx('Every connection that had retries still retries at least once (a call into a cache does not count), the failure rate of the whole run is below 10%, and p99 of successful requests is below 130 ms.'),
      goals: [
        failUnder10,
        { text: tx('p99 of successful requests below 130 ms'), check: (run) => ({ ok: run.result.summary.latencyMs.p99 < 130, value: ms(run.result.summary.latencyMs.p99) }) },
      ],
      rules: [noMoreCapacity, keepRetries],
      hint: tx('With a smaller queue limit, the rejected calls are retried, and that multiplies the traffic again. Add a retry budget to limit the total of retries.'),
    },
  ],
};

const cacheHitRatio = COURSE_BY_ID['2.1'];

export const LESSONS: Record<string, Lesson> = { [retryStorm.example]: retryStorm, [cacheHitRatio.example]: cacheHitRatio };
