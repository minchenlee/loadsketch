// 3.1 Retry storm (retry-storm). The first lesson of the app, moved into the course unchanged:
// same question and challenge ids, so passed challenges and the guess log stay as they were.
import { t, tx } from '../../i18n/index.ts';
import { keepRetries, noMoreCapacity, type Lesson } from '../lesson.ts';
import { errorsUnder, p99Under } from '../lessonKit.ts';
import { recovery, recoveryText, recoversWithin } from '../lessonKit2.ts';
import { peakAmp } from '../metrics.ts';

const failUnder10 = errorsUnder(0.1, tx('Failure rate of the whole run below 10%'));

const retryStorm: Lesson = {
  id: '3.1',
  title: tx('Retry storm'),
  unit: 3,
  order: 1,
  minutes: 20,
  wave: 1,
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
      look: { panel: 'bottom' },
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
      calc: [tx('Spike: 3 × the usual requests'), tx('Each call from the load balancer: 1 + 3 retries = up to 4 sends'), tx('At the API: up to 3 × 4 = 12 × the usual')],
      look: { node: 'api' },
      explainFor: { x3: tx('Retries did not multiply the traffic: the API receives about as many requests as the users send.') },
    },
  ],
  challenges: [
    {
      id: 'retry-storm/recover',
      title: tx('Recover on its own'),
      text: tx('Recover within 5 seconds after the spike, with no more machines.'),
      goals: [recoversWithin(5, tx('Recovered within 5 seconds after the spike (then fewer than 5% fail in every second)')), errorsUnder(0.35, tx('Error rate under 35% for the whole run'))],
      rules: [noMoreCapacity],
      hint: tx('Look at the retry settings on the edges. A retry budget limits retries to a share of the calls, so retries cannot snowball during the spike.'),
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
      text: tx('Every edge that had retries still retries at least once (a call into a cache does not count), the failure rate of the whole run is below 10%, and p99 of successful requests is below 130 ms.'),
      goals: [failUnder10, p99Under(130, tx('p99 of successful requests below 130 ms'))],
      rules: [noMoreCapacity, keepRetries],
      hint: tx('With a smaller queue limit, the rejected calls are retried, and that multiplies the traffic again. Add a retry budget to limit the total of retries.'),
    },
  ],
  learn: [tx('How retries multiply the traffic when a component is full'), tx('Why the system can stay broken after the spike is over'), tx('What turning retries off costs and saves'), tx('How a retry budget and fast rejection keep retries from snowballing')],
  learnAt: [2, 2, 3, 4],
  recap: [tx('Each failed call can be sent up to 4 times (1 try + 3 retries): retries add load at the worst moment.'), tx('After the spike, queues full of retries keep new requests slow, so they time out and are retried too.'), tx('Limit the retries (a retry budget) and reject fast (a short queue), so that the trouble ends when the spike does.')],
  steps: [
    { kind: 'read', title: tx('The setup'), text: tx('A three-tier site with a 150 ms timeout and 3 retries on every hop. From second 20 to 30, traffic is 3 times higher. Guess what happens, then press Run.'), key: tx('A retry is one more call, sent when the system is already slow.') },
    { kind: 'guess', title: tx('Guess: after the spike'), questions: ['recover', 'amp'] },
    { kind: 'run', title: tx('Run the spike'), look: { panel: 'bottom' }, show: ['recovery', 'failRate', 'busiest'] },
    { kind: 'try', title: tx('No retries into the API'), text: tx('Set the retries of the edge from the load balancer to the API servers to 0 and run again. In the charts: do requests still fail during the spike? How soon after second 30 does the system recover?'), patch: [{ edge: 'lb->api', set: { retries: 0 } }], look: { panel: 'bottom' }, show: ['recovery', 'failRate', 'p99'] },
    { kind: 'challenge', title: tx('Three challenges'), challenges: ['retry-storm/recover', 'retry-storm/fail-less', 'retry-storm/keep-retries'] },
    { kind: 'practice', title: tx('Practice'), items: [{ kind: 'oncall', id: 'cache-down' }] },
  ],
};

export default retryStorm;
