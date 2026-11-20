// 1.1 Little's law and one server (single-server / steady): ρ = λ/(cμ), L = λW, and why waiting
// explodes as ρ nears 1.
import { t, tx } from '../../i18n/index.ts';
import { noMoreCapacity, type Goal, type Lesson } from '../lesson.ts';
import type { RunData } from '../metrics.ts';
import { failUnder1, p99Under, paramOf, pct } from '../lessonKit.ts';
import { meanOf, mostMachines } from '../courseMachines.ts';

const INTRO = tx('One API server, called directly, with the network left out. It works on 4 requests at a time (4 slots; c = 4 in the formulas); each takes 2.5 ms on average. Users send 800 requests a second, so it can do 4 × 1000 ÷ 2.5 = 1600 a second and is busy half the time (utilization ρ = 800 ÷ 1600). Guess how much requests wait, then press Run.');

const api = (run: RunData) => run.result.nodes.api;
/** Average wait in the queue ÷ average time being worked on. */
const waitShare = (run: RunData) => {
  const n = api(run);
  return n?.holdMs ? (n.waitMs ?? 0) / n.holdMs : 0;
};
/** Little's law: requests inside the server on average = arrival rate × time inside. */
const inside = (run: RunData) => {
  const n = api(run);
  return n ? (n.rps * ((n.waitMs ?? 0) + (n.holdMs ?? 0))) / 1000 : 0;
};
const serviceMean = (run: RunData) => {
  const v = paramOf(run.design, 'api', 'serviceMs');
  return meanOf(v);
};

const slower: Goal = {
  text: tx('Each request takes 4.5 ms or more on average'),
  check: (run) => {
    const m = serviceMean(run);
    return { ok: m !== undefined && m >= 4.5, value: m === undefined ? '—' : `${m} ms` };
  },
};
const oneServer: Goal = {
  text: tx('Still one API server'),
  check: (run) => {
    const n = mostMachines(run, 'api');
    return { ok: n === 1, value: String(n) };
  },
};
const busy80: Goal = {
  text: tx('The API server is at least 80% busy'),
  check: (run) => ({ ok: (api(run)?.utilization ?? 0) >= 0.8, value: pct(api(run)?.utilization ?? 0) }),
};

const lesson: Lesson = {
  id: '1.1',
  title: tx('Little’s law and one server'),
  unit: 1,
  order: 1,
  minutes: 20,
  wave: 1,
  learn: [
    tx("Work out how busy a server is: ρ = λ ÷ (c × μ)"),
    tx("Use Little’s law to turn a rate and a time into a count"),
    tx("See how waiting grows as a server nears 100% busy"),
    tx("See that variation costs queueing too"),
    tx("Find the knee where p99 starts to climb"),
  ],
  learnAt: [0, 2, 3, 4, 5],
  recap: [
    tx("ρ = λ ÷ (c × μ): the same traffic on slower or fewer slots is busier."),
    tx("Little’s law, L = λ × W, holds for any queue."),
    tx("Past about 85% busy, the wait grows much faster than the load; a wider spread of times makes it grow more."),
    tx("Plan for 70–80% busy, not 100%."),
  ],
  example: 'single-server',
  scenario: 'steady',
  intro: INTRO,
  questions: [
    {
      id: 'wait-share',
      topic: 'queueing',
      text: tx('At 50% busy, how long does a request wait in the queue before the server starts on it, compared with the 2.5 ms of work?'),
      options: [
        { id: 'none', text: tx('Almost no wait (under 3% of the work time)') },
        { id: 'some', text: tx('A little (3% to 30%)') },
        { id: 'same', text: tx('About as long as the work (30% to 100%)') },
        { id: 'more', text: tx('Longer than the work') },
      ],
      answer: (run) => {
        const s = waitShare(run);
        return s < 0.03 ? 'none' : s < 0.3 ? 'some' : s <= 1 ? 'same' : 'more';
      },
      measured: (run) => t('Wait {w} ms for {h} ms of work ({s})', { w: (api(run)?.waitMs ?? 0).toFixed(2), h: (api(run)?.holdMs ?? 0).toFixed(2), s: pct(waitShare(run)) }),
      explain: tx('Requests arrive at random, so even at 50% busy some arrive while all 4 slots are taken and wait a little. The theory row (M/G/c) predicts this wait from ρ and the 4 slots; compare it with the measured wait on the Results tab: they agree.'),
      explainFor: {
        none: tx('Almost nobody waits: the server has plenty of room for this load.'),
        same: tx('Requests wait about as long as they are worked on: the server is close to full.'),
        more: tx('Requests wait longer than they are worked on: the server is nearly full, and the queue, not the work, sets the latency.'),
      },
    },
    {
      id: 'inside',
      topic: 'queueing',
      text: tx("Little’s law: requests inside = arrivals per second × seconds each one spends inside. On average, how many requests are inside the server at once (being worked on or waiting)?"),
      options: [
        { id: 'one', text: tx('About 1') },
        { id: 'two', text: tx('About 2') },
        { id: 'four', text: tx('About 4, every slot') },
        { id: 'many', text: tx('More than 6') },
      ],
      answer: (run) => {
        const l = inside(run);
        return l < 1.5 ? 'one' : l < 3 ? 'two' : l < 6 ? 'four' : 'many';
      },
      measured: (run) => t('{n} inside on average ({rps}/s × {ms} ms)', { n: inside(run).toFixed(1), rps: Math.round(api(run)?.rps ?? 0), ms: ((api(run)?.waitMs ?? 0) + (api(run)?.holdMs ?? 0)).toFixed(2) }),
      calc: [tx('L = λ × W'), tx('800/s × about 2.7 ms ≈ 2 requests inside'), tx('2 of 4 slots = 50% busy')],
      explain: tx('About 2 requests are inside on average: 2 of the 4 slots are busy, which is the same 50% from the other side. Little’s law holds for any queue, whatever the distribution; it turns a rate and a time into a count.'),
      explainFor: {
        four: tx('About 4 inside: every slot is busy most of the time, and new requests start to queue.'),
        many: tx('More than 6 inside: the slots are full and the rest are waiting in the queue. The time inside is mostly waiting.'),
      },
    },
  ],
  challenges: [
    {
      id: 'littles/slower-release',
      title: tx('A slower release'),
      text: tx('A new release makes each request take 4.5 ms (set the processing time to 4.5 ms or more). The server is now 90% busy and p99 grows about 4 times. Bring p99 under 25 ms, still with one server, and do not turn requests away (under 1% fail).'),
      goals: [slower, oneServer, failUnder1, p99Under(25, tx('p99 of successful requests under 25 ms'))],
      rules: [],
      hint: tx('ρ = λ ÷ (c × μ). λ is fixed and each request is slower, so the only lever left on one server is c: how many requests it works on at a time.'),
    },
    {
      id: 'littles/knee',
      title: tx('Find the knee'),
      text: tx('Run the server at least 80% busy with p99 under 40 ms, without adding capacity: make each request slower until you find where p99 starts to climb.'),
      goals: [busy80, p99Under(40, tx('p99 of successful requests under 40 ms')), failUnder1],
      rules: [noMoreCapacity],
      hint: tx('Raise the processing time a little at a time (3.5, 4, 4.2 ms…) and watch p99: from 50% to 80% busy it grows slowly, and past about 85% it shoots up. That bend is why people plan for 70–80% busy, not 100%.'),
    },
  ],
  steps: [
    { kind: 'read', title: tx('One server'), text: INTRO, key: tx('Utilization ρ = arrivals per second ÷ what the server can do per second.') },
    { kind: 'guess', title: tx('Wait and requests inside'), questions: ['wait-share', 'inside'] },
    { kind: 'run', title: tx('Run at 50% busy'), look: { node: 'api', tab: 'results' } },
    { kind: 'try', title: tx('A slower release'), text: tx('Set the processing time to 4.5 ms (90% busy) and run again. How long do requests wait now, compared with the work? Does the theory row still match?'), patch: [{ node: 'api', params: { serviceMs: { mean: 4.5, cv: 1 } } }], show: ['p99', 'p50', 'busiest'] },
    { kind: 'try', title: tx('A wider spread'), text: tx('Keep 4.5 ms and set the variation (cv) to 2: the same average, a wider spread. Run again: does the wait change?'), patch: [{ node: 'api', params: { serviceMs: { mean: 4.5, cv: 2 } } }], show: ['p99', 'p50', 'busiest'] },
    { kind: 'challenge', title: tx('Two challenges'), challenges: ['littles/slower-release', 'littles/knee'] },
  ],
};

export default lesson;
