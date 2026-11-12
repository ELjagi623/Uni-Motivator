// Tone of the copy lines (the rotating line during class, the lines on the slacking page): gentle / normal / extreme.
// Saved in `config.intensity`; changing it takes effect at once because the carousel reads it as a signal.

import { computed } from '@preact/signals';
import type { Intensity } from '../core/types';
import { config, setConfig } from './data';

export const INTENSITIES: readonly Intensity[] = ['gentle', 'normal', 'extreme'];
export const DEFAULT_INTENSITY: Intensity = 'normal';

export function isIntensity(value: unknown): value is Intensity {
  return typeof value === 'string' && (INTENSITIES as readonly string[]).includes(value);
}

export const copyIntensity = computed<Intensity>(() => (isIntensity(config.value.intensity) ? config.value.intensity : DEFAULT_INTENSITY));

export function setIntensity(next: Intensity): void {
  setConfig({ ...config.peek(), intensity: next });
}
