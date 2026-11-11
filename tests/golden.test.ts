// Golden test: every example with the scenario it opens with, fixed seed, first 30 s. The result's
// fingerprint (numbers only, no prose) must stay exactly the same. When an engine change is meant
// to change behaviour, rerun with UPDATE_GOLDEN=1 and say why in the commit message.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { simulate, type SimResult } from '../src/engine/index.ts';
import type { Design, Scenario } from '../src/schema/design.ts';
import { EXAMPLE_SCENARIO } from '../src/app/exampleScenarios.ts';

const ROOT = join(import.meta.dirname, '..');
const FILE = join(import.meta.dirname, 'golden.json');
const MAX_S = 30;
const SEED = 7;

const read = <T,>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const names = readdirSync(join(ROOT, 'examples', 'designs')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
const scenarioOf = (name: string): string => {
  const own = EXAMPLE_SCENARIO[name] ?? name;
  return existsSync(join(ROOT, 'examples', 'scenarios', `${own}.json`)) ? own : 'steady';
};

/** Display text in a result: names, labels, explanations. A copy-only change must not change the hash. */
const PROSE = new Set(['design', 'name', 'label', 'why', 'text', 'note', 'role']);

/** The numbers of a run: every display-text field (see PROSE), at any depth, is left out. */
export function fingerprint(r: SimResult): string {
  const keep = JSON.stringify(r, (k, v: unknown) => (typeof v === 'string' && PROSE.has(k) ? undefined : v));
  return createHash('sha256').update(keep).digest('hex').slice(0, 16);
}

function run(name: string): string {
  const d = read<Design>(join(ROOT, 'examples', 'designs', `${name}.json`));
  const sc = read<Scenario>(join(ROOT, 'examples', 'scenarios', `${scenarioOf(name)}.json`));
  const durationS = Math.min(sc.durationS ?? 60, MAX_S);
  const warmupS = Math.min(sc.warmupS ?? 0, durationS / 2);
  return fingerprint(simulate(d, { ...sc, seed: SEED, durationS, warmupS }));
}

describe('golden fingerprint', () => {
  it('ignores display text: design name, node labels, theory notes', () => {
    const d = read<Design>(join(ROOT, 'examples', 'designs', 'flash-sale.json'));
    const sc = read<Scenario>(join(ROOT, 'examples', 'scenarios', 'steady.json'));
    const opts = { ...sc, seed: SEED, durationS: 5, warmupS: 0 };
    const renamed: Design = {
      ...d,
      name: `${d.name} (renamed)`,
      nodes: d.nodes.map((n) => ({ ...n, label: `${n.label ?? n.id} (renamed)` })),
    };
    expect(fingerprint(simulate(renamed, { ...opts, name: 'renamed' }))).toBe(fingerprint(simulate(d, opts)));
  });
  it('still sees a change in the numbers', () => {
    const d = read<Design>(join(ROOT, 'examples', 'designs', 'flash-sale.json'));
    const sc = read<Scenario>(join(ROOT, 'examples', 'scenarios', 'steady.json'));
    const opts = { ...sc, seed: SEED, durationS: 5, warmupS: 0 };
    expect(fingerprint(simulate(d, { ...opts, seed: SEED + 1 }))).not.toBe(fingerprint(simulate(d, opts)));
  });
});

describe('golden: every example gives exactly the same numbers', () => {
  const now = Object.fromEntries(names.map((n) => [n, run(n)]));
  if (process.env.UPDATE_GOLDEN) writeFileSync(FILE, JSON.stringify(now, null, 2) + '\n');
  const saved = existsSync(FILE) ? read<Record<string, string>>(FILE) : {};

  it('lists every example', () => {
    expect(Object.keys(saved).sort()).toEqual(names);
  });
  it.each(names)('%s', (name) => {
    expect(now[name], `${name} with ${scenarioOf(name)}: the numbers changed (UPDATE_GOLDEN=1 if that is meant)`).toBe(saved[name]);
  });
});
