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
  intro: tx('A chat service modeled on Slack’s incident of 22 February 2022, scaled down. 8000 requests a second: connected clients send and read messages, booting clients send a boot query. Reads check the cache first and the sharded database only on a miss. At second 45 half of the cache nodes are replaced by empty ones; at second 55 they are back, but cold. Clients retry failed requests. Guess, then press Run.'),
  scenario: 'saas-slack',
  questions: [
    {
      id: 'db-hold',
      topic: 'cache',
      text: tx('Half of the cache is empty for 10 seconds, so many more reads go to the database. From second 45 to 70, can the database hold?'),
      options: [
        { id: 'yes', text: tx('Yes: fewer than 5% of requests fail') },
        { id: 'no', text: tx('No: more than 5% fail') },
      ],
      answer: (run) => (during(run).err < 0.05 ? 'yes' : 'no'),
      measured: (run) => t('{p} of requests failed from second 45 to 70', { p: pct(during(run).err) }),
      explain: tx('Without half the cache, about twice as many reads miss: the database needs about twice the connections it has. Its queue fills, calls time out, and the webapp and the clients retry, so the database gets even more. A cache that carries most of the reads is part of the capacity: losing it is like losing machines.'),
      calc: [tx('Hits 70%: the database gets 30% of the reads'), tx('Half the cache empty: about 30% + 70% ÷ 2 = 65% miss'), tx('About twice as many reads at the database')],
      look: { node: 'vitess' },
      explainFor: {
        yes: tx('The database held: it has enough spare connections for the misses of an empty cache.'),
      },
    },
    {
      id: 'after-trigger',
      topic: 'recovery',
      text: tx('The cache nodes are back at second 55. From second 70 to the end, does the p99 of every second stay under 300 ms?'),
      options: [
        { id: 'yes', text: tx('Yes: the system recovers once the cause is gone') },
        { id: 'no', text: tx('No: it stays slow long after') },
      ],
      answer: (run) => (after(run).p99 < 300 ? 'yes' : 'no'),
      measured: (run) => t('Highest p99 in one second after second 70: {v}', { v: ms(after(run).p99) }),
      explain: tx('This is a metastable failure: the cause is gone, but the system stays in the bad state. The cold cache misses, so the database is busy; a busy database times out, so the cache does not fill again, and the retries add more load. The loop keeps itself going. To get out you must take load away, for a while, from outside the loop: Slack limited the boot queries.'),
      look: { panel: 'bottom' },
      explainFor: {
        yes: tx('It recovered: something broke the loop (less load on the database, or enough spare capacity to fill the cache again).'),
      },
    },
  ],
  challenges: [
    {
      id: 'saas-slack/break-the-loop',
      title: tx('Break the loop'),
      text: tx('Without more machines: after second 70 the p99 of every second is under 300 ms, fewer than 3% of the connected clients’ requests fail, and at least 20% of boot queries still succeed.'),
      goals: [
        afterP99Under(300, tx('Every second after second 70: p99 under 300 ms')),
        { text: tx('Fewer than 3% of the connected clients’ requests fail'), check: (run) => ({ ok: clientFailShare(run, 'active') < 0.03, value: pct(clientFailShare(run, 'active')) }) },
        { text: tx('At least 20% of boot queries succeed'), check: (run) => ({ ok: bootOk(run) >= 0.2, value: pct(bootOk(run)) }) },
        errorsUnder(0.3, tx('Under 30% of all requests fail, turned-away boot queries included')),
      ],
      rules: [noMoreCapacity],
      hint: tx('Booting clients can wait; connected clients cannot. The boot rate limit applies only to the boot queries: give it a per-second limit low enough that the database gets out of the loop, but not so low that almost nobody can start.'),
    },
  ],
  learn: [tx('Why losing a cache is like losing machines'), tx('What a metastable failure is: a loop that keeps itself going'), tx('How a rate limit from outside the loop breaks it, and who pays'), tx('Why stampede protection does not fix a shortage of capacity')],
  learnAt: [3, 3, 4, 5],
  recap: [tx('A cache that carries most of the reads is part of the capacity.'), tx('A cold cache, a busy database, timeouts and retries feed each other: the loop outlives its cause.'), tx('To get out, take load away from outside the loop for a while: rate limiting chooses who waits.')],
  steps: [
    { kind: 'read', title: tx('The incident'), text: tx('A chat service modeled on Slack’s incident of 22 February 2022, scaled down. 8000 requests a second: connected clients send and read messages, booting clients send a boot query. Reads check the cache first and the sharded database only on a miss.') },
    { kind: 'read', title: tx('The trigger'), text: tx('At second 45 half of the cache nodes are replaced by empty ones; at second 55 they are back, but cold. Clients retry failed requests. Guess, then press Run.'), key: tx('A metastable failure goes on after its cause is gone.') },
    { kind: 'guess', title: tx('Guess: the database, and after'), questions: ['db-hold', 'after-trigger'] },
    { kind: 'run', title: tx('Run the incident'), look: { panel: 'bottom' }, show: ['p99', 'clientFail:active', 'clientFail:boot'] },
    { kind: 'try', title: tx('Limit the boot queries'), text: tx('Set the per-second limit of “Boot rate limit (added during the incident)” to 300 and run again. In the charts: does the p99 come back after second 70? Who pays for it?'), patch: [{ node: 'bootlimit', params: { ratePerSec: 300, burst: 300 } }], look: { panel: 'bottom' }, show: ['p99', 'clientFail:active', 'clientFail:boot'] },
    { kind: 'try', title: tx('Lease instead'), text: tx('Set the per-second limit of “Boot rate limit (added during the incident)” back to 100000, and set the cache’s stampede protection to lease instead. Run again. Does it help as much as the boot limit? Is the database short of capacity, or flooded by reads of the same key?'), patch: [{ node: 'bootlimit', params: { ratePerSec: 100000, burst: 100000 } }, { node: 'mcrouter', params: { stampede: 'lease' } }], look: { panel: 'bottom' }, show: ['p99', 'clientFail:active', 'hitRatio'] },
    { kind: 'challenge', title: tx('Break the loop'), challenges: ['saas-slack/break-the-loop'] },
    { kind: 'practice', title: tx('Practice'), items: [{ kind: 'oncall', id: 'cache-down' }, { kind: 'oncall', id: 'traffic-spike' }, { kind: 'constraint', id: 'retry-budget' }] },
  ],
};

export default metastable;
