// 1.5 Autoscaling is slow (autoscale / flash-crowd): the delay is the check interval plus the boot
// time; the checks keep adding while instances boot; headroom (a lower target) buys time.
import { t, tx } from '../../i18n/index.ts';
import { noMoreCapacity, type Goal, type Lesson } from '../lesson.ts';
import { isBad, measured, type RunData } from '../metrics.ts';
import { errorsUnder, paramOf, pct } from '../lessonKit.ts';

const INTRO = tx('API servers that scale themselves: 2 instances normally, more when they are over 60% busy, up to 12. They check once a minute, and a new instance takes 2 minutes to boot. Traffic is 300 requests a second, and at minute 5 it triples for 20 minutes. Guess how the autoscaler copes, then press Run (30 simulated minutes take a few seconds).');

/** The spike: when it starts and ends (seconds). */
const spikeOf = (run: RunData) => {
  const e = (run.scenario.events ?? []).find((x) => x.type === 'spike');
  return e && e.type === 'spike' ? { from: e.atS, to: e.atS + (e.forS ?? 0) } : { from: 0, to: run.scenario.durationS ?? 0 };
};
/** Seconds from the start of the spike to the end of the last failing second inside it (0: none failed). */
export const failingFor = (run: RunData) => {
  const { from, to } = spikeOf(run);
  let last = -1;
  for (const w of measured(run).windows) if (w.t > from && w.t <= to + 1e-9 && isBad(w)) last = w.t;
  return last < 0 ? 0 : last - from;
};
const scaling = (run: RunData) => run.result.nodes.api?.autoscale;
const num = (run: RunData, key: string) => {
  const v = paramOf(run.design, 'api', key);
  return typeof v === 'number' ? v : undefined;
};
const designIs = (key: string, ok: (v: number) => boolean, text: string, unit = ''): Goal => ({
  text,
  check: (run) => {
    const v = num(run, key);
    return { ok: v !== undefined && ok(v), value: v === undefined ? '—' : `${v}${unit}` };
  },
});

const lesson: Lesson = {
  id: '1.5',
  title: tx('Autoscaling is slow'),
  unit: 1,
  order: 5,
  minutes: 25,
  wave: 1,
  example: 'autoscale',
  scenario: 'flash-crowd',
  intro: INTRO,
  questions: [
    {
      id: 'failing-for',
      topic: 'recovery',
      text: tx('Traffic triples at minute 5. For how long do requests keep failing?'),
      options: [
        { id: 'quick', text: tx('Under a minute') },
        { id: 'minutes', text: tx('A few minutes (1 to 5)') },
        { id: 'long', text: tx('More than 5 minutes') },
      ],
      answer: (run) => {
        const s = failingFor(run);
        return s < 60 ? 'quick' : s <= 300 ? 'minutes' : 'long';
      },
      measured: (run) => {
        const s = failingFor(run);
        return s === 0 ? t('No second failed during the spike') : t('Failing until {s} s after the spike started', { s: Math.round(s) });
      },
      explain: tx('The autoscaler first has to notice: it checks once a minute. Then each new instance boots for 2 minutes. Until they are up, the 2 old instances get 3 times the traffic, their queues fill and requests fail. Check interval + boot time is the floor on how fast autoscaling can help.'),
      explainFor: {
        quick: tx('Failures stop within a minute: new instances come up fast enough here (short boot time or frequent checks), or there was spare capacity before the spike.'),
        long: tx('Failures last more than 5 minutes: booting takes so long that the spike is mostly over before help arrives.'),
      },
    },
    {
      id: 'overshoot',
      topic: 'capacity',
      text: tx('At 900 a second, about 4 instances are enough to be 60% busy. How many instances run at the peak?'),
      options: [
        { id: 'short', text: tx('Fewer than 4') },
        { id: 'right', text: tx('4 or 5') },
        { id: 'over', text: tx('6 or more') },
      ],
      answer: (run) => {
        const p = scaling(run)?.peakActive ?? 0;
        return p < 4 ? 'short' : p <= 5 ? 'right' : 'over';
      },
      measured: (run) => {
        const a = scaling(run);
        return a ? t('{peak} at the peak, {end} at the end', { peak: a.peakActive, end: a.endActive }) : t('No autoscaling');
      },
      explain: tx('While the first new instances boot, the next checks still see the old ones at 100% and add more. When they all come up there are too many, and they are removed only after the scale-down window (5 minutes in a row of not needing them). Slow scaling overshoots, then slowly comes back.'),
      explainFor: {
        short: tx('Fewer than needed: the autoscaler hit its maximum, or it never saw the servers busy enough to add.'),
        right: tx('About what is needed: new instances came up before the next checks could add extra ones.'),
      },
    },
  ],
  challenges: [
    {
      id: 'autoscale/faster',
      title: tx('Scale faster'),
      text: tx('Keep the 60% target and the instance limits, and bring the failures of the whole run under 1% by changing how fast the autoscaler reacts.'),
      goals: [designIs('targetUtil', (v) => v >= 0.6, tx('The target is still 60% busy or more')), errorsUnder(0.01, tx('Error rate under 1% for the whole run'))],
      rules: [noMoreCapacity],
      hint: tx('Two delays add up: the check interval and the boot time. Pre-warmed instances (a boot of 10–30 s) alone are not enough while the autoscaler still waits a minute to notice; shorten both.'),
    },
    {
      id: 'autoscale/headroom',
      title: tx('Headroom instead of speed'),
      text: tx('Boot still takes 2 minutes and checks still come once a minute. Make the flash crowd fail almost nothing (under 0.1%).'),
      goals: [
        designIs('bootS', (v) => v >= 120, tx('Boot time 120 s or more'), ' s'),
        designIs('scaleEveryS', (v) => v >= 60, tx('Check interval 60 s or more'), ' s'),
        { text: tx('Error rate under 0.1% for the whole run'), check: (run) => ({ ok: run.result.summary.errorRate < 0.001, value: pct(run.result.summary.errorRate) }) },
      ],
      rules: [noMoreCapacity],
      hint: tx('If scaling cannot be faster, it has to start earlier: a lower target keeps more instances running before the spike, so the spike lands on spare capacity while new instances boot. The cost is idle machines the rest of the time.'),
    },
  ],
  steps: [
    { kind: 'read', text: INTRO },
    { kind: 'guess', questions: ['failing-for', 'overshoot'] },
    { kind: 'run' },
    { kind: 'try', text: tx('Set the boot time to 300 s and run again: the failing stretch gets longer, and the failure rate about doubles.'), patch: [{ node: 'api', params: { bootS: 300 } }] },
    { kind: 'try', text: tx('Set the boot time to 10 s (pre-warmed instances): failures drop but do not stop, because the autoscaler still waits up to a minute to notice. Then set the check interval to 15 s as well.'), patch: [{ node: 'api', params: { bootS: 10 } }] },
    { kind: 'challenge', challenges: ['autoscale/faster', 'autoscale/headroom'] },
    { kind: 'practice', items: [{ kind: 'constraint', id: 'spike-budget' }] },
  ],
};

export default lesson;
