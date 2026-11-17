// 2.4 Replication lag (replica-lag / read-after-write): replicas serve old data for keys written in
// the last few hundred ms; hot keys are written all the time, so many replica reads are stale. A lag
// limit sends the reads back to the primary. (This scenario has no user sessions, so read-your-writes
// has nothing to act on; the lesson leaves it out.)
import { t, tx } from '../../i18n/index.ts';
import { noMoreCapacity, type Goal, type Lesson } from '../lesson.ts';
import type { RunData } from '../metrics.ts';
import { pct } from '../lessonKit.ts';

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
      goals: [noStale, { text: tx('Primary under 25% busy'), check: (run) => ({ ok: primaryBusy(run) < 0.25, value: pct(primaryBusy(run)) }) }],
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
      ],
      rules: [noMoreCapacity],
      hint: tx('A lag limit cannot help: it moves the reads off the replicas. The lag itself has to shrink: replicas close to the primary, confirming writes quickly (semi-synchronous replication). Lower “Replication lag” and see how far it must go: the hottest keys are written every few ms.'),
    },
  ],
  steps: [
    { kind: 'read', text: INTRO },
    { kind: 'guess', questions: ['stale-share'] },
    { kind: 'run' },
    { kind: 'guess', questions: ['primary-busy'] },
    { kind: 'try', text: tx('Set “Max replication lag” to 200 ms and run again: stale reads drop to zero, and the primary takes every read.'), patch: [{ node: 'db', params: { maxLagMs: 200 } }] },
    { kind: 'try', text: tx('Put the lag limit back to 0 and set “Replication lag” to 50 ms: fewer reads are stale, but not few, because the hot keys are written more often than every 50 ms.'), patch: [{ node: 'db', params: { maxLagMs: 0, replicaDelayMs: 50 } }] },
    { kind: 'challenge', challenges: ['replicas/no-stale', 'replicas/keep-replicas'] },
  ],
};

export default lesson;
