// Importing calendar files: unzip in the browser (core), check that the text parses, POST each .ics to the server,
// and keep the texts in state. Messages are shown by the UI from the report's reason codes.

import { computed, signal } from '@preact/signals';
import { deleteCalendar, postCalendar } from '../api/client';
import { readCalendarFile } from '../core/ics/unzip';
import { calendars } from './data';
import { isParsableCalendar, parseCalendarFile } from './derived';

export interface ImportItem {
  name: string;
  data: Uint8Array;
}

export type ImportFailureReason = 'unsupported' | 'not-calendar' | 'no-ics' | 'upload';

export interface ImportReport {
  /** Calendars newly added to the data folder. */
  added: number;
  /** Names of calendars that were already imported (same content). */
  duplicates: string[];
  failures: Array<{ name: string; reason: ImportFailureReason; message?: string }>;
}

/** File name the user imported, by calendar id (display only). */
export const calendarNames = signal<Record<string, string>>({});
export const importing = signal(false);
export const importReport = signal<ImportReport | null>(null);

export interface CalendarSummary {
  id: string;
  name: string;
  sessionCount: number;
  failed: boolean;
}

export const calendarSummaries = computed<CalendarSummary[]>(() =>
  calendars.value.map((file) => {
    const parsed = parseCalendarFile(file);
    return { id: file.id, name: calendarNames.value[file.id] ?? file.id, sessionCount: parsed.sessions.length, failed: parsed.failed };
  }),
);

const CALENDAR_START = /^\s*BEGIN:VCALENDAR/i;

/** Import dropped / chosen files. Never throws: problems are listed in the returned report. */
export async function importFiles(items: readonly ImportItem[]): Promise<ImportReport> {
  const report: ImportReport = { added: 0, duplicates: [], failures: [] };
  importing.value = true;
  try {
    for (const item of items) {
      const lower = item.name.toLowerCase();
      if (!lower.endsWith('.zip') && !lower.endsWith('.ics')) {
        report.failures.push({ name: item.name, reason: 'unsupported' });
        continue;
      }
      let entries;
      try {
        entries = readCalendarFile(item.name, item.data);
      } catch {
        report.failures.push({ name: item.name, reason: 'no-ics' });
        continue;
      }
      if (entries.length === 0) {
        report.failures.push({ name: item.name, reason: 'no-ics' });
        continue;
      }
      for (const entry of entries) {
        const label = entries.length === 1 ? item.name : `${item.name}/${entry.name}`;
        if (!CALENDAR_START.test(entry.text) || !isParsableCalendar(entry.text)) {
          report.failures.push({ name: label, reason: 'not-calendar' });
          continue;
        }
        try {
          const id = await postCalendar(entry.text);
          if (calendars.value.some((c) => c.id === id)) {
            report.duplicates.push(label);
          } else {
            calendars.value = [...calendars.value, { id, text: entry.text }];
            calendarNames.value = { ...calendarNames.value, [id]: label };
            report.added += 1;
          }
        } catch (err) {
          report.failures.push({ name: label, reason: 'upload', message: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  } finally {
    importing.value = false;
  }
  importReport.value = report;
  return report;
}

/** Delete a calendar on the server and forget it locally. */
export async function removeCalendar(id: string): Promise<void> {
  await deleteCalendar(id);
  calendars.value = calendars.value.filter((c) => c.id !== id);
  const { [id]: _gone, ...rest } = calendarNames.value;
  void _gone;
  calendarNames.value = rest;
}

export function resetCalendarState(): void {
  calendarNames.value = {};
  importing.value = false;
  importReport.value = null;
}
