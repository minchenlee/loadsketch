// What changed between two designs (roadmap-next M2).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { ApiSchema, DesignSchema, EdgeSchema, NodeSchema, ScenarioSchema, type Design, type DesignEdge, type Scenario } from '../src/schema/design.ts';
import { EDGE_PARAMS, KINDS, type ParamSpec } from '../src/schema/kinds.ts';
import { describeChange, describeScenarioChange, diffDesigns, diffScenarios, IGNORED, type Change } from '../src/app/designDiff.ts';
import { setLang } from '../src/i18n/index.ts';

const root = join(import.meta.dirname, '..', 'examples');
const design = (n: string) => JSON.parse(readFileSync(join(root, 'designs', `${n}.json`), 'utf8')) as Design;
const scenario = (n: string) => JSON.parse(readFileSync(join(root, 'scenarios', `${n}.json`), 'utf8')) as Scenario;
const clone = <T,>(x: T): T => structuredClone(x);
const texts = (cs: Change[]) => cs.map(describeChange);

describe('design diff', () => {
  setLang('zh-TW');

  it('a design compared with itself has no changes, for every example', () => {
    for (const f of readdirSync(join(root, 'designs')).filter((x) => x.endsWith('.json'))) {
      const d = design(f.replace(/\.json$/, ''));
      expect(diffDesigns(d, clone(d)), f).toEqual([]);
    }
  });

  it('moving components, notes and the description are not changes', () => {
    const a = design('three-tier');
    const b = clone(a);
    b.nodes[0].pos = [999, 999];
    b.description = 'other';
    b.notes = [{ id: 'n', text: 'x', pos: [0, 0] }];
    b.name = 'renamed';
    expect(diffDesigns(a, b)).toEqual([]);
  });

  it('a param left out equals the same param set to its default', () => {
    const a = design('three-tier');
    const b = clone(a);
    const api = b.nodes.find((n) => n.id === 'api')!;
    api.params = { ...api.params, queueLimit: 500 }; // the service default
    expect(diffDesigns(a, b)).toEqual([]);
  });

  it('components added and removed', () => {
    const a = design('three-tier');
    const b = clone(a);
    b.nodes = b.nodes.filter((n) => n.id !== 'cache');
    b.edges = b.edges.filter((e) => e.to !== 'cache');
    b.nodes.push({ id: 'queue', kind: 'queue', pos: [0, 0] });
    const d = diffDesigns(a, b);
    expect(d).toContainEqual({ type: 'node-removed', node: 'cache', kind: 'cache', label: 'Redis' });
    expect(d).toContainEqual({ type: 'node-added', node: 'queue', kind: 'queue' });
    expect(d).toContainEqual({ type: 'edge-removed', edge: 'api->cache', from: 'api', to: 'cache', fromName: 'API 伺服器', toName: 'Redis' });
    expect(texts(d)).toEqual(['刪除元件「Redis」', '新增元件「Queue」', '刪除呼叫 API 伺服器 → Redis']);
  });

  it('a changed setting says from what to what', () => {
    const a = design('three-tier');
    const b = clone(a);
    b.nodes.find((n) => n.id === 'api')!.params!.instances = 4;
    b.nodes.find((n) => n.id === 'api')!.params!.serviceMs = { mean: 8, cv: 1 };
    b.nodes.find((n) => n.id === 'cache')!.label = 'Memcached';
    const d = diffDesigns(a, b);
    expect(d).toContainEqual({ type: 'node-changed', node: 'api', kind: 'service', label: 'API 伺服器', field: 'params.instances', before: 3, after: 4 });
    expect(texts(d)).toEqual(['「API 伺服器」的實例數：3 → 4', '「API 伺服器」的處理時間：6 ms (cv 1) → 8 ms (cv 1)', '「Memcached」的名稱：Redis → Memcached']);
  });

  it('a changed call, also when its filter changes its id', () => {
    const a = design('three-tier');
    const b = clone(a);
    b.edges.find((e) => e.to === 'db')!.timeoutMs = 300;
    const e = b.edges.find((x) => x.to === 'cache')!;
    e.retries = 2;
    e.on = 'read';
    const d = diffDesigns(a, b);
    expect(d.filter((c) => c.type === 'edge-added' || c.type === 'edge-removed')).toEqual([]);
    expect(texts(d)).toEqual(['呼叫 API 伺服器 → Redis 的走哪些請求：全部 → 只走讀取', '呼叫 API 伺服器 → Redis 的重試次數：0 → 2', '呼叫 API 伺服器 → Postgres 的逾時：500 ms → 300 ms']);
  });

  it('the paired examples differ only where the lesson says', () => {
    expect(texts(diffDesigns(design('retry-storm'), design('retry-budget')))).toEqual([
      '呼叫 負載平衡器 → API 伺服器 的重試預算：0% → 10%',
      '呼叫 API 伺服器 → Redis 的重試預算：0% → 10%',
      '呼叫 API 伺服器 → Postgres 的重試預算：0% → 10%',
    ]);
    const lease = diffDesigns(design('cache-stampede'), design('cache-lease'));
    expect(lease.map((c) => c.type === 'node-changed' && c.field)).toEqual(['params.ttlJitter', 'params.stampede']);
  });

  it('APIs added, removed and changed', () => {
    const a: Design = { ...design('three-tier'), apis: [{ name: 'feed', op: 'read' }, { name: 'post', op: 'write', share: 2 }] };
    const b: Design = { ...clone(a), apis: [{ name: 'feed', op: 'read', share: 3 }, { name: 'like', op: 'write' }] };
    expect(texts(diffDesigns(a, b))).toEqual(['刪除 API「post」', '新增 API「like」', 'API「feed」的流量比重：1 → 3']);
  });

  it('English text', () => {
    setLang('en');
    try {
      const a = design('three-tier');
      const b = clone(a);
      b.nodes.find((n) => n.id === 'api')!.params!.instances = 4;
      expect(texts(diffDesigns(a, b))).toEqual(['"API 伺服器" Instances: 3 → 4']);
    } finally {
      setLang('zh-TW');
    }
  });
});

describe('scenario diff', () => {
  it('same scenario, defaults written out or not: no change', () => {
    const s = scenario('steady');
    expect(diffScenarios(s, clone(s))).toEqual([]);
    expect(diffScenarios(s, { ...clone(s), seed: s.seed ?? 1, durationS: s.durationS ?? 60 })).toEqual([]);
  });

  it('different traffic, seed and events', () => {
    const a = scenario('steady');
    const b = scenario('spike');
    const d = diffScenarios(a, b);
    expect(d.map((c) => c.field)).toContain('events');
    expect(diffScenarios(a, { ...a, seed: 5 })).toEqual([{ field: 'seed', before: a.seed ?? 1, after: 5 }]);
    setLang('zh-TW');
    expect(describeScenarioChange({ field: 'traffic.rps', before: 800, after: 1200 })).toBe('情境的每秒請求：800 → 1200');
    expect(describeScenarioChange({ field: 'events', before: [], after: [{}] })).toBe('情境的事件：0 個 → 1 個');
  });
});

// Every field of the format is compared, or listed in IGNORED: a field added later cannot be missed.
const shapeKeys = (o: unknown) => Object.keys((o as z.ZodObject).shape);

/** A valid value other than the default (or `than`). */
function another(spec: ParamSpec, than?: unknown): unknown {
  switch (spec.type) {
    case 'int':
    case 'number': {
      const v = than ?? spec.default;
      return v === spec.max ? spec.min : spec.max;
    }
    case 'ratio':
      return (than ?? spec.default) === 1 ? 0 : 1;
    case 'dist':
      return { mean: spec.default.mean + 7, cv: spec.default.cv };
    case 'enum':
      return spec.options.find((o) => o.value !== (than ?? spec.default))!.value;
  }
}

describe('every field is compared (M2 review P2)', () => {
  setLang('zh-TW');

  it('scenario: each field of the schema, changed alone, is a difference', () => {
    const base: Scenario = { schema: 'loadsketch/scenario@1', name: 'a', traffic: { rps: 100 } };
    // one other value for every field; a new field in the schema fails here until it is listed
    const alt: Record<string, (s: Scenario) => void> = {
      seed: (s) => (s.seed = 7),
      durationS: (s) => (s.durationS = 90),
      warmupS: (s) => (s.warmupS = 10),
      windowS: (s) => (s.windowS = 2),
      'traffic.rps': (s) => (s.traffic.rps = 200),
      'traffic.readRatio': (s) => (s.traffic.readRatio = 0.5),
      'traffic.clientTimeoutMs': (s) => (s.traffic.clientTimeoutMs = 1000),
      'traffic.arrivals': (s) => (s.traffic.arrivals = 'constant'),
      'traffic.followReads': (s) => (s.traffic.followReads = 0.2),
      'traffic.followAfterMs': (s) => (s.traffic.followAfterMs = 2000),
      'keys.count': (s) => (s.keys = { count: 50 }),
      'keys.zipf': (s) => (s.keys = { count: 100000, zipf: 1.2 }),
      events: (s) => (s.events = [{ type: 'down', at: 10, node: 'api' } as never]),
      scale: (s) => (s.scale = 1),
    };
    const shape = (ScenarioSchema as unknown as z.ZodObject).shape;
    const leaves = [
      ...shapeKeys(ScenarioSchema).filter((k) => k !== 'traffic' && k !== 'keys'),
      ...shapeKeys(shape.traffic).map((k) => `traffic.${k}`),
      ...shapeKeys((shape.keys as unknown as z.ZodOptional<z.ZodObject>).unwrap()).map((k) => `keys.${k}`),
    ].filter((k) => !(IGNORED.scenario as readonly string[]).includes(k));
    expect(Object.keys(alt).sort()).toEqual(leaves.sort());
    for (const [field, set] of Object.entries(alt)) {
      const b = clone(base);
      set(b);
      expect(diffScenarios(base, b).map((c) => c.field), field).toEqual([field]);
      expect(describeScenarioChange(diffScenarios(base, b)[0]), field).not.toMatch(/^情境的[a-z]/);
    }
    // the case from the review: only followAfterMs differs
    expect(diffScenarios({ ...base, traffic: { rps: 100, followAfterMs: 100 } }, { ...base, traffic: { rps: 100, followAfterMs: 2000 } })).toHaveLength(1);
    // the name does not change a run
    expect(diffScenarios(base, { ...base, name: 'b' })).toEqual([]);
  });

  const two = (): Design => ({
    schema: 'loadsketch/design@1',
    name: 'd',
    nodes: [
      { id: 'u', kind: 'client', pos: [0, 0] },
      { id: 'api', kind: 'service', pos: [200, 0] },
      { id: 'db', kind: 'database', pos: [400, 0] },
    ],
    edges: [{ id: 'call', from: 'u', to: 'api' }],
    apis: [{ name: 'feed', op: 'read' }],
  });

  it('edge: each field of the schema, changed alone, is a difference; a call with an id that is moved says where to', () => {
    const fields = shapeKeys(EdgeSchema).filter((k) => !(IGNORED.edge as readonly string[]).includes(k));
    const alt: Record<string, (e: DesignEdge) => void> = { from: (e) => (e.from = 'db'), to: (e) => (e.to = 'db'), apis: (e) => (e.apis = ['feed']) };
    for (const [name, spec] of Object.entries(EDGE_PARAMS)) alt[name] = (e) => ((e as unknown as Record<string, unknown>)[name] = another(spec));
    expect(Object.keys(alt).sort()).toEqual(fields.sort());
    for (const [field, set] of Object.entries(alt)) {
      const a = two();
      const b = two();
      set(b.edges[0]);
      const d = diffDesigns(a, b);
      expect(d.map((c) => c.type === 'edge-changed' && c.field), field).toEqual([field]);
    }
    // the case from the review: an explicit id, the callee changed
    setLang('zh-TW');
    const a = two();
    const b = two();
    b.edges[0].to = 'db';
    expect(texts(diffDesigns(a, b))).toEqual(['呼叫 使用者 → Database 的被呼叫端：API Server → Database']);
    // the id and the source do not change a run
    const c = two();
    c.edges[0].source = { line: 'definite' };
    expect(diffDesigns(a, c)).toEqual([]);
  });

  it('node: each field of every kind, and each of its params, changed alone, is a difference', () => {
    for (const option of (NodeSchema as unknown as { options: z.ZodObject[] }).options) {
      const kind = (option.shape.kind as unknown as z.ZodLiteral<string>).value;
      const node = { id: 'x', kind, pos: [0, 0] as [number, number] };
      const design = (n: object): Design => ({ schema: 'loadsketch/design@1', name: 'd', nodes: [n as never], edges: [] });
      const alt: Record<string, () => object> = {
        kind: () => ({ ...node, kind: kind === 'service' ? 'cache' : 'service' }),
        label: () => ({ ...node, label: 'L' }),
        region: () => ({ ...node, region: 'eu' }),
        ...(shapeKeys(option).includes('replicaRegion') ? { replicaRegion: () => ({ ...node, replicaRegion: 'eu' }) } : {}),
      };
      const fields = shapeKeys(option).filter((k) => k !== 'params' && k !== 'id' && !(IGNORED.node as readonly string[]).includes(k));
      expect(Object.keys(alt).sort(), kind).toEqual(fields.sort());
      for (const [field, make] of Object.entries(alt)) {
        expect(diffDesigns(design(node), design(make())).map((c) => c.type === 'node-changed' && c.field)[0], `${kind}.${field}`).toBe(field);
      }
      for (const [name, spec] of Object.entries(KINDS[kind].params)) {
        const d = diffDesigns(design(node), design({ ...node, params: { [name]: another(spec) } }));
        expect(d.map((c) => c.type === 'node-changed' && c.field), `${kind}.${name}`).toEqual([`params.${name}`]);
      }
      // where it sits and where it came from do not change a run
      expect(diffDesigns(design(node), design({ ...node, pos: [5, 5], source: { from: ['x'] } }))).toEqual([]);
    }
  });

  it('design and API: each field of the schema, changed alone, is a difference', () => {
    const designFields = shapeKeys(DesignSchema).filter((k) => !(IGNORED.design as readonly string[]).includes(k) && !['nodes', 'edges', 'apis'].includes(k));
    expect(designFields).toEqual(['interRegionMs']);
    const b = two();
    b.interRegionMs = 80;
    expect(diffDesigns(two(), b).map((c) => c.type)).toEqual(['design-changed']);

    const apiFields = shapeKeys(ApiSchema).filter((k) => !(IGNORED.api as readonly string[]).includes(k));
    const alt: Record<string, (d: Design) => void> = { op: (d) => (d.apis![0].op = 'write'), share: (d) => (d.apis![0].share = 3) };
    expect(Object.keys(alt).sort()).toEqual(apiFields.sort());
    for (const [field, set] of Object.entries(alt)) {
      const d = two();
      set(d);
      expect(diffDesigns(two(), d).map((c) => c.type === 'api-changed' && c.field), field).toEqual([field]);
    }
    const named = two();
    named.apis![0].label = 'Feed';
    named.name = 'other';
    expect(diffDesigns(two(), named)).toEqual([]);
  });
});
