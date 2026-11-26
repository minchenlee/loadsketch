// 4.1 Slow dependency: timeout, bulkhead, fallback, breaker (slow-dependency → bulkhead-fallback; resilience).
import { t, tx } from '../../i18n/index.ts';
import { noMoreCapacity, type Goal, type Lesson } from '../lesson.ts';
import { failUnder1, p99Under, pct } from '../lessonKit.ts';
import type { RunData } from '../metrics.ts';

/** Share of the users' requests answered with a degraded answer: each response counted once (summary.degraded), not each fallback on the way. */
const degraded = (run: RunData) => {
  const s = run.result.summary as { degraded?: number; offered: number };
  return s.offered > 0 ? (s.degraded ?? 0) / s.offered : 0;
};

const degradedUnder = (limit: number, text: string): Goal => ({
  text,
  check: (run) => ({ ok: degraded(run) < limit, value: pct(degraded(run)) }),
});

const failBands = (run: RunData) => {
  const e = run.result.summary.errorRate;
  return e < 0.05 ? 'few' : e < 0.25 ? 'some' : e < 0.6 ? 'half' : 'most';
};

const slowDependency: Lesson = {
  id: '4.1',
  title: tx('Slow dependency: timeout, bulkhead, fallback, breaker'),
  unit: 4,
  order: 1,
  minutes: 30,
  wave: 1,
  example: 'slow-dependency',
  extraExamples: ['bulkhead-fallback', 'resilience'],
  intro: tx('Most web servers rely on other services—databases, payment gateways, or recommendation engines—to build a page. Each external service your server calls is a dependency.\n\nA crashed dependency fails immediately, freeing your server to move on. A slow dependency is often far worse: while your server waits for an answer, that request holds onto a worker slot.\n\nHere, a product page receives 1500 requests a second across 4 API servers (32 slots each). Every request reads Postgres, then calls a recommendation service (normally 20 ms, timeout 1 s). Recommendations are just a nice extra. From second 20 to 60, recommendations become 50 times slower (about 1 second per call). Guess what happens to the product page, then press Run.'),
  scenario: 'slow-dependency',
  terms: [
    {
      term: tx('Dependency'),
      plain: tx('Another service or datastore that your server must call to complete part of a request.'),
      example: tx('A restaurant kitchen relying on a separate bakery across the street for dessert.'),
    },
    {
      term: tx('Bulkhead'),
      plain: tx('A limit on how many concurrent calls one server may make to a specific dependency, isolating slow calls so they cannot consume every slot.'),
      example: tx('Waterproof compartments in a ship hull: if one compartment floods, the rest of the ship stays afloat.'),
    },
    {
      term: tx('Fallback'),
      plain: tx('A simpler backup answer returned when a non-essential dependency fails or is skipped, so the main request still succeeds.'),
      example: tx('Handing diners a simple backup menu when the main kitchen is down.'),
    },
    {
      term: tx('Circuit breaker'),
      plain: tx('A switch that detects repeated failures to a dependency, opens to fail new calls immediately without waiting, and later tests a few calls to see if it recovered.'),
      example: tx('An electrical breaker in your home that trips automatically to stop a faulty wire from causing a fire.'),
    },
  ],
  questions: [
    {
      id: 'slow-fail',
      topic: 'recovery',
      text: tx('Recommendations are 50 times slower (about 1 s per call) for 40 of the 80 seconds. What share of all product page requests fail?'),
      options: [
        { id: 'few', text: tx('Under 5%: only the recommendations are late') },
        { id: 'some', text: tx('5% to 25%') },
        { id: 'half', text: tx('25% to 60%: about every request while they are slow') },
        { id: 'most', text: tx('More than 60%') },
      ],
      answer: failBands,
      measured: (run) => t('{p} of the requests failed', { p: pct(run.result.summary.errorRate) }),
      explain: tx('A slow dependency is worse than a crashed one because every waiting call holds an API slot until the 1-second timeout expires.\n\nWith 1500 requests arriving every second and only 128 total slots across 4 API servers, all slots fill immediately, the queue overflows, and even requests that could have shown the product without recommendations get rejected. One optional feature takes down the entire page.'),
      calc: [tx('Slots needed while slow: 1500/s × 1 s = 1500 slots'), tx('Slots available: 4 servers × 32 slots = 128 slots')],
      look: { node: 'api' },
      explainFor: {
        few: tx('Almost no requests failed because this design prevents slow calls from holding all the slots (using a short timeout or a bulkhead, paired with a fallback).'),
        some: tx('Some requests failed because slow calls still tied up part of the slots. Check what is still waiting too long on recommendations.'),
      },
    },
    {
      id: 'degraded',
      example: 'bulkhead-fallback',
      topic: 'capacity',
      text: tx('Now we combine both defenses on the connection to recommendations: a bulkhead allowing at most 4 concurrent calls per API server, plus a fallback that returns a default list whenever a call fails or is blocked.\n\nRemember: each of the 4 API servers receives 375 requests a second (1500 ÷ 4), and recommendations normally take 20 ms (0.02 s). Over the whole 80-second run, what share of requests get the fallback list instead of real recommendations?'),
      options: [
        { id: 'few', text: tx('Under 10%') },
        { id: 'half', text: tx('About half: every request while recommendations are slow') },
        { id: 'most', text: tx('More than half: some even while they are fast') },
      ],
      answer: (run) => {
        const d = degraded(run);
        return d < 0.1 ? 'few' : d < 0.55 ? 'half' : 'most';
      },
      measured: (run) => t('{p} of the requests got the fallback', { p: pct(degraded(run)) }),
      explain: tx('Zero requests fail now, but the bulkhead of 4 is too small! Even at normal 20 ms speed, each API server averages 7.5 recommendation calls in flight at once (375/s × 0.02 s).\n\nBecause the bulkhead caps concurrent calls at 4, many requests get turned away and served the default list even when recommendations are completely healthy. Always size a bulkhead larger than normal concurrency, and use a shorter timeout to cut slow calls short.'),
      calc: [tx('Traffic per API server: 1500/s ÷ 4 servers = 375/s'), tx('Normal calls in flight: 375/s × 0.02 s = 7.5 at a time'), tx('Bulkhead allows only 4 → overflows even at normal speed')],
      look: { panel: 'bottom' },
      explainFor: {
        half: tx('About half got the fallback: requests during the 40-second slowdown got the default list, while normal traffic got real recommendations. The bulkhead and timeout are sized properly.'),
        few: tx('Few requests got the fallback because recommendations were rarely cut off. Check that the API servers still hold up during the slowdown.'),
      },
    },
  ],
  challenges: [
    {
      id: 'slow-dependency/hold',
      title: tx('Keep the page up'),
      text: tx('Keep total failures under 1% over the whole run, without adding machines.'),
      goals: [failUnder1],
      rules: [noMoreCapacity],
      hint: tx('Click the connection from the API server to Recommendations. You need two settings working together:\n\n1. Stop the API from waiting too long (set a shorter "Timeout", or add a "Bulkhead (max concurrent calls)").\n2. Turn "Fallback (degraded response)" on so failed recommendation calls return a backup list instead of failing the whole page.'),
    },
    {
      id: 'bulkhead-fallback/degrade-less',
      example: 'bulkhead-fallback',
      title: tx('Degrade less'),
      text: tx('On the "Bulkhead + fallback" design: keep failures under 1%, keep fallback responses under 55%, and keep p99 under 200 ms. Add no machines.'),
      goals: [failUnder1, degradedUnder(0.55, tx('Fewer than 55% get the fallback')), p99Under(200, tx('p99 of successful requests under 200 ms'))],
      rules: [noMoreCapacity],
      hint: tx('At normal speed, a bulkhead of 4 is already full (each server needs about 7.5 slots normally). Raise "Bulkhead (max concurrent calls)" above normal traffic so healthy calls get real recommendations.\n\nThen lower "Timeout" so slow calls do not wait a full 1000 ms—a larger bulkhead alone lets slow calls wait the whole second and pushes p99 above 200 ms.'),
    },
  ],
  learn: [
    tx('Why a slow dependency can be more dangerous than a crashed one'),
    tx('What a fallback does, and why it cannot protect slots on its own'),
    tx('How a bulkhead isolates slow calls, and why it needs a fallback'),
    tx('How to size a bulkhead and timeout together for normal vs. slow traffic'),
    tx('How a circuit breaker trips to fail fast while a dependency is broken'),
  ],
  learnAt: [3, 4, 6, 8, 10],
  recap: [
    tx('A slow dependency holds onto server slots while waiting: one slow extra feature can take down the whole page.'),
    tx('Combine fast cutoff (timeout or bulkhead) with a backup answer (fallback)—neither works alone.'),
    tx('Size a bulkhead above normal concurrent calls so healthy traffic is not degraded, and use a circuit breaker to stop hammering broken dependencies.'),
  ],
  steps: [
    {
      kind: 'read',
      title: tx('A product page'),
      text: tx('Modern sites rely on other services to build each page. Any service your server calls is called a dependency—like a restaurant kitchen relying on a separate bakery for dessert.\n\nHere, a product page handles 1500 requests a second on 4 API servers (32 slots each). Every request reads product details from Postgres, then calls a recommendation service (normally 20 ms per call, with a 1-second timeout). Recommendations are only a nice extra—the page is still useful without them.'),
      key: tx('An optional dependency should never be able to take down your main page.'),
    },
    {
      kind: 'read',
      title: tx('The slowdown'),
      text: tx('From second 20 to 60 (half of the 80-second run), the recommendation service becomes 50 times slower—taking about 1 second per call instead of 20 ms.\n\nUnlike a crash that returns an error right away, a slow call keeps its API slot locked until the timeout fires. Guess what this slowdown does to the product page, then press Run.'),
      key: tx('A slow call holds a slot for as long as it waits.'),
    },
    { kind: 'guess', title: tx('Guess: the page'), questions: ['slow-fail'] },
    { kind: 'run', title: tx('Run the slowdown'), look: { panel: 'bottom' }, show: ['failRate', 'rejected', 'timedOut'] },
    {
      kind: 'try',
      title: tx('Only a fallback'),
      text: tx('A fallback returns a simple backup answer (like a default product list) when a call fails—just like handing diners a simple backup menu when the main kitchen is down.\n\nTurn on only "Fallback (degraded response)" on the connection to Recommendations (or use the button below), and run again. Do fewer requests fail? Why do calls still tie up the API servers?'),
      patch: [{ edge: 'api->recs', set: { fallback: 'on' } }],
      show: ['failRate', 'degraded', 'p99'],
    },
    {
      kind: 'try',
      title: tx('Only a bulkhead'),
      text: tx('A bulkhead caps how many concurrent calls an API server can make to one dependency—like waterproof compartments in a ship hull so one leak cannot sink the whole ship.\n\nTurn fallback off and set a "Bulkhead (max concurrent calls)" of 4 on the connection to Recommendations (or use the button below), then run again. Are there more or fewer failures than with fallback alone? What happens to requests the bulkhead blocks?'),
      patch: [{ edge: 'api->recs', set: { fallback: 'off', bulkhead: 4 } }],
      show: ['failRate', 'rejected', 'p99'],
    },
    { kind: 'challenge', title: tx('Keep the page up'), challenges: ['slow-dependency/hold'] },
    { kind: 'guess', title: tx('Guess: the default list'), questions: ['degraded'] },
    { kind: 'run', title: tx('Run bulkhead + fallback'), example: 'bulkhead-fallback', show: ['degraded', 'failRate', 'p99'] },
    { kind: 'challenge', title: tx('Degrade less'), challenges: ['bulkhead-fallback/degrade-less'] },
    {
      kind: 'run',
      title: tx('A circuit breaker'),
      text: tx('When a dependency is clearly broken, even short timeouts waste time and keep hammering it. A circuit breaker works like an electrical breaker in your home: when too many calls fail, it trips open and rejects new calls immediately without waiting.\n\nAfter a short cooldown, it enters a test state (half-open) and lets a few probe calls through. If they succeed, the breaker closes and normal traffic resumes.\n\nHere, the order service calls payments through a circuit breaker while payments slow down 20×. Press Run and inspect the circuit breaker card: how often did it open, and how many calls did it turn away?'),
      example: 'resilience',
      scenario: 'slow-payments',
      look: { node: 'cb' },
    },
    { kind: 'practice', title: tx('Practice'), items: [{ kind: 'oncall', id: 'slow-dependency' }, { kind: 'oncall', id: 'db-slow' }, { kind: 'brief', id: 'brief-checkout' }] },
  ],
};

export default slowDependency;
