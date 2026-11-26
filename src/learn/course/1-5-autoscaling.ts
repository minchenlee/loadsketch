// 1.5 Autoscaling is slow (autoscale / flash-crowd): the delay is the check interval plus the boot
// time; the checks keep adding while instances boot; headroom (a lower target) buys time.
import { t, tx } from '../../i18n/index.ts';
import { noMoreCapacity, type Goal, type Lesson } from '../lesson.ts';
import { isBad, measured, type RunData } from '../metrics.ts';
import { errorsUnder, failShareOf, paramOf, pct } from '../lessonKit.ts';

const INTRO = tx(
  'Website traffic rarely stays flat all day. Paying for enough servers 24/7 to handle a rare viral surge wastes money, so cloud systems use autoscaling: automatically adding servers when traffic rises and removing them when traffic falls, like a grocery store calling extra cashiers to the registers during a rush.\n\nHelp does not arrive right away. First, the autoscaler checks how busy the servers are only once every 60 seconds (Check interval). Next, each new server needs 120 seconds to start up (Boot time), and for its first 20 seconds online it runs 3 times slower than normal while warming up—a cold start. Waiting to notice plus booting creates scale-out lag.\n\nNormally, 2 API servers handle 300 requests/s easily. Whenever average utilization passes 60%, the autoscaler adds more servers (up to 12). Because it only counts running servers—not ones still booting—later 1-minute checks keep seeing the original 2 servers maxed out and keep ordering more. Extra servers are removed only after 5 quiet minutes in a row (the scale-down window).\n\nAt minute 5, a sudden wave of visitors triples traffic to 900 requests/s for 20 minutes. Guess how long requests fail and how many servers end up running at the peak, then press Run (30 simulated minutes take only a few seconds).',
);

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
  learn: [
    tx('See how long a sudden traffic surge fails while autoscaling catches up'),
    tx('Understand why slow autoscaling adds too many servers, then shrinks slowly'),
    tx('See how check interval and boot time add up to scale-out lag'),
    tx('Use spare headroom when scaling cannot be faster'),
  ],
  learnAt: [2, 2, 4, 5],
  recap: [
    tx('Scale-out lag = check interval + boot time (plus cold-start warm-up). Help arrives only after both finish.'),
    tx('Checks that run while servers are still booting keep ordering more, so slow autoscaling overshoots.'),
    tx('Fast boots alone are not enough if checks are slow; shorten both to shrink scale-out lag.'),
    tx('When scaling cannot be faster, lower Target utilization to keep spare headroom—trading idle server cost for reliability.'),
  ],
  terms: [
    {
      term: tx('Autoscaling'),
      plain: tx('Automatically adding servers when traffic rises and removing them when traffic drops.'),
      example: tx('A supermarket opening extra checkout lanes during the evening rush and closing them later.'),
    },
    {
      term: tx('Cold start'),
      plain: tx('The startup delay and brief slower period when a brand-new server boots up and warms its memory before reaching full speed.'),
      example: tx('A backup chef stepping into the kitchen who still needs a few minutes to preheat the oven.'),
    },
    {
      term: tx('Scale-out lag'),
      plain: tx('The total gap between traffic jumping and new servers actually taking load—check interval plus boot time.'),
      example: tx('Noticing a long line after 5 minutes, then waiting another 10 minutes for extra staff to arrive.'),
    },
  ],
  example: 'autoscale',
  scenario: 'flash-crowd',
  intro: INTRO,
  questions: [
    {
      id: 'failing-for',
      topic: 'recovery',
      text: tx('Traffic triples at minute 5. Because the autoscaler checks every 60 s and new servers take 120 s to boot, how long do requests keep failing?'),
      options: [
        { id: 'quick', text: tx('Under 1 minute') },
        { id: 'minutes', text: tx('A few minutes (1 to 5 minutes)') },
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
      calc: [tx('Up to 60 s waiting for the next check + 120 s boot time = up to 3 minutes of scale-out lag')],
      explain: tx(
        'Requests keep failing for a few minutes. First, the autoscaler waits up to 60 seconds for its next check. Then each new server needs 120 seconds to boot (and briefly runs slower during its cold start).\n\nUntil those new servers come online, the original 2 servers take 3 times their normal load, their queues overflow, and users see errors. Check interval plus boot time is the shortest possible scale-out lag.',
      ),
      explainFor: {
        quick: tx('Failures stop within a minute: new servers came up quickly here (short boot time and frequent checks), or there was already enough spare headroom before the surge.'),
        long: tx('Failures last more than 5 minutes: booting takes so long that users suffer through a huge chunk of the surge before help arrives.'),
      },
    },
    {
      id: 'overshoot',
      topic: 'capacity',
      text: tx('At 900 requests/s, about 5 servers are enough to sit near 60% busy. How many servers end up running at the peak?'),
      options: [
        { id: 'short', text: tx('Fewer than 5') },
        { id: 'right', text: tx('5 or 6') },
        { id: 'over', text: tx('7 or more') },
      ],
      answer: (run) => {
        const p = scaling(run)?.peakActive ?? 0;
        return p < 5 ? 'short' : p <= 6 ? 'right' : 'over';
      },
      measured: (run) => {
        const a = scaling(run);
        return a ? t('{peak} at the peak, {end} at the end', { peak: a.peakActive, end: a.endActive }) : t('No autoscaling');
      },
      explain: tx(
        'While the first new servers are still booting, the next 1-minute checks still see the original 2 servers at 100% busy and order even more.\n\nOnce every booting server finally comes online, there are too many. They stay running until the 5-minute scale-down window confirms traffic no longer needs them (which keeps a brief dip from turning servers off too soon). Slow scaling overshoots, then shrinks slowly.',
      ),
      explainFor: {
        short: tx('Fewer than needed: the autoscaler hit its upper limit, or never saw the servers busy enough to add more.'),
        right: tx('Right around what is needed: new servers came online before later checks could order extras.'),
      },
    },
  ],
  challenges: [
    {
      id: 'autoscale/faster',
      title: tx('Scale faster'),
      text: tx('Keep “Target utilization” at 60% or higher and leave the server limits unchanged. Bring the whole run’s error rate under 1% by cutting scale-out lag.'),
      goals: [designIs('targetUtil', (v) => v >= 0.6, tx('The target is still 60% busy or more')), errorsUnder(0.01, tx('Error rate under 1% for the whole run'))],
      rules: [noMoreCapacity],
      hint: tx(
        'Scale-out lag is the sum of two delays: “Check interval” and “Boot time”.\n\nFast 10–30 s boots alone are not enough if the autoscaler still waits 60 s just to notice the surge. Shorten both settings.',
      ),
    },
    {
      id: 'autoscale/headroom',
      title: tx('Headroom instead of speed'),
      text: tx('Keep “Boot time” at 120 s or more and “Check interval” at 60 s or more. Without faster scaling, keep the whole run’s error rate under 0.1%.'),
      goals: [
        designIs('bootS', (v) => v >= 120, tx('Boot time 120 s or more'), ' s'),
        designIs('scaleEveryS', (v) => v >= 60, tx('Check interval 60 s or more'), ' s'),
        { text: tx('Error rate under 0.1% for the whole run'), check: (run) => ({ ok: failShareOf(run) < 0.001, value: pct(failShareOf(run)) }) },
      ],
      rules: [noMoreCapacity],
      hint: tx(
        'When scaling cannot react faster, you need headroom before the surge hits.\n\nLower “Target utilization” so more servers already run during normal traffic. Those spare servers absorb the jump while new ones boot—at the cost of paying for idle machines the rest of the time.',
      ),
    },
  ],
  steps: [
    { kind: 'read', title: tx('A flash crowd'), text: INTRO, key: tx('Autoscaling helps only after the check interval plus the boot time have passed.') },
    { kind: 'guess', title: tx('How long, how many'), questions: ['failing-for', 'overshoot'] },
    { kind: 'run', title: tx('Run 30 minutes'), look: { panel: 'bottom' } },
    { kind: 'try', title: tx('A slower boot'), text: tx('Raise “Boot time” from 120 s to 300 s (5 minutes) and run again. How much longer do requests keep failing before new servers arrive?'), patch: [{ node: 'api', params: { bootS: 300 } }], look: { panel: 'bottom' } },
    { kind: 'try', title: tx('Pre-warmed instances'), text: tx('Set “Boot time” to 10 s (like keeping ready-to-start servers on standby) and run again. Do failures stop right away?\n\nNext, also lower “Check interval” from 60 s to 15 s and run once more: what changes when you speed up both?'), patch: [{ node: 'api', params: { bootS: 10 } }], look: { panel: 'bottom' } },
    { kind: 'challenge', title: tx('Two challenges'), challenges: ['autoscale/faster', 'autoscale/headroom'] },
    { kind: 'practice', title: tx('Practice'), items: [{ kind: 'constraint', id: 'spike-budget' }] },
  ],
};

export default lesson;
