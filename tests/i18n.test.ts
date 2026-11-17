import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ZH } from '../src/i18n/zh-TW.ts';
import { setLang, stripContext, t } from '../src/i18n/index.ts';
import { localizeDesign, localizeScenario } from '../src/i18n/content.ts';
import { simulate } from '../src/engine/index.ts';
import { checkDesign, type Design, type Scenario } from '../src/schema/design.ts';

const root = join(import.meta.dirname, '..');
const CJK = /[　-〿一-鿿＀-￯]/;
const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const read = <T,>(p: string) => JSON.parse(readFileSync(join(root, p), 'utf8')) as T;

afterEach(() => setLang('zh-TW'));

describe('i18n catalog', () => {
  it('the catalog is up to date with the code (scripts/i18n-extract.ts --check)', () => {
    execFileSync('node', ['scripts/i18n-extract.ts', '--check'], { cwd: root, stdio: 'pipe' });
  });

  // An empty value is allowed: i18n:check lists it and the nightly --strict run fails on it.
  it('English ids have no Chinese; every Traditional Chinese text is Chinese and has the same placeholders', () => {
    const bad = Object.entries(ZH).filter(([en, zh]) => CJK.test(en) || (zh !== '' && (!CJK.test(zh) || holes(stripContext(en)).join() !== holes(zh).join())));
    expect(bad).toEqual([]);
  });

  it('t() fills placeholders, strips @@context, falls back to English, and translates legacy Chinese ids in en mode', () => {
    expect(t('Second {at}: traffic {m}×{span}', { at: 20, m: 3, span: '' })).toBe('第 20 秒流量變 3 倍');
    expect(t('Missing message {x}@@ctx', { x: 1 })).toBe('Missing message 1');
    setLang('en');
    expect(t('Missing message {x}@@ctx', { x: 1 })).toBe('Missing message 1');
    expect(t('Off@@not-used')).toBe('Off');
    expect(t('primary')).toBe('primary');
    // legacy Chinese id in an old design file still translates in English mode
    expect(t('主庫')).toBe('Primary');
  });
});

describe('English and Traditional Chinese output', () => {
  const examples = readdirSync(join(root, 'examples/designs')).filter((f) => f.endsWith('.json'));

  it.each(examples)('%s: events, bottleneck and warnings have no Chinese in English, and translate in zh-TW', (f) => {
    const rawD = read<Design>(`examples/designs/${f}`);
    const rawSc = read<Scenario>('examples/scenarios/spike.json');

    setLang('en');
    const d = localizeDesign(rawD);
    const sc = localizeScenario(rawSc);
    expect(JSON.stringify([d.name, d.description, d.nodes.map((n) => n.label), d.notes])).not.toMatch(CJK);
    const r = simulate(d, { ...sc, durationS: 20 });
    const text = [r.bottleneck?.why ?? '', ...r.timeline.map((e) => e.text), ...Object.values(r.nodes).map((n) => n.label), ...checkDesign(d).map((i) => i.message)];
    expect(text.filter((s) => CJK.test(s))).toEqual([]);
    // sentences joined without a space ("64%.Most")
    expect(r.bottleneck?.why ?? '').not.toMatch(/[.;:][A-Z]/);

    setLang('zh-TW');
    const zhD = localizeDesign(rawD);
    // An English-only contribution leaves its Chinese empty: then zh-TW shows the English.
    if (ZH[rawD.name]) expect(zhD.name).toMatch(CJK);
    if (rawD.description && ZH[rawD.description]) expect(zhD.description).toMatch(CJK);
  });

  it('the CLI prints English with --lang en', () => {
    const out = execFileSync('node', ['cli/loadsketch.ts', 'run', 'examples/designs/priority-shedding.json', '--scenario', 'examples/scenarios/spike.json', '--duration', '20', '--lang', 'en'], { cwd: root, encoding: 'utf8' });
    expect(out).toContain('Bottleneck');
    expect(out.split('\n').filter((l) => CJK.test(l))).toEqual([]);
  });
});
