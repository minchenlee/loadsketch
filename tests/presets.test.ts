// Component presets (roadmap-next M8, Q21): a component with its settings under a name, kept in the
// browser and in a file. The data layer: what a preset keeps, the file format, merging an import.
import { describe, expect, it } from 'vitest';
import { MAX_PRESETS, PRESETS_KEY, PRESETS_SCHEMA, loadPresets, mergePresets, parsePresetFile, presetFile, presetFromNode, readPreset, savePresets, MAX_PENDING, removePresetChange, savePresetChange, updatePresets, usePresets, viewPresets, type Preset, type Store } from '../src/app/presets.ts';

const mem = (): Store & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

const pay: Preset = { id: 'p1', name: '金流商（200 ms、1% 失敗）', kind: 'service', params: { serviceMs: { mean: 200, cv: 0.5 }, errorRate: 0.01 } };

describe('presets', () => {
  it('a preset keeps the kind and settings of a component, not its place, region or source', () => {
    const node = { id: 'api', kind: 'service', pos: [10, 20], params: { instances: 4 }, source: { from: ['aws_ecs_service.api'] } } as never;
    const p = presetFromNode(node, '  API  ', new Set(['p1']));
    expect(p).toEqual({ id: expect.stringMatching(/^p[0-9a-z]+$/), name: 'API', kind: 'service', params: { instances: 4 } });
    expect(p.id).not.toBe('p1');
    // a copy: changing the component later does not change the preset
    (node as { params: { instances: number } }).params.instances = 9;
    expect(p.params!.instances).toBe(4);
    expect(presetFromNode({ kind: 'cache' }, 'c', new Set())).toMatchObject({ name: 'c', kind: 'cache' });
    // random ids: two tabs do not make the same one (M8 review round 4)
    expect(new Set(Array.from({ length: 200 }, () => presetFromNode({ kind: 'cache' }, 'c', new Set()).id)).size).toBe(200);
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
    const alias = new Map<string, string>();
    const r = mergePresets([pay], [pay, other], MAX_PRESETS, alias);
    expect(r.added).toBe(1);
    expect(r.list[0].id).toBe('p1');
    expect(r.list[1].id).not.toBe('p1');
    expect(alias.get('p1')).toBe(r.list[1].id);
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
    expect(b!.id).toBe(a!.id);
    expect(usePresets.getState().presets.map((p) => [p.name, p.params?.instances])).toEqual([['API', 5], ['Redis', undefined]]);
    // tests run without localStorage: the presets last only in memory
    expect(usePresets.getState().memoryOnly).toBe(true);
    usePresets.getState().remove(a!.id);
    expect(usePresets.getState().presets.map((p) => p.name)).toEqual(['Redis']);
    expect(usePresets.getState().importPresets([pay, pay])).toEqual({ added: 1, full: 0, refused: false });
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
    expect(m).toEqual({ list: [{ id: 'p9', name: 'X', kind: 'cache' }], memoryOnly: true, pending: [], refused: false });
  });

  it('storage that reads but takes no write: changes not saved yet are kept and replayed (M8 review round 2)', () => {
    const data = new Map<string, string>();
    const s: Store = { getItem: (k) => data.get(k) ?? null, setItem: () => { throw new Error('quota'); } };
    data.set(PRESETS_KEY, presetFile([{ id: 'p1', name: 'API', kind: 'service' }]));
    let r = updatePresets(s, loadPresets(s), (l) => [...l, { id: 'p2', name: 'Redis', kind: 'cache' }]);
    expect(r.memoryOnly).toBe(true);
    expect(r.pending).toHaveLength(1);
    r = updatePresets(s, r.list, (l) => [...l, { id: 'p3', name: 'DB', kind: 'database' }], r.pending);
    expect(r.list.map((p) => p.name)).toEqual(['API', 'Redis', 'DB']);
    // a removed preset does not come back with the next change
    r = updatePresets(s, r.list, (l) => l.filter((p) => p.name !== 'API'), r.pending);
    r = updatePresets(s, r.list, (l) => l, r.pending);
    expect(r.list.map((p) => p.name)).toEqual(['Redis', 'DB']);
  });

  it('a tab that could not save, then another tab frees room: what the other tab removed stays removed, what it added stays (M8 review round 3)', () => {
    const data = new Map<string, string>();
    let full = false;
    const s: Store = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { if (full) throw new Error('quota'); data.set(k, v); } };
    savePresets(s, [{ id: 'p1', name: 'API', kind: 'service' }, { id: 'p2', name: 'Redis', kind: 'cache' }]);
    // tab A: storage is full, its new preset is not saved
    full = true;
    const a = updatePresets(s, loadPresets(s), (l) => [...l, { id: 'p3', name: 'DB', kind: 'database' }]);
    expect(a.memoryOnly).toBe(true);
    // tab B frees room: removes Redis, adds a cache preset
    full = false;
    let b = updatePresets(s, loadPresets(s), (l) => l.filter((p) => p.id !== 'p2'));
    b = updatePresets(s, b.list, (l) => [...l, { id: 'p4', name: 'Memcached', kind: 'cache' }], b.pending);
    // tab A sees B's change, with its own unsaved preset on top
    expect(viewPresets(s, a.list, a.pending).map((p) => p.name)).toEqual(['API', 'Memcached', 'DB']);
    // tab A removes API; the write works now
    const a2 = updatePresets(s, a.list, (l) => l.filter((p) => p.id !== 'p1'), a.pending);
    expect(a2).toMatchObject({ memoryOnly: false, pending: [] });
    expect(loadPresets(s).map((p) => p.name)).toEqual(['Memcached', 'DB']);
  });

  it('too many changes waiting for storage: the next one is refused, and the list stays as it was', () => {
    const s: Store = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    let r = updatePresets(s, [], (l) => [...l, { id: 'p0', name: 'n0', kind: 'service' }]);
    for (let i = 1; i < MAX_PENDING; i++) r = updatePresets(s, r.list, (l) => [...l, { id: `p${i}`, name: `n${i}`, kind: 'service' }].slice(-MAX_PRESETS), r.pending);
    expect(r.pending).toHaveLength(MAX_PENDING);
    const before = r.list;
    r = updatePresets(s, r.list, () => [], r.pending);
    expect(r).toMatchObject({ refused: true, memoryOnly: true });
    expect(r.list).toEqual(before);
    expect(r.pending).toHaveLength(MAX_PENDING);
  });

  it('a change waiting for storage keeps pointing at its own preset when another tab took its id (M8 review round 4)', () => {
    const data = new Map<string, string>();
    let full = false;
    const s: Store = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { if (full) throw new Error('quota'); data.set(k, v); } };
    savePresets(s, [{ id: 'p1', name: 'API', kind: 'service' }]);
    // tab A cannot save: it saves Redis as p2, then removes p2
    full = true;
    let a = updatePresets(s, loadPresets(s), savePresetChange({ id: 'p2', name: 'Redis', kind: 'cache' }));
    a = updatePresets(s, a.list, removePresetChange('p2'), a.pending);
    expect(a.pending).toHaveLength(2);
    // tab B saves DB, also as p2
    full = false;
    updatePresets(s, loadPresets(s), savePresetChange({ id: 'p2', name: 'DB', kind: 'database' }));
    // replayed, Redis gets another id and the removal follows it: DB stays, Redis does not come back
    expect(viewPresets(s, a.list, a.pending).map((p) => p.name)).toEqual(['API', 'DB']);
    const a2 = updatePresets(s, a.list, (l) => l, a.pending);
    expect(a2.pending).toEqual([]);
    expect(loadPresets(s).map((p) => p.name)).toEqual(['API', 'DB']);
  });

  it('another tab cleared the presets: the list is empty with this tab\'s unsaved changes on top, and is not written back (M8 review round 4)', () => {
    const data = new Map<string, string>();
    let full = false;
    const s: Store = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { if (full) throw new Error('quota'); data.set(k, v); } };
    savePresets(s, [{ id: 'p1', name: 'API', kind: 'service' }, { id: 'p2', name: 'Redis', kind: 'cache' }]);
    full = true;
    const a = updatePresets(s, loadPresets(s), savePresetChange({ id: 'p3', name: 'DB', kind: 'database' }));
    data.delete(PRESETS_KEY);
    expect(viewPresets(s, a.list, a.pending).map((p) => p.name)).toEqual(['DB']);
    full = false;
    updatePresets(s, a.list, (l) => l, a.pending);
    expect(loadPresets(s).map((p) => p.name)).toEqual(['DB']);
  });

  it('the store: a save refused because too many changes wait returns nothing, so the inspector does not say it was saved (M8 review round 4)', () => {
    const g = globalThis as { localStorage?: Store };
    const data = new Map<string, string>();
    g.localStorage = { getItem: (k) => data.get(k) ?? null, setItem: () => { throw new Error('quota'); } };
    try {
      for (let i = 0; i < MAX_PENDING; i++) expect(usePresets.getState().save({ kind: 'service' }, `n${i}`)).not.toBeNull();
      expect(usePresets.getState().save({ kind: 'service' }, 'one more')).toBeNull();
      expect(usePresets.getState().refused).toBe(true);
      expect(usePresets.getState().presets.some((p) => p.name === 'one more')).toBe(false);
      expect(usePresets.getState().importPresets([{ id: 'x', name: 'x', kind: 'cache' }])).toMatchObject({ added: 0, refused: true });
    } finally {
      delete g.localStorage;
    }
  });
});
