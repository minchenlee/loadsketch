// Scenario editor (M4, U1): the event kinds, their fields, new events, and the event times the
// charts mark. The editor component reads these tables; tests check them without a browser.

import type { Design, ScenarioEvent } from '../schema/design.ts';
import { instanceCount as nodeInstances, regionsOf } from '../schema/design.ts';
import { KINDS } from '../schema/kinds.ts';
import { tx } from '../i18n/index.ts';

export type EventType = ScenarioEvent['type'];

/** A number field of an event. `scale` 100 shows a 0–1 share as a percent. */
export interface EventNumField {
  key: string;
  label: string;
  unit?: string;
  min: number;
  max: number;
  scale?: number;
  /** Not required: off by default (a switch turns it on). */
  optional?: boolean;
}

export interface EventSpec {
  type: EventType;
  label: string;
  help: string;
  /** Aimed at a node, a region, two regions (the cut between them), an edge or none of them. */
  target: 'node' | 'region' | 'regions' | 'edge' | 'none';
  /** The duration field's own name and its "off" text (a shift's forS is how long the move takes). */
  forLabel?: string;
  forOff?: string;
  /** The event can hit one instance of the node. */
  instance?: boolean;
  /** forS must be given (a ramp has a length). */
  needsFor?: boolean;
  /** No duration field (a rollout lasts its waves). */
  noFor?: boolean;
  /** The node can be left out: the label of that choice (a rollout to every server). */
  anyNode?: string;
  fields: EventNumField[];
  /** On/off fields (a version that crashes at start). */
  flags?: { key: string; label: string }[];
}

const MULT = (label = tx('倍數'), min = 0): EventNumField => ({ key: 'multiplier', label, unit: '×', min, max: 1000 });

export const EVENT_SPECS: EventSpec[] = [
  { type: 'spike', label: tx('突波'), help: tx('這段時間流量乘上倍數。'), target: 'none', fields: [MULT()] },
  {
    type: 'ramp', label: tx('漸增'), help: tx('流量在這段時間從 1 倍直線升到目標倍數，之後維持。'), target: 'none', needsFor: true,
    fields: [{ key: 'toMultiplier', label: tx('目標倍數'), unit: '×', min: 0, max: 1000 }],
  },
  {
    type: 'wave', label: tx('週期流量'), help: tx('像一天的高低峰：流量在 1 ± 振幅之間來回。'), target: 'none',
    fields: [
      { key: 'periodS', label: tx('一輪多久'), unit: 's', min: 1, max: 86400 },
      { key: 'amplitude', label: tx('振幅'), unit: '%', min: 0, max: 1, scale: 100 },
    ],
  },
  {
    type: 'cron', label: tx('排程工作'), help: tx('每隔一段時間，所有使用者同時送出（例如整點的排程）。'), target: 'none',
    fields: [
      { key: 'everyS', label: tx('每隔'), unit: 's', min: 1, max: 86400 },
      { key: 'burstS', label: tx('爆量持續'), unit: 's', min: 0.01, max: 3600 },
      MULT(tx('爆量倍數'), 1),
      { key: 'jitterS', label: tx('分散時間（jitter）'), unit: 's', min: 0, max: 3600, optional: true },
    ],
  },
  { type: 'down', label: tx('故障'), help: tx('元件（或其中一台）停止回應。'), target: 'node', instance: true, fields: [] },
  { type: 'region_down', label: tx('整區故障'), help: tx('同一區的元件一起故障（整個資料中心）。'), target: 'region', fields: [] },
  {
    type: 'partition', label: tx('網路分區'), help: tx('兩個區域之間斷線：互相的呼叫和複製都送不到（呼叫端逾時），使用者兩邊都連得到。資料庫開了自動 failover 時，副本那一側會升新主庫，舊主庫還在收寫入（split brain）。'), target: 'regions',
    fields: [],
  },
  { type: 'slow', label: tx('變慢'), help: tx('元件（或其中一台）的處理時間乘上倍數。'), target: 'node', instance: true, fields: [MULT()] },
  {
    type: 'errors', label: tx('錯誤'), help: tx('元件（或其中一台）改用這個錯誤率。'), target: 'node', instance: true,
    fields: [{ key: 'rate', label: tx('錯誤率'), unit: '%', min: 0, max: 1, scale: 100 }],
  },
  {
    type: 'shift', label: tx('流量移轉'), help: tx('把一條線的權重改掉：DNS、負載平衡器或使用者照權重分流，所以這就是金絲雀發布、藍綠切換或撤出一個區域。可以在一段時間內慢慢移。'), target: 'edge',
    forLabel: tx('移轉時間'), forOff: tx('立刻'),
    fields: [{ key: 'weight', label: tx('新權重'), min: 0, max: 1000 }],
  },
  {
    type: 'rollout', label: tx('部署新版本'), help: tx('一波一波換上新版本（程式或設定）。壞版本會變慢、出錯或一啟動就當掉。分波＋自動回滾能把影響限制在第一波；一波推到全部就是全域推送。'), target: 'node',
    noFor: true, anyNode: tx('全部（全域推送）'),
    fields: [
      { key: 'waves', label: tx('分幾波'), min: 1, max: 20 },
      { key: 'waveS', label: tx('每波觀察'), unit: 's', min: 1, max: 3600 },
      { key: 'slow', label: tx('新版本變慢'), unit: '×', min: 1, max: 1000 },
      { key: 'errorRate', label: tx('新版本錯誤率'), unit: '%', min: 0, max: 1, scale: 100 },
      { key: 'haltAt', label: tx('自動回滾門檻'), unit: '%', min: 0, max: 1, scale: 100, optional: true },
    ],
    flags: [{ key: 'crash', label: tx('一啟動就當掉') }],
  },
  {
    type: 'reshard', label: tx('重新分片'), help: tx('分片資料庫一邊服務一邊改分片數：複製資料的這段時間每份都變慢，結束時 key 改照新的分片數分配（key 除以分片數的餘數）。拆開熱分片，或合併太空的分片。'), target: 'node',
    forLabel: tx('複製時間'), forOff: tx('預設 60 秒'),
    fields: [
      { key: 'toShards', label: tx('改成幾份'), min: 1, max: 256 },
      { key: 'copyLoad', label: tx('複製時多做的工'), unit: '%', min: 0, max: 10, scale: 100, optional: true },
    ],
  },
  {
    type: 'pause', label: tx('GC 停頓'), help: tx('每隔一段時間停下來不做事（stop-the-world）。'), target: 'node',
    fields: [
      { key: 'everyS', label: tx('每隔'), unit: 's', min: 0.1, max: 3600 },
      { key: 'pauseMs', label: tx('每次停多久'), unit: 'ms', min: 1, max: 60000 },
    ],
  },
];

export const EVENT_SPEC: Record<EventType, EventSpec> = Object.fromEntries(EVENT_SPECS.map((s) => [s.type, s])) as Record<EventType, EventSpec>;

/** Nodes an event of this type can aim at: pauses and rollouts only hit components with instances. */
export function eventNodes(d: Pick<Design, 'nodes'>, type: EventType): { id: string; label: string }[] {
  return d.nodes
    .filter((n) => n.kind !== 'client' && ((type !== 'pause' && type !== 'rollout') || KINDS[n.kind]?.station) && (type !== 'reshard' || n.kind === 'sharded_db'))
    .map((n) => ({ id: n.id, label: n.label ?? n.id }));
}

/** Edges a traffic shift can aim at: out of a node that splits its traffic by weight. */
export function eventEdges(d: Pick<Design, 'nodes' | 'edges'>): { from: string; to: string; label: string }[] {
  const byId = new Map(d.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const out: { from: string; to: string; label: string }[] = [];
  for (const e of d.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    const id = `${e.from}->${e.to}`;
    if (!a || !b || KINDS[a.kind]?.routing !== 'one' || seen.has(id)) continue;
    seen.add(id);
    out.push({ from: e.from, to: e.to, label: `${a.label ?? a.id} → ${b.label ?? b.id}` });
  }
  return out;
}

/** How many instances an event can pick from (0: the node has no instances to pick). */
export function instanceCount(d: Pick<Design, 'nodes'>, nodeId: string): number {
  const n = d.nodes.find((x) => x.id === nodeId);
  if (!n || !KINDS[n.kind]?.station) return 0;
  // the engine's count: a sharded database has shards × (1 + replicas)
  return nodeInstances(n);
}

/** Event types the design can use: one aimed at a node needs a node to aim at, a region event a region. */
export function usableTypes(d: Pick<Design, 'nodes' | 'edges'>): EventSpec[] {
  return EVENT_SPECS.filter((s) =>
    s.target === 'node' ? eventNodes(d, s.type).length > 0 : s.target === 'region' ? regionsOf(d as Design).length > 0 : s.target === 'regions' ? regionsOf(d as Design).length > 1 : s.target === 'edge' ? eventEdges(d).length > 0 : true,
  );
}

/** A new event of this type, with values that show something in a run of `durationS`. */
export function newEvent(type: EventType, d: Pick<Design, 'nodes' | 'edges'>, durationS: number): ScenarioEvent {
  const atS = Math.max(0, Math.round(durationS / 4));
  const forS = Math.max(1, Math.round(durationS / 4));
  const node = eventNodes(d, type)[0]?.id ?? '';
  switch (type) {
    case 'spike':
      return { type, atS, forS, multiplier: 3 };
    case 'ramp':
      return { type, atS, forS, toMultiplier: 2 };
    case 'wave':
      return { type, atS: 0, periodS: Math.max(1, Math.round(durationS / 2)), amplitude: 0.5 };
    case 'cron':
      return { type, atS, everyS: Math.max(2, Math.round(durationS / 4)), burstS: 1, multiplier: 5 };
    case 'down':
      return { type, atS, forS, node };
    case 'region_down':
      return { type, atS, forS, region: regionsOf(d as Design)[0] ?? '' };
    case 'partition': {
      const r = regionsOf(d as Design);
      return { type, atS, forS, regions: [r[0] ?? '', r[1] ?? ''] };
    }
    case 'slow':
      return { type, atS, forS, node, multiplier: 5 };
    case 'errors':
      return { type, atS, forS, node, rate: 0.5 };
    case 'pause':
      return { type, atS, forS, node, everyS: 5, pauseMs: 200 };
    case 'shift': {
      // move everything off the first edge, over a quarter of the run
      const e = eventEdges(d)[0];
      return { type, atS, forS, from: e?.from ?? '', to: e?.to ?? '', weight: 0 };
    }
    case 'reshard': {
      // double the shards of the first sharded database
      const db = d.nodes.find((n) => n.id === node);
      const shards = Number(db?.params?.shards ?? KINDS.sharded_db.params.shards.default);
      return { type, atS, forS, node, toShards: Math.min(256, shards * 2) };
    }
    case 'rollout':
      // a global push of a version that fails half its requests, in 4 waves with a rollback check
      return { type, atS, waves: 4, waveS: Math.max(1, Math.round(durationS / 10)), slow: 1, errorRate: 0.5, haltAt: 0.05 };
  }
}

/** How long the event lasts, when it has an end: forS, or a rollout's waves. */
export function eventLength(ev: ScenarioEvent): number | undefined {
  if (ev.type === 'rollout') return (ev.waves ?? 1) * (ev.waveS ?? 60);
  if (ev.type === 'reshard') return ev.forS ?? 60;
  return 'forS' in ev ? ev.forS : undefined;
}

/**
 * The event as another type: time, length and target are kept when the new type has them; the
 * other fields take the new type's defaults.
 */
export function retype(ev: ScenarioEvent, type: EventType, d: Pick<Design, 'nodes' | 'edges'>, durationS: number): ScenarioEvent {
  const base = newEvent(type, d, durationS) as Record<string, unknown>;
  const old = ev as Record<string, unknown>;
  base.atS = ev.atS;
  if (EVENT_SPEC[type].noFor) delete base.forS;
  else if (typeof old.forS === 'number') base.forS = old.forS;
  else if (!EVENT_SPEC[type].needsFor) delete base.forS;
  if (('node' in base || EVENT_SPEC[type].anyNode) && typeof old.node === 'string' && eventNodes(d, type).some((n) => n.id === old.node)) {
    base.node = old.node;
    // the same target: one instance stays one instance (a gray failure stays gray)
    if (EVENT_SPEC[type].instance && typeof old.instance === 'number' && old.instance < instanceCount(d, old.node)) base.instance = old.instance;
  }
  return base as ScenarioEvent;
}

/** A time marked on the charts: an event's start and, when it has one, its end. */
export interface EventMark {
  t: number;
  t1?: number;
  label: string;
}

/** Marks for the events of a run of `durationS` seconds (none past the end). */
export function eventMarks(events: ScenarioEvent[] | undefined, durationS: number, label: (ev: ScenarioEvent) => string): EventMark[] {
  return (events ?? [])
    .filter((ev) => ev.atS < durationS)
    .map((ev) => {
      const len = eventLength(ev);
      return { t: ev.atS, t1: len === undefined ? undefined : Math.min(durationS, ev.atS + len), label: label(ev) };
    });
}
