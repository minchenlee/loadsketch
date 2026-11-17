// 1.2 Where is the ceiling? (three-tier / steady, then double traffic): the busiest component
// falls first; Find limit reads the ceiling under the default target. Q6: the "guess the limit"
// question is a run at double traffic (the overload scenario), judged against the same target.
import { t, tx } from '../../i18n/index.ts';
import { DEFAULT_SLO } from '../../engine/limit.ts';
import type { Goal, Lesson } from '../lesson.ts';
import type { RunData } from '../metrics.ts';
import { errorsUnder, failShareOf, ms, p99Under, pct } from '../lessonKit.ts';
import { mostMachines } from '../courseMachines.ts';

const INTRO = tx('The same three-tier site at a steady 800 requests a second: a load balancer, 3 API servers, Redis and Postgres. Nothing is wrong yet. How much more traffic can it take, and which part gives up first? Guess, then press Run.');

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
  example: 'three-tier',
  scenario: 'steady',
  intro: INTRO,
  questions: [
    {
      id: 'ceiling-first',
      topic: 'capacity',
      text: tx('At 800 requests a second, which component is the busiest, and so the first to give up as traffic grows?'),
      options: [
        { id: 'lb', text: tx('The load balancer') },
        { id: 'api', text: tx('The API servers') },
        { id: 'cache', text: tx('The Redis cache') },
        { id: 'db', text: tx('The database') },
      ],
      answer: busiest,
      measured: (run) => {
        const b = run.result.bottleneck;
        return b ? t('Busiest: {name}, {u} busy on average', { name: t(b.label), u: pct(b.utilization) }) : t('No bottleneck');
      },
      explain: tx('The API servers are about 60% busy at 800 a second; Redis and Postgres are under 10%. Utilisation grows in step with traffic, so the API servers reach 100% first, at roughly 800 ÷ 0.6 ≈ 1300 a second. Find limit (on the run bar) checks this by running more and more traffic until the target breaks.'),
      explainFor: {
        lb: tx('Here the load balancer is the busiest: it is the first to give up as traffic grows.'),
        cache: tx('Here the cache is the busiest: it is the first to give up as traffic grows.'),
        db: tx('Here the database is the busiest: it is the first to give up as traffic grows.'),
      },
    },
    {
      id: 'double',
      topic: 'capacity',
      scenario: 'overload',
      text: tx('Open the scenario “Overload”: 1000 requests a second, then 2000 a second for 40 seconds. The target is the one Find limit uses: p99 under 1 s and under 1% of requests failing. What happens?'),
      options: [
        { id: 'holds', text: tx('It meets the target') },
        { id: 'slow', text: tx('Few fail, but p99 goes over 1 s') },
        { id: 'fails', text: tx('More than 1% fail') },
      ],
      answer: (run) => (meetsTarget(run) ? 'holds' : failShareOf(run) >= DEFAULT_SLO.errorRate ? 'fails' : 'slow'),
      measured: (run) => t('{e} failed, p99 {p}', { e: pct(failShareOf(run)), p: ms(run.result.summary.latencyMs.p99) }),
      explain: tx('Double traffic is well past the ceiling of about 1300 a second. The API queues fill, requests wait until they time out or are turned away, and most of the double-traffic part fails. Past the ceiling a system does not slow down gently: it fails.'),
      explainFor: {
        holds: tx('It meets the target: this design has room for double traffic.'),
        slow: tx('Few fail but p99 is over 1 s: the design is right at its ceiling, where queues are long but still drain.'),
      },
    },
  ],
  challenges: [
    {
      id: 'ceiling/double',
      scenario: 'overload',
      title: tx('Room for double'),
      text: tx('With the “Overload” scenario (2000 a second for 40 seconds), meet the target (under 1% fail, p99 under 1 s) with at most 5 API servers.'),
      goals: [apiAtMost5, errorsUnder(0.01, tx('Error rate under 1% for the whole run')), p99Under(1000, tx('p99 of successful requests under 1 s'))],
      rules: [],
      hint: tx('One API server does about 4 ÷ 9 ms ≈ 450 requests a second. How many does 2000 a second need? Adding database connections does not help: the database was never the busy part.'),
    },
  ],
  steps: [
    { kind: 'read', text: INTRO },
    { kind: 'guess', questions: ['ceiling-first'] },
    { kind: 'run' },
    { kind: 'try', text: tx('Press “Find limit” on the run bar. It runs the design at more and more traffic and reports the most that met the target and the component that gave up first. Compare that component with your answer.') },
    { kind: 'guess', questions: ['double'] },
    { kind: 'run', scenario: 'overload' },
    { kind: 'try', text: tx('Double the database connections and find the limit again: it does not move, because the database was not the bottleneck. Then set the API servers to 6 and find it again: the ceiling about doubles.'), patch: [{ node: 'db', params: { connections: 24 } }] },
    { kind: 'challenge', challenges: ['ceiling/double'] },
  ],
};

export default lesson;
