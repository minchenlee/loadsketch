// Translation. The English text in the code is the message id (gettext style);
// Traditional Chinese looks it up in ZH and falls back to the English text.
// Disambiguated keys carry a context suffix ("Off@@not-used") stripped before display.
// Legacy Chinese message ids are mapped back to English so old design files still translate.
// Placeholders are written {name}: t('{s} s@@at', { s: 20 }).
import { ZH } from './zh-TW.ts';

export type Lang = 'zh-TW' | 'en';
export const LANGS: Lang[] = ['zh-TW', 'en'];

const CATALOGS: Record<Lang, Record<string, string> | null> = { 'zh-TW': ZH, en: null };

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
/** 'en' for anything that is not Chinese. */
export function pickLang(code: string | null | undefined): Lang {
  return code && /^zh/i.test(code) ? 'zh-TW' : 'en';
}

export function t(msg: string, vars?: Record<string, string | number>): string {
  const cat = CATALOGS[lang];
  const s = cat ? cat[msg] || stripContext(msg) : ZH_TO_EN[msg] || stripContext(msg);
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** Whether the message has a translation in the current language (English always has). */
export function translated(msg: string): boolean {
  const cat = CATALOGS[lang];
  return !cat || !!cat[msg];
}

/** Marks a message for extraction without translating it here (translate it where it is shown). */
export const tx = (msg: string): string => msg;
