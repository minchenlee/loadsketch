// 6.2 Incident replay: a metastable failure (saas-slack, after Slack's incident of 2022-02-22).
import { t, tx } from '../../i18n/index.ts';
import { noMoreCapacity, type Goal, type Lesson } from '../lesson.ts';
import { errorsUnder, ms, pct } from '../lessonKit.ts';
import { clientFailShare } from '../lessonKit2.ts';
import type { RunData } from '../metrics.ts';

const AFTER = 70; // from here the trigger is long gone

/** Failure share and highest one-second p99 of the users' requests in (from, to]. */
const between = (run: RunData, from: number, to: number) => {
  let n = 0;
  let f = 0;
  let p99 = 0;
  for (const w of run.windows) {
    if (w.t <= from || w.t > to) continue;
    const fail = Object.values(w.fail).reduce((a, b) => a + b, 0);
    n += w.ok + fail;
    f += fail;
    if (w.latency.count > 0) p99 = Math.max(p99, w.latency.p99);
  }
  return { err: n > 0 ? f / n : 0, p99 };
};
const end = (run: RunData) => run.scenario.durationS ?? Infinity;
const during = (run: RunData) => between(run, 45, AFTER);
const after = (run: RunData) => between(run, AFTER, end(run));
const bootOk = (run: RunData) => 1 - clientFailShare(run, 'boot');

const afterP99Under = (limit: number, text: string): Goal => ({
  text,
  check: (run) => ({ ok: after(run).p99 < limit, value: ms(after(run).p99) }),
});

const metastable: Lesson = {
  id: '6.2',
  title: tx('Incident replay: Slack 2022, a failure that outlives its cause'),
  unit: 6,
  order: 2,
  minutes: 25,
  wave: 1,
  example: 'saas-slack',
  intro: tx('Sometimes a system stays broken long after the original trigger is gone—a metastable failure, like a traffic jam that stays gridlocked long after the accident clears.\n\nThis chat service is modeled on Slack’s February 22, 2022 outage, scaled down. It handles 8000 requests a second: connected clients send and read messages, while booting clients send a heavy boot query to load their workspace. Reads check the cache first (~70% hit rate normally) and the sharded database only on a miss.\n\nAt second 45, half the cache nodes are replaced by empty ones (a cache flush / cold start storm); at second 55 they return, still cold. Clients retry failed requests. Guess what happens, then press Run.'),
  scenario: 'saas-slack',
  questions: [
    {
      id: 'db-hold',
      topic: 'cache',
      text: tx('Half of the cache turns empty for 10 seconds, sending many more misses to the database. From second 45 to 70, can the database hold?'),
      options: [
        { id: 'yes', text: tx('Yes: fewer than 5% of requests fail') },
        { id: 'no', text: tx('No: more than 5% fail') },
      ],
      answer: (run) => (during(run).err < 0.05 ? 'yes' : 'no'),
      measured: (run) => t('{p} of requests failed from second 45 to 70', { p: pct(during(run).err) }),
      explain: tx('Losing half the cache roughly doubles the reads hitting the database. The database needs about twice as many connections as it has.\n\nIts queue fills up, calls time out, and both the web app and clients retry—piling even more load onto the database. When a cache carries most of your reads, it acts as core capacity: losing it is like losing database machines.'),
      calc: [tx('Normal cache hit rate ~70%: database serves 30% of reads'), tx('Half the cache empty: ~30% + (70% ÷ 2) = 65% miss rate'), tx('Database read load roughly doubles')],
      look: { node: 'vitess' },
      explainFor: {
        yes: tx('The database held because it had enough spare connections to absorb the cold-cache misses.'),
      },
    },
    {
      id: 'after-trigger',
      topic: 'recovery',
      text: tx('All cache nodes are back online at second 55. From second 70 to the end, does every second’s p99 stay under 300 ms?'),
      options: [
        { id: 'yes', text: tx('Yes: the system recovers once the trigger is gone') },
        { id: 'no', text: tx('No: it stays slow long after') },
      ],
      answer: (run) => (after(run).p99 < 300 ? 'yes' : 'no'),
      measured: (run) => t('Highest p99 in one second after second 70: {v}', { v: ms(after(run).p99) }),
      explain: tx('This is a textbook metastable failure: the trigger ended at second 55, yet the system stays stuck in an outage.\n\nA self-sustaining feedback loop traps it: the cold cache misses, overloading the database. The overloaded database times out, so replies never return to refill the cache. Meanwhile, client retries keep hammering the database.\n\nThe loop feeds itself. To break it, you must cut load from outside the loop long enough for the database to recover and refill the cache—which is why Slack rate-limited boot queries.'),
      look: { panel: 'bottom' },
      explainFor: {
        yes: tx('The system recovered because something broke the feedback loop—either lower load on the database or enough spare capacity to refill the cache.'),
      },
    },
  ],
  challenges: [
    {
      id: 'saas-slack/break-the-loop',
      title: tx('Break the loop'),
      text: tx('Break the metastable loop without adding machines.\n\nAfter second 70, keep every second’s p99 under 300 ms. Keep connected clients’ failures under 3%, while still letting at least 20% of boot queries succeed.'),
      goals: [
        afterP99Under(300, tx('Every second after second 70: p99 under 300 ms')),
        { text: tx('Fewer than 3% of the connected clients’ requests fail'), check: (run) => ({ ok: clientFailShare(run, 'active') < 0.03, value: pct(clientFailShare(run, 'active')) }) },
        { text: tx('At least 20% of boot queries succeed'), check: (run) => ({ ok: bootOk(run) >= 0.2, value: pct(bootOk(run)) }) },
        errorsUnder(0.3, tx('Under 30% of all requests fail, turned-away boot queries included')),
      ],
      rules: [noMoreCapacity],
      hint: tx('Booting clients can wait a moment to open the app; connected clients are actively chatting and cannot be dropped.\n\n“Boot rate limit (added during the incident)” only limits boot queries. Set its “Limit per second” low enough to let the database escape the loop and refill the cache, but high enough that at least 20% of booting clients still get in.'),
    },
  ],
  terms: [
    {
      term: tx('Metastable failure'),
      plain: tx('A failure state where a system stays broken even after the original trigger is gone, kept alive by a feedback loop.'),
      example: tx('A highway traffic jam that stays gridlocked long after the original accident has been cleared.'),
    },
    {
      term: tx('Cache flush (cold start storm)'),
      plain: tx('A sudden flood of database reads caused when an empty or restarted cache misses on almost every request.'),
      example: tx('Every librarian forgetting where the popular books are at once, forcing a huge line at the main archive.'),
    },
    {
      term: tx('Feedback loop'),
      plain: tx('A cycle where a slowdown creates extra work—like retries and timeouts—that makes the slowdown even worse.'),
      example: tx('Pressing refresh over and over on a slow ticket site, which adds more traffic and makes the site even slower.'),
    },
    {
      term: tx('Boot query'),
      plain: tx('The heavy initial request a chat or app client sends when it first opens to load workspace data.'),
      example: tx('Opening your desk in the morning and pulling out every folder you need before answering a single email.'),
    },
  ],
  learn: [tx('Why emptying a warm cache hits the database like losing machines'), tx('How a feedback loop creates a metastable failure that outlives its cause'), tx('How rate limiting from outside the loop breaks it, and who pays'), tx('Why stampede protection cannot fix a broad cold-cache capacity shortage')],
  learnAt: [3, 3, 4, 5],
  recap: [tx('A cache that carries most of your reads is part of your capacity: a cache flush hits like losing servers.'), tx('A cold cache, overloaded database, timeouts, and retries form a feedback loop that outlives the original trigger.'), tx('To escape a metastable failure, cut load from outside the loop—rate limiting lets you choose which traffic waits.')],
  steps: [
    { kind: 'read', title: tx('The incident'), text: tx('Most outages end as soon as you fix whatever broke. Sometimes, though, a system stays stuck in a broken state long after the original cause is gone. That is a metastable failure—like a traffic jam that stays gridlocked long after the accident clears.\n\nThis chat service is modeled on Slack’s real outage of February 22, 2022, scaled down. It handles 8000 requests a second from two groups: connected clients (people already chatting) and booting clients (people opening the app, which sends a heavy boot query to load their workspace).\n\nReads check the cache first and hit the sharded database only on a miss. Normally, the cache catches about 70% of reads, leaving the database with little spare room.'), key: tx('A metastable failure stays broken even after the original trigger is completely gone.') },
    { kind: 'read', title: tx('The trigger: a cold cache'), text: tx('At second 45, half of the cache nodes are suddenly replaced by empty machines. At second 55, all cache nodes are back online—but the replaced ones are cold (empty).\n\nEmptying a warm cache causes a cache flush (cold start storm): thousands of reads miss at once and flood the database. Meanwhile, clients automatically retry failed requests. Guess whether the database holds up, and whether the system heals afterward. Then press Run.'), key: tx('A cache that carries most of your reads is part of your capacity: emptying it floods the database.') },
    { kind: 'guess', title: tx('Guess: the database, and after'), questions: ['db-hold', 'after-trigger'] },
    { kind: 'run', title: tx('Run the incident'), look: { panel: 'bottom' }, show: ['p99', 'clientFail:active', 'clientFail:boot'] },
    { kind: 'try', title: tx('Limit the boot queries'), text: tx('Set “Limit per second” on “Boot rate limit (added during the incident)” to 300 and run again.\n\nWatch the charts: does p99 recover after second 70? Which group of users pays the price so everyone else can chat?'), patch: [{ node: 'bootlimit', params: { ratePerSec: 300, burst: 300 } }], look: { panel: 'bottom' }, show: ['p99', 'clientFail:active', 'clientFail:boot'] },
    { kind: 'try', title: tx('Try lease instead'), text: tx('Set “Limit per second” on “Boot rate limit (added during the incident)” back to 100000, and change the cache’s “Stampede protection” to “Lease (cache-aside)”. Run again.\n\nDoes lease help as much as limiting boot queries? Is the database flooded by many reads of one hot key, or simply short of capacity across thousands of cold keys?'), patch: [{ node: 'bootlimit', params: { ratePerSec: 100000, burst: 100000 } }, { node: 'mcrouter', params: { stampede: 'lease' } }], look: { panel: 'bottom' }, show: ['p99', 'clientFail:active', 'hitRatio'] },
    { kind: 'challenge', title: tx('Break the loop'), challenges: ['saas-slack/break-the-loop'] },
    { kind: 'practice', title: tx('Practice'), items: [{ kind: 'oncall', id: 'cache-down' }, { kind: 'oncall', id: 'traffic-spike' }, { kind: 'constraint', id: 'retry-budget' }] },
  ],
};

export default metastable;
