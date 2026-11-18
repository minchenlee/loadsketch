// 3.2 Retry budgets, throttling and deadlines (retry-budget, adaptive-throttle, retry-storm).
import { t, tx } from '../../i18n/index.ts';
import { keepRetries, noMoreCapacity, type Lesson } from '../lesson.ts';
import { errorsUnder } from '../lessonKit.ts';
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
      explain: tx('The budget counts first calls and retries over the last 10 s. Once retries reach 10% of the first calls, a failed call is not retried (the edge counts it as “denied”). So during the spike the API gets the 3× spike plus about a tenth more, and the queues do not fill with retries. Only the first second of the spike comes near 4×: the budget saved up in the quiet seconds before it is spent at once.'),
      calc: [tx('First calls in the spike: 3 × the usual'), tx('Retries: at most 10% of the first calls'), tx('At the API: about 3 × 1.1 ≈ 3.3 × the usual')],
      look: { node: 'api' },
      explainFor: {
        x6: tx('The budget is larger than 10%, or not on the edge into the API servers: more retries get through, and they multiply the spike.'),
        x10: tx('No budget limits the retries into the API servers. Look at the edge from the load balancer: that is where the storm grows.'),
      },
    },
    {
      id: 'throttle-recover',
      example: 'adaptive-throttle',
      topic: 'recovery',
      text: tx('Adaptive throttling, K = 2, on every edge. After the spike ends at second 30, how soon does the system recover?'),
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
      explain: tx('Throttling stops the storm, but it remembers: the caller rejects by what it counted over the last 10 s. After the spike, that window is still full of failures, so the caller goes on rejecting good calls until enough successes build up. A retry budget forgets faster: it limits only the retries, never the first calls.'),
      calc: [tx('Reject probability = (requests − K × accepts) ÷ (requests + 1)'), tx('requests and accepts: counted over the last 10 s; K = 2')],
      look: { panel: 'bottom' },
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
      title: tx('One edge is enough'),
      text: tx('On the retry storm, recover within 5 seconds after the spike. Keep every retry, add no machines, and change one edge only.'),
      goals: [recoversWithin(5, tx('Recovered within 5 seconds after the spike (then fewer than 5% fail in every second)')), errorsUnder(0.35, tx('Error rate under 35% for the whole run'))],
      rules: [noMoreCapacity, keepRetries, oneEdgeOnly],
      hint: tx('The storm grows where the overloaded component is called. The API servers are the ones that fill up; which edge retries into them? A retry budget on the edges into the cache or the database changes nothing here.'),
    },
    {
      id: 'adaptive-throttle/let-go',
      example: 'adaptive-throttle',
      title: tx('Let go sooner'),
      text: tx('With adaptive throttling, recover within 20 seconds after the spike. Keep throttling on every edge that has it (K from 1 to 3), and add no machines.'),
      goals: [recoversWithin(20, tx('Recovered within 20 seconds after the spike (then fewer than 5% fail in every second)')), errorsUnder(0.45, tx('Error rate under 45% for the whole run'))],
      rules: [noMoreCapacity, keepThrottle(3)],
      hint: tx('A smaller K rejects earlier, and takes longer to let go: try 1.5 and see. A larger K lets go sooner. A retry budget next to the throttle also helps: fewer retries fail, so fewer failures stay in the window.'),
    },
  ],
  learn: [tx('How a retry budget caps retries at a share of the first calls'), tx('How adaptive throttling rejects at the caller, and why it lets go slowly'), tx('Why a deadline does nothing when every hop gives up sooner'), tx('Where a fix belongs: the edge into the component that fills up')],
  learnAt: [3, 5, 7, 8],
  recap: [tx('A retry budget limits only the retries, so it forgets quickly once the spike is over.'), tx('Adaptive throttling remembers the failures in its window: a smaller K rejects earlier and lets go later.'), tx('A deadline drops work that nobody waits for; it helps only when it is shorter than what the hops already give up after.'), tx('Put the limit on the edge into the component that fills up.')],
  steps: [
    { kind: 'read', title: tx('The storm again'), text: tx('The retry storm from lesson 3.1 again: 600 requests a second, 3× from second 20 to 30, a 150 ms timeout and 3 retries on every hop. Two fixes keep the retries; this lesson tries both.') },
    { kind: 'read', title: tx('Two fixes'), text: tx('A retry budget lets retries be at most 10% of the first calls over the last 10 s. Adaptive throttling (Google SRE, K = 2) makes the caller reject calls itself when too few succeed. Guess how each one does, then run them.'), key: tx('A retry budget limits only the retries; adaptive throttling limits every call.') },
    { kind: 'guess', title: tx('Guess: the budget'), questions: ['budget-amp'] },
    { kind: 'run', title: tx('Run with the budget'), look: { panel: 'bottom' }, show: ['recovery', 'failRate', 'busiest'] },
    { kind: 'guess', title: tx('Guess: the throttle'), questions: ['throttle-recover'] },
    { kind: 'run', title: tx('Run with the throttle'), example: 'adaptive-throttle', look: { panel: 'bottom' }, show: ['recovery', 'failRate', 'busiest'] },
    {
      kind: 'try',
      title: tx('A smaller K'),
      example: 'adaptive-throttle',
      text: tx('Set K to 1.5 on every edge and run again. In the charts: does the caller reject earlier than with K = 2? Does it let go after the spike?'),
      patch: [
        { edge: 'users->lb', set: { throttleK: 1.5 } },
        { edge: 'lb->api', set: { throttleK: 1.5 } },
        { edge: 'api->cache', set: { throttleK: 1.5 } },
        { edge: 'api->db', set: { throttleK: 1.5 } },
      ],
      look: { panel: 'bottom' },
      show: ['recovery', 'failRate'],
    },
    {
      kind: 'try',
      title: tx('Deadlines'),
      example: 'retry-storm',
      text: tx('Deadlines: on the retry storm, set the users’ “Deadline propagation” to “Pass down” (their deadline is 1 s) and run again. Does anything change? Compare the 1 s deadline with the 150 ms timeout of each hop.'),
      patch: [{ node: 'users', params: { deadline: 'propagate' } }],
    },
    { kind: 'challenge', title: tx('One edge is enough'), challenges: ['retry-budget/one-edge'] },
    { kind: 'challenge', title: tx('Let go sooner'), challenges: ['adaptive-throttle/let-go'] },
    { kind: 'practice', title: tx('Practice'), items: [{ kind: 'constraint', id: 'retry-budget' }] },
  ],
};

export default retryBudgets;
