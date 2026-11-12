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

/** A short id not in `taken`. */
export function presetId(taken: Set<string>): string {
  for (let i = 1; ; i++) {
    const id = `p${i}`;
    if (!taken.has(id)) return id;
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

/** `add` appended to `list`: a preset already there (same name, kind and settings) is skipped; ids stay unique. */
export function mergePresets(list: Preset[], add: Preset[], max = MAX_PRESETS): { list: Preset[]; added: number; full: number } {
  const out = [...list];
  const taken = new Set(out.map((p) => p.id));
  let added = 0;
  let full = 0;
  for (const p of add) {
    if (out.some((q) => sameContent(q, p))) continue;
    if (out.length >= max) {
      full++;
      continue;
    }
    const id = taken.has(p.id) ? presetId(taken) : p.id;
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

/** A change to the list: replayed on a newer list from storage, so it works by id, name and kind. */
export type PresetChange = (list: Preset[]) => Preset[];
/** At most this many changes wait for storage to take a write; more are refused. */
export const MAX_PENDING = 50;

/** The list in storage now, or null when storage has none or cannot be read. */
function stored(store: Store | undefined): Preset[] | null {
  try {
    const text = store?.getItem(PRESETS_KEY);
    if (text === null) return [];
    const r = text ? parsePresetFile(text) : null;
    return r?.ok ? r.presets.slice(0, MAX_PRESETS) : null;
  } catch {
    return null;
  }
}

/**
 * The list to show: the list in storage now, with this tab's changes not saved yet on top. Without a
 * readable list in storage, the list in memory (it has those changes already).
 */
export function viewPresets(store: Store | undefined, memory: Preset[], pending: PresetChange[]): Preset[] {
  const latest = store ? stored(store) : null;
  return latest ? pending.reduce((l, c) => c(l), latest) : memory;
}

/**
 * Changes the list as it is in storage now: another tab may have changed it since this one read it
 * (M8 review P2). Changes that could not be saved (full or blocked storage) wait in `pending` and are
 * replayed on the newest list each time, so neither this tab's unsaved changes nor another tab's
 * saved ones are lost (M8 review rounds 2 and 3). A save that works empties `pending`.
 * `refused`: too many changes wait already; this one is not made.
 */
export function updatePresets(store: Store | undefined, memory: Preset[], change: PresetChange, pending: PresetChange[] = []): { list: Preset[]; memoryOnly: boolean; pending: PresetChange[]; refused: boolean } {
  const latest = store ? stored(store) : null;
  const list = change(latest ? pending.reduce((l, c) => c(l), latest) : memory);
  if (savePresets(store, list)) return { list, memoryOnly: false, pending: [], refused: false };
  if (!store) return { list, memoryOnly: true, pending: [], refused: false };
  if (pending.length >= MAX_PENDING) return { list: viewPresets(store, memory, pending), memoryOnly: true, pending, refused: true };
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
  save: (node: Pick<DesignNode, 'kind' | 'params'>, name: string) => Preset;
  remove: (id: string) => void;
  /** Adds the presets of a file; returns how many were added and how many did not fit. */
  importPresets: (add: Preset[]) => { added: number; full: number };
}

export const usePresets = create<PresetState>((set, get) => {
  /** Changes not saved yet (full or blocked storage), replayed on the newest list each time. */
  let pending: PresetChange[] = [];
  const write = (change: PresetChange) => {
    const r = updatePresets(browserStore(), get().presets, change, pending);
    pending = r.pending;
    set({ presets: r.list, memoryOnly: r.memoryOnly, refused: r.refused });
    return r.list;
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
      let saved!: Preset;
      write((presets) => {
        const p = presetFromNode(node, name, new Set(presets.map((x) => x.id)));
        // the same name and kind again: the new settings replace the old ones, in its place
        const at = presets.findIndex((x) => x.name === p.name && x.kind === p.kind);
        const list = [...presets];
        if (at >= 0) list[at] = saved = { ...p, id: list[at].id };
        else list.push((saved = p));
        return list.slice(-MAX_PRESETS);
      });
      return saved;
    },
    remove: (id) => void write((presets) => presets.filter((p) => p.id !== id)),
    importPresets: (add) => {
      let r!: ReturnType<typeof mergePresets>;
      write((presets) => (r = mergePresets(presets, add)).list);
      return { added: r.added, full: r.full };
    },
  };
});
