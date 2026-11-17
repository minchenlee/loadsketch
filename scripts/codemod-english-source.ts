// One-time codemod + dry-run counter for flipping loadsketch i18n source text from zh-TW to English.
// Usage:
//   node scripts/codemod-english-source.ts --dry-run [--root <repo-path>]
//   node scripts/codemod-english-source.ts [--root <repo-path>]
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { formatJson } from '../src/schema/design.ts';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const rootIdx = args.indexOf('--root');
const ROOT = resolve(rootIdx >= 0 ? args[rootIdx + 1] : join(import.meta.dirname, '..'));

const require = createRequire(join(ROOT, 'package.json'));
const { parseSync } = (await import(require.resolve('rolldown/utils'))) as {
  parseSync: (filename: string, sourceText: string, options?: { lang?: 'ts' | 'tsx' }) => {
    program: unknown;
    errors: { message: string }[];
  };
};

const enPath = join(ROOT, 'src/i18n/en.ts');
const zhPath = join(ROOT, 'src/i18n/zh-TW.ts');

const CJK_RE = /[㐀-鿿\u3000-\u303f\uff00-\uffef]/;

// 13 duplicate English values -> unique context-tagged keys (keeping plain English on KINDS side when applicable)
const CONTEXT_TAGS: Record<string, string> = {
  '{n} 次': '{n}@@times',
  '第 {s} 秒': '{s} s@@at',
  '、': ', @@list',
  '不用': 'Off@@not-used',
  '檢查間隔': 'Check interval@@probe',
  '副本所在區域': 'Replica region@@detail',
  '最大複製延遲': 'Max replication lag@@detail',
  '失敗率': 'Error rate@@failure',
  '總時長': 'Duration@@total',
  '每秒請求數': 'Requests per second@@count',
  '自動切換主庫': 'Automatic failover@@switch',
  '請求怎麼到': 'Arrivals@@how',
  '防擊穿': 'Stampede protection@@short',
};

const zhToNewKey = new Map<string, string>();
const newKeyToZh = new Map<string, string>();

if (existsSync(enPath)) {
  const { EN } = (await import(enPath)) as { EN: Record<string, string> };
  for (const [zh, en] of Object.entries(EN)) {
    if (en.includes('@@')) throw new Error(`EN value already contains @@: ${zh} -> ${en}`);
    const key = CONTEXT_TAGS[zh] ?? en;
    if (newKeyToZh.has(key)) {
      throw new Error(`Duplicate new key "${key}" for "${newKeyToZh.get(key)}" and "${zh}"`);
    }
    zhToNewKey.set(zh, key);
    newKeyToZh.set(key, zh);
  }
  for (const zh of Object.keys(CONTEXT_TAGS)) {
    if (!(zh in EN)) throw new Error(`CONTEXT_TAGS entry missing from EN: ${zh}`);
  }
} else if (existsSync(zhPath)) {
  const { ZH } = (await import(zhPath)) as { ZH: Record<string, string> };
  for (const [key, zh] of Object.entries(ZH)) {
    zhToNewKey.set(zh, key);
    newKeyToZh.set(key, zh);
  }
} else {
  throw new Error('Neither src/i18n/en.ts nor src/i18n/zh-TW.ts found');
}

function quoteLiteral(val: string, q: string): string {
  const esc = val.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
  if (q === "'") return `'${esc.replace(/'/g, "\\'")}'`;
  if (q === '"') return `"${esc.replace(/"/g, '\\"')}"`;
  if (q === '`') return `\`${esc.replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}\``;
  throw new Error(`Unexpected quote char: ${q}`);
}

function walkFiles(dir: string, exts: RegExp, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walkFiles(p, exts, out);
    else if (exts.test(f)) out.push(p);
  }
  return out;
}

type AstNode = { type: string; start: number; end: number; [k: string]: unknown };
const isNode = (n: unknown): n is AstNode => !!n && typeof n === 'object' && typeof (n as AstNode).type === 'string';

function walkAst(
  node: unknown,
  visit: (n: AstNode, parent: AstNode | null, key: string) => void,
  parent: AstNode | null = null,
  key = '',
): void {
  if (Array.isArray(node)) {
    for (const item of node) walkAst(item, visit, parent, key);
    return;
  }
  if (!isNode(node)) return;
  visit(node, parent, key);
  for (const [k, v] of Object.entries(node)) {
    if (k === 'type' || k === 'start' || k === 'end') continue;
    walkAst(v, visit, node, k);
  }
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

const WHITELIST_EXACT = new Set(['src/app/components/FindLimit.tsx::自訂', 'src/schema/design.ts::秒']);

const tsFiles = [...walkFiles(join(ROOT, 'src'), /\.(ts|tsx)$/), ...walkFiles(join(ROOT, 'cli'), /\.(ts|tsx)$/)].filter(
  (f) => {
    const rel = relative(ROOT, f);
    return rel !== 'src/i18n/en.ts' && rel !== 'src/i18n/zh-TW.ts';
  },
);

let tCallsReplaced = 0;
let txCallsReplaced = 0;
let dynamicTCalls = 0;
let asciiTCalls = 0;
let kindsReplaced = 0;
let whitelistReplaced = 0;
const tFiles = new Set<string>();
const txFiles = new Set<string>();
const allReplacedFiles = new Set<string>();
const missingInEn: { file: string; line: number; value: string; kind: string }[] = [];
const remainingCjk: { file: string; line: number; nodeType: string; value: string }[] = [];
const contextTaggedHits: { file: string; line: number; zh: string; newKey: string }[] = [];

for (const abs of tsFiles) {
  const rel = relative(ROOT, abs);
  const src = readFileSync(abs, 'utf8');
  const r = parseSync(abs, src, { lang: abs.endsWith('x') ? 'tsx' : 'ts' });
  if (r.errors.length) throw new Error(`${rel}: parse error: ${r.errors[0].message}`);

  const replacedSpans = new Set<string>();
  const edits: { start: number; end: number; newKey: string }[] = [];

  const tryRecordReplace = (node: AstNode, value: string, category: 't' | 'tx' | 'kinds' | 'whitelist') => {
    const spanKey = `${node.start}:${node.end}`;
    if (replacedSpans.has(spanKey)) return;
    const newKey = zhToNewKey.get(value);
    const line = lineOf(src, node.start);
    if (!newKey) {
      missingInEn.push({ file: rel, line, value, kind: category });
      return;
    }
    replacedSpans.add(spanKey);
    edits.push({ start: node.start, end: node.end, newKey });
    allReplacedFiles.add(rel);
    if (CONTEXT_TAGS[value]) {
      contextTaggedHits.push({ file: rel, line, zh: value, newKey });
    }
    if (category === 't') {
      tCallsReplaced++;
      tFiles.add(rel);
    } else if (category === 'tx') {
      txCallsReplaced++;
      txFiles.add(rel);
    } else if (category === 'kinds') {
      kindsReplaced++;
    } else {
      whitelistReplaced++;
    }
  };

  walkAst(r.program, (node, parent, parentKey) => {
    if (node.type === 'CallExpression') {
      const callee = node.callee as AstNode;
      if (callee.type === 'Identifier' && (callee.name === 't' || callee.name === 'tx')) {
        const fnName = callee.name as 't' | 'tx';
        const argsList = node.arguments as AstNode[];
        const arg0 = argsList[0];
        if (!arg0) return;
        if (arg0.type === 'Literal' && typeof arg0.value === 'string') {
          if (CJK_RE.test(arg0.value)) {
            tryRecordReplace(arg0, arg0.value, fnName);
          } else {
            asciiTCalls++;
          }
        } else if (arg0.type === 'TemplateLiteral' && (arg0.expressions as AstNode[]).length === 0) {
          const quasis = arg0.quasis as { value: { cooked: string } }[];
          const val = quasis[0]?.value.cooked ?? '';
          if (CJK_RE.test(val)) {
            tryRecordReplace(arg0, val, fnName);
          } else {
            asciiTCalls++;
          }
        } else {
          dynamicTCalls++;
          walkAst(arg0, (inner) => {
            if (inner.type === 'Literal' && typeof inner.value === 'string' && CJK_RE.test(inner.value)) {
              const wKey = `${rel}::${inner.value}`;
              if (WHITELIST_EXACT.has(wKey)) {
                tryRecordReplace(inner, inner.value, 'whitelist');
              }
            }
          });
        }
      }
    }

    if (rel === 'src/schema/kinds.ts') {
      if (node.type === 'Literal' && typeof node.value === 'string' && CJK_RE.test(node.value)) {
        if (zhToNewKey.has(node.value)) {
          tryRecordReplace(node, node.value, 'kinds');
        }
      } else if (node.type === 'TemplateLiteral' && (node.expressions as AstNode[]).length === 0) {
        const val = (node.quasis as { value: { cooked: string } }[])[0]?.value.cooked ?? '';
        if (CJK_RE.test(val) && zhToNewKey.has(val)) {
          tryRecordReplace(node, val, 'kinds');
        }
      }
    }

    if (node.type === 'Literal' && typeof node.value === 'string' && CJK_RE.test(node.value)) {
      const wKey = `${rel}::${node.value}`;
      if (WHITELIST_EXACT.has(wKey) && !replacedSpans.has(`${node.start}:${node.end}`)) {
        if (rel !== 'src/schema/design.ts' || (parent?.type === 'Property' && parentKey === 'value')) {
          tryRecordReplace(node, node.value, 'whitelist');
        }
      }
    }
  });

  // Second pass: find every remaining CJK literal / template / regex / JSXText not in replacedSpans
  walkAst(r.program, (node) => {
    if (replacedSpans.has(`${node.start}:${node.end}`)) return;
    if (node.type === 'Literal' && typeof node.value === 'string' && CJK_RE.test(node.value)) {
      remainingCjk.push({
        file: rel,
        line: lineOf(src, node.start),
        nodeType: node.regex ? 'RegExpLiteral' : 'StringLiteral',
        value: node.value,
      });
    } else if (node.type === 'Literal' && node.regex) {
      const pat = (node.regex as { pattern: string }).pattern;
      if (CJK_RE.test(pat))
        remainingCjk.push({ file: rel, line: lineOf(src, node.start), nodeType: 'RegExpLiteral', value: `/${pat}/` });
    } else if (node.type === 'TemplateLiteral') {
      const rawText = src.slice(node.start, node.end);
      if (CJK_RE.test(rawText)) {
        remainingCjk.push({ file: rel, line: lineOf(src, node.start), nodeType: 'TemplateLiteral', value: rawText });
      }
    } else if (node.type === 'JSXText' && typeof node.value === 'string' && CJK_RE.test(node.value)) {
      remainingCjk.push({ file: rel, line: lineOf(src, node.start), nodeType: 'JSXText', value: node.value.trim() });
    }
  });

  if (!dryRun && edits.length > 0 && missingInEn.length === 0) {
    edits.sort((a, b) => b.start - a.start);
    for (let i = 0; i + 1 < edits.length; i++) {
      if (edits[i].start < edits[i + 1].end) {
        throw new Error(`${rel}: overlapping edits at ${edits[i].start} and ${edits[i + 1].end}`);
      }
    }
    let outSrc = src;
    for (const e of edits) {
      const origQuote = outSrc[e.start];
      const replacement = quoteLiteral(e.newKey, origQuote);
      outSrc = outSrc.slice(0, e.start) + replacement + outSrc.slice(e.end);
    }
    writeFileSync(abs, outSrc);
  }
}

// Check & update JSON files
const jsonStats: Record<string, { files: number; replaced: number; missing: string[]; otherCjk: string[] }> = {};

function processJsonDir(dir: string, fieldsFn: (j: any, file: string, mut: (val: unknown, path: string) => unknown) => void) {
  const full = join(ROOT, dir);
  if (!existsSync(full)) return;
  for (const f of readdirSync(full).sort()) {
    if (!f.endsWith('.json')) continue;
    const abs = join(full, f);
    const rel = `${dir}/${f}`;
    const rawText = readFileSync(abs, 'utf8');
    const raw = JSON.parse(rawText);
    const visited = new Set<string>();
    let changedInFile = 0;
    const bucket = dir.split('/').pop()!;

    const mut = (val: unknown, fieldPath: string): unknown => {
      visited.add(fieldPath);
      if (typeof val !== 'string' || !CJK_RE.test(val)) return val;
      const nk = zhToNewKey.get(val);
      if (nk) {
        jsonStats[bucket].replaced++;
        changedInFile++;
        return nk;
      } else {
        jsonStats[bucket].missing.push(`${rel}: ${fieldPath}: ${val}`);
        return val;
      }
    };

    jsonStats[bucket].files++;
    fieldsFn(raw, rel, mut);
    checkOtherJsonStrings(bucket, rel, raw, visited);

    if (!dryRun && changedInFile > 0 && jsonStats[bucket].missing.length === 0) {
      writeFileSync(abs, formatJson(raw));
    }
  }
}

const checkOtherJsonStrings = (bucket: string, file: string, v: unknown, skipPaths: Set<string>, path = '') => {
  if (typeof v === 'string') {
    if (CJK_RE.test(v) && !skipPaths.has(path)) {
      jsonStats[bucket].otherCjk.push(`${file}: ${path}: ${v}`);
    }
    return;
  }
  if (Array.isArray(v)) {
    v.forEach((item, idx) => checkOtherJsonStrings(bucket, file, item, skipPaths, `${path}[${idx}]`));
  } else if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      checkOtherJsonStrings(bucket, file, val, skipPaths, path ? `${path}.${k}` : k);
    }
  }
};

jsonStats.designs = { files: 0, replaced: 0, missing: [], otherCjk: [] };
processJsonDir('examples/designs', (j, _file, mut) => {
  if (j.name !== undefined) j.name = mut(j.name, 'name');
  if (j.description !== undefined) j.description = mut(j.description, 'description');
  (j.nodes ?? []).forEach((n: any, i: number) => {
    if (n.label !== undefined) n.label = mut(n.label, `nodes[${i}].label`);
  });
  (j.notes ?? []).forEach((n: any, i: number) => {
    if (n.text !== undefined) n.text = mut(n.text, `notes[${i}].text`);
  });
});

jsonStats.scenarios = { files: 0, replaced: 0, missing: [], otherCjk: [] };
processJsonDir('examples/scenarios', (j, _file, mut) => {
  if (j.name !== undefined) j.name = mut(j.name, 'name');
});

jsonStats.oncall = { files: 0, replaced: 0, missing: [], otherCjk: [] };
processJsonDir('examples/practice/oncall', (j, _file, mut) => {
  if (j.title !== undefined) j.title = mut(j.title, 'title');
  if (j.scenario?.name !== undefined) j.scenario.name = mut(j.scenario.name, 'scenario.name');
  if (j.explain !== undefined) j.explain = mut(j.explain, 'explain');
  if (j.hint !== undefined) j.hint = mut(j.hint, 'hint');
});

jsonStats.constraints = { files: 0, replaced: 0, missing: [], otherCjk: [] };
processJsonDir('examples/practice/constraints', (j, _file, mut) => {
  if (j.title !== undefined) j.title = mut(j.title, 'title');
  if (j.text !== undefined) j.text = mut(j.text, 'text');
  if (j.scenario?.name !== undefined) j.scenario.name = mut(j.scenario.name, 'scenario.name');
  if (j.hint !== undefined) j.hint = mut(j.hint, 'hint');
});

jsonStats.briefs = { files: 0, replaced: 0, missing: [], otherCjk: [] };
processJsonDir('examples/practice/briefs', (j, _file, mut) => {
  if (j.title !== undefined) j.title = mut(j.title, 'title');
  if (j.text !== undefined) j.text = mut(j.text, 'text');
  if (Array.isArray(j.functional)) j.functional = j.functional.map((s: unknown, i: number) => mut(s, `functional[${i}]`));
  if (Array.isArray(j.load)) j.load = j.load.map((s: unknown, i: number) => mut(s, `load[${i}]`));
  if (Array.isArray(j.given)) j.given = j.given.map((s: unknown, i: number) => mut(s, `given[${i}]`));
  if (Array.isArray(j.outOfScope)) j.outOfScope = j.outOfScope.map((s: unknown, i: number) => mut(s, `outOfScope[${i}]`));
  if (j.hint !== undefined) j.hint = mut(j.hint, 'hint');
  (j.needs ?? []).forEach((n: any, i: number) => {
    if (n.text !== undefined) n.text = mut(n.text, `needs[${i}].text`);
  });
  if (j.scenario?.name !== undefined) j.scenario.name = mut(j.scenario.name, 'scenario.name');
  for (const dk of ['start', 'reference', 'naive']) {
    if (j[dk]?.name !== undefined) j[dk].name = mut(j[dk].name, `${dk}.name`);
    (j[dk]?.nodes ?? []).forEach((n: any, i: number) => {
      if (n.label !== undefined) n.label = mut(n.label, `${dk}.nodes[${i}].label`);
    });
  }
});

if (missingInEn.length || Object.values(jsonStats).some((s) => s.missing.length > 0)) {
  console.error('Errors found:', { missingInEn, jsonStats });
  process.exit(1);
}

if (!dryRun) {
  const sortedKeys = [...newKeyToZh.keys()].sort();
  const lines = sortedKeys.map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(newKeyToZh.get(k) ?? '')},`);
  const zhText =
    `// Traditional Chinese catalog: English message id → Traditional Chinese. Keys are generated by\n` +
    `// scripts/i18n-extract.ts; values are edited by hand. An empty value falls back to the English text.\n` +
    `export const ZH: Record<string, string> = {\n${lines.join('\n')}\n};\n`;
  writeFileSync(zhPath, zhText);
}

// Print report
console.log(`=== CODEMOD (${dryRun ? 'dry-run: no files modified' : 'APPLIED'}) ===`);
console.log(`Catalog entries: ${newKeyToZh.size}, context tags: ${Object.keys(CONTEXT_TAGS).length}`);
console.log('');
console.log('--- Code (src/ + cli/) ---');
console.log(`t() CJK replaced: ${tCallsReplaced} (${tFiles.size} files)`);
console.log(`tx() CJK replaced: ${txCallsReplaced} (${txFiles.size} files)`);
console.log(`t()/tx() already ASCII: ${asciiTCalls}`);
console.log(`t()/tx() dynamic arg0: ${dynamicTCalls}`);
console.log(`kinds.ts replaced: ${kindsReplaced}`);
console.log(`whitelist replaced: ${whitelistReplaced}`);
console.log(`Total code replacements: ${tCallsReplaced + txCallsReplaced + kindsReplaced + whitelistReplaced} across ${allReplacedFiles.size} files`);
console.log(`Context-tagged replacements in code: ${contextTaggedHits.length}`);
console.log(`Missing in catalog (code): ${missingInEn.length}`);

console.log('');
console.log('--- JSON (examples/) ---');
let totalJsonFiles = 0;
let totalJsonReplaced = 0;
for (const [k, s] of Object.entries(jsonStats)) {
  totalJsonFiles += s.files;
  totalJsonReplaced += s.replaced;
  console.log(`${k}: ${s.files} files, ${s.replaced} strings, missing=${s.missing.length}, otherCjk=${s.otherCjk.length}`);
  if (s.otherCjk.length) console.log('  otherCjk:', s.otherCjk);
}
console.log(`Total JSON replacements: ${totalJsonReplaced} across ${totalJsonFiles} files`);

console.log('');
console.log(`--- Remaining CJK literals/templates/regex/JSXText in src/ + cli/: ${remainingCjk.length} ---`);
const byFile = new Map<string, typeof remainingCjk>();
for (const item of remainingCjk) {
  if (!byFile.has(item.file)) byFile.set(item.file, []);
  byFile.get(item.file)!.push(item);
}
for (const [f, items] of [...byFile.entries()].sort()) {
  console.log(`  ${f} (${items.length}):`);
  for (const it of items) console.log(`    L${it.line} [${it.nodeType}]: ${JSON.stringify(it.value)}`);
}
