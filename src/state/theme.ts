// Light / dark theme: "follow the system" (no attribute, tokens.css reacts to prefers-color-scheme), "light" or "dark"
// (the `data-theme` attribute on the root element forces one).
//
// The choice is saved in `config.theme`. The config only arrives after the first request to the local server, so the
// choice is also mirrored into localStorage and index.html has a tiny inline script that sets `data-theme` from that
// mirror before the first paint (no flash of the wrong theme). When the config is loaded it is the source of truth and
// the mirror is refreshed.

import { computed, effect } from '@preact/signals';
import { DEFAULT_THEME, THEME_CHOICES, type ThemeChoice } from './config';
import { config, loadStatus, setConfig } from './data';

export const THEME_STORAGE_KEY = 'tt.theme';

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === 'string' && (THEME_CHOICES as readonly string[]).includes(value);
}

/** Set (or, for "system", remove) the `data-theme` attribute of the root element. */
export function applyTheme(choice: ThemeChoice, root: HTMLElement = document.documentElement): void {
  if (choice === 'light' || choice === 'dark') root.setAttribute('data-theme', choice);
  else root.removeAttribute('data-theme');
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // blocked storage (private window, site data off)
  }
}

export function readStoredTheme(): ThemeChoice | null {
  try {
    const value = storage()?.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(value) ? value : null;
  } catch {
    return null;
  }
}

function storeTheme(choice: ThemeChoice): void {
  try {
    const s = storage();
    if (!s) return;
    if (choice === 'system') s.removeItem(THEME_STORAGE_KEY);
    else s.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    /* the mirror is only an optimisation against flicker */
  }
}

/** The saved choice (default: follow the system). */
export const themeChoice = computed<ThemeChoice>(() => (isThemeChoice(config.value.theme) ? config.value.theme : DEFAULT_THEME));

/** Choose a theme: it takes effect at once and is saved in the config. */
export function setTheme(choice: ThemeChoice): void {
  applyTheme(choice);
  storeTheme(choice);
  setConfig({ ...config.peek(), theme: choice });
}

/** Keep the root element in line with the saved choice once the config has been loaded. Returns the stop function. */
export function installTheme(): () => void {
  return effect(() => {
    if (loadStatus.value !== 'ready') return; // until then the inline script in index.html decides
    const choice = themeChoice.value;
    applyTheme(choice);
    storeTheme(choice);
  });
}
