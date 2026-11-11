// Constraint problems (M8, Q11=A, Q12=A): meet the error rate and p99 targets inside a budget and a
// complexity limit. People and time cannot be simulated, so a small team and a short deadline become
// fewer complexity points: each component and each mechanism costs points to build and run.
// Pure functions: no React, no DOM.
import { tx } from '../i18n/index.ts';
import type { SimResult, WindowStat } from '../engine/index.ts';
import type { Design, DesignEdge, DesignNode, Scenario } from '../schema/design.ts';
import { resolveParams } from '../schema/kinds.ts';
import { costOf, type Cost } from './cost.ts';
import type { Patch } from './oncall.ts';

/** Points to build and run one component of a kind. */
export const KIND_POINTS: Record<string, number> = {
  client: 0,
  dns: 0,
  cdn: 1,
  api_gateway: 1,
  load_balancer: 1,
  rate_limiter: 1,
  service: 1,
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

const sc = (name: string, traffic: Scenario['traffic'], events: Scenario['events'] = [], o: { durationS?: number; seed?: number; warmupS?: number } = {}): Scenario => ({
  schema: 'loadsketch/scenario@1',
  name,
  seed: o.seed ?? 1,
  durationS: o.durationS ?? 60,
  warmupS: o.warmupS ?? 5,
  traffic,
  ...(events.length ? { events } : {}),
});

const NO_RETRIES: Patch[] = [
  { edge: 'lb->api', set: { retries: 0 } },
  { edge: 'api->cache', set: { retries: 0 } },
  { edge: 'api->db', set: { retries: 0 } },
];

export const PROBLEMS: Problem[] = [
  {
    id: 'spike-budget',
    title: tx('尖峰，但預算有限'),
    text: tx('3 人團隊，一個月。平常每秒 300 個請求；第 2 分鐘起有 2 分鐘變成 3 倍。目前固定 2 台 API Server，尖峰時大量失敗。整場失敗率 ≤ 1%、p99 ≤ 500 ms，每月不超過 $800，複雜度不超過 6 點。'),
    example: 'autoscale',
    scenario: sc(tx('限制：尖峰 3 倍'), { rps: 300, readRatio: 0.9, clientTimeoutMs: 2000 }, [{ type: 'spike', atS: 120, forS: 120, multiplier: 3 }], { durationS: 600 }),
    start: [{ node: 'api', params: { autoscale: 'off' } }],
    limits: { maxErrorRate: 0.01, maxP99Ms: 500, budgetPerMonth: 800, maxPoints: 6 },
    hint: tx('固定開到尖峰需要的台數，平常時段就在浪費錢。打開自動擴充，並把檢查間隔和開機時間調短，讓它趕得上尖峰。'),
    solution: [{ node: 'api', params: { autoscale: 'on', instances: 3, scaleEveryS: 10, bootS: 15, scaleDownS: 30 } }],
    naive: [{ node: 'api', params: { autoscale: 'off', instances: 6 } }],
  },
  {
    id: 'retry-budget',
    title: tx('重試風暴，兩人團隊'),
    text: tx('2 人團隊，兩週。每秒 600 個請求，第 20 秒起有 10 秒變成 3 倍；每一跳都重試 3 次，系統被重試塞爆，之後也沒有恢復。整場失敗率 ≤ 1%、p99 ≤ 300 ms，每月不超過 $850，複雜度不超過 7 點。'),
    example: 'retry-storm',
    scenario: sc(tx('限制：重試風暴'), { rps: 600, readRatio: 0.9, clientTimeoutMs: 1000 }, [{ type: 'spike', atS: 20, forS: 10, multiplier: 3 }], { durationS: 90, seed: 3, warmupS: 0 }),
    start: [],
    limits: { maxErrorRate: 0.01, maxP99Ms: 300, budgetPerMonth: 850, maxPoints: 7 },
    hint: tx('加機器能撐住，但超出預算；每一跳加重試預算又超出點數。先拿掉放大流量的重試，再把每台 API Server 的同時處理數調大一點（比加一台便宜）。'),
    solution: [...NO_RETRIES, { node: 'api', params: { concurrency: 8 } }],
    naive: [{ node: 'api', params: { instances: 6 } }],
  },
  {
    id: 'solo-shortener',
    title: tx('一個人顧的短網址'),
    text: tx('1 人，一週上線。每秒 4000 個請求，95% 是讀取。現在的資料庫撐不住，一成以上的請求失敗。整場失敗率 ≤ 1%、p99 ≤ 200 ms，每月不超過 $2,800，複雜度不超過 6 點：一個人顧不了讀副本。'),
    example: 'url-shortener',
    scenario: sc(tx('限制：每秒 4000'), { rps: 4000, readRatio: 0.95 }),
    start: [],
    limits: { maxErrorRate: 0.01, maxP99Ms: 200, budgetPerMonth: 2800, maxPoints: 6 },
    hint: tx('加讀副本最直覺，但多 1 點，也比較貴。拿掉副本，把主庫的連線數調大：快取已經擋掉大部分讀取，主庫只要接得住沒命中的那些。'),
    solution: [{ node: 'db', params: { replicas: 0, connections: 32 } }],
    naive: [{ node: 'db', params: { replicas: 3 } }],
  },
];

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
}

/** Judge one run of a problem: the targets are gates; past them, a cheaper design scores higher. */
export function judgeProblem(p: Problem, design: Design, run: { result: SimResult; windows: WindowStat[] }): ProblemVerdict {
  const cost = costOf(design, run);
  const points = complexity(design);
  const s = run.result.summary;
  const checks: Check[] = [
    { id: 'errors', ok: s.errorRate <= p.limits.maxErrorRate, value: s.errorRate, limit: p.limits.maxErrorRate },
    { id: 'p99', ok: s.latencyMs.p99 <= p.limits.maxP99Ms, value: s.latencyMs.p99, limit: p.limits.maxP99Ms },
    { id: 'budget', ok: cost.perMonth <= p.limits.budgetPerMonth, value: cost.perMonth, limit: p.limits.budgetPerMonth },
    { id: 'points', ok: points.total <= p.limits.maxPoints, value: points.total, limit: p.limits.maxPoints },
  ];
  const passed = checks.every((c) => c.ok);
  const score = passed ? 50 + Math.round((50 * (p.limits.budgetPerMonth - cost.perMonth)) / p.limits.budgetPerMonth) : 0;
  return { passed, checks, cost, points, score };
}

