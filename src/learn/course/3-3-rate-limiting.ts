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
  intro: tx('A flash sale: 400 requests a second, then 10× (4000 a second) from second 15 for 20 s. A token bucket at the edge lets 1500 a second through, with a burst of 300; every request over that gets a 429 at once. Behind it: 4 checkout servers and one MySQL database. Guess what the limiter costs and what it saves, then press Run.'),
  scenario: 'flash-sale',
  questions: [
    {
      id: 'sale-limited',
      topic: 'capacity',
      text: tx('Of all the requests in the run, what share does the rate limiter turn away?'),
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
      explain: tx('During the sale most requests are turned away: about half of the whole run. The checkout servers and the database stay at a normal pace (look at their utilization), so the ones that get through are fast. But the limit is lower than what they can carry: the challenge finds the real number.'),
      calc: [tx('During the sale: 4000 a second arrive, 1500 get through'), tx('Turned away: 4000 − 1500 = 2500 a second, for 20 s')],
      look: { node: 'limiter' },
      explainFor: {
        few: tx('Almost nothing was turned away: the limit is close to the sale traffic. Check that the servers behind it still keep up (p99).'),
        some: tx('The limit is close to what the servers behind it can carry: fewer shoppers are turned away, and the ones that get through are still fast.'),
        most: tx('The limit is far below the sale traffic: most shoppers are turned away, while the servers behind it are idle.'),
      },
    },
    {
      id: 'tenant-small',
      example: 'tenant-limits',
      scenario: 'steady',
      topic: 'other',
      text: tx('Two customers share an API: a large one sends 9 times as much as a small one (about 660 and 75 a second). The limiter gives each customer its own quota: 500 a second. What happens to the small customer?'),
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
      explain: tx('Each customer has its own bucket. The large customer is over its quota, so about a third of its requests get a 429; the small customer is far under its own and sees nothing. With one shared bucket (“All share one”), both would lose the same share: the large customer’s burst would use up the small customer’s tokens.'),
      look: { node: 'rl' },
      explainFor: {
        same: tx('Both customers lose the same share: the quota is shared (“All share one”), so the large customer uses up the tokens the small one needs.'),
        some: tx('The small customer loses some requests: the quota or the concurrency limit is close to its own traffic.'),
      },
    },
  ],
  challenges: [
    {
      id: 'flash-sale/sell-more',
      title: tx('Sell more'),
      text: tx('The limit turns away shoppers the servers could serve. Get the error rate of the whole run under 25% while p99 stays under 150 ms, without adding machines.'),
      goals: [errorsUnder(0.25, tx('Error rate under 25% for the whole run')), p99Under(150, tx('p99 of successful requests under 150 ms'))],
      rules: [noMoreCapacity],
      hint: tx('Raise “Limit per second” on the edge throttling step by step. The checkout servers and the database have room: watch their utilization climb. Too high and the database fills up: requests queue, and p99 jumps. Removing the limit fails fewer requests but p99 goes over 300 ms. A bigger burst does not help either: it lets a wave into the queues at the start of the sale.'),
    },
    {
      id: 'tenant-limits/grow',
      example: 'tenant-limits',
      scenario: 'steady',
      title: tx('A bigger plan'),
      text: tx('The large customer moves to a bigger plan: fewer than 1% of its requests may be turned away. The small customer must still lose nothing. Keep one quota per customer, at most 800 a second.'),
      goals: [
        clientUnder('big', 0.01, tx('Large customer: under 1% fail')),
        clientUnder('small', 0.005, tx('Small customer: under 0.5% fail')),
        paramAtMost('rl', 'ratePerSec', 800, tx('Quota per customer ≤ 800 a second')),
        failUnder1,
      ],
      rules: [noMoreCapacity, keepParam('rl', 'scope', tx('Keep one quota per customer'), tx('The rate limiter keeps “One per user (tenant)”'))],
      hint: tx('The large customer sends about 660 a second on average, but requests arrive at random: some seconds bring many more. A quota just over the average still turns some away. Leave some room above the average.'),
    },
  ],
  learn: [tx('What a rate limiter costs: the requests it turns away'), tx('What it saves: the servers behind it stay fast'), tx('How to set the limit from what the servers can carry'), tx('Why each customer needs its own quota')],
  learnAt: [2, 3, 4, 7],
  recap: [tx('A limit below what the servers can carry turns users away for nothing; a limit above it lets the queues fill.'), tx('Requests arrive at random: leave room above the average.'), tx('One shared quota lets a large customer use up a small one’s share; one quota per customer keeps them apart.')],
  steps: [
    { kind: 'read', title: tx('A flash sale'), text: tx('A flash sale: 400 requests a second, then 10× (4000 a second) from second 15 for 20 s. A token bucket at the edge lets 1500 a second through, with a burst of 300; every request over that gets a 429 at once. Behind it: 4 checkout servers and one MySQL database. Guess what the limiter costs and what it saves, then press Run.'), key: tx('A rate limiter protects what is behind it by choosing who is turned away.') },
    { kind: 'guess', title: tx('Guess: how many are turned away'), questions: ['sale-limited'] },
    { kind: 'run', title: tx('Run the sale'), look: { panel: 'bottom' } },
    { kind: 'try', title: tx('Without the limit'), text: tx('Take the limit away: set “Limit per second” to 100000 and run again. Do fewer requests fail? What happens to the database and to p99?'), patch: [{ node: 'limiter', params: { ratePerSec: 100000 } }], look: { node: 'db' }, show: ['failRate', 'p99', 'util:db'] },
    { kind: 'challenge', title: tx('Sell more'), challenges: ['flash-sale/sell-more'] },
    { kind: 'guess', title: tx('Guess: two customers'), questions: ['tenant-small'] },
    { kind: 'run', title: tx('Run two customers'), example: 'tenant-limits', scenario: 'steady', show: ['clientFail:small', 'clientFail:big'] },
    { kind: 'try', title: tx('One shared quota'), text: tx('Switch “How the allowance is split” to “All share one” and run again. What share of the small customer’s requests fail now, next to the large one’s?'), example: 'tenant-limits', scenario: 'steady', patch: [{ node: 'rl', params: { scope: 'global' } }], show: ['clientFail:small', 'clientFail:big'] },
    { kind: 'challenge', title: tx('A bigger plan'), challenges: ['tenant-limits/grow'] },
  ],
};

export default rateLimiting;
