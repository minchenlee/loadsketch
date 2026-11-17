// On-call mode (M7, Q7–Q9): a hidden fault in a known example. The learner sees only what users
// see (error rate and p99 each second), pays points to open a component's own metrics, picks the
// component and the kind of fault, and then fixes the design on the canvas for more points.
// Pure functions: no React, no DOM.
import { tx } from '../i18n/index.ts';
import type { WindowStat } from '../engine/index.ts';
import type { Design, Scenario } from '../schema/design.ts';
import { CUSTOM_KIND, KINDS } from '../schema/kinds.ts';
import { settled } from './metrics.ts';
import { loadPracticeList, parseIncident, type FaultValue } from './practiceData.ts';

/** What went wrong. `gray`: only one instance; `traffic`: the users sent much more (node: the client). */
export type Fault = FaultValue;

export const FAULTS: { id: Fault; text: string }[] = [
  { id: 'down', text: tx('整個元件故障（不回應）') },
  { id: 'slow', text: tx('整個元件變慢') },
  { id: 'errors', text: tx('整個元件回錯誤') },
  { id: 'gray', text: tx('只有一台實例出問題，其他台正常') },
  { id: 'pause', text: tx('定期停頓（GC）') },
  { id: 'traffic', text: tx('流量暴增') },
];

/** A change to the design: params of a node, or fields of an edge ("from->to"). */
export type Patch = { node: string; params: Record<string, unknown> } | { edge: string; set: Record<string, unknown> };

export interface Incident {
  id: string;
  /** The page the learner gets: symptoms only, never the cause. */
  title: string;
  /** The example design the incident runs on. */
  example: string;
  /** Traffic and the hidden fault (events). */
  scenario: Scenario;
  answer: { node: string; fault: Fault };
  /** Shown after the answer: what happened and why the symptoms looked like that. */
  explain: string;
  /** How to fix it in the design (shown after the answer). */
  hint: string;
  /** A fix that is known to work (the tests check it; the learner may find another). */
  solution: Patch[];
  /** The fixed design passes when the whole run is at most this bad. */
  fixGoal: { maxErrorRate: number; maxP99Ms?: number };
}

const incidentFiles = import.meta.glob('../../examples/practice/oncall/*.json', { eager: true, import: 'default' });
export const INCIDENTS: Incident[] = loadPracticeList(incidentFiles, parseIncident);

export const INCIDENT_BY_ID: Record<string, Incident> = Object.fromEntries(INCIDENTS.map((i) => [i.id, i]));

/**
 * Points: the component, the kind of fault, the fix. The metrics of the first `free` components
 * opened cost nothing; each one after them costs `open` (roadmap-next M10: a full score should not
 * need a guess with no metrics at all).
 */
export const POINTS = { node: 40, fault: 30, fix: 30, open: -10, free: 2 } as const;

/** What opening `opened` components costs (0 or less). */
export function openCost(opened: number): number {
  const paid = Math.max(0, opened - POINTS.free);
  return paid ? paid * POINTS.open : 0;
}

export interface Score {
  node: boolean;
  fault: boolean;
  fixed: boolean;
  opened: number;
  total: number;
}

export function score(inc: Incident, guess: { node: string; fault: Fault }, opened: number, fixed: boolean): Score {
  const node = guess.node === inc.answer.node;
  const fault = guess.fault === inc.answer.fault;
  const total = Math.max(0, (node ? POINTS.node : 0) + (fault ? POINTS.fault : 0) + (fixed ? POINTS.fix : 0) + openCost(opened));
  return { node, fault, fixed, opened, total };
}

/** What users see each second: the share of settled requests that failed, and p99 (ms). */
export interface Symptom {
  t: number;
  errorRate: number;
  /** null: no request succeeded this second (no p99 to show). */
  p99: number | null;
}

export function symptoms(windows: WindowStat[]): Symptom[] {
  return windows.map((w) => {
    const n = settled(w);
    return { t: w.t, errorRate: n ? (n - w.ok) / n : 0, p99: w.latency.count ? w.latency.p99 : null };
  });
}

/** One component's own numbers each second (shown after the learner pays to open it). */
export interface NodeSample {
  t: number;
  /** The client: requests sent this second. Others: requests that arrived. */
  rps: number;
  util?: number;
  queue?: number;
  fail: number;
  /** Busy share of each instance, when the node has several. */
  instUtil?: number[];
}

export function nodeSamples(windows: WindowStat[], design: Design, id: string): NodeSample[] {
  const client = design.nodes.find((n) => n.id === id)?.kind === 'client';
  return windows.map((w) => {
    const nw = w.nodes[id];
    const dt = w.dt || 1;
    if (client) return { t: w.t, rps: w.offered / dt, fail: nw?.fail ?? 0 };
    return {
      t: w.t,
      rps: (nw?.arrivals ?? 0) / dt,
      ...(nw?.util !== undefined ? { util: nw.util } : {}),
      ...(nw?.queue !== undefined ? { queue: nw.queue } : nw?.depth !== undefined ? { queue: nw.depth } : {}),
      fail: nw?.fail ?? 0,
      ...(nw?.instUtil && nw.instUtil.length > 1 ? { instUtil: nw.instUtil } : {}),
    };
  });
}

/** The design with the patches applied (a copy). Unknown nodes or edges are left out. */
export function applyPatches(design: Design, patches: Patch[]): Design {
  const d = structuredClone(design);
  for (const p of patches) {
    if ('node' in p) {
      const n = d.nodes.find((x) => x.id === p.node);
      if (n) n.params = { ...(n.params ?? {}), ...(p.params as typeof n.params) };
    } else {
      const [from, to] = p.edge.split('->');
      const e = d.edges.find((x) => x.from === from && x.to === to);
      if (e) Object.assign(e, p.set);
    }
  }
  return d;
}

/**
 * The learner's fix: every component of the incident's design is still there and still gets
 * requests (a fix may not route around the system, e.g. with a weight-0 edge out of the client),
 * no cache hits more often than before (the hit ratio comes from the traffic; nobody sets it
 * during an incident), background work is not lost (`lost`: the share of queued jobs that failed
 * for good is above the error-rate goal), and the run meets the goal.
 */
export function judgeFix(
  inc: Incident,
  original: Design,
  fixed: Design,
  result: { summary: { errorRate: number; latencyMs: { p99: number } }; nodes: Record<string, { arrivals: number; asyncFail?: number }> },
): { ok: boolean; missing: string[]; idle: string[]; raised: string[]; lost: boolean; custom: string[] } {
  const have = new Set(fixed.nodes.map((n) => n.id));
  const missing = original.nodes.map((n) => n.id).filter((id) => !have.has(id));
  const idle = original.nodes.filter((n) => have.has(n.id) && !(result.nodes[n.id]?.arrivals > 0)).map((n) => n.id);
  const hit = (n: Design['nodes'][number]) => (typeof n.params?.hitRatio === 'number' ? n.params.hitRatio : (KINDS[n.kind]?.params.hitRatio?.default as number | undefined));
  const raised = original.nodes
    .filter((o) => {
      const n = fixed.nodes.find((x) => x.id === o.id);
      const a = hit(o);
      const b = n && hit(n);
      return a !== undefined && b !== undefined && b > a;
    })
    .map((n) => n.id);
  const g = inc.fixGoal;
  const jobs = Object.values(result.nodes).filter((n) => n.asyncFail !== undefined);
  const lost = jobs.reduce((x, n) => x + (n.asyncFail ?? 0), 0) > g.maxErrorRate * jobs.reduce((x, n) => x + n.arrivals, 0);
  // a custom service can be made as fast as wanted: not a fix (Q20)
  const custom = fixed.nodes.filter((n) => n.kind === CUSTOM_KIND).map((n) => n.id);
  const ok = custom.length === 0 && missing.length === 0 && idle.length === 0 && raised.length === 0 && !lost && result.summary.errorRate <= g.maxErrorRate && (g.maxP99Ms === undefined || result.summary.latencyMs.p99 <= g.maxP99Ms);
  return { ok, missing, idle, raised, lost, custom };
}
