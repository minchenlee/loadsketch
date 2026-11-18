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

const MULT = (label = tx('Multiplier'), min = 0): EventNumField => ({ key: 'multiplier', label, unit: '×', min, max: 1000 });

export const EVENT_SPECS: EventSpec[] = [
  { type: 'spike', label: tx('Spike'), help: tx('Traffic is multiplied during this time.'), target: 'none', fields: [MULT()] },
  {
    type: 'ramp', label: tx('Ramp'), help: tx('Traffic rises in a straight line from 1× to the target over this time, then holds.'), target: 'none', needsFor: true,
    fields: [{ key: 'toMultiplier', label: tx('Target multiplier'), unit: '×', min: 0, max: 1000 }],
  },
  {
    type: 'wave', label: tx('Daily wave'), help: tx('Like the peaks and lows of a day: traffic swings between 1 ± amplitude.'), target: 'none',
    fields: [
      { key: 'periodS', label: tx('Cycle length'), unit: 's', min: 1, max: 86400 },
      { key: 'amplitude', label: tx('Amplitude'), unit: '%', min: 0, max: 1, scale: 100 },
    ],
  },
  {
    type: 'cron', label: tx('Scheduled job'), help: tx('At regular times, all users send at once (for example a job on the hour).'), target: 'none',
    fields: [
      { key: 'everyS', label: tx('Every'), unit: 's', min: 1, max: 86400 },
      { key: 'burstS', label: tx('Burst length'), unit: 's', min: 0.01, max: 3600 },
      MULT(tx('Burst multiplier'), 1),
      { key: 'jitterS', label: tx('Spread (jitter)'), unit: 's', min: 0, max: 3600, optional: true },
    ],
  },
  { type: 'down', label: tx('Down'), help: tx('The component (or one of its instances) stops answering.'), target: 'node', instance: true, fields: [] },
  { type: 'region_down', label: tx('Region outage'), help: tx('All components of a region fail together (a whole data center).'), target: 'region', fields: [] },
  {
    type: 'partition', label: tx('Network partition'), help: tx('The network between two regions is cut: calls and replication between them are lost (the caller times out); users reach both sides. A database with automatic failover promotes a new primary on the replicas\' side while the old one still takes writes (split brain).'), target: 'regions',
    fields: [],
  },
  { type: 'slow', label: tx('Slowdown'), help: tx('The component\'s (or one instance\'s) processing time is multiplied.'), target: 'node', instance: true, fields: [MULT()] },
  {
    type: 'errors', label: tx('error'), help: tx('The component (or one of its instances) uses this error rate.'), target: 'node', instance: true,
    fields: [{ key: 'rate', label: tx('Error rate'), unit: '%', min: 0, max: 1, scale: 100 }],
  },
  {
    type: 'shift', label: tx('Traffic shift'), help: tx('Change the weight of an edge. DNS, load balancers and clients split traffic by weight, so this is a canary release, a blue-green cutover or a region evacuation. The move can be gradual.'), target: 'edge',
    forLabel: tx('Shift time'), forOff: tx('At once'),
    fields: [{ key: 'weight', label: tx('New weight'), min: 0, max: 1000 }],
  },
  {
    type: 'rollout', label: tx('Deploy a new version'), help: tx('Deploy a new version (code or config) wave by wave. A bad version is slower, fails more, or crashes at start. Waves with automatic rollback limit the damage to the first wave; one wave to everything is a global push.'), target: 'node',
    noFor: true, anyNode: tx('All (global push)'),
    fields: [
      { key: 'waves', label: tx('Waves'), min: 1, max: 20 },
      { key: 'waveS', label: tx('Watch per wave'), unit: 's', min: 1, max: 3600 },
      { key: 'slow', label: tx('New version slower by'), unit: '×', min: 1, max: 1000 },
      { key: 'errorRate', label: tx('New version error rate'), unit: '%', min: 0, max: 1, scale: 100 },
      { key: 'haltAt', label: tx('Automatic rollback threshold'), unit: '%', min: 0, max: 1, scale: 100, optional: true },
    ],
    flags: [{ key: 'crash', label: tx('Crashes at start') }],
  },
  {
    type: 'reshard', label: tx('Reshard'), help: tx('Change the shard count of a sharded database while it serves: while the data is copied every shard is slower; at the end the keys go by the new count (key mod shards). Split hot shards, or merge idle ones.'), target: 'node',
    forLabel: tx('Copy time'), forOff: tx('Default 60 s'),
    fields: [
      { key: 'toShards', label: tx('New shard count'), min: 1, max: 256 },
      { key: 'copyLoad', label: tx('Extra work while copying'), unit: '%', min: 0, max: 10, scale: 100, optional: true },
    ],
  },
  {
    type: 'pause', label: tx('GC pause'), help: tx('Stops doing work at regular times (stop-the-world).'), target: 'node',
    fields: [
      { key: 'everyS', label: tx('Every'), unit: 's', min: 0.1, max: 3600 },
      { key: 'pauseMs', label: tx('Pause length'), unit: 'ms', min: 1, max: 60000 },
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
