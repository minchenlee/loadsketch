// 2.5 Sharding and hot keys (sharded / hot-keys, hot-shard): shards split keys, not load. The shard
// that holds the hottest key stays the busiest, and more shards cannot split one key. For a key that
// is mostly read, replicas of that shard spread it.
import { t, tx } from '../../i18n/index.ts';
import type { Goal, Lesson, Rule } from '../lesson.ts';
import type { RunData } from '../metrics.ts';
import { paramOf, pct } from '../lessonKit.ts';
import { meanOf } from '../courseMachines.ts';

const INTRO = tx('Writes are too many for one database, so the data is split by the hash of the key over 4 shards, 8 connections each. Users send 3500 requests a second, 70% of them writes, and some keys are much more popular than others (Zipf). Each shard gets about a quarter of the keys. Guess whether it also gets a quarter of the load, then press Run.');

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
  example: 'sharded',
  scenario: 'hot-keys',
  intro: INTRO,
  questions: [
    {
      id: 'hot-ratio',
      topic: 'capacity',
      text: tx('How busy is the busiest shard, compared with the average shard?'),
      options: [
        { id: 'even', text: tx('About the same (within 15%)') },
        { id: 'hotter', text: tx('Somewhat busier (15% to 60% more)') },
        { id: 'much', text: tx('Much busier (more than 60% more)') },
      ],
      answer: (run) => {
        const r = hottest(run) / Math.max(average(run), 1e-9);
        return r < 1.15 ? 'even' : r <= 1.6 ? 'hotter' : 'much';
      },
      measured: (run) => t('Busiest shard {h}, average {a}', { h: pct(hottest(run)), a: pct(average(run)) }),
      explain: tx('A hash spreads keys evenly, not requests. One key gets far more requests than the rest, and all of them go to the one shard that holds it. That shard runs close to full while the others have room: the design is as strong as its hottest shard, not its average.'),
      explainFor: {
        even: tx('The shards are about even: no single key is popular enough to stand out (keys are less concentrated here).'),
        much: tx('The busiest is far above the average: with many shards, each one holds few keys, so the shard with the hottest key stands out even more.'),
      },
    },
    {
      id: 'more-shards',
      topic: 'capacity',
      text: tx('Set the shards to 16: the average shard now does a quarter of the work. How busy is the busiest shard?'),
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
      explain: tx('The other keys spread over more shards, but the hottest key still lands on one shard, with all its requests. Its share of that shard grows as the shard holds fewer other keys, so the busiest shard falls about half while the average falls to a quarter. More shards cannot split one key.'),
      explainFor: {
        quarter: tx('The busiest fell as much as the average: no key was hot enough to dominate its shard.'),
        same: tx('The busiest shard is still close to full: it is the hot key, not the other keys, that loads it.'),
      },
    },
  ],
  challenges: [
    {
      id: 'shards/read-hot',
      scenario: 'hot-shard',
      title: tx('A hot channel'),
      text: tx('Scenario "A large server posts an announcement": 80% reads, and a few keys are very hot. Keep 4 shards and bring every database machine under 35% busy.'),
      goals: [
        shardsAtMost(4),
        { text: tx('Every database machine under 35% busy'), check: (run) => ({ ok: hottest(run) < 0.35, value: pct(hottest(run)) }) },
      ],
      rules: [sameMachines],
      hint: tx('The hot key is mostly read. Reads of one key can go to several copies of its shard: give each shard read replicas and send reads to them.'),
    },
  ],
  steps: [
    { kind: 'read', text: INTRO },
    { kind: 'guess', questions: ['hot-ratio'] },
    { kind: 'run' },
    { kind: 'guess', questions: ['more-shards'] },
    { kind: 'try', text: tx('Set the shards to 16 and run again: the average shard drops to a quarter, the busiest only to about half.'), patch: [{ node: 'db', params: { shards: 16 } }] },
    { kind: 'run', scenario: 'hot-shard', text: tx('Open the scenario "A large server posts an announcement": now 80% of requests are reads, and one shard is again the busiest.') },
    { kind: 'challenge', challenges: ['shards/read-hot'] },
  ],
};

export default lesson;
