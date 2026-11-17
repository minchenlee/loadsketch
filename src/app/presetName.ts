// Which built-in scenario the current one is, by name. The built-in names are English now; an old
// share link or a saved version still has the Traditional Chinese name, so that matches too.
import type { Scenario } from '../schema/design.ts';
import { ZH } from '../i18n/zh-TW.ts';

export function presetOf(scenarios: Record<string, Scenario>, name: string | undefined): string | undefined {
  if (!name) return undefined;
  return Object.entries(scenarios).find(([, s]) => s.name === name || (!!s.name && Object.hasOwn(ZH, s.name) && !!ZH[s.name] && ZH[s.name] === name))?.[0];
}
