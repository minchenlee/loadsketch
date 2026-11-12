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
  save: (node: Pick<DesignNode, 'kind' | 'params'>, name: string) => Preset;
  remove: (id: string) => void;
  /** Adds the presets of a file; returns how many were added and how many did not fit. */
  importPresets: (add: Preset[]) => { added: number; full: number };
}

export const usePresets = create<PresetState>((set, get) => {
  const write = (presets: Preset[]) => set({ presets, memoryOnly: !savePresets(browserStore(), presets) });
  return {
    presets: loadPresets(browserStore()),
    memoryOnly: false,
    save: (node, name) => {
      const p = presetFromNode(node, name, new Set(get().presets.map((x) => x.id)));
      // the same name and kind again: the new settings replace the old ones, in its place
      const at = get().presets.findIndex((x) => x.name === p.name && x.kind === p.kind);
      const list = [...get().presets];
      if (at >= 0) list[at] = { ...p, id: list[at].id };
      else list.push(p);
      write(list.slice(-MAX_PRESETS));
      return at >= 0 ? list[at] : p;
    },
    remove: (id) => write(get().presets.filter((p) => p.id !== id)),
    importPresets: (add) => {
      const r = mergePresets(get().presets, add);
      write(r.list);
      return { added: r.added, full: r.full };
    },
  };
});
