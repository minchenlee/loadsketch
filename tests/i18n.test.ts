import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ZH } from '../src/i18n/zh-TW.ts';
import { getAllLocales, getLocaleInfo, pickLang, setLang, stripContext, t } from '../src/i18n/index.ts';
import { isLocaleFile, parseLocaleModule } from '../src/i18n/locale.ts';
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

  it('t() fills placeholders, strips @@context, falls back to English, and preserves unknown Chinese in zh-TW while translating legacy ids in en', () => {
    expect(t('Second {at}: traffic {m}×{span}', { at: 20, m: 3, span: '' })).toBe('第 20 秒流量變 3 倍');
    // a new id the extractor added with empty Chinese: shown in English, without the @@context
    ZH['Missing message {x}@@ctx'] = '';
    try {
      expect(t('Missing message {x}@@ctx', { x: 1 })).toBe('Missing message 1');
      setLang('en');
      expect(t('Missing message {x}@@ctx', { x: 1 })).toBe('Missing message 1');
    } finally {
      delete ZH['Missing message {x}@@ctx'];
    }
    expect(t('Off@@not-used')).toBe('Off');
    expect(t('primary')).toBe('primary');

    // Paired test: zh-TW preserves unknown keys as-is; en reverse-translates legacy Chinese ids
    setLang('zh-TW');
    expect(t('主庫')).toBe('主庫');
    setLang('en');
    expect(t('主庫')).toBe('Primary');
  });

  it('discovers built-in locales via import.meta.glob and ignores Object.prototype keys in pickLang', () => {
    expect(getAllLocales().map((l) => l.code)).toEqual(['zh-TW', 'en']);
    expect(pickLang('zh_TW')).toBe('zh-TW');
    expect(pickLang('zh-CN')).toBe('zh-TW');
    expect(pickLang('fr-FR')).toBe('en');
    for (const key of ['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty']) {
      expect(pickLang(key)).toBe('en');
      expect(getLocaleInfo(key).code).toBe('en');
    }
  });
});

describe('user text', () => {
  it('a user\'s own text with @@ is shown as written in both languages; a catalog id still loses its @@context', () => {
    const sc = { name: '壓測@@臺北' } as Scenario;
    for (const l of ['zh-TW', 'en'] as const) {
      setLang(l);
      expect(t('壓測@@臺北')).toBe('壓測@@臺北');
      expect(localizeScenario(sc).name).toBe('壓測@@臺北');
      expect(localizeDesign({ name: 'a@@b', nodes: [{ label: 'x@@y' }] } as unknown as Design).nodes[0].label).toBe('x@@y');
    }
    setLang('en');
    expect(t('Arrivals@@how')).toBe('Arrivals');
    expect(t('Database@@kind')).toBe('Database');
    setLang('zh-TW');
    // an id that stays English in Chinese (src/i18n/same.ts) is a catalog id too
    expect(t('Database@@kind')).toBe('Database');
    setLang('zh-TW');
    expect(t('Arrivals@@how')).toBe('請求怎麼到');
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

describe('adding a third language (isolated fixture)', () => {
  it('auto-discovers a third language in a fresh process, translates matched keys including SAME_IN_ZH, falls back to English, and checks with i18n-extract', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loadsketch-i18n-'));
    try {
      const fakeLangCode = 'xx-test';
      const keyWithPlaceholder = 'Second {at}: traffic {m}×{span}';
      const sameInZhKey = 'p99 ≤ {v}';

      writeFileSync(
        join(dir, `${fakeLangCode}.ts`),
        `export default {\n` +
          `  code: '${fakeLangCode}',\n` +
          `  label: 'TestLang',\n` +
          `  intlLocale: 'en-US',\n` +
          `  htmlLang: 'xx',\n` +
          `  wordSeparator: ' ',\n` +
          `  messages: {\n` +
          `    ${JSON.stringify(keyWithPlaceholder)}: 'FAKE_TRANSLATION {at} {m}{span}',\n` +
          `    ${JSON.stringify(sameInZhKey)}: 'P99 <= {v}',\n` +
          `  },\n` +
          `};\n`,
        'utf8',
      );

      // 1. Real Node discovery path in a fresh process with LOADSKETCH_LOCALES_DIR
      const probe = `
        import assert from 'node:assert/strict';
        import { LANGS, getAllLocales, getLang, getLocaleInfo, pickLang, setLang, t } from './src/i18n/index.ts';
        assert.ok(LANGS.includes('xx-test'), 'LANGS should include xx-test');
        assert.ok(getAllLocales().some((l) => l.code === 'xx-test' && l.label === 'TestLang'));
        assert.equal(pickLang('xx-test'), 'xx-test');
        assert.equal(pickLang('xx_TEST'), 'xx-test');
        assert.equal(pickLang('xx-custom'), 'xx-test');
        assert.equal(pickLang('toString'), 'en');
        setLang('xx-test');
        assert.equal(getLang(), 'xx-test');
        assert.equal(getLocaleInfo().wordSeparator, ' ');
        assert.equal(t(${JSON.stringify(keyWithPlaceholder)}, { at: 10, m: 2, span: '' }), 'FAKE_TRANSLATION 10 2');
        assert.equal(t(${JSON.stringify(sameInZhKey)}, { v: 500 }), 'P99 <= 500');
        assert.equal(t('Off@@not-used'), 'Off');
        assert.equal(t('Database@@kind'), 'Database');
        assert.equal(t('主庫'), 'Primary');
        assert.equal(t('壓測@@臺北'), '壓測@@臺北');
      `;
      const runtimeRes = spawnSync('node', ['--input-type=module', '-e', probe], {
        cwd: root,
        env: { ...process.env, LOADSKETCH_LOCALES_DIR: dir },
        encoding: 'utf8',
      });
      expect(runtimeRes.status, runtimeRes.stderr).toBe(0);

      // CLI --help reflects discovered languages
      const helpRes = spawnSync('node', ['cli/loadsketch.ts', '--help'], {
        cwd: root,
        env: { ...process.env, LOADSKETCH_LOCALES_DIR: dir },
        encoding: 'utf8',
      });
      expect(helpRes.status).toBe(0);
      expect(helpRes.stdout).toContain('zh-TW|en|xx-test');

      // 2. i18n-extract --check exits 0, warns about missing keys, and accepts SAME_IN_ZH keys
      const checkRes = spawnSync('node', ['scripts/i18n-extract.ts', '--check', '--locales-dir', dir], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(checkRes.status).toBe(0);
      expect(checkRes.stderr).toContain(fakeLangCode);
      expect(checkRes.stderr).toContain('missing translation(s)');
      expect(checkRes.stderr).not.toContain('extra key(s)');

      // 3. i18n-extract --check --strict exits non-zero and lists the language missing translations
      const strictRes = spawnSync('node', ['scripts/i18n-extract.ts', '--check', '--strict', '--locales-dir', dir], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(strictRes.status).not.toBe(0);
      expect(strictRes.stderr).toContain(fakeLangCode);
      expect(strictRes.stderr).toContain('missing translation(s)');

      // 4. i18n-extract --add creates a valid scaffold with metadata and full English IDs (including SAME_IN_ZH)
      const addRes = spawnSync('node', ['scripts/i18n-extract.ts', '--add', 'zz-new', '--locales-dir', dir], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(addRes.status, addRes.stderr).toBe(0);
      const addedFile = join(dir, 'zz-new.ts');
      expect(existsSync(addedFile)).toBe(true);
      const addedText = readFileSync(addedFile, 'utf8');
      expect(addedText).toContain('machine-translated, not proofread');
      expect(addedText).toContain(`code: "zz-new"`);
      expect(addedText).toContain(`"p99 ≤ {v}": ""`);
      expect(addedText).toContain(`"Second {at}: traffic {m}×{span}": ""`);

      const checkAdded = spawnSync('node', ['scripts/i18n-extract.ts', '--check', '--locales-dir', dir], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(checkAdded.status).toBe(0);
      expect(checkAdded.stderr).toContain('zz-new');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid locale files with filename in checker, skips and warns at runtime, and ignores non-.ts files', () => {
    expect(isLocaleFile('ja.ts')).toBe(true);
    expect(isLocaleFile('ja.js')).toBe(false);
    expect(isLocaleFile('ja.d.ts')).toBe(false);
    expect(parseLocaleModule({ default: { code: 'bad', label: 'Bad', intlLocale: 'bad', htmlLang: 'bad', messages: {} } }, 'bad.ts')).toEqual({
      ok: false,
      error: 'bad.ts: "wordSeparator" must be a string',
    });
    expect(
      parseLocaleModule(
        { default: { code: 'bad', label: 'Bad', intlLocale: 'bad', htmlLang: 'bad', wordSeparator: ' ', messages: { Run: 123 } } },
        'bad.ts',
      ),
    ).toEqual({
      ok: false,
      error: 'bad.ts: messages["Run"] must be a string',
    });

    const dir = mkdtempSync(join(tmpdir(), 'loadsketch-bad-locale-'));
    try {
      writeFileSync(
        join(dir, 'bad-locale.ts'),
        `export default { code: 'bad', label: 'Bad', intlLocale: 'bad', htmlLang: 'bad', messages: { Run: 'X' } };\n`,
        'utf8',
      );
      writeFileSync(
        join(dir, 'ignored.js'),
        `export default { code: 'ignored', label: 'Ignored', intlLocale: 'en-US', htmlLang: 'ig', wordSeparator: ' ', messages: {} };\n`,
        'utf8',
      );

      // Checker must fail and include the bad filename
      const checkRes = spawnSync('node', ['scripts/i18n-extract.ts', '--check', '--locales-dir', dir], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(checkRes.status).not.toBe(0);
      expect(checkRes.stderr).toContain('bad-locale.ts');
      expect(checkRes.stderr).not.toContain('ignored.js');

      // Runtime Node loader skips invalid file with console.warn(filename) and ignores .js
      const probe = `
        import assert from 'node:assert/strict';
        import { LANGS } from './src/i18n/index.ts';
        assert.deepEqual(LANGS, ['zh-TW', 'en']);
      `;
      const runtimeRes = spawnSync('node', ['--input-type=module', '-e', probe], {
        cwd: root,
        env: { ...process.env, LOADSKETCH_LOCALES_DIR: dir },
        encoding: 'utf8',
      });
      expect(runtimeRes.status, runtimeRes.stderr).toBe(0);
      expect(runtimeRes.stderr).toContain('bad-locale.ts');
      expect(runtimeRes.stderr).not.toContain('ignored.js');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
