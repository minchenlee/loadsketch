// Collects every English message id and writes src/i18n/zh-TW.ts, keeping the Traditional Chinese
// translations already there. Also checks all locales in src/i18n/locales/*.ts or scaffolds a new locale.
// Sources: t('…') and tx('…') calls in src and cli, the component specs (KINDS) and the examples.
// Run: node scripts/i18n-extract.ts [--check] [--strict] [--add <code>] [--locales-dir <dir>]
//   --check: exit 1 if zh-TW.ts is out of date, placeholders mismatch, or a locale file is invalid; warn when entries lack translation
//   --strict: with --check, also exit 1 when any entry lacks translation (for zh-TW and any other locale)
//   --add <code>: create src/i18n/locales/<code>.ts with complete metadata and all English message ids
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CATEGORY_LABEL, EDGE_PARAMS, KINDS } from '../src/schema/kinds.ts';
import { ZH } from '../src/i18n/zh-TW.ts';
import { SAME_IN_ZH } from '../src/i18n/same.ts';
import { isLocaleFile, parseLocaleModule } from '../src/i18n/locale.ts';

const root = join(import.meta.dirname, '..');

function getFlagValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
    if (arg === `--${name}` && i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) {
      return process.argv[i + 1];
    }
  }
  return undefined;
}

const allIds = new Set<string>();
const add = (s: unknown) => {
  if (typeof s === 'string' && s.length > 0) allIds.add(s);
};

function walk(dir: string, out: string[]): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      if (p.endsWith(join('src', 'i18n', 'locales'))) continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(f) && !p.endsWith(join('i18n', 'zh-TW.ts'))) {
      out.push(p);
    }
  }
  return out;
}

// t('…'), t("…"), t(`…`) and tx(…): the first argument must be a plain literal
const CALL = /\btx?\(\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\$]|\\.)*`)/g;
const unquote = (lit: string) => {
  const body = lit.slice(1, -1);
  return body.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));
};
const files = [...walk(join(root, 'src'), []), ...walk(join(root, 'cli'), [])];
let bad = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(CALL)) add(unquote(m[1]));
  // a t() whose first argument is not a literal cannot be extracted
  for (const m of src.matchAll(/\bt\(\s*`[^`]*\$\{/g)) {
    console.error(`${f}: t() with an interpolated template; use {name} placeholders: ${m[0]}`);
    bad++;
  }
}

for (const c of Object.values(CATEGORY_LABEL)) add(c);
const paramSets = [...Object.values(KINDS).map((k) => k.params), EDGE_PARAMS];
for (const k of Object.values(KINDS)) {
  add(k.label);
  add(k.summary);
}
for (const params of paramSets) {
  for (const p of Object.values(params)) {
    const ps = p as { label?: string; help?: string; options?: { label?: string; hint?: string }[] };
    add(ps.label);
    add(ps.help);
    for (const o of ps.options ?? []) {
      add(o.label);
      add(o.hint);
    }
  }
}

function readJsonDir(dir: string, visit: (j: any) => void) {
  const full = join(root, dir);
  if (!existsSync(full)) return;
  for (const f of readdirSync(full)) {
    if (!f.endsWith('.json')) continue;
    visit(JSON.parse(readFileSync(join(full, f), 'utf8')));
  }
}

readJsonDir('examples/designs', (j) => {
  add(j.name);
  add(j.description);
  for (const n of j.nodes ?? []) add(n.label);
  for (const n of j.notes ?? []) add(n.text);
});

readJsonDir('examples/scenarios', (j) => {
  add(j.name);
});

readJsonDir('examples/practice/oncall', (j) => {
  add(j.title);
  add(j.scenario?.name);
  add(j.explain);
  add(j.hint);
});

readJsonDir('examples/practice/constraints', (j) => {
  add(j.title);
  add(j.text);
  add(j.scenario?.name);
  add(j.hint);
});

readJsonDir('examples/practice/briefs', (j) => {
  add(j.title);
  add(j.text);
  for (const s of j.functional ?? []) add(s);
  for (const s of j.load ?? []) add(s);
  for (const s of j.given ?? []) add(s);
  for (const s of j.outOfScope ?? []) add(s);
  add(j.hint);
  for (const n of j.needs ?? []) add(n.text);
  add(j.scenario?.name);
  for (const dk of ['start', 'reference', 'naive']) {
    add(j[dk]?.name);
    for (const n of j[dk]?.nodes ?? []) add(n.label);
  }
});

const stripContext = (s: string) => {
  const i = s.indexOf('@@');
  return i < 0 ? s : s.slice(0, i);
};
const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const sortedAll = [...allIds].sort();
const localesDirArg = getFlagValue('locales-dir') ?? process.env.LOADSKETCH_LOCALES_DIR;
const localesDir = localesDirArg ? resolve(root, localesDirArg) : join(root, 'src/i18n/locales');

// --add <code>: generate a new locale file with complete metadata and all English IDs
const hasAddFlag = process.argv.some((a) => a === '--add' || a.startsWith('--add='));
if (hasAddFlag) {
  const code = getFlagValue('add');
  if (!code || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(code) || code === 'en' || code === 'zh-TW') {
    console.error(`invalid locale code for --add: ${JSON.stringify(code ?? '')} (expected e.g. ja or pt-BR; not en or zh-TW)`);
    process.exit(1);
  }
  mkdirSync(localesDir, { recursive: true });
  const target = join(localesDir, `${code}.ts`);
  if (existsSync(target)) {
    console.error(`${target} already exists`);
    process.exit(1);
  }
  const msgLines = sortedAll.map((k) => `    ${JSON.stringify(k)}: "",`);
  const content =
    `// Locale catalog for ${code}. Empty values ("") fall back to English.\n` +
    `// If machine-translated without human proofreading, add a header comment:\n` +
    `// machine-translated, not proofread\n` +
    `import type { LocaleDefinition } from '../locale.ts';\n\n` +
    `const locale: LocaleDefinition = {\n` +
    `  code: ${JSON.stringify(code)},\n` +
    `  label: ${JSON.stringify(code)}, // Display name in the language menu, e.g. '日本語'\n` +
    `  intlLocale: ${JSON.stringify(code)}, // BCP 47 tag for dates and numbers, e.g. 'ja-JP'\n` +
    `  htmlLang: ${JSON.stringify(code)}, // HTML lang attribute, e.g. 'ja'\n` +
    `  wordSeparator: ' ', // ' ' for space-separated languages, '' for Chinese/Japanese\n` +
    `  messages: {\n${msgLines.join('\n')}\n  },\n` +
    `};\n\n` +
    `export default locale;\n`;
  writeFileSync(target, content, 'utf8');
  console.log(`Created ${target} with ${sortedAll.length} message keys.`);
  process.exit(bad ? 1 : 0);
}

// Traditional Chinese excludes SAME_IN_ZH entries; other locales include the full source ID set.
const zhIds = new Set(sortedAll.filter((s) => !SAME_IN_ZH.has(s)));
const sortedZh = [...zhIds].sort();

// Check zh-TW
for (const k of sortedZh) {
  const zh = ZH[k];
  if (zh) {
    const enH = holes(stripContext(k));
    const zhH = holes(zh);
    if (enH.join() !== zhH.join()) {
      console.error(`placeholder mismatch for ${JSON.stringify(k)}: en {${enH.join(', ')}} vs zh-TW {${zhH.join(', ')}}`);
      bad++;
    }
  }
}

const kept = Object.keys(ZH).filter((k) => zhIds.has(k) && ZH[k]).length;
const dropped = Object.keys(ZH).filter((k) => !zhIds.has(k));
const missingKeys = sortedZh.filter((k) => !ZH[k]);
const lines = sortedZh.map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(ZH[k] ?? '')},`);
const text =
  `// Traditional Chinese catalog: English message id → Traditional Chinese. Keys are generated by\n` +
  `// scripts/i18n-extract.ts; values are edited by hand. An empty value falls back to the English text.\n` +
  `export const ZH: Record<string, string> = {\n${lines.join('\n')}\n};\n`;
const path = join(root, 'src/i18n/zh-TW.ts');
const missing = missingKeys.length;

function wordsOf(s: string): Set<string> {
  return new Set(stripContext(s).toLowerCase().match(/[a-z0-9]+/g) ?? []);
}
function closestDropped(target: string, candidates: string[]): string | null {
  const tw = wordsOf(target);
  if (!tw.size) return null;
  let best: string | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const cw = wordsOf(c);
    if (!cw.size) continue;
    let inter = 0;
    for (const w of tw) if (cw.has(w)) inter++;
    const score = (2 * inter) / (tw.size + cw.size);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore >= 0.3 ? best : null;
}

const isCheck = process.argv.includes('--check');
const strict = process.argv.includes('--strict');

// Check all locales in localesDir using the shared file rule and validator
let otherLocalesFailed = false;
const seenCodes = new Set<string>(['en']);

if (existsSync(localesDir)) {
  for (const file of readdirSync(localesDir).sort()) {
    if (!isLocaleFile(file)) continue;
    let locMod: unknown;
    try {
      locMod = await import(pathToFileURL(join(localesDir, file)).href);
    } catch (err) {
      console.error(`${file}: failed to load locale module: ${(err as Error).message}`);
      bad++;
      continue;
    }
    const parsed = parseLocaleModule(locMod, file);
    if (!parsed.ok) {
      console.error(`invalid locale ${parsed.error}`);
      bad++;
      continue;
    }
    const { code, messages: cat } = parsed.locale;
    if (seenCodes.has(code)) {
      console.error(`${file}: duplicate locale code ${JSON.stringify(code)}`);
      bad++;
      continue;
    }
    seenCodes.add(code);
    if (code === 'zh-TW') continue;

    let locMissing = 0;
    for (const k of sortedAll) {
      const val = Object.hasOwn(cat, k) ? cat[k] : '';
      if (!val) {
        locMissing++;
      } else {
        const enH = holes(stripContext(k));
        const locH = holes(val);
        if (enH.join() !== locH.join()) {
          console.error(`placeholder mismatch in ${code} (${file}) for ${JSON.stringify(k)}: en {${enH.join(', ')}} vs ${code} {${locH.join(', ')}}`);
          bad++;
        }
      }
    }

    const extraKeys = Object.keys(cat).filter((k) => !allIds.has(k));
    if (extraKeys.length > 0) {
      console.warn(`warning: ${code} has ${extraKeys.length} extra key(s) no longer in source: ${extraKeys.slice(0, 5).join(', ')}${extraKeys.length > 5 ? '...' : ''}`);
    }

    if (locMissing > 0) {
      if (strict) {
        console.error(`strict check failed: ${code} has ${locMissing} missing translation(s)`);
        otherLocalesFailed = true;
      } else {
        console.warn(`warning: ${code} has ${locMissing} missing translation(s) (falling back to English)`);
      }
    }
  }
}

if (isCheck) {
  const same = readFileSync(path, 'utf8') === text;
  console.log(`${sortedZh.length} messages, ${missing} without Chinese${same ? '' : ', zh-TW.ts is out of date'}`);
  if (missing > 0) {
    for (const k of missingKeys) console.warn(`  missing zh-TW: ${JSON.stringify(k)}`);
  }
  process.exit(same && !bad && !otherLocalesFailed && (!strict || missing === 0) ? 0 : 1);
}

writeFileSync(path, text);
console.log(`${sortedZh.length} messages (${kept} translated kept, ${missing} without Chinese, ${dropped.length} dropped)`);
if (dropped.length > 0 && missingKeys.length > 0) {
  for (const nk of missingKeys) {
    const old = closestDropped(nk, dropped);
    if (old && ZH[old]) {
      console.log(`  hint for ${JSON.stringify(nk)}:\n    closest dropped key: ${JSON.stringify(old)}\n    old zh-TW: ${JSON.stringify(ZH[old])}`);
    }
  }
}
if (bad || otherLocalesFailed) process.exit(1);
