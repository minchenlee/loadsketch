// Design briefs: a problem that starts from requirements, not from a finished design. The canvas
// holds only what is given (the users, sometimes an outside service); the learner builds the rest.
// A run of the brief's scenario is judged on the same four limits as a constraint problem, plus:
//   - needs: things the design must have to do the job at all (data is stored, work is finished);
//   - givens: how fast each part is. A part cannot be made faster than the brief says, or every
//     brief is solved by typing a smaller number.
// The simulator cannot judge the questions a person asks about the requirements, the API or the
// data model. The brief states those, and tests the architecture.
// Pure functions: no React, no DOM.
import { tx } from '../i18n/index.ts';
import type { SimResult, WindowStat } from '../engine/index.ts';
import { DESIGN_SCHEMA, edgeId, type Design, type DesignEdge, type DesignNode, type ParamValue, type Scenario } from '../schema/design.ts';
import { KINDS } from '../schema/kinds.ts';
import { judgeLimits, type ProblemVerdict } from './constraints.ts';
import { HOURS_PER_MONTH } from './cost.ts';

/**
 * `windows` end with the traffic (what the charts show). `allWindows` also holds the time after
 * it, while queues empty: the needs count on those, so work finished late is still counted.
 */
type Run = { result: SimResult; windows: WindowStat[]; allWindows?: WindowStat[] };

/** Something the design must have or do. `vars` fill the text. */
export interface Need {
  id: string;
  text: string; // message id
  check: (d: Design, run: Run) => boolean;
}

/** A broken given: text (message id) and its variables. */
export interface Broken {
  text: string;
  vars: Record<string, string | number>;
}

export interface Brief {
  id: string;
  title: string;
  /** Who builds it and by when. */
  text: string;
  /** Functional requirements: "users can …". */
  functional: string[];
  /** Non-functional requirements that are not one of the four limits (the load, in words). */
  load: string[];
  /** How fast each part is. */
  given: string[];
  outOfScope: string[];
  scenario: Scenario;
  limits: { maxErrorRate: number; maxP99Ms: number; budgetPerMonth: number; maxPoints: number };
  /** The canvas at the start. */
  start: Design;
  /** Nodes of `start` that are not the learner's to change (an outside service). */
  fixed: string[];
  needs: Need[];
  /** The fastest a part can be, by kind and parameter (mean, ms). Without an entry: the kind's default. */
  floors?: Record<string, Record<string, number>>;
  hint: string;
  /** A design that passes (the tests check it), and the first thing most people draw, which does not. */
  reference: Design;
  naive: Design;
}

export interface BriefVerdict extends ProblemVerdict {
  needs: { id: string; text: string; ok: boolean }[];
  broken: Broken[];
}

// ---------------------------------------------------------------------------------------------
// Givens

/** Parameters that are a time: a smaller mean is a faster part. */
const TIMES = ['serviceMs', 'readMs', 'writeMs', 'opMs', 'getMs', 'putMs', 'edgeMs', 'lookupMs', 'latencyMs', 'enqueueMs', 'coldStartMs'];
/** Parameters that are a share of requests answered without the work: a larger value is a faster part. */
const SHARES = ['hitRatio'];

/** The mean of a time parameter: it is a number, or a distribution with a mean. */
const meanOf = (v: unknown): number | undefined => (typeof v === 'number' ? v : v && typeof v === 'object' && 'mean' in v ? (v as { mean: number }).mean : undefined);
/** One form for a value, so that `5` and `{ mean: 5 }` with the default spread compare equal, in any key order. */
const norm = (v: unknown, def: unknown): string => {
  const full = typeof v === 'number' && def && typeof def === 'object' ? { ...(def as object), mean: v } : v && typeof v === 'object' && def && typeof def === 'object' ? { ...(def as object), ...(v as object) } : v;
  return JSON.stringify(full && typeof full === 'object' ? Object.fromEntries(Object.entries(full).sort(([a], [b]) => (a < b ? -1 : 1))) : full ?? null);
};
/** The settings of a node as the engine sees them: a default written out is the same as one left out. */
const sameSettings = (a: DesignNode, b: DesignNode): boolean => {
  const spec = KINDS[a.kind]?.params ?? {};
  const keys = new Set([...Object.keys(spec), ...Object.keys(a.params ?? {}), ...Object.keys(b.params ?? {})]);
  for (const k of keys) if (norm(value(a, k), spec[k]?.default) !== norm(value(b, k), spec[k]?.default)) return false;
  return true;
};
const value = (n: DesignNode, key: string): ParamValue | undefined => n.params?.[key] ?? (KINDS[n.kind]?.params[key]?.default as ParamValue | undefined);

/** The parts made faster than the brief allows, and given nodes that were changed or removed. */
export function brokenGivens(b: Brief, d: Design): Broken[] {
  const out: Broken[] = [];
  const now = new Map(d.nodes.map((n) => [n.id, n]));
  // APIs replace the scenario's read share, so they would change the load the brief gives
  if (d.apis?.length) out.push({ text: tx('這題的讀寫比例是題目給的，不能用 API 改掉'), vars: {} });
  for (const id of b.fixed) {
    const was = b.start.nodes.find((n) => n.id === id)!;
    const n = now.get(id);
    const name = was.label ?? id;
    if (!n || n.kind !== was.kind) out.push({ text: tx('題目給的「{name}」不見了'), vars: { name } });
    else if (!sameSettings(n, was)) out.push({ text: tx('題目給的「{name}」不能改設定'), vars: { name } });
  }
  for (const n of d.nodes) {
    if (b.fixed.includes(n.id)) continue;
    const spec = KINDS[n.kind];
    if (!spec) continue;
    const name = n.label ?? n.id;
    for (const k of TIMES) {
      const def = meanOf(spec.params[k]?.default);
      const got = meanOf(value(n, k));
      if (def === undefined || got === undefined) continue;
      const floor = b.floors?.[n.kind]?.[k] ?? def;
      if (got < floor) out.push({ text: tx('「{name}」的{what}是 {got} ms，題目給的最快是 {floor} ms'), vars: { name, what: spec.params[k].label ?? k, got, floor } });
    }
    for (const k of SHARES) {
      const def = spec.params[k]?.default;
      const got = value(n, k);
      if (typeof def !== 'number' || typeof got !== 'number') continue;
      if (got > def) out.push({ text: tx('「{name}」的{what}是 {got}，題目給的最高是 {floor}'), vars: { name, what: spec.params[k].label ?? k, got, floor: def } });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Needs

/** Node ids a request from a client can reach along the connections. */
export function reachable(d: Design): Set<string> {
  const next = new Map<string, string[]>();
  for (const e of d.edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const seen = new Set(d.nodes.filter((n) => n.kind === 'client').map((n) => n.id));
  const todo = [...seen];
  while (todo.length) {
    for (const to of next.get(todo.pop()!) ?? []) {
      if (!seen.has(to)) {
        seen.add(to);
        todo.push(to);
      }
    }
  }
  return seen;
}

const reaches = (d: Design, kinds: string[]) => {
  const r = reachable(d);
  return d.nodes.some((n) => kinds.includes(n.kind) && r.has(n.id));
};

/**
 * The writes (or reads) users send arrive at these nodes. A line on the canvas is not enough: an
 * edge can carry reads only, and a queue can lose messages. Counted on the connections, over the
 * whole run: calls that go into the nodes, against calls that leave the users (3% is still on the way).
 * It counts calls, not requests: a design that sends one request twice and drops another is not
 * found. The check is there for an honest mistake, not to stop someone who wants to cheat.
 */
function arrive(op: 'read' | 'write', d: Design, run: Run, into: (n: DesignNode) => boolean): boolean {
  const [out, arrived] = calls(op, d, run, into);
  return out > 0 && arrived >= 0.97 * out;
}

/** Calls of one kind that leave the users, and those that go into the chosen nodes, over the whole run. */
function calls(op: 'read' | 'write', d: Design, run: Run, into: (n: DesignNode) => boolean): [out: number, arrived: number] {
  const kind = new Map(d.nodes.map((n) => [n.id, n]));
  const sent = new Set<string>();
  const got = new Set<string>();
  for (const e of d.edges) {
    if (kind.get(e.from)?.kind === 'client') sent.add(edgeId(e));
    const to = kind.get(e.to);
    if (to && into(to)) got.add(edgeId(e));
  }
  let out = 0;
  let arrived = 0;
  for (const w of run.allWindows ?? run.windows) {
    for (const [id, e] of Object.entries(w.edges)) {
      if (sent.has(id)) out += e[op];
      if (got.has(id)) arrived += e[op];
    }
  }
  return [out, arrived];
}

/** What users write is stored in a database. */
const stored: Need = { id: 'stored', text: tx('資料有存進資料庫'), check: (d, run) => reaches(d, ['database', 'sharded_db']) && arrive('write', d, run, (n) => n.kind === 'database' || n.kind === 'sharded_db') };

/** What users read comes from somewhere: a cache or a database. An API with no store behind its reads answers with nothing. */
const looked: Need = {
  id: 'looked',
  text: tx('讀取有查到資料（快取或資料庫）'),
  check: (d, run) => {
    // a read put on a queue is answered before anything was looked up
    const [out, queued] = calls('read', d, run, (n) => n.kind === 'queue');
    return queued <= 0.01 * out && arrive('read', d, run, (n) => ['cache', 'database', 'sharded_db'].includes(n.kind));
  },
};

/**
 * Background work is finished: what still waits at the end, and what was lost on the way (a message
 * past its time to live, a delivery that failed), is at most 1% of the requests.
 */
const finished: Need = {
  id: 'finished',
  text: tx('背景工作做得完（沒做完和弄丟的不超過 1%）'),
  check: (_, run) => run.result.unfinished + Object.values(run.result.nodes).reduce((s, n) => s + (n.asyncFail ?? 0), 0) <= 0.01 * Math.max(1, run.result.summary.offered),
};

/**
 * A degraded answer is not the real one: at most 1% of the requests. Background work that fell back
 * (a worker's call that failed and was answered by a fallback) counts too: the summary has only
 * the answers users got, so the fallbacks on every connection are counted as well.
 */
const notDegraded: Need = {
  id: 'not-degraded',
  text: tx('降級回應不超過 1%'),
  check: (_, run) => {
    const max = 0.01 * Math.max(1, run.result.summary.offered);
    const fallbacks = Object.values(run.result.edges).reduce((s, e) => s + (e.fallbacks ?? 0), 0);
    return (run.result.summary.degraded ?? 0) <= max && fallbacks <= max;
  },
};

const reachesNode = (id: string, text: string): Need => ({ id: `reaches-${id}`, text, check: (d, run) => reachable(d).has(id) && arrive('write', d, run, (n) => n.id === id) });

// ---------------------------------------------------------------------------------------------
// Briefs

const sc = (name: string, traffic: Scenario['traffic'], events: Scenario['events'] = [], o: { durationS?: number; seed?: number; warmupS?: number } = {}): Scenario => ({
  schema: 'loadsketch/scenario@1',
  name,
  seed: o.seed ?? 1,
  durationS: o.durationS ?? 60,
  warmupS: o.warmupS ?? 5,
  traffic,
  ...(events.length ? { events } : {}),
});

type N = [id: string, kind: string, label: string, pos: [number, number], params?: DesignNode['params']];
type E = [from: string, to: string, extra?: Omit<DesignEdge, 'from' | 'to'>];

const design = (name: string, nodes: N[], edges: E[] = []): Design => ({
  schema: DESIGN_SCHEMA,
  name,
  nodes: nodes.map(([id, kind, label, pos, params]) => ({ id, kind, label, pos, ...(params ? { params } : {}) })),
  edges: edges.map(([from, to, extra]) => ({ from, to, ...extra })),
});

const USERS: N = ['users', 'client', tx('使用者'), [0, 200]];

const SHORTENER = tx('需求：短網址');
const SALE = tx('需求：限量開賣');
const NOTIFY = tx('需求：簡訊通知');
const SHOP_DB: N = ['db', 'database', tx('公司共用的資料庫'), [1080, 320]];
/** At the start, a given node sits under the users: the brief's card covers the right of the canvas. */
const under = (n: N): N => [n[0], n[1], n[2], [0, 380], n[4]];
const SMS: N = ['sms', 'service', tx('簡訊供應商（外部）'), [1080, 200], { instances: 1, concurrency: 400, serviceMs: { mean: 200, cv: 0.5 }, queueLimit: 2000 }];

export const BRIEFS: Brief[] = [
  {
    id: 'brief-shortener',
    title: SHORTENER,
    text: tx('2 人團隊，一個月後上線。做一個短網址服務。'),
    functional: [tx('使用者能把一個長網址換成短網址'), tx('使用者點短網址，會被帶到原本的網址')],
    load: [tx('每秒 20,000 個請求，95% 是點短網址（讀取），5% 是建立（寫入）')],
    given: [tx('你的程式處理一個請求平均 5 ms'), tx('資料庫讀一筆 3 ms、寫一筆 10 ms'), tx('快取命中率最高 90%')],
    outOfScope: [tx('登入和帳號'), tx('點擊統計'), tx('自訂短碼')],
    scenario: sc(SHORTENER, { rps: 20000, readRatio: 0.95 }, [], { durationS: 30 }),
    limits: { maxErrorRate: 0.01, maxP99Ms: 100, budgetPerMonth: 10600, maxPoints: 6 },
    start: design(SHORTENER, [USERS]),
    fixed: [],
    needs: [stored, looked, notDegraded],
    hint: tx('先估容量。每秒 20,000 個請求 × 每個 5 ms = 同時要處理 100 個，預設的 2 台不夠。讀取每秒 19,000 次 × 3 ms = 57 條連線，資料庫預設只有 50 條。可以把資料庫開大，也可以在前面放快取擋掉九成的讀取；算算哪個便宜。'),
    reference: design(
      SHORTENER,
      [
        USERS,
        ['lb', 'load_balancer', tx('負載平衡器'), [270, 200]],
        ['api', 'service', tx('轉址 API'), [540, 200], { instances: 5 }],
        ['cache', 'cache', tx('快取（短碼 → 網址）'), [810, 80], { instances: 2 }],
        ['db', 'database', tx('網址資料庫'), [810, 320]],
      ],
      [['users', 'lb'], ['lb', 'api'], ['api', 'cache'], ['api', 'db']],
    ),
    naive: design(
      SHORTENER,
      [USERS, ['lb', 'load_balancer', tx('負載平衡器'), [270, 200]], ['api', 'service', tx('轉址 API'), [540, 200]], ['db', 'database', tx('網址資料庫'), [810, 200]]],
      [['users', 'lb'], ['lb', 'api'], ['api', 'db']],
    ),
  },
  {
    id: 'brief-sale',
    title: SALE,
    text: tx('3 人團隊，兩個月後有一檔限量開賣。平常流量不大，開賣的 15 秒會暴增。訂單要寫進公司共用的資料庫，它已經在畫布上。'),
    functional: [tx('使用者能看商品'), tx('使用者能下單；下了單就不能掉')],
    load: [tx('平常每秒 800 個請求，一半是下單（寫入）'), tx('第 20 秒開賣：流量變成 16 倍，持續 15 秒')],
    given: [tx('共用的資料庫有 50 條連線，讀一筆 3 ms、寫一筆 10 ms；它不歸你管，改不了'), tx('你的程式處理一個請求平均 5 ms'), tx('背景工作處理一筆訂單 2 ms，再加上寫資料庫的時間')],
    outOfScope: [tx('付款'), tx('庫存扣到負數的問題'), tx('排隊頁面')],
    scenario: sc(SALE, { rps: 800, readRatio: 0.5 }, [{ type: 'spike', atS: 20, forS: 15, multiplier: 16 }], { durationS: 120 }),
    limits: { maxErrorRate: 0.01, maxP99Ms: 300, budgetPerMonth: 4000, maxPoints: 8 },
    start: design(SALE, [USERS, under(SHOP_DB)]),
    fixed: ['db'],
    needs: [reachesNode('db', tx('訂單有寫進共用的資料庫')), looked, finished, notDegraded],
    floors: { worker: { serviceMs: 2 } },
    hint: tx('開賣時每秒 6,400 筆寫入 × 10 ms = 64 條連線，再加上讀取約 19 條，共用的資料庫只有 50 條，而且改不了。下單可以先進佇列就回應，背景工作再照資料庫吃得下的速度寫進去：尖峰被攤平，只要結束前做得完。背景工作的同時處理數就是它最多佔用的連線數，要留一些給讀取。API Server 也要撐得住尖峰：每秒 12,800 個請求。'),
    reference: design(
      SALE,
      [
        USERS,
        ['lb', 'load_balancer', tx('負載平衡器'), [270, 200]],
        ['api', 'service', tx('商店 API'), [540, 200], { instances: 6 }],
        ['orders', 'queue', tx('訂單佇列'), [810, 80]],
        ['writer', 'worker', tx('寫訂單的背景工作'), [1080, 80], { instances: 3, concurrency: 10, serviceMs: { mean: 2, cv: 1 } }],
        SHOP_DB,
      ],
      [['users', 'lb'], ['lb', 'api'], ['api', 'orders', { on: 'write' }], ['orders', 'writer'], ['writer', 'db'], ['api', 'db', { on: 'read' }]],
    ),
    naive: design(
      SALE,
      [USERS, ['lb', 'load_balancer', tx('負載平衡器'), [270, 200]], ['api', 'service', tx('商店 API'), [540, 200], { instances: 6 }], SHOP_DB],
      [['users', 'lb'], ['lb', 'api'], ['api', 'db']],
    ),
  },
  {
    id: 'brief-notify',
    title: NOTIFY,
    text: tx('2 人團隊，三週。其他團隊呼叫你的 API，你負責把簡訊送出去。簡訊由外部供應商發送，已經在畫布上。'),
    functional: [tx('其他服務能呼叫 API 送出一則簡訊'), tx('每一則都要真的送到簡訊供應商')],
    load: [tx('每秒 500 則，全部是寫入'), tx('呼叫你的服務只等得了 100 ms：API 要很快回應')],
    given: [tx('簡訊供應商送一則平均 200 ms，這個改不了'), tx('你的 API 處理一個請求平均 5 ms'), tx('背景工作處理一則 2 ms，再加上等供應商的時間')],
    outOfScope: [tx('簡訊內容和範本'), tx('供應商出錯時的重送'), tx('送達回報')],
    scenario: sc(NOTIFY, { rps: 500, readRatio: 0 }, [], { durationS: 60 }),
    limits: { maxErrorRate: 0.01, maxP99Ms: 100, budgetPerMonth: 2600, maxPoints: 6 },
    start: design(NOTIFY, [USERS, under(SMS)]),
    fixed: ['sms'],
    needs: [reachesNode('sms', tx('簡訊有送到供應商')), finished, notDegraded],
    floors: { worker: { serviceMs: 2 } },
    hint: tx('API 直接呼叫供應商，每個請求就要等 200 ms，不可能在 100 ms 內回應。把「收下請求」和「送出簡訊」分開：API 把請求放進佇列就回應，背景工作再去呼叫供應商。每秒 500 則 × 200 ms = 同時有 100 則在送，背景工作的同時處理數加起來要超過 100。'),
    reference: design(
      NOTIFY,
      [
        USERS,
        ['api', 'service', tx('通知 API'), [270, 200]],
        ['outbox', 'queue', tx('待送佇列'), [540, 200]],
        ['sender', 'worker', tx('送簡訊的背景工作'), [810, 200], { instances: 4, concurrency: 32, serviceMs: { mean: 2, cv: 1 } }],
        SMS,
      ],
      [['users', 'api'], ['api', 'outbox'], ['outbox', 'sender'], ['sender', 'sms']],
    ),
    naive: design(NOTIFY, [USERS, ['api', 'service', tx('通知 API'), [540, 200], { instances: 4 }], SMS], [['users', 'api'], ['api', 'sms']]),
  },
];

export const BRIEF_BY_ID: Record<string, Brief> = Object.fromEntries(BRIEFS.map((b) => [b.id, b]));

/** Judge one run of a brief: the four limits, the needs and the givens are all gates. */
export function judgeBrief(b: Brief, design: Design, run: Run): BriefVerdict {
  const v = judgeLimits(b.limits, design, run);
  const needs = b.needs.map((n) => ({ id: n.id, text: n.text, ok: n.check(design, run) }));
  const broken = brokenGivens(b, design);
  const passed = v.passed && broken.length === 0 && needs.every((n) => n.ok);
  // Traffic to users and the given nodes cost the same in every design, so the score compares the
  // rest: 100 = nothing but that part, 50 = the whole budget.
  const same = v.cost.items.filter((i) => i.id === 'egress' || b.fixed.includes(i.id)).reduce((s, i) => s + i.perHour * HOURS_PER_MONTH, 0);
  const room = b.limits.budgetPerMonth - same;
  const score = passed ? 50 + Math.round((50 * Math.max(0, b.limits.budgetPerMonth - v.cost.perMonth)) / Math.max(1, room)) : 0;
  return { ...v, passed, score: Math.min(100, score), needs, broken };
}
