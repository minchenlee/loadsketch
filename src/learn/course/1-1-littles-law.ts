// 1.1 Little's law and one server (single-server / steady): ρ = λ/(cμ), L = λW, and why waiting
// explodes as ρ nears 1.
import { t, tx } from '../../i18n/index.ts';
import { noMoreCapacity, type Goal, type Lesson } from '../lesson.ts';
import type { RunData } from '../metrics.ts';
import { failUnder1, p99Under, paramOf, pct } from '../lessonKit.ts';
import { meanOf, mostMachines } from '../courseMachines.ts';

const INTRO = tx(
  'Before sizing a large website, you need to understand how a single server behaves. Even a server that is only half busy can make requests wait in line, and once it nears 100% busy, wait times shoot up rapidly.\n\nThis simulation isolates 1 API server with zero network delay so the math stays crystal clear. Three numbers describe its workload: arrival rate (how many requests show up each second—here, 800/s, like customers walking into a coffee shop), service time (how long the server works on one request—here, 2.5 ms or 0.0025 s on average, like making one coffee), and concurrency (how many requests it works on at once—here, 4 slots, like 4 baristas behind the counter).\n\nLet’s do the math in plain words first. Because 1 second is 1,000 ms, one slot finishes 1,000 ÷ 2.5 = 400 requests per second. With 4 slots, the server can handle 4 × 400 = 1,600 requests per second. Since 800 arrive each second, the server is half busy: 800 ÷ 1,600 = 50%. That busy share is called utilization. In textbooks, you will see this written as ρ = λ ÷ (c × μ), where ρ is utilization, λ is arrival rate (800/s), c is concurrency (4 slots), and μ is one slot’s speed (400/s).\n\nTwo more ideas help you predict this run. First, requests arrive at random times rather than like clockwork, so tiny clusters briefly fill all 4 slots and cause short waits even at 50% busy. Second, Little’s Law connects traffic speed to headcount: average requests inside = arrival rate × average seconds each spends inside (written L = λ × W). For example, if 2 people enter a shop per minute and each stays 5 minutes, about 10 people are inside at once. Guess how long requests wait and how many sit inside the server at once, then press Run.',
);

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
    tx('Calculate server utilization from arrival rate, slots, and service time'),
    tx('Use Little’s Law to find how many requests sit inside a server at once'),
    tx('Watch queue wait times explode as a server nears 100% busy'),
    tx('See how unpredictable service times make queues longer'),
    tx('Find the “knee” where p99 starts climbing sharply'),
  ],
  learnAt: [0, 2, 3, 4, 5],
  recap: [
    tx('Utilization = arrival rate ÷ max speed (ρ = λ ÷ (c × μ)). Slower work or fewer slots make a server busier.'),
    tx('Little’s Law (L = λ × W) turns arrival rate and time inside into the average number of requests inside any queue.'),
    tx('Past about 85% busy, wait times grow much faster than traffic. Unpredictable work times push waits even higher.'),
    tx('Plan for 70–80% utilization at peak, never 100%.'),
  ],
  terms: [
    {
      term: tx('Arrival rate'),
      plain: tx('How many new requests arrive at a server each second (symbol λ).'),
      example: tx('10 customers walking through a coffee shop door every minute.'),
    },
    {
      term: tx('Service time'),
      plain: tx('How long a server actively works on one request once its turn begins.'),
      example: tx('A barista taking 30 seconds to brew one latte, not counting line wait.'),
    },
    {
      term: tx('Concurrency'),
      plain: tx('How many requests one server can work on at the exact same time (its number of slots, symbol c).'),
      example: tx('Having 4 baristas behind the counter making 4 drinks in parallel.'),
    },
    {
      term: tx('Little’s Law'),
      plain: tx('A universal rule saying average items inside a system equal arrival rate times average time spent inside (L = λ × W).'),
      example: tx('If 2 people enter a shop per minute and each stays 5 minutes, about 10 people are inside.'),
    },
    {
      term: tx('Utilization'),
      plain: tx('The percentage of a server’s maximum capacity currently in use (symbol ρ).'),
      example: tx('If 2 out of 4 baristas are busy on average, the shop runs at 50% utilization.'),
    },
  ],
  example: 'single-server',
  scenario: 'steady',
  intro: INTRO,
  questions: [
    {
      id: 'wait-share',
      topic: 'queueing',
      text: tx('At 50% utilization, how long does a request wait in the queue before a slot opens, compared with its 2.5 ms of work?'),
      options: [
        { id: 'none', text: tx('Almost no wait (under 3% of work time)') },
        { id: 'some', text: tx('A short wait (3% to 30% of work time)') },
        { id: 'same', text: tx('About as long as the work (30% to 100%)') },
        { id: 'more', text: tx('Longer than the work itself') },
      ],
      answer: (run) => {
        const s = waitShare(run);
        return s < 0.03 ? 'none' : s < 0.3 ? 'some' : s <= 1 ? 'same' : 'more';
      },
      measured: (run) => t('Wait {w} ms for {h} ms of work ({s})', { w: (api(run)?.waitMs ?? 0).toFixed(2), h: (api(run)?.holdMs ?? 0).toFixed(2), s: pct(waitShare(run)) }),
      explain: tx(
        'Requests arrive at random, not on a metronome. Even at 50% busy, small clusters occasionally arrive while all 4 slots are taken, so a few requests wait briefly.\n\nBecause traffic is steady here (no spikes), compare the measured wait with the theory row on the Results tab: they closely agree.',
      ),
      explainFor: {
        none: tx('Almost nobody waits: the server has plenty of spare room for this load.'),
        same: tx('Requests wait about as long as they are worked on: the server is close to full.'),
        more: tx('Requests wait longer than they are worked on: the server is nearly full, so the queue—not the actual work—drives latency.'),
      },
    },
    {
      id: 'inside',
      topic: 'queueing',
      text: tx('Use Little’s Law: requests inside = arrival rate × seconds spent inside. At 800 requests/s and roughly 2.5 ms (0.0025 s) inside, about how many requests are inside the server at once (working or waiting)?'),
      options: [
        { id: 'one', text: tx('About 1') },
        { id: 'two', text: tx('About 2') },
        { id: 'four', text: tx('About 4 (every slot full)') },
        { id: 'many', text: tx('More than 6') },
      ],
      answer: (run) => {
        const l = inside(run);
        return l < 1.5 ? 'one' : l < 3 ? 'two' : l < 6 ? 'four' : 'many';
      },
      measured: (run) => t('{n} inside on average ({rps}/s × {ms} ms)', { n: inside(run).toFixed(1), rps: Math.round(api(run)?.rps ?? 0), ms: ((api(run)?.waitMs ?? 0) + (api(run)?.holdMs ?? 0)).toFixed(2) }),
      calc: [
        tx('Plain words: requests inside = arrival rate × seconds inside'),
        tx('With symbols (Little’s Law): L = λ × W'),
        tx('800 requests/s × 0.0025 s (2.5 ms) = 2 working (+ tiny wait ≈ 2 inside)'),
        tx('2 busy slots out of 4 slots = 50% utilization'),
      ],
      explain: tx(
        'About 2 requests sit inside the server on average. Filling 2 of the 4 slots is the exact same 50% utilization seen from the inside.\n\nLittle’s Law holds for every waiting line, whether requests take uniform times or vary wildly: it turns a traffic rate and a duration into an average headcount.',
      ),
      explainFor: {
        four: tx('About 4 inside: every slot is busy most of the time, so new requests start forming a queue.'),
        many: tx('More than 6 inside: all 4 slots are full and extra requests are waiting in line. Most of the time inside is now spent waiting.'),
      },
    },
  ],
  challenges: [
    {
      id: 'littles/slower-release',
      title: tx('A slower release'),
      text: tx('Suppose a code update slows each request down to 4.5 ms or more (set Process time to at least 4.5 ms). The server jumps to 90% busy and p99 climbs sharply.\n\nBring p99 under 25 ms while keeping just 1 server and under 1% failed requests.'),
      goals: [slower, oneServer, failUnder1, p99Under(25, tx('p99 of successful requests under 25 ms'))],
      rules: [],
      hint: tx('Arrival rate (800/s) and the slower service time (4.5 ms) are fixed, and you may only use 1 server. To lower utilization below 90%, raise “Concurrency per instance” (c) so that single server works on more requests at once.'),
    },
    {
      id: 'littles/knee',
      title: tx('Find the knee'),
      text: tx('Push the server to at least 80% busy while keeping p99 under 40 ms and failures under 1%. Do not add servers or slots—slow down Process time step by step until you find the sharp bend (the “knee”) where p99 starts climbing fast.'),
      goals: [busy80, p99Under(40, tx('p99 of successful requests under 40 ms')), failUnder1],
      rules: [noMoreCapacity],
      hint: tx(
        'Raise Process time in small steps (for example 3.5 ms, then 4.0 ms, then 4.2 ms) and watch p99.\n\nFrom 50% to 80% busy, p99 rises gently. Past about 85% busy, queues shoot upward. That bend is why engineers plan for 70–80% busy instead of 100%.',
      ),
    },
  ],
  steps: [
    { kind: 'read', title: tx('One server'), text: INTRO, key: tx('Utilization = arrival rate ÷ max speed. Little’s Law: items inside = arrival rate × time inside.') },
    { kind: 'guess', title: tx('Wait and requests inside'), questions: ['wait-share', 'inside'] },
    { kind: 'run', title: tx('Run at 50% busy'), look: { node: 'api', tab: 'results' } },
    { kind: 'try', title: tx('A slower release'), text: tx('Raise Process time from 2.5 ms to 4.5 ms (pushing the server to 90% busy) and run again. How much longer do requests wait compared with the actual work, and does the theory row still match?'), patch: [{ node: 'api', params: { serviceMs: { mean: 4.5, cv: 1 } } }], show: ['p99', 'p50', 'busiest'] },
    { kind: 'try', title: tx('A wider spread'), text: tx('Keep the average Process time at 4.5 ms, but raise variation (cv) from 1 to 2. Higher variation means request times are less predictable—many are quick while a few are much slower, like a coffee shop where most orders are simple and a few are huge group orders.\n\nRun again: with the exact same average work time, does the queue wait change?'), patch: [{ node: 'api', params: { serviceMs: { mean: 4.5, cv: 2 } } }], show: ['p99', 'p50', 'busiest'] },
    { kind: 'challenge', title: tx('Two challenges'), challenges: ['littles/slower-release', 'littles/knee'] },
  ],
};

export default lesson;
