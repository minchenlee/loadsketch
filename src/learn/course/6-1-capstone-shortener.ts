// 6.1 Capstone: a URL shortener for one person (url-shortener on its own traffic, then on hot-keys).
// Judged like the constraint problems: errors, p99, money a month and complexity points.
import { t, tx } from '../../i18n/index.ts';
import type { Lesson } from '../lesson.ts';
import { pct } from '../lessonKit.ts';
import { givenParts, limitGoals } from '../lessonKit2.ts';

const capstone: Lesson = {
  id: '6.1',
  title: tx('Capstone: a URL shortener run by one person'),
  unit: 6,
  order: 1,
  minutes: 40,
  wave: 1,
  example: 'url-shortener',
  intro: tx('This final unit puts everything together: read a brief (requirements and team limits), meet your SLOs (concrete speed and error targets), and balance cost against reliability.\n\nHere is your system: a URL shortener run by one person. Traffic is 3000 requests a second with a 99:1 read-to-write ratio (99% link clicks, 1% new links). It works, but it runs a read replica—adding complexity points that one person cannot safely maintain. Press Run, then inspect the cost and complexity points.'),
  scenario: 'url-shortener',
  questions: [
    {
      id: 'writes-fail',
      scenario: 'hot-keys',
      topic: 'capacity',
      text: tx('Now the product shifts: 3500 requests a second, and the read-to-write ratio flips so 70% are writes (new links). The primary database still has 8 connections, and each write takes 8 ms. With the same design, what share of requests fail?'),
      options: [
        { id: 'few', text: tx('Under 10%') },
        { id: 'some', text: tx('10% to 40%') },
        { id: 'most', text: tx('More than 40%') },
      ],
      answer: (run) => {
        const e = run.result.summary.errorRate;
        return e < 0.1 ? 'few' : e < 0.4 ? 'some' : 'most';
      },
      measured: (run) => t('{p} of the requests failed', { p: pct(run.result.summary.errorRate) }),
      explain: tx('Every write must go to the primary database. Neither a cache nor a read replica can absorb writes.\n\nAt 70% writes, the incoming writes need far more connections than the primary has. Its queue fills up and most requests fail. Whenever the read-to-write ratio changes, recalculate the load on each component: here writes, not reads, decide the database size.'),
      calc: [tx('Writes: 3500 requests/s × 70% = 2450 writes/s'), tx('Connections needed: 2450 writes/s × 0.008 s ≈ 20'), tx('Primary database currently has: 8 connections')],
      look: { node: 'db' },
      explainFor: {
        few: tx('Almost nothing failed because the primary database has enough connections to keep up with the writes.'),
        some: tx('Some requests failed because the primary has more connections than before, but still not enough for all the writes.'),
      },
    },
  ],
  challenges: [
    {
      id: 'capstone/solo-shortener',
      title: tx('One person can run it'),
      text: tx('Meet the brief on the same traffic. Hit the SLOs (at most 1% errors, p99 at most 100 ms) while staying at or under $2,200 a month and 6 complexity points.\n\nKeep the speed settings of existing components as given.'),
      goals: limitGoals({ maxErrorRate: 0.01, maxP99Ms: 100, budgetPerMonth: 2200, maxPoints: 6 }, [tx('At most 1% of requests fail'), tx('p99 of successful requests at most 100 ms'), tx('At most $2,200 a month'), tx('At most 6 complexity points')]),
      rules: [givenParts],
      hint: tx('Check your cost and complexity points. The Redis cache already serves almost every click, so very few reads reach the database.\n\nIf the database barely sees reads, what is the read replica doing for you?'),
    },
    {
      id: 'capstone/write-heavy',
      scenario: 'hot-keys',
      title: tx('When writes take over'),
      text: tx('Handle the write-heavy traffic within your budget and solo-developer limits: at most 1% errors, p99 at most 200 ms, at most $2,450 a month, and at most 6 complexity points.\n\nKeep the speed settings of existing components as given.'),
      goals: limitGoals({ maxErrorRate: 0.01, maxP99Ms: 200, budgetPerMonth: 2450, maxPoints: 6 }, [tx('At most 1% of requests fail'), tx('p99 of successful requests at most 200 ms'), tx('At most $2,450 a month'), tx('At most 6 complexity points')]),
      rules: [givenParts],
      hint: tx('Calculate the connections your writes need: writes per second × write time in seconds. Only the primary database handles writes, so give it more connections.\n\nAdding more API servers will not help because they still wait on the database. To stay within budget and complexity limits, remove or shrink a part that no longer earns its cost.'),
    },
  ],
  terms: [
    {
      term: tx('Brief (requirements)'),
      plain: tx('A short description of what a system must handle: traffic, read/write mix, budget, and team size.'),
      example: tx('An architect’s project checklist: how many rooms, total budget, and deadline before drawing blueprints.'),
    },
    {
      term: tx('SLO (service-level objective)'),
      plain: tx('A concrete, measurable reliability or speed target a system promises to meet, such as p99 under 100 ms or errors under 1%.'),
      example: tx('A pizza shop promising delivery in under 30 minutes for at least 99% of orders.'),
    },
    {
      term: tx('Read-to-write ratio'),
      plain: tx('The balance between requests that read existing data and requests that create or change data.'),
      example: tx('A news site where 99 people read an article for every 1 journalist who publishes one (99:1).'),
    },
    {
      term: tx('Complexity points'),
      plain: tx('A measure of how much ongoing effort an architecture takes to monitor, patch, and keep healthy.'),
      example: tx('Owning one simple bicycle vs maintaining a whole fleet of custom racing bikes by yourself.'),
    },
    {
      term: tx('Trade-off (cost vs reliability)'),
      plain: tx('Balancing spending and simplicity against speed and fault tolerance, because every extra part has a price.'),
      example: tx('Buying a spare tire for long road trips, but not towing a second car behind you.'),
    },
  ],
  learn: [tx('How to read monthly cost and complexity points alongside SLO results'), tx('Why an unused component still costs money and team attention'), tx('Why the read-to-write ratio decides when writes size the primary database'), tx('How to fund the capacity you need by cutting parts that do not help')],
  learnAt: [2, 3, 5, 6],
  recap: [tx('When a cache catches almost all clicks, a read replica behind it adds cost and complexity without helping.'), tx('Recalculate load whenever the read-to-write ratio shifts: only the primary database can handle writes.'), tx('Connections needed = writes per second × seconds per write.')],
  steps: [
    { kind: 'read', title: tx('Putting it all together'), text: tx('Real system design is never about building the biggest architecture possible. Every project starts with a brief—a list of user requirements, budget, and team size—and strict SLOs (service-level objectives, such as keeping p99 latency under 100 ms and errors under 1%).\n\nYour job is a trade-off between cost, reliability, and simplicity. Each extra component adds complexity points—a score for how much effort it takes to monitor, patch, and debug.'), key: tx('Good system design meets its SLO targets with the simplest, lowest-cost architecture that works.') },
    { kind: 'read', title: tx('A URL shortener for one person'), text: tx('Here is your brief: a URL shortener run by one person. Traffic is 3000 requests a second with a 99:1 read-to-write ratio (99% link clicks, 1% new links).\n\nRight now, Redis caches the hottest links, and the database has 8 connections (each write takes 8 ms) plus 1 read replica. The site works, but maintaining a read replica takes extra operational effort—pushing complexity past what one person can safely run. Press Run, then inspect the cost and complexity points in the Results tab.'), key: tx('Every component costs money and attention: keep only parts that earn their place.') },
    { kind: 'run', title: tx('Run the shortener'), look: { tab: 'results' } },
    { kind: 'challenge', title: tx('One person can run it'), challenges: ['capstone/solo-shortener'] },
    { kind: 'guess', title: tx('Guess: writes take over'), questions: ['writes-fail'] },
    { kind: 'run', title: tx('Run the write-heavy traffic'), scenario: 'hot-keys', look: { node: 'db' }, show: ['failRate', 'util:db', 'p99'] },
    { kind: 'challenge', title: tx('When writes take over'), challenges: ['capstone/write-heavy'] },
    { kind: 'practice', title: tx('Practice'), text: tx('Ready for full capstone practice? Briefs start from an empty canvas with only requirements, and constraint problems start from a broken design you must fix within limits.'), items: [{ kind: 'brief', id: 'brief-shortener' }, { kind: 'constraint', id: 'solo-shortener' }, { kind: 'constraint', id: 'spike-budget' }] },
  ],
};

export default capstone;
