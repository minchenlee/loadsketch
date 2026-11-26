// Preventive guardrails aligned with AGENTS.md rule 3:
// - Runs inside `npm run test:quick`: checks that every course lesson field, course UI t()/tx()
//   literal, and JSX text node is extracted into `src/i18n/zh-TW.ts`, and that every *translated*
//   (non-empty) zh-TW entry has matching `{placeholders}` and CJK text.
// - Empty translations (`""` added by `scripts/i18n-extract.ts` before a translator fills them in)
//   are intentionally allowed in `test:quick`; 0-missing completeness is enforced by `npm run i18n:strict`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COURSE } from '../src/learn/course.ts';
import { ALL_LESSONS, UNITS } from '../src/course/catalog.ts';
import { stepsOf } from '../src/learn/lesson.ts';
import { ZH } from '../src/i18n/zh-TW.ts';
import { SAME_IN_ZH } from '../src/i18n/same.ts';
import { stripContext } from '../src/i18n/index.ts';

const root = join(import.meta.dirname, '..');
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
const CALL = /\btx?\(\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\$]|\\.)*`)/g;
const unquote = (lit: string) => lit.slice(1, -1).replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));
const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(f)) out.push(p);
  }
  return out;
}

function checkMessageId(id: string, where: string, problems: string[]) {
  if (!id || SAME_IN_ZH.has(id)) return;
  if (!Object.hasOwn(ZH, id)) {
    problems.push(`${where}: missing from src/i18n/zh-TW.ts (did you wrap in tx()/t() and run scripts/i18n-extract.ts?): ${JSON.stringify(id.slice(0, 80))}`);
    return;
  }
  const zh = ZH[id];
  // Per AGENTS.md rule 3, an extracted entry left empty ("") is allowed in test:quick;
  // completeness (0 untranslated messages) is enforced by `npm run i18n:strict`.
  if (!zh) return;
  if (!CJK.test(zh)) {
    problems.push(`${where}: zh-TW translation has no CJK characters: ${JSON.stringify(id.slice(0, 80))} -> ${JSON.stringify(zh)}`);
  }
  if (holes(stripContext(id)) !== holes(zh)) {
    problems.push(`${where}: placeholder mismatch: en={${holes(stripContext(id))}} vs zh={${holes(zh)}} for ${JSON.stringify(id.slice(0, 80))}`);
  }
}

describe('course & catalog i18n extraction and parameter guardrails', () => {
  it('every user-facing prose field across all course lessons, units, and outline is extracted into zh-TW with matching placeholders', () => {
    const problems: string[] = [];

    for (const u of UNITS) checkMessageId(u.title, `unit ${u.id}`, problems);
    for (const e of ALL_LESSONS) checkMessageId(e.title, `outline ${e.id}`, problems);

    for (const l of COURSE) {
      const tag = `lesson ${l.id}`;
      if (l.title) checkMessageId(l.title, `${tag}.title`, problems);
      checkMessageId(l.intro, `${tag}.intro`, problems);
      for (const [k, s] of (l.learn ?? []).entries()) checkMessageId(s, `${tag}.learn[${k}]`, problems);
      for (const [k, s] of (l.recap ?? []).entries()) checkMessageId(s, `${tag}.recap[${k}]`, problems);
      for (const [k, term] of (l.terms ?? []).entries()) {
        checkMessageId(term.term, `${tag}.terms[${k}].term`, problems);
        checkMessageId(term.plain, `${tag}.terms[${k}].plain`, problems);
        if (term.example) checkMessageId(term.example, `${tag}.terms[${k}].example`, problems);
      }
      for (const [k, s] of stepsOf(l).entries()) {
        if (s.title) checkMessageId(s.title, `${tag}.steps[${k}].title`, problems);
        if ('text' in s && s.text) checkMessageId(s.text, `${tag}.steps[${k}].text`, problems);
        if ('key' in s && s.key) checkMessageId(s.key, `${tag}.steps[${k}].key`, problems);
      }
      for (const q of l.questions) {
        checkMessageId(q.text, `${tag}.q[${q.id}].text`, problems);
        checkMessageId(q.explain, `${tag}.q[${q.id}].explain`, problems);
        for (const [opt, ex] of Object.entries(q.explainFor ?? {})) {
          if (ex) checkMessageId(ex, `${tag}.q[${q.id}].explainFor.${opt}`, problems);
        }
        for (const [k, line] of (q.calc ?? []).entries()) checkMessageId(line, `${tag}.q[${q.id}].calc[${k}]`, problems);
        for (const o of q.options) checkMessageId(o.text, `${tag}.q[${q.id}].opt[${o.id}]`, problems);
      }
      for (const c of l.challenges) {
        checkMessageId(c.title, `${tag}.c[${c.id}].title`, problems);
        checkMessageId(c.text, `${tag}.c[${c.id}].text`, problems);
        checkMessageId(c.hint, `${tag}.c[${c.id}].hint`, problems);
        for (const [k, g] of c.goals.entries()) checkMessageId(g.text, `${tag}.c[${c.id}].goals[${k}]`, problems);
        for (const [k, r] of c.rules.entries()) {
          checkMessageId(r.short, `${tag}.c[${c.id}].rules[${k}].short`, problems);
          checkMessageId(r.text, `${tag}.c[${c.id}].rules[${k}].text`, problems);
        }
      }
    }

    expect(problems).toEqual([]);
  });

  it('every t()/tx() literal in src/course/ and src/learn/course/ is extracted into zh-TW with matching placeholders', () => {
    const problems: string[] = [];
    const files = [...walk(join(root, 'src/course')), ...walk(join(root, 'src/learn/course'))];
    for (const f of files) {
      const rel = f.slice(root.length + 1);
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\bt\(\s*`[^`]*\$\{/g)) {
        problems.push(`${rel}: interpolated t() template cannot be extracted: ${m[0]}`);
      }
      for (const m of src.matchAll(CALL)) {
        checkMessageId(unquote(m[1]), rel, problems);
      }
    }
    expect(problems).toEqual([]);
  });

  it('src/course/*.tsx has no hardcoded English JSX text outside t()', () => {
    const ALLOWED = new Set(['loadsketch']);
    const problems: string[] = [];
    // Matches literal text between a JSX opening tag and its closing tag (ignoring arrow functions `=>`).
    const JSX_TEXT = /<[A-Za-z][\w.]*(?:\s[^<>]*?)?>([^<{}\n]*[A-Za-z]{2,}[^<{}\n]*)<\/[A-Za-z][\w.]*>/g;
    for (const f of walk(join(root, 'src/course')).filter((p) => p.endsWith('.tsx'))) {
      const rel = f.slice(root.length + 1);
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(JSX_TEXT)) {
        const text = m[1].trim();
        if (!text || ALLOWED.has(text)) continue;
        const line = src.slice(0, m.index ?? 0).split('\n').length;
        problems.push(`${rel}:${line}: unwrapped JSX text: ${JSON.stringify(text)}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every translated entry in src/i18n/zh-TW.ts has matching {placeholders}', () => {
    const mismatches: string[] = [];
    for (const [en, zh] of Object.entries(ZH)) {
      if (!zh) continue;
      if (holes(stripContext(en)) !== holes(zh)) {
        mismatches.push(`en={${holes(stripContext(en))}} vs zh={${holes(zh)}} for ${JSON.stringify(en.slice(0, 80))}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
