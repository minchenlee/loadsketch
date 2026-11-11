// Translation. The Traditional Chinese text in the code is the message id (gettext style);
// other languages look it up in their catalog and fall back to the Chinese text.
// Placeholders are written {name}: t('第 {s} 秒', { s: 20 }).
import { EN } from './en.ts';

export type Lang = 'zh-TW' | 'en';
export const LANGS: Lang[] = ['zh-TW', 'en'];

const CATALOGS: Record<Lang, Record<string, string> | null> = { 'zh-TW': null, en: EN };

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
  const s = (cat && cat[msg]) || msg;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** Whether the message has a translation in the current language (Chinese always has). */
export function translated(msg: string): boolean {
  const cat = CATALOGS[lang];
  return !cat || !!cat[msg];
}

/** Marks a message for extraction without translating it here (translate it where it is shown). */
export const tx = (msg: string): string => msg;
