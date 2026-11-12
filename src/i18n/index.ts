// Lightweight i18n: every user-visible string lives in a dictionary under src/i18n and is looked up with t().
// Three languages (zh-CN is the source; zh-TW and en have exactly the same keys, which TypeScript and
// scripts/check-i18n.mjs both enforce). A key that is somehow missing falls back to zh-CN, then to the key itself.
//
// The current language is a signal, so everything that calls t() while rendering or inside a computed value updates
// when the language changes. The choice is saved in config.language and mirrored in localStorage (so that the very
// first render already uses it); <html lang> follows.

import { signal } from '@preact/signals';
import { en } from './en';
import { zhCN } from './zh-CN';
import { zhTW } from './zh-TW';

export type MessageKey = keyof typeof zhCN;
export type MessageParams = Record<string, string | number>;

export const dictionaries = { 'zh-CN': zhCN, 'zh-TW': zhTW, en } as const;
export type Locale = keyof typeof dictionaries;
export const LOCALES: readonly Locale[] = ['zh-CN', 'zh-TW', 'en'];
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_STORAGE_KEY = 'tt.lang';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

function storedLocale(): Locale | null {
  try {
    const v = typeof window === 'undefined' ? null : window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(v) ? v : null;
  } catch {
    return null; // storage blocked
  }
}

const localeSignal = signal<Locale>(storedLocale() ?? DEFAULT_LOCALE);
if (typeof document !== 'undefined') document.documentElement.lang = localeSignal.value;

export function setLocale(next: Locale): void {
  localeSignal.value = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
}

export function getLocale(): Locale {
  return localeSignal.value;
}

/** Remember the language for the next first render (the config is the source of truth once it is loaded). */
export function mirrorLocale(next: Locale): void {
  try {
    if (typeof window === 'undefined') return;
    if (next === DEFAULT_LOCALE) window.localStorage.removeItem(LOCALE_STORAGE_KEY);
    else window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
  } catch {
    /* only an optimisation */
  }
}

/** Look a message up and fill `{name}` placeholders. A key missing in the current language falls back to zh-CN. */
export function t(key: MessageKey, params?: MessageParams): string {
  const dict = dictionaries[localeSignal.value] as Record<string, string | undefined>;
  const template: string = dict[key] ?? zhCN[key] ?? key;
  if (!params) return template;
  const text = template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
  // An empty parameter (English items have no counter word) must not leave a double space behind.
  return Object.values(params).some((v) => v === '') ? text.replace(/ {2,}/g, ' ').trim() : text;
}
