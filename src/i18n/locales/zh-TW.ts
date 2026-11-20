// Traditional Chinese locale definition.
import { ZH } from '../zh-TW.ts';

export interface LocaleDefinition {
  code: string;
  label: string;
  intlLocale: string;
  htmlLang: string;
  wordSeparator: string;
  messages: Record<string, string>;
}

export const zhTW: LocaleDefinition = {
  code: 'zh-TW',
  label: '繁體中文',
  intlLocale: 'zh-TW',
  htmlLang: 'zh-Hant',
  wordSeparator: '',
  messages: ZH,
};

export default zhTW;
