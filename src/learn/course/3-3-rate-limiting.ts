// 3.3 Rate limiting at the door (flash-sale; tenant-limits with steady traffic).
import { t, tx } from '../../i18n/index.ts';
import { noMoreCapacity, type Goal, type Lesson } from '../lesson.ts';
import { errorsUnder, failUnder1, p99Under, pct } from '../lessonKit.ts';
import { clientFailShare, keepParam, paramAtMost } from '../lessonKit2.ts';

/** Share of every request that the rate limiters turned away. */
const limitedShare = (run: Parameters<Goal['check']>[0]) => {
  let n = 0;
  for (const x of Object.values(run.result.nodes)) n += x.origin?.rate_limited ?? 0;
  return run.result.summary.offered > 0 ? n / run.result.summary.offered : 0;
};

const clientUnder = (client: string, limit: number, text: string): Goal => ({
  text,
  check: (run) => ({ ok: clientFailShare(run, client) < limit, value: pct(clientFailShare(run, client)) }),
});

const rateLimiting: Lesson = {
  id: '3.3',
  title: tx('Rate limiting at the door'),
  unit: 3,
  order: 3,
  minutes: 20,
  wave: 1,
  example: 'flash-sale',
  extraExamples: ['tenant-limits'],
  intro: tx('When a flash sale opens, ten times as many shoppers rush in at once. If every request reaches checkout, the queues fill up and nobody can finish paying.\n\nA rate limiter acts like a bouncer at the front door. It lets requests inside at a steady pace and rejects extra ones right away with an HTTP 429 ("Too Many Requests") error so the servers behind it stay fast.\n\nMost rate limiters use a token bucket: tokens refill at a steady rate, and each request takes one token to enter. The bucket also holds a small reserve (a burst allowance), like a short velvet-rope buffer that absorbs brief bumps.\n\nIn this flash sale, normal traffic is 400 requests a second, then jumps 10× (to 4000 a second) from second 15 for 20 seconds. The rate limiter lets 1500 a second through with a burst of 300, protecting 4 checkout servers and one MySQL database. Guess what the limiter costs and what it saves, then press Run.'),
  scenario: 'flash-sale',
  terms: [
    {
      term: tx('Rate limiter'),
      plain: tx('A gatekeeper placed in front of servers that caps how many requests may enter per second, rejecting excess traffic immediately (HTTP 429).'),
      example: tx('A bouncer at a club door letting guests in at a steady pace so the room never gets overcrowded.'),
    },
    {
      term: tx('Token bucket'),
      plain: tx('A rate-limiting rule where tokens refill at a steady rate and each request must spend one token to pass.'),
      example: tx('A ticket dispenser that drops 10 entry tickets per second into a tray; when the tray is empty, newcomers are turned away.'),
    },
    {
      term: tx('Burst'),
      plain: tx('The maximum number of saved tokens a bucket can hold, allowing a brief spike of requests to pass all at once.'),
      example: tx('A small velvet-rope buffer that lets a group of friends walk in together before the steady pace resumes.'),
    },
    {
      term: tx('Noisy neighbor'),
      plain: tx('One heavy user or customer whose high traffic consumes shared limits or resources and hurts smaller users on the same system.'),
      example: tx('One huge tour bus taking every spot in a single shared ticket line while solo travelers cannot get through.'),
    },
  ],
  questions: [
    {
      id: 'sale-limited',
      topic: 'capacity',
      text: tx('Normal traffic is 400 requests a second for 40 seconds, and sale traffic is 4000 a second for 20 seconds. The rate limiter lets at most 1500 a second through. Over the whole 60-second run, what share of all requests does the rate limiter turn away?'),
      options: [
        { id: 'few', text: tx('Under 10%: only the peak of the peak') },
        { id: 'some', text: tx('10% to 30%') },
        { id: 'half', text: tx('30% to 60%') },
        { id: 'most', text: tx('More than 60%') },
      ],
      answer: (run) => {
        const s = limitedShare(run);
        return s < 0.1 ? 'few' : s < 0.3 ? 'some' : s < 0.6 ? 'half' : 'most';
      },
      measured: (run) => t('{p} of the requests got a 429', { p: pct(limitedShare(run)) }),
      explain: tx('During the 20-second sale, 4000 requests arrive each second but only 1500 get tokens. Turning away 2500 a second adds up to roughly half of all requests in the entire run.\n\nThe upside: the checkout servers and MySQL database stay comfortably busy (check their utilization), so shoppers who get through check out fast. However, this limit is actually lower than what the servers can handle—the challenge asks you to find the real ceiling.'),
      calc: [tx('During the 20 s sale: 4000/s arrive, 1500/s enter → 2500/s turned away'), tx('Turned away: 2500 × 20 s = 50,000 requests'), tx('Total in 60 s run: (400 × 40 s) + (4000 × 20 s) = 96,000 → about half turned away')],
      look: { node: 'limiter' },
      explainFor: {
        few: tx('Almost no requests were turned away because the limit is close to the sale traffic. Check p99 to make sure the servers behind it can still keep up.'),
        some: tx('The limit sits close to what the servers behind it can actually handle: fewer shoppers are turned away, and the ones who get in stay fast.'),
        most: tx('The limit sits far below what the servers can handle: most shoppers are turned away while the checkout servers sit mostly idle.'),
      },
    },
    {
      id: 'tenant-small',
      example: 'tenant-limits',
      scenario: 'steady',
      topic: 'other',
      text: tx('When multiple customers share one API, a heavy customer (a noisy neighbor) can drain a shared limit and block everyone else. To prevent this, a per-tenant limit gives each customer its own separate lane.\n\nHere, two customers share an API: a large customer sends 9 times as much traffic as a small one (about 720 vs. 80 requests a second). The rate limiter gives each customer its own 500/s quota. What happens to the small customer?'),
      options: [
        { id: 'none', text: tx('None of its requests are turned away') },
        { id: 'some', text: tx('Some are turned away, fewer than the large customer’s') },
        { id: 'same', text: tx('As many as the large customer’s, the same share') },
      ],
      answer: (run) => {
        const s = clientFailShare(run, 'small');
        const b = clientFailShare(run, 'big');
        return s < 0.005 ? 'none' : s < b / 2 ? 'some' : 'same';
      },
      measured: (run) => t('Small customer: {s} failed; large customer: {b} failed', { s: pct(clientFailShare(run, 'small')), b: pct(clientFailShare(run, 'big')) }),
      explain: tx('Each customer has its own token bucket. The large customer sends more than its 500/s quota, so its excess requests get HTTP 429 errors. The small customer stays far below 500/s and loses nothing.\n\nIf they shared one bucket ("All share one"), the large customer would act as a noisy neighbor: it would drain the shared tokens, and both customers would lose the same share of requests.'),
      look: { node: 'rl' },
      explainFor: {
        same: tx('Both customers lose the same share because they share one quota ("All share one"). The large customer drains the tokens the small customer needs.'),
        some: tx('The small customer loses some requests because the per-customer quota or concurrency limit is close to its own traffic.'),
      },
    },
  ],
  challenges: [
    {
      id: 'flash-sale/sell-more',
      title: tx('Sell more'),
      text: tx('The current rate limit turns away shoppers that checkout could easily serve. Bring the total error rate under 25% while keeping p99 under 150 ms, without adding machines.'),
      goals: [errorsUnder(0.25, tx('Error rate under 25% for the whole run')), p99Under(150, tx('p99 of successful requests under 150 ms'))],
      rules: [noMoreCapacity],
      hint: tx('Click the "Edge throttling" rate limiter and raise "Limit per second" step by step.\n\nWatch the utilization of the checkout servers and MySQL database climb. If you raise the limit too high, the database fills up, queues grow, and p99 jumps above 150 ms. Raising "Burst allowance" does not fix sustained load either—it just dumps a sudden wave into the queues when the sale starts.'),
    },
    {
      id: 'tenant-limits/grow',
      example: 'tenant-limits',
      scenario: 'steady',
      title: tx('A bigger plan'),
      text: tx('The large customer upgrades to a bigger plan: fewer than 1% of its requests may be turned away, and the small customer must still lose nothing. Keep one quota per customer ("One per user (tenant)"), at most 800 requests a second.'),
      goals: [
        clientUnder('big', 0.01, tx('Large customer: under 1% fail')),
        clientUnder('small', 0.005, tx('Small customer: under 0.5% fail')),
        paramAtMost('rl', 'ratePerSec', 800, tx('Quota per customer ≤ 800 a second')),
        failUnder1,
      ],
      rules: [noMoreCapacity, keepParam('rl', 'scope', tx('Keep one quota per customer'), tx('The rate limiter keeps “One per user (tenant)”'))],
      hint: tx('Real requests do not arrive like a metronome. Like shoppers walking into a store, they arrive at random—even if the average is steady, some seconds bring noticeably more.\n\nA limit set just barely above the average still rejects busy seconds. Leave extra headroom above the large customer’s average rate (and check "Max concurrent" if requests are still getting blocked).'),
    },
  ],
  learn: [
    tx('What a rate limiter costs: the excess requests it turns away at the door'),
    tx('What a rate limiter saves: the servers behind it stay fast'),
    tx('How to tune a rate limit to match what your servers can actually carry'),
    tx('Why per-tenant limits stop a noisy neighbor from blocking smaller customers'),
  ],
  learnAt: [2, 3, 4, 7],
  recap: [
    tx('A rate limit below your servers’ capacity turns users away needlessly; a limit above capacity lets queues fill and spikes latency.'),
    tx('Because requests arrive at random, set quotas with headroom above the average rate.'),
    tx('One shared bucket lets a noisy neighbor starve small customers; per-tenant limits give each customer its own lane.'),
  ],
  steps: [
    {
      kind: 'read',
      title: tx('A flash sale'),
      text: tx('When a flash sale begins, traffic can jump tenfold in a second. Letting everyone rush in at once fills every queue and breaks checkout for all shoppers.\n\nA rate limiter acts like a bouncer at the door. It uses a token bucket: tokens refill at a steady pace, and each request spends one token to enter. A small burst allowance acts like a velvet-rope buffer for brief bumps. Any request that finds the bucket empty gets rejected immediately with HTTP 429 ("Too Many Requests").\n\nIn this flash sale, traffic starts at 400 requests a second and jumps 10× (to 4000 a second) from second 15 for 20 seconds. The rate limiter allows 1500 a second with a burst of 300 in front of 4 checkout servers and one MySQL database. Guess what it costs and saves, then press Run.'),
      key: tx('A rate limiter protects what is behind it by choosing who is turned away.'),
    },
    { kind: 'guess', title: tx('Guess: how many are turned away'), questions: ['sale-limited'] },
    { kind: 'run', title: tx('Run the sale'), look: { panel: 'bottom' } },
    {
      kind: 'try',
      title: tx('Without the limit'),
      text: tx('Remove the bottleneck at the door: set "Limit per second" to 100000 (or use the button below) and run again.\n\nDo fewer requests fail? What happens to the database and to p99 latency?'),
      patch: [{ node: 'limiter', params: { ratePerSec: 100000 } }],
      look: { node: 'db' },
      show: ['failRate', 'p99', 'util:db'],
    },
    { kind: 'challenge', title: tx('Sell more'), challenges: ['flash-sale/sell-more'] },
    { kind: 'guess', title: tx('Guess: two customers'), questions: ['tenant-small'] },
    { kind: 'run', title: tx('Run two customers'), example: 'tenant-limits', scenario: 'steady', show: ['clientFail:small', 'clientFail:big'] },
    {
      kind: 'try',
      title: tx('One shared quota'),
      text: tx('Switch "How the allowance is split" from "One per user (tenant)" to "All share one" (or use the button below) and run again.\n\nNow that both customers share one lane, what share of the small customer’s requests fail compared to the large customer’s?'),
      example: 'tenant-limits',
      scenario: 'steady',
      patch: [{ node: 'rl', params: { scope: 'global' } }],
      show: ['clientFail:small', 'clientFail:big'],
    },
    { kind: 'challenge', title: tx('A bigger plan'), challenges: ['tenant-limits/grow'] },
  ],
};

export default rateLimiting;
