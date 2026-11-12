// Version history (roadmap-next M1): every finished run leaves a version.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/engine/index.ts';
import type { Design, Scenario } from '../src/schema/design.ts';
import {
  MAX_VERSIONS,
  VERSIONS_KEY,
  VERSIONS_SCHEMA,
  addVersion,
  loadVersions,
  mergeVersions,
  parseVersionFile,
  pinVersion,
  removeVersion,
  renameVersion,
  saveVersions,
  summarize,
  versionFile,
  updateVersions,
  type Store,
  type Version,
} from '../src/app/versions.ts';

const root = join(import.meta.dirname, '..', 'examples');
const design = (n: string) => JSON.parse(readFileSync(join(root, 'designs', `${n}.json`), 'utf8')) as Design;
const scenario = (n: string) => JSON.parse(readFileSync(join(root, 'scenarios', `${n}.json`), 'utf8')) as Scenario;
const short = (sc: Scenario): Scenario => ({ ...sc, durationS: 10, warmupS: 0 });

function runOf(d: Design, sc: Scenario) {
  const sim = new Simulation(d, sc);
  const result = sim.runToEnd();
  return { result, windows: sim.drainWindows() };
}

function version(d: Design, sc: Scenario, at: number, extra: Partial<Version> = {}): Omit<Version, 'id'> & { id?: string } {
  const { result, windows } = runOf(d, sc);
  return { at, name: d.name, pinned: false, design: d, scenario: sc, summary: summarize(d, result, windows), ...extra };
}

/** A fake version without running: only the list logic is tested. */
const fake = (i: number, extra: Partial<Version> = {}): Version => ({
  id: `v${i}`,
  at: 1000 + i,
  name: `run ${i}`,
  pinned: false,
  design: { schema: 'loadsketch/design@1', name: `d${i}`, nodes: [], edges: [] } as Design,
  scenario: { schema: 'loadsketch/scenario@1', name: 's', traffic: { rps: 10 } } as Scenario,
  summary: { offered: 1, ok: 1, errorRate: 0, throughputRps: 1, p50: 1, p99: 2, fail: {}, costPerMonth: 0, complexity: 0, bottleneck: null },
  ...extra,
});

describe('version summary', () => {
  it('keeps the numbers the compare view shows, and the same run gives the same summary', () => {
    const d = design('three-tier');
    const sc = short(scenario('spike'));
    const a = version(d, sc, 1);
    const b = version(d, sc, 2);
    expect(a.summary).toEqual(b.summary);
    expect(a.summary.offered).toBeGreaterThan(0);
    expect(a.summary.p99).toBeGreaterThanOrEqual(a.summary.p50);
    expect(a.summary.costPerMonth).toBeGreaterThan(0);
    expect(a.summary.complexity).toBeGreaterThan(0);
    // only the reasons that happened
    for (const n of Object.values(a.summary.fail)) expect(n).toBeGreaterThan(0);
  });

  it('a different seed is a different run', () => {
    const d = design('three-tier');
    const a = version(d, short(scenario('spike')), 1);
    const b = version(d, { ...short(scenario('spike')), seed: 99 }, 2);
    expect(addVersion([{ ...a, id: 'a' }], b)).toHaveLength(2);
  });
});

describe('version list', () => {
  it('adds new versions at the top', () => {
    const list = addVersion(addVersion([], fake(1)), fake(2));
    expect(list.map((v) => v.name)).toEqual(['run 2', 'run 1']);
    expect(new Set(list.map((v) => v.id)).size).toBe(2);
  });

  it('running the same design and scenario again moves that version to the top, keeping its name and pin', () => {
    let list = addVersion([], fake(1));
    list = addVersion(list, fake(2));
    list = renameVersion(list, list[1].id, 'my baseline');
    list = pinVersion(list, list[1].id, true);
    list = addVersion(list, { ...fake(1), id: undefined, at: 5000, name: 'other' });
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ name: 'my baseline', pinned: true, at: 5000 });
  });

  it(`keeps at most ${MAX_VERSIONS} unpinned versions; pinned ones are never pushed out`, () => {
    let list: Version[] = [];
    list = addVersion(list, fake(0));
    list = pinVersion(list, list[0].id, true);
    for (let i = 1; i <= MAX_VERSIONS + 5; i++) list = addVersion(list, fake(i));
    expect(list.filter((v) => !v.pinned)).toHaveLength(MAX_VERSIONS);
    expect(list.some((v) => v.name === 'run 0')).toBe(true);
    // the oldest unpinned ones went
    expect(list.some((v) => v.name === 'run 5')).toBe(false);
    expect(list.some((v) => v.name === 'run 6')).toBe(true);
    expect(list[0].name).toBe(`run ${MAX_VERSIONS + 5}`);
  });

  it('rename, pin, unpin and delete', () => {
    let list = [fake(1), fake(2)];
    list = renameVersion(list, 'v1', 'baseline');
    expect(list[0].name).toBe('baseline');
    list = pinVersion(list, 'v2', true);
    expect(list[1].pinned).toBe(true);
    list = pinVersion(list, 'v2', false);
    expect(list[1].pinned).toBe(false);
    list = removeVersion(list, 'v1');
    expect(list.map((v) => v.id)).toEqual(['v2']);
  });

  it('unpinning past the limit pushes out the oldest unpinned version', () => {
    let list = Array.from({ length: 3 }, (_, i) => fake(i, { pinned: true }));
    list = pinVersion(list, 'v0', false, 2);
    list = pinVersion(list, 'v1', false, 2);
    list = pinVersion(list, 'v2', false, 2);
    expect(list.map((v) => v.id)).toEqual(['v0', 'v1']);
  });
});

describe('version file and storage', () => {
  it('a file round-trips, and a run version survives byte for byte', () => {
    const d = design('three-tier');
    const list = addVersion([], version(d, short(scenario('steady')), 1));
    const text = versionFile(list);
    expect(JSON.parse(text).schema).toBe(VERSIONS_SCHEMA);
    const back = parseVersionFile(text);
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.skipped).toBe(0);
      expect(JSON.stringify(back.versions)).toBe(JSON.stringify(list));
    }
  });

  it('a wrong file is refused; a damaged version is skipped, the others kept', () => {
    expect(parseVersionFile('not json').ok).toBe(false);
    expect(parseVersionFile('{"schema":"other","versions":[]}').ok).toBe(false);
    const good = fake(1);
    const bad = { ...fake(2), design: { nodes: 'x' } };
    const r = parseVersionFile(JSON.stringify({ schema: VERSIONS_SCHEMA, versions: [good, bad, 42] }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.versions.map((v) => v.id)).toEqual(['v1']);
      expect(r.skipped).toBe(2);
    }
  });

  it('importing skips runs already in the list and renames taken ids', () => {
    const list = [fake(1), fake(2)];
    const add = [fake(1), { ...fake(3), id: 'v2' }];
    const out = mergeVersions(list, add);
    expect(out).toHaveLength(3);
    expect(new Set(out.map((v) => v.id)).size).toBe(3);
    // newest first
    expect(out[0].design.name).toBe('d3');
  });

  it('saves to and loads from storage; full storage drops the oldest unpinned versions first', () => {
    const mem = new Map<string, string>();
    const store: Store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) };
    const list = [fake(1), fake(2, { pinned: true }), fake(3)];
    expect(saveVersions(store, list)).toEqual({ saved: list, dropped: 0 });
    expect(loadVersions(store)).toEqual(list);

    // room for two versions only
    const limit = versionFile(list.slice(0, 2)).length;
    const small: Store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => { if (v.length > limit) throw new Error('quota'); mem.set(k, v); } };
    const r = saveVersions(small, list);
    expect(r.dropped).toBe(1);
    expect(r.saved!.map((v) => v.id)).toEqual(['v1', 'v2']);
    expect(JSON.parse(mem.get(VERSIONS_KEY)!).versions).toHaveLength(2);
  });

  it('no storage or broken storage is not an error', () => {
    expect(loadVersions(undefined)).toEqual([]);
    const broken: Store = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(loadVersions(broken)).toEqual([]);
    expect(saveVersions(broken, [fake(1, { pinned: true })]).saved).toBeNull();
  });
});

describe('two tabs', () => {
  const shared = () => {
    const mem = new Map<string, string>();
    return { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) } as Store;
  };

  it('a change in one tab does not undo what the other tab did', () => {
    const store = shared();
    // both tabs open with the same list
    saveVersions(store, [fake(1), fake(2)]);
    let tabA = loadVersions(store);
    let tabB = loadVersions(store);
    // tab A pins v1 and deletes v2
    tabA = updateVersions(store, tabA, (l) => pinVersion(l, 'v1', true)).list;
    tabA = updateVersions(store, tabA, (l) => removeVersion(l, 'v2')).list;
    // tab B still shows its old list, and finishes a run
    tabB = updateVersions(store, tabB, (l) => addVersion(l, fake(3))).list;
    expect(tabB.map((v) => v.id)).toEqual(['v3', 'v1']);
    expect(tabB.find((v) => v.id === 'v1')!.pinned).toBe(true);
    // tab A renames: tab B's run stays
    tabA = updateVersions(store, tabA, (l) => renameVersion(l, 'v1', 'base')).list;
    expect(loadVersions(store).map((v) => [v.id, v.name, v.pinned])).toEqual([
      ['v3', 'run 3', false],
      ['v1', 'base', true],
    ]);
  });

  it('without a list in storage, the change applies to the list in memory', () => {
    const none = updateVersions(undefined, [fake(1)], (l) => addVersion(l, fake(2)));
    expect(none.list.map((v) => v.id)).toEqual(['v2', 'v1']);
    expect(none.memoryOnly).toBe(true);
    const broken: Store = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    const r = updateVersions(broken, [fake(1)], (l) => removeVersion(l, 'v1'));
    expect(r).toEqual({ list: [], dropped: 0, refused: false, memoryOnly: true });
  });
});

describe('storage that reads but takes no write (M8 review round 2)', () => {
  it('a change after a failed write starts from the list in memory, so the unsaved change stays', () => {
    const mem = new Map<string, string>();
    const store: Store = { getItem: (k) => mem.get(k) ?? null, setItem: () => { throw new Error('quota'); } };
    mem.set(VERSIONS_KEY, versionFile([fake(1)]));
    let r = updateVersions(store, loadVersions(store), (l) => addVersion(l, fake(2)));
    expect(r.memoryOnly).toBe(true);
    r = updateVersions(store, r.list, (l) => removeVersion(l, 'v1'), r.memoryOnly);
    expect(r.list.map((v) => v.id)).toEqual(['v2']);
    expect(r.memoryOnly).toBe(true);
  });
});

describe('full storage', () => {
  /** A fake storage that holds at most `room` characters. */
  const quota = (room: number) => {
    const mem = new Map<string, string>();
    const store: Store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => { if (v.length > room) throw new Error('quota'); mem.set(k, v); } };
    return store;
  };

  it('memory and storage stay the same: a version storage leaves out is gone from the list too', () => {
    const store = quota(versionFile([fake(1)]).length + 5); // room for one version
    let list: Version[] = [];
    let r = updateVersions(store, list, (l) => addVersion(l, fake(1)));
    list = r.list;
    r = updateVersions(store, list, (l) => addVersion(l, fake(2)));
    expect(r).toMatchObject({ dropped: 1, refused: false });
    list = r.list;
    expect(list.map((v) => v.id)).toEqual(['v2']);
    expect(loadVersions(store)).toEqual(list);
    // pinning the version that is left keeps it; nothing comes back or goes away unseen
    r = updateVersions(store, list, (l) => pinVersion(l, 'v2', true));
    expect(r.list.map((v) => [v.id, v.pinned])).toEqual([['v2', true]]);
    expect(loadVersions(store)).toEqual(r.list);
  });

  it('when the pinned versions alone fill the storage, a new version is not added and the list stays', () => {
    const store = quota(versionFile([fake(1, { pinned: true })]).length + 5);
    let r = updateVersions(store, [], (l) => addVersion(l, fake(1, { pinned: true })));
    expect(r.refused).toBe(false);
    const before = r.list;
    r = updateVersions(store, before, (l) => addVersion(l, fake(2)));
    // the new unpinned version is the one left out
    expect(r).toMatchObject({ dropped: 1, refused: false });
    expect(r.list).toEqual(before);
    // pinning it too: nothing fits, nothing changes
    r = updateVersions(store, before, (l) => addVersion(l, fake(3, { pinned: true })));
    expect(r).toMatchObject({ refused: true, dropped: 0 });
    expect(r.list).toEqual(before);
    expect(loadVersions(store)).toEqual(before);
  });
});

describe('storage that takes no write', () => {
  it('reads work, every write throws: changes stay in memory and say so', () => {
    const mem = new Map<string, string>([[VERSIONS_KEY, versionFile([fake(1)])]]);
    const readOnly: Store = { getItem: (k) => mem.get(k) ?? null, setItem: () => { throw new Error('denied'); } };
    const r = updateVersions(readOnly, [], (l) => addVersion(l, fake(2)));
    expect(r.list.map((v) => v.id)).toEqual(['v2', 'v1']);
    expect(r).toMatchObject({ memoryOnly: true, refused: false, dropped: 0 });
    // a storage that works is not memory only
    const ok = new Map<string, string>();
    const good: Store = { getItem: (k) => ok.get(k) ?? null, setItem: (k, v) => void ok.set(k, v) };
    expect(updateVersions(good, [], (l) => addVersion(l, fake(1))).memoryOnly).toBe(false);
  });
});
