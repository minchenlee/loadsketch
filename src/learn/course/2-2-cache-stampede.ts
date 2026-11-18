// 2.2 Cache stampede (cache-stampede / hot-key-expiry; extra example cache-lease): a 98% hit ratio
// still fails requests when a hot key expires and every miss reads the same row at once. A lease
// lets one request read; a longer TTL or jitter only moves the bursts.
import { t, tx } from '../../i18n/index.ts';
import { noMoreCapacity, type Lesson } from '../lesson.ts';
import type { RunData } from '../metrics.ts';
import { errorsUnder, failShareOf, hitRatio, ms, pct } from '../lessonKit.ts';

const INTRO = tx('Cache-aside: the API reads Redis first; on a miss it reads Postgres and writes the value back. Values live 10 s in Redis (TTL). Users send 3000 reads a second, and a few keys are very hot: the hottest gets about 1000 reads a second. A Postgres read takes 100 ms and there are 16 connections. Guess what happens when a hot key expires, then press Run.');

const db = (run: RunData) => run.result.nodes.db;

const lesson: Lesson = {
  id: '2.2',
  title: tx('Cache stampede'),
  unit: 2,
  order: 2,
  minutes: 20,
  wave: 1,
  learn: [
    tx("See how a 98% hit ratio can still fail requests"),
    tx("See why bursts, not the average, size the database"),
    tx("See why a longer TTL only makes the bursts rarer"),
    tx("Stop a stampede with a lease"),
  ],
  learnAt: [2, 2, 3, 5],
  recap: [
    tx("An expiring hot key sends a burst of reads to the database; the hit ratio averages it away."),
    tx("A longer TTL makes the bursts rarer, not smaller."),
    tx("Coalescing needs read-through; with cache-aside, use a lease: one request reads, the others wait a little."),
  ],
  example: 'cache-stampede',
  scenario: 'hot-key-expiry',
  extraExamples: ['cache-lease'],
  intro: INTRO,
  questions: [
    {
      id: 'hit-fail',
      topic: 'cache',
      text: tx('Redis answers about 98% of reads. What share of requests fail?'),
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
      calc: [tx('1000 reads/s × 100 ms ≈ 100 reads of the same row at once'), tx('100 ÷ 16 connections ≈ 6 rounds of 100 ms')],
      explain: tx('When the hottest key expires, every read of it misses until one DB read writes it back: about 100 requests read the same row at once. The 16 connections serve them 16 at a time, so the last of them waits about 6 rounds; the DB queue fills, and requests behind it time out or are turned away. The hit ratio averages over the whole minute and hides these bursts.'),
      explainFor: {
        none: tx('Almost none fail: when a hot key expires, only one request reads the DB (a lease), and the others wait a moment for the value.'),
        few: tx('A few fail: the expiry bursts are small enough that the DB queue mostly holds them.'),
      },
    },
    {
      id: 'db-wait',
      topic: 'queueing',
      text: tx('Postgres is busy under half the time on average. How long does a read wait for a connection, on average?'),
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
      explain: tx('The DB is idle most of the time and swamped right after each expiry. The reads that arrive in a burst wait for the whole burst ahead of them, so the average wait is long although the average load is low. Bursts, not the average, size the database.'),
      explainFor: {
        short: tx('Reads barely wait: each expiry sends one read to the DB, so there is no burst to queue behind.'),
      },
    },
  ],
  challenges: [
    {
      id: 'stampede/no-fail',
      title: tx('Stop the stampede'),
      text: tx('Without a bigger database or more machines, make the stampede fail almost nothing (under 0.1% of requests).'),
      goals: [errorsUnder(0.001, tx('Error rate under 0.1% for the whole run'))],
      rules: [noMoreCapacity],
      hint: tx('A longer TTL makes expiries rarer, but each one is the same burst. The burst itself must go: let only one request read the DB when a key expires, and the others wait for the value.'),
    },
  ],
  steps: [
    { kind: 'read', title: tx('Cache-aside with hot keys'), text: INTRO, key: tx('When a hot key expires, every read of it goes to the database at once.') },
    { kind: 'guess', title: tx('Failures and the wait'), questions: ['hit-fail', 'db-wait'] },
    { kind: 'run', title: tx('Run'), show: ['hitRatio', 'failRate', 'p99'], look: { panel: 'bottom' } },
    { kind: 'try', title: tx('A longer TTL'), text: tx('Set the TTL to 60 s and run again. The hit ratio goes up: do the failures stop?'), patch: [{ node: 'redis', params: { ttlS: 60 } }], show: ['hitRatio', 'failRate', 'p99'], look: { panel: 'bottom' } },
    { kind: 'try', title: tx('Coalesce'), text: tx('Set “Stampede protection” to Coalesce and run again. Does anything change?'), patch: [{ node: 'redis', params: { stampede: 'coalesce' } }], show: ['hitRatio', 'failRate', 'p99'] },
    { kind: 'run', title: tx('A lease and TTL jitter'), example: 'cache-lease', text: tx('Coalescing works only when the cache reads the DB itself (read-through); here the API reads the DB, so the cache never sees the misses together. Open “Cache lease + TTL jitter”: the same design with a lease, so one request reads the DB per expiry and the others ask Redis again every 20 ms, and with TTL jitter, so keys written together do not all expire in the same second. Run it: how many fail now, and what do the waiting requests pay?'), show: ['failRate', 'p99', 'p50'] },
    { kind: 'challenge', title: tx('Stop the stampede'), challenges: ['stampede/no-fail'] },
  ],
};

export default lesson;
