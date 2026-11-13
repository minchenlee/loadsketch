// Verifies that CONTRIBUTING.md stays in sync with the repository: every TOC anchor resolves,
// every file path in the repo exists, and every npm / node / npx / script command resolves.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const DOC_PATH = join(ROOT, 'CONTRIBUTING.md');
const PKG_PATH = join(ROOT, 'package.json');

const REPO_PATH_RE = /(?:^|[\s`(])((?:src|tests|e2e|scripts|cli|examples|docs|schema)\/[\w.\-/]*)/g;
const ENV_PREFIX_RE = /^(?:[A-Z_]+=\S+\s+)+/;
const headingSlug = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');

function checkContributing(text: string): string[] {
  const problems: string[] = [];
  const lines = text.split('\n');
  const scripts = (JSON.parse(readFileSync(PKG_PATH, 'utf8')) as { scripts: Record<string, string> }).scripts;
  const headings = new Set<string>();
  const tocAnchors: { line: number; anchor: string }[] = [];

  let inFence = false;
  let fenceLang = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const n = i + 1;

    if (line.startsWith('```')) {
      if (!inFence) {
        inFence = true;
        fenceLang = line.slice(3).trim().toLowerCase();
      } else {
        inFence = false;
        fenceLang = '';
      }
      continue;
    }

    if (inFence) {
      if (fenceLang !== 'sh' && fenceLang !== 'bash') continue;
      const cmd = line.replace(/#.*$/, '').trim().replace(ENV_PREFIX_RE, '');
      if (!cmd) continue;
      const [tool, a, b] = cmd.split(/\s+/);
      if (tool === 'npm') {
        if (a === 'run') {
          if (!b || !scripts[b]) problems.push(`line ${n}: npm script "${b ?? ''}" is not in package.json`);
        } else if (a !== 'install') {
          problems.push(`line ${n}: unsupported npm subcommand "${a ?? ''}"`);
        }
      } else if (tool === 'node') {
        if (!a || !existsSync(join(ROOT, a))) problems.push(`line ${n}: node target "${a ?? ''}" does not exist`);
      } else if (tool === 'npx') {
        if (!a || !existsSync(join(ROOT, 'node_modules', '.bin', a))) problems.push(`line ${n}: npx binary "${a ?? ''}" is not installed`);
      } else if (tool.startsWith('scripts/')) {
        if (!existsSync(join(ROOT, tool))) problems.push(`line ${n}: script "${tool}" does not exist`);
      } else if (tool !== 'git' && tool !== 'cd') {
        problems.push(`line ${n}: unchecked command "${tool}"`);
      }
      if (tool !== 'git') {
        for (const m of cmd.matchAll(REPO_PATH_RE)) {
          const p = m[1].replace(/[.,:;)]+$/, '');
          if (!existsSync(join(ROOT, p))) problems.push(`line ${n}: path "${p}" does not exist`);
        }
      }
      continue;
    }

    const hm = /^#{1,6}\s+(.+)$/.exec(line);
    if (hm) headings.add(headingSlug(hm[1]));

    for (const m of line.matchAll(/\]\(#([^)]+)\)/g)) tocAnchors.push({ line: n, anchor: m[1] });
    for (const m of line.matchAll(/\]\(([^)#][^)]*)\)/g)) {
      const target = m[1].trim();
      if (/^https?:\/\//.test(target)) continue;
      if (!existsSync(join(ROOT, target))) problems.push(`line ${n}: linked file "${target}" does not exist`);
    }
    for (const tk of [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1])) {
      for (const m of ` ${tk}`.matchAll(REPO_PATH_RE)) {
        const p = m[1].replace(/[.,:;)]+$/, '');
        if (!existsSync(join(ROOT, p))) problems.push(`line ${n}: path "${p}" does not exist`);
      }
      if (/^npm run\s+\S+/.test(tk)) {
        const s = tk.split(/\s+/)[2];
        if (!scripts[s]) problems.push(`line ${n}: inline npm script "${s}" is not in package.json`);
      } else if (/^node\s+\S+/.test(tk)) {
        const f = tk.split(/\s+/)[1];
        if (!existsSync(join(ROOT, f))) problems.push(`line ${n}: inline node target "${f}" does not exist`);
      } else if (/^npx\s+\S+/.test(tk)) {
        const bin = tk.split(/\s+/)[1];
        if (!existsSync(join(ROOT, 'node_modules', '.bin', bin))) problems.push(`line ${n}: inline npx binary "${bin}" is not installed`);
      }
    }
  }

  for (const { line, anchor } of tocAnchors) {
    if (!headings.has(anchor)) problems.push(`line ${line}: broken anchor "#${anchor}"`);
  }

  return problems;
}

describe('CONTRIBUTING.md check', () => {
  const doc = readFileSync(DOC_PATH, 'utf8');
  const swap = (a: string, b: string) => {
    expect(doc).toContain(a);
    return doc.replace(a, b);
  };

  it('includes the Terraform resource mapping guide in the TOC and body', () => {
    expect(doc).toContain('[Adding a Terraform Resource Mapping](#adding-a-terraform-resource-mapping)');
    expect(doc).toContain('## Adding a Terraform Resource Mapping');
  });

  it('has valid anchors, existing file paths, and valid npm/node/npx/script commands', () => {
    expect(checkContributing(doc)).toEqual([]);
  });

  it('fails when a referenced file path does not exist', () => {
    const problems = checkContributing(swap('`src/import/terraform/rules.ts`', '`src/import/terraform/nonexistent.ts`'));
    expect(problems.some((p) => p.includes('src/import/terraform/nonexistent.ts'))).toBe(true);
  });

  it('fails when an npm run script does not exist in package.json', () => {
    const problems = checkContributing(swap('npm run test:quick', 'npm run test:does_not_exist'));
    expect(problems.some((p) => p.includes('test:does_not_exist'))).toBe(true);
  });

  it('fails when a node script path does not exist', () => {
    const problems = checkContributing(swap('node scripts/i18n-extract.ts', 'node scripts/missing-extract.ts'));
    expect(problems.some((p) => p.includes('scripts/missing-extract.ts'))).toBe(true);
  });

  it('fails when a TOC anchor points to a missing heading', () => {
    const problems = checkContributing(swap('#adding-a-terraform-resource-mapping', '#missing-section'));
    expect(problems.some((p) => p.includes('#missing-section'))).toBe(true);
  });
});
