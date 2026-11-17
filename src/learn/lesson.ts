// A lesson on one example: questions to answer before the run (checked against the run),
// and challenges (goals and rules) judged after every run.
// Pure functions: no React, no DOM. Text goes through t() when it is made.
import { KINDS } from '../schema/kinds.ts';
import { edgeId, type Design, type ParamValue, type Scenario } from '../schema/design.ts';
import { t, tx } from '../i18n/index.ts';
import type { RunData } from './metrics.ts';
import { customUsed } from './constraints.ts';
import type { Patch } from './oncall.ts';

export interface Option {
  id: string;
  text: string; // message id (tx)
}

/** Guess first, then run: the answer is read from the run, so it holds for a changed design too. */
export interface Question {
  id: string;
  /**
   * Course lessons with more than one example (a pair) or scenario: the run this question reads.
   * Defaults to the lesson's own example and scenario.
   */
  example?: string;
  scenario?: string;
  text: string; // message id
  options: Option[];
  answer: (run: RunData) => string; // option id
  /** What the run measured, shown with the answer. */
  measured: (run: RunData) => string;
  explain: string; // message id
  /** Explanations for answers other than the example's own (a fixed design), by option id. */
  explainFor?: Partial<Record<string, string>>;
  /** What the question is about, for the guess log (a key of TOPICS in guessLog.ts). Options run from low to high. */
  topic?: string;
}

export interface GoalResult {
  ok: boolean;
  value: string; // what the run measured
}

export interface Goal {
  text: string; // message id
  check: (run: RunData) => GoalResult;
}

/** A rule on the design: returns the reasons it is broken (empty when kept). */
export type Rule = { short: string; text: string; check: (d: Design, original: Design) => string[] };

export interface Challenge {
  /** Unique over every lesson: the store keeps passed challenges by id. */
  id: string;
  /** Course lessons: the run this challenge is judged on (default: the lesson's example and scenario). */
  example?: string;
  scenario?: string;
  title: string; // message id
  text: string; // message id
  goals: Goal[];
  rules: Rule[];
  hint: string; // message id
}

/** A change to the design: params of a node, or fields of an edge ("from->to"). Same shape as on-call fixes. */
export type { Patch };

/** Where a practice problem lives: on-call drills, constraint problems, briefs (by their id). */
export type PracticeLink = { kind: 'oncall' | 'constraint' | 'brief'; id: string };

/**
 * One step of a course lesson, in order. A course page shows them top to bottom; the side panel
 * ignores them. Text is a message id.
 * - read: a paragraph.
 * - guess: the questions (ids) to answer before the next run.
 * - run: open this example and scenario (default: the lesson's) and run it.
 * - try: change the design (`patch`, optional: the text may only describe it) or open another
 *   scenario, and run again. Not judged: the run shows the answer.
 * - challenge: the challenges (ids), judged on every run.
 * - practice: problems to do after the lesson.
 */
export type Step =
  | { kind: 'read'; text: string }
  | { kind: 'guess'; questions: string[] }
  | { kind: 'run'; example?: string; scenario?: string; text?: string }
  | { kind: 'try'; text: string; example?: string; scenario?: string; patch?: Patch[] }
  | { kind: 'challenge'; challenges: string[] }
  | { kind: 'practice'; text?: string; items: PracticeLink[] };

export interface Lesson {
  example: string;
  /** Course lessons (src/learn/course/): the number in the outline, e.g. "2.1". Unique. */
  id?: string;
  /** Course lessons: the title (message id). */
  title?: string;
  /** Course lessons: the unit (0–6, a key of UNITS in course.ts) and the order inside it. */
  unit?: number;
  order?: number;
  /** Course lessons: about how long it takes, in minutes. */
  minutes?: number;
  /** Course lessons: the wave it ships in. */
  wave?: 1 | 2;
  /** Course lessons: other examples the lesson opens (a pair: the problem, then the fix). */
  extraExamples?: string[];
  /** Course lessons: the steps in order. Without it: stepsOf() (intro, guess all, run, challenges). */
  steps?: Step[];
  /** Shown instead of the example's description until the first run: the description gives the answer away. */
  intro: string; // message id
  /** Challenges count only with this scenario (the one the example opens with). A key of SCENARIOS. */
  scenario: string;
  questions: Question[];
  challenges: Challenge[];
}

/** The steps of a lesson: its own, or read the intro, guess every question, run, then the challenges. */
export function stepsOf(l: Lesson): Step[] {
  if (l.steps) return l.steps;
  const out: Step[] = [{ kind: 'read', text: l.intro }];
  if (l.questions.length) out.push({ kind: 'guess', questions: l.questions.map((q) => q.id) });
  out.push({ kind: 'run' });
  if (l.challenges.length) out.push({ kind: 'challenge', challenges: l.challenges.map((c) => c.id) });
  return out;
}

/** The example and scenario a question or challenge reads (its own, else the lesson's). */
export function runOf(l: Lesson, x: { example?: string; scenario?: string }): { example: string; scenario: string } {
  return { example: x.example ?? l.example, scenario: x.scenario ?? l.scenario };
}

export interface Verdict {
  passed: boolean;
  goals: (GoalResult & { text: string })[];
  broken: string[]; // reasons, already translated
}

// ---------------------------------------------------------------------------------------------
// Rules

/** Parameters that add capacity: a larger value is more machines, slots or connections. */
const MORE = ['instances', 'concurrency', 'connections', 'replicas', 'shards', 'maxInstances', 'partitions'];
/** Parameters whose smaller value is faster code or hardware (a distribution's mean). */
const FASTER = ['serviceMs', 'readMs', 'writeMs'];

const num = (v: ParamValue | undefined): number | undefined => (typeof v === 'number' ? v : undefined);
const mean = (v: ParamValue | undefined): number | undefined =>
  v && typeof v === 'object' && 'mean' in v ? (v as { mean: number }).mean : undefined;

function param(n: Design['nodes'][number], key: string): ParamValue | undefined {
  return n.params?.[key] ?? (KINDS[n.kind]?.params[key]?.default as ParamValue | undefined);
}

/** No new machines, slots, connections or faster parts; no original component or connection removed. */
export const noMoreCapacity: Rule = {
  short: tx('No more machines'),
  text: tx('instances, concurrency and connections cannot grow, processing times cannot get shorter, the cache hit ratio cannot get higher, and no original component or connection can be removed'),
  check: (d, original) => {
    const out: string[] = [];
    const now = new Map(d.nodes.map((n) => [n.id, n]));
    for (const o of original.nodes) {
      const n = now.get(o.id);
      const name = o.label ? t(o.label) : o.id;
      if (!n || n.kind !== o.kind) {
        out.push(t('Removed "{name}"', { name }));
        continue;
      }
      const spec = KINDS[n.kind];
      for (const k of MORE) {
        const a = num(param(o, k));
        const b = num(param(n, k));
        if (a !== undefined && b !== undefined && b > a) out.push(t('"{name}": {what} changed from {a} to {b}', { name, what: t(spec.params[k]?.label ?? k), a, b }));
      }
      for (const k of FASTER) {
        const a = mean(param(o, k));
        const b = mean(param(n, k));
        if (a !== undefined && b !== undefined && b < a) out.push(t('"{name}": {what} changed from {a} to {b}', { name, what: t(spec.params[k]?.label ?? k), a, b }));
      }
      const ha = num(param(o, 'hitRatio'));
      const hb = num(param(n, 'hitRatio'));
      if (ha !== undefined && hb !== undefined && hb > ha) out.push(t('"{name}": {what} changed from {a} to {b}', { name, what: t(spec.params.hitRatio?.label ?? "hitRatio"), a: ha, b: hb }));
      if (param(o, 'autoscale') !== 'on' && param(n, 'autoscale') === 'on') out.push(t('"{name}": autoscaling is on', { name }));
    }
    const was = new Set(original.nodes.map((n) => n.id));
    for (const n of d.nodes) if (!was.has(n.id) && KINDS[n.kind]?.station) out.push(t('Added a new {kind} "{name}"', { kind: t(KINDS[n.kind].label), name: n.label ?? n.id }));
    const edges = new Set(d.edges.map(edgeId));
    for (const e of original.edges) if (!edges.has(edgeId(e))) out.push(t('Removed the connection "{id}"', { id: edgeId(e) }));
    return out;
  },
};

/**
 * Every connection that retried in the original still retries at least once. A call into a cache
 * does not count: when the cache does not answer, the caller reads the store, so a retry there
 * is not something to keep.
 */
export const keepRetries: Rule = {
  short: tx('Keep the retries'),
  text: tx('Every connection that had retries must still retry at least once (a call into a cache does not count)'),
  check: (d, original) => {
    const now = new Map(d.edges.map((e) => [edgeId(e), e]));
    const caches = new Set(original.nodes.filter((n) => n.kind === 'cache').map((n) => n.id));
    const out: string[] = [];
    for (const o of original.edges) {
      if (!o.retries || caches.has(o.to)) continue;
      const e = now.get(edgeId(o));
      if (e && !(e.retries && e.retries >= 1)) out.push(t('The connection "{id}" no longer retries', { id: edgeId(o) }));
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// Judging

/** Whether the scenario is the lesson's (its name may be translated). */
export function sameScenario(a: Scenario, b: Scenario): boolean {
  const key = (s: Scenario) => JSON.stringify({ ...s, name: undefined, description: undefined });
  return key(a) === key(b);
}

export function judge(c: Challenge, run: RunData, original: Design): Verdict {
  const goals = c.goals.map((g) => ({ ...g.check(run), text: t(g.text) }));
  const broken = [...customUsed(run.design).map((b) => t(b.text, b.vars)), ...c.rules.flatMap((r) => r.check(run.design, original))];
  // no way round the system: a component of the example that gets no request (e.g. behind a weight-0 connection)
  for (const o of original.nodes) {
    if (o.kind !== 'client' && run.design.nodes.some((n) => n.id === o.id) && !(run.result.nodes[o.id]?.arrivals > 0)) broken.push(t('"{name}" got no requests: you cannot go round a component of the original design', { name: o.label ? t(o.label) : o.id }));
  }
  return { passed: broken.length === 0 && goals.every((g) => g.ok), goals, broken };
}
