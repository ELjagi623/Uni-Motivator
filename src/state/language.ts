// Interface language: zh-CN, zh-TW or en. The choice is saved in `config.language` and mirrored in localStorage (so the
// first render after a reload already speaks the right language); `<html lang>` follows. Everything that calls t()
// updates by itself, because the current language is a signal (src/i18n/index.ts).

import { computed, effect } from '@preact/signals';
import { DEFAULT_LOCALE, isLocale, mirrorLocale, setLocale, type Locale } from '../i18n';
import { config, loadStatus, setConfig } from './data';

/** The saved language (default zh-CN). */
export const languageChoice = computed<Locale>(() => (isLocale(config.value.language) ? config.value.language : DEFAULT_LOCALE));

/** Choose a language: the interface changes at once and the choice is saved. */
export function chooseLanguage(next: Locale): void {
  setLocale(next);
  mirrorLocale(next);
  setConfig({ ...config.peek(), language: next });
}

/** Once the config is loaded it decides the language (until then the localStorage mirror did). Returns the stop function. */
export function installLanguage(): () => void {
  return effect(() => {
    if (loadStatus.value !== 'ready') return;
    const choice = languageChoice.value;
    setLocale(choice);
    mirrorLocale(choice);
  });
}
