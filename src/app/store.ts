import { create } from 'zustand';
import { applyEdgeChanges, applyNodeChanges, type Connection, type EdgeChange, type NodeChange } from '@xyflow/react';
import type { SimResult, TimelineEvent, WindowStat } from '../engine/index.ts';
import { KINDS } from '../schema/kinds.ts';
import {
  DESIGN_SCHEMA,
  SCENARIO_SCHEMA,
  checkDesign,
  edgeId,
  formatJson,
  parseDesign,
  parseScenario,
  type Design,
  type DesignApi,
  type DesignEdge,
  type DesignNode,
  type Issue,
  type ParamValue,
  type Scenario,
} from '../schema/design.ts';
import { freshId, toDesign, toFlow, type SdEdge, type SdNode } from './convert.ts';
import { connect, live, resetLive, send } from './runtime.ts';
import { getLang, pickLang, setLang, t, tx, type Lang } from '../i18n/index.ts';
import { localizeDesign } from '../i18n/content.ts';
import { DEFAULT_SLO, type Slo } from '../learn/sla.ts';
import { GUESS_LOG_KEY, addEntries, entriesForRun, logFile, parseLog, type GuessEntry } from '../learn/guessLog.ts';
import { LESSONS } from '../learn/lessons.ts';
import type { Finding } from '../import/terraform/index.ts';
import { editedSources } from './sources.ts';
import { markNew, planEntrance } from './motion.ts';
import type { CompareItem } from './compare.ts';
import { VERSIONS_KEY, addVersion, loadVersions, mergeVersions, pinVersion, removeVersion, renameVersion, summarize, updateVersions, type Version } from './versions.ts';

/** localStorage, or undefined where it is blocked (private mode in some browsers). */
function storage(): Storage | undefined {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}
/** The simulator inside another page (?embed=1): its looping runs leave no versions. */
const EMBEDDED = new URLSearchParams(location.search).has('embed');

/** ?lang= first, then the saved choice, then the browser language. Set before any text is made. */
function initialLang(): Lang {
  const q = new URLSearchParams(location.search).get('lang');
  if (q) return pickLang(q);
  try {
    const saved = localStorage.getItem('loadsketch-lang');
    if (saved) return pickLang(saved);
  } catch {
    /* private mode */
  }
  return pickLang(navigator.language);
}
function applyLang(l: Lang) {
  setLang(l);
  document.documentElement.lang = l === 'en' ? 'en' : 'zh-Hant';
  document.title = t('loadsketch 系統設計模擬器');
}
applyLang(initialLang());

// Examples ship with the app.
const designFiles = import.meta.glob<Design>('../../examples/designs/*.json', { eager: true, import: 'default' });
const scenarioFiles = import.meta.glob<Scenario>('../../examples/scenarios/*.json', { eager: true, import: 'default' });
const base = (p: string) => p.split('/').pop()!.replace(/\.json$/, '');
const PASSED_KEY = 'loadsketch-passed';

function loadPassed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(PASSED_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function loadGuessLog(): GuessEntry[] {
  try {
    const text = localStorage.getItem(GUESS_LOG_KEY);
    if (!text) return [];
    const r = parseLog(text);
    return r.ok ? r.entries : [];
  } catch {
    return [];
  }
}

function saveGuessLog(entries: GuessEntry[]): void {
  try {
    localStorage.setItem(GUESS_LOG_KEY, logFile(entries));
  } catch {
    // private window or full storage: the log lives until the page closes
  }
}

export const EXAMPLES: Record<string, Design> = Object.fromEntries(Object.entries(designFiles).map(([p, d]) => [base(p), d]));
export const SCENARIOS: Record<string, Scenario> = Object.fromEntries(Object.entries(scenarioFiles).map(([p, s]) => [base(p), s]));
export { EXAMPLE_SCENARIO } from './exampleScenarios.ts';
import { EXAMPLE_SCENARIO } from './exampleScenarios.ts';

/** Scenarios that fit any design (no part named, not one example's story): offered under "General". */
export const GENERAL_SCENARIOS = ['steady', 'spike', 'flash-crowd', 'overload', 'retry-storm', 'hot-keys', 'hot-key-expiry', 'read-after-write'];

/** The scenario an example opens with: the table above, else a scenario with the same name (saas-*). */
export function exampleScenario(name: string): string {
  return EXAMPLE_SCENARIO[name] ?? (SCENARIOS[name] ? name : 'steady');
}
/** Basic examples first, then the ones modelled after well-known services. */
export const EXAMPLE_ORDER = Object.keys(EXAMPLES).sort((a, b) => Number(a.startsWith('saas-')) - Number(b.startsWith('saas-')) || (a in EXAMPLE_SCENARIO && b in EXAMPLE_SCENARIO ? Object.keys(EXAMPLE_SCENARIO).indexOf(a) - Object.keys(EXAMPLE_SCENARIO).indexOf(b) : a.localeCompare(b)));

export const SPEEDS = [0.01, 0.03, 0.1, 0.3, 1, 3, 10, 30, 100, 300];

export type Selection = { type: 'node' | 'edge'; id: string } | null;
export type RunStatus = 'idle' | 'running' | 'paused' | 'done';

export interface AppState {
  doc: Design;
  nodes: SdNode[];
  edges: SdEdge[];
  selected: Selection;
  issues: Issue[];
  dirty: boolean;
  scenario: Scenario;
  status: RunStatus;
  speed: number;
  /** Display time in ms, refreshed a few times per second for React (the canvas animates on its own). */
  tView: number;
  windows: WindowStat[];
  timeline: TimelineEvent[];
  result: SimResult | null;
  error: string | null;
  theme: 'light' | 'dark';
  lang: Lang;
  /** The example the design was loaded from (null for a file or a new design). */
  example: string | null;
  /**
   * Builds the loaded design again in the current language (an example, a practice problem), or
   * null for a file or a new design. On a language change, text that still equals it is swapped.
   */
  origin: (() => Design) | null;
  /** Counts the designs loaded: a feature that loaded one (a problem, an incident fix) knows when another replaced it. */
  loads: number;
  /** Which side panels are shown. Saved in localStorage. */
  panels: Panels;
  /** The phone layout: the drawer that is open (phone.ts). */
  drawer: Drawer;
  setDrawer: (d: Drawer) => void;
  /** Stacked nodes shown with one row per instance. View state only: not saved in the design. */
  expanded: Record<string, boolean>;
  /** The design and scenario of the last run (the lesson judges what ran, not later edits). */
  ran: { design: Design; scenario: Scenario } | null;
  /** The learner's guesses for the lesson's questions, by question id. Cleared when a design loads. */
  guesses: Record<string, string>;
  /** Every guess with what its run measured, in this browser (kept in localStorage). */
  guessLog: GuessEntry[];
  /** The current guesses are in the log already (logged after the first run that follows them). */
  guessesLogged: boolean;
  /** Ids of the challenges passed in this browser (kept in localStorage). */
  passed: string[];
  /** The service level objective the runs are measured against (kept in localStorage). */
  slo: Slo;
  /** Edit history for undo and redo: the canvas before each edit. Cleared when a design loads. */
  past: Snapshot[];
  future: Snapshot[];
  /** The last Terraform import: its checks, shown while that design is the one loaded (`loads`). */
  imported: { file: string; loads: number; findings: Finding[] } | null;
  /** Every finished run leaves a version, newest first (versions.ts; kept in localStorage). */
  versions: Version[];
  /** The runs in the compare view while it is open (compare.ts). */
  compare: CompareItem[] | null;

  load: (d: Design, origin?: () => Design) => void;
  /** Load a design from `loadsketch import terraform` (in the browser) with its checks. */
  loadImport: (file: string, d: Design, findings: Finding[]) => void;
  loadExample: (name: string) => void;
  design: () => Design;
  exportText: () => string;
  onNodesChange: (c: NodeChange<SdNode>[]) => void;
  onEdgesChange: (c: EdgeChange<SdEdge>[]) => void;
  onConnect: (c: Connection) => void;
  addNode: (kind: string, x: number, y: number) => void;
  select: (s: Selection) => void;
  /** Selects a part and shows it selected on the canvas (select alone follows the canvas). */
  focus: (s: Selection) => void;
  updateNode: (id: string, patch: { label?: string; region?: string; replicaRegion?: string; params?: Record<string, ParamValue | undefined> }) => void;
  updateEdge: (id: string, patch: Partial<Omit<DesignEdge, 'from' | 'to'>>) => void;
  remove: (s: NonNullable<Selection>) => void;
  setScenario: (s: Scenario) => void;
  run: () => void;
  pause: (p: boolean) => void;
  setSpeed: (s: number) => void;
  finish: () => void;
  stop: () => void;
  setTheme: (t: 'light' | 'dark') => void;
  setLang: (l: Lang) => void;
  togglePanel: (p: keyof Panels) => void;
  toggleExpanded: (id: string) => void;
  setGuess: (question: string, option: string) => void;
  markPassed: (ids: string[]) => void;
  /** Add imported entries to the guess log (same entry: kept once). */
  importGuessLog: (entries: GuessEntry[]) => void;
  clearGuessLog: () => void;
  undo: () => void;
  redo: () => void;
  /** The design was saved to a file: the canvas now is clean. */
  markSaved: () => void;
  /** Renames the design (not an undo step). */
  rename: (name: string) => void;
  /**
   * Sets the design's APIs (not an undo step). `renamed`: old name → new name, so edges keep
   * theirs; an edge loses the names that are gone (none left: it carries every API again).
   */
  setApis: (apis: DesignApi[], renamed?: Record<string, string>) => void;
  setSlo: (slo: Slo) => void;
  renameVersion: (id: string, name: string) => void;
  pinVersion: (id: string, pinned: boolean) => void;
  removeVersion: (id: string) => void;
  /** Puts a version's design and scenario on the canvas. */
  loadVersion: (id: string) => void;
  /** Adds versions from a file (runs already in the list are skipped). */
  importVersions: (add: Version[]) => void;
  openCompare: (items: CompareItem[]) => void;
  closeCompare: () => void;
}

/** The canvas at one point of the edit history. */
export interface Snapshot {
  nodes: SdNode[];
  edges: SdEdge[];
  /** Which edit made this canvas. The canvas is clean when its rev is the saved rev. */
  rev: number;
}

const SLO_KEY = 'loadsketch-slo';

function loadSlo(): Slo {
  try {
    const v = JSON.parse(localStorage.getItem(SLO_KEY) ?? 'null') as Partial<Slo> | null;
    if (v && typeof v.target === 'number' && v.target > 0 && v.target < 1 && typeof v.p99Ms === 'number' && v.p99Ms >= 0) return { target: v.target, p99Ms: v.p99Ms };
  } catch {
    /* private mode or bad JSON */
  }
  return DEFAULT_SLO;
}

/** At most this many edits can be undone. */
const HISTORY = 100;

export type Drawer = 'palette' | 'inspector' | 'metrics' | null;
export interface Panels {
  left: boolean;
  right: boolean;
  bottom: boolean;
}

function loadPanels(): Panels {
  const all = { left: true, right: true, bottom: true };
  try {
    const v = JSON.parse(localStorage.getItem('loadsketch-panels') ?? '{}') as Partial<Panels>;
    return { left: v.left !== false, right: v.right !== false, bottom: v.bottom !== false };
  } catch {
    return all;
  }
}

export const UNTITLED = tx('未命名設計');
const empty: Design = { schema: DESIGN_SCHEMA, name: t(UNTITLED), nodes: [], edges: [] };

function withIssues(doc: Design, nodes: SdNode[], edges: SdEdge[]) {
  return { issues: checkDesign(toDesign(doc, nodes, edges)) };
}

/** The scenario a new page starts with, and the one a loaded design falls back to. */
const defaultScenario = (): Scenario => ({ schema: SCENARIO_SCHEMA, name: tx('自訂'), durationS: 60, traffic: { rps: 500, readRatio: 0.9 } });

export const useApp = create<AppState>((set, get) => {
  // Edits of the same field in quick succession (typing a number, dragging a slider) are one step.
  let lastKey = '';
  let lastAt = 0;
  let dragging = false;
  // Each recorded edit gets a new rev. `savedRev` is the rev of the canvas last loaded or saved
  // (-1: no canvas in the history is saved, for example after a rename).
  let rev = 0;
  let nextRev = 0;
  let savedRev = 0;
  /** Saves the canvas before an edit. Same `key` within `mergeMs` of the last edit: no new step. */
  const record = (key = '', mergeMs = 0) => {
    const at = Date.now();
    const merge = key !== '' && key === lastKey && at - lastAt < mergeMs;
    lastKey = key;
    lastAt = at;
    if (merge) return;
    const s = get();
    set({ past: [...s.past.slice(1 - HISTORY), current()], future: [] });
    rev = ++nextRev;
  };
  /** Shows a snapshot, with nothing selected (the selected part may be gone). */
  const restore = (to: Snapshot): Partial<AppState> => {
    lastKey = '';
    rev = to.rev;
    const nodes = to.nodes.map((n) => (n.selected ? { ...n, selected: false } : n));
    const edges = to.edges.map((e) => (e.selected ? { ...e, selected: false } : e));
    return { nodes, edges, selected: null, dirty: rev !== savedRev, ...withIssues(get().doc, nodes, edges) };
  };
  const current = (): Snapshot => ({ nodes: get().nodes, edges: get().edges, rev });
  return {
  doc: empty,
  nodes: [],
  edges: [],
  selected: null,
  issues: [],
  dirty: false,
  scenario: defaultScenario(),
  status: 'idle',
  speed: 1,
  tView: 0,
  windows: [],
  timeline: [],
  result: null,
  error: null,
  theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  lang: getLang(),
  example: null,
  origin: null,
  loads: 0,
  panels: loadPanels(),
  drawer: null,
  setDrawer: (drawer) => set({ drawer }),
  expanded: {},
  ran: null,
  guesses: {},
  guessLog: loadGuessLog(),
  guessesLogged: false,
  passed: loadPassed(),
  slo: loadSlo(),
  past: [],
  future: [],
  imported: null,
  versions: loadVersions(storage()),
  compare: null,

  load: (d, origin) => {
    get().stop();
    const { nodes, edges } = toFlow(d);
    planEntrance(nodes, edges, { nodes: new Set(get().nodes.map((n) => n.id)), edges: new Set(get().edges.map((e) => e.id)) });
    lastKey = '';
    rev = nextRev = savedRev = 0;
    // A loaded design ends the last error; a scenario made for the old design (an event on a node this
    // one does not have) would stop every run, so it goes back to the default.
    const fits = (() => { const v = parseDesign(d); return !v.ok || parseScenario(get().scenario, v.value).ok; })();
    set({ past: [], future: [], doc: d, nodes, edges, selected: null, dirty: false, example: null, origin: origin ?? null, loads: get().loads + 1, result: null, windows: [], timeline: [], tView: 0, ran: null, guesses: {}, guessesLogged: false, error: null, ...(fits ? {} : { scenario: defaultScenario() }), ...withIssues(d, nodes, edges) });
  },
  loadImport: (file, d, findings) => {
    get().load(d);
    set({ imported: { file, loads: get().loads, findings } });
  },
  loadExample: (name) => {
    const d = EXAMPLES[name];
    if (!d) return;
    get().load(localizeDesign(structuredClone(d)), () => localizeDesign(structuredClone(d)));
    set({ example: name });
    const sc = SCENARIOS[exampleScenario(name)];
    if (sc) set({ scenario: structuredClone(sc) });
  },
  design: () => toDesign(get().doc, get().nodes, get().edges),
  exportText: () => formatJson(get().design()),

  onNodesChange: (changes) => {
    // a drag is one step, saved when it starts
    const drag = changes.find((c) => c.type === 'position');
    if (drag && drag.type === 'position') {
      if (drag.dragging && !dragging) record();
      dragging = !!drag.dragging;
    }
    // deleting a node also deletes its edges, in a second call: one step
    if (changes.some((c) => c.type === 'remove')) record('rf-remove', 200);
    const nodes = applyNodeChanges(changes, get().nodes);
    const patch: Partial<AppState> = { nodes };
    const sel = changes.find((c) => c.type === 'select' && c.selected);
    if (sel && sel.type === 'select') patch.selected = { type: 'node', id: sel.id };
    if (changes.some((c) => c.type === 'position' && !c.dragging)) patch.dirty = true;
    if (changes.some((c) => c.type === 'remove')) Object.assign(patch, { dirty: true, selected: null }, withIssues(get().doc, nodes, get().edges));
    set(patch);
  },
  onEdgesChange: (changes) => {
    if (changes.some((c) => c.type === 'remove')) record('rf-remove', 200);
    const edges = applyEdgeChanges(changes, get().edges);
    const patch: Partial<AppState> = { edges };
    const sel = changes.find((c) => c.type === 'select' && c.selected);
    if (sel && sel.type === 'select') patch.selected = { type: 'edge', id: sel.id };
    if (changes.some((c) => c.type === 'remove')) Object.assign(patch, { dirty: true, selected: null }, withIssues(get().doc, get().nodes, edges));
    set(patch);
  },
  onConnect: (c) => {
    if (!c.source || !c.target || c.source === c.target) return;
    const e: DesignEdge = { from: c.source, to: c.target };
    const id = edgeId(e);
    if (get().edges.some((x) => x.id === id)) return;
    record();
    markNew('edge', id);
    const edges = [...get().edges, { id, type: 'flow' as const, source: e.from, target: e.to, data: { edge: e } }];
    set({ edges, dirty: true, selected: { type: 'edge', id }, ...withIssues(get().doc, get().nodes, edges) });
  },
  addNode: (kind, x, y) => {
    const spec = KINDS[kind];
    if (!spec) return;
    const id = freshId(kind, new Set(get().nodes.map((n) => n.id)));
    record();
    markNew('node', id);
    const node: DesignNode = { id, kind, pos: [Math.round(x), Math.round(y)] };
    const nodes = [...get().nodes.map((n) => ({ ...n, selected: false })), { id, type: 'component' as const, position: { x: node.pos[0], y: node.pos[1] }, data: { node }, selected: true }];
    set({ nodes, dirty: true, selected: { type: 'node', id }, ...withIssues(get().doc, nodes, get().edges) });
  },
  select: (s) => set({ selected: s }),
  focus: (s) =>
    set({
      selected: s,
      nodes: get().nodes.map((n) => (!!n.selected === (s?.type === 'node' && s.id === n.id) ? n : { ...n, selected: !n.selected })),
      edges: get().edges.map((e) => (!!e.selected === (s?.type === 'edge' && s.id === e.id) ? e : { ...e, selected: !e.selected })),
    }),
  updateNode: (id, patch) => {
    record(`node:${id}:${Object.keys(patch).join()}:${Object.keys(patch.params ?? {}).join()}`, 1000);
    const nodes = get().nodes.map((n) => {
      if (n.id !== id) return n;
      const node: DesignNode = { ...n.data.node };
      if (patch.label !== undefined) {
        if (patch.label) node.label = patch.label;
        else delete node.label;
      }
      if (patch.region !== undefined) {
        if (patch.region) node.region = patch.region;
        else delete node.region;
      }
      if (patch.replicaRegion !== undefined) {
        if (patch.replicaRegion) node.replicaRegion = patch.replicaRegion;
        else delete node.replicaRegion;
      }
      if (patch.params) {
        const params: Record<string, ParamValue> = { ...(node.params ?? {}) };
        for (const [k, v] of Object.entries(patch.params)) {
          if (v === undefined) delete params[k];
          else params[k] = v;
        }
        if (Object.keys(params).length) node.params = params;
        else delete node.params;
        if (node.source) node.source = { ...node.source, params: editedSources(node.source.params, patch.params) };
      }
      return { ...n, data: { node } };
    });
    set({ nodes, dirty: true, ...withIssues(get().doc, nodes, get().edges) });
  },
  updateEdge: (id, patch) => {
    record(`edge:${id}:${Object.keys(patch).join()}`, 1000);
    let newId = id;
    const edges = get().edges.map((e) => {
      if (e.id !== id) return e;
      const edge: DesignEdge = { ...e.data!.edge };
      for (const [k, v] of Object.entries(patch) as [keyof DesignEdge, unknown][]) {
        if (v === undefined) delete edge[k];
        else (edge as unknown as Record<string, unknown>)[k] = v;
      }
      if (edge.source) edge.source = { ...edge.source, params: editedSources(edge.source.params, patch as Record<string, unknown>) };
      newId = edgeId(edge);
      return { ...e, id: newId, data: { edge } };
    });
    const sel = get().selected;
    set({ edges, dirty: true, selected: sel?.id === id ? { type: 'edge', id: newId } : sel, ...withIssues(get().doc, get().nodes, edges) });
  },
  remove: (s) => {
    record();
    if (s.type === 'node') {
      const nodes = get().nodes.filter((n) => n.id !== s.id);
      const edges = get().edges.filter((e) => e.source !== s.id && e.target !== s.id);
      set({ nodes, edges, selected: null, dirty: true, ...withIssues(get().doc, nodes, edges) });
    } else {
      const edges = get().edges.filter((e) => e.id !== s.id);
      set({ edges, selected: null, dirty: true, ...withIssues(get().doc, get().nodes, edges) });
    }
  },
  setScenario: (s) => set({ scenario: s }),

  run: () => {
    const d = get().design();
    const r = parseDesign(d);
    if (!r.ok) {
      set({ issues: r.issues, error: t('設計有錯誤，先修好再執行（看右邊的檢查結果）。') });
      return;
    }
    // the scenario editor can produce values the engine must not run (a pause as long as its period)
    if (!parseScenario(get().scenario, r.value).ok) {
      set({ error: t('情境有錯誤，先修好再執行（看「情境」分頁的檢查結果）。') });
      return;
    }
    resetLive();
    set({ status: 'running', result: null, windows: [], timeline: [], tView: 0, error: null, ran: { design: d, scenario: get().scenario } });
    send({ type: 'start', design: d, scenario: get().scenario, speed: get().speed, lang: get().lang });
  },
  pause: (p) => {
    if (get().status !== 'running' && get().status !== 'paused') return;
    set({ status: p ? 'paused' : 'running' });
    send({ type: 'pause', paused: p });
  },
  setSpeed: (s) => {
    set({ speed: s });
    send({ type: 'speed', speed: s });
  },
  finish: () => {
    if (get().status === 'running' || get().status === 'paused') send({ type: 'finish' });
  },
  stop: () => {
    if (get().status === 'running' || get().status === 'paused') send({ type: 'stop' });
    resetLive();
    set({ status: 'idle', tView: 0 });
  },
  setTheme: (th) => {
    document.documentElement.classList.toggle('dark', th === 'dark');
    try {
      localStorage.setItem('loadsketch-theme', th);
    } catch {
      /* private mode */
    }
    set({ theme: th });
  },
  setLang: (l) => {
    if (l === get().lang) return;
    // Text that still equals the example's text in the old language is swapped for the new
    // language. Text the user changed, positions and everything else stay as they are.
    const { origin } = get();
    const before = origin?.();
    const untitledBefore = t(UNTITLED);
    applyLang(l);
    const after = origin?.();
    try {
      localStorage.setItem('loadsketch-lang', l);
    } catch {
      /* private mode */
    }
    // A run made in the old language would mix languages: stop it and drop its text.
    get().stop();
    // the history holds text in the old language: it is dropped
    lastKey = '';
    set({ past: [], future: [] });
    let { doc, nodes } = get();
    const swap = <T,>(cur: T, from: T | undefined, to: T | undefined): T => (from !== undefined && to !== undefined && cur === from ? to : cur);
    if (before && after) {
      const labels = new Map(before.nodes.map((n, i) => [n.id, [n.label, after.nodes[i].label] as const]));
      nodes = nodes.map((n) => {
        const p = labels.get(n.id);
        const label = p ? swap(n.data.node.label, p[0], p[1]) : n.data.node.label;
        return label === n.data.node.label ? n : { ...n, data: { ...n.data, node: { ...n.data.node, label } } };
      });
      doc = {
        ...doc,
        name: swap(doc.name, before.name, after.name),
        description: swap(doc.description, before.description, after.description),
        notes: doc.notes?.map((note) => {
          const i = before.notes?.findIndex((x) => x.id === note.id) ?? -1;
          return i < 0 ? note : { ...note, text: swap(note.text, before.notes![i].text, after.notes![i].text) };
        }),
      };
    }
    doc = { ...doc, name: swap(doc.name, untitledBefore, t(UNTITLED)) };
    set({ lang: l, doc, nodes, status: 'idle', result: null, windows: [], timeline: [], tView: 0, error: null, ...withIssues(doc, nodes, get().edges) });
  },
  togglePanel: (p) => {
    const panels = { ...get().panels, [p]: !get().panels[p] };
    try {
      localStorage.setItem('loadsketch-panels', JSON.stringify(panels));
    } catch {
      /* private mode */
    }
    set({ panels });
  },
  toggleExpanded: (id) => set({ expanded: { ...get().expanded, [id]: !get().expanded[id] } }),
  setGuess: (question, option) => set({ guesses: { ...get().guesses, [question]: option } }),
  setSlo: (slo) => {
    set({ slo });
    try {
      localStorage.setItem(SLO_KEY, JSON.stringify(slo));
    } catch {
      /* private mode */
    }
  },
  undo: () => {
    const { past, future } = get();
    if (!past.length) return;
    set({ past: past.slice(0, -1), future: [...future, current()], ...restore(past[past.length - 1]) });
  },
  redo: () => {
    const { past, future } = get();
    if (!future.length) return;
    set({ future: future.slice(0, -1), past: [...past, current()], ...restore(future[future.length - 1]) });
  },
  markSaved: () => {
    savedRev = rev;
    // the next edit is a new step, so that undo can come back to exactly the saved canvas
    lastKey = '';
    set({ dirty: false });
  },
  rename: (name) => {
    savedRev = -1;
    set({ doc: { ...get().doc, name }, dirty: true });
  },
  setApis: (apis, renamed = {}) => {
    savedRev = -1;
    const names = new Set(apis.map((a) => a.name));
    const edges = get().edges.map((e) => {
      const old = e.data!.edge;
      if (!old.apis) return e;
      const keep = [...new Set(old.apis.map((n) => renamed[n] ?? n).filter((n) => names.has(n)))];
      if (keep.length === old.apis.length && keep.every((n, i) => n === old.apis![i])) return e;
      const edge: DesignEdge = { ...old };
      if (keep.length) edge.apis = keep;
      else delete edge.apis;
      return { ...e, id: edgeId(edge), data: { edge } };
    });
    const doc: Design = { ...get().doc };
    if (apis.length) doc.apis = apis;
    else delete doc.apis;
    const sel = get().selected;
    const selEdge = sel?.type === 'edge' ? edges[get().edges.findIndex((e) => e.id === sel.id)] : undefined;
    set({ doc, edges, dirty: true, selected: selEdge ? { type: 'edge', id: selEdge.id } : sel, ...withIssues(doc, get().nodes, edges) });
  },
  importGuessLog: (entries) => {
    const log = addEntries(get().guessLog, entries);
    saveGuessLog(log);
    set({ guessLog: log });
  },
  clearGuessLog: () => {
    saveGuessLog([]);
    set({ guessLog: [] });
  },
  renameVersion: (id, name) => changeVersions((l) => renameVersion(l, id, name)),
  pinVersion: (id, pinned) => changeVersions((l) => pinVersion(l, id, pinned)),
  removeVersion: (id) => changeVersions((l) => removeVersion(l, id)),
  loadVersion: (id) => {
    const v = get().versions.find((x) => x.id === id);
    if (!v) return;
    get().load(structuredClone(v.design));
    set({ scenario: structuredClone(v.scenario) });
  },
  importVersions: (add) => changeVersions((l) => mergeVersions(l, add)),
  openCompare: (items) => set({ compare: items }),
  closeCompare: () => set({ compare: null }),
  markPassed: (ids) => {
    const now = get().passed;
    const add = ids.filter((id) => !now.includes(id));
    if (!add.length) return;
    const passed = [...now, ...add];
    set({ passed });
    try {
      localStorage.setItem(PASSED_KEY, JSON.stringify(passed));
    } catch {
      /* private mode */
    }
  },
  };
});

/**
 * Changes the version list as it is in storage now (another tab may have changed it), shows it and
 * saves it. Full storage says so once.
 */
function changeVersions(change: (list: Version[]) => Version[]): void {
  const r = updateVersions(storage(), useApp.getState().versions, change);
  useApp.setState({ versions: r.list });
  if (r.dropped) useApp.setState({ error: t('瀏覽器的儲存空間滿了：最舊的 {n} 個版本已經移除。要留下版本，先匯出成檔案。', { n: r.dropped }) });
  if (r.refused) useApp.setState({ error: t('瀏覽器的儲存空間滿了，釘選的版本就佔滿了：這次的改動沒有存。取消釘選幾個版本，或先匯出再刪除。') });
  if (r.memoryOnly && !memoryWarned) {
    memoryWarned = true;
    useApp.setState({ error: t('這個瀏覽器不讓網頁存資料：版本只留到關閉分頁。要留下版本，先匯出成檔案。') });
  }
}
let memoryWarned = false;

/** A finished run leaves a version: the design and scenario that ran, and a summary of the result. */
function recordVersion(): void {
  const s = useApp.getState();
  if (EMBEDDED || !s.ran || !s.result) return;
  const { design, scenario } = s.ran;
  const v = { at: Date.now(), name: design.name, pinned: false, design, scenario, summary: summarize(design, s.result, s.windows) };
  changeVersions((l) => addVersion(l, v));
}

// another tab changed the versions: show its list
window.addEventListener('storage', (e) => {
  if (e.key === VERSIONS_KEY || e.key === null) useApp.setState({ versions: loadVersions(storage()) });
});

/** After the first run that follows the guesses of a lesson, add them to the guess log. */
function logGuesses(): void {
  const s = useApp.getState();
  const lesson = s.example ? LESSONS[s.example] : undefined;
  if (!lesson || s.guessesLogged || !s.ran || !s.result || !Object.keys(s.guesses).length) return;
  const add = entriesForRun(lesson, s.guesses, { design: s.ran.design, scenario: s.ran.scenario, result: s.result, windows: s.windows }, new Date());
  if (!add.length) return;
  const log = addEntries(s.guessLog, add);
  saveGuessLog(log);
  useApp.setState({ guessLog: log, guessesLogged: true });
}

// Worker → store. Charts and lists refresh at most ~4 times a second.
let lastPush = 0;
connect((m) => {
  const st = useApp.getState();
  if (m.type === 'error') {
    useApp.setState({ error: t('模擬出錯：{why}', { why: m.message }), status: 'idle' });
    return;
  }
  if (m.type === 'result') {
    const sec = m.tView / 1000;
    useApp.setState({ status: 'done', result: m.result, tView: m.tView, windows: live.windows.filter((w) => w.t <= sec + 1e-9), timeline: live.timeline.filter((e) => e.t <= sec) });
    logGuesses();
    recordVersion();
    return;
  }
  const now = performance.now();
  if (now - lastPush < 250 && st.status === 'running') return;
  lastPush = now;
  const sec = m.tView / 1000;
  useApp.setState({
    tView: m.tView,
    windows: live.windows.filter((w) => w.t <= sec + 1e-9),
    timeline: live.timeline.filter((e) => e.t <= sec),
  });
});
