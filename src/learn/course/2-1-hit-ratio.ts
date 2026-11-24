// 2.1 Hit ratio decides the database (url-shortener). Moved from feat/course-sample (cb667f4).
import { t, tx } from '../../i18n/index.ts';
import { noMoreCapacity, type Lesson } from '../lesson.ts';
import { cacheAtMost, failUnder1, hitRatio, keepLru, p99Under, pct, shareReaching } from '../lessonKit.ts';

const p99Under150 = p99Under(150, tx('p99 of successful requests under 150 ms'));
const p99Under100 = p99Under(100, tx('p99 of successful requests under 100 ms'));

const INTRO = tx('A database can handle only so many lookups per second before it slows down. A cache sits in front of the database to answer repeated lookups, like keeping frequent phone numbers on a sticky note on your desk instead of walking to the filing cabinet every time.\n\nRequests come in two kinds: a read looks up existing data, while a write creates or changes data. When a read finds its answer in the cache, that is a cache hit and the database does nothing. When the answer is missing from the cache, that is a cache miss and the server must ask the database. Writes always go to the database. The share of reads answered by the cache is the hit ratio.\n\nThis example is a URL shortener receiving 3000 clicks a second. Almost all traffic (99%) is reads that look up a short code to find the original URL, and 1% is writes that create new short links. There are 200,000 short URLs, and clicks are very uneven: a few viral links get most of the clicks, while most links are barely opened. Redis keeps at most 20,000 links (one tenth of the total) as an LRU cache, which drops the least recently used link when full. Guess the hit ratio and the database load, then press Run.');

const cacheHitRatio: Lesson = {
  id: '2.1',
  title: tx('Hit ratio decides the database'),
  unit: 2,
  order: 1,
  minutes: 20,
  wave: 1,
  learn: [
    tx('Read a cache’s hit ratio'),
    tx('Calculate database load from the hit ratio'),
    tx('Shrink a cache while keeping the database under its ceiling'),
    tx('See how a short expiration time (TTL) reduces hit ratio'),
  ],
  learnAt: [2, 2, 3, 3],
  recap: [
    tx('When clicks concentrate on popular items, caching one tenth of the keys catches most reads.'),
    tx('Database load = reads × (1 − hit ratio) + writes, so the hit ratio decides how big the database must be.'),
    tx('A short TTL forces every popular key to be read from the database again every few seconds.'),
  ],
  terms: [
    {
      term: tx('Read vs. write'),
      plain: tx('A read looks up existing data; a write creates or changes data.'),
      example: tx('Checking a price tag in a store is a read; changing the price on the tag is a write.'),
    },
    {
      term: tx('Cache hit'),
      plain: tx('A read that finds its answer in the cache and skips the database.'),
      example: tx('Finding a phone number on a sticky note on your desk instead of walking to the filing cabinet.'),
    },
    {
      term: tx('Cache miss'),
      plain: tx('A read that is not in the cache, so the server must query the database.'),
      example: tx('Not finding the number on your desk sticky notes, so you walk to the filing cabinet to look it up.'),
    },
    {
      term: tx('Hit ratio'),
      plain: tx('The share of reads answered by the cache instead of the database.'),
      example: tx('If 8 out of 10 lookups are on your desk sticky notes, your hit ratio is 80%.'),
    },
    {
      term: tx('LRU cache'),
      plain: tx('A cache that removes the least recently used item when it runs out of space.'),
      example: tx('A small desk board that tosses the oldest untouched sticky note whenever a new one needs space.'),
    },
  ],
  example: 'url-shortener',
  intro: INTRO,
  scenario: 'url-shortener',
  questions: [
    {
      id: 'hit',
      topic: 'cache',
      text: tx('The cache holds only one tenth of the short URLs. About what share of reads are cache hits?'),
      options: [
        { id: 'tenth', text: tx('About one tenth, matching the cache size') },
        { id: 'half', text: tx('About half') },
        { id: 'most', text: tx('About three quarters') },
        { id: 'all', text: tx('More than 90%') },
      ],
      answer: (run) => {
        const h = hitRatio(run, 'cache');
        return h < 0.3 ? 'tenth' : h < 0.65 ? 'half' : h < 0.9 ? 'most' : 'all';
      },
      measured: (run) => t('Hit ratio {h}', { h: pct(hitRatio(run, 'cache')) }),
      explain: tx('Most clicks go to a small set of popular short URLs (often called hot keys). Because the LRU cache keeps recently used links, holding just one tenth of the URLs catches most reads.\n\nThe hit ratio does not climb above 90% for two reasons. First, every link misses the first time anyone clicks it. Second, during a 60-second run, many rarely opened links (cold keys) are clicked only once and always miss.'),
      explainFor: {
        tenth: tx('Only about one tenth of reads hit the cache. This cache is not keeping the popular links. Check whether its capacity is too small, or whether its expiration time (TTL) is so short that links expire too fast.'),
        half: tx('About half of reads hit the cache. It catches some popular links, but low capacity or a short expiration time (TTL) drops many of them before they are clicked again.'),
        all: tx('More than 90% of reads hit the cache. Check whether the cache is set to “Fixed hit rate”, which uses a typed-in percentage instead of simulating real keys.'),
      },
    },
    {
      id: 'db-share',
      topic: 'capacity',
      text: tx('Out of every 100 requests to the redirect API, how many reach the database?'),
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
      calc: [tx('Database load = reads × (1 − hit ratio) + writes'), tx('Database ceiling = 8 connections × 1000 ÷ 5 ms = 1600 reads/s')],
      explain: tx('The hit ratio decides how much work reaches the database. Raising the hit ratio from 50% to 75% cuts database reads in half.\n\nHere the database has 8 connections and takes 5 ms per read, so its ceiling is about 1600 reads a second. If the hit ratio drops below 50%, 3000 clicks a second send more reads than the database can handle.'),
      explainFor: {
        tenth: tx('Fewer than 10 in 100 requests reach the database because the cache caught more than 90% of reads. Check whether this design has a very high hit ratio or uses a fixed hit rate.'),
        half: tx('More than 40 in 100 requests reach the database. The hit ratio is around half or lower, pushing database reads close to its ceiling (about 1600 reads/s). Any lower and requests queue up and time out. Check the database card to see how many requests a second it receives.'),
      },
    },
  ],
  challenges: [
    {
      id: 'cache/tenth',
      title: tx('A tenth of the cache'),
      text: tx('Shrink the cache to 2000 keys or fewer (one tenth of its starting size). Keep the error rate under 1% and p99 under 150 ms, without adding machines.'),
      goals: [cacheAtMost('capacityKeys', 2000, tx('Cache capacity (keys) ≤ 2000')), failUnder1, p99Under150],
      rules: [noMoreCapacity, keepLru],
      hint: tx('Clicks concentrate on popular links, so shrinking the cache to one tenth loses only part of the hit ratio.\n\nSelect the cache, lower “Capacity (keys, LRU)”, and run again. Watch how many requests a second reach the database compared with its ceiling (about 1600/s). A card’s average utilization can look calm even when it saturates, so check the “Bottleneck:” note on the Results tab.'),
    },
    {
      id: 'cache/fiftieth',
      title: tx('A fiftieth of the cache, and the database must hold'),
      text: tx('Shrink the cache to 1000 keys or fewer. Keep the error rate under 1% and p99 under 150 ms. This time you may add capacity, but only in the right place.'),
      goals: [cacheAtMost('capacityKeys', 1000, tx('Cache capacity (keys) ≤ 1000')), failUnder1, p99Under150],
      rules: [keepLru],
      hint: tx('Once the hit ratio drops below half, the database hits its ceiling. Adding more API servers will not help.\n\nSelect the database and increase either its connections (“Concurrency per instance”) or its read replicas (“Read replica count”, extra read-only copies of the database).'),
    },
    {
      id: 'cache/fresh',
      title: tx('Fresh within three seconds'),
      text: tx('When a short URL changes its target, users must see the new link within 3 seconds. Set the cache’s TTL (time to live — how many seconds a cached item lasts before expiring) to 3 seconds or less, but not 0. Keep the error rate under 1% and p99 under 100 ms, without adding machines.'),
      goals: [cacheAtMost('ttlS', 3, tx('Cache TTL between 1 and 3 seconds (0 means never expires and does not count)')), failUnder1, p99Under100],
      rules: [noMoreCapacity, keepLru],
      hint: tx('TTL affects the hit ratio too. Every TTL seconds, each popular link expires and must be read from the database again.\n\nA shorter TTL makes the database busier, so find the shortest TTL that still stays within the limits. Making the cache bigger will not help here, because links expire on a timer rather than being pushed out for lack of space.'),
    },
  ],
  steps: [
    { kind: 'read', title: tx('A URL shortener'), text: INTRO, key: tx('Only a cache miss or a write reaches the database.') },
    { kind: 'guess', title: tx('Hit ratio and database'), questions: ['hit', 'db-share'] },
    { kind: 'run', title: tx('Run') },
    { kind: 'challenge', title: tx('Three challenges'), challenges: ['cache/tenth', 'cache/fiftieth', 'cache/fresh'] },
  ],
};

export default cacheHitRatio;
