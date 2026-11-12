// Lightweight i18n: every user-visible string lives in a dictionary under src/i18n and is looked up with t().
// Only zh-CN exists for now; further languages are added as more dictionaries with the same keys.

import { zhCN } from './zh-CN';

export type MessageKey = keyof typeof zhCN;
export type MessageParams = Record<string, string | number>;

const dictionaries = { 'zh-CN': zhCN } as const;
export type Locale = keyof typeof dictionaries;

let locale: Locale = 'zh-CN';

export function setLocale(next: Locale): void {
  locale = next;
}

export function getLocale(): Locale {
  return locale;
}

/** Look a message up and fill `{name}` placeholders. An unknown key returns the key itself. */
export function t(key: MessageKey, params?: MessageParams): string {
  const template: string = dictionaries[locale][key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}
