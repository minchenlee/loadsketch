// Shared parts of course lessons (src/learn/course/): formatting, numbers read from a run, goals
// and rules. Pure functions: no React, no DOM. Text goes through t() when it is made.
import { t, tx } from '../i18n/index.ts';
import { KINDS } from '../schema/kinds.ts';
import type { Design, ParamValue } from '../schema/design.ts';
import type { Goal, Rule } from './lesson.ts';
import type { RunData } from './metrics.ts';

export const ms = (x: number) => `${Math.round(x)} ms`;
export const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** A node's parameter, or the kind's default. */
export function paramOf(d: Design, id: string, key: string): ParamValue | undefined {
  const n = d.nodes.find((x) => x.id === id);
  if (!n) return undefined;
  return n.params?.[key] ?? (KINDS[n.kind]?.params[key]?.default as ParamValue | undefined);
}

/** A node's label in the current language, or its id. */
export const labelOf = (d: Design, id: string) => {
  const n = d.nodes.find((x) => x.id === id);
  return n?.label ? t(n.label) : id;
};

/** Share of the requests into `node` that went on to `store` (both counted at arrival). */
export function shareReaching(run: RunData, store: string, node: string): number {
  const a = run.result.nodes[node]?.arrivals ?? 0;
  return a > 0 ? (run.result.nodes[store]?.arrivals ?? 0) / a : 0;
}

/** The cache's measured hit ratio (0 when it has none). */
export const hitRatio = (run: RunData, id: string) => run.result.nodes[id]?.hitRatio ?? 0;

/** The cache stays an LRU cache: a fixed hit ratio would be a number typed in, not one the run worked out. */
export const keepLru: Rule = {
  short: tx('Keep the LRU cache'),
  text: tx('The cache must stay in LRU mode: a fixed hit ratio is a number typed in, not one the run works out'),
  check: (d, original) => {
    const out: string[] = [];
    for (const o of original.nodes) {
      if (o.kind !== 'cache' || paramOf(original, o.id, 'mode') !== 'lru') continue;
      if (d.nodes.some((n) => n.id === o.id) && paramOf(d, o.id, 'mode') !== 'lru') out.push(t('“{name}” was switched to a fixed hit ratio', { name: labelOf(d, o.id) }));
    }
    return out;
  },
};

/**
 * A goal on the design rather than the run: the cache parameter `key` is at or below `max`. A goal,
 * not a rule, so that it shows under its own challenge (the rules of all challenges are listed
 * together). For ttlS, 0 means "never expires" and counts as above the limit.
 */
export function cacheAtMost(key: 'capacityKeys' | 'ttlS', max: number, text: string): Goal {
  return {
    text,
    check: (run) => {
      const caches = run.design.nodes.filter((n) => n.kind === 'cache');
      const values = caches.map((n) => paramOf(run.design, n.id, key));
      const ok = caches.length > 0 && values.every((v) => typeof v === 'number' && v <= max && (key !== 'ttlS' || v > 0));
      const shown = values.map((v) => (typeof v !== 'number' ? '—' : key === 'ttlS' && v <= 0 ? t('0 (never expires)') : String(v))).join(', ');
      return { ok, value: shown };
    },
  };
}

/** The whole run fails less than `limit` (a share). */
export const errorsUnder = (limit: number, text: string): Goal => ({
  text,
  check: (run) => ({ ok: run.result.summary.errorRate < limit, value: pct(run.result.summary.errorRate) }),
});

/** p99 of successful requests is under `limit` ms. */
export const p99Under = (limit: number, text: string): Goal => ({
  text,
  check: (run) => ({ ok: run.result.summary.latencyMs.p99 < limit, value: ms(run.result.summary.latencyMs.p99) }),
});

export const failUnder1 = errorsUnder(0.01, tx('Error rate under 1% for the whole run'));
