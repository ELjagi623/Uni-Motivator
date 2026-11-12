// Copy templates: placeholder rendering and picking a line that differs from the previous one.

import { COPY_ZH_CN, type CopyLibrary } from '../data/copy-zh-cn';
import type { CopyScene, Intensity } from './types';

export type CopyVars = Record<string, string | number | undefined>;

const PLACEHOLDER = /\{(\w+)\}/g;

export function placeholdersOf(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1]);
}

/** Fill the placeholders. Returns null when a placeholder has no value (so no "{...}" is ever shown). */
export function renderTemplate(template: string, vars: CopyVars): string | null {
  let missing = false;
  const text = template.replace(PLACEHOLDER, (_, name: string) => {
    const v = vars[name];
    if (v === undefined || v === null || v === '') {
      missing = true;
      return '';
    }
    return String(v);
  });
  return missing ? null : text;
}

export interface PickOptions {
  intensity: Intensity;
  scene: CopyScene;
  vars: CopyVars;
  /** The text shown last; the new pick differs from it whenever another candidate exists. */
  previous?: string | null;
  /** Random source in [0, 1); injectable for tests. */
  random?: () => number;
  library?: CopyLibrary;
}

/** Pick a rendered line for the scene, or null if no template can be rendered with the given values. */
export function pickCopy(options: PickOptions): string | null {
  const library = options.library ?? COPY_ZH_CN;
  const random = options.random ?? Math.random;
  const candidates: string[] = [];
  for (const tpl of library[options.intensity][options.scene]) {
    const text = renderTemplate(tpl, options.vars);
    if (text !== null && !candidates.includes(text)) candidates.push(text);
  }
  if (candidates.length === 0) return null;
  const pool = candidates.length > 1 ? candidates.filter((t) => t !== options.previous) : candidates;
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  return pool[index];
}
