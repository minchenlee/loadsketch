import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EN } from '../src/i18n/en.ts';
import { setLang, t } from '../src/i18n/index.ts';
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

  it('every message has an English text with the same placeholders and no Chinese', () => {
    const bad = Object.entries(EN).filter(([zh, en]) => !en || CJK.test(en) || holes(zh).join() !== holes(en).join());
    expect(bad).toEqual([]);
  });

  it('t() fills placeholders and falls back to the Chinese text', () => {
    expect(t('第 {at} 秒流量變 {m} 倍{span}', { at: 20, m: 3, span: '' })).toBe('第 20 秒流量變 3 倍');
    setLang('en');
    expect(t('沒有這則訊息 {x}', { x: 1 })).toBe('沒有這則訊息 1');
    expect(t('主庫')).not.toMatch(CJK);
  });
});

describe('English output', () => {
  const examples = readdirSync(join(root, 'examples/designs')).filter((f) => f.endsWith('.json'));

  it.each(examples)('%s: events, bottleneck and warnings have no Chinese in English', (f) => {
    setLang('en');
    const d = localizeDesign(read<Design>(`examples/designs/${f}`));
    const sc = localizeScenario(read<Scenario>('examples/scenarios/spike.json'));
    expect(JSON.stringify([d.name, d.description, d.nodes.map((n) => n.label), d.notes])).not.toMatch(CJK);
    const r = simulate(d, { ...sc, durationS: 20 });
    const text = [r.bottleneck?.why ?? '', ...r.timeline.map((e) => e.text), ...Object.values(r.nodes).map((n) => n.label), ...checkDesign(d).map((i) => i.message)];
    expect(text.filter((s) => CJK.test(s))).toEqual([]);
    // sentences joined without a space ("64%.Most")
    expect(r.bottleneck?.why ?? '').not.toMatch(/[.;:][A-Z]/);
  });

  it('the CLI prints English with --lang en', () => {
    const out = execFileSync('node', ['cli/loadsketch.ts', 'run', 'examples/designs/priority-shedding.json', '--scenario', 'examples/scenarios/spike.json', '--duration', '20', '--lang', 'en'], { cwd: root, encoding: 'utf8' });
    expect(out).toContain('Bottleneck');
    expect(out.split('\n').filter((l) => CJK.test(l))).toEqual([]);
  });
});
