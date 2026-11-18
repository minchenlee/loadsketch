import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { presetOf } from '../src/app/presetName.ts';
import type { Scenario } from '../src/schema/design.ts';
import { ZH } from '../src/i18n/zh-TW.ts';

// the same keys as SCENARIOS in src/app/store.ts: the file name without .json
const dir = join(import.meta.dirname, '../examples/scenarios');
const SCENARIOS: Record<string, Scenario> = Object.fromEntries(
  readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(dir, f), 'utf8'))]),
);

describe('the scenario menu finds the current preset (presetOf)', () => {
  const named = Object.entries(SCENARIOS).filter(([, x]) => x.name && ZH[x.name]);

  it('every built-in scenario has a name with Chinese', () => {
    expect(named.length).toBe(Object.keys(SCENARIOS).length);
  });

  it.each(named)('%s: by its English name and by its old Chinese name (old share link, saved version)', (key, s) => {
    expect(presetOf(SCENARIOS, s.name)).toBe(key);
    expect(presetOf(SCENARIOS, ZH[s.name!])).toBe(key);
  });

  it('not for a name of the user\'s own, or no name', () => {
    expect(presetOf(SCENARIOS, 'My test')).toBeUndefined();
    expect(presetOf(SCENARIOS, '')).toBeUndefined();
    expect(presetOf(SCENARIOS, undefined)).toBeUndefined();
  });
});
