// 2.4 Replication lag (replica-lag / read-after-write): replicas serve old data for keys written in
// the last few hundred ms; hot keys are written all the time, so many replica reads are stale. A lag
// limit sends the reads back to the primary. (This scenario has no user sessions, so read-your-writes
// has nothing to act on; the lesson leaves it out.)
import { t, tx } from '../../i18n/index.ts';
import { noMoreCapacity, type Goal, type Lesson } from '../lesson.ts';
import type { RunData } from '../metrics.ts';
import { failUnder1, pct } from '../lessonKit.ts';

const INTRO = tx('All reads go to two Postgres replicas. A write reaches the replicas about 300 ms after the primary finishes it (replication lag). Users send 800 requests a second, 20% of them writes, and the same popular keys are written and read all the time. Guess how often a replica returns old data, then press Run.');

const db = (run: RunData) => run.result.nodes.db;
/** Share of replica reads that returned old data (0 when the replicas served no reads). */
export const staleShare = (run: RunData) => {
  const n = db(run);
  return n?.replicaReads ? (n.staleReads ?? 0) / n.replicaReads : 0;
};
/** Share of all database requests that a replica served. */
const replicaShare = (run: RunData) => {
  const n = db(run);
  return n?.arrivals ? (n.replicaReads ?? 0) / n.arrivals : 0;
};
/** Utilisation of the primary (instance 0). */
export const primaryBusy = (run: RunData) => db(run)?.instances?.[0]?.utilization ?? 0;

const noStale: Goal = {
  text: tx('No stale reads'),
  check: (run) => ({ ok: (db(run)?.staleReads ?? 0) === 0, value: String(db(run)?.staleReads ?? 0) }),
};

const lesson: Lesson = {
  id: '2.4',
  title: tx('Replication lag'),
  unit: 2,
  order: 4,
  minutes: 20,
  wave: 1,
  learn: [
    tx("See what replication lag does to replica reads"),
    tx("See why the hottest keys are stale most often"),
    tx("See what a lag limit costs the primary"),
    tx("See why a shorter lag does not fix keys that keep changing"),
  ],
  learnAt: [2, 2, 4, 5],
  recap: [
    tx("Replicas are eventually consistent: a key that keeps changing is often stale."),
    tx("A lag limit sends the reads back to the primary: fresh reads cost primary capacity."),
    tx("Replicas help only for reads that can be a little old."),
  ],
  example: 'replica-lag',
  scenario: 'read-after-write',
  intro: INTRO,
  questions: [
    {
      id: 'stale-share',
      topic: 'other',
      text: tx('Of the reads a replica serves, what share return data older than the primary has?'),
      options: [
        { id: 'few', text: tx('Under 5%') },
        { id: 'some', text: tx('5% to 25%') },
        { id: 'many', text: tx('More than 25%') },
      ],
      answer: (run) => {
        const s = staleShare(run);
        return s < 0.05 ? 'few' : s <= 0.25 ? 'some' : 'many';
      },
      measured: (run) => t('{stale} of {reads} replica reads were stale ({s})', { stale: db(run)?.staleReads ?? 0, reads: db(run)?.replicaReads ?? 0, s: pct(staleShare(run)) }),
      calc: [tx('800 requests/s × 20% = 160 writes/s'), tx('A read is stale if its key was written in the last 300 ms')],
      explain: tx('A read is stale when its key was written in the last 300 ms. With 160 writes a second landing mostly on the same popular keys, those keys are almost always inside that window, so the reads people make most are the ones most often stale. Replicas are eventually consistent: they catch up, but never for a key that keeps changing.'),
      explainFor: {
        few: tx('Few are stale: the replicas are only a few ms behind, so a key is rarely read inside its lag window.'),
        some: tx('Some are stale: a shorter lag narrows the window, but the hottest keys are written so often that they still fall inside it.'),
      },
    },
    {
      id: 'primary-busy',
      topic: 'capacity',
      text: tx('Set “Max replication lag” to 200 ms: a replica that is further behind stops taking reads, and the primary takes them. How busy does the primary get?'),
      options: [
        { id: 'low', text: tx('Under 10%') },
        { id: 'mid', text: tx('10% to 30%') },
        { id: 'high', text: tx('More than 30%') },
      ],
      answer: (run) => {
        const u = primaryBusy(run);
        return u < 0.1 ? 'low' : u <= 0.3 ? 'mid' : 'high';
      },
      measured: (run) => t('Primary {u} busy; replicas served {r} of the requests', { u: pct(primaryBusy(run)), r: pct(replicaShare(run)) }),
      explain: tx('The lag here is always about 300 ms, so with a 200 ms limit the replicas never qualify: every read goes to the primary, the same as reading the primary only. Its load more than doubles. Fresh reads cost primary capacity; the replicas only help for reads that can be a little old.'),
      explainFor: {
        low: tx('The primary is still lightly loaded: the replicas are within the limit and keep taking the reads.'),
      },
    },
  ],
  challenges: [
    {
      id: 'replicas/no-stale',
      title: tx('No old data'),
      text: tx('No read may return old data, and the primary must stay under 25% busy. Do not add machines.'),
      // a database that fails every read returns nothing stale: the reads must succeed too (review of 9fd99c3)
      goals: [noStale, { text: tx('Primary under 25% busy'), check: (run) => ({ ok: primaryBusy(run) < 0.25, value: pct(primaryBusy(run)) }) }, failUnder1],
      rules: [noMoreCapacity],
      hint: tx('Every replica read can be stale while the replicas are 300 ms behind. Stop them taking reads when they lag, and check the primary can carry the reads alone.'),
    },
    {
      id: 'replicas/keep-replicas',
      title: tx('Keep the replicas busy'),
      text: tx('Keep at least half of all database requests on the replicas, with under 5% of replica reads stale.'),
      goals: [
        { text: tx('Replicas serve at least half of the requests'), check: (run) => ({ ok: replicaShare(run) >= 0.5, value: pct(replicaShare(run)) }) },
        { text: tx('Under 5% of replica reads stale'), check: (run) => ({ ok: staleShare(run) < 0.05, value: pct(staleShare(run)) }) },
        failUnder1,
      ],
      rules: [noMoreCapacity],
      hint: tx('A lag limit cannot help: it moves the reads off the replicas. The lag itself has to shrink: replicas close to the primary, confirming writes quickly (semi-synchronous replication). Lower “Replication lag” and see how far it must go: the hottest keys are written every few ms.'),
    },
  ],
  steps: [
    { kind: 'read', title: tx('Reads from replicas'), text: INTRO, key: tx('A replica read is stale when its key was written within the lag.') },
    { kind: 'guess', title: tx('Stale reads'), questions: ['stale-share'] },
    { kind: 'run', title: tx('Run'), show: ['staleReads', 'busiestInstance:db', 'failRate'] },
    { kind: 'guess', title: tx('A lag limit'), questions: ['primary-busy'] },
    { kind: 'try', title: tx('Max lag 200 ms'), text: tx('Set “Max replication lag” to 200 ms and run again. How many reads are stale now, and how busy is the primary?'), patch: [{ node: 'db', params: { maxLagMs: 200 } }], show: ['staleReads', 'busiestInstance:db', 'failRate'], look: { node: 'db' } },
    { kind: 'try', title: tx('A shorter lag'), text: tx('Put the lag limit back to 0 and set “Replication lag” to 50 ms. Run again: how many reads are stale now?'), patch: [{ node: 'db', params: { maxLagMs: 0, replicaDelayMs: 50 } }], show: ['staleReads', 'busiestInstance:db', 'failRate'] },
    { kind: 'challenge', title: tx('Two challenges'), challenges: ['replicas/no-stale', 'replicas/keep-replicas'] },
  ],
};

export default lesson;
