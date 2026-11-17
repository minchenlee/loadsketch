// Helpers for course lessons 3.1–6.2 (recovery after a spike, rules on edges and parameters).
// Kept apart from lessonKit.ts so the two lesson writers do not edit the same file; they can be
// merged later. Pure functions: no React, no DOM. Text goes through t() when it is made.
import { t, tx } from '../i18n/index.ts';
import { edgeId } from '../schema/design.ts';
import { KINDS } from '../schema/kinds.ts';
import type { Goal, Rule } from './lesson.ts';
import { recoveryS, spikeEnd, type RunData } from './metrics.ts';
import { labelOf, paramOf, pct, ms } from './lessonKit.ts';
import { complexity, customUsed } from './constraints.ts';
import { costOf } from './cost.ts';

/** Seconds from the end of the scenario's spike until fewer than 5% fail in every second (Infinity: never). */
export const recovery = (run: RunData) => recoveryS(run, spikeEnd(run.scenario));

export const recoveryText = (run: RunData) => {
  const s = recovery(run);
  if (s === Infinity) return t('No recovery before the end');
  if (s === 0) return t('No failures left when the spike ended');
  return t('Recovered {s} seconds after the spike', { s: Math.round(s) });
};

/** The run recovers within `s` seconds after the spike. */
export const recoversWithin = (s: number, text: string): Goal => ({
  text,
  check: (run) => ({ ok: recovery(run) <= s, value: recoveryText(run) }),
});

/** Share of one client's requests that failed (0 when it sent none). */
export function clientFailShare(run: RunData, client: string): number {
  const n = run.result.nodes[client];
  return n && n.arrivals > 0 ? n.fail / n.arrivals : 0;
}

/** Sum of one failure reason over every node (failures each node produced itself). */
export function originCount(run: RunData, reason: string): number {
  let s = 0;
  for (const n of Object.values(run.result.nodes)) s += (n.origin as unknown as Record<string, number> | undefined)?.[reason] ?? 0;
  return s;
}

/** JSON with object keys sorted at every level, so equal values give the same text. */
const canon = (v: unknown): string =>
  Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon((v as Record<string, unknown>)[k])).join(',') + '}'
  : JSON.stringify(v);
const strip = (x: Record<string, unknown>) => canon(Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'pos' && k !== 'label')));

/** At most one connection changes; no component changes, and none is added or removed. */
export const oneEdgeOnly: Rule = {
  short: tx('Change one connection only'),
  text: tx('Change the settings of one connection at most; components and the other connections stay as they are'),
  check: (d, original) => {
    const out: string[] = [];
    const nodes = new Map(d.nodes.map((n) => [n.id, n]));
    if (d.nodes.length !== original.nodes.length) out.push(t('Components were added or removed'));
    for (const o of original.nodes) {
      const n = nodes.get(o.id);
      if (n && strip({ kind: n.kind, params: n.params ?? {} }) !== strip({ kind: o.kind, params: o.params ?? {} })) out.push(t('“{name}” was changed', { name: labelOf(d, o.id) }));
    }
    const was = new Map(original.edges.map((e) => [edgeId(e), JSON.stringify(e)]));
    const changed = d.edges.filter((e) => was.get(edgeId(e)) !== JSON.stringify(e)).map(edgeId);
    const removed = original.edges.filter((e) => !d.edges.some((x) => edgeId(x) === edgeId(e))).map(edgeId);
    const all = [...changed, ...removed];
    if (all.length > 1) out.push(t('{n} connections changed: {ids}', { n: all.length, ids: all.join(', ') }));
    return out;
  },
};

/** Every connection that used adaptive throttling keeps it, with K from 1 to `maxK` (a large K hardly rejects). */
export const keepThrottle = (maxK: number): Rule => ({
  short: tx('Keep adaptive throttling'),
  text: tx('Every connection that had adaptive throttling keeps it, with K from 1 to 3 (a larger K hardly ever rejects)'),
  check: (d, original) => {
    const now = new Map(d.edges.map((e) => [edgeId(e), e]));
    const out: string[] = [];
    for (const o of original.edges) {
      if (!o.throttleK) continue;
      const e = now.get(edgeId(o));
      const k = e?.throttleK ?? 0;
      if (!e) out.push(t('Connection “{id}” was removed', { id: edgeId(o) }));
      else if (!(k >= 1 && k <= maxK)) out.push(t('Connection “{id}”: K is {k}', { id: edgeId(o), k }));
    }
    return out;
  },
});

/** A node parameter keeps its original value. */
export const keepParam = (id: string, key: string, short: string, text: string): Rule => ({
  short,
  text,
  check: (d, original) => {
    if (!d.nodes.some((n) => n.id === id)) return [t('“{name}” was removed', { name: labelOf(original, id) })];
    const a = paramOf(original, id, key);
    const b = paramOf(d, id, key);
    const kind = d.nodes.find((n) => n.id === id)!.kind;
    const what = KINDS[kind]?.params[key]?.label;
    return JSON.stringify(a) === JSON.stringify(b) ? [] : [t('“{name}”: {what} changed from {a} to {b}', { name: labelOf(d, id), what: what ? t(what) : key, a: String(a), b: String(b) })];
  },
});

/** A goal on the design: a numeric node parameter is at most `max`. */
export const paramAtMost = (id: string, key: string, max: number, text: string): Goal => ({
  text,
  check: (run) => {
    const v = paramOf(run.design, id, key);
    return { ok: typeof v === 'number' && v <= max, value: typeof v === 'number' ? String(v) : '—' };
  },
});

/**
 * Total slots of every consumer of a queue stay at most max: instances (the maximum when it
 * autoscales) × concurrency per instance, summed over each node the queue delivers to. A missing
 * queue, or a consumer without a slot count, fails.
 */
export const slotsAtMost = (queue: string, max: number, text: string): Goal => ({
  text,
  check: (run) => {
    const d = run.design;
    if (!d.nodes.some((n) => n.id === queue)) return { ok: false, value: t('“{name}” was removed', { name: queue }) };
    let n = 0;
    for (const id of new Set(d.edges.filter((e) => e.from === queue).map((e) => e.to))) {
      const auto = paramOf(d, id, 'autoscale') === 'on';
      const i = paramOf(d, id, auto ? 'maxInstances' : 'instances');
      const c = paramOf(d, id, 'concurrency');
      n += typeof i === 'number' && typeof c === 'number' ? i * c : Infinity;
    }
    return { ok: n <= max, value: Number.isFinite(n) ? t('{n} slots', { n }) : '—' };
  },
});

/**
 * The four limits of a constraint problem as goals. texts: message ids for errors, p99, money a
 * month and complexity points, in that order (they name the limit; the run shows the value).
 */
export const limitGoals = (l: { maxErrorRate: number; maxP99Ms: number; budgetPerMonth: number; maxPoints: number }, texts: [string, string, string, string]): Goal[] => [
  { text: texts[0], check: (run) => ({ ok: run.result.summary.errorRate <= l.maxErrorRate, value: pct(run.result.summary.errorRate) }) },
  { text: texts[1], check: (run) => ({ ok: run.result.summary.latencyMs.p99 <= l.maxP99Ms, value: ms(run.result.summary.latencyMs.p99) }) },
  { text: texts[2], check: (run) => { const c = costOf(run.design, run).perMonth; return { ok: c <= l.budgetPerMonth, value: '$' + Math.round(c).toLocaleString('en-US') }; } },
  { text: texts[3], check: (run) => { const p = complexity(run.design).total; return { ok: p <= l.maxPoints, value: String(p) }; } },
];

const GIVEN = ['serviceMs', 'readMs', 'writeMs'];
const meanOf = (v: unknown) => (typeof v === 'number' ? v : v && typeof v === 'object' && 'mean' in v ? (v as { mean: number }).mean : undefined);

/**
 * The speed of the parts is given: no node is faster than the original node with its id. A node
 * under a new id is not faster than the fastest original node of its kind (the kind's default
 * when the original has none), so renaming a part does not lift the floor. No custom service.
 */
export const givenParts: Rule = {
  short: tx('Same speed of parts'),
  text: tx('The time each part takes stays as given, and no custom service'),
  check: (d, original) => {
    const out = customUsed(d).map((b) => t(b.text, b.vars));
    for (const n of d.nodes) {
      const same = original.nodes.find((o) => o.id === n.id && o.kind === n.kind);
      const kin = same ? [same] : original.nodes.filter((o) => o.kind === n.kind);
      for (const k of GIVEN) {
        const spec = KINDS[n.kind]?.params[k];
        if (!spec) continue;
        const floors = kin.map((o) => meanOf(paramOf(original, o.id, k))).filter((x): x is number => x !== undefined);
        const floor = floors.length ? Math.min(...floors) : meanOf(spec.default);
        const now = meanOf(paramOf(d, n.id, k));
        if (floor !== undefined && now !== undefined && now < floor) out.push(t('{name}: {what} is shorter than given', { name: labelOf(d, n.id), what: spec.label ? t(spec.label) : k }));
      }
    }
    return out;
  },
};
