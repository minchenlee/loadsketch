// Collects every English message id and writes src/i18n/zh-TW.ts, keeping the Traditional Chinese
// translations already there.
// Sources: t('…') and tx('…') calls in src and cli, the component specs (KINDS) and the examples.
// Run: node scripts/i18n-extract.ts [--check] [--strict]
//   --check: exit 1 if zh-TW.ts is out of date or placeholders mismatch; warn (list) when entries lack Chinese
//   --strict: with --check, also exit 1 when any entry lacks Chinese (for nightly checks)
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATEGORY_LABEL, EDGE_PARAMS, KINDS } from '../src/schema/kinds.ts';
import { ZH } from '../src/i18n/zh-TW.ts';

const root = join(import.meta.dirname, '..');

// Proper nouns, component kind names and technical terms that stay identical in Traditional Chinese.
const SAME_IN_ZH = new Set([
  'API',
  'API Gateway',
  'API Server',
  'CDN',
  'Cache',
  'Circuit Breaker',
  'CloudFront',
  'DNS',
  'DNS / edge PoP',
  'DNS failover',
  'Data service',
  'Database@@kind',
  'Django',
  'Django (gunicorn) ×27',
  'ECS → RDS',
  'Executor',
  'Function',
  'Health check',
  'IaC',
  'Load Balancer',
  'Mcrouter + Memcached',
  'Memcached',
  'Memcached ×6',
  'NGINX ×3',
  'Object Storage',
  'PostgreSQL',
  'Postgres',
  'Queue@@kind',
  'Rate Limiter',
  'Redis',
  'Redis job queue',
  'Route53',
  'S3',
  'Sharded DB',
  'TTL',
  'TTL jitter',
  'Visibility timeout',
  'Worker',
  'failover',
  'memcache',
  'outlier detection',
  'p99 ≤ {v}',
]);

const ids = new Set<string>();
const add = (s: unknown) => {
  if (typeof s === 'string' && s.length > 0 && !SAME_IN_ZH.has(s)) ids.add(s);
};

function walk(dir: string, out: string[]): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(f) && !p.endsWith(join('i18n', 'zh-TW.ts'))) out.push(p);
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

const sorted = [...ids].sort();
for (const k of sorted) {
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

const kept = Object.keys(ZH).filter((k) => ids.has(k) && ZH[k]).length;
const dropped = Object.keys(ZH).filter((k) => !ids.has(k));
const missingKeys = sorted.filter((k) => !ZH[k]);
const lines = sorted.map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(ZH[k] ?? '')},`);
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

if (process.argv.includes('--check')) {
  const same = readFileSync(path, 'utf8') === text;
  const strict = process.argv.includes('--strict');
  console.log(`${sorted.length} messages, ${missing} without Chinese${same ? '' : ', zh-TW.ts is out of date'}`);
  if (missing > 0) {
    for (const k of missingKeys) console.warn(`  missing zh-TW: ${JSON.stringify(k)}`);
  }
  process.exit(same && !bad && (!strict || missing === 0) ? 0 : 1);
}

writeFileSync(path, text);
console.log(`${sorted.length} messages (${kept} translated kept, ${missing} without Chinese, ${dropped.length} dropped)`);
if (dropped.length > 0 && missingKeys.length > 0) {
  for (const nk of missingKeys) {
    const old = closestDropped(nk, dropped);
    if (old && ZH[old]) {
      console.log(`  hint for ${JSON.stringify(nk)}:\n    closest dropped key: ${JSON.stringify(old)}\n    old zh-TW: ${JSON.stringify(ZH[old])}`);
    }
  }
}
if (bad) process.exit(1);
