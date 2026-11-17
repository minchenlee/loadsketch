// Constraint problems (M8, Q11=A, Q12=A): meet the error rate and p99 targets inside a budget and a
// complexity limit. People and time cannot be simulated, so a small team and a short deadline become
// fewer complexity points: each component and each mechanism costs points to build and run.
// Pure functions: no React, no DOM.
import { tx } from '../i18n/index.ts';
import type { SimResult, WindowStat } from '../engine/index.ts';
import type { Design, DesignEdge, DesignNode, Scenario } from '../schema/design.ts';
import { CUSTOM_KIND, KINDS, resolveParams } from '../schema/kinds.ts';
import { costOf, type Cost } from './cost.ts';
import type { Patch } from './oncall.ts';
import { loadPracticeList, parseProblem } from './practiceData.ts';

/** Points to build and run one component of a kind. */
export const KIND_POINTS: Record<string, number> = {
  client: 0,
  dns: 0,
  cdn: 1,
  api_gateway: 1,
  load_balancer: 1,
  rate_limiter: 1,
  service: 1,
  custom: 1,
  circuit_breaker: 1,
  cache: 2,
  database: 2,
  sharded_db: 5,
  queue: 2,
  worker: 1,
  function: 1,
  object_storage: 1,
};

/** Mechanisms that cost points on top of the component. */
export const NODE_MECHANISMS: { text: string; points: number; on: (p: Record<string, unknown>, n: DesignNode) => boolean }[] = [
  { text: tx('讀副本'), points: 1, on: (p) => typeof p.replicas === 'number' && p.replicas > 0 },
  { text: tx('自動切換主庫'), points: 1, on: (p) => p.failover === 'on' },
  { text: tx('自動擴充'), points: 1, on: (p) => p.autoscale === 'on' },
  { text: tx('outlier detection'), points: 1, on: (p) => p.outlier === 'on' },
  { text: tx('主動健康檢查'), points: 1, on: (p) => p.healthCheck === 'liveness' || p.healthCheck === 'deep' },
  { text: tx('防擊穿'), points: 1, on: (p) => typeof p.stampede === 'string' && p.stampede !== 'none' },
];

export const EDGE_MECHANISMS: { text: string; points: number; on: (e: DesignEdge) => boolean }[] = [
  { text: tx('對沖請求'), points: 1, on: (e) => (e.hedgeMs ?? 0) > 0 },
  { text: tx('扇出'), points: 1, on: (e) => (e.fanout ?? 0) > 1 },
  { text: tx('降級回應'), points: 1, on: (e) => e.fallback === 'on' },
  { text: tx('隔艙'), points: 1, on: (e) => (e.bulkhead ?? 0) > 0 },
  { text: tx('自我限流'), points: 1, on: (e) => (e.throttleK ?? 0) > 0 },
  { text: tx('重試預算'), points: 1, on: (e) => (e.retryBudget ?? 0) > 0 },
];

/** A design in more than one region costs this much more. */
export const MULTI_REGION_POINTS = 5;

export interface PointItem {
  /** A node id or edge "from->to"; '' for the whole design. */
  where: string;
  text: string;
  points: number;
}

export function complexity(design: Design): { total: number; items: PointItem[] } {
  const items: PointItem[] = [];
  for (const n of design.nodes) {
    const kp = KIND_POINTS[n.kind] ?? 1;
    if (kp) items.push({ where: n.id, text: n.kind, points: kp });
    const p = resolveParams(n.kind, n.params) as Record<string, unknown>;
    for (const m of NODE_MECHANISMS) if (m.on(p, n)) items.push({ where: n.id, text: m.text, points: m.points });
  }
  for (const e of design.edges) for (const m of EDGE_MECHANISMS) if (m.on(e)) items.push({ where: `${e.from}->${e.to}`, text: m.text, points: m.points });
  const regions = new Set(design.nodes.flatMap((n) => [n.region, n.replicaRegion]).filter((r): r is string => !!r));
  if (regions.size > 1) items.push({ where: '', text: tx('多區域'), points: MULTI_REGION_POINTS });
  return { total: items.reduce((s, i) => s + i.points, 0), items };
}

export interface Problem {
  id: string;
  title: string;
  /** The story: who builds it, the deadline, what it must do. */
  text: string;
  /** The starting design (an example) and the scenario the runs are judged on. */
  example: string;
  scenario: Scenario;
  /** Changes to the example that make the starting design. */
  start: Patch[];
  limits: { maxErrorRate: number; maxP99Ms: number; budgetPerMonth: number; maxPoints: number };
  hint: string;
  /** A design that meets every limit (the tests check it), and the obvious one that does not. */
  solution: Patch[];
  naive: Patch[];
}

const problemFiles = import.meta.glob('../../examples/practice/constraints/*.json', { eager: true, import: 'default' });
export const PROBLEMS: Problem[] = loadPracticeList(problemFiles, parseProblem);

export const PROBLEM_BY_ID: Record<string, Problem> = Object.fromEntries(PROBLEMS.map((p) => [p.id, p]));

export interface Check {
  id: 'errors' | 'p99' | 'budget' | 'points';
  ok: boolean;
  value: number;
  limit: number;
}

export interface ProblemVerdict {
  passed: boolean;
  checks: Check[];
  cost: Cost;
  points: { total: number; items: PointItem[] };
  /** 50–100 when passed (the cheaper, the higher); 0 when not. */
  score: number;
  /** What the problem gives and the design changed (a faster part, a removed component). A gate. */
  broken: Broken[];
}

/** A reason to show: a message to translate with its values. */
export interface Broken {
  text: string;
  vars: Record<string, string | number>;
}

/** Custom services in a design: not allowed in practice problems (Q20), as they can be made as fast as wanted. */
export function customUsed(d: Design): Broken[] {
  return d.nodes.filter((n) => n.kind === CUSTOM_KIND).map((n) => ({ text: tx('練習題不能用自訂服務：「{name}」'), vars: { name: n.label ?? n.id } }));
}

/** Judge a run against the four limits: they are gates; past them, a cheaper design scores higher. */
export function judgeLimits(limits: Problem['limits'], design: Design, run: { result: SimResult; windows: WindowStat[] }): ProblemVerdict {
  const cost = costOf(design, run);
  const points = complexity(design);
  const s = run.result.summary;
  const checks: Check[] = [
    { id: 'errors', ok: s.errorRate <= limits.maxErrorRate, value: s.errorRate, limit: limits.maxErrorRate },
    { id: 'p99', ok: s.latencyMs.p99 <= limits.maxP99Ms, value: s.latencyMs.p99, limit: limits.maxP99Ms },
    { id: 'budget', ok: cost.perMonth <= limits.budgetPerMonth, value: cost.perMonth, limit: limits.budgetPerMonth },
    { id: 'points', ok: points.total <= limits.maxPoints, value: points.total, limit: limits.maxPoints },
  ];
  const passed = checks.every((c) => c.ok);
  const score = passed ? 50 + Math.round((50 * (limits.budgetPerMonth - cost.perMonth)) / limits.budgetPerMonth) : 0;
  return { passed, checks, cost, points, score, broken: [] };
}

/** Times that the problem gives: how fast the code and the machines are. A smaller value is not a design. */
const GIVEN_TIMES: [key: string, unit: string][] = [['serviceMs', 'ms'], ['readMs', 'ms'], ['writeMs', 'ms'], ['bootS', 's']];
const meanOf = (v: unknown): number | undefined => (typeof v === 'number' ? v : v && typeof v === 'object' && 'mean' in v ? (v as { mean: number }).mean : undefined);
const valueOf = (n: DesignNode, key: string): unknown => n.params?.[key] ?? KINDS[n.kind]?.params[key]?.default;

/**
 * What a problem gives, against the design it starts from: every component is still there and
 * still gets requests (no way round the system, e.g. a weight-0 connection out of the users),
 * no part is faster, no machine starts faster, and no cache hits more often.
 */
export function brokenStart(start: Design, design: Design, result: SimResult): Broken[] {
  const out: Broken[] = customUsed(design);
  const now = new Map(design.nodes.map((n) => [n.id, n]));
  for (const o of start.nodes) {
    const n = now.get(o.id);
    const name = o.label ?? o.id;
    if (!n || n.kind !== o.kind) {
      out.push({ text: tx('題目給的「{name}」不見了'), vars: { name } });
      continue;
    }
    if (o.kind !== 'client' && !(result.nodes[o.id]?.arrivals > 0)) out.push({ text: tx('「{name}」沒有收到任何請求：不能繞過原本的元件'), vars: { name } });
    const spec = KINDS[n.kind];
    for (const [k, unit] of GIVEN_TIMES) {
      const floor = meanOf(valueOf(o, k));
      const got = meanOf(valueOf(n, k));
      if (floor === undefined || got === undefined || got >= floor) continue;
      out.push({ text: unit === 's' ? tx('「{name}」的{what}是 {got} 秒，題目給的最快是 {floor} 秒') : tx('「{name}」的{what}是 {got} ms，題目給的最快是 {floor} ms'), vars: { name, what: spec?.params[k]?.label ?? k, got, floor } });
    }
    const was = valueOf(o, 'hitRatio');
    const hit = valueOf(n, 'hitRatio');
    if (typeof was === 'number' && typeof hit === 'number' && hit > was) out.push({ text: tx('「{name}」的{what}是 {got}，題目給的最高是 {floor}'), vars: { name, what: spec?.params.hitRatio?.label ?? 'hitRatio', got: hit, floor: was } });
  }
  return out;
}

/** Judge one run of a problem. `start`: the design the problem starts from (the example with the problem's patches). */
export function judgeProblem(p: Problem, design: Design, run: { result: SimResult; windows: WindowStat[] }, start?: Design): ProblemVerdict {
  const v = judgeLimits(p.limits, design, run);
  const broken = start ? brokenStart(start, design, run.result) : [];
  return broken.length ? { ...v, passed: false, score: 0, broken } : v;
}
