// Translation. The English text in the code is the message id (gettext style).
// Other languages look up the message id in their catalog and fall back to the English text.
// Disambiguated keys carry a context suffix ("Off@@not-used") stripped before display; only a
// catalog id has one, so a user's own text with "@@" is shown as written.
// Legacy Chinese message ids are mapped back to English so old design files still translate.
// Placeholders are written {name}: t('{s} s@@at', { s: 20 }).
import { ZH } from './zh-TW.ts';
import { SAME_IN_ZH } from './same.ts';

export type Lang = string;

export interface LocaleInfo {
  code: string;
  label: string;
  intlLocale: string;
  htmlLang: string;
  wordSeparator: string;
}

interface LocaleDefinition extends LocaleInfo {
  messages: Record<string, string>;
}

const EN_LOCALE: LocaleDefinition = {
  code: 'en',
  label: 'English',
  intlLocale: 'en-US',
  htmlLang: 'en',
  wordSeparator: ' ',
  messages: {},
};

const LOCALES: Record<string, LocaleDefinition> = {
  en: EN_LOCALE,
};

// Dynamic discovery
const isNode = typeof process !== 'undefined' && process.versions != null && process.versions.node != null && typeof globalThis.window === 'undefined';

if (!isNode) {
  // Vite / Vitest client environment: import.meta.glob is statically transformed
  const modules = import.meta.glob<{ default?: LocaleDefinition; [key: string]: unknown }>('./locales/*.ts', { eager: true });
  for (const [path, mod] of Object.entries(modules)) {
    const loc = (mod.default ?? Object.values(mod).find((v) => v && typeof v === 'object' && 'code' in v && 'messages' in v)) as LocaleDefinition | undefined;
    if (loc && loc.code) {
      LOCALES[loc.code] = loc;
    } else {
      const code = path.split('/').pop()!.replace(/\.ts$/, '');
      LOCALES[code] = {
        code,
        label: code,
        intlLocale: code,
        htmlLang: code,
        wordSeparator: ' ',
        messages: (mod as unknown as Record<string, string>) ?? {},
      };
    }
  }
} else {
  // Node.js environment fallback
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const currentDir = path.dirname(url.fileURLToPath(import.meta.url));
    const localesDir = path.join(currentDir, 'locales');
    if (fs.existsSync(localesDir)) {
      for (const file of fs.readdirSync(localesDir)) {
        if (file.endsWith('.ts') || file.endsWith('.js')) {
          const mod = await import(/* @vite-ignore */ url.pathToFileURL(path.join(localesDir, file)).href);
          const loc = (mod.default ?? Object.values(mod).find((v) => v && typeof v === 'object' && 'code' in v && 'messages' in v)) as LocaleDefinition | undefined;
          if (loc && loc.code) {
            LOCALES[loc.code] = loc;
          }
        }
      }
    }
  } catch {
    // If dynamic load fails in Node, at least guarantee zh-TW
    LOCALES['zh-TW'] = {
      code: 'zh-TW',
      label: '繁體中文',
      intlLocale: 'zh-TW',
      htmlLang: 'zh-Hant',
      wordSeparator: '',
      messages: ZH,
    };
  }
}

// Fallback if zh-TW was not discovered (e.g. empty locales or import failure)
if (!LOCALES['zh-TW']) {
  LOCALES['zh-TW'] = {
    code: 'zh-TW',
    label: '繁體中文',
    intlLocale: 'zh-TW',
    htmlLang: 'zh-Hant',
    wordSeparator: '',
    messages: ZH,
  };
}

export function registerLocale(loc: LocaleDefinition): void {
  LOCALES[loc.code] = loc;
  if (!LANGS.includes(loc.code)) {
    LANGS.push(loc.code);
  }
}

export function unregisterLocale(code: string): void {
  delete LOCALES[code];
  const idx = LANGS.indexOf(code);
  if (idx >= 0) LANGS.splice(idx, 1);
}

// Order: zh-TW, en, then others sorted by code
export const LANGS: Lang[] = Object.keys(LOCALES).sort((a, b) => {
  if (a === 'zh-TW') return -1;
  if (b === 'zh-TW') return 1;
  if (a === 'en') return -1;
  if (b === 'en') return 1;
  return a.localeCompare(b);
});

export function getLocaleInfo(code = lang): LocaleInfo {
  return LOCALES[code] ?? LOCALES[pickLang(code)] ?? EN_LOCALE;
}

export function getAllLocales(): LocaleInfo[] {
  return LANGS.map((code) => LOCALES[code] ?? { code, label: code, intlLocale: code, htmlLang: code, wordSeparator: ' ' });
}

export function stripContext(msg: string): string {
  const i = msg.indexOf('@@');
  return i < 0 ? msg : msg.slice(0, i);
}

const ZH_TO_EN: Record<string, string> = {};
for (const [en, zh] of Object.entries(ZH)) {
  if (zh && !(zh in ZH_TO_EN)) ZH_TO_EN[zh] = stripContext(en);
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
  // Exact match
  if (raw in LOCALES) return raw;
  // Normalized match e.g. zh_TW -> zh-TW
  const normalized = raw.replace('_', '-');
  for (const key of Object.keys(LOCALES)) {
    if (key.toLowerCase() === normalized.toLowerCase()) return key;
  }
  // Language prefix match e.g. ja-JP -> ja or xx-custom -> xx-test
  const prefix = normalized.split('-')[0].toLowerCase();
  for (const key of Object.keys(LOCALES)) {
    if (key.toLowerCase() === prefix) return key;
    if (key.toLowerCase().split('-')[0] === prefix) return key;
  }
  // zh prefix defaults to zh-TW if available
  if (/^zh/i.test(raw)) {
    if ('zh-TW' in LOCALES) return 'zh-TW';
    const anyZh = Object.keys(LOCALES).find((k) => /^zh/i.test(k));
    if (anyZh) return anyZh;
  }
  return 'en';
}

const has = (o: Record<string, string>, k: string) => Object.hasOwn(o, k);
/** The text of a message id with no translation: a catalog id loses its @@context, other text stays. */
const plain = (msg: string) => (has(ZH, msg) || SAME_IN_ZH.has(msg) ? stripContext(msg) : msg);

export function t(msg: string, vars?: Record<string, string | number>): string {
  const loc = LOCALES[lang];
  const cat = loc?.messages;
  let s: string;
  if (cat && has(cat, msg) && cat[msg]) {
    s = cat[msg];
  } else if (lang === 'en') {
    s = (has(ZH_TO_EN, msg) && ZH_TO_EN[msg]) || plain(msg);
  } else {
    // Missing in current non-en language: fallback to plain English text or legacy ZH_TO_EN
    s = (has(ZH_TO_EN, msg) && ZH_TO_EN[msg]) || plain(msg);
  }
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** Whether the message has a translation in the current language (English always has). */
export function translated(msg: string): boolean {
  if (lang === 'en') return true;
  const loc = LOCALES[lang];
  const cat = loc?.messages;
  return !!(cat && has(cat, msg) && cat[msg]);
}

/** Marks a message for extraction without translating it here (translate it where it is shown). */
export const tx = (msg: string): string => msg;
