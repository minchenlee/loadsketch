// 2.5 Sharding and hot keys (sharded / hot-keys, hot-shard): shards split keys, not load. The shard
// that holds the hottest key stays the busiest, and more shards cannot split one key. For a key that
// is mostly read, replicas of that shard spread it.
import { t, tx } from '../../i18n/index.ts';
import type { Goal, Lesson, Rule } from '../lesson.ts';
import type { RunData } from '../metrics.ts';
import { failUnder1, paramOf, pct } from '../lessonKit.ts';
import { meanOf } from '../courseMachines.ts';

const INTRO = tx('Read replicas help share read traffic, but every write still has to go to one primary database. When writes grow too heavy for a single machine, teams use sharding: they split the data across several independent databases called shards.\n\nTo decide which shard stores each record, the system picks a shard key (such as a user ID or channel ID) and runs a hash formula on it so keys spread evenly across the shards. Imagine splitting library books across 4 rooms by the first letter of the title. Even if each room holds the same number of books, what happens if everyone wants books starting with "S"? Room S jams while the other 3 rooms sit mostly empty. In databases, one key that draws far more traffic than the rest is called a hot key (causing skew).\n\nIn this example, users send 3500 requests a second, and 70% are writes. The data is split across 4 shards with 8 connections each, and a few keys are far more popular than the rest. Each shard holds about a quarter of the keys. Guess whether each shard also gets a quarter of the work, then press Run.');

/** Busiest database instance (with no replicas, the busiest shard). */
export const hottest = (run: RunData) => Math.max(0, ...(run.result.nodes.db?.instances ?? []).map((i) => i.utilization));
/** Average over the instances. */
export const average = (run: RunData) => run.result.nodes.db?.utilization ?? 0;

/** Each database machine stays as it is: no more connections, no faster reads or writes. Replicas may be added. */
const sameMachines: Rule = {
  short: tx('Same database machines'),
  text: tx('each database machine keeps its connections and its read and write times; replicas may be added'),
  check: (d, original) => {
    const out: string[] = [];
    const conn = (x: typeof d) => paramOf(x, 'db', 'connections');
    const mean = (x: typeof d, k: string) => meanOf(paramOf(x, 'db', k));
    const [a, b] = [conn(original), conn(d)];
    if (typeof a === 'number' && typeof b === 'number' && b > a) out.push(t('Connections changed from {a} to {b}', { a, b }));
    for (const k of ['readMs', 'writeMs']) {
      const [x, y] = [mean(original, k), mean(d, k)];
      // a value that cannot be read as a time does not get past the rule either
      if (x !== undefined && (y === undefined || y < x)) out.push(t('{what} changed from {a} to {b} ms', { what: k === 'readMs' ? t('Read time') : t('Write time'), a: x, b: y ?? '—' }));
    }
    return out;
  },
};

const shardsAtMost = (n: number): Goal => ({
  text: tx('Still 4 shards or fewer'),
  check: (run) => {
    const v = paramOf(run.design, 'db', 'shards');
    return { ok: typeof v === 'number' && v <= n, value: String(v) };
  },
});

const lesson: Lesson = {
  id: '2.5',
  title: tx('Sharding and hot keys'),
  unit: 2,
  order: 5,
  minutes: 20,
  wave: 1,
  learn: [
    tx('See why sharding splits keys, not traffic'),
    tx('See why adding more shards cannot split a single hot key'),
    tx('Spread a read-heavy hot key using read replicas on each shard'),
  ],
  learnAt: [2, 4, 6],
  recap: [
    tx('A sharded database is only as strong as its busiest shard, not its average.'),
    tx('Adding more shards cannot split traffic for a single hot key.'),
    tx('When a hot key is mostly reads, read replicas on its shard can share the load.'),
  ],
  terms: [
    {
      term: tx('Sharding'),
      plain: tx('Splitting a database’s data across multiple independent machines (shards) so they share storage and writes.'),
      example: tx('Dividing a huge library’s books across 4 separate rooms instead of cramming them into one room.'),
    },
    {
      term: tx('Shard key'),
      plain: tx('The identifier (like a user ID or channel ID) used to decide which shard stores a record.'),
      example: tx('Sorting library books into rooms by the first letter of the title.'),
    },
    {
      term: tx('Hash'),
      plain: tx('A fast formula that turns a key into a consistent shard number so keys spread out evenly.'),
      example: tx('Assigning lockers by dividing each student’s ID number evenly across 4 hallways.'),
    },
    {
      term: tx('Hot key (skew)'),
      plain: tx('One popular key that draws far more traffic than the rest, overloading the single shard that owns it.'),
      example: tx('Splitting books across 4 rooms by first letter — if everyone wants books starting with "S", room S jams while the other 3 sit almost empty.'),
    },
  ],
  example: 'sharded',
  scenario: 'hot-keys',
  intro: INTRO,
  questions: [
    {
      id: 'hot-ratio',
      topic: 'capacity',
      text: tx('Compared with the average shard, how busy is the busiest shard?'),
      options: [
        { id: 'even', text: tx('About the same (within 15%)') },
        { id: 'hotter', text: tx('Noticeably busier (15% to 60% more)') },
        { id: 'much', text: tx('Much busier (more than 60% more)') },
      ],
      answer: (run) => {
        const r = hottest(run) / Math.max(average(run), 1e-9);
        return r < 1.15 ? 'even' : r <= 1.6 ? 'hotter' : 'much';
      },
      measured: (run) => t('Busiest shard {h}, average {a}', { h: pct(hottest(run)), a: pct(average(run)) }),
      explain: tx('Hashing spreads keys evenly across the shards, not requests.\n\nOne hot key receives far more traffic than the rest, and all of its requests go to the single shard that owns it. That shard runs near its limit while the others still have room to spare. A sharded database is only as strong as its hottest shard, not its average.'),
      explainFor: {
        even: tx('The shards are nearly even because traffic is spread more smoothly and no single key dominates its shard.'),
        much: tx('The busiest shard stands out far above the average. With many shards, each shard holds fewer ordinary keys, so the one shard holding the hot key looks much busier than the rest.'),
      },
    },
    {
      id: 'more-shards',
      topic: 'capacity',
      text: tx('Now increase the database from 4 shards to 16. The average shard does a quarter as much work as before. How busy is the busiest shard?'),
      options: [
        { id: 'quarter', text: tx('Under 35%') },
        { id: 'half', text: tx('35% to 65%') },
        { id: 'same', text: tx('More than 65%') },
      ],
      answer: (run) => {
        const h = hottest(run);
        return h < 0.35 ? 'quarter' : h <= 0.65 ? 'half' : 'same';
      },
      measured: (run) => t('Busiest shard {h}, average {a}', { h: pct(hottest(run)), a: pct(average(run)) }),
      explain: tx('Adding shards spreads the ordinary keys across 16 machines instead of 4, so the average shard’s load drops to a quarter.\n\nHowever, the hottest key still lives on a single shard and brings all of its traffic with it. Moving the other keys away gives that shard some relief, so its load drops roughly in half — nowhere near a quarter. Adding more shards can never split a single hot key.'),
      explainFor: {
        quarter: tx('The busiest shard dropped as much as the average because no single key was hot enough to dominate it.'),
        same: tx('The busiest shard is still near full because the hot key itself, not the other keys on that shard, causes almost all of its load.'),
      },
    },
  ],
  challenges: [
    {
      id: 'shards/read-hot',
      scenario: 'hot-shard',
      title: tx('A hot channel'),
      text: tx('In the scenario “A large server posts an announcement”, 80% of requests are reads and a few channels are very hot. Keep 4 shards or fewer, keep the error rate under 1%, and bring every database machine under 35% busy.'),
      goals: [
        shardsAtMost(4),
        { text: tx('Every database machine under 35% busy'), check: (run) => ({ ok: hottest(run) < 0.35, value: pct(hottest(run)) }) },
        // failed requests take load off the database: they must not count as handling it (review of 41fe433)
        failUnder1,
      ],
      rules: [sameMachines],
      hint: tx('More shards cannot split one hot channel, because all requests for that channel still land on one shard.\n\nThis time, though, 80% of the traffic is reads. Reads of a single key can be shared across copies of its shard. Select the sharded database, increase “Read replica count”, and make sure “Read source” sends reads to the replicas.'),
    },
  ],
  steps: [
    { kind: 'read', title: tx('Four shards'), text: INTRO, key: tx('Sharding spreads keys evenly, not traffic.') },
    { kind: 'guess', title: tx('The busiest shard'), questions: ['hot-ratio'] },
    { kind: 'run', title: tx('Run'), look: { node: 'db' }, show: ['busiestInstance:db', 'util:db', 'failRate'] },
    { kind: 'guess', title: tx('16 shards'), questions: ['more-shards'] },
    { kind: 'try', title: tx('16 shards'), text: tx('Set “Shards” to 16 and run again. The average shard now does a quarter of the work — how busy is the busiest shard?'), patch: [{ node: 'db', params: { shards: 16 } }], look: { node: 'db' }, show: ['busiestInstance:db', 'util:db', 'failRate'] },
    { kind: 'run', title: tx('A hot channel'), scenario: 'hot-shard', text: tx('Open the scenario “A large server posts an announcement”. Here each chat channel is a key, 80% of requests are reads, and a few channels are very hot. Run it: does one shard jam again?'), look: { node: 'db' }, show: ['busiestInstance:db', 'util:db', 'failRate'] },
    { kind: 'challenge', title: tx('A hot channel'), challenges: ['shards/read-hot'] },
  ],
};

export default lesson;
