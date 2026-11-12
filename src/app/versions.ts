// Version history (roadmap-next M1, Q3–Q5): every finished run leaves a version — the design, the
// scenario and a summary of the result. The same design, scenario and seed give the same result,
// so the per-second data is not kept: the compare view runs a version again to draw its charts.
//
// Kept in this browser (localStorage) and exported to a file. At most MAX_VERSIONS versions that
// are not pinned; a new run pushes out the oldest of those. Pinned versions are never pushed out.
//
// Pure functions: no React. Storage goes through a `Store` argument so tests can pass a fake one.
import { FAIL_REASONS, type FailReason, type SimResult, type WindowStat } from '../engine/index.ts';
import { DesignSchema, ScenarioSchema, type Design, type Scenario } from '../schema/design.ts';
import { costOf } from '../learn/cost.ts';
import { complexity } from '../learn/constraints.ts';

export const VERSIONS_SCHEMA = 'loadsketch/versions@1';
export const VERSIONS_KEY = 'loadsketch-versions';
/** Versions that are not pinned: the newest this many are kept. */
export const MAX_VERSIONS = 20;

/** What a version shows without running again. */
export interface VersionSummary {
  offered: number;
  ok: number;
  errorRate: number;
  throughputRps: number;
  p50: number;
  p99: number;
  /** Failures by reason; only the reasons that happened. */
  fail: Partial<Record<FailReason, number>>;
  degraded?: number;
  costPerMonth: number;
  complexity: number;
  bottleneck: { node: string; label: string; why: string } | null;
  /** Simulated at 1/scale (absent: full size). */
  scale?: number;
}

export interface Version {
  id: string;
  /** When the run finished, ms since 1970. */
  at: number;
  name: string;
  pinned: boolean;
  design: Design;
  scenario: Scenario;
  summary: VersionSummary;
}

export interface VersionFile {
  schema: typeof VERSIONS_SCHEMA;
  versions: Version[];
}

/** The summary of a finished run. */
export function summarize(design: Design, result: SimResult, windows: WindowStat[]): VersionSummary {
  const s = result.summary;
  const fail: Partial<Record<FailReason, number>> = {};
  for (const k of FAIL_REASONS) if (s.fail[k]) fail[k] = s.fail[k];
  const out: VersionSummary = {
    offered: s.offered,
    ok: s.ok,
    errorRate: s.errorRate,
    throughputRps: s.throughputRps,
    p50: s.latencyMs.p50,
    p99: s.latencyMs.p99,
    fail,
    costPerMonth: costOf(design, { result, windows }).perMonth,
    complexity: complexity(design).total,
    bottleneck: result.bottleneck ? { node: result.bottleneck.node, label: result.bottleneck.label, why: result.bottleneck.why } : null,
  };
  if (s.degraded) out.degraded = s.degraded;
  if (result.scale && result.scale > 1) out.scale = result.scale;
  return out;
}

/** Same design and same scenario: the run gives the same result. */
export function sameRun(a: Pick<Version, 'design' | 'scenario'>, b: Pick<Version, 'design' | 'scenario'>): boolean {
  return JSON.stringify(a.design) === JSON.stringify(b.design) && JSON.stringify(a.scenario) === JSON.stringify(b.scenario);
}

/** An id that is not in `taken`. */
export function newId(at: number, taken: Set<string>): string {
  let i = 0;
  let id = `v${at.toString(36)}`;
  while (taken.has(id)) id = `v${at.toString(36)}-${++i}`;
  return id;
}

/**
 * Adds a version at the top (newest first). A version of the same run already in the list moves to
 * the top with the new time, and keeps its name and pin. Then the oldest unpinned versions beyond
 * MAX_VERSIONS go.
 */
export function addVersion(list: Version[], v: Omit<Version, 'id'> & { id?: string }, max = MAX_VERSIONS): Version[] {
  const same = list.find((x) => sameRun(x, v));
  const { id, ...rest } = v;
  const added: Version = same
    ? { ...same, at: v.at, summary: v.summary }
    : { id: id ?? newId(v.at, new Set(list.map((x) => x.id))), ...rest };
  return trim([added, ...list.filter((x) => x !== same)], max);
}

/** Keeps every pinned version and the newest `max` unpinned ones, in order. */
export function trim(list: Version[], max = MAX_VERSIONS): Version[] {
  let free = max;
  return list.filter((v) => v.pinned || free-- > 0);
}

export function renameVersion(list: Version[], id: string, name: string): Version[] {
  return list.map((v) => (v.id === id ? { ...v, name } : v));
}

/** Unpinning can push the oldest unpinned versions out (the list keeps MAX_VERSIONS unpinned). */
export function pinVersion(list: Version[], id: string, pinned: boolean, max = MAX_VERSIONS): Version[] {
  return trim(list.map((v) => (v.id === id ? { ...v, pinned } : v)), max);
}

export function removeVersion(list: Version[], id: string): Version[] {
  return list.filter((v) => v.id !== id);
}

// ---------------------------------------------------------------------------------------------
// File and storage

export function versionFile(list: Version[]): string {
  const f: VersionFile = { schema: VERSIONS_SCHEMA, versions: list };
  return JSON.stringify(f, null, 1);
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** One version from a file, or null when its shape is wrong. The design and scenario are checked with the schema. */
function readVersion(x: unknown): Version | null {
  if (!x || typeof x !== 'object') return null;
  const v = x as Record<string, unknown>;
  if (typeof v.id !== 'string' || !isNum(v.at) || typeof v.name !== 'string') return null;
  if (!DesignSchema.safeParse(v.design).success || !ScenarioSchema.safeParse(v.scenario).success) return null;
  const s = v.summary as Record<string, unknown> | null;
  if (!s || typeof s !== 'object') return null;
  for (const k of ['offered', 'ok', 'errorRate', 'throughputRps', 'p50', 'p99', 'costPerMonth', 'complexity']) if (!isNum(s[k])) return null;
  const b = s.bottleneck as Record<string, unknown> | null | undefined;
  if (b != null && (typeof b !== 'object' || typeof b.node !== 'string' || typeof b.label !== 'string' || typeof b.why !== 'string')) return null;
  return {
    id: v.id,
    at: v.at,
    name: v.name,
    pinned: v.pinned === true,
    design: v.design as Design,
    scenario: v.scenario as Scenario,
    summary: { ...(s as unknown as VersionSummary), fail: (s.fail && typeof s.fail === 'object' ? s.fail : {}) as VersionSummary['fail'], bottleneck: (b ?? null) as VersionSummary['bottleneck'] },
  };
}

/**
 * The versions in a file. Versions with a wrong shape are skipped and counted, so that one damaged
 * version does not lose the others.
 */
export function parseVersionFile(text: string): { ok: true; versions: Version[]; skipped: number } | { ok: false } {
  let f: unknown;
  try {
    f = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  const o = f as { schema?: unknown; versions?: unknown } | null;
  if (!o || o.schema !== VERSIONS_SCHEMA || !Array.isArray(o.versions)) return { ok: false };
  const versions = o.versions.map(readVersion).filter((v): v is Version => v !== null);
  return { ok: true, versions, skipped: o.versions.length - versions.length };
}

/**
 * Imported versions join the list: a version of a run already in the list is skipped, ids that are
 * taken get a new one. Pinned versions stay pinned; the unpinned limit applies.
 */
export function mergeVersions(list: Version[], add: Version[], max = MAX_VERSIONS): Version[] {
  const out = [...list];
  const ids = new Set(out.map((v) => v.id));
  for (const v of add) {
    if (out.some((x) => sameRun(x, v))) continue;
    const id = ids.has(v.id) ? newId(v.at, ids) : v.id;
    ids.add(id);
    out.push({ ...v, id });
  }
  out.sort((a, b) => b.at - a.at);
  return trim(out, max);
}

export interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadVersions(store: Store | undefined): Version[] {
  try {
    const text = store?.getItem(VERSIONS_KEY);
    if (!text) return [];
    const r = parseVersionFile(text);
    return r.ok ? r.versions : [];
  } catch {
    return [];
  }
}

/**
 * Saves the list. Full storage: the oldest unpinned versions are left out until it fits, and
 * `dropped` counts them. `saved` is null when even the pinned versions alone do not fit: nothing was
 * saved. Without storage (`store` undefined) the list lives in memory only.
 */
export function saveVersions(store: Store | undefined, list: Version[]): { saved: Version[] | null; dropped: number } {
  if (!store) return { saved: list, dropped: 0 };
  let keep = list;
  for (;;) {
    try {
      store.setItem(VERSIONS_KEY, versionFile(keep));
      return { saved: keep, dropped: list.length - keep.length };
    } catch {
      const i = keep.map((v) => v.pinned).lastIndexOf(false);
      if (i < 0) return { saved: null, dropped: 0 };
      keep = keep.filter((_, j) => j !== i);
    }
  }
}

/**
 * Changes the list the way another tab may have left it: reads the newest list from storage, applies
 * `change` to it and saves the result. Two tabs then do not overwrite each other's versions. Without
 * a list in storage (blocked storage, nothing saved yet), `change` applies to the list in memory.
 *
 * The list returned is always the list saved, so memory and storage never differ: versions full
 * storage leaves out are gone (`dropped`), and a change that does not fit at all is not made
 * (`refused`; the list stays as it was). Without storage, or with a storage that takes no write at
 * all (blocked), the list lives in memory only (`memoryOnly`): it is gone when the page closes.
 *
 * `unsaved`: the last change lived in memory only, so memory holds changes storage does not have.
 * The change then applies to the list in memory; the older list in storage would undo them
 * (M8 review round 2).
 */
export function updateVersions(store: Store | undefined, memory: Version[], change: (list: Version[]) => Version[], unsaved = false): { list: Version[]; dropped: number; refused: boolean; memoryOnly: boolean } {
  let base = memory;
  if (!unsaved) try {
    const text = store?.getItem(VERSIONS_KEY);
    const r = text ? parseVersionFile(text) : null;
    if (r?.ok) base = r.versions;
  } catch {
    // unreadable storage: the list in memory
  }
  const next = change(base);
  const r = saveVersions(store, next);
  if (r.saved) return { list: r.saved, dropped: r.dropped, refused: false, memoryOnly: !store };
  // the list as it was does not save either: the storage takes nothing (blocked), so the list lives in memory
  try {
    store!.setItem(VERSIONS_KEY, versionFile(base));
  } catch {
    return { list: next, dropped: 0, refused: false, memoryOnly: true };
  }
  return { list: base, dropped: 0, refused: true, memoryOnly: false };
}
