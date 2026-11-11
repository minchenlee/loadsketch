// Import boundaries for code that runs outside the browser app. The check follows every import
// down the whole graph (not only the first level), so a rule cannot be broken through a middle file.
//   - From src/core/index.ts and every file in src/import/: never reach src/app/, UI packages or
//     DOM globals; from src/learn/ only the allowed files.
//   - Only the known files may import src/i18n/: the engine and schema already do (sim.ts,
//     design.ts, cost.ts), and this round does not change that. Every other file, and every file in
//     src/import/, must not (new code returns message ids and arguments). src/import/ may still use
//     the core entry, which reaches i18n only through the known files.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseSync } from 'rolldown/utils';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const CORE = 'src/core/index.ts';
const IMPORT_DIR = 'src/import';
const LEARN_ALLOWED = new Set(['src/learn/cost.ts']);
const I18N_KNOWN = new Set(['src/engine/sim.ts', 'src/schema/design.ts', 'src/learn/cost.ts', 'src/i18n/content.ts']);
const UI_PACKAGES = /^((react|react-dom|lucide-react|uplot)(\/|$)|@xyflow\/)/;
const DOM_GLOBALS = new Set([
  'window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'history',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'matchMedia',
  'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'ResizeObserver',
]);

type Files = (path: string) => string | undefined;
/** A regular file's text; undefined for a missing path or a directory (so '../engine' resolves to index.ts). */
const disk: Files = (p) => (existsSync(join(ROOT, p)) && statSync(join(ROOT, p)).isFile() ? readFileSync(join(ROOT, p), 'utf8') : undefined);
/** Disk with some files replaced or added, so a test can plant a violation without touching src/. */
const overlay = (extra: Record<string, string>): Files => (p) => extra[p] ?? disk(p);

function resolveSpec(from: string, spec: string, files: Files): string | null {
  if (!spec.startsWith('.')) return null;
  const base = relative(ROOT, resolve(ROOT, dirname(from), spec));
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) if (files(c) !== undefined) return c;
  throw new Error(`${from}: cannot resolve '${spec}'`);
}

interface Scan { specs: string[]; dom: string[] }
// The oxc parser that ships with Vite (rolldown); TypeScript 7 has no JS compiler API to parse with.
type AstNode = { type: string; [k: string]: unknown };
function scan(path: string, text: string): Scan {
  const r = parseSync(path, text, { lang: path.endsWith('x') ? 'tsx' : 'ts' });
  if (r.errors.length) throw new Error(`${path}: parse error: ${r.errors[0].message}`);
  const specs = [
    ...r.module.staticImports.map((i) => i.moduleRequest.value),
    ...r.module.staticExports.flatMap((e) => e.entries.flatMap((x) => (x.moduleRequest ? [x.moduleRequest.value] : []))),
    ...r.module.dynamicImports.map((d) => text.slice(d.moduleRequest.start, d.moduleRequest.end).replace(/^['"`]|['"`]$/g, '')),
  ];
  return { specs, dom: domReferences(r.program as unknown as AstNode) };
}

// Scopes. A local declaration hides a DOM global only inside its own scope, so the check runs in two
// passes: first record which DOM-named bindings each scope declares, then resolve each reference
// against the scopes around it.
const FUNCTION = /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/;
const BLOCK = /^(BlockStatement|StaticBlock|ForStatement|ForInStatement|ForOfStatement|SwitchStatement|CatchClause|ClassBody)$/;
const children = (n: AstNode): [string, unknown][] => Object.entries(n).filter(([k]) => k !== 'type' && k !== 'start' && k !== 'end');
const isNode = (n: unknown): n is AstNode => !!n && typeof n === 'object' && typeof (n as AstNode).type === 'string';
const isType = (n: AstNode) => n.type.startsWith('TS') && !/^TS(AsExpression|SatisfiesExpression|NonNullExpression)$/.test(n.type);

/** Identifiers a binding pattern declares (not the default values, which are references). */
function patternIds(p: unknown, out: AstNode[] = []): AstNode[] {
  if (!isNode(p)) return out;
  if (p.type === 'Identifier') out.push(p);
  else if (p.type === 'ObjectPattern') for (const q of p.properties as AstNode[]) patternIds(q.type === 'RestElement' ? q.argument : q.value, out);
  else if (p.type === 'ArrayPattern') for (const q of p.elements as unknown[]) patternIds(q, out);
  else if (p.type === 'RestElement') patternIds(p.argument, out);
  else if (p.type === 'AssignmentPattern') patternIds(p.left, out);
  else if (p.type === 'TSParameterProperty') patternIds(p.parameter, out);
  return out;
}

function domReferences(program: AstNode): string[] {
  const scopes = new Map<AstNode, Set<string>>();
  const declIds = new Set<AstNode>();
  const declare = (scope: AstNode, ids: AstNode[]) => {
    for (const id of ids) {
      declIds.add(id);
      if (DOM_GLOBALS.has(id.name as string)) {
        if (!scopes.has(scope)) scopes.set(scope, new Set());
        scopes.get(scope)!.add(id.name as string);
      }
    }
  };
  // Pass 1: bindings. fn = nearest function (or the module), block = nearest block scope.
  const collect = (n: unknown, fn: AstNode, block: AstNode): void => {
    if (Array.isArray(n)) return n.forEach((c) => collect(c, fn, block));
    if (!isNode(n) || isType(n)) return;
    let f = fn;
    let b = block;
    if (FUNCTION.test(n.type)) {
      if (n.type === 'FunctionDeclaration' && n.id) declare(block, [n.id as AstNode]);
      if (n.type === 'FunctionExpression' && n.id) declare(n, [n.id as AstNode]);
      declare(n, (n.params as unknown[]).flatMap((q) => patternIds(q)));
      f = n;
      b = n;
    } else if (BLOCK.test(n.type)) {
      b = n;
      if (n.type === 'CatchClause' && n.param) declare(n, patternIds(n.param));
    } else if (n.type === 'VariableDeclaration') {
      declare(n.kind === 'var' ? fn : block, (n.declarations as AstNode[]).flatMap((d) => patternIds(d.id)));
    } else if (n.type === 'ClassDeclaration' && n.id) declare(block, [n.id as AstNode]);
    else if (n.type === 'ClassExpression' && n.id) declare(n, [n.id as AstNode]);
    else if (/^Import(Specifier|DefaultSpecifier|NamespaceSpecifier)$/.test(n.type)) declare(program, [n.local as AstNode]);
    for (const [, c] of children(n)) collect(c, f, b);
  };
  collect(program, program, program);
  // Pass 2: references, resolved against the scopes on the way down.
  const used = new Set<string>();
  const refs = (n: unknown, parent: AstNode | null, key: string, stack: AstNode[]): void => {
    if (Array.isArray(n)) return n.forEach((c) => refs(c, parent, key, stack));
    if (!isNode(n) || isType(n)) return;
    const here = scopes.has(n) ? [...stack, n] : stack;
    if (n.type === 'Identifier' && DOM_GLOBALS.has(n.name as string) && !declIds.has(n) && isReference(parent, key)) {
      if (!here.some((s) => scopes.get(s)!.has(n.name as string))) used.add(n.name as string);
    }
    for (const [k, c] of children(n)) refs(c, n, k, here);
  };
  refs(program, null, '', []);
  return [...used];
}
/** True when the identifier reads a value: not a property name, an object key or an export name. */
function isReference(p: AstNode | null, key: string): boolean {
  if (!p) return true;
  if (p.type === 'MemberExpression' && key === 'property' && !p.computed) return false;
  if ((p.type === 'Property' || p.type === 'MethodDefinition' || p.type === 'PropertyDefinition') && key === 'key' && !p.computed && !p.shorthand) return false;
  if (/^(Import|Export)(Specifier|DefaultSpecifier|NamespaceSpecifier)$/.test(p.type) || p.type === 'LabeledStatement' || p.type === 'BreakStatement' || p.type === 'ContinueStatement') return false;
  return true;
}

interface Edge { file: string; spec: string; target: string | null }
/** Every file reachable from the entries, with the chain of imports that reached it. */
function walk(entries: string[], files: Files) {
  const via = new Map<string, string[]>();
  const edges: Edge[] = [];
  const dom: { file: string; name: string }[] = [];
  const queue: [string, string[]][] = entries.map((e) => [e, [e]]);
  for (const e of entries) via.set(e, [e]);
  while (queue.length) {
    const [file, chain] = queue.shift()!;
    const text = files(file);
    if (text === undefined) throw new Error(`missing ${file}`);
    const s = scan(file, text);
    for (const name of s.dom) dom.push({ file, name });
    for (const spec of s.specs) {
      const target = resolveSpec(file, spec, files);
      edges.push({ file, spec, target });
      if (target && !via.has(target)) {
        via.set(target, [...chain, target]);
        queue.push([target, [...chain, target]]);
      }
    }
  }
  return { via, edges, dom };
}

function importFiles(files: Files, extra: string[] = []): string[] {
  const dir = join(ROOT, IMPORT_DIR);
  const found: string[] = [];
  const list = (d: string): void => {
    for (const f of readdirSync(d)) {
      const full = join(d, f);
      if (statSync(full).isDirectory()) list(full);
      else if (/\.tsx?$/.test(f)) found.push(relative(ROOT, full));
    }
  };
  if (existsSync(dir)) list(dir);
  return [...new Set([...found, ...extra])].filter((f) => files(f) !== undefined);
}

/** Every broken rule, as one readable line each (with the import chain). */
function violations(files: Files, extraImportFiles: string[] = []): string[] {
  const out: string[] = [];
  const show = (chain: string[]) => chain.join(' -> ');
  const entries = [CORE, ...importFiles(files, extraImportFiles)];
  const { via, edges, dom } = walk(entries, files);
  for (const [file, chain] of via) {
    if (file.startsWith('src/app/')) out.push(`reaches src/app/: ${show(chain)}`);
    if (file.startsWith('src/learn/') && !LEARN_ALLOWED.has(file)) out.push(`reaches ${file} (learn allows only ${[...LEARN_ALLOWED].join(', ')}): ${show(chain)}`);
  }
  for (const e of edges) {
    if (e.target?.startsWith('src/i18n/') && !e.file.startsWith('src/i18n/') && !I18N_KNOWN.has(e.file)) {
      const who = e.file.startsWith(`${IMPORT_DIR}/`) ? 'src/import/ imports src/i18n/' : `new i18n import from ${e.file}`;
      out.push(`${who}: ${show(via.get(e.file)!)} -> ${e.target}`);
    }
    if (!e.target && UI_PACKAGES.test(e.spec)) out.push(`imports UI package '${e.spec}': ${show(via.get(e.file)!)}`);
  }
  for (const d of dom) out.push(`uses DOM global '${d.name}': ${show(via.get(d.file)!)}`);
  return [...new Set(out)];
}

describe('core and import boundaries', () => {
  it('the code in the repo keeps every rule', () => {
    expect(violations(disk)).toEqual([]);
  });

  it('the core entry reaches the engine, schema and cost (the check is not empty)', () => {
    const { via } = walk([CORE], disk);
    for (const f of ['src/engine/sim.ts', 'src/engine/scale.ts', 'src/engine/theory.ts', 'src/schema/kinds.ts', 'src/learn/cost.ts']) expect(via.has(f), f).toBe(true);
  });

  it('the core entry exports what the importer needs', async () => {
    const core = await import('../src/core/index.ts');
    for (const name of ['DesignSchema', 'ScenarioSchema', 'KINDS', 'resolveParams', 'simulate', 'Simulation', 'erlangC', 'mgc', 'planScale', 'scaleDesign', 'costOf']) expect(core, name).toHaveProperty(name);
  });

  it('fails when src/import/ imports the app store', () => {
    const probe = 'src/import/probe.ts';
    const v = violations(overlay({ [probe]: "import { useStore } from '../app/store.ts';\nexport const x = useStore;\n" }), [probe]);
    expect(v.some((l) => l.startsWith('reaches src/app/:') && l.includes(probe))).toBe(true);
  });

  it('fails when src/import/ reaches src/app/ through a middle file', () => {
    const a = 'src/import/a.ts';
    const b = 'src/import/b.ts';
    const v = violations(overlay({ [a]: "export { y } from './b.ts';\n", [b]: "import { KINDS } from '../app/examples.ts';\nexport const y = KINDS;\n" }), [a]);
    expect(v.some((l) => l.includes(`${a} -> ${b} -> src/app/examples.ts`))).toBe(true);
  });

  it('fails when the core entry reaches another learn file, even indirectly', () => {
    const direct = violations(overlay({ [CORE]: `${disk(CORE)}export * from '../learn/diagnose.ts';\n` }));
    expect(direct.some((l) => l.startsWith('reaches src/learn/diagnose.ts'))).toBe(true);
    // Indirect: an engine file starts importing a learn file that is not allowed.
    const indirect = violations(overlay({ 'src/engine/theory.ts': `import '../learn/sla.ts';\n${disk('src/engine/theory.ts')}` }));
    expect(indirect.some((l) => l.startsWith('reaches src/learn/sla.ts') && l.includes('src/engine/theory.ts -> src/learn/sla.ts'))).toBe(true);
  });

  it('fails when src/import/ imports i18n, directly or through its own middle file', () => {
    const p = 'src/import/probe.ts';
    const m = 'src/import/msg.ts';
    expect(violations(overlay({ [p]: "import { t } from '../i18n/index.ts';\nexport const x = t;\n" }), [p]).some((l) => l.startsWith('src/import/ imports src/i18n/'))).toBe(true);
    const v = violations(overlay({ [p]: "export { x } from './msg.ts';\n", [m]: "import { tx } from '../i18n/index.ts';\nexport const x = tx;\n" }), [p, m]);
    expect(v.some((l) => l.startsWith('src/import/ imports src/i18n/') && l.includes(m))).toBe(true);
  });

  it('lets src/import/ use the core entry (i18n behind it is the known exception)', () => {
    const p = 'src/import/probe.ts';
    expect(violations(overlay({ [p]: "import { KINDS, costOf } from '../core/index.ts';\nexport const x = [KINDS, costOf];\n" }), [p])).toEqual([]);
  });

  it('fails on a new i18n import in core code, but not on the known ones', () => {
    const v = violations(overlay({ 'src/engine/scale.ts': `import '../i18n/index.ts';\n${disk('src/engine/scale.ts')}` }));
    expect(v.some((l) => l.startsWith('new i18n import from src/engine/scale.ts'))).toBe(true);
  });

  it('fails on DOM globals and UI packages, but not on a property or a local named like one', () => {
    const f = 'src/engine/theory.ts';
    const base = disk(f)!;
    expect(violations(overlay({ [f]: `${base}\nexport const w = () => window.innerWidth;\n` })).some((l) => l.startsWith("uses DOM global 'window'"))).toBe(true);
    expect(violations(overlay({ [f]: `${base}\nexport const s = () => localStorage.getItem('x');\n` })).some((l) => l.includes("'localStorage'"))).toBe(true);
    expect(violations(overlay({ [f]: `import { useState } from 'react';\n${base}\nexport const u = useState;\n` })).some((l) => l.startsWith("imports UI package 'react'"))).toBe(true);
    expect(violations(overlay({ [f]: `${base}\nexport const ok = (o: { window: number; document: string }) => { const location = o.window; return { location, n: o.document }; };\n` }))).toEqual([]);
    // Scoped UI packages.
    expect(violations(overlay({ [f]: `import { Position } from '@xyflow/react';\n${base}\nexport const P = Position;\n` })).some((l) => l.startsWith("imports UI package '@xyflow/react'"))).toBe(true);
  });

  it('a local named like a DOM global hides it only inside its own scope', () => {
    const f = 'src/engine/theory.ts';
    const base = disk(f)!;
    const has = (code: string) => violations(overlay({ [f]: `${base}\n${code}\n` })).some((l) => l.startsWith("uses DOM global 'window'"));
    expect(has('export function f(window: string) { return window; }\nexport const x = () => window.innerWidth;')).toBe(true);
    expect(has('export const g = () => { { const window = 1; void window; } return window.innerWidth; };')).toBe(true);
    expect(has('export const s = ({ window }: { window: number }) => window;')).toBe(false);
    expect(has('export function h() { var window = 1; { return window; } }')).toBe(false);
    expect(has('export const o = (window: number) => ({ window });')).toBe(false);
    expect(has('export const p = () => ({ window });')).toBe(true);
    // The imported side of an aliased import is a name in another module.
    const node = (code: string) => violations(overlay({ [f]: `${code}\n${base}` })).filter((l) => l.includes("'Node'"));
    expect(node("import { Node as GraphNode } from './heap.ts';\nexport const q = GraphNode;")).toEqual([]);
    expect(node("import type { Node as N } from './heap.ts';\nexport type Q = N;")).toEqual([]);
    expect(node('export const r = () => Node.ELEMENT_NODE;')).not.toEqual([]);
  });

  it('resolves a directory import to its index.ts', () => {
    expect(violations(overlay({ [CORE]: `${disk(CORE)}export * from '../engine';\n` }))).toEqual([]);
  });
});
