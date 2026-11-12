// Interface size: the whole page is zoomed by a percentage the user picks in the settings (default 100 %).
// Saved in `config.uiScale`, mirrored in localStorage so the first paint after a reload already has the right size, and
// applied through the `--ui-scale` custom property that base.css turns into `zoom` on <html>.

import { computed, effect } from '@preact/signals';
import { config, loadStatus, setConfig } from './data';

export const SCALE_MIN = 70;
export const SCALE_MAX = 200;
export const SCALE_STEP = 5;
/** The size a fresh install starts with; base.css falls back to the same factor (1.2) when --ui-scale is not set. */
export const DEFAULT_SCALE = 120;
export const SCALE_STORAGE_KEY = 'tt.scale';

/** A usable percentage: finite and inside the allowed range (rounded to a whole percent). */
export function clampScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SCALE;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(value)));
}

/** The saved interface size in percent (default 120). */
export const uiScale = computed<number>(() => clampScale(config.value.uiScale));

/** Zoom the page. The default size removes the property again (the CSS fallback is the default). */
export function applyScale(percent: number, root: HTMLElement = document.documentElement): void {
  if (percent === DEFAULT_SCALE) root.style.removeProperty('--ui-scale');
  else root.style.setProperty('--ui-scale', String(percent / 100));
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // blocked storage (private window, site data off)
  }
}

function mirrorScale(percent: number): void {
  try {
    const s = storage();
    if (!s) return;
    if (percent === DEFAULT_SCALE) s.removeItem(SCALE_STORAGE_KEY);
    else s.setItem(SCALE_STORAGE_KEY, String(percent));
  } catch {
    /* the mirror is only an optimisation against a flash of the wrong size */
  }
}

/** The size remembered by the last visit, or null. */
export function readStoredScale(): number | null {
  try {
    const raw = storage()?.getItem(SCALE_STORAGE_KEY);
    return raw ? clampScale(Number(raw)) : null;
  } catch {
    return null;
  }
}

/** Choose an interface size: it takes effect at once and is saved. */
export function setUiScale(percent: number): void {
  const next = clampScale(percent);
  applyScale(next);
  mirrorScale(next);
  setConfig({ ...config.peek(), uiScale: next });
}

/** Apply the remembered size before the first render, and follow the saved config once it has loaded. */
export function installScale(): () => void {
  const stored = readStoredScale();
  if (stored !== null) applyScale(stored);
  return effect(() => {
    if (loadStatus.value !== 'ready') return;
    const percent = uiScale.value;
    applyScale(percent);
    mirrorScale(percent);
  });
}
