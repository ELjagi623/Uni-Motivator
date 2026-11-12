// The slack records of the data being shown (real or demo). Kept in its own module so that both the dashboard model
// and the slacking logic can read it without importing each other.

import { computed } from '@preact/signals';
import type { SlackRecord } from '../core/types';
import { activeSlacks } from './source';

/** The `slacks` document holds `{schemaVersion, records: SlackRecord[]}`. */
export const slackRecords = computed<SlackRecord[]>(() => {
  const raw = activeSlacks.value.records;
  return Array.isArray(raw) ? (raw as SlackRecord[]) : [];
});
