// 1.2 Where is the ceiling? (three-tier / steady, then double traffic): the busiest component
// falls first; Find limit reads the ceiling under the default target. Q6: the "guess the limit"
// question is a run at double traffic (the overload scenario), judged against the same target.
import { t, tx } from '../../i18n/index.ts';
import { DEFAULT_SLO } from '../../engine/limit.ts';
import type { Goal, Lesson } from '../lesson.ts';
import type { RunData } from '../metrics.ts';
import { errorsUnder, failShareOf, ms, p99Under, pct } from '../lessonKit.ts';
import { mostMachines, onlyMachinesOf } from '../courseMachines.ts';

const INTRO = tx(
  'A website that runs smoothly today can still crash tomorrow when traffic doubles. Before a product launch or sale, you need to know two things: your ceiling (the highest traffic the site can handle before breaking) and your headroom (the spare room left between today’s load and that ceiling).\n\nThis is the same three-tier site from 0.1: a load balancer, 3 API servers (4 slots each; each request holds a slot for about 9 ms—6 ms of its own processing time plus about 3 ms waiting on Redis or Postgres), Redis (catching 85% of reads), and Postgres. Right now, a steady 800 requests arrive every second. Throughput—the number of requests the site actually finishes each second—matches 800/s, and nothing is broken yet.\n\nUtilization rises in step with traffic: if a part is 50% busy at 800/s, it hits 100% at 1,600/s. The busiest part hits 100% first and sets the ceiling for the entire site. Guess which component is busiest at 800/s, then press Run.',
);

const LAYERS = ['lb', 'api', 'cache', 'db'];
const busiest = (run: RunData) => {
  const b = run.result.bottleneck?.node;
  return b && LAYERS.includes(b) ? b : 'api';
};
const meetsTarget = (run: RunData) => failShareOf(run) < DEFAULT_SLO.errorRate && run.result.summary.latencyMs.p99 < DEFAULT_SLO.p99Ms;

const apiAtMost5: Goal = {
  text: tx('At most 5 API servers'),
  check: (run) => {
    const n = mostMachines(run, 'api');
    return { ok: n > 0 && n <= 5, value: String(n) };
  },
};

const lesson: Lesson = {
  id: '1.2',
  title: tx('Where is the ceiling?'),
  unit: 1,
  order: 2,
  minutes: 20,
  wave: 1,
  learn: [
    tx('Identify the busiest component that limits the site'),
    tx('Estimate the ceiling and headroom from current utilization'),
    tx('Measure the real ceiling with Find limit'),
    tx('See why pushing past the ceiling causes failures, not just slowness'),
    tx('Add capacity only at the bottleneck'),
  ],
  learnAt: [2, 2, 3, 5, 6],
  recap: [
    tx('The busiest component reaches 100% utilization first and sets the site’s ceiling.'),
    tx('Rough ceiling = current traffic ÷ busiest utilization. Headroom is the spare room below that ceiling.'),
    tx('Past the ceiling, throughput stops growing, queues fill up, and extra requests fail.'),
    tx('Adding capacity anywhere except the bottleneck does not raise the ceiling.'),
  ],
  terms: [
    {
      term: tx('Throughput'),
      plain: tx('How many requests a system actually finishes each second.'),
      example: tx('A coffee shop handing out 40 finished drinks per hour, regardless of how many people are waiting.'),
    },
    {
      term: tx('Ceiling'),
      plain: tx('The highest traffic rate a system can handle before latency or error rates break its target.'),
      example: tx('A bridge that safely holds 100 cars per minute before traffic gridlocks.'),
    },
    {
      term: tx('Headroom'),
      plain: tx('The spare capacity left between normal traffic and the system’s ceiling.'),
      example: tx('Running a highway at 60 cars per minute when its ceiling is 100 leaves 40 cars/min of headroom.'),
    },
  ],
  example: 'three-tier',
  scenario: 'steady',
  intro: INTRO,
  questions: [
    {
      id: 'ceiling-first',
      topic: 'capacity',
      text: tx('At a steady 800 requests/s, which component is the busiest—and therefore the first to give up as traffic grows?'),
      options: [
        { id: 'lb', text: tx('The load balancer') },
        { id: 'api', text: tx('The API servers') },
        { id: 'cache', text: tx('The Redis cache') },
        { id: 'db', text: tx('The Postgres database') },
      ],
      answer: busiest,
      measured: (run) => {
        const b = run.result.bottleneck;
        return b ? t('Busiest: {name}, {u} busy on average', { name: t(b.label), u: pct(b.utilization) }) : t('No bottleneck');
      },
      calc: [
        tx('Hold time per API request ≈ 9 ms (6 ms own processing + ~3 ms waiting on Redis/Postgres)'),
        tx('3 API servers × 4 slots × (1000 ÷ 9 ms) ≈ 1300 requests/s max'),
        tx('At 800/s, API servers are about 800 ÷ 1300 ≈ 60% busy'),
        tx('Ceiling estimate: 800/s ÷ 0.60 ≈ 1300 requests/s (~500/s headroom)'),
      ],
      explain: tx(
        'At 800 requests/s, the API servers are already about 60% busy, while Redis and Postgres stay under 10%. Because utilization grows in step with traffic, if 800/s uses 60% of the API servers, then 100% is roughly 800 ÷ 0.60 ≈ 1,300 requests/s.\n\nThat leaves about 500 requests/s of headroom. Pressing “Find limit” on the run bar tests this automatically by raising traffic until the site breaks its speed or error target.',
      ),
      explainFor: {
        lb: tx('Here the load balancer is the busiest: it is the first component to give up as traffic grows.'),
        cache: tx('Here the cache is the busiest: it is the first component to give up as traffic grows.'),
        db: tx('Here the database is the busiest: it is the first component to give up as traffic grows.'),
      },
    },
    {
      id: 'double',
      topic: 'capacity',
      scenario: 'overload',
      text: tx('Switch to the “Overload” scenario: 1,000 requests/s at first, then 2,000/s for 40 seconds. Using the same pass/fail target as Find limit (p99 under 1 s and under 1% failing), what happens?'),
      options: [
        { id: 'holds', text: tx('It meets the target') },
        { id: 'slow', text: tx('Few fail, but p99 goes over 1 s') },
        { id: 'fails', text: tx('More than 1% fail') },
      ],
      answer: (run) => (meetsTarget(run) ? 'holds' : failShareOf(run) >= DEFAULT_SLO.errorRate ? 'fails' : 'slow'),
      measured: (run) => t('{e} failed, p99 {p}', { e: pct(failShareOf(run)), p: ms(run.result.summary.latencyMs.p99) }),
      explain: tx(
        '2,000 requests/s is far past the site’s ~1,300/s ceiling. Throughput cannot rise above the ceiling, so the extra ~700 requests every second pile up in the API queues.\n\nOnce those queues fill up, requests wait until users give up or get turned away, and failures spike. Past its ceiling, a system does not slow down politely—it fails.',
      ),
      explainFor: {
        holds: tx('It meets the target: this design has enough headroom for double traffic.'),
        slow: tx('Few fail, but p99 goes over 1 s: the design is sitting right at its ceiling, where queues grow long but still drain.'),
      },
    },
  ],
  challenges: [
    {
      id: 'ceiling/double',
      scenario: 'overload',
      title: tx('Room for double'),
      text: tx('Handle the “Overload” scenario (2,000 requests/s for 40 seconds) within the target—under 1% error rate and p99 under 1 s—using at most 5 API servers.'),
      goals: [apiAtMost5, errorsUnder(0.01, tx('Error rate under 1% for the whole run')), p99Under(1000, tx('p99 of successful requests under 1 s'))],
      rules: [onlyMachinesOf('api')],
      hint: tx(
        'One API server has 4 slots, and each request holds a slot for about 9 ms (6 ms own processing plus ~3 ms waiting on Redis or Postgres), so 1 server handles about 4 × (1000 ÷ 9) ≈ 440 requests/s.\n\nDivide 2,000/s by 440/s per server to see how many API servers you need. Adding database connections will not help because Postgres is not the bottleneck.',
      ),
    },
  ],
  steps: [
    { kind: 'read', title: tx('The site at 800/s'), text: INTRO, key: tx('The busiest component hits 100% first and sets the ceiling for the whole site.') },
    { kind: 'guess', title: tx('The busiest component'), questions: ['ceiling-first'] },
    { kind: 'run', title: tx('Run at 800/s'), look: { tab: 'results' } },
    { kind: 'try', title: tx('Find limit'), text: tx('Press “Find limit” on the run bar. It tests the site at higher and higher traffic until either p99 passes 1 second or errors pass 1%, then reports the ceiling and the component that gave up first.\n\nIs the component it names the same one you picked?') },
    { kind: 'guess', title: tx('Double traffic'), questions: ['double'] },
    { kind: 'run', title: tx('Run the overload'), scenario: 'overload', look: { panel: 'bottom' } },
    { kind: 'try', title: tx('More database connections'), text: tx('Double the database’s connections (how many queries Postgres handles at once) from 12 to 24, then press “Find limit” again. Does the ceiling move?\n\nNext, change the API servers’ Instances to 6 and press “Find limit” again: which change actually raised the ceiling?'), patch: [{ node: 'db', params: { connections: 24 } }] },
    { kind: 'challenge', title: tx('Room for double'), challenges: ['ceiling/double'] },
  ],
};

export default lesson;
