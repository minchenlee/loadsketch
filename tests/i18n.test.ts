import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ZH } from '../src/i18n/zh-TW.ts';
import { LANGS, getAllLocales, getLang, getLocaleInfo, loadLocalesFromDirForTest, pickLang, setLang, stripContext, t } from '../src/i18n/index.ts';
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

  it('discovers built-in locales via import.meta.glob in expected order and ignores Object.prototype keys in pickLang', () => {
    const codes = getAllLocales().map((l) => l.code);
    expect(codes).toContain('zh-TW');
    expect(codes).toContain('en');
    expect(codes.indexOf('zh-TW')).toBeLessThan(codes.indexOf('en'));
    for (const key of ['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty']) {
      expect(pickLang(key)).toBe('en');
      expect(getLocaleInfo(key).code).toBe('en');
    }
  });

  it('picks the closest registered locale via BCP 47 subtag truncation in an isolated fixture registry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loadsketch-picklang-'));
    let restore: (() => void) | undefined;
    try {
      writeFileSync(
        join(dir, 'zh-Hant.ts'),
        `export default { code: 'zh-Hant', label: '繁中', intlLocale: 'zh-Hant', htmlLang: 'zh-Hant', wordSeparator: '', messages: {} };\n`,
        'utf8',
      );
      writeFileSync(
        join(dir, 'xx-test.ts'),
        `export default { code: 'xx-test', label: 'Test', intlLocale: 'en-US', htmlLang: 'xx', wordSeparator: ' ', messages: {} };\n`,
        'utf8',
      );
      restore = await loadLocalesFromDirForTest(dir, { isolated: true });
      expect(pickLang('zh_TW')).toBe('zh-TW');
      expect(pickLang('zh-Hant-TW')).toBe('zh-Hant');
      expect(pickLang('zh_Hant_HK')).toBe('zh-Hant');
      expect(pickLang('zh-Hant')).toBe('zh-Hant');
      expect(pickLang('zh-CN')).toBe('zh-TW');
      expect(pickLang('xx-custom')).toBe('xx-test');
      expect(pickLang('fr-FR')).toBe('en');
    } finally {
      restore?.();
      rmSync(dir, { recursive: true, force: true });
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

  it('the CLI prints English with --lang en and ignores LOADSKETCH_LOCALES_DIR env var', () => {
    const out = execFileSync('node', ['cli/loadsketch.ts', 'run', 'examples/designs/priority-shedding.json', '--scenario', 'examples/scenarios/spike.json', '--duration', '20', '--lang', 'en'], { cwd: root, encoding: 'utf8' });
    expect(out).toContain('Bottleneck');
    expect(out.split('\n').filter((l) => CJK.test(l))).toEqual([]);

    const emptyDir = mkdtempSync(join(tmpdir(), 'loadsketch-ignore-env-'));
    try {
      const helpRes = spawnSync('node', ['cli/loadsketch.ts', '--help'], {
        cwd: root,
        env: { ...process.env, LOADSKETCH_LOCALES_DIR: emptyDir },
        encoding: 'utf8',
      });
      expect(helpRes.status).toBe(0);
      expect(helpRes.stdout).toContain('--lang zh-TW|en');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe('adding a third language (isolated fixture)', () => {
  it('discovers a third language via the Node directory loader, translates matched keys including SAME_IN_ZH, falls back to English, and checks with i18n-extract', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loadsketch-i18n-'));
    let restore: (() => void) | undefined;
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

      // 1. Real Node directory discovery path via Vitest-only loader helper (no env override)
      restore = await loadLocalesFromDirForTest(dir);
      expect(LANGS).toContain(fakeLangCode);
      expect(getAllLocales().some((l) => l.code === fakeLangCode && l.label === 'TestLang')).toBe(true);
      expect(pickLang(fakeLangCode)).toBe(fakeLangCode);
      expect(pickLang('xx_TEST')).toBe(fakeLangCode);
      expect(pickLang('xx-custom')).toBe(fakeLangCode);
      expect(pickLang('toString')).toBe('en');

      setLang(fakeLangCode);
      expect(getLang()).toBe(fakeLangCode);
      expect(getLocaleInfo().wordSeparator).toBe(' ');
      expect(t(keyWithPlaceholder, { at: 10, m: 2, span: '' })).toBe('FAKE_TRANSLATION 10 2');
      expect(t(sameInZhKey, { v: 500 })).toBe('P99 <= 500');
      expect(t('Off@@not-used')).toBe('Off');
      expect(t('Database@@kind')).toBe('Database');
      expect(t('主庫')).toBe('Primary');
      expect(t('壓測@@臺北')).toBe('壓測@@臺北');

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

      // 4. Rejects mutually exclusive --check --add flags without writing file
      const mutexRes = spawnSync('node', ['scripts/i18n-extract.ts', '--check', '--add', 'pt-BR', '--locales-dir', dir], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(mutexRes.status).not.toBe(0);
      expect(existsSync(join(dir, 'pt-BR.ts'))).toBe(false);

      // 5. i18n-extract --add creates a valid scaffold with metadata and full English IDs (including SAME_IN_ZH)
      const addRes = spawnSync('node', ['scripts/i18n-extract.ts', '--add', 'pt-BR', '--locales-dir', dir], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(addRes.status, addRes.stderr).toBe(0);
      const addedFile = join(dir, 'pt-BR.ts');
      expect(existsSync(addedFile)).toBe(true);
      const addedText = readFileSync(addedFile, 'utf8');
      expect(addedText).toContain('machine-translated, not proofread');
      expect(addedText).toContain(`code: "pt-BR"`);
      expect(addedText).toContain(`"p99 ≤ {v}": ""`);
      expect(addedText).toContain(`"Second {at}: traffic {m}×{span}": ""`);

      // Re-running --add for an existing file fails via wx flag without overwriting
      const addDupRes = spawnSync('node', ['scripts/i18n-extract.ts', '--add', 'pt-BR', '--locales-dir', dir], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(addDupRes.status).not.toBe(0);
      expect(addDupRes.stderr).toContain('already exists');

      const checkAdded = spawnSync('node', ['scripts/i18n-extract.ts', '--check', '--locales-dir', dir], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(checkAdded.status).toBe(0);
      expect(checkAdded.stderr).toContain('pt-BR');
    } finally {
      restore?.();
      setLang('zh-TW');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid metadata (BCP 47, filename stem, built-in case conflicts, duplicates), nonexistent --locales-dir, and non-.ts files', async () => {
    expect(isLocaleFile('ja.ts')).toBe(true);
    expect(isLocaleFile('ja.js')).toBe(false);
    expect(isLocaleFile('ja.d.ts')).toBe(false);

    // Missing wordSeparator
    expect(parseLocaleModule({ default: { code: 'bad', label: 'Bad', intlLocale: 'en-US', htmlLang: 'en', messages: {} } }, 'bad.ts')).toEqual({
      ok: false,
      error: 'bad.ts: "wordSeparator" must be a string',
    });
    // Non-string message value
    expect(
      parseLocaleModule(
        { default: { code: 'bad', label: 'Bad', intlLocale: 'en-US', htmlLang: 'en', wordSeparator: ' ', messages: { Run: 123 } } },
        'bad.ts',
      ),
    ).toEqual({
      ok: false,
      error: 'bad.ts: messages["Run"] must be a string',
    });
    // Invalid BCP 47 tag (underscore ja_JP would throw RangeError in Intl toLocaleTimeString)
    expect(
      parseLocaleModule(
        { default: { code: 'ja', label: '日本語', intlLocale: 'ja_JP', htmlLang: 'ja', wordSeparator: '', messages: {} } },
        'ja.ts',
      ).ok,
    ).toBe(false);
    // Code must match filename stem
    expect(
      parseLocaleModule(
        { default: { code: 'fr', label: 'Français', intlLocale: 'fr-FR', htmlLang: 'fr', wordSeparator: ' ', messages: {} } },
        'ja.ts',
      ).ok,
    ).toBe(false);
    // Built-in case-only conflicts
    expect(
      parseLocaleModule(
        { default: { code: 'EN', label: 'English', intlLocale: 'en-US', htmlLang: 'en', wordSeparator: ' ', messages: {} } },
        'EN.ts',
      ).ok,
    ).toBe(false);
    expect(
      parseLocaleModule(
        { default: { code: 'zh-tw', label: '繁體中文', intlLocale: 'zh-TW', htmlLang: 'zh-Hant', wordSeparator: '', messages: {} } },
        'zh-tw.ts',
      ).ok,
    ).toBe(false);

    // Nonexistent --locales-dir fails instead of silently passing
    const missingDirRes = spawnSync('node', ['scripts/i18n-extract.ts', '--check', '--locales-dir', join(tmpdir(), 'loadsketch-does-not-exist-xyz')], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(missingDirRes.status).not.toBe(0);

    const dir = mkdtempSync(join(tmpdir(), 'loadsketch-bad-locale-'));
    let restore: (() => void) | undefined;
    try {
      writeFileSync(
        join(dir, 'bad-locale.ts'),
        `export default { code: 'bad-locale', label: 'Bad', intlLocale: 'ja_JP', htmlLang: 'ja', wordSeparator: ' ', messages: { Run: 'X' } };\n`,
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

      // Duplicate locale code across directories warns and skips at runtime
      const dupDir = mkdtempSync(join(tmpdir(), 'loadsketch-dup-locale-'));
      let dupRestore: (() => void) | undefined;
      try {
        writeFileSync(
          join(dupDir, 'zh-TW.ts'),
          `export default { code: 'zh-TW', label: '繁體中文', intlLocale: 'zh-TW', htmlLang: 'zh-Hant', wordSeparator: '', messages: {} };\n`,
          'utf8',
        );
        const dupWarns: string[] = [];
        const origWarn = console.warn;
        console.warn = (...args: unknown[]) => dupWarns.push(args.map(String).join(' '));
        try {
          dupRestore = await loadLocalesFromDirForTest(dupDir);
        } finally {
          console.warn = origWarn;
        }
        expect(dupWarns.some((w) => w.includes('duplicate locale code'))).toBe(true);
      } finally {
        dupRestore?.();
        rmSync(dupDir, { recursive: true, force: true });
      }

      // Runtime Node loader skips invalid file with console.warn(filename) and ignores .js
      const warns: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: unknown[]) => warns.push(args.map(String).join(' '));
      try {
        restore = await loadLocalesFromDirForTest(dir);
      } finally {
        console.warn = origWarn;
      }
      expect(LANGS).not.toContain('bad-locale');
      expect(LANGS).not.toContain('ignored');
      expect(warns.some((w) => w.includes('bad-locale.ts'))).toBe(true);
      expect(warns.some((w) => w.includes('ignored.js'))).toBe(false);
    } finally {
      restore?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
