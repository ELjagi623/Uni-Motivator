// Importing calendar files: unzip in the browser (core), check that the text parses, POST each .ics to the server,
// and keep the texts in state. Messages are shown by the UI from the report's reason codes.

import { computed, signal } from '@preact/signals';
import { deleteCalendar, postCalendar } from '../api/client';
import { readCalendarFile } from '../core/ics/unzip';
import { marksOf } from './dashboard';
import type { SubscriptionInfo } from '../api/client';
import { t } from '../i18n';
import { calendars, config, marks as marksDoc, setConfig, subscriptions } from './data';
import { allSessions, isParsableCalendar, parseCalendarFile } from './derived';

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

// ------------------------------------------------------------------ settings page: add / replace / remove

export interface ReplaceReport {
  /** replaced = the new file(s) took the old one's place; unchanged = the new file is identical to the old one; failed = nothing was changed. */
  status: 'replaced' | 'unchanged' | 'failed';
  failures: ImportReport['failures'];
  sessionsBefore: number;
  sessionsAfter: number;
  /** Marks whose session exists in the new timetable (kept: the session id is `UID|original start`). */
  marksKept: number;
  /** Marks whose session is not in the new timetable any more. They stay in the file and come back if the session does. */
  marksOrphaned: number;
}

export const replaceReport = signal<ReplaceReport | null>(null);

/** The id -> display name list stored in `config.calendars`, brought in line with the calendars that exist. */
export function syncCalendarSources(): void {
  const cfg = config.peek();
  const known = new Map((cfg.calendars ?? []).map((c) => [c.id, c.name]));
  const next = calendars.peek().map((c) => ({ id: c.id, name: known.get(c.id) ?? calendarNames.peek()[c.id] ?? c.id }));
  const same = (cfg.calendars ?? []).length === next.length && next.every((c, i) => cfg.calendars?.[i]?.id === c.id && cfg.calendars?.[i]?.name === c.name);
  if (!same) setConfig({ ...cfg, calendars: next });
}

/** Add calendar files to the ones already imported (the settings page's "add"). */
export async function addCalendars(items: readonly ImportItem[]): Promise<ImportReport> {
  const report = await importFiles(items);
  if (report.added > 0) syncCalendarSources();
  return report;
}

function marksOnTimetable(sessionIds: ReadonlySet<string>): { kept: number; orphaned: number } {
  let kept = 0;
  let orphaned = 0;
  for (const id of Object.keys(marksOf(marksDoc.peek()))) {
    if (sessionIds.has(id)) kept++;
    else orphaned++;
  }
  return { kept, orphaned };
}

/**
 * Re-import: the chosen file(s) take the place of the calendar `oldId`. Sessions are merged by session id
 * (`UID|original start`), so every mark stays attached: an occurrence that the school moved keeps its original-start id
 * and therefore its mark. The old file is deleted only after the new one(s) have been stored, so a failed upload
 * changes nothing.
 */
export async function replaceCalendar(oldId: string, items: readonly ImportItem[]): Promise<ReplaceReport> {
  const before = new Set(allSessions.peek().map((s) => s.id));
  const failures: ImportReport['failures'] = [];
  const entries: Array<{ label: string; text: string }> = [];
  for (const item of items) {
    const lower = item.name.toLowerCase();
    if (!lower.endsWith('.zip') && !lower.endsWith('.ics')) {
      failures.push({ name: item.name, reason: 'unsupported' });
      continue;
    }
    let found;
    try {
      found = readCalendarFile(item.name, item.data);
    } catch {
      failures.push({ name: item.name, reason: 'no-ics' });
      continue;
    }
    if (found.length === 0) failures.push({ name: item.name, reason: 'no-ics' });
    for (const entry of found) {
      const label = found.length === 1 ? item.name : `${item.name}/${entry.name}`;
      if (!CALENDAR_START.test(entry.text) || !isParsableCalendar(entry.text)) failures.push({ name: label, reason: 'not-calendar' });
      else entries.push({ label, text: entry.text });
    }
  }
  const finish = (status: ReplaceReport['status']): ReplaceReport => {
    const after = new Set(allSessions.peek().map((s) => s.id));
    const m = marksOnTimetable(after);
    const report: ReplaceReport = { status, failures, sessionsBefore: before.size, sessionsAfter: after.size, marksKept: m.kept, marksOrphaned: m.orphaned };
    replaceReport.value = report;
    return report;
  };
  if (entries.length === 0) return finish('failed');
  const oldText = calendars.peek().find((c) => c.id === oldId)?.text;
  if (entries.length === 1 && entries[0].text === oldText) return finish('unchanged');

  importing.value = true;
  const stored: Array<{ id: string; label: string; text: string }> = [];
  try {
    for (const entry of entries) {
      try {
        stored.push({ id: await postCalendar(entry.text), label: entry.label, text: entry.text });
      } catch (err) {
        failures.push({ name: entry.label, reason: 'upload', message: err instanceof Error ? err.message : String(err) });
        // Roll back what this call stored (files that did not exist before), so that nothing half-done is left.
        for (const done of stored) {
          if (!calendars.peek().some((c) => c.id === done.id)) await deleteCalendar(done.id).catch(() => undefined);
        }
        return finish('failed');
      }
    }
    const newIds = [...new Set(stored.map((s) => s.id))];
    if (newIds.length === 1 && newIds[0] === oldId) return finish('unchanged');

    const present = new Set(calendars.peek().map((c) => c.id));
    const added = stored.filter((s, i) => !present.has(s.id) && stored.findIndex((o) => o.id === s.id) === i);
    if (!newIds.includes(oldId)) await deleteCalendar(oldId).catch(() => undefined);
    const kept = calendars.peek().filter((c) => c.id !== oldId || newIds.includes(oldId));
    calendars.value = [...kept, ...added.map((a) => ({ id: a.id, text: a.text }))];
    calendarNames.value = { ...calendarNames.peek(), ...Object.fromEntries(added.map((a) => [a.id, a.label])) };
    // config.calendars: the new files take the old one's name slot.
    const cfg = config.peek();
    const keep = (cfg.calendars ?? []).filter((c) => c.id !== oldId);
    const next = [...keep, ...stored.filter((s, i) => stored.findIndex((o) => o.id === s.id) === i).map((s) => ({ id: s.id, name: s.label }))];
    const uniq = next.filter((c, i) => next.findIndex((o) => o.id === c.id) === i);
    setConfig({ ...cfg, calendars: uniq });
    return finish('replaced');
  } finally {
    importing.value = false;
  }
}

/** Remove one calendar (the settings page keeps at least one). */
export async function removeCalendarFromSettings(id: string): Promise<void> {
  await removeCalendar(id);
  syncCalendarSources();
}

export interface SettingsCalendar {
  id: string;
  name: string;
  /** Events found in the file (before any course filtering). */
  eventCount: number;
  failed: boolean;
  /** Set when the calendar is fed by a subscription link. */
  subscription: SubscriptionInfo | null;
}

/** The calendars listed on the settings page: name from `config.calendars` (the file name the user imported). */
export const settingsCalendars = computed<SettingsCalendar[]>(() => {
  const names = new Map((config.value.calendars ?? []).map((c) => [c.id, c.name]));
  const feeds = new Map(subscriptions.value.map((s) => [s.calendarId, s]));
  return calendars.value.map((file) => {
    const parsed = parseCalendarFile(file);
    const feed = feeds.get(file.id) ?? null;
    return {
      id: file.id,
      name: feed ? t('settings.subscriptionName') : (names.get(file.id) ?? calendarNames.value[file.id] ?? file.id),
      eventCount: parsed.sessions.length,
      failed: parsed.failed,
      subscription: feed,
    };
  });
});

/** Read the chosen files (File API) into the shape `importFiles` / `replaceCalendar` take. */
export async function readImportItems(files: FileList | File[] | null): Promise<ImportItem[]> {
  if (!files || files.length === 0) return [];
  return Promise.all(Array.from(files).map(async (file) => ({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) })));
}
