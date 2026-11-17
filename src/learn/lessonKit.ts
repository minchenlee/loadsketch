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

/**
 * Share of the requests users sent that did not succeed: failed, or not finished when the run
 * ended. Counted once per user request (summary.offered and summary.ok), never by adding up
 * events, so retries and fan-out do not dilute it. No traffic at all counts as all failed.
 * (summary.errorRate leaves out the requests that never finished: a design so slow that nothing
 * finishes would score 0%.)
 */
export const failShareOf = (run: RunData) => {
  const s = run.result.summary;
  return s.offered > 0 ? Math.min(1, Math.max(0, s.offered - s.ok) / s.offered) : 1;
};

/** The whole run fails less than `limit` (a share of the requests users sent). */
export const errorsUnder = (limit: number, text: string): Goal => ({
  text,
  check: (run) => ({ ok: failShareOf(run) < limit, value: pct(failShareOf(run)) }),
});

/**
 * p99 of successful requests is under `limit` ms. With no successful request the histogram is
 * empty and its p99 reads 0: that does not count.
 */
export const p99Under = (limit: number, text: string): Goal => ({
  text,
  check: (run) => {
    const s = run.result.summary;
    if (!(s.ok > 0)) return { ok: false, value: t('no successful requests') };
    return { ok: s.latencyMs.p99 < limit, value: ms(s.latencyMs.p99) };
  },
});

export const failUnder1 = errorsUnder(0.01, tx('Error rate under 1% for the whole run'));
