// The compare view runs less (roadmap-next M14): curves of runs this tab finished are kept in memory
// (at most 8, by version id, only for the same run) and used instead of a run again.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/engine/index.ts';
import type { Design, Scenario } from '../src/schema/design.ts';
import { seriesOf, seriesUpTo, type CompareItem, type RunSeries } from '../src/app/compare.ts';
import { Curves, MAX_CURVES, keptRuns } from '../src/app/curves.ts';
import { VERSIONS_KEY, parseVersionFile, summarize, updateVersions, versionChanges, versionFile, type Store, type Version } from '../src/app/versions.ts';

const root = join(import.meta.dirname, '..', 'examples');
const design = (n: string) => JSON.parse(readFileSync(join(root, 'designs', `${n}.json`), 'utf8')) as Design;
const scenario = (n: string) => JSON.parse(readFileSync(join(root, 'scenarios', `${n}.json`), 'utf8')) as Scenario;

const summary = { offered: 1, ok: 1, errorRate: 0, throughputRps: 1, p50: 1, p99: 2, fail: {}, costPerMonth: 0, complexity: 0, bottleneck: null };
const fake = (i: number, extra: Partial<Version> = {}): Version => ({
  id: `v${i}`,
  at: 1000 + i,
  name: `run ${i}`,
  pinned: false,
  design: { schema: 'loadsketch/design@1', name: `d${i}`, nodes: [], edges: [] } as Design,
  scenario: { schema: 'loadsketch/scenario@1', name: 's', traffic: { rps: 10 } } as Scenario,
  summary,
  ...extra,
});
const line = (i: number): RunSeries => ({ t: [1], failShare: [i / 100], p99: [i] });
const item = (v: Version): CompareItem => ({ key: v.id, name: v.name, at: v.at, design: v.design, scenario: v.scenario, summary: v.summary });
const memStore = (): Store => {
  const mem = new Map<string, string>();
  return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) };
};

describe('kept curves', () => {
  it('a version with a kept curve is not run again; the others are', () => {
    const c = new Curves();
    const [a, b, d] = [fake(1), fake(2), fake(3)];
    c.put(a.id, a, line(1));
    c.put(d.id, d, line(3));
    const kept = keptRuns([item(a), item(b), item(d)], c);
    expect(kept).toEqual([{ summary, series: line(1) }, undefined, { summary, series: line(3) }]);
    // an item without a saved summary (an example, a shared link) needs the run for its numbers
    expect(keptRuns([{ ...item(a), summary: undefined }], c)).toEqual([undefined]);
  });

  it('a curve is used only for the run that made it: another design or scenario under that id runs again', () => {
    const c = new Curves();
    const a = fake(1);
    c.put(a.id, a, line(1));
    expect(c.get(a.id, a)).toEqual(line(1));
    expect(c.get(a.id, { ...a, design: { ...a.design, name: 'other' } })).toBeUndefined();
    expect(c.get(a.id, { ...a, scenario: { ...a.scenario, seed: 2 } })).toBeUndefined();
    expect(c.get('v9', a)).toBeUndefined();
  });

  it(`keeps at most ${MAX_CURVES} curves: a new one drops the oldest; the same run again does not take two places`, () => {
    const c = new Curves();
    const vs = Array.from({ length: MAX_CURVES + 2 }, (_, i) => fake(i));
    for (const v of vs) c.put(v.id, v, line(0));
    expect(MAX_CURVES).toBe(8);
    expect(c.ids()).toEqual(vs.slice(2).reverse().map((v) => v.id));
    expect(c.get(vs[0].id, vs[0])).toBeUndefined();
    expect(c.get(vs[1].id, vs[1])).toBeUndefined();
    // the same run under the id its version has now: one curve, the newest
    c.put('v4b', vs[4], line(4));
    expect(c.ids()).toHaveLength(MAX_CURVES);
    expect(c.ids()[0]).toBe('v4b');
    expect(c.ids()).not.toContain('v4');
  });

  it('a removed version takes its curve with it', () => {
    const c = new Curves();
    const store = memStore();
    let list: Version[] = [];
    for (const v of [fake(1), fake(2)]) {
      list = updateVersions(store, list, versionChanges.add(v)).list;
      c.put(v.id, v, line(Number(v.id.slice(1))));
    }
    list = updateVersions(store, list, versionChanges.remove('v1')).list;
    c.follow(list);
    expect(c.ids()).toEqual(['v2']);
    expect(keptRuns(list.map(item), c)).toEqual([{ summary, series: line(2) }]);
    // a removed version that comes back (imported) has no curve: it runs again
    list = updateVersions(store, list, versionChanges.merge([fake(1)])).list;
    c.follow(list);
    expect(c.get('v1', fake(1))).toBeUndefined();
  });

  it('a curve follows its run when the version gets another id (same run kept once, a replayed id)', () => {
    const c = new Curves();
    const store = memStore();
    const first = fake(1);
    let list = updateVersions(store, [], versionChanges.add(first)).list;
    c.put('v1', first, line(1));
    // the same run again under a new id: the list keeps one version with the first id
    list = updateVersions(store, list, versionChanges.add({ ...fake(1), id: 'v7', at: 2000 })).list;
    expect(list.map((v) => v.id)).toEqual(['v1']);
    c.follow(list);
    expect(c.get('v1', list[0])).toEqual(line(1));
    // another id for the same run (a replay that found the id taken): the curve goes with it
    c.follow([{ ...list[0], id: 'v1-1' }]);
    expect(c.ids()).toEqual(['v1-1']);
    expect(c.get('v1-1', list[0])).toEqual(line(1));
  });

  it('a version read back from storage still matches the curve of its run', () => {
    const d = design('three-tier');
    const sc = { ...scenario('spike'), durationS: 5, warmupS: 0 };
    const v = fake(1, { design: d, scenario: sc });
    const back = parseVersionFile(versionFile([v]));
    expect(back.ok).toBe(true);
    const c = new Curves();
    c.put(v.id, { design: d, scenario: sc }, line(1));
    const r = back as { ok: true; versions: Version[] };
    expect(c.get(v.id, r.versions[0])).toEqual(line(1));
    const store = memStore();
    store.setItem(VERSIONS_KEY, versionFile([v]));
    expect(keptRuns(updateVersions(store, [], versionChanges.rename('v1', 'x')).list.map(item), c)[0]).toEqual({ summary, series: line(1) });
  });
});

describe('the curve of a run', () => {
  it('kept from the live run (in steps, with traces, up to the end of the traffic) equals the one from a run again', () => {
    const d = design('three-tier');
    const sc = { ...scenario('spike'), durationS: 12, warmupS: 0 };
    // a run again (src/worker/compare.worker.ts)
    const again = new Simulation(d, sc);
    const result = again.runToEnd();
    const all = again.drainWindows();
    // the live run (src/worker/sim.worker.ts): steps, traces, then the rest; the app keeps the
    // windows up to the end of the traffic
    const liveSim = new Simulation(d, sc, { tracesPerSec: 150, maxTraces: 100000 });
    const windows = [];
    for (let t = 0; t < liveSim.durationMs; ) {
      t = Math.min(liveSim.durationMs, t + 137);
      liveSim.runUntil(t);
      windows.push(...liveSim.drainWindows());
    }
    liveSim.runUntil(Infinity);
    windows.push(...liveSim.drainWindows());
    const shown = windows.filter((w) => w.t <= liveSim.durationMs / 1000 + 1e-9);
    // the run again goes on after the traffic stops; the curve stops where the traffic does
    expect(all.length).toBeGreaterThan(shown.length);
    expect(seriesOf(shown)).toEqual(seriesUpTo(all, again.durationMs));
    expect(summarize(d, result, all)).toBeTruthy();
  });
});
