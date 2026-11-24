// 2.2 Cache stampede (cache-stampede / hot-key-expiry; extra example cache-lease): a 98% hit ratio
// still fails requests when a hot key expires and every miss reads the same row at once. A lease
// lets one request read; a longer TTL or jitter only moves the bursts.
import { t, tx } from '../../i18n/index.ts';
import { noMoreCapacity, type Lesson } from '../lesson.ts';
import type { RunData } from '../metrics.ts';
import { errorsUnder, failShareOf, hitRatio, ms, pct } from '../lessonKit.ts';

const INTRO = tx('Cached data cannot stay in memory forever, because the original data in the database can change. To keep answers fresh, caches give each item a TTL (time to live) — an expiration timer, like a "best before" date on milk. Once the timer runs out, the next read misses and fetches a fresh copy from the database.\n\nIn this design, the API uses cache-aside: it checks Redis first, and on a miss it reads Postgres and writes the fresh value back to Redis. When a very popular key expires, trouble starts. Every read of that key misses while the first database lookup is still running, so dozens of requests rush Postgres for the exact same row at once. That sudden flood is called a cache stampede (or thundering herd).\n\nHere, users send 3000 reads a second, and the hottest key gets about 1000 reads a second. Values live for a 10-second TTL in Redis. Postgres has 16 connections, and each read takes 100 ms. Guess what happens each time that hot key expires, then press Run.');

const db = (run: RunData) => run.result.nodes.db;

const lesson: Lesson = {
  id: '2.2',
  title: tx('Cache stampede'),
  unit: 2,
  order: 2,
  minutes: 20,
  wave: 1,
  learn: [
    tx('See how a 98% hit ratio can still cause failures'),
    tx('See why sudden bursts, not averages, overwhelm a database'),
    tx('See why a longer TTL makes bursts rarer, not smaller'),
    tx('Stop a cache stampede with a lease'),
  ],
  learnAt: [2, 2, 3, 5],
  recap: [
    tx('When a hot key expires, a sudden burst of reads hits the database even when the average hit ratio looks high.'),
    tx('A longer TTL makes stampedes happen less often, but each stampede is just as big.'),
    tx('Coalescing works when the cache queries the database; when the API queries the database, use a lease so only one request fetches the row.'),
  ],
  terms: [
    {
      term: tx('TTL (time to live)'),
      plain: tx('How long an item stays in the cache before it expires and must be fetched again.'),
      example: tx('A "best before" date on milk — once it passes, you throw it out and grab a fresh carton.'),
    },
    {
      term: tx('Cache stampede'),
      plain: tx('A sudden flood of database reads when a popular cached item expires and many requests miss at once.'),
      example: tx('A store announces a hot item is back, and 100 shoppers rush the same stockroom clerk at once.'),
    },
    {
      term: tx('Request coalescing'),
      plain: tx('Merging identical in-flight cache misses into a single database read when the cache fetches from the database itself.'),
      example: tx('A front desk clerk makes one trip to the filing cabinet and hands copies to everyone waiting at the counter.'),
    },
    {
      term: tx('Lease'),
      plain: tx('A short lock given to the first cache miss so only that request queries the database while other requests wait briefly for the cache to refill.'),
      example: tx('One person walks to the filing cabinet while everyone else who asked for the same page waits for that one copy.'),
    },
    {
      term: tx('TTL jitter'),
      plain: tx('Adding a small random offset to each item’s expiration time so items saved together do not all expire in the exact same second.'),
      example: tx('Staggering alarm clocks across a few minutes so everyone does not crowd the hallway at once.'),
    },
  ],
  example: 'cache-stampede',
  scenario: 'hot-key-expiry',
  extraExamples: ['cache-lease'],
  intro: INTRO,
  questions: [
    {
      id: 'hit-fail',
      topic: 'cache',
      text: tx('Over the full run, Redis answers about 98% of reads. What share of user requests still fail?'),
      options: [
        { id: 'none', text: tx('Almost none (under 0.1%)') },
        { id: 'few', text: tx('A few (0.1% to 1%)') },
        { id: 'some', text: tx('More than 1%') },
      ],
      answer: (run) => {
        const e = failShareOf(run);
        return e < 0.001 ? 'none' : e < 0.01 ? 'few' : 'some';
      },
      measured: (run) => t('Hit ratio {h}, {e} failed', { h: pct(hitRatio(run, 'redis')), e: pct(failShareOf(run)) }),
      calc: [tx('1000 reads/s × 100 ms ≈ 100 reads of the same row at once'), tx('100 reads ÷ 16 connections ≈ 6 rounds of 100 ms')],
      explain: tx('While the first miss spends 100 ms reading Postgres, about 100 more requests for that same hot key arrive and miss too. All of them hit Postgres at once.\n\nPostgres has only 16 connections, so it processes those 100 reads in about 6 waves of 100 ms each. The database queue fills up, and requests behind the burst time out or get rejected. The 98% hit ratio averages across the whole minute and hides these sharp bursts.'),
      explainFor: {
        none: tx('Almost no requests fail. When a hot key expires, a lease lets only one request query the database while the others wait briefly for the fresh value.'),
        few: tx('Only a few requests fail because the expiry bursts are small enough for the database queue to absorb most of them.'),
      },
    },
    {
      id: 'db-wait',
      topic: 'queueing',
      text: tx('On average, Postgres is busy less than half the time. How long does a database read wait for a connection, on average?'),
      options: [
        { id: 'short', text: tx('Under 100 ms') },
        { id: 'long', text: tx('100 to 300 ms') },
        { id: 'very', text: tx('More than 300 ms') },
      ],
      answer: (run) => {
        const w = db(run)?.waitMs ?? 0;
        return w < 100 ? 'short' : w <= 300 ? 'long' : 'very';
      },
      measured: (run) => {
        const n = db(run);
        return t('Wait {w}; {u} busy on average, {p} at the peak', { w: ms(n?.waitMs ?? 0), u: pct(n?.utilization ?? 0), p: pct(n?.peakUtilization ?? 0) });
      },
      explain: tx('Postgres sits almost idle between expirations, then gets hit by a sudden wave the moment a hot key expires.\n\nRequests arriving in that wave have to wait behind everyone else in the same wave. That makes the average wait time long even though average utilization looks low. Short bursts, not the average, determine whether the database holds up.'),
      explainFor: {
        short: tx('Reads barely wait because each expiration sends only one read to the database, so no burst queues up.'),
      },
    },
  ],
  challenges: [
    {
      id: 'stampede/no-fail',
      title: tx('Stop the stampede'),
      text: tx('Keep the error rate under 0.1% across the whole run, without adding machines or making the database bigger.'),
      goals: [errorsUnder(0.001, tx('Error rate under 0.1% for the whole run'))],
      rules: [noMoreCapacity],
      hint: tx('A longer TTL makes expirations less frequent, but each expiration still triggers the same burst.\n\nYou need to stop the burst itself. Select Redis and change “Stampede protection” so only one request reads the database when a key expires while the others wait briefly for the result.'),
    },
  ],
  steps: [
    { kind: 'read', title: tx('When a hot key expires'), text: INTRO, key: tx('When a hot key expires, every read during the database lookup misses and hits the database at once.') },
    { kind: 'guess', title: tx('Failures and wait time'), questions: ['hit-fail', 'db-wait'] },
    { kind: 'run', title: tx('Run'), show: ['hitRatio', 'failRate', 'p99'], look: { panel: 'bottom' } },
    { kind: 'try', title: tx('A longer TTL'), text: tx('Set the TTL to 60 s and run again. The hit ratio climbs — do the failures stop?'), patch: [{ node: 'redis', params: { ttlS: 60 } }], show: ['hitRatio', 'failRate', 'p99'], look: { panel: 'bottom' } },
    { kind: 'try', title: tx('Try coalescing'), text: tx('Request coalescing merges identical misses into a single database read. Set “Stampede protection” to Coalesce and run again. Does anything change here?'), patch: [{ node: 'redis', params: { stampede: 'coalesce' } }], show: ['hitRatio', 'failRate', 'p99'] },
    { kind: 'run', title: tx('A lease and TTL jitter'), example: 'cache-lease', text: tx('Request coalescing only works when the cache itself fetches from the database (called read-through), like a front desk clerk going to the filing cabinet once for everyone in line. Here, the API server queries Postgres instead of Redis (cache-aside), so Redis cannot combine those database queries on its own.\n\nOpen “Cache lease + TTL jitter” to see the fix. First, a lease lets one miss query the database while the other requests wait 20 ms and check Redis again — like one person walking to the filing cabinet while everyone else waits for that one copy. Second, TTL jitter slightly randomizes each key’s expiration time so keys saved together do not all expire in the exact same second.\n\nRun it: how many requests fail now, and what extra cost do the waiting requests pay?'), show: ['failRate', 'p99', 'p50'] },
    { kind: 'challenge', title: tx('Stop the stampede'), challenges: ['stampede/no-fail'] },
  ],
};

export default lesson;
