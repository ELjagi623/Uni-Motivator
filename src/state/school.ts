// The school's name: asked in the onboarding, shown in the dashboard's title bar, and renamed in the settings.
// Saved in `config.school`. It is a plain text edit (no unit prices depend on it), so it is saved as you type.

import { computed } from '@preact/signals';
import { config, setConfig } from './data';

export const SCHOOL_MAX_LENGTH = 80;

/** The saved name exactly as typed (may be empty). */
export const schoolName = computed<string>(() => (typeof config.value.school === 'string' ? config.value.school : ''));

export function setSchoolName(next: string): void {
  setConfig({ ...config.peek(), school: next.slice(0, SCHOOL_MAX_LENGTH) });
}
