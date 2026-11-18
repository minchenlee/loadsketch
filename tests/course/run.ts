// Runs for course lesson tests: an example with its scenario (or another), changed by named
// patches, cached by what changed. Every expected answer comes from these runs, never typed in.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Simulation } from '../../src/engine/index.ts';
import type { Design, Scenario } from '../../src/schema/design.ts';
import { judge, type Lesson } from '../../src/learn/lesson.ts';
import type { RunData } from '../../src/learn/metrics.ts';

const root = join(import.meta.dirname, '..', '..');
const read = <T,>(p: string) => JSON.parse(readFileSync(join(root, p), 'utf8')) as T;
export const design = (example: string) => read<Design>(`examples/designs/${example}.json`);
export const scenario = (name: string) => read<Scenario>(`examples/scenarios/${name}.json`);

/** A change to the design or scenario, named so that runs can be cached by what changed. */
export type Change = { key: string; apply: (d: Design, s: Scenario) => void };
export const node = (d: Design, id: string) => {
  const n = d.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no node ${id}`);
  return n;
};
export const setParam = (id: string, key: string, v: unknown): Change => ({
  key: `${id}.${key}=${JSON.stringify(v)}`,
  apply: (d) => (node(d, id).params = { ...node(d, id).params, [key]: v as never }),
});
export const setEdge = (from: string, to: string, key: string, v: unknown): Change => ({
  key: `${from}->${to}.${key}=${JSON.stringify(v)}`,
  apply: (d) => {
    const e = d.edges.find((x) => x.from === from && x.to === to);
    if (!e) throw new Error(`no edge ${from}->${to}`);
    (e as unknown as Record<string, unknown>)[key] = v;
  },
});
export const setScenario = (key: string, apply: (s: Scenario) => void): Change => ({ key: `scenario:${key}`, apply: (_d, s) => apply(s) });

/** Delete a node and every edge to or from it. */
export const removeNode = (id: string): Change => ({
  key: `remove:${id}`,
  apply: (d) => {
    d.nodes = d.nodes.filter((n) => n.id !== id);
    d.edges = d.edges.filter((e) => e.from !== id && e.to !== id);
  },
});

const runs = new Map<string, RunData>();
/** One run of `example` with `scenarioName` and the changes, cached. */
export function runOf(example: string, scenarioName: string, ...changes: Change[]): RunData {
  const key = [example, scenarioName, ...changes.map((c) => c.key)].join('+');
  let r = runs.get(key);
  if (!r) {
    const d = structuredClone(design(example));
    const sc = structuredClone(scenario(scenarioName));
    for (const c of changes) c.apply(d, sc);
    const sim = new Simulation(d, sc);
    const result = sim.runToEnd();
    r = { design: d, scenario: sc, result, windows: sim.allWindows() };
    runs.set(key, r);
  }
  return r;
}

/** A lesson's runner: its example and scenario unless told otherwise. */
export function lessonRuns(lesson: Lesson) {
  const run = (...changes: Change[]) => runOf(lesson.example, lesson.scenario, ...changes);
  const original = design(lesson.example);
  /** Ids of the lesson's challenges (on its own example) this run passes. */
  const passed = (r: RunData) => lesson.challenges.filter((c) => (c.example ?? lesson.example) === lesson.example).filter((c) => judge(c, r, original).passed).map((c) => c.id);
  const question = (id: string) => {
    const q = lesson.questions.find((x) => x.id === id);
    if (!q) throw new Error(`no question ${id}`);
    return q;
  };
  const challenge = (id: string) => {
    const c = lesson.challenges.find((x) => x.id === id);
    if (!c) throw new Error(`no challenge ${id}`);
    return c;
  };
  return { run, original, passed, question, challenge };
}

/**
 * cheats-errors.test.ts sets the error rate of every component, one at a time. A design with more
 * than BIG_DESIGN such components takes many runs of a long scenario (6.2: 9 components, about
 * 20 s a run), so the course suite tries one component of each kind (and all of them at once);
 * COURSE_ALL_CHEATS=1 (npm run test:cheats-all) tries every component.
 */
export const ALL_CHEATS = !!process.env.COURSE_ALL_CHEATS;
export const BIG_DESIGN = 8;
/** All of `nodes`, or for a big design the first of each kind (in design order). */
export function sample<T extends { kind: string }>(nodes: T[]): T[] {
  if (ALL_CHEATS || nodes.length <= BIG_DESIGN) return nodes;
  const seen = new Set<string>();
  return nodes.filter((n) => !seen.has(n.kind) && seen.add(n.kind));
}

/** Each run is a whole simulation; the slow suite runs many files at once. */
export const SLOW = 180_000;
