// 2.1 Hit ratio decides the database (url-shortener). Moved from feat/course-sample (cb667f4).
import { t, tx } from '../../i18n/index.ts';
import { noMoreCapacity, type Lesson } from '../lesson.ts';
import { cacheAtMost, failUnder1, hitRatio, keepLru, p99Under, pct, shareReaching } from '../lessonKit.ts';

const p99Under150 = p99Under(150, tx('p99 of successful requests under 150 ms'));
const p99Under100 = p99Under(100, tx('p99 of successful requests under 100 ms'));

const cacheHitRatio: Lesson = {
  id: '2.1',
  title: tx('Hit ratio decides the database'),
  unit: 2,
  order: 1,
  minutes: 20,
  wave: 1,
  learn: [
    tx("Read the hit ratio of a cache"),
    tx("Work out the database load from the hit ratio"),
    tx("Shrink a cache and keep the database under its ceiling"),
    tx("See how a short TTL costs hit ratio"),
  ],
  learnAt: [2, 2, 3, 3],
  recap: [
    tx("When clicks are concentrated, room for a tenth of the keys catches most reads."),
    tx("Database load = reads × (1 − hit ratio) + writes: the hit ratio sizes the database."),
    tx("A short TTL reads every hot key from the database again each TTL seconds."),
  ],
  example: 'url-shortener',
  intro: tx('A URL shortener: 3000 clicks a second, 99% reads (short code → original URL). There are 200,000 short URLs, and the clicks are concentrated. Redis keeps at most 20,000 of them (a tenth) as an LRU cache; only a miss reads the database. Guess the hit ratio and the database load, then press Run.'),
  scenario: 'url-shortener',
  questions: [
    {
      id: 'hit',
      topic: 'cache',
      text: tx('The cache holds only a tenth of the short URLs. About what share of reads hit the cache?'),
      options: [
        { id: 'tenth', text: tx('About a tenth, the same as the capacity share') },
        { id: 'half', text: tx('About a half') },
        { id: 'most', text: tx('About three quarters') },
        { id: 'all', text: tx('More than 90%') },
      ],
      answer: (run) => {
        const h = hitRatio(run, 'cache');
        return h < 0.3 ? 'tenth' : h < 0.65 ? 'half' : h < 0.9 ? 'most' : 'all';
      },
      measured: (run) => t('Hit ratio {h}', { h: pct(hitRatio(run, 'cache')) }),
      explain: tx('Clicks concentrate on a few hot short URLs (a Zipf distribution), so room for a tenth of the keys catches most reads. It is not above 90% because every short URL misses the first time it is read, and in 60 seconds many cold short URLs are read only once.'),
      explainFor: {
        tenth: tx("A hit ratio of only about a tenth: this design’s cache does not catch the hot keys. Check whether the capacity is too small, or the TTL so short that keys keep expiring."),
        half: tx('A hit ratio of about a half: some hot keys are caught, but the capacity or the TTL evicts or expires many of them.'),
        all: tx('A hit ratio above 90%: the cache caught almost every read. Check whether this is a “fixed hit ratio”: that is a number typed in, not one the run worked out.'),
      },
    },
    {
      id: 'db-share',
      topic: 'capacity',
      text: tx('Of every 100 requests into the redirect API, how many reach the database?'),
      options: [
        { id: 'tenth', text: tx('Fewer than 10') },
        { id: 'quarter', text: tx('10 to 40') },
        { id: 'half', text: tx('More than 40') },
      ],
      answer: (run) => {
        const s = shareReaching(run, 'db', 'api');
        return s < 0.1 ? 'tenth' : s <= 0.4 ? 'quarter' : 'half';
      },
      measured: (run) => t('{n} of every 100 requests reach the database', { n: Math.round(shareReaching(run, 'db', 'api') * 100) }),
      calc: [tx('Database load = reads × (1 − hit ratio) + writes'), tx('Ceiling: 8 connections × 1000 ÷ 5 ms = 1600 reads/s')],
      explain: tx('The hit ratio decides how much the database carries: from 50% to 75%, the database reads halve. The database serves at most about 1600 reads a second; once the hit ratio falls under a half, 3000 clicks a second fill it up.'),
      explainFor: {
        tenth: tx('Under a tenth reach the database: the cache caught more than 90%. This design has a high hit ratio (or uses a fixed one).'),
        half: tx('More than 40 in 100 reach the database: the hit ratio is about a half or lower, and the reads the database receives are close to its ceiling (8 connections × one read per 5 ms ≈ 1600/s). A little lower and it starts to queue and time out. See how many a second the database card receives.'),
      },
    },
  ],
  challenges: [
    {
      id: 'cache/tenth',
      title: tx('A tenth of the cache'),
      text: tx('Shrink the cache to 2000 keys or fewer (a tenth of the original) and keep the error rate under 1% and p99 under 150 ms, without adding machines.'),
      goals: [cacheAtMost('capacityKeys', 2000, tx('Cache capacity (keys) ≤ 2000')), failUnder1, p99Under150],
      rules: [noMoreCapacity, keepLru],
      hint: tx('Clicks are concentrated, so a tenth of the capacity loses only some of the hit ratio. Change “Capacity (keys, LRU)” and run again; watch how much the database receives a second and how far it is from its ceiling (about 1600/s). The utilization on a card can look like it has room to spare; read the “Bottleneck:” note on the Results tab, which says which component saturated and when.'),
    },
    {
      id: 'cache/fiftieth',
      title: tx('A fiftieth of the cache, and the database must hold'),
      text: tx('Shrink the cache to 1000 keys or fewer. Error rate under 1%, p99 under 150 ms. This time you may add machines, but in the right place.'),
      goals: [cacheAtMost('capacityKeys', 1000, tx('Cache capacity (keys) ≤ 1000')), failUnder1, p99Under150],
      rules: [keepLru],
      hint: tx("Once the hit ratio is under a half, the database is the ceiling: more API servers do not help. The database’s “connections” or “replicas” are the place to add."),
    },
    {
      id: 'cache/fresh',
      title: tx('Fresh within three seconds'),
      text: tx('When a short URL changes its target, it must take effect within three seconds: set the cache TTL to 3 seconds or less (not 0). Error rate under 1%, p99 under 100 ms, without adding machines.'),
      goals: [cacheAtMost('ttlS', 3, tx('Cache TTL between 1 and 3 seconds (0 means never expires and does not count)')), failUnder1, p99Under100],
      rules: [noMoreCapacity, keepLru],
      hint: tx('The TTL decides the hit ratio too: every TTL seconds, each hot key is read from the database again. The shorter the TTL, the busier the database; find the shortest TTL that still holds. A bigger cache does not help: the hot keys expire, they are not evicted.'),
    },
  ],
  steps: [
    { kind: 'read', title: tx('A URL shortener'), text: tx('A URL shortener: 3000 clicks a second, 99% reads (short code → original URL). There are 200,000 short URLs, and the clicks are concentrated. Redis keeps at most 20,000 of them (a tenth) as an LRU cache; only a miss reads the database. Guess the hit ratio and the database load, then press Run.'), key: tx('Only a cache miss reads the database.') },
    { kind: 'guess', title: tx('Hit ratio and database'), questions: ['hit', 'db-share'] },
    { kind: 'run', title: tx('Run'), show: ['hitRatio', 'p99', 'failRate'] },
    { kind: 'challenge', title: tx('Three challenges'), challenges: ['cache/tenth', 'cache/fiftieth', 'cache/fresh'] },
  ],
};

export default cacheHitRatio;
