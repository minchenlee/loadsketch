// 2.4 Replication lag (replica-lag / read-after-write): replicas serve old data for keys written in
// the last few hundred ms; hot keys are written all the time, so many replica reads are stale. A lag
// limit sends the reads back to the primary. (This scenario has no user sessions, so read-your-writes
// has nothing to act on; the lesson leaves it out.)
import { t, tx } from '../../i18n/index.ts';
import { noMoreCapacity, type Goal, type Lesson } from '../lesson.ts';
import type { RunData } from '../metrics.ts';
import { failUnder1, pct } from '../lessonKit.ts';

const INTRO = tx('When one database gets too many reads, teams add read-only copies called read replicas to share the read traffic. The original database is the primary database: it handles every write and copies each change to the replicas.\n\nCopying data across machines takes time. The delay between a write finishing on the primary and that update appearing on a replica is called replication lag — like a branch store whose price board updates a few seconds after headquarters changes a price. If a user reads from a replica before the latest update arrives, they receive old data. That is a stale read.\n\nIn this design, Postgres has one primary and two read replicas, and all reads go to the replicas. Replication lag is about 300 ms. Users send 800 requests a second, and 20% of them are writes. The same popular keys are written and read constantly. Guess how often a replica returns old data, then press Run.');

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
/** Utilization of the primary (instance 0). */
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
    tx('See how replication lag causes stale reads'),
    tx('See why popular keys are stale most often'),
    tx('See how a lag limit shifts load back to the primary'),
    tx('See why even a shorter lag struggles with constantly changing keys'),
  ],
  learnAt: [2, 2, 4, 5],
  recap: [
    tx('Read replicas lag behind the primary, so keys that change constantly are often stale.'),
    tx('A lag limit protects freshness by sending reads back to the primary, which uses up primary capacity.'),
    tx('Read replicas work best for reads that can tolerate slightly older data.'),
  ],
  terms: [
    {
      term: tx('Primary database'),
      plain: tx('The main database copy that accepts all writes and holds the latest data.'),
      example: tx('A retail chain’s headquarters where official prices are updated first.'),
    },
    {
      term: tx('Read replica'),
      plain: tx('A read-only copy of the primary database that shares read traffic.'),
      example: tx('A branch store displaying a copy of the price list so shoppers do not all have to call headquarters.'),
    },
    {
      term: tx('Replication lag'),
      plain: tx('The delay between a write finishing on the primary and that change appearing on a read replica.'),
      example: tx('A few seconds of delay before a branch store’s price board updates after headquarters changes a price.'),
    },
    {
      term: tx('Stale read'),
      plain: tx('Reading outdated data from a replica before the latest write has arrived there.'),
      example: tx('A shopper checking the branch price board a second after headquarters raised the price and seeing the old price.'),
    },
  ],
  example: 'replica-lag',
  scenario: 'read-after-write',
  intro: INTRO,
  questions: [
    {
      id: 'stale-share',
      topic: 'other',
      text: tx('Out of all the reads served by a replica, what share return older data than the primary holds?'),
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
      calc: [
        tx('800 requests/s × 20% = 160 writes/s'),
        tx('Simulator rule: a replica read is stale whenever that replica still has an unapplied write for that same key (~300 ms behind here)'),
      ],
      explain: tx('In this simulator, a replica read is counted as stale whenever that key still has an unapplied write on its way to the replica (here, replication lag is ~300 ms).\n\nBecause 160 writes a second land mostly on the same popular keys, those keys almost always have an unapplied write in flight, so the items users read most are also stale most often. Replicas catch up once writes stop (called eventual consistency), while a key that keeps changing stays behind.'),
      explainFor: {
        few: tx('Few reads are stale because the replicas are only a few milliseconds behind, so a read rarely lands inside the lag window.'),
        some: tx('Some reads are stale. A shorter lag shrinks the window, but the hottest keys are written so often that they still fall inside it.'),
      },
    },
    {
      id: 'primary-busy',
      topic: 'capacity',
      text: tx('Suppose you set “Max replication lag” to 200 ms. Any replica further behind than 200 ms stops taking reads, and the primary handles them instead. How busy will the primary get?'),
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
      explain: tx('The simulator measures each replica’s lag using the age of its oldest unapplied write. In this scenario, continuous writes keep both replicas ~300 ms behind, so neither meets the 200 ms limit: replicas serve the share shown in Measured above and reads fall back to the primary, raising its busyness as Measured shows.\n\nNote that a lag limit only bounds how far behind a replica may fall—it does not guarantee every individual read is fresh unless reads fall back to the primary. Protecting freshness costs primary capacity, so read replicas only help for reads that can safely be slightly behind.'),
      explainFor: {
        low: tx('The primary stays lightly loaded because the replicas stay within the lag limit and keep handling reads.'),
      },
    },
  ],
  challenges: [
    {
      id: 'replicas/no-stale',
      title: tx('No old data'),
      text: tx('Return zero stale reads while keeping the primary under 25% busy and the error rate under 1%. Do not add machines.'),
      // a database that fails every read returns nothing stale: the reads must succeed too (review of 9fd99c3)
      goals: [noStale, { text: tx('Primary under 25% busy'), check: (run) => ({ ok: primaryBusy(run) < 0.25, value: pct(primaryBusy(run)) }) }, failUnder1],
      rules: [noMoreCapacity],
      hint: tx('While the replicas lag by 300 ms, any replica read can return old data. Select Postgres and either set “Max replication lag” below 300 ms or set “Read source” to “Primary only”, then check whether the primary can handle the reads alone.'),
    },
    {
      id: 'replicas/keep-replicas',
      title: tx('Keep the replicas busy'),
      text: tx('Keep at least half of all database requests on the replicas, with under 5% of replica reads stale and error rate under 1%. Do not add machines.'),
      goals: [
        { text: tx('Replicas serve at least half of the requests'), check: (run) => ({ ok: replicaShare(run) >= 0.5, value: pct(replicaShare(run)) }) },
        { text: tx('Under 5% of replica reads stale'), check: (run) => ({ ok: staleShare(run) < 0.05, value: pct(staleShare(run)) }) },
        failUnder1,
      ],
      rules: [noMoreCapacity],
      hint: tx('A lag limit cannot solve this challenge because it pushes reads off the replicas and onto the primary.\n\nInstead, you must shrink the lag itself — like keeping replicas close to the primary so updates arrive much faster. Select Postgres, lower “Replication lag”, and see how small it needs to be when popular keys change every few milliseconds.'),
    },
  ],
  steps: [
    { kind: 'read', title: tx('Reads from replicas'), text: INTRO, key: tx('In this simulator, a replica read is stale whenever that replica has not yet applied the latest write for that key.') },
    { kind: 'guess', title: tx('Stale reads'), questions: ['stale-share'] },
    { kind: 'run', title: tx('Run'), show: ['staleReads', 'busiestInstance:db', 'failRate'] },
    { kind: 'guess', title: tx('A lag limit'), questions: ['primary-busy'] },
    { kind: 'try', title: tx('Max lag 200 ms'), text: tx('Set “Max replication lag” to 200 ms and run again. How many reads are stale now, and how busy is the primary?'), patch: [{ node: 'db', params: { maxLagMs: 200 } }], show: ['staleReads', 'busiestInstance:db', 'failRate'], look: { node: 'db' } },
    { kind: 'try', title: tx('A shorter lag'), text: tx('Reset “Max replication lag” to 0 and lower “Replication lag” to 50 ms. Run again: how many reads are stale now?'), patch: [{ node: 'db', params: { maxLagMs: 0, replicaDelayMs: 50 } }], show: ['staleReads', 'busiestInstance:db', 'failRate'] },
    { kind: 'challenge', title: tx('Two challenges'), challenges: ['replicas/no-stale', 'replicas/keep-replicas'] },
  ],
};

export default lesson;
