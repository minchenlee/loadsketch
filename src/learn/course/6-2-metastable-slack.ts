// 6.2 Capstone: a metastable failure (saas-slack, after Slack's incident of 2022-02-22).
import { t, tx } from '../../i18n/index.ts';
import { noMoreCapacity, type Goal, type Lesson } from '../lesson.ts';
import { ms, pct } from '../lessonKit.ts';
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
  title: tx('Capstone: a failure that does not end with its cause'),
  unit: 6,
  order: 2,
  minutes: 40,
  wave: 1,
  example: 'saas-slack',
  intro: tx('A chat service modelled on Slack’s incident of 22 February 2022, scaled down. 8000 requests a second: started clients send and read messages, starting clients send a boot query. Reads check the cache first and the sharded database only on a miss. At second 45 half of the cache nodes are replaced by empty ones; at second 55 they are back, but cold. Clients retry failed requests. Guess, then press Run.'),
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
      explain: tx('With 70% hits the database takes about 30% of the reads. Lose half the cache and the misses about double: the database needs about twice the connections it has. Its queue fills, calls time out, and the webapp and the clients retry, so the database gets even more. A cache that carries most of the reads is part of the capacity: losing it is like losing machines.'),
      explainFor: {
        yes: tx('The database held: it has enough spare connections for the misses of an empty cache.'),
      },
    },
    {
      id: 'after-trigger',
      topic: 'recovery',
      text: tx('The cache nodes are back at second 55. From second 70 to the end, is the p99 of successful requests back to normal, under 300 ms?'),
      options: [
        { id: 'yes', text: tx('Yes: the system recovers once the cause is gone') },
        { id: 'no', text: tx('No: it stays slow long after') },
      ],
      answer: (run) => (after(run).p99 < 300 ? 'yes' : 'no'),
      measured: (run) => t('Highest p99 in one second after second 70: {v}', { v: ms(after(run).p99) }),
      explain: tx('This is a metastable failure: the cause is gone, but the system stays in the bad state. The cold cache misses, so the database is busy; a busy database times out, so the cache does not fill again, and the retries add more load. The loop keeps itself going. To get out you must take load away, for a while, from outside the loop: Slack limited the boot queries.'),
      explainFor: {
        yes: tx('It recovered: something broke the loop (less load on the database, or enough spare capacity to fill the cache again).'),
      },
    },
  ],
  challenges: [
    {
      id: 'saas-slack/break-the-loop',
      title: tx('Break the loop'),
      text: tx('Without more machines: after second 70 the p99 is under 300 ms, fewer than 3% of the started clients’ requests fail, and at least 20% of boot queries still succeed.'),
      goals: [
        afterP99Under(300, tx('p99 after second 70 under 300 ms')),
        { text: tx('Fewer than 3% of the started clients’ requests fail'), check: (run) => ({ ok: clientFailShare(run, 'active') < 0.03, value: pct(clientFailShare(run, 'active')) }) },
        { text: tx('At least 20% of boot queries succeed'), check: (run) => ({ ok: bootOk(run) >= 0.2, value: pct(bootOk(run)) }) },
      ],
      rules: [noMoreCapacity],
      hint: tx('Starting clients can wait; started clients cannot. The boot rate limit applies only to the boot queries: give it a per-second limit low enough that the database gets out of the loop, but not so low that almost nobody can start.'),
    },
  ],
  steps: [
    { kind: 'read', text: tx('A chat service modelled on Slack’s incident of 22 February 2022, scaled down. 8000 requests a second: started clients send and read messages, starting clients send a boot query. Reads check the cache first and the sharded database only on a miss. At second 45 half of the cache nodes are replaced by empty ones; at second 55 they are back, but cold. Clients retry failed requests. Guess, then press Run.') },
    { kind: 'guess', questions: ['db-hold', 'after-trigger'] },
    { kind: 'run' },
    { kind: 'try', text: tx('Set the per-second limit of “Boot rate limit” to 300 and run again. After second 70 the p99 is back to about 100 ms, and far fewer started clients fail. The price: most boot queries are turned away. Rate limiting chooses who waits.'), patch: [{ node: 'bootlimit', params: { ratePerSec: 300, burst: 300 } }] },
    { kind: 'try', text: tx('Undo that, and set the cache’s stampede protection to lease instead. It helps only a little here: the database is short of capacity, not flooded by many reads of the same key.'), patch: [{ node: 'mcrouter', params: { stampede: 'lease' } }] },
    { kind: 'challenge', challenges: ['saas-slack/break-the-loop'] },
    { kind: 'practice', items: [{ kind: 'oncall', id: 'cache-down' }, { kind: 'oncall', id: 'traffic-spike' }, { kind: 'constraint', id: 'retry-budget' }] },
  ],
};

export default metastable;
