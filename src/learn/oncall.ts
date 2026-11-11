// On-call mode (M7, Q7–Q9): a hidden fault in a known example. The learner sees only what users
// see (error rate and p99 each second), pays points to open a component's own metrics, picks the
// component and the kind of fault, and then fixes the design on the canvas for more points.
// Pure functions: no React, no DOM.
import { tx } from '../i18n/index.ts';
import type { WindowStat } from '../engine/index.ts';
import type { Design, Scenario } from '../schema/design.ts';
import { KINDS } from '../schema/kinds.ts';
import { settled } from './metrics.ts';

/** What went wrong. `gray`: only one instance; `traffic`: the users sent much more (node: the client). */
export type Fault = 'down' | 'slow' | 'errors' | 'gray' | 'pause' | 'traffic';

export const FAULTS: { id: Fault; text: string }[] = [
  { id: 'down', text: tx('整個元件故障（不回應）') },
  { id: 'slow', text: tx('整個元件變慢') },
  { id: 'errors', text: tx('整個元件回錯誤') },
  { id: 'gray', text: tx('只有一台實例出問題，其他台正常') },
  { id: 'pause', text: tx('定期停頓（GC）') },
  { id: 'traffic', text: tx('流量暴增') },
];

/** A change to the design: params of a node, or fields of an edge ("from->to"). */
export type Patch = { node: string; params: Record<string, unknown> } | { edge: string; set: Record<string, unknown> };

export interface Incident {
  id: string;
  /** The page the learner gets: symptoms only, never the cause. */
  title: string;
  /** The example design the incident runs on. */
  example: string;
  /** Traffic and the hidden fault (events). */
  scenario: Scenario;
  answer: { node: string; fault: Fault };
  /** Shown after the answer: what happened and why the symptoms looked like that. */
  explain: string;
  /** How to fix it in the design (shown after the answer). */
  hint: string;
  /** A fix that is known to work (the tests check it; the learner may find another). */
  solution: Patch[];
  /** The fixed design passes when the whole run is at most this bad. */
  fixGoal: { maxErrorRate: number; maxP99Ms?: number };
}

const sc = (name: string, rps: number, readRatio: number, events: Scenario['events']): Scenario => ({
  schema: 'loadsketch/scenario@1',
  name,
  seed: 1,
  durationS: 60,
  warmupS: 5,
  traffic: { rps, readRatio },
  events,
});

export const INCIDENTS: Incident[] = [
  {
    id: 'gray-errors',
    title: tx('值班告警：第 20 秒起，大約三分之一的使用者請求失敗。延遲沒變。'),
    example: 'three-tier',
    scenario: sc(tx('值班：失敗三分之一'), 400, 0.9, [{ type: 'errors', atS: 20, node: 'api', instance: 1, rate: 0.9 }]),
    answer: { node: 'api', fault: 'gray' },
    explain: tx('API Server 3 台裡的第 2 台（#1）有九成請求回錯誤，另外 2 台正常。負載平衡器預設只看實例有沒有活著（它活著），所以照樣把三分之一的請求送給它。打開 API Server 的指標，每台的使用率差不多，但失敗數升高：問題在單台，不在整體容量。'),
    hint: tx('在負載平衡器打開 outlier detection（看回應自動剔除出錯的實例）。'),
    solution: [{ node: 'lb', params: { outlier: 'on' } }],
    fixGoal: { maxErrorRate: 0.01 },
  },
  {
    id: 'slow-dependency',
    title: tx('值班告警：第 20 秒起，大部分請求失敗，p99 升到約 3 秒。'),
    example: 'slow-dependency',
    scenario: sc(tx('值班：大部分失敗'), 1500, 0.9, [{ type: 'slow', atS: 20, node: 'recs', multiplier: 30 }]),
    answer: { node: 'recs', fault: 'slow' },
    explain: tx('推薦服務（recs）整個變慢 30 倍。API 每個請求都要等它，逾時 1 秒；等待中的請求佔住 API 的槽，API 的佇列滿了，連不需要推薦的請求也一起失敗。API 的使用率很高，但它是受害者：佔住它的是在等 recs 的請求。'),
    hint: tx('把 API → recs 的逾時調短（例如 100 ms），並打開降級回應：推薦拿不到就先回沒有推薦的頁面。'),
    solution: [{ edge: 'api->recs', set: { timeoutMs: 100, fallback: 'on' } }],
    fixGoal: { maxErrorRate: 0.01 },
  },
  {
    id: 'db-slow',
    title: tx('值班告警：第 20 秒起，三到四成的請求失敗，p99 升到約 3 秒。'),
    example: 'three-tier',
    scenario: sc(tx('值班：失敗又變慢'), 400, 0.9, [{ type: 'slow', atS: 20, node: 'db', multiplier: 20 }]),
    answer: { node: 'db', fault: 'slow' },
    explain: tx('資料庫整個變慢 20 倍。快取沒命中的讀取和全部寫入都要等它，等到 API → db 的逾時（500 ms）就失敗；等待的請求佔住 API 的槽，後面的請求跟著排隊。打開資料庫的指標：使用率和排隊數都比之前高很多，但它自己沒有失敗（放棄的是呼叫它的 API）。'),
    hint: tx('資料庫變慢了，但沒有壞，也沒有滿。失敗是因為 500 ms 的逾時現在比一次寫入還短，而且在等的請求佔滿 API 的槽。把 API Server 的同時處理數調大（例如 64），並把逾時放寬到等得到回應（API → db 3 秒，負載平衡器 → API 4 秒）：使用者會變慢，但不會失敗。另一個做法：API → db 的逾時調短，並打開降級回應。'),
    solution: [
      { node: 'api', params: { concurrency: 64 } },
      { edge: 'api->db', set: { timeoutMs: 3000 } },
      { edge: 'lb->api', set: { timeoutMs: 4000 } },
    ],
    fixGoal: { maxErrorRate: 0.02 },
  },
  {
    id: 'gray-slow',
    title: tx('值班告警：第 20 秒起，大約一成的請求失敗，p99 小幅上升。'),
    example: 'hedged-reads',
    scenario: sc(tx('值班：失敗一成'), 400, 0.95, [{ type: 'slow', atS: 20, node: 'api', instance: 2, multiplier: 60 }]),
    answer: { node: 'api', fault: 'gray' },
    explain: tx('API Server 4 台裡的第 3 台（#2）變慢 60 倍，其他台正常。負載平衡器輪流送，所以四分之一的請求送到慢的那台。對沖請求在 40 ms 後把讀取再送一份到別台，但不會取消慢的那台上的第一份；它的佇列很快就滿了。佇列滿了之後，送過去的請求立刻被拒絕，比對沖的 40 ms 還快，所以對沖救不到。寫入不做對沖，也救不到。打開 API Server 的指標：一台使用率滿了，其他台很閒。'),
    hint: tx('把負載平衡器的策略改成最少連線（least connections）：慢的那台連線多，就少送給它。'),
    solution: [{ node: 'lb', params: { policy: 'least_conn' } }],
    fixGoal: { maxErrorRate: 0.01 },
  },
  {
    id: 'gc-pause',
    title: tx('值班告警：第 20 秒起，p99 從約 80 ms 跳到約 450 ms。沒有失敗。'),
    example: 'sharded',
    scenario: sc(tx('值班：長尾變慢'), 600, 0.8, [{ type: 'pause', atS: 20, node: 'api', everyS: 2, pauseMs: 400 }]),
    answer: { node: 'api', fault: 'pause' },
    explain: tx('API Server 每 2 秒停頓 400 ms（stop-the-world GC）。停頓時它什麼都不做，剛好在那時進來的請求要等停頓結束，所以 p50 幾乎不變，p99 跳到約 400 ms 以上。使用率平均下來不高，看平均看不出來。'),
    hint: tx('在負載平衡器 → API 打開對沖請求（例如 60 ms）：讀取等超過 60 ms 沒有回應，就再送一份到另一台。對沖只用在讀取；寫入重送可能寫兩次，所以不要用短逾時加重試來處理。'),
    solution: [{ edge: 'lb->api', set: { hedgeMs: 60 } }],
    fixGoal: { maxErrorRate: 0.01, maxP99Ms: 250 },
  },
  {
    id: 'traffic-spike',
    title: tx('值班告警：第 20 秒起，大約一成的請求失敗，p99 升到約 750 ms。'),
    example: 'url-shortener',
    scenario: sc(tx('值班：失敗一成又變慢'), 1000, 0.95, [{ type: 'spike', atS: 20, multiplier: 4 }]),
    answer: { node: 'users', fault: 'traffic' },
    explain: tx('沒有元件壞掉：使用者的流量在第 20 秒變成 4 倍。API 和資料庫接不下，排隊變長、逾時增加。打開「使用者」看每秒送出的請求數，就看得出來。'),
    hint: tx('加容量：API Server 加到 12 台，資料庫連線加到 32。'),
    solution: [
      { node: 'api', params: { instances: 12 } },
      { node: 'db', params: { connections: 32 } },
    ],
    fixGoal: { maxErrorRate: 0.01 },
  },
  {
    id: 'db-errors',
    title: tx('值班告警：第 20 秒起，大約 14% 的請求失敗。延遲沒變。'),
    example: 'async-queue',
    scenario: sc(tx('值班：失敗但不慢'), 300, 0.7, [{ type: 'errors', atS: 20, node: 'db', rate: 0.2 }]),
    answer: { node: 'db', fault: 'errors' },
    explain: tx('資料庫有兩成的請求回錯誤（例如連線被重設），每台都一樣。錯誤很快就回來，所以延遲不變，只有失敗率升高。使用者看到的是讀取失敗。worker 寫入資料庫也有兩成失敗：那些背景工作沒有做完，但使用者的失敗率看不出來，要打開佇列的指標才看得到。'),
    hint: tx('偶發的錯誤用重試擋：API → db 和 worker → db 都設 2 次重試。只修 API 那一條，背景工作還是會掉兩成。'),
    solution: [
      { edge: 'api->db', set: { retries: 2 } },
      { edge: 'thumb->db', set: { retries: 2 } },
    ],
    fixGoal: { maxErrorRate: 0.01 },
  },
  {
    id: 'cache-down',
    title: tx('值班告警：第 20 秒起，幾乎所有請求都失敗，之後一直沒有恢復。'),
    example: 'retry-storm',
    scenario: sc(tx('值班：全部失敗'), 400, 0.9, [{ type: 'down', atS: 20, node: 'cache' }]),
    answer: { node: 'cache', fault: 'down' },
    explain: tx('快取整個故障。讀取會改讀資料庫，資料庫接得住（使用率不到一成）。問題在 API → 快取的重試：每個讀取先對壞掉的快取重試 3 次，每次還要等退避時間，這段時間一直佔住 API 的槽。API 的槽被佔滿，負載平衡器 → API 開始逾時並重試，請求數被放大（重試風暴），之後一直恢復不了。API Server 看起來最忙，但它是受害者。'),
    hint: tx('不要對快取重試：把 API → 快取的重試設成 0 次。快取拿不到就當作沒命中，直接讀資料庫，資料庫撐得住。'),
    solution: [{ edge: 'api->cache', set: { retries: 0 } }],
    fixGoal: { maxErrorRate: 0.01 },
  },
];

export const INCIDENT_BY_ID: Record<string, Incident> = Object.fromEntries(INCIDENTS.map((i) => [i.id, i]));

/** Points: the component, the kind of fault, the fix; each opened component costs. */
export const POINTS = { node: 40, fault: 30, fix: 30, open: -10 } as const;

export interface Score {
  node: boolean;
  fault: boolean;
  fixed: boolean;
  opened: number;
  total: number;
}

export function score(inc: Incident, guess: { node: string; fault: Fault }, opened: number, fixed: boolean): Score {
  const node = guess.node === inc.answer.node;
  const fault = guess.fault === inc.answer.fault;
  const total = Math.max(0, (node ? POINTS.node : 0) + (fault ? POINTS.fault : 0) + (fixed ? POINTS.fix : 0) + opened * POINTS.open);
  return { node, fault, fixed, opened, total };
}

/** What users see each second: the share of settled requests that failed, and p99 (ms). */
export interface Symptom {
  t: number;
  errorRate: number;
  /** null: no request succeeded this second (no p99 to show). */
  p99: number | null;
}

export function symptoms(windows: WindowStat[]): Symptom[] {
  return windows.map((w) => {
    const n = settled(w);
    return { t: w.t, errorRate: n ? (n - w.ok) / n : 0, p99: w.latency.count ? w.latency.p99 : null };
  });
}

/** One component's own numbers each second (shown after the learner pays to open it). */
export interface NodeSample {
  t: number;
  /** The client: requests sent this second. Others: requests that arrived. */
  rps: number;
  util?: number;
  queue?: number;
  fail: number;
  /** Busy share of each instance, when the node has several. */
  instUtil?: number[];
}

export function nodeSamples(windows: WindowStat[], design: Design, id: string): NodeSample[] {
  const client = design.nodes.find((n) => n.id === id)?.kind === 'client';
  return windows.map((w) => {
    const nw = w.nodes[id];
    const dt = w.dt || 1;
    if (client) return { t: w.t, rps: w.offered / dt, fail: nw?.fail ?? 0 };
    return {
      t: w.t,
      rps: (nw?.arrivals ?? 0) / dt,
      ...(nw?.util !== undefined ? { util: nw.util } : {}),
      ...(nw?.queue !== undefined ? { queue: nw.queue } : nw?.depth !== undefined ? { queue: nw.depth } : {}),
      fail: nw?.fail ?? 0,
      ...(nw?.instUtil && nw.instUtil.length > 1 ? { instUtil: nw.instUtil } : {}),
    };
  });
}

/** The design with the patches applied (a copy). Unknown nodes or edges are left out. */
export function applyPatches(design: Design, patches: Patch[]): Design {
  const d = structuredClone(design);
  for (const p of patches) {
    if ('node' in p) {
      const n = d.nodes.find((x) => x.id === p.node);
      if (n) n.params = { ...(n.params ?? {}), ...(p.params as typeof n.params) };
    } else {
      const [from, to] = p.edge.split('->');
      const e = d.edges.find((x) => x.from === from && x.to === to);
      if (e) Object.assign(e, p.set);
    }
  }
  return d;
}

/**
 * The learner's fix: every component of the incident's design is still there and still gets
 * requests (a fix may not route around the system, e.g. with a weight-0 edge out of the client),
 * no cache hits more often than before (the hit ratio comes from the traffic; nobody sets it
 * during an incident), background work is not lost (`lost`: the share of queued jobs that failed
 * for good is above the error-rate goal), and the run meets the goal.
 */
export function judgeFix(
  inc: Incident,
  original: Design,
  fixed: Design,
  result: { summary: { errorRate: number; latencyMs: { p99: number } }; nodes: Record<string, { arrivals: number; asyncFail?: number }> },
): { ok: boolean; missing: string[]; idle: string[]; raised: string[]; lost: boolean } {
  const have = new Set(fixed.nodes.map((n) => n.id));
  const missing = original.nodes.map((n) => n.id).filter((id) => !have.has(id));
  const idle = original.nodes.filter((n) => have.has(n.id) && !(result.nodes[n.id]?.arrivals > 0)).map((n) => n.id);
  const hit = (n: Design['nodes'][number]) => (typeof n.params?.hitRatio === 'number' ? n.params.hitRatio : (KINDS[n.kind]?.params.hitRatio?.default as number | undefined));
  const raised = original.nodes
    .filter((o) => {
      const n = fixed.nodes.find((x) => x.id === o.id);
      const a = hit(o);
      const b = n && hit(n);
      return a !== undefined && b !== undefined && b > a;
    })
    .map((n) => n.id);
  const g = inc.fixGoal;
  const jobs = Object.values(result.nodes).filter((n) => n.asyncFail !== undefined);
  const lost = jobs.reduce((x, n) => x + (n.asyncFail ?? 0), 0) > g.maxErrorRate * jobs.reduce((x, n) => x + n.arrivals, 0);
  const ok = missing.length === 0 && idle.length === 0 && raised.length === 0 && !lost && result.summary.errorRate <= g.maxErrorRate && (g.maxP99Ms === undefined || result.summary.latencyMs.p99 <= g.maxP99Ms);
  return { ok, missing, idle, raised, lost };
}
