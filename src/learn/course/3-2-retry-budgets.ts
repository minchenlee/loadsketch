// 3.2 Retry budgets, throttling and deadlines (retry-budget, adaptive-throttle, retry-storm).
import { t, tx } from '../../i18n/index.ts';
import { keepRetries, noMoreCapacity, type Lesson } from '../lesson.ts';
import { keepThrottle, oneEdgeOnly, recovery, recoveryText, recoversWithin } from '../lessonKit2.ts';
import { peakAmp } from '../metrics.ts';

const retryBudgets: Lesson = {
  id: '3.2',
  title: tx('Retry budgets, throttling and deadlines'),
  unit: 3,
  order: 2,
  minutes: 25,
  wave: 1,
  example: 'retry-budget',
  extraExamples: ['adaptive-throttle', 'retry-storm'],
  intro: tx('The retry storm from lesson 3.1 again: 600 requests a second, 3× from second 20 to 30, a 150 ms timeout and 3 retries on every hop. Two fixes keep the retries. A retry budget lets retries be at most 10% of the first calls over the last 10 s. Adaptive throttling (Google SRE, K = 2) makes the caller reject calls itself when too few succeed. Guess how each one does, then run them.'),
  scenario: 'retry-storm',
  questions: [
    {
      id: 'budget-amp',
      topic: 'retry',
      text: tx('With a 10% retry budget: during the spike, the API servers receive at most how many times their usual requests a second? (Without it, more than 10 times.)'),
      options: [
        { id: 'x3', text: tx('About 3 to 4 times: the spike, plus a few retries') },
        { id: 'x6', text: tx('About 6 times') },
        { id: 'x10', text: tx('More than 10 times, as without a budget') },
      ],
      answer: (run) => {
        const x = peakAmp(run, 'api', 20, 30);
        return x < 4.5 ? 'x3' : x < 9 ? 'x6' : 'x10';
      },
      measured: (run) => t('At most {x} times the usual', { x: peakAmp(run, 'api', 20, 30).toFixed(1) }),
      explain: tx('The budget counts first calls and retries over the last 10 s. Once retries reach 10% of the first calls, a failed call is not retried (the connection counts it as “denied”). So during the spike the API gets the 3× spike plus about a tenth more, and the queues do not fill with retries. Only the first second of the spike comes near 4×: the budget saved up in the quiet seconds before it is spent at once.'),
      explainFor: {
        x6: tx('The budget is larger than 10%, or not on the connection into the API servers: more retries get through, and they multiply the spike.'),
        x10: tx('No budget limits the retries into the API servers. Look at the connection from the load balancer: that is where the storm grows.'),
      },
    },
    {
      id: 'throttle-recover',
      example: 'adaptive-throttle',
      topic: 'recovery',
      text: tx('Adaptive throttling, K = 2, on every connection. After the spike ends at second 30, how soon does the system recover?'),
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
      explain: tx('Throttling stops the storm, but it remembers: the caller rejects with probability (requests − K × accepts) ÷ (requests + 1) over the last 10 s. After the spike, that window is still full of failures, so the caller goes on rejecting good calls until enough successes build up. A retry budget forgets faster: it limits only the retries, never the first calls.'),
      explainFor: {
        fast: tx('This design recovered at once: the throttle had little to remember (a larger K, or few failures in the window).'),
        never: tx('The throttle never let go. With a small K, the caller rejects so many calls that too few successes come back to bring the rejection rate down.'),
      },
    },
  ],
  challenges: [
    {
      id: 'retry-budget/one-edge',
      example: 'retry-storm',
      title: tx('One connection is enough'),
      text: tx('On the retry storm, recover within 5 seconds after the spike. Keep every retry, add no machines, and change one connection only.'),
      goals: [recoversWithin(5, tx('Recovered within 5 seconds after the spike (then fewer than 5% fail in every second)'))],
      rules: [noMoreCapacity, keepRetries, oneEdgeOnly],
      hint: tx('The storm grows where the overloaded component is called. The API servers are the ones that fill up; which connection retries into them? A retry budget on the connections into the cache or the database changes nothing here.'),
    },
    {
      id: 'adaptive-throttle/let-go',
      example: 'adaptive-throttle',
      title: tx('Let go sooner'),
      text: tx('With adaptive throttling, recover within 20 seconds after the spike. Keep throttling on every connection that has it (K from 1 to 3), and add no machines.'),
      goals: [recoversWithin(20, tx('Recovered within 20 seconds after the spike (then fewer than 5% fail in every second)'))],
      rules: [noMoreCapacity, keepThrottle(3)],
      hint: tx('A smaller K rejects earlier, and takes longer to let go: try 1.5 and see. A larger K lets go sooner. A retry budget next to the throttle also helps: fewer retries fail, so fewer failures stay in the window.'),
    },
  ],
  steps: [
    { kind: 'read', text: tx('The retry storm from lesson 3.1 again: 600 requests a second, 3× from second 20 to 30, a 150 ms timeout and 3 retries on every hop. Two fixes keep the retries. A retry budget lets retries be at most 10% of the first calls over the last 10 s. Adaptive throttling (Google SRE, K = 2) makes the caller reject calls itself when too few succeed. Guess how each one does, then run them.') },
    { kind: 'guess', questions: ['budget-amp'] },
    { kind: 'run' },
    { kind: 'guess', questions: ['throttle-recover'] },
    { kind: 'run', example: 'adaptive-throttle' },
    {
      kind: 'try',
      example: 'adaptive-throttle',
      text: tx('Set K to 1.5 on every connection and run again. The caller rejects earlier, and then it never lets go: its own rejections leave too few successes in the window.'),
      patch: [
        { edge: 'users->lb', set: { throttleK: 1.5 } },
        { edge: 'lb->api', set: { throttleK: 1.5 } },
        { edge: 'api->cache', set: { throttleK: 1.5 } },
        { edge: 'api->db', set: { throttleK: 1.5 } },
      ],
    },
    {
      kind: 'try',
      example: 'retry-storm',
      text: tx('Deadlines: on the retry storm, set the users’ “Deadline propagation” to “Pass down” (their deadline is 1 s) and run again. Nothing changes. A deadline drops work that nobody waits for any more, but here every hop gives up after 150 ms, long before the 1 s deadline.'),
      patch: [{ node: 'users', params: { deadline: 'propagate' } }],
    },
    { kind: 'challenge', challenges: ['retry-budget/one-edge'] },
    { kind: 'challenge', challenges: ['adaptive-throttle/let-go'] },
    { kind: 'practice', items: [{ kind: 'constraint', id: 'retry-budget' }] },
  ],
};

export default retryBudgets;
