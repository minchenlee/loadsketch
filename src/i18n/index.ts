// Translation. The English text in the code is the message id (gettext style).
// Other languages look up the message id in their catalog and fall back to the English text.
// Disambiguated keys carry a context suffix ("Off@@not-used") stripped before display; only a
// catalog id has one, so a user's own text with "@@" is shown as written.
// Legacy Chinese message ids are mapped back to English so old design files still translate.
// Placeholders are written {name}: t('{s} s@@at', { s: 20 }).
import { ZH } from './zh-TW.ts';
import { SAME_IN_ZH } from './same.ts';
import { isLocaleFile, parseLocaleModule, type LocaleDefinition, type LocaleInfo } from './locale.ts';

export type Lang = string;
export type { LocaleInfo, LocaleDefinition };

const EN_LOCALE: LocaleDefinition = {
  code: 'en',
  label: 'English',
  intlLocale: 'en-US',
  htmlLang: 'en',
  wordSeparator: ' ',
  messages: {},
};

const ZH_FALLBACK_LOCALE: LocaleDefinition = {
  code: 'zh-TW',
  label: '繁體中文',
  intlLocale: 'zh-TW',
  htmlLang: 'zh-Hant',
  wordSeparator: '',
  messages: ZH,
};

const LOCALES = new Map<string, LocaleDefinition>([['en', EN_LOCALE]]);

function registerLocaleModule(file: string, mod: unknown, target: Map<string, LocaleDefinition>, seenLower: Set<string>): void {
  const res = parseLocaleModule(mod, file);
  if (!res.ok) {
    console.warn(`[i18n] skipping invalid locale: ${res.error}`);
    return;
  }
  const lower = res.locale.code.toLowerCase();
  if (seenLower.has(lower)) {
    console.warn(`[i18n] skipping duplicate locale code ${JSON.stringify(res.locale.code)} in ${file}`);
    return;
  }
  seenLower.add(lower);
  target.set(res.locale.code, res.locale);
}

async function scanNodeLocalesDir(dir: string, target: Map<string, LocaleDefinition>, seenLower: Set<string>): Promise<void> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir).sort()) {
    if (!isLocaleFile(file)) continue;
    try {
      const mod = await import(/* @vite-ignore */ url.pathToFileURL(path.join(dir, file)).href);
      registerLocaleModule(file, mod, target, seenLower);
    } catch (err) {
      console.warn(`[i18n] failed to load locale ${file}:`, err);
    }
  }
}

// Vite / Vitest environments define import.meta.env.MODE (folded statically at build time, so
// browser/worker bundles tree-shake the Node branch and emit no node:fs import or top-level await).
if (typeof import.meta.env !== 'undefined' && import.meta.env.MODE) {
  const seenLower = new Set<string>(['en']);
  const modules = import.meta.glob('./locales/*.ts', { eager: true });
  for (const [path, mod] of Object.entries(modules)) {
    if (!isLocaleFile(path)) continue;
    registerLocaleModule(path, mod, LOCALES, seenLower);
  }
} else {
  // Native Node.js (CLI and scripts): always scan this package's src/i18n/locales directory.
  try {
    const path = await import('node:path');
    const url = await import('node:url');
    const currentDir = path.dirname(url.fileURLToPath(import.meta.url));
    const seenLower = new Set<string>(['en']);
    await scanNodeLocalesDir(path.join(currentDir, 'locales'), LOCALES, seenLower);
  } catch (err) {
    console.warn('[i18n] failed to scan locales directory:', err);
  }
}

if (!LOCALES.has('zh-TW')) {
  LOCALES.set('zh-TW', ZH_FALLBACK_LOCALE);
}

// Order: zh-TW, en, then others sorted by code
export const LANGS: Lang[] = [];
function syncLangs(): void {
  const sorted = [...LOCALES.keys()].sort((a, b) => {
    if (a === 'zh-TW') return -1;
    if (b === 'zh-TW') return 1;
    if (a === 'en') return -1;
    if (b === 'en') return 1;
    return a.localeCompare(b);
  });
  LANGS.splice(0, LANGS.length, ...sorted);
}
syncLangs();

/** @internal Test-only helper (Vitest mode) to exercise the Node directory loader against an isolated fixture dir. */
export async function loadLocalesFromDirForTest(dir: string): Promise<() => void> {
  if (typeof import.meta.env === 'undefined' || !import.meta.env.VITEST) {
    throw new Error('loadLocalesFromDirForTest is only available in Vitest test runs');
  }
  const snapshot = new Map(LOCALES);
  const seenLower = new Set<string>([...LOCALES.keys()].map((k) => k.toLowerCase()));
  await scanNodeLocalesDir(dir, LOCALES, seenLower);
  syncLangs();
  return () => {
    LOCALES.clear();
    for (const [k, v] of snapshot) LOCALES.set(k, v);
    syncLangs();
  };
}

export function getLocaleInfo(code = lang): LocaleInfo {
  return LOCALES.get(code) ?? LOCALES.get(pickLang(code)) ?? EN_LOCALE;
}

export function getAllLocales(): LocaleInfo[] {
  return LANGS.map((code) => LOCALES.get(code)!);
}

export function stripContext(msg: string): string {
  const i = msg.indexOf('@@');
  return i < 0 ? msg : msg.slice(0, i);
}

const ZH_TO_EN = new Map<string, string>();
for (const [en, zh] of Object.entries(ZH)) {
  if (zh && !ZH_TO_EN.has(zh)) ZH_TO_EN.set(zh, stripContext(en));
}

let lang: Lang = 'zh-TW';

export function setLang(l: Lang): void {
  lang = l;
}
export function getLang(): Lang {
  return lang;
}

/** Pick the closest registered language, or 'en'. Preserves zh* -> zh-TW, other -> en if not found. */
export function pickLang(code: string | null | undefined): Lang {
  if (!code) return 'en';
  const raw = code.trim();
  if (!raw) return 'en';
  if (LOCALES.has(raw)) return raw;

  const normalized = raw.replace(/_/g, '-');
  const normLower = normalized.toLowerCase();
  for (const key of LANGS) {
    if (key.toLowerCase() === normLower) return key;
  }

  const prefix = normLower.split('-')[0];
  if (prefix) {
    for (const key of LANGS) {
      if (key.toLowerCase() === prefix) return key;
    }
    for (const key of LANGS) {
      if (key.toLowerCase().split('-')[0] === prefix) return key;
    }
  }

  if (/^zh/i.test(raw) && LOCALES.has('zh-TW')) return 'zh-TW';
  return 'en';
}

const has = (o: object, k: string) => Object.hasOwn(o, k);
/** The text of a message id with no translation: a catalog id loses its @@context, other text stays. */
const plain = (msg: string) => (has(ZH, msg) || SAME_IN_ZH.has(msg) ? stripContext(msg) : msg);

export function t(msg: string, vars?: Record<string, string | number>): string {
  const loc = LOCALES.get(lang);
  const cat = loc?.messages;
  let s: string;
  if (cat && has(cat, msg) && cat[msg]) {
    s = cat[msg];
  } else if (lang === 'zh-TW') {
    s = plain(msg);
  } else {
    // English mode, or another language falling back to English (legacy Chinese ids also map to English).
    s = ZH_TO_EN.get(msg) ?? plain(msg);
  }
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (has(vars, k) ? String(vars[k]) : m)) : s;
}

/** Whether the message has a translation in the current language (English always has). */
export function translated(msg: string): boolean {
  if (lang === 'en') return true;
  const cat = LOCALES.get(lang)?.messages;
  return !!(cat && has(cat, msg) && cat[msg]);
}

/** Marks a message for extraction without translating it here (translate it where it is shown). */
export const tx = (msg: string): string => msg;
