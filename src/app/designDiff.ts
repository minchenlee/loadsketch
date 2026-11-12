// What changed between two designs (roadmap-next M2): components and calls added or removed, and
// every setting that changed, from what to what. The compare view lists it; pasting a design (M4)
// shows it before the canvas is replaced.
//
// Settings are compared by what they mean, not how they are written: a parameter left out and the
// same parameter set to its default are the same. Every field is compared except the few listed as
// IGNORED below (positions, notes, names, the description, import sources): they do not change a
// run. A field added to the format later is compared without a change here (tests/design-diff.test.ts
// lists the fields of the schema to make sure).
import { EDGE_PARAMS, KINDS, resolveParams, type ParamSpec } from '../schema/kinds.ts';
import { edgeId, resolveScenario, type Design, type DesignEdge, type DesignNode, type Scenario } from '../schema/design.ts';
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

/** Fields that do not change a run: not compared. */
export const IGNORED = {
  design: ['schema', 'name', 'description', 'notes'],
  node: ['id', 'pos', 'source'],
  edge: ['id', 'source'],
  api: ['name', 'label'],
  scenario: ['schema', 'name'],
} as const;

const has = (list: readonly string[], k: string) => list.includes(k);
const keysOf = (...objs: object[]) => [...new Set(objs.flatMap((o) => Object.keys(o)))];

/** Node fields shown first, in this order; other fields follow. */
const NODE_FIELDS = ['kind', 'label', 'region', 'replicaRegion'];

/** An edge's fields with the defaults filled in (the latency default depends on the caller). */
function edgeValues(e: DesignEdge): Record<string, Value> {
  const out: Record<string, Value> = { from: e.from, to: e.to };
  const raw = e as unknown as Record<string, Value>;
  for (const [name, spec] of Object.entries(EDGE_PARAMS)) out[name] = raw[name] ?? (name === 'latencyMs' ? undefined : spec.default);
  for (const k of Object.keys(raw)) if (!(k in out) && !has(IGNORED.edge, k)) out[k] = raw[k];
  return out;
}

type Ref = { e: DesignEdge; id: string };

/**
 * Which call of `a` each call of `b` is: by id first, then an unmatched call with the same caller and
 * callee (its filter or APIs changed), taken in order. Pairs are in the order of `b`; calls left over
 * are in their design's order. Pasting a design uses the same pairs to give lines their sources back
 * (M5 review round 3), so both agree. Linear in the number of calls.
 */
export function pairEdges(a: DesignEdge[], b: DesignEdge[]): { pairs: [DesignEdge, DesignEdge][]; left: Ref[]; right: Ref[] } {
  const ae = a.map((e) => ({ e, id: edgeId(e) }));
  const be = b.map((e) => ({ e, id: edgeId(e) }));
  const match = new Map<Ref, Ref>();
  const byId = new Map<string, Ref>();
  for (const y of be) if (!byId.has(y.id)) byId.set(y.id, y);
  const taken = new Set<Ref>();
  for (const x of ae) {
    const y = byId.get(x.id);
    if (y && !taken.has(y)) {
      match.set(y, x);
      taken.add(y);
    }
  }
  const free = new Map<string, Ref[]>();
  for (const y of be) {
    if (taken.has(y)) continue;
    const key = `${y.e.from}\u0000${y.e.to}`;
    const list = free.get(key);
    if (list) list.push(y);
    else free.set(key, [y]);
  }
  const head = new Map<string, number>();
  const matched = new Set<Ref>(match.values());
  for (const x of ae) {
    if (matched.has(x)) continue;
    const key = `${x.e.from}\u0000${x.e.to}`;
    const list = free.get(key);
    const i = head.get(key) ?? 0;
    if (!list || i >= list.length) continue;
    head.set(key, i + 1);
    match.set(list[i], x);
    matched.add(x);
  }
  const pairs: [DesignEdge, DesignEdge][] = [];
  const right: Ref[] = [];
  for (const y of be) {
    const x = match.get(y);
    if (x) pairs.push([x.e, y.e]);
    else right.push(y);
  }
  return { pairs, left: ae.filter((x) => !matched.has(x)), right };
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
    const ra = na as unknown as Record<string, Value>;
    const rb = nb as unknown as Record<string, Value>;
    const fields = [...NODE_FIELDS, ...keysOf(na, nb).filter((k) => !NODE_FIELDS.includes(k))].filter((k) => k !== 'params' && !has(IGNORED.node, k));
    for (const f of fields) if (!same(ra[f], rb[f])) out.push({ ...base, field: f, before: ra[f], after: rb[f] });
    // a new kind has other params: compare what is written
    const pa = na.kind === nb.kind ? resolveParams(nb.kind, na.params) : (na.params ?? {});
    const pb = na.kind === nb.kind ? resolveParams(nb.kind, nb.params) : (nb.params ?? {});
    for (const k of [...new Set([...Object.keys(pa), ...Object.keys(pb)])]) {
      if (!same(pa[k], pb[k])) out.push({ ...base, field: `params.${k}`, before: pa[k], after: pb[k] });
    }
  }

  const { pairs, left, right } = pairEdges(a.edges, b.edges);
  const named = (id: string) => {
    const n = bn.get(id) ?? an.get(id);
    return n ? nodeName({ node: n.id, kind: n.kind, label: n.label }) : id;
  };
  const ref = (id: string, e: DesignEdge): EdgeRef => ({ edge: id, from: e.from, to: e.to, fromName: named(e.from), toName: named(e.to) });
  for (const x of left) out.push({ type: 'edge-removed', ...ref(x.id, x.e) });
  for (const y of right) out.push({ type: 'edge-added', ...ref(y.id, y.e) });
  for (const [ea, eb] of pairs) {
    const va = edgeValues(ea);
    const vb = edgeValues(eb);
    for (const k of keysOf(va, vb)) {
      if (same(va[k], vb[k])) continue;
      // a call that now goes from or to another component: the names, as the canvas shows them
      const end = k === 'from' || k === 'to';
      out.push({ type: 'edge-changed', ...ref(edgeId(eb), eb), field: k, before: end ? named(va[k] as string) : va[k], after: end ? named(vb[k] as string) : vb[k] });
    }
  }

  // APIs by name
  const aa = new Map((a.apis ?? []).map((x) => [x.name, x]));
  const ba = new Map((b.apis ?? []).map((x) => [x.name, x]));
  for (const x of a.apis ?? []) if (!ba.has(x.name)) out.push({ type: 'api-removed', api: x.name });
  for (const x of b.apis ?? []) if (!aa.has(x.name)) out.push({ type: 'api-added', api: x.name });
  for (const y of b.apis ?? []) {
    const x = aa.get(y.name);
    if (!x) continue;
    const rx = { ...x, share: x.share ?? 1 } as Record<string, Value>;
    const ry = { ...y, share: y.share ?? 1 } as Record<string, Value>;
    for (const f of keysOf(rx, ry)) if (!has(IGNORED.api, f) && !same(rx[f], ry[f])) out.push({ type: 'api-changed', api: y.name, field: f, before: rx[f], after: ry[f] });
  }
  const da = a as unknown as Record<string, Value>;
  const db = b as unknown as Record<string, Value>;
  for (const f of keysOf(a, b)) {
    if (has(IGNORED.design, f) || f === 'nodes' || f === 'edges' || f === 'apis') continue;
    if (!same(da[f], db[f])) out.push({ type: 'design-changed', field: f, before: da[f], after: db[f] });
  }
  return out;
}

export interface ScenarioChange {
  field: string;
  before: Value;
  after: Value;
}

/** The fields of a resolved scenario, by their place in the scenario file. */
const SCENARIO_PATH: Record<string, string> = {
  rps: 'traffic.rps',
  readRatio: 'traffic.readRatio',
  clientTimeoutMs: 'traffic.clientTimeoutMs',
  arrivals: 'traffic.arrivals',
  followReads: 'traffic.followReads',
  followAfterMs: 'traffic.followAfterMs',
  keyCount: 'keys.count',
  zipf: 'keys.zipf',
};

/**
 * A scenario as the engine runs it: every field with its default filled in (resolveScenario), plus
 * the scale. The name is left out: it does not change a run.
 */
function scenarioValues(s: Scenario): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const [k, v] of Object.entries(resolveScenario(s))) if (!has(IGNORED.scenario, k)) out[SCENARIO_PATH[k] ?? k] = v;
  out.scale = s.scale ?? 'auto';
  return out;
}

/** How scenario `b` differs from `a`. Empty: the two runs can be compared number for number. */
export function diffScenarios(a: Scenario, b: Scenario): ScenarioChange[] {
  const va = scenarioValues(a);
  const vb = scenarioValues(b);
  return keysOf(va, vb).filter((k) => !same(va[k], vb[k])).map((field) => ({ field, before: va[field], after: vb[field] }));
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
  from: tx('呼叫端'),
  to: tx('被呼叫端'),
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
  'traffic.followAfterMs': tx('寫完多久接著讀'),
  'keys.count': tx('資料筆數'),
  'keys.zipf': tx('熱門程度（zipf）'),
  durationS: tx('時長'),
  warmupS: tx('暖機'),
  windowS: tx('每個統計區間'),
  seed: tx('隨機種子'),
  scale: tx('縮小比例'),
  events: tx('事件'),
};

/** One scenario change as a sentence. */
export function describeScenarioChange(c: ScenarioChange): string {
  const what = t(SCENARIO_LABEL[c.field] ?? c.field);
  const v = (x: Value): string => {
    if (c.field === 'events') return t('{n} 個', { n: (x as unknown[]).length });
    if (c.field === 'traffic.readRatio' || c.field === 'traffic.followReads') return `${fmtNum((x as number) * 100)}%`;
    if (c.field === 'durationS' || c.field === 'warmupS' || c.field === 'windowS') return t('{n} 秒', { n: fmtNum(x as number) });
    if (c.field === 'traffic.clientTimeoutMs' || c.field === 'traffic.followAfterMs') return `${fmtNum(x as number)} ms`;
    if (c.field === 'traffic.arrivals') return x === 'constant' ? t('平均間隔') : t('隨機');
    return fmtValue(x);
  };
  if (c.field === 'events' && Array.isArray(c.before) && Array.isArray(c.after) && c.before.length === c.after.length) return t('情境的事件不同');
  return t('情境的{what}：{before} → {after}', { what, before: v(c.before), after: v(c.after) });
}
