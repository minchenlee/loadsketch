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
  intro: tx('The last unit puts it all together: estimate, build, run, read the result, and fix what breaks first, within money and complexity limits like a real team. Here: a URL shortener run by one person. 3000 requests a second, 99% clicks. It works, but it has a read replica, and one person cannot look after one. Press Run, then look at the cost and the complexity points.'),
  scenario: 'url-shortener',
  questions: [
    {
      id: 'writes-fail',
      scenario: 'hot-keys',
      topic: 'capacity',
      text: tx('The product grows: 3500 requests a second, and now 70% are writes (new links), the same design. What share of the requests fail?'),
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
      explain: tx('Every write goes to the primary database, and a cache or a read replica cannot take a write. 2450 writes a second × 8 ms ≈ 20 connections busy, and the primary has 8. The queue at the database fills up, and most requests fail. Count the load on each part again whenever the mix changes: here the writes, not the reads, set the size of the database.'),
      explainFor: {
        few: tx('Almost nothing failed: the primary database has enough connections for the writes.'),
        some: tx('Some failed: the primary has more connections than at the start, but not enough for all the writes.'),
      },
    },
  ],
  challenges: [
    {
      id: 'capstone/solo-shortener',
      title: tx('One person can run it'),
      text: tx('Same traffic. Fewer than 1% fail, p99 at most 100 ms, at most $2,200 a month and at most 6 complexity points. The parts are not faster than given.'),
      goals: limitGoals({ maxErrorRate: 0.01, maxP99Ms: 100, budgetPerMonth: 2200, maxPoints: 6 }, [tx('At most 1% of requests fail'), tx('p99 of successful requests at most 100 ms'), tx('At most $2,200 a month'), tx('At most 6 complexity points')]),
      rules: [givenParts],
      hint: tx('Look at the complexity points and the cost. The cache takes almost all clicks, so the database sees only the misses. What does the read replica add, then?'),
    },
    {
      id: 'capstone/write-heavy',
      scenario: 'hot-keys',
      title: tx('When writes take over'),
      text: tx('On the write-heavy traffic: fewer than 1% fail, p99 at most 200 ms, at most $2,450 a month and at most 6 complexity points. The parts are not faster than given.'),
      goals: limitGoals({ maxErrorRate: 0.01, maxP99Ms: 200, budgetPerMonth: 2450, maxPoints: 6 }, [tx('At most 1% of requests fail'), tx('p99 of successful requests at most 200 ms'), tx('At most $2,450 a month'), tx('At most 6 complexity points')]),
      rules: [givenParts],
      hint: tx('Work out the connections the writes need: writes a second × seconds a write takes. The primary is the only part that can take them, so make it larger. More API servers do not help: they wait for the database too. Then pay for it with the part that no longer earns its place.'),
    },
  ],
  steps: [
    { kind: 'read', text: tx('The last unit puts it all together: estimate, build, run, read the result, and fix what breaks first, within money and complexity limits like a real team. Here: a URL shortener run by one person. 3000 requests a second, 99% clicks. It works, but it has a read replica, and one person cannot look after one. Press Run, then look at the cost and the complexity points.') },
    { kind: 'run' },
    { kind: 'challenge', challenges: ['capstone/solo-shortener'] },
    { kind: 'guess', questions: ['writes-fail'] },
    { kind: 'run', scenario: 'hot-keys' },
    { kind: 'challenge', challenges: ['capstone/write-heavy'] },
    { kind: 'practice', text: tx('Now the full problems: the brief starts from an empty canvas, and the constraint problem from a design that fails.'), items: [{ kind: 'brief', id: 'brief-shortener' }, { kind: 'constraint', id: 'solo-shortener' }, { kind: 'constraint', id: 'spike-budget' }] },
  ],
};

export default capstone;
