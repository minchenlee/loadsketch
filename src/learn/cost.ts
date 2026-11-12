// Cost model (#68, Q10=A): simple sample prices, close to the ratios of 2026 AWS prices, not a quote.
// Machines cost per hour; managed parts cost per million requests; traffic to users costs per GB.
// Pure functions: no React, no DOM.
import { tx } from '../i18n/index.ts';
import type { SimResult, WindowStat } from '../engine/index.ts';
import { edgeId, type Design, type DesignNode } from '../schema/design.ts';
import { CUSTOM_KIND, resolveParams } from '../schema/kinds.ts';

export const HOURS_PER_MONTH = 730;

/**
 * One machine of a kind at its default size: its price per hour, and the param that sets its size
 * (slots). Half the price is the machine itself; the other half grows with its slots (see `size`).
 */
export const MACHINE: Record<string, { perHour: number; slots: string; unit: number }> = {
  service: { perHour: 0.08, slots: 'concurrency', unit: 32 },
  worker: { perHour: 0.08, slots: 'concurrency', unit: 4 },
  cache: { perHour: 0.15, slots: 'concurrency', unit: 8 },
  database: { perHour: 0.25, slots: 'connections', unit: 50 },
  sharded_db: { perHour: 0.25, slots: 'connections', unit: 50 },
};

/** Managed parts: a fixed price per hour and a price per million requests that reach them. */
export const MANAGED: Record<string, { perHour: number; perMillion: number }> = {
  load_balancer: { perHour: 0.025, perMillion: 0.003 },
  api_gateway: { perHour: 0, perMillion: 3.5 },
  queue: { perHour: 0, perMillion: 0.4 },
  cdn: { perHour: 0, perMillion: 1 },
  dns: { perHour: 0, perMillion: 0.4 },
  // Lambda: $0.20 per million requests plus about 50 ms × 1 GB of compute each ($0.83)
  function: { perHour: 0, perMillion: 1 },
};

/** Object storage: per million writes (PUT) and reads (GET). */
export const STORAGE = { writePerMillion: 5, readPerMillion: 0.4 };

/** Traffic to users: each user request answers this many KB, at this price per GB. */
export const EGRESS = { kbPerRequest: 2, perGb: 0.09 };

/** Traffic between regions: each call over an edge that joins two regions (request and reply), and each cache copy. */
export const CROSS_REGION = { kbPerCall: 2, perGb: 0.02 };

export interface CostItem {
  /** A node id, 'egress' or 'cross-region'. */
  id: string;
  kind: string;
  /** What is counted, for example "3 台 × 每台每小時 $0.08": a message to translate with its values. */
  what: { text: string; vars: Record<string, string> };
  perHour: number;
}

export interface Cost {
  perHour: number;
  perMonth: number;
  items: CostItem[];
  /** Request prices need a run; without one they are left out. */
  withRequests: boolean;
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** One machine's price as a share of the default one: 0.5 + 0.5 × slots / default slots. */
export function size(n: Pick<DesignNode, 'kind' | 'params'>): number {
  const m = MACHINE[n.kind];
  if (!m) return 0;
  const p = resolveParams(n.kind, n.params);
  return 0.5 + (0.5 * num(p[m.slots], m.unit)) / m.unit;
}

/**
 * Machines of a node. An autoscaled node counts its average number serving in the run (scaled to
 * the design's size when the run had fewer), or its starting number without a run.
 */
export function machines(n: Pick<DesignNode, 'id' | 'kind' | 'params'>, run?: { result: SimResult; windows: WindowStat[] }): number {
  const p = resolveParams(n.kind, n.params);
  if (n.kind === 'database') return 1 + num(p.replicas);
  if (n.kind === 'sharded_db') return num(p.shards, 1) * (1 + num(p.replicas));
  const fixed = num(p.instances, 1);
  if (p.autoscale !== 'on' || !run) return fixed;
  const ws = run.windows.filter((w) => w.measured && w.nodes[n.id]?.active !== undefined);
  const a = run.result.nodes[n.id]?.autoscale;
  if (!ws.length || !a?.max) return fixed;
  const avg = ws.reduce((s, w) => s + (w.nodes[n.id].active ?? 0), 0) / ws.length;
  return avg * (num(p.maxInstances, a.max) / a.max);
}

const money = (x: number) => Math.round(x * 1e6) / 1e6;

/** What the design costs; with a run, its request prices too (at the run's average rates). */
export function costOf(design: Design, run?: { result: SimResult; windows: WindowStat[] }): Cost {
  const items: CostItem[] = [];
  const secs = run ? Math.max(1e-9, run.result.measuredToS - run.result.measuredFromS) : 0;
  /** Millions per hour of a count measured over the run. */
  const mph = (count: number) => (run ? ((count / secs) * 3600) / 1e6 : 0);
  for (const n of design.nodes) {
    // a custom service (Q19): instances × the price per instance the user gives
    if (n.kind === CUSTOM_KIND) {
      const k = machines(n, run);
      const each = num(resolveParams(n.kind, n.params).pricePerHour);
      items.push({ id: n.id, kind: n.kind, what: { text: tx('{k} 台 × 每台每小時 {p}'), vars: { k: fmtCount(k), p: `$${fmtCount(each)}` } }, perHour: money(k * each) });
      continue;
    }
    const m = MACHINE[n.kind];
    if (m) {
      const k = machines(n, run);
      const each = size(n) * m.perHour;
      items.push({ id: n.id, kind: n.kind, what: { text: tx('{k} 台 × 每台每小時 {p}'), vars: { k: fmtCount(k), p: `$${fmtCount(each)}` } }, perHour: money(k * each) });
      continue;
    }
    const g = MANAGED[n.kind];
    if (g) {
      const arrivals = run?.result.nodes[n.id]?.arrivals ?? 0;
      items.push({ id: n.id, kind: n.kind, what: { text: tx('每小時 {m} 百萬次'), vars: { m: fmtCount(mph(arrivals)) } }, perHour: money(g.perHour + mph(arrivals) * g.perMillion) });
      continue;
    }
    if (n.kind === 'object_storage') {
      let read = 0;
      let write = 0;
      const ids = design.edges.filter((de) => de.to === n.id).map((de) => edgeId(de));
      for (const w of run?.windows ?? []) {
        if (!w.measured) continue;
        for (const id of ids) {
          read += w.edges[id]?.read ?? 0;
          write += w.edges[id]?.write ?? 0;
        }
      }
      items.push({ id: n.id, kind: n.kind, what: { text: tx('每小時讀 {r}、寫 {w} 百萬次'), vars: { r: fmtCount(mph(read)), w: fmtCount(mph(write)) } }, perHour: money(mph(read) * STORAGE.readPerMillion + mph(write) * STORAGE.writePerMillion) });
    }
  }
  if (run) {
    const gbPerHour = (((run.result.summary.offered / secs) * 3600) * EGRESS.kbPerRequest) / 1e6;
    items.push({ id: 'egress', kind: 'egress', what: { text: tx('每小時 {gb} GB'), vars: { gb: fmtCount(gbPerHour) } }, perHour: money(gbPerHour * EGRESS.perGb) });
    // messages between regions, as the engine counts them per edge: each copy sent to an instance in
    // another region than the caller (retries, fan-out, a replica or a moved primary there), and cache copies
    let calls = 0;
    for (const w of run.windows) {
      if (!w.measured) continue;
      for (const id in w.edges) calls += w.edges[id].crossRegion ?? 0;
    }
    if (calls > 0) {
      const gb = (((calls / secs) * 3600) * CROSS_REGION.kbPerCall) / 1e6;
      items.push({ id: 'cross-region', kind: 'cross-region', what: { text: tx('每小時 {gb} GB'), vars: { gb: fmtCount(gb) } }, perHour: money(gb * CROSS_REGION.perGb) });
    }
  }
  const perHour = money(items.reduce((s, i) => s + i.perHour, 0));
  return { perHour, perMonth: money(perHour * HOURS_PER_MONTH), items, withRequests: !!run };
}

function fmtCount(x: number): string {
  if (x >= 100) return String(Math.round(x));
  if (x >= 10) return x.toFixed(1).replace(/\.0$/, '');
  return x.toFixed(2).replace(/\.?0+$/, '') || '0';
}

/** Dollars, as the screens show them. */
export const fmtUsd = (x: number) => (x >= 100 ? `$${Math.round(x).toLocaleString('en-US')}` : `$${x.toFixed(2)}`);
