// 3.2 Retry budgets, throttling and deadlines (retry-budget, adaptive-throttle, retry-storm).
import { t, tx } from '../../i18n/index.ts';
import { keepRetries, noMoreCapacity, type Lesson } from '../lesson.ts';
import { errorsUnder } from '../lessonKit.ts';
import { keepThrottle, oneEdgeOnly, recovery, recoveryText, recoversWithin } from '../lessonKit2.ts';
import { peakAmp } from '../metrics.ts';

const retryBudgets: Lesson = {
  id: '3.2',
  title: tx('Retry budgets, adaptive throttling, and deadlines'),
  unit: 3,
  order: 2,
  minutes: 25,
  wave: 1,
  example: 'retry-budget',
  extraExamples: ['adaptive-throttle', 'retry-storm'],
  intro: tx('Turning retries off stops a retry storm, but then even a single random glitch fails for the user. We want to keep retries for normal glitches without letting them flood an overloaded server.\n\nThis lesson compares two safety limits on the same 3× traffic spike from lesson 3.1 (600 requests a second, tripling from second 20 to 30, 150 ms timeout, 3 retries per connection).\n\nA retry budget puts a cap on extra retries—here, at most 10% of the first-try calls over the last 10 seconds. Adaptive throttling goes further: the caller tracks how many calls succeeded in the last 10 seconds, and starts rejecting calls itself before sending them when too few succeed (here with K = 2). Guess how each one behaves, then run them.'),
  scenario: 'retry-storm',
  terms: [
    {
      term: tx('Retry budget'),
      plain: tx('A cap that limits retries to a small percentage of normal first-try calls over a recent time window.'),
      example: tx('Allowing at most 10 redials for every 100 normal phone calls in the last 10 seconds.'),
    },
    {
      term: tx('Adaptive throttling'),
      plain: tx('When a caller tracks recent successes over a rolling window and rejects some outgoing calls itself once too many fail.'),
      example: tx('A receptionist stopping new transfers for a moment after noticing most calls to an office are going unanswered.'),
    },
    {
      term: tx('Request deadline'),
      plain: tx('The total time left before the user gives up, passed down across servers so nobody wastes work on an expired request.'),
      example: tx('A delivery driver checking the remaining delivery time before starting the next stop.'),
    },
  ],
  questions: [
    {
      id: 'budget-amp',
      topic: 'retry',
      text: tx('With a 10% retry budget on every connection: during the 3× spike, the API servers receive at most how many times their usual traffic? (Without a budget, they received more than 10 times.)'),
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
      explain: tx('The retry budget counts first-try calls and retries over the last 10 seconds. Once retries reach 10% of first-try calls, the connection stops retrying and fails fast instead.\n\nDuring the spike, the API gets the 3× user spike plus only about 10% more in retries, so queues stay manageable. Only the very first second of the spike climbs near 4× because the budget saved up during the quiet seconds gets spent right away.'),
      calc: [tx('First-try calls in the spike: 3 × usual traffic'), tx('Allowed retries: at most 10% of first-try calls'), tx('Peak at API: about 3 × 1.1 ≈ 3.3 × usual traffic')],
      look: { node: 'api' },
      explainFor: {
        x6: tx('The budget is larger than 10%, or not set on the connection into the API servers. More retries get through and multiply the spike.'),
        x10: tx('No budget limits retries into the API servers. Check the connection from the load balancer to the API: that is where the storm grows.'),
      },
    },
    {
      id: 'throttle-recover',
      example: 'adaptive-throttle',
      topic: 'recovery',
      text: tx('Now every connection uses adaptive throttling (K = 2), deciding whether to reject calls based on failures counted over the last 10 seconds. After the spike ends at second 30, how soon does the system recover?'),
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
      explain: tx('Adaptive throttling stops the retry storm, but it has a memory. The caller rejects calls based on all attempts and successes over the last 10 seconds.\n\nAfter the spike ends, that 10-second window is still full of failures. The caller keeps rejecting good calls until enough new successes fill the window. A retry budget forgets faster because it only limits retries and never blocks first-try calls.'),
      calc: [tx('Reject probability = (requests − K × accepts) ÷ (requests + 1)'), tx('requests = total calls tried; accepts = calls that succeeded (last 10 s, K = 2)')],
      look: { panel: 'bottom' },
      explainFor: {
        fast: tx('This design recovered right away because the caller had few failures left in its 10-second window (or used a larger K).'),
        never: tx('Adaptive throttling never let go. With a small K, the caller rejects so many calls that too few successes come back to lower the rejection rate.'),
      },
    },
  ],
  challenges: [
    {
      id: 'retry-budget/one-edge',
      example: 'retry-storm',
      title: tx('One connection is enough'),
      text: tx('On the retry storm design, recover within 5 seconds after the spike. Keep every retry, add no machines, and change only one connection.'),
      goals: [recoversWithin(5, tx('Recovered within 5 seconds after the spike (then fewer than 5% fail in every second)')), errorsUnder(0.35, tx('Error rate under 35% for the whole run'))],
      rules: [noMoreCapacity, keepRetries, oneEdgeOnly],
      hint: tx('A retry storm grows on the connection feeding the overloaded component. Here, the API servers fill up first.\n\nFind the connection that retries into the API servers and add a "Retry budget" there. Adding a budget into the cache or database will not stop the storm.'),
    },
    {
      id: 'adaptive-throttle/let-go',
      example: 'adaptive-throttle',
      title: tx('Let go sooner'),
      text: tx('With adaptive throttling enabled, recover within 20 seconds after the spike. Keep adaptive throttling on every connection that has it (K from 1 to 3), and add no machines.'),
      goals: [recoversWithin(20, tx('Recovered within 20 seconds after the spike (then fewer than 5% fail in every second)')), errorsUnder(0.45, tx('Error rate under 45% for the whole run'))],
      rules: [noMoreCapacity, keepThrottle(3)],
      hint: tx('In the formula, K multiplies recent successes. A smaller K rejects earlier and holds on longer after a spike. A larger K needs fewer successes to stop rejecting, so it lets go sooner.\n\nTry raising "Adaptive throttling K" (up to 3). Adding a "Retry budget" alongside adaptive throttling also helps: fewer failed retries enter the 10-second window.'),
    },
  ],
  learn: [
    tx('How a retry budget caps retries at a small share of first-try calls'),
    tx('How adaptive throttling rejects calls at the caller, and why it lets go slowly'),
    tx('How request deadlines stop wasted work, and when they do nothing'),
    tx('Where a fix belongs: the connection into the overloaded component'),
  ],
  learnAt: [3, 5, 7, 8],
  recap: [
    tx('A retry budget limits only retries, never first-try calls, so it recovers quickly once a spike ends.'),
    tx('Adaptive throttling remembers recent failures in its 10-second window: a smaller K rejects earlier and lets go later.'),
    tx('Passing a request deadline down drops work nobody is waiting for, but only when the deadline is shorter than each step’s timeout.'),
    tx('Put the limit on the connection feeding the component that fills up.'),
  ],
  steps: [
    {
      kind: 'read',
      title: tx('Why keep retries?'),
      text: tx('Turning retries off stopped the storm in lesson 3.1, but it leaves users exposed to brief random glitches. We want retries to stay on during normal traffic, yet stay safe during overload.\n\nWe start with the same site and spike from lesson 3.1: 600 requests a second, tripling from second 20 to 30, with a 150 ms timeout and 3 retries on every connection. This lesson compares two ways to keep retries safe.'),
      key: tx('Good overload protection keeps retries for rare glitches without letting them flood a busy server.'),
    },
    {
      kind: 'read',
      title: tx('Two safety limits'),
      text: tx('First, a retry budget caps retries at a share of normal calls—here, at most 10% of first-try calls over the last 10 seconds. It is like allowing at most 10 redials for every 100 normal phone calls.\n\nSecond, adaptive throttling works at the caller before a call is even sent. The caller counts calls sent and calls that succeeded over the last 10 seconds. When successes drop below a share controlled by K (here K = 2, meaning it starts rejecting when fewer than half succeed), the caller rejects some new calls locally.\n\nGuess how each limit performs, then run both.'),
      key: tx('A retry budget limits only the retries; adaptive throttling limits every call.'),
    },
    { kind: 'guess', title: tx('Guess: the budget'), questions: ['budget-amp'] },
    { kind: 'run', title: tx('Run with the budget'), look: { panel: 'bottom' }, show: ['recovery', 'failRate', 'busiest'] },
    { kind: 'guess', title: tx('Guess: adaptive throttling'), questions: ['throttle-recover'] },
    { kind: 'run', title: tx('Run with adaptive throttling'), example: 'adaptive-throttle', look: { panel: 'bottom' }, show: ['recovery', 'failRate', 'busiest'] },
    {
      kind: 'try',
      title: tx('A smaller K'),
      example: 'adaptive-throttle',
      text: tx('Lower "Adaptive throttling K" to 1.5 on every connection and run again.\n\nIn the charts: does the caller reject earlier than with K = 2? Does it ever let go after the spike?'),
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
      title: tx('Request deadlines'),
      example: 'retry-storm',
      text: tx('A request deadline carries the user’s remaining patience across every server—like a delivery driver checking how much time is left before starting the next stop. If time has already run out, servers drop the work instead of wasting effort.\n\nOn the retry storm design, set Users’ "Deadline propagation" to "Pass down (like gRPC deadline)" (the user deadline is 1 second) and run again. Does anything change? Compare the 1-second deadline with each connection’s 150 ms timeout.'),
      patch: [{ node: 'users', params: { deadline: 'propagate' } }],
    },
    { kind: 'challenge', title: tx('One connection is enough'), challenges: ['retry-budget/one-edge'] },
    { kind: 'challenge', title: tx('Let go sooner'), challenges: ['adaptive-throttle/let-go'] },
    { kind: 'practice', title: tx('Practice'), items: [{ kind: 'constraint', id: 'retry-budget' }] },
  ],
};

export default retryBudgets;
