// "Why did it break": a short story of one run, in time order, read from its stats windows.
// Pure functions: no React, no DOM. Text goes through t(), so call it in the language to show.
import { FAIL_LABEL, FAIL_REASONS, type FailReason, type WindowStat } from '../engine/index.ts';
import { edgeId } from '../schema/design.ts';
import { KINDS } from '../schema/kinds.ts';
import { t, tx } from '../i18n/index.ts';
import { measured, baseArrivals, baseTraffic, baseline, calmAt, calms, failShare, isBad, reactions, triggers, type RunData } from './metrics.ts';

export type StoryKind = 'trigger' | 'react' | 'saturate' | 'amplify' | 'fail' | 'breaker' | 'recover' | 'stuck';

export interface Story {
  t: number; // seconds
  kind: StoryKind;
  node?: string;
  text: string;
  /** The idea behind it, for a learner. */
  why?: string;
}

/** A node is busy from here on (window average). */
const BUSY = 0.9;
/** A node gets this many times more than the client traffic explains. */
const EXTRA = 1.5;
/** At most this many busy nodes, and this many amplified nodes, are told. */
const MAX_BUSY = 3;
const MAX_AMP = 2;

const WHY_BUSY = tx('Near 100% busy, waiting time grows very fast: 10% more traffic can make the wait several times longer.');
const WHY_RETRY = tx('Calls that time out are retried. Retries make the queues longer, so more calls time out, and that makes more retries. This is a positive feedback loop.');
const WHY_STUCK = tx('This is a metastable failure: the trigger is gone, but the extra load from retries keeps the system in the bad state. To break the loop, limit retries (a retry budget, adaptive throttling), or reject fast when overloaded.');
const WHY_BREAKER = tx('The circuit breaker saw the downstream fail again and again, so it stops calling it and fails at once. This gives the downstream time to recover.');

const pctText = (x: number) => `${Math.round(x * 100)}%`;
const times = (x: number) => (x >= 10 ? String(Math.round(x)) : x.toFixed(1));

function topReason(w: WindowStat): FailReason | null {
  let best: FailReason | null = null;
  for (const r of FAIL_REASONS) if (w.fail[r] > 0 && (!best || w.fail[r] > w.fail[best])) best = r;
  return best;
}

export function diagnose(full: RunData): Story[] {
  // only the measured interval: no warm-up, no drain after the traffic ends
  const run = measured(full);
  const { design, result } = run;
  const ws = run.windows;
  if (!ws.length) return [];
  const out: Story[] = [];
  const label = (id: string) => result.nodes[id]?.label ?? id;
  const base = baseline(run);
  const startT = base.length ? base[base.length - 1].t : 0;
  const after = ws.filter((w) => w.t > startT);

  // 1. what happened to the system (traffic changes, faults), as the timeline tells it
  const seen = new Set<string>();
  for (const e of [...triggers(result.timeline), ...calms(result.timeline)]) {
    // region events have no node: each region's own text keeps them apart
    const k = `${e.type}:${e.node ?? (e.type.startsWith('region_') ? e.text : '')}`;
    if (seen.has(k)) continue;
    seen.add(k);
    // the same thing on several instances of the node at the same time is one line that says how many
    const same = e.node === undefined ? 1 : result.timeline.filter((x) => x.type === e.type && x.node === e.node && x.t === e.t).length;
    out.push({ t: e.t, kind: 'trigger', node: e.node, text: same > 1 ? t('{text} ({k} instances at the same time)', { text: e.text, k: same }) : e.text });
  }

  // the system's own reactions: the first of each kind on each node
  for (const e of reactions(result.timeline)) {
    const k = `${e.type}:${e.node ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ t: e.t, kind: 'react', node: e.node, text: e.text });
  }

  // 2. nodes that became busy
  const busy: Story[] = [];
  for (const n of design.nodes) {
    if (!KINDS[n.kind]?.station) continue;
    const already = base.length > 0 && base.every((w) => (w.nodes[n.id]?.util ?? 0) >= BUSY);
    const w = already ? base[0] : after.find((x) => (x.nodes[n.id]?.util ?? 0) >= BUSY);
    if (!w) continue;
    const u = pctText(w.nodes[n.id]!.util!);
    busy.push({
      t: w.t,
      kind: 'saturate',
      node: n.id,
      text: already ? t('{name} is busy from the start ({u} busy)', { name: label(n.id), u }) : t('{name} is full ({u} busy), and new requests start to queue', { name: label(n.id), u }),
      why: t(WHY_BUSY),
    });
  }
  busy.sort((a, b) => a.t - b.t);
  out.push(...busy.slice(0, MAX_BUSY));

  // 3. nodes that receive more than the client traffic explains (retries, misses)
  const traffic0 = baseTraffic(run);
  const extraAt = (id: string, w: WindowStat, a0: number) => {
    if (traffic0 > 0 && w.targetRps <= 0) return 0;
    const m = traffic0 > 0 ? w.targetRps / traffic0 : 1;
    return (w.nodes[id]?.arrivals ?? 0) / w.dt / a0 / Math.max(m, 1e-9);
  };
  const retryShare = (id: string, w: WindowStat) => {
    let calls = 0;
    let retries = 0;
    for (const e of design.edges) {
      if (e.to !== id) continue;
      const s = w.edges[edgeId(e)];
      if (!s) continue;
      calls += s.calls;
      retries += s.retries;
    }
    return calls ? retries / calls : 0;
  };
  const lastBadT = [...ws].reverse().find((w) => isBad(w))?.t ?? -1;
  const amps: (Story & { retried: boolean })[] = [];
  let worst: { id: string; extra: number } | null = null;
  for (const n of design.nodes) {
    if (n.kind === 'client') continue;
    const a0 = baseArrivals(run, n.id);
    if (a0 < 1) continue;
    // for 3 seconds in a row (a backlog draining for a second or two is not the story)
    const w = after.find((x, i) => x.t <= lastBadT && after.slice(i, i + 3).length === 3 && after.slice(i, i + 3).every((y) => extraAt(n.id, y, a0) >= EXTRA));
    if (w) {
      const x = extraAt(n.id, w, a0);
      const m = traffic0 > 0 ? w.targetRps / traffic0 : 1;
      const retried = retryShare(n.id, w) >= 0.2;
      amps.push({
        retried,
        t: w.t,
        kind: 'amplify',
        node: n.id,
        text: retried
          ? t('{name} receives {x} times its usual requests, but user traffic is only {m} times: the extra requests are retries', { name: label(n.id), x: times(x * m), m: times(m) })
          : t('{name} receives {x} times its usual requests, but user traffic is only {m} times', { name: label(n.id), x: times(x * m), m: times(m) }),
        why: retried ? t(WHY_RETRY) : undefined,
      });
    }
    // the most amplified node over the last 10 windows (for a run that ends still failing)
    const tail = ws.slice(-10);
    const avg = tail.reduce((s, x) => s + extraAt(n.id, x, a0), 0) / tail.length;
    if (!worst || avg > worst.extra) worst = { id: n.id, extra: avg };
  }
  // retries first (the cause), then the earliest
  amps.sort((a, b) => Number(b.retried) - Number(a.retried) || a.t - b.t);
  for (const { retried: _, ...a } of amps.slice(0, MAX_AMP)) out.push(a);

  // 4. failures: when they start, why, and whether they stop
  const firstBad = ws.find((w) => w.t > 1 && isBad(w));
  if (firstBad) {
    const r = topReason(firstBad);
    out.push({
      t: firstBad.t,
      kind: 'fail',
      text: r
        ? t('Users start to fail ({p} fail in this second). The most common reason: {why}', { p: pctText(failShare(firstBad)), why: t(FAIL_LABEL[r]) })
        : t('Users start to fail ({p} fail in this second)', { p: pctText(failShare(firstBad)) }),
    });
    const lastBad = [...ws].reverse().find((w) => isBad(w))!;
    const calm = calmAt(result.timeline);
    const endsBad = ws.indexOf(lastBad) >= ws.length - 2;
    if (endsBad && calm !== undefined && lastBad.t - calm >= 10 && worst && worst.extra >= EXTRA) {
      out.push({
        t: calm + 10,
        kind: 'stuck',
        node: worst.id,
        text: t('The trigger ended 10 seconds ago, but failures do not stop: {name} keeps receiving {x} times its usual requests', { name: label(worst.id), x: times(worst.extra) }),
        why: t(WHY_STUCK),
      });
    } else if (endsBad) {
      out.push({ t: lastBad.t, kind: 'stuck', text: t('Still failing at the end') });
    } else {
      // told at the first healthy window
      out.push({ t: ws[ws.indexOf(lastBad) + 1].t, kind: 'recover', text: t('Recovered: from here on, fewer than 5% fail in every second') });
    }
  }

  // 5. a circuit breaker opens
  const open = ws.find((w) => Object.values(w.nodes).some((n) => n.cb === 'open'));
  if (open) {
    const id = Object.keys(open.nodes).find((k) => open.nodes[k].cb === 'open')!;
    out.push({ t: open.t, kind: 'breaker', node: id, text: t('{name} opens and stops calling the downstream for a while', { name: label(id) }), why: t(WHY_BREAKER) });
  }

  const order: StoryKind[] = ['trigger', 'react', 'saturate', 'amplify', 'breaker', 'fail', 'recover', 'stuck'];
  return out.sort((a, b) => a.t - b.t || order.indexOf(a.kind) - order.indexOf(b.kind));
}
