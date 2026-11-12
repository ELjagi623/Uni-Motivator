// Interface language: zh-CN, zh-TW or en. The choice is saved in `config.language` and mirrored in localStorage (so the
// first render after a reload already speaks the right language); `<html lang>` follows. Everything that calls t()
// updates by itself, because the current language is a signal (src/i18n/index.ts).

import { computed, effect } from '@preact/signals';
import { DEFAULT_LOCALE, isLocale, mirrorLocale, setLocale, type Locale } from '../i18n';
import { config, loadStatus, setConfig } from './data';

/**
 * The saved language. A new install speaks the default (English); data that was set up before the language choice
 * existed (onboarding done, no language saved) keeps the Chinese it always had.
 */
export const languageChoice = computed<Locale>(() => {
  const saved = config.value.language;
  if (isLocale(saved)) return saved;
  return config.value.onboardingDone ? 'zh-CN' : DEFAULT_LOCALE;
});

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
