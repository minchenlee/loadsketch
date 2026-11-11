// AGENTS.md is checked against the code (scripts/check-agents-md.ts). These cases make sure the
// check fails when the map drifts, not only that the current file passes.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'check-agents-md.ts');
const doc = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'agents-md-'));

function check(text: string): { code: number; out: string } {
  const f = join(dir, `AGENTS-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(f, text);
  const r = spawnSync(process.execPath, [SCRIPT, f], { encoding: 'utf8' });
  return { code: r.status ?? -1, out: r.stdout + r.stderr };
}
const swap = (a: string, b: string) => {
  expect(doc).toContain(a);
  return doc.replace(a, b);
};

describe('AGENTS.md check', () => {
  it('the file in the repo passes', () => {
    const r = check(doc);
    expect(r.out).toContain('ok');
    expect(r.code).toBe(0);
  });
  it('fails when a section is missing', () => {
    expect(check(swap('## 改既有行為：在哪裡', '## 行為')).code).toBe(1);
  });
  it('fails when a path does not exist', () => {
    const r = check(swap('`src/learn/cost.ts`', '`src/learn/costs.ts`'));
    expect(r.code).toBe(1);
    expect(r.out).toContain('src/learn/costs.ts does not exist');
  });
  it('fails when a name is not in the file the line names', () => {
    const r = check(swap('`cacheOp()`', '`cacheLookup()`'));
    expect(r.code).toBe(1);
    expect(r.out).toContain('cacheLookup()');
  });
  it('fails when a command does not resolve', () => {
    expect(check(swap('npm run test:quick ', 'npm run test:fast ')).code).toBe(1);
    expect(check(swap('node scripts/i18n-extract.ts\n', 'node scripts/i18n-extractor.ts\n')).code).toBe(1);
  });
});
