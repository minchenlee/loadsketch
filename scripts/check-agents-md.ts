#!/usr/bin/env node
// Checks AGENTS.md against the code, so the map does not drift:
//   1. every required section is there;
//   2. every path it names exists;
//   3. every name in backticks (`name()`, `NAME`, `TypeName`) is found in a file named on the same
//      line, or, when the line names none, in the last file named before it in the same section;
//   4. every command in the ```sh block resolves: `npm run X` is a script in package.json,
//      `node <file>` exists, `npx <bin>` is in node_modules/.bin.
// Exit 0 when all hold; else prints one line per problem and exits 1.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2] ?? join(ROOT, 'AGENTS.md');
const text = readFileSync(file, 'utf8');
const lines = text.split('\n');
const problems: string[] = [];
const say = (line: number, msg: string) => problems.push(`${file}:${line}: ${msg}`);

const REQUIRED = ['## 規則', '## 新增一種元件：要改的檔案', '## 改既有行為：在哪裡', '## English summary'];
for (const h of REQUIRED) if (!lines.includes(h)) say(0, `missing section "${h}"`);

const PATH_RE = /(?:^|[\s`(])((?:src|tests|e2e|scripts|cli|examples|docs|schema)\/[\w.\-/]*)/g;
const NAME_RE = /^(?:[A-Za-z_]\w*\(\)|[A-Z][A-Za-z0-9_]*)$/;

const contents = new Map<string, string>();
function filesOf(p: string): string[] {
  const abs = join(ROOT, p);
  if (!existsSync(abs)) return [];
  if (!statSync(abs).isDirectory()) return [abs];
  return readdirSync(abs, { recursive: true, encoding: 'utf8' })
    .map((f) => join(abs, f))
    .filter((f) => /\.(ts|tsx|json)$/.test(f) && statSync(f).isFile());
}
function has(p: string, name: string): boolean {
  const re = name.endsWith('()') ? new RegExp(`\\b${name.slice(0, -2)}\\s*[(<=:]|\\b${name.slice(0, -2)}\\b\\s*\\(`) : new RegExp(`\\b${name}\\b`);
  return filesOf(p).some((f) => {
    if (!contents.has(f)) contents.set(f, readFileSync(f, 'utf8'));
    return re.test(contents.get(f)!);
  });
}

let inSh = false;
let lastFile: string | null = null;
const scripts = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;

lines.forEach((raw, i) => {
  const n = i + 1;
  if (raw.startsWith('```')) {
    inSh = !inSh && raw.startsWith('```sh');
    return;
  }
  if (inSh) {
    const cmd = raw.replace(/#.*$/, '').trim().replace(/^([A-Z_]+=\S+\s+)+/, '');
    if (!cmd) return;
    const [tool, a, b] = cmd.split(/\s+/);
    if (tool === 'npm' && a === 'run') {
      if (!scripts[b]) say(n, `npm script "${b}" is not in package.json`);
    } else if (tool === 'node') {
      if (!existsSync(join(ROOT, a))) say(n, `${a} does not exist`);
    } else if (tool === 'npx') {
      if (!existsSync(join(ROOT, 'node_modules', '.bin', a))) say(n, `npx ${a}: not installed`);
    } else say(n, `command "${tool}" is not checked: use npm run, node or npx`);
    for (const m of cmd.matchAll(PATH_RE)) if (!existsSync(join(ROOT, m[1]))) say(n, `${m[1]} does not exist`);
    return;
  }
  if (raw.startsWith('## ')) lastFile = null;
  const ticks = [...raw.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const paths = ticks.flatMap((tk) => [...` ${tk}`.matchAll(PATH_RE)].map((m) => m[1].replace(/[.,]$/, '')));
  for (const p of paths) if (!existsSync(join(ROOT, p))) say(n, `${p} does not exist`);
  const here = paths.filter((p) => existsSync(join(ROOT, p)));
  const scope = here.length ? here : lastFile ? [lastFile] : [];
  for (const tk of ticks) {
    if (!NAME_RE.test(tk)) continue;
    if (!scope.length) say(n, `${tk}: no file named on this line or before it in the section`);
    else if (!scope.some((p) => has(p, tk))) say(n, `${tk} is not found in ${scope.join(', ')}`);
  }
  if (here.length) lastFile = here.at(-1)!;
});

if (problems.length) {
  for (const p of problems) console.error(p);
  console.error(`${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`${file}: ok`);
