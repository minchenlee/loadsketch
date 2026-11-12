// Categories of the bundled examples, for the example browser. An example missing here is shown
// under "Other", so a new example file is never hidden.
import { tx } from '../i18n/index.ts';

/**
 * Two tiers (Q16=A): "start" teaches one mechanism per example; "real" reproduces a public
 * incident or a whole architecture of a well-known service.
 */
export type Tier = 'start' | 'real';

export interface Category {
  id: string;
  label: string; // message id
  tier: Tier;
  examples: string[];
}

export const TIERS: { id: Tier; label: string; help: string }[] = [
  { id: 'start', label: tx('入門'), help: tx('一個範例學一個機制：先從這裡開始。') },
  { id: 'real', label: tx('真實系統'), help: tx('公開事故的重現，和知名服務的完整架構：好幾個機制一起出現。') },
];

export const CATEGORIES: Category[] = [
  { id: 'basics', label: tx('基礎架構'), tier: 'start', examples: ['three-tier', 'sharded', 'replica-lag', 'autoscale', 'hot-shard', 'location-writes', 'scatter-gather', 'quorum', 'custom-search'] },
  { id: 'cache', label: tx('快取'), tier: 'start', examples: ['cache-stampede', 'cache-lease', 'url-shortener', 'cache-cold-restart', 'cdn-offload'] },
  { id: 'overload', label: tx('過載與重試'), tier: 'start', examples: ['retry-storm', 'retry-budget', 'adaptive-throttle', 'priority-shedding', 'tenant-limits', 'lifo-codel', 'flash-sale', 'serverless-db'] },
  { id: 'failure', label: tx('故障與韌性'), tier: 'start', examples: ['resilience', 'slow-dependency', 'bulkhead-fallback', 'gray-failure', 'gray-failure-outlier', 'hedged-reads', 'region-cutover', 'split-brain', 'bad-config-push', 'provisioning', 'blind-autoscaler'] },
  { id: 'async', label: tx('非同步'), tier: 'start', examples: ['async-queue', 'async-reliable', 'order-outbox', 'fifo-poison', 'upload-tasks', 'timeline-fanout'] },
  { id: 'traffic', label: tx('流量型態'), tier: 'start', examples: ['periodic'] },
  // whole architectures of well-known services from their engineering blogs: 12–18 parts
  { id: 'saas', label: tx('真實服務架構'), tier: 'real', examples: ['saas-instagram', 'saas-uber', 'saas-netflix'] },
  // reproductions of public postmortems: 15–20 parts, with the fix to try
  { id: 'incident', label: tx('真實事故重現'), tier: 'real', examples: ['saas-slack', 'saas-stripe', 'saas-linkedin', 'saas-github'] },
];

/** The categories with every example in one of them: unknown ones go to "Other". */
export function categorize(all: string[]): Category[] {
  const known = new Set(CATEGORIES.flatMap((c) => c.examples));
  const cats = CATEGORIES.map((c) => ({ ...c, examples: c.examples.filter((e) => all.includes(e)) })).filter((c) => c.examples.length);
  const other = all.filter((e) => !known.has(e));
  return other.length ? [...cats, { id: 'other', label: tx('其他'), tier: 'start' as const, examples: other }] : cats;
}

/**
 * Examples that come in pairs (roadmap-next M3, Q10=A): the problem first, then the same system
 * with the fix. Both run the same scenario, so the compare view shows what the fix changes.
 */
export const PAIRS: [problem: string, fix: string][] = [
  ['retry-storm', 'retry-budget'],
  ['cache-stampede', 'cache-lease'],
  ['gray-failure', 'gray-failure-outlier'],
  ['slow-dependency', 'bulkhead-fallback'],
];

/** The pair an example is in, the problem first; null when it is in none. */
export function pairOf(example: string): [string, string] | null {
  return PAIRS.find((p) => p.includes(example)) ?? null;
}
