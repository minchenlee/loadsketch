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
  intro: tx('When a network call fails or times out, a server often tries again automatically. That second attempt is a retry. Retries fix brief hiccups, but during overload they can make a busy server much busier.\n\nImagine a busy phone line where everyone hits redial three times. Even after the rush ends, the line stays jammed with redials. That self-feeding flood is a retry storm, and the extra traffic it creates is traffic amplification.\n\nTo soften retries, systems usually wait longer between tries (backoff) and add a small random delay (jitter) so everyone does not redial at the exact same instant.\n\nIn this design, each connection between components has a 150 ms timeout, 3 retries, and a 10 ms backoff base. From second 20 to 30, user traffic triples. Guess what happens, then press Run.'),
  scenario: 'retry-storm',
  terms: [
    {
      term: tx('Retry'),
      plain: tx('Automatically sending a failed or timed-out request again in case the problem was brief.'),
      example: tx('Hitting redial when a phone call drops.'),
    },
    {
      term: tx('Retry storm'),
      plain: tx('A feedback loop where failed requests trigger so many retries that the server stays overloaded even after normal traffic returns.'),
      example: tx('A ticket hotline staying jammed because everyone keeps hitting redial at once.'),
    },
    {
      term: tx('Traffic amplification'),
      plain: tx('When retries or fan-out multiply one user request into several internal calls.'),
      example: tx('One caller hitting redial 3 times turns 1 call into 4 calls to the switchboard.'),
    },
    {
      term: tx('Backoff'),
      plain: tx('Waiting progressively longer before each retry instead of retrying immediately.'),
      example: tx('Waiting 10 seconds, then 20 seconds, then 40 seconds before trying a busy phone line again.'),
    },
    {
      term: tx('Jitter'),
      plain: tx('Adding a small random delay to waits so many callers do not retry at the exact same moment.'),
      example: tx('Asking callers to wait a random number of seconds before redialing so their calls spread out.'),
    },
  ],
  questions: [
    {
      id: 'recover',
      topic: 'recovery',
      text: tx('User traffic triples from second 20 to 30, and every failed call retries up to 3 times. After traffic returns to normal at second 30, what happens?'),
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
      explain: tx('During the spike, calls time out and trigger retries. Each user request is sent up to 4 times (1 original try plus 3 retries).\n\nWhen the spike ends at second 30, the API queues are still packed with retries. New requests wait in those full queues, time out, and trigger even more retries. The system traps itself in a retry storm.'),
      look: { panel: 'bottom' },
      explainFor: {
        fast: tx('This design stopped retries from piling up during the spike by limiting retries or rejecting fast. The queues stayed short, so the system recovered right after traffic returned to normal.'),
        slow: tx('Retries piled up during the spike, but not enough to trap the system forever. It recovered once the queues slowly drained.'),
      },
    },
    {
      id: 'amp',
      topic: 'retry',
      text: tx('During the 3× spike, each failed call from the load balancer retries up to 3 times (4 sends total). At most how many times their usual traffic do the API servers receive?'),
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
      explain: tx('When the API servers are full, most calls time out or get rejected. Each failed call from the load balancer is retried up to 3 times.\n\nThis traffic amplification multiplies the 3× user spike by up to 4 sends per request—and delayed retries from earlier seconds overlap with new arrivals, pushing the measured peak above a simple 3 × 4 estimate.'),
      calc: [
        tx('User spike: 3 × usual requests'),
        tx('Per load-balancer call: 1 original + 3 retries = up to 4 sends'),
        tx('Simplified estimate: 3 × 4 = 12 × usual traffic (the measured peak above can be higher because retries from earlier seconds carry over into the next second)'),
      ],
      look: { node: 'api' },
      explainFor: { x3: tx('Retries did not multiply the traffic. The API servers receive roughly the same traffic that users send.') },
    },
  ],
  challenges: [
    {
      id: 'retry-storm/recover',
      title: tx('Recover on its own'),
      text: tx('Make the system recover within 5 seconds after the spike ends, without adding more machines.'),
      goals: [recoversWithin(5, tx('Recovered within 5 seconds after the spike (then fewer than 5% fail in every second)')), errorsUnder(0.35, tx('Error rate under 35% for the whole run'))],
      rules: [noMoreCapacity],
      hint: tx('Click the connection lines between components to inspect their retry settings.\n\nEither reduce "Retry count" or add a "Retry budget" (such as 0.1, which caps retries at 10% of normal calls) so retries cannot snowball during the spike.'),
    },
    {
      id: 'retry-storm/fail-less',
      title: tx('Fail less'),
      text: tx('Keep the failure rate of the whole run below 10%, without adding more machines.'),
      goals: [failUnder10],
      rules: [noMoreCapacity],
      hint: tx('During the spike, the API servers cannot handle every request, so some requests must fail.\n\nRejecting excess requests right away is better than letting them wait 150 ms in a long queue and time out. Click the API server and try a smaller "Max queue", or set a "CoDel queue target" (which automatically drops requests that wait too long).'),
    },
    {
      id: 'retry-storm/keep-retries',
      title: tx('Keep the retries'),
      text: tx('Keep at least 1 retry on every connection that had retries (calls into the cache do not count, since the API falls back to the database). Keep total failures below 10% and p99 of successful requests below 130 ms.'),
      goals: [failUnder10, p99Under(130, tx('p99 of successful requests below 130 ms'))],
      rules: [noMoreCapacity, keepRetries],
      hint: tx('A smaller queue rejects excess calls fast, which saves latency. However, those rejected calls still trigger retries and multiply traffic again.\n\nPair a shorter API queue with a "Retry budget" on the connection into the API so total retries stay small.'),
    },
  ],
  learn: [
    tx('How retries multiply traffic when a server is already full'),
    tx('Why a retry storm keeps a system broken after a spike ends'),
    tx('What you save—and give up—when you turn retries off'),
    tx('How a retry budget and fast rejection stop retries from snowballing'),
  ],
  learnAt: [2, 2, 3, 4],
  recap: [
    tx('A failed call with 3 retries sends up to 4 tries total: retries add load at the worst moment.'),
    tx('After a spike, queues packed with retries make new requests time out and retry too, locking in a retry storm.'),
    tx('Cap total retries and reject overload fast with a short queue so the outage ends when the spike ends.'),
  ],
  steps: [
    {
      kind: 'read',
      title: tx('The setup'),
      text: tx('When a network call fails or times out, the caller often tries again automatically. That is a retry. Retries fix brief hiccups, like hitting redial when a call drops.\n\nDuring heavy overload, retries backfire. If everyone keeps hitting redial on a busy phone line, the line stays jammed. Each extra try multiplies the load (traffic amplification) and can trigger a retry storm. Waiting longer between tries (backoff) with a random delay (jitter) spreads redials out, but does not reduce total retries.\n\nThis site has a load balancer, API servers, a cache, and a database. Every connection has a 150 ms timeout, 3 retries, and a 10 ms backoff base. From second 20 to 30, traffic triples. Guess what happens, then press Run.'),
      key: tx('A retry is one more call, sent when the system is already slow.'),
    },
    { kind: 'guess', title: tx('Guess: after the spike'), questions: ['recover', 'amp'] },
    { kind: 'run', title: tx('Run the spike'), look: { panel: 'bottom' }, show: ['recovery', 'failRate', 'busiest'] },
    {
      kind: 'try',
      title: tx('No retries into the API'),
      text: tx('Set "Retry count" to 0 on the connection from the load balancer to the API servers (or use the button below) and run again.\n\nIn the charts: do requests still fail during the spike? How soon after second 30 does the system recover?'),
      patch: [{ edge: 'lb->api', set: { retries: 0 } }],
      look: { panel: 'bottom' },
      show: ['recovery', 'failRate', 'p99'],
    },
    { kind: 'challenge', title: tx('Three challenges'), challenges: ['retry-storm/recover', 'retry-storm/fail-less', 'retry-storm/keep-retries'] },
    { kind: 'practice', title: tx('Practice'), items: [{ kind: 'oncall', id: 'cache-down' }] },
  ],
};

export default retryStorm;
