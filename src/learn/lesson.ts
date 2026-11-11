// A lesson on one example: questions to answer before the run (checked against the run),
// and challenges (goals and rules) judged after every run.
// Pure functions: no React, no DOM. Text goes through t() when it is made.
import { KINDS } from '../schema/kinds.ts';
import { edgeId, type Design, type ParamValue, type Scenario } from '../schema/design.ts';
import { t, tx } from '../i18n/index.ts';
import type { RunData } from './metrics.ts';

export interface Option {
  id: string;
  text: string; // message id (tx)
}

/** Guess first, then run: the answer is read from the run, so it holds for a changed design too. */
export interface Question {
  id: string;
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
  id: string;
  title: string; // message id
  text: string; // message id
  goals: Goal[];
  rules: Rule[];
  hint: string; // message id
}

export interface Lesson {
  example: string;
  /** Shown instead of the example's description until the first run: the description gives the answer away. */
  intro: string; // message id
  /** Challenges count only with this scenario (the one the example opens with). */
  scenario: string;
  questions: Question[];
  challenges: Challenge[];
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
  short: tx('不能加機器'),
  text: tx('台數、同時處理數、連線數不能變多，處理時間不能變短，快取命中率不能變高，也不能刪掉原本的元件或連線'),
  check: (d, original) => {
    const out: string[] = [];
    const now = new Map(d.nodes.map((n) => [n.id, n]));
    for (const o of original.nodes) {
      const n = now.get(o.id);
      const name = o.label ? t(o.label) : o.id;
      if (!n || n.kind !== o.kind) {
        out.push(t('刪掉了「{name}」', { name }));
        continue;
      }
      const spec = KINDS[n.kind];
      for (const k of MORE) {
        const a = num(param(o, k));
        const b = num(param(n, k));
        if (a !== undefined && b !== undefined && b > a) out.push(t('「{name}」的{what}從 {a} 變成 {b}', { name, what: t(spec.params[k]?.label ?? k), a, b }));
      }
      for (const k of FASTER) {
        const a = mean(param(o, k));
        const b = mean(param(n, k));
        if (a !== undefined && b !== undefined && b < a) out.push(t('「{name}」的{what}從 {a} 變成 {b}', { name, what: t(spec.params[k]?.label ?? k), a, b }));
      }
      const ha = num(param(o, 'hitRatio'));
      const hb = num(param(n, 'hitRatio'));
      if (ha !== undefined && hb !== undefined && hb > ha) out.push(t('「{name}」的{what}從 {a} 變成 {b}', { name, what: t(spec.params.hitRatio?.label ?? "hitRatio"), a: ha, b: hb }));
      if (param(o, 'autoscale') !== 'on' && param(n, 'autoscale') === 'on') out.push(t('「{name}」開了自動擴充', { name }));
    }
    const was = new Set(original.nodes.map((n) => n.id));
    for (const n of d.nodes) if (!was.has(n.id) && KINDS[n.kind]?.station) out.push(t('加了新的{kind}「{name}」', { kind: t(KINDS[n.kind].label), name: n.label ?? n.id }));
    const edges = new Set(d.edges.map(edgeId));
    for (const e of original.edges) if (!edges.has(edgeId(e))) out.push(t('刪掉了連線「{id}」', { id: edgeId(e) }));
    return out;
  },
};

/** Every connection that retried in the original still retries at least once. */
export const keepRetries: Rule = {
  short: tx('重試照留'),
  text: tx('原本有重試的連線，每條至少還要重試 1 次'),
  check: (d, original) => {
    const now = new Map(d.edges.map((e) => [edgeId(e), e]));
    const out: string[] = [];
    for (const o of original.edges) {
      if (!o.retries) continue;
      const e = now.get(edgeId(o));
      if (e && !(e.retries && e.retries >= 1)) out.push(t('連線「{id}」不重試了', { id: edgeId(o) }));
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
  const broken = c.rules.flatMap((r) => r.check(run.design, original));
  // no way round the system: a component of the example that gets no request (e.g. behind a weight-0 connection)
  for (const o of original.nodes) {
    if (o.kind !== 'client' && run.design.nodes.some((n) => n.id === o.id) && !(run.result.nodes[o.id]?.arrivals > 0)) broken.push(t('「{name}」沒有收到任何請求：不能繞過原本的元件', { name: o.label ? t(o.label) : o.id }));
  }
  return { passed: broken.length === 0 && goals.every((g) => g.ok), goals, broken };
}
