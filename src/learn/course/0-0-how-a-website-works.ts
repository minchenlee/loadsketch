// 0.0 Follow one click: how a website works (three-tier / steady): zero-math orientation to the
// four parts of a web site, reading Busy %, queue, latency, p99 and error rate, and watching
// overload happen when server count drops from 3 to 1.
import { t, tx } from '../../i18n/index.ts';
import type { Lesson } from '../lesson.ts';
import type { RunData } from '../metrics.ts';
import { failShareOf, ms, pct } from '../lessonKit.ts';

const INTRO = tx(
  'Welcome! You do not need any math or backend background to start here. Every time you open a webpage, scroll a feed, or tap “Buy”, your device sends a request to a website’s computers—just like placing an order at a restaurant.\n\nLook at the simulator canvas. A request travels left to right through four parts. First, a load balancer stands at the front door like a restaurant host and sends each request to whichever server is free. Next, 3 API servers (API = Application Programming Interface, the servers that run the website’s rules) act like kitchen cooks doing the actual work.\n\nRequests come in two kinds: a read looks up existing data (like opening a product page), while a write saves or changes data (like placing an order). To answer fast, an API server checks a cache first (Redis, a super-fast notepad in memory holding popular answers). If a read finds its answer there (a hit), Redis answers right away. Here, 85% of reads are hits. Only the remaining 15% that miss the cache (not found in Redis) plus all writes go to the database (Postgres, the main filing cabinet on disk that safely stores everything).',
);

const READ_RESULTS = tx(
  'When every cook in a kitchen is busy, new orders wait in a queue (a waiting line, like at a coffee shop). On the canvas, each card shows how busy that part is: green means comfortable room, amber means getting full, and red means overloaded.\n\nAfter you press Run, the Results tab summarizes the user’s experience with three numbers: latency (total time from click to answer, including waiting in line), p99 (the 99th-slowest threshold out of 100 successful requests—99% of successful requests finish within this time, catching slowdowns an average hides), and error rate (the share of requests that fail instead of returning a page; latency counts only successful requests, while failures show up here).\n\nIn this first run, traffic is steady and comfortable for 3 API servers. Make two quick guesses—no math needed—then press Run.',
);

const dbBusy = (run: RunData) => run.result.nodes.db?.utilization ?? 0;

const lesson: Lesson = {
  id: '0.0',
  title: tx('Follow one click: how a website works'),
  unit: 0,
  order: 0,
  minutes: 8,
  wave: 1,
  learn: [
    tx('Trace one click from a user’s screen through a website’s parts'),
    tx('Read the key numbers on the Results tab'),
    tx('See what a healthy, calm simulation run looks like'),
    tx('Watch a queue form and errors appear when servers run short'),
  ],
  learnAt: [0, 1, 3, 4],
  recap: [
    tx('Every click sends a request through a chain: load balancer → API servers → cache and database.'),
    tx('A cache answers most reads right away in memory, keeping the database quiet.'),
    tx('When servers have spare room, queues stay empty and p99 stays fast; when they run short, lines grow and errors appear.'),
  ],
  terms: [
    {
      term: tx('Request'),
      plain: tx('One single action a user’s device asks a website to perform.'),
      example: tx('Opening a product page, clicking “Buy”, or refreshing your feed.'),
    },
    {
      term: tx('Server'),
      plain: tx('A computer (called an instance in the settings) that receives requests and sends back answers.'),
      example: tx('A cashier or kitchen worker taking orders behind the counter.'),
    },
    {
      term: tx('Load balancer'),
      plain: tx('A front-door router that spreads incoming requests across several servers so no single server gets overwhelmed.'),
      example: tx('A restaurant host seating guests at whichever table is open.'),
    },
    {
      term: tx('Cache@@term'),
      plain: tx('Very fast temporary memory that stores popular answers so servers do not have to look them up every time.'),
      example: tx('Keeping the top 10 phone numbers on a sticky note instead of opening the phone book.'),
    },
    {
      term: tx('Database'),
      plain: tx('Permanent storage on disk where a website safely saves and searches all of its data.'),
      example: tx('The main filing cabinet in the back room that holds every customer record.'),
    },
    {
      term: tx('Queue'),
      plain: tx('A waiting line where incoming requests pause when all server slots are already busy.'),
      example: tx('Customers standing in line at a coffee shop while every barista is making a drink.'),
    },
    {
      term: tx('Latency'),
      plain: tx('The total time a request takes from when a user sends it until the answer comes back, including waiting in line.'),
      example: tx('Total time from joining the coffee shop line until you hold your cup.'),
    },
    {
      term: tx('p99'),
      plain: tx('The 99th-slowest threshold out of 100 successful requests—99% of successful requests finish within this time (latency in the simulator counts only successful requests; failures are counted in error rate).'),
      example: tx('Sort 100 coffee orders from fastest to slowest: the 99th cup is p99 (the 100th cup is the maximum). If 98 cups take 1 minute and the 99th and 100th take 5 and 10 minutes, p99 is 5 minutes.'),
    },
    {
      term: tx('Error rate'),
      plain: tx('The percentage of requests that fail instead of returning a working answer.'),
      example: tx('Out of 100 people who try to check out, 2 get an error message—a 2% error rate.'),
    },
  ],
  example: 'three-tier',
  scenario: 'steady',
  intro: INTRO,
  questions: [
    {
      id: 'db-quiet',
      topic: 'cache',
      text: tx('Because Redis (the cache) answers 85% of reads right away, how busy does Postgres (the database) stay during this steady run?'),
      options: [
        { id: 'quiet', text: tx('Very quiet (under 20% busy)') },
        { id: 'half', text: tx('Moderately busy (20% to 70% busy)') },
        { id: 'full', text: tx('Nearly full (over 70% busy)') },
      ],
      answer: (run) => {
        const u = dbBusy(run);
        return u < 0.2 ? 'quiet' : u <= 0.7 ? 'half' : 'full';
      },
      measured: (run) => t('Database {u} busy on average', { u: pct(dbBusy(run)) }),
      explain: tx(
        'Postgres stays very quiet. Most requests are reads, and 85% of them stop at the fast Redis cache and never touch the database.\n\nOnly the 15% that miss the cache plus the small share of writes reach Postgres, leaving it with plenty of breathing room.',
      ),
      explainFor: {
        half: tx('Here the database is moderately busy because a larger share of requests is reaching Postgres instead of stopping at the cache.'),
        full: tx('Here the database is nearly full because too many reads or writes are landing directly on Postgres.'),
      },
    },
    {
      id: 'healthy-run',
      topic: 'capacity',
      text: tx('With 3 API servers sharing steady normal traffic, what happens to p99 latency and the error rate?'),
      options: [
        { id: 'healthy', text: tx('Fast and healthy (p99 under 200 ms, under 1% errors)') },
        { id: 'slow', text: tx('Slow but working (p99 over 200 ms, under 1% errors)') },
        { id: 'failing', text: tx('Broken (more than 1% of requests fail)') },
      ],
      answer: (run) => {
        if (failShareOf(run) >= 0.01) return 'failing';
        return run.result.summary.latencyMs.p99 >= 200 ? 'slow' : 'healthy';
      },
      measured: (run) => t('p99 {p}, error rate {e}', { p: ms(run.result.summary.latencyMs.p99), e: pct(failShareOf(run)) }),
      explain: tx(
        'The site stays fast and healthy. Three API servers easily keep up with steady traffic, so queues stay nearly empty, p99 stays low, and requests succeed.\n\nNow that you have seen a calm, healthy run, let’s take away servers on purpose so you can see what overload looks like.',
      ),
      explainFor: {
        slow: tx('Errors stayed low, but queues formed and pushed p99 past 200 ms.'),
        failing: tx('More than 1% of requests failed because part of the site ran out of capacity and could not keep up.'),
      },
    },
  ],
  challenges: [],
  steps: [
    { kind: 'read', title: tx('Follow one click'), text: INTRO, look: { node: 'users' }, key: tx('Every click sends a request through a chain: load balancer → servers → cache and database.') },
    { kind: 'read', title: tx('How to read a run'), text: READ_RESULTS, look: { tab: 'results' }, key: tx('Watch four signals: Busy %, queue length, p99 latency, and error rate.') },
    { kind: 'guess', title: tx('Two quick guesses'), questions: ['db-quiet', 'healthy-run'] },
    { kind: 'run', title: tx('Run a healthy site'), look: { tab: 'results' } },
    {
      kind: 'try',
      title: tx('Drop to 1 API server'),
      text: tx('Now let’s see what overload looks like. Drop the API servers from 3 to 1 and press Run.\n\nWatch the API server card on the canvas and the Results tab: what happens to the queue, p99 latency, and the error rate when one server does the work of three?'),
      patch: [{ node: 'api', params: { instances: 1 } }],
      look: { tab: 'results' },
      show: ['p99', 'failRate', 'busiest'],
    },
    {
      kind: 'try',
      title: tx('Restore 3 API servers'),
      text: tx('Change the API servers back from 1 to 3 and press Run again.\n\nOnce the site has more capacity than incoming traffic again, what happens to the queue and errors?'),
      patch: [{ node: 'api', params: { instances: 3 } }],
      look: { tab: 'results' },
      show: ['p99', 'failRate', 'busiest'],
    },
  ],
};

export default lesson;
