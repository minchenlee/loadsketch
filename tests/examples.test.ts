// The example browser: every bundled example is in exactly one category.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATEGORIES, TIERS, categorize } from '../src/app/examples.ts';

const files = readdirSync(join(import.meta.dirname, '..', 'examples', 'designs'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -5));

describe('example categories', () => {
  it('every example is in exactly one category, and every listed example exists', () => {
    const listed = CATEGORIES.flatMap((c) => c.examples);
    expect([...listed].sort()).toEqual([...files].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('an example missing from the list is shown under "Other"', () => {
    const cats = categorize([...files, 'new-one']);
    expect(cats.at(-1)).toMatchObject({ id: 'other', examples: ['new-one'] });
  });

  it('two tiers (Q16=A): starters teach one mechanism, real systems are the incident and whole-architecture examples', () => {
    expect(TIERS.map((x) => x.id)).toEqual(['start', 'real']);
    const real = CATEGORIES.filter((c) => c.tier === 'real').flatMap((c) => c.examples);
    expect(real.length).toBeGreaterThan(0);
    expect(real.every((e) => e.startsWith('saas-'))).toBe(true);
    const start = CATEGORIES.filter((c) => c.tier === 'start').flatMap((c) => c.examples);
    expect(start.some((e) => e.startsWith('saas-'))).toBe(false);
    expect(categorize(['three-tier', 'brand-new']).find((c) => c.id === 'other')?.tier).toBe('start');
  });
});
