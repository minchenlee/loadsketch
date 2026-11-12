// Component presets (roadmap-next M8, Q21): a component with its settings, saved under a name (for
// example "Payment provider: 200 ms, 1% errors"), offered in the palette next to the kinds. Kept in
// this browser (localStorage) and exported to a file; a file can be imported again.
//
// The storage format has a version (`loadsketch/presets@1`). The data layer is pure; the small store
// at the end keeps the list for the palette and writes it through on every change.
import { create } from 'zustand';
import { NodeSchema, type DesignNode, type ParamValue } from '../schema/design.ts';
import { KINDS } from '../schema/kinds.ts';

export const PRESETS_SCHEMA = 'loadsketch/presets@1';
export const PRESETS_KEY = 'loadsketch-presets';
/** At most this many presets: the palette is a list, not a library. */
export const MAX_PRESETS = 50;
export const MAX_PRESET_NAME = 60;

export interface Preset {
  id: string;
  /** Shown in the palette; a component made from it takes it as its name. */
  name: string;
  kind: string;
  params?: Record<string, ParamValue>;
}

export interface PresetFile {
  schema: typeof PRESETS_SCHEMA;
  presets: Preset[];
}

/**
 * A new id not in `taken`: random, so a preset made in one tab and one made in another tab do not
 * get the same id (M8 review round 4).
 */
export function presetId(taken: Set<string>): string {
  for (;;) {
    const id = `p${Math.random().toString(36).slice(2, 10)}`;
    if (id.length > 4 && !taken.has(id)) return id;
  }
}

/** A preset from a component on the canvas: its kind and settings (not its place, region or source). */
export function presetFromNode(node: Pick<DesignNode, 'kind' | 'params'>, name: string, taken: Set<string>): Preset {
  const p: Preset = { id: presetId(taken), name: name.trim().slice(0, MAX_PRESET_NAME), kind: node.kind };
  if (node.params && Object.keys(node.params).length) p.params = structuredClone(node.params) as Record<string, ParamValue>;
  return p;
}

/** A preset read from storage or a file, or null when it is not one: its kind and settings must be valid now. */
export function readPreset(x: unknown): Preset | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id || typeof o.name !== 'string' || !o.name.trim() || o.name.length > MAX_PRESET_NAME) return null;
  if (typeof o.kind !== 'string' || !KINDS[o.kind]) return null;
  if (o.params !== undefined && (!o.params || typeof o.params !== 'object' || Array.isArray(o.params))) return null;
  // the settings as the format checks them on a component
  if (!NodeSchema.safeParse({ id: 'preset', kind: o.kind, pos: [0, 0], params: o.params }).success) return null;
  const p: Preset = { id: o.id, name: o.name.trim(), kind: o.kind };
  if (o.params && Object.keys(o.params).length) p.params = o.params as Record<string, ParamValue>;
  return p;
}

const sameContent = (a: Preset, b: Preset) => a.name === b.name && a.kind === b.kind && JSON.stringify(a.params ?? {}) === JSON.stringify(b.params ?? {});

/**
 * `add` appended to `list`: a preset already there (same name, kind and settings) is skipped; ids stay
 * unique. `alias` records what an id of `add` became: the preset it is the same as, or a new id.
 */
export function mergePresets(list: Preset[], add: Preset[], max = MAX_PRESETS, alias?: Map<string, string>): { list: Preset[]; added: number; full: number } {
  const out = [...list];
  const taken = new Set(out.map((p) => p.id));
  let added = 0;
  let full = 0;
  for (const p of add) {
    const same = out.find((q) => sameContent(q, p));
    if (same) {
      if (same.id !== p.id) alias?.set(p.id, same.id);
      continue;
    }
    if (out.length >= max) {
      full++;
      continue;
    }
    const id = taken.has(p.id) ? presetId(taken) : p.id;
    if (id !== p.id) alias?.set(p.id, id);
    taken.add(id);
    out.push({ ...p, id });
    added++;
  }
  return { list: out, added, full };
}

export function presetFile(list: Preset[]): string {
  const f: PresetFile = { schema: PRESETS_SCHEMA, presets: list };
  return JSON.stringify(f, null, 2) + '\n';
}

/** A preset file: the presets that are valid, and how many were not. */
export function parsePresetFile(text: string): { ok: true; presets: Preset[]; skipped: number } | { ok: false } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (!v || typeof v !== 'object' || (v as PresetFile).schema !== PRESETS_SCHEMA || !Array.isArray((v as PresetFile).presets)) return { ok: false };
  const all = (v as PresetFile).presets;
  const presets = all.map(readPreset).filter((p): p is Preset => !!p);
  return { ok: true, presets, skipped: all.length - presets.length };
}

/** Where presets are kept: localStorage, or a fake one in tests. */
export interface Store {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export function loadPresets(store: Store | undefined): Preset[] {
  try {
    const text = store?.getItem(PRESETS_KEY);
    if (!text) return [];
    const r = parsePresetFile(text);
    return r.ok ? r.presets.slice(0, MAX_PRESETS) : [];
  } catch {
    return [];
  }
}

/** Saves the list; false when the browser keeps nothing (blocked or full storage). */
export function savePresets(store: Store | undefined, list: Preset[]): boolean {
  try {
    if (!store) return false;
    store.setItem(PRESETS_KEY, presetFile(list));
    return true;
  } catch {
    return false;
  }
}

/**
 * A change to the list. It may be replayed on a newer list from storage (see `updatePresets`), so its
 * ids are fixed when it is made. On a replay an id can turn into another one (the same preset is
 * there already, or another tab took the id): the change records that in `alias`, and later changes
 * find their preset through it (M8 review round 4).
 */
export type PresetChange = (list: Preset[], alias: Map<string, string>) => Preset[];
/** At most this many changes wait for storage to take a write; more are refused. */
export const MAX_PENDING = 50;

/** The id a change made as `id` has now. */
export const resolveId = (alias: Map<string, string>, id: string) => alias.get(id) ?? id;

/** Saves `p` under its name and kind: a preset with both already there takes its settings, in place. */
export const savePresetChange = (p: Preset): PresetChange => (list, alias) => {
  const at = list.findIndex((x) => x.name === p.name && x.kind === p.kind);
  const out = [...list];
  if (at >= 0) {
    if (out[at].id !== p.id) alias.set(p.id, out[at].id);
    out[at] = { ...p, id: out[at].id };
    return out;
  }
  const taken = new Set(list.map((x) => x.id));
  const id = taken.has(p.id) ? presetId(taken) : p.id;
  if (id !== p.id) alias.set(p.id, id);
  return [...out, { ...p, id }].slice(-MAX_PRESETS);
};

export const removePresetChange = (id: string): PresetChange => (list, alias) => list.filter((p) => p.id !== resolveId(alias, id));

/**
 * The list in storage now: an empty list when storage has none (another tab may have cleared it), or
 * null when storage cannot be read.
 */
function stored(store: Store | undefined): Preset[] | null {
  if (!store) return null;
  try {
    const text = store.getItem(PRESETS_KEY);
    if (text === null) return [];
    const r = parsePresetFile(text);
    return r.ok ? r.presets.slice(0, MAX_PRESETS) : null;
  } catch {
    return null;
  }
}

const replay = (list: Preset[], changes: PresetChange[], alias = new Map<string, string>()) => changes.reduce((l, c) => c(l, alias), list);

/**
 * The list to show: the list in storage now, with this tab's changes not saved yet on top. Without a
 * readable storage, the list in memory (it has those changes already).
 */
export function viewPresets(store: Store | undefined, memory: Preset[], pending: PresetChange[]): Preset[] {
  const latest = stored(store);
  return latest ? replay(latest, pending) : memory;
}

/**
 * Changes the list as it is in storage now: another tab may have changed it since this one read it
 * (M8 review P2). Changes that could not be saved (full or blocked storage) wait in `pending` and are
 * replayed on the newest list each time, so neither this tab's unsaved changes nor another tab's
 * saved ones are lost (M8 review rounds 2–4). A save that works empties `pending`.
 * `refused`: too many changes wait already; this one is not made and the list stays as it was.
 */
export function updatePresets(store: Store | undefined, memory: Preset[], change: PresetChange, pending: PresetChange[] = []): { list: Preset[]; memoryOnly: boolean; pending: PresetChange[]; refused: boolean } {
  const latest = stored(store);
  const alias = new Map<string, string>();
  const base = latest ? replay(latest, pending, alias) : memory;
  const list = change(base, alias);
  if (savePresets(store, list)) return { list, memoryOnly: false, pending: [], refused: false };
  if (!store) return { list, memoryOnly: true, pending: [], refused: false };
  if (pending.length >= MAX_PENDING) return { list: base, memoryOnly: true, pending, refused: true };
  return { list, memoryOnly: true, pending: [...pending, change], refused: false };
}

const browserStore = (): Store | undefined => {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
};

interface PresetState {
  presets: Preset[];
  /** The browser keeps nothing: the presets last until the tab closes. */
  memoryOnly: boolean;
  /** The last change was not made: too many changes wait for storage already. */
  refused: boolean;
  /** The preset saved, or null when the change was refused (see `refused`). */
  save: (node: Pick<DesignNode, 'kind' | 'params'>, name: string) => Preset | null;
  remove: (id: string) => void;
  /** Adds the presets of a file; returns how many were added and how many did not fit. */
  importPresets: (add: Preset[]) => { added: number; full: number; refused: boolean };
}

export const usePresets = create<PresetState>((set, get) => {
  /** Changes not saved yet (full or blocked storage), replayed on the newest list each time. */
  let pending: PresetChange[] = [];
  const write = (change: PresetChange) => {
    const r = updatePresets(browserStore(), get().presets, change, pending);
    pending = r.pending;
    set({ presets: r.list, memoryOnly: r.memoryOnly, refused: r.refused });
    return r;
  };
  // another tab changed the presets: its list, with this tab's unsaved changes on top
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (e.key === PRESETS_KEY || e.key === null) set({ presets: viewPresets(browserStore(), get().presets, pending) });
    });
  }
  return {
    presets: loadPresets(browserStore()),
    memoryOnly: false,
    refused: false,
    save: (node, name) => {
      // the id is fixed now, so changes made later find this preset after a replay
      const p = presetFromNode(node, name, new Set(get().presets.map((x) => x.id)));
      const same = get().presets.find((x) => x.name === p.name && x.kind === p.kind);
      if (same) p.id = same.id;
      const r = write(savePresetChange(p));
      return r.refused ? null : (r.list.find((x) => x.name === p.name && x.kind === p.kind) ?? p);
    },
    remove: (id) => void write(removePresetChange(id)),
    importPresets: (add) => {
      // the ids are fixed now too: taken ones get a new id here, not on a replay
      const taken = new Set(get().presets.map((x) => x.id));
      const fixed = add.map((p) => {
        const id = taken.has(p.id) ? presetId(taken) : p.id;
        taken.add(id);
        return { ...p, id };
      });
      // what this change did the first time it ran (a replay later counts again; that is not shown)
      let done = { added: 0, full: 0 };
      const r = write((list, alias) => {
        const m = mergePresets(list, fixed, MAX_PRESETS, alias);
        done = { added: m.added, full: m.full };
        return m.list;
      });
      return r.refused ? { added: 0, full: 0, refused: true } : { ...done, refused: false };
    },
  };
});
