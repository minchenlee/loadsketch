// What changed between two designs (roadmap-next M2).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Design, Scenario } from '../src/schema/design.ts';
import { describeChange, describeScenarioChange, diffDesigns, diffScenarios, type Change } from '../src/app/designDiff.ts';
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
