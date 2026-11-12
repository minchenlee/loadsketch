// Component presets (roadmap-next M8, Q21): a component with its settings under a name, kept in the
// browser and in a file. The data layer: what a preset keeps, the file format, merging an import.
import { describe, expect, it } from 'vitest';
import { MAX_PRESETS, PRESETS_KEY, PRESETS_SCHEMA, loadPresets, mergePresets, parsePresetFile, presetFile, presetFromNode, readPreset, savePresets, updatePresets, usePresets, type Preset, type Store } from '../src/app/presets.ts';

const mem = (): Store & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

const pay: Preset = { id: 'p1', name: '金流商（200 ms、1% 失敗）', kind: 'service', params: { serviceMs: { mean: 200, cv: 0.5 }, errorRate: 0.01 } };

describe('presets', () => {
  it('a preset keeps the kind and settings of a component, not its place, region or source', () => {
    const node = { id: 'api', kind: 'service', pos: [10, 20], params: { instances: 4 }, source: { from: ['aws_ecs_service.api'] } } as never;
    const p = presetFromNode(node, '  API  ', new Set(['p1']));
    expect(p).toEqual({ id: 'p2', name: 'API', kind: 'service', params: { instances: 4 } });
    // a copy: changing the component later does not change the preset
    (node as { params: { instances: number } }).params.instances = 9;
    expect(p.params!.instances).toBe(4);
    expect(presetFromNode({ kind: 'cache' }, 'c', new Set())).toEqual({ id: 'p1', name: 'c', kind: 'cache' });
  });

  it('a preset is read only when its kind exists and its settings are valid for it', () => {
    expect(readPreset(pay)).toEqual(pay);
    expect(readPreset({ ...pay, kind: 'spaceship' })).toBeNull();
    expect(readPreset({ ...pay, params: { instances: 0 } })).toBeNull();
    expect(readPreset({ ...pay, params: { nope: 1 } })).toBeNull();
    expect(readPreset({ ...pay, name: '   ' })).toBeNull();
    expect(readPreset({ ...pay, name: 'x'.repeat(61) })).toBeNull();
    expect(readPreset({ ...pay, id: 3 })).toBeNull();
    expect(readPreset(null)).toBeNull();
    // a custom service with its own icon and price
    expect(readPreset({ id: 'c', name: '搜尋', kind: 'custom', params: { icon: 'Search', pricePerHour: 0.3 } })).not.toBeNull();
  });

  it('the file has a version; a file with other presets keeps the valid ones and counts the rest', () => {
    const text = presetFile([pay]);
    expect(JSON.parse(text).schema).toBe(PRESETS_SCHEMA);
    expect(parsePresetFile(text)).toEqual({ ok: true, presets: [pay], skipped: 0 });
    const mixed = JSON.stringify({ schema: PRESETS_SCHEMA, presets: [pay, { id: 'x', name: 'bad', kind: 'nope' }] });
    expect(parsePresetFile(mixed)).toEqual({ ok: true, presets: [pay], skipped: 1 });
    expect(parsePresetFile('{')).toEqual({ ok: false });
    expect(parsePresetFile(JSON.stringify({ schema: 'loadsketch/presets@2', presets: [] }))).toEqual({ ok: false });
    expect(parsePresetFile(JSON.stringify({ schema: 'loadsketch/design@1', nodes: [] }))).toEqual({ ok: false });
  });

  it('an import skips presets already there, gives a new id to a taken one, and stops at the limit', () => {
    const other: Preset = { id: 'p1', name: 'Redis', kind: 'cache', params: { hitRatio: 0.9 } };
    const r = mergePresets([pay], [pay, other]);
    expect(r.added).toBe(1);
    expect(r.list.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(r.list[1]).toMatchObject({ name: 'Redis', kind: 'cache' });
    const many = Array.from({ length: MAX_PRESETS }, (_, i) => ({ id: `q${i}`, name: `n${i}`, kind: 'service' }));
    const full = mergePresets(many, [other]);
    expect(full).toMatchObject({ added: 0, full: 1 });
    expect(full.list.length).toBe(MAX_PRESETS);
  });

  it('saved in the browser and loaded again; broken or blocked storage gives an empty list, not an error', () => {
    const s = mem();
    expect(loadPresets(s)).toEqual([]);
    expect(savePresets(s, [pay])).toBe(true);
    expect(s.data.has(PRESETS_KEY)).toBe(true);
    expect(loadPresets(s)).toEqual([pay]);
    s.data.set(PRESETS_KEY, 'not json');
    expect(loadPresets(s)).toEqual([]);
    const blocked: Store = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); } };
    expect(loadPresets(blocked)).toEqual([]);
    expect(savePresets(blocked, [pay])).toBe(false);
    expect(savePresets(undefined, [pay])).toBe(false);
  });

  it('the store: saving the same name and kind again replaces its settings in place; without storage it says so', () => {
    const st = usePresets.getState();
    const a = st.save({ kind: 'service', params: { instances: 2 } }, 'API');
    st.save({ kind: 'cache' }, 'Redis');
    const b = usePresets.getState().save({ kind: 'service', params: { instances: 5 } }, 'API');
    expect(b.id).toBe(a.id);
    expect(usePresets.getState().presets.map((p) => [p.name, p.params?.instances])).toEqual([['API', 5], ['Redis', undefined]]);
    // tests run without localStorage: the presets last only in memory
    expect(usePresets.getState().memoryOnly).toBe(true);
    usePresets.getState().remove(a.id);
    expect(usePresets.getState().presets.map((p) => p.name)).toEqual(['Redis']);
    expect(usePresets.getState().importPresets([pay, pay])).toEqual({ added: 1, full: 0 });
  });

  it('two tabs: a change starts from the list in storage now, so one tab does not erase the other\'s presets (M8 review P2)', () => {
    const s = mem();
    // tab 1 loaded an empty list, then tab 2 saved "API"
    const tab1: Preset[] = [];
    savePresets(s, [{ id: 'p1', name: 'API', kind: 'service' }]);
    const r = updatePresets(s, tab1, (l) => [...l, { id: 'p2', name: 'Redis', kind: 'cache' }]);
    expect(r.list.map((p) => p.name)).toEqual(['API', 'Redis']);
    expect(loadPresets(s).map((p) => p.name)).toEqual(['API', 'Redis']);
    expect(r.memoryOnly).toBe(false);
    // no storage: the change applies to the list in memory
    const m = updatePresets(undefined, tab1, (l) => [...l, { id: 'p9', name: 'X', kind: 'cache' }]);
    expect(m).toEqual({ list: [{ id: 'p9', name: 'X', kind: 'cache' }], memoryOnly: true });
  });

  it('storage that reads but takes no write: a change after a failed write keeps the unsaved one (M8 review round 2)', () => {
    const data = new Map<string, string>();
    const s: Store = { getItem: (k) => data.get(k) ?? null, setItem: () => { throw new Error('quota'); } };
    data.set(PRESETS_KEY, presetFile([{ id: 'p1', name: 'API', kind: 'service' }]));
    let r = updatePresets(s, loadPresets(s), (l) => [...l, { id: 'p2', name: 'Redis', kind: 'cache' }]);
    expect(r.memoryOnly).toBe(true);
    r = updatePresets(s, r.list, (l) => [...l, { id: 'p3', name: 'DB', kind: 'database' }], r.memoryOnly);
    expect(r.list.map((p) => p.name)).toEqual(['API', 'Redis', 'DB']);
    // a removed preset does not come back with the next change
    r = updatePresets(s, r.list, (l) => l.filter((p) => p.name !== 'API'), r.memoryOnly);
    r = updatePresets(s, r.list, (l) => l, r.memoryOnly);
    expect(r.list.map((p) => p.name)).toEqual(['Redis', 'DB']);
  });
});
