// What changed between two designs (roadmap-next M2): components and calls added or removed, and
// every setting that changed, from what to what. The compare view lists it; pasting a design (M4)
// shows it before the canvas is replaced.
//
// Settings are compared by what they mean, not how they are written: a parameter left out and the
// same parameter set to its default are the same. Positions, notes and the description are not
// compared: they do not change a run.
import { EDGE_PARAMS, KINDS, resolveParams, type ParamSpec } from '../schema/kinds.ts';
import { edgeId, type Design, type DesignEdge, type DesignNode, type Scenario } from '../schema/design.ts';
import { isPercent, unitLabel } from './paramLayout.ts';
import { t, tx } from '../i18n/index.ts';

export type Value = unknown;

export type Change =
  | { type: 'node-added' | 'node-removed'; node: string; kind: string; label?: string }
  | { type: 'node-changed'; node: string; kind: string; label?: string; field: string; before: Value; after: Value }
  | ({ type: 'edge-added' | 'edge-removed' } & EdgeRef)
  | ({ type: 'edge-changed'; field: string; before: Value; after: Value } & EdgeRef)
  | { type: 'api-added' | 'api-removed'; api: string }
  | { type: 'api-changed'; api: string; field: string; before: Value; after: Value }
  | { type: 'design-changed'; field: string; before: Value; after: Value };

/** A call: its id, its ends, and the names the canvas shows for them. */
export interface EdgeRef {
  edge: string;
  from: string;
  to: string;
  fromName: string;
  toName: string;
}

const same = (a: Value, b: Value) => JSON.stringify(a) === JSON.stringify(b);

/** Node fields compared besides its params. */
const NODE_FIELDS = ['kind', 'label', 'region', 'replicaRegion'] as const;

/** An edge's settings with the defaults filled in (the latency default depends on the caller). */
function edgeValues(e: DesignEdge): Record<string, Value> {
  const out: Record<string, Value> = {};
  const raw = e as unknown as Record<string, Value>;
  for (const [name, spec] of Object.entries(EDGE_PARAMS)) out[name] = raw[name] ?? (name === 'latencyMs' ? undefined : spec.default);
  out.apis = e.apis;
  return out;
}

/**
 * The changes that turn design `a` into design `b`, in a fixed order: components, calls, APIs,
 * design settings. Components match by id; calls match by id, then by caller and callee.
 */
export function diffDesigns(a: Design, b: Design): Change[] {
  const out: Change[] = [];
  const an = new Map(a.nodes.map((n) => [n.id, n]));
  const bn = new Map(b.nodes.map((n) => [n.id, n]));
  const label = (n: DesignNode) => (n.label !== undefined ? { label: n.label } : {});
  for (const n of a.nodes) if (!bn.has(n.id)) out.push({ type: 'node-removed', node: n.id, kind: n.kind, ...label(n) });
  for (const n of b.nodes) if (!an.has(n.id)) out.push({ type: 'node-added', node: n.id, kind: n.kind, ...label(n) });
  for (const nb of b.nodes) {
    const na = an.get(nb.id);
    if (!na) continue;
    const base = { type: 'node-changed' as const, node: nb.id, kind: nb.kind, ...label(nb) };
    for (const f of NODE_FIELDS) if (!same(na[f], nb[f])) out.push({ ...base, field: f, before: na[f], after: nb[f] });
    // a new kind has other params: compare what is written
    const pa = na.kind === nb.kind ? resolveParams(nb.kind, na.params) : (na.params ?? {});
    const pb = na.kind === nb.kind ? resolveParams(nb.kind, nb.params) : (nb.params ?? {});
    for (const k of [...new Set([...Object.keys(pa), ...Object.keys(pb)])]) {
      if (!same(pa[k], pb[k])) out.push({ ...base, field: `params.${k}`, before: pa[k], after: pb[k] });
    }
  }

  // calls: by id first, then an unmatched call with the same caller and callee (its filter or APIs changed)
  const ae = a.edges.map((e) => ({ e, id: edgeId(e) }));
  const be = b.edges.map((e) => ({ e, id: edgeId(e) }));
  const pairs: [DesignEdge, DesignEdge][] = [];
  const left = new Set(ae);
  const right = new Set(be);
  for (const x of ae) {
    const y = [...right].find((r) => r.id === x.id);
    if (y) {
      pairs.push([x.e, y.e]);
      left.delete(x);
      right.delete(y);
    }
  }
  for (const x of [...left]) {
    const y = [...right].find((r) => r.e.from === x.e.from && r.e.to === x.e.to);
    if (y) {
      pairs.push([x.e, y.e]);
      left.delete(x);
      right.delete(y);
    }
  }
  const named = (id: string) => {
    const n = bn.get(id) ?? an.get(id);
    return n ? nodeName({ node: n.id, kind: n.kind, label: n.label }) : id;
  };
  const ref = (id: string, e: DesignEdge): EdgeRef => ({ edge: id, from: e.from, to: e.to, fromName: named(e.from), toName: named(e.to) });
  for (const x of left) out.push({ type: 'edge-removed', ...ref(x.id, x.e) });
  for (const y of right) out.push({ type: 'edge-added', ...ref(y.id, y.e) });
  pairs.sort((x, y) => b.edges.indexOf(x[1]) - b.edges.indexOf(y[1]));
  for (const [ea, eb] of pairs) {
    const va = edgeValues(ea);
    const vb = edgeValues(eb);
    for (const k of Object.keys(vb)) if (!same(va[k], vb[k])) out.push({ type: 'edge-changed', ...ref(edgeId(eb), eb), field: k, before: va[k], after: vb[k] });
  }

  // APIs by name
  const aa = new Map((a.apis ?? []).map((x) => [x.name, x]));
  const ba = new Map((b.apis ?? []).map((x) => [x.name, x]));
  for (const x of a.apis ?? []) if (!ba.has(x.name)) out.push({ type: 'api-removed', api: x.name });
  for (const x of b.apis ?? []) if (!aa.has(x.name)) out.push({ type: 'api-added', api: x.name });
  for (const y of b.apis ?? []) {
    const x = aa.get(y.name);
    if (!x) continue;
    for (const f of ['op', 'share'] as const) {
      const before = f === 'share' ? (x.share ?? 1) : x[f];
      const after = f === 'share' ? (y.share ?? 1) : y[f];
      if (!same(before, after)) out.push({ type: 'api-changed', api: y.name, field: f, before, after });
    }
  }
  if (!same(a.interRegionMs, b.interRegionMs)) out.push({ type: 'design-changed', field: 'interRegionMs', before: a.interRegionMs, after: b.interRegionMs });
  return out;
}

export interface ScenarioChange {
  field: string;
  before: Value;
  after: Value;
}

/** Scenario fields that change a run, with their defaults. */
const SCENARIO_FIELDS: [string, (s: Scenario) => Value][] = [
  ['traffic.rps', (s) => s.traffic.rps],
  ['traffic.readRatio', (s) => s.traffic.readRatio ?? 0.9],
  ['traffic.clientTimeoutMs', (s) => s.traffic.clientTimeoutMs ?? 3000],
  ['traffic.arrivals', (s) => s.traffic.arrivals ?? 'poisson'],
  ['traffic.followReads', (s) => s.traffic.followReads ?? 0],
  ['durationS', (s) => s.durationS ?? 60],
  ['warmupS', (s) => s.warmupS ?? 5],
  ['seed', (s) => s.seed ?? 1],
  ['keys', (s) => s.keys ?? null],
  ['scale', (s) => s.scale ?? 'auto'],
  ['events', (s) => s.events ?? []],
];

/** How scenario `b` differs from `a`. Empty: the two runs can be compared number for number. */
export function diffScenarios(a: Scenario, b: Scenario): ScenarioChange[] {
  const out: ScenarioChange[] = [];
  for (const [field, get] of SCENARIO_FIELDS) {
    const before = get(a);
    const after = get(b);
    if (!same(before, after)) out.push({ field, before, after });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Text

const nodeName = (c: { node: string; kind: string; label?: string }) => c.label ?? (KINDS[c.kind] ? t(KINDS[c.kind].label) : c.node);

function fmtNum(x: number): string {
  return Number.isInteger(x) ? String(x) : String(Math.round(x * 1000) / 1000);
}

/** A setting's value as the inspector would show it. */
export function fmtValue(v: Value, spec?: ParamSpec, name = ''): string {
  if (v === undefined || v === null) return t('預設');
  if (Array.isArray(v)) return v.length ? v.join(t('、')) : t('全部');
  if (spec?.type === 'enum') {
    const o = spec.options.find((x) => x.value === v);
    return o ? t(o.label) : String(v);
  }
  if (typeof v === 'object') {
    const d = v as { mean?: number; cv?: number };
    if (typeof d.mean === 'number') return d.cv !== undefined ? `${fmtNum(d.mean)} ms (cv ${fmtNum(d.cv)})` : `${fmtNum(d.mean)} ms`;
    return JSON.stringify(v);
  }
  if (typeof v === 'number') {
    if (spec && isPercent(name, spec)) return `${fmtNum(v * 100)}%`;
    const unit = spec && 'unit' in spec && spec.unit ? t(unitLabel(spec.unit)) : '';
    return unit ? `${fmtNum(v)} ${unit}` : fmtNum(v);
  }
  return String(v);
}

const FIELD_LABEL: Record<string, string> = {
  kind: tx('種類'),
  label: tx('名稱'),
  region: tx('區域'),
  replicaRegion: tx('副本區域'),
  apis: tx('只走這些 API'),
  op: tx('讀或寫'),
  share: tx('流量比重'),
  interRegionMs: tx('跨區域延遲'),
};

/** One change as a sentence. */
export function describeChange(c: Change): string {
  switch (c.type) {
    case 'node-added':
      return t('新增元件「{name}」', { name: nodeName(c) });
    case 'node-removed':
      return t('刪除元件「{name}」', { name: nodeName(c) });
    case 'edge-added':
      return t('新增呼叫 {from} → {to}', { from: c.fromName, to: c.toName });
    case 'edge-removed':
      return t('刪除呼叫 {from} → {to}', { from: c.fromName, to: c.toName });
    case 'api-added':
      return t('新增 API「{api}」', { api: c.api });
    case 'api-removed':
      return t('刪除 API「{api}」', { api: c.api });
    case 'node-changed': {
      const { what, before, after } = fieldText(c.field, c.kind, c.before, c.after);
      return t('「{name}」的{what}：{before} → {after}', { name: nodeName(c), what, before, after });
    }
    case 'edge-changed': {
      const { what, before, after } = fieldText(c.field, 'edge', c.before, c.after);
      return t('呼叫 {from} → {to} 的{what}：{before} → {after}', { from: c.fromName, to: c.toName, what, before, after });
    }
    case 'api-changed': {
      const what = t(FIELD_LABEL[c.field] ?? c.field);
      const v = (x: Value) => (c.field === 'op' ? (x === 'read' ? t('讀') : t('寫')) : fmtValue(x));
      return t('API「{api}」的{what}：{before} → {after}', { api: c.api, what, before: v(c.before), after: v(c.after) });
    }
    case 'design-changed':
      return t('設計的{what}：{before} → {after}', { what: t(FIELD_LABEL[c.field] ?? c.field), before: fmtValue(c.before, EDGE_PARAMS.latencyMs), after: fmtValue(c.after, EDGE_PARAMS.latencyMs) });
  }
}

function fieldText(field: string, kind: string, before: Value, after: Value): { what: string; before: string; after: string } {
  const name = field.startsWith('params.') ? field.slice(7) : field;
  const spec = kind === 'edge' ? EDGE_PARAMS[name] : field.startsWith('params.') ? KINDS[kind]?.params[name] : undefined;
  if (field === 'kind') {
    const k = (x: Value) => (typeof x === 'string' && KINDS[x] ? t(KINDS[x].label) : String(x));
    return { what: t('種類'), before: k(before), after: k(after) };
  }
  if (field === 'latencyMs' && kind === 'edge') {
    const v = (x: Value) => (x === undefined ? t('預設') : fmtValue(x, spec, name));
    return { what: t(spec!.label), before: v(before), after: v(after) };
  }
  const what = spec ? t(spec.label) : t(FIELD_LABEL[name] ?? name);
  const v = (x: Value) => (x === undefined && (field === 'label' || field === 'region' || field === 'replicaRegion') ? t('沒有') : fmtValue(x, spec, name));
  return { what, before: v(before), after: v(after) };
}

const SCENARIO_LABEL: Record<string, string> = {
  'traffic.rps': tx('每秒請求'),
  'traffic.readRatio': tx('讀取比例'),
  'traffic.clientTimeoutMs': tx('使用者逾時'),
  'traffic.arrivals': tx('請求到達方式'),
  'traffic.followReads': tx('寫完接著讀的比例'),
  durationS: tx('時長'),
  warmupS: tx('暖機'),
  seed: tx('隨機種子'),
  keys: tx('資料筆數和熱門程度'),
  scale: tx('縮小比例'),
  events: tx('事件'),
};

/** One scenario change as a sentence. */
export function describeScenarioChange(c: ScenarioChange): string {
  const what = t(SCENARIO_LABEL[c.field] ?? c.field);
  const v = (x: Value): string => {
    if (c.field === 'events') return t('{n} 個', { n: (x as unknown[]).length });
    if (c.field === 'traffic.readRatio' || c.field === 'traffic.followReads') return `${fmtNum((x as number) * 100)}%`;
    if (c.field === 'durationS' || c.field === 'warmupS') return t('{n} 秒', { n: fmtNum(x as number) });
    if (c.field === 'traffic.clientTimeoutMs') return `${fmtNum(x as number)} ms`;
    if (c.field === 'keys') return x ? t('{count} 筆，zipf {zipf}', { count: (x as { count: number }).count, zipf: (x as { zipf?: number }).zipf ?? 0.8 }) : t('預設');
    if (c.field === 'traffic.arrivals') return x === 'constant' ? t('平均間隔') : t('隨機');
    return fmtValue(x);
  };
  if (c.field === 'events' && Array.isArray(c.before) && Array.isArray(c.after) && c.before.length === c.after.length) return t('情境的事件不同');
  return t('情境的{what}：{before} → {after}', { what, before: v(c.before), after: v(c.after) });
}
