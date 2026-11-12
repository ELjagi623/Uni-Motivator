// Backup: export the whole data as one JSON file, and import such a file again. The server does the real work
// (GET /api/export, POST /api/import: validation, a safety copy of the current data, then replacement); this file only
// moves the text between the user's disk and the server and keeps the messages.
//
// Subscription links are private and are not part of the file. Importing replaces everything, so the user confirms first.

import { signal } from '@preact/signals';
import { fetchBackup, ImportApiError, postImport } from '../api/client';
import { t } from '../i18n';
import { flushSaves, loadAll } from './data';

export const BACKUP_SCHEMA_VERSION = 1;

export type BackupMessage = { kind: 'exported' | 'imported' | 'error'; text: string };

export const backupMessage = signal<BackupMessage | null>(null);
export const importPending = signal<{ text: string; fileName: string; calendars: number } | null>(null);
export const backupBusy = signal(false);

/** Quick check of a chosen file before the server sees it: is it JSON, written by this program, with a known schemaVersion? */
export function inspectBackupText(text: string): { ok: true; calendars: number } | { ok: false; reason: 'format' | 'version'; version?: number } {
  let doc: unknown;
  try {
    doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { ok: false, reason: 'format' };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, reason: 'format' };
  const d = doc as { app?: unknown; kind?: unknown; schemaVersion?: unknown; calendars?: unknown };
  if (d.app !== 'tuition-ticker' || d.kind !== 'backup' || typeof d.schemaVersion !== 'number') return { ok: false, reason: 'format' };
  if (d.schemaVersion !== BACKUP_SCHEMA_VERSION) return { ok: false, reason: 'version', version: d.schemaVersion };
  return { ok: true, calendars: Array.isArray(d.calendars) ? d.calendars.length : 0 };
}

function saveAsFile(text: string, fileName: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function exportBackup(): Promise<void> {
  backupBusy.value = true;
  try {
    const { text, fileName } = await fetchBackup();
    saveAsFile(text, fileName);
    backupMessage.value = { kind: 'exported', text: t('backup.exported', { name: fileName }) };
  } catch (err) {
    backupMessage.value = { kind: 'error', text: t('backup.err.export', { message: err instanceof Error ? err.message : String(err) }) };
  } finally {
    backupBusy.value = false;
  }
}

/** The user chose a file: check it and ask for confirmation (nothing is sent yet). */
export async function chooseBackupFile(file: { name: string; text(): Promise<string> }): Promise<void> {
  backupMessage.value = null;
  let text: string;
  try {
    text = await file.text();
  } catch {
    backupMessage.value = { kind: 'error', text: t('backup.err.read') };
    return;
  }
  const checked = inspectBackupText(text);
  if (!checked.ok) {
    backupMessage.value = { kind: 'error', text: checked.reason === 'version' ? t('backup.err.version', { version: checked.version ?? '?' }) : t('backup.err.format') };
    return;
  }
  importPending.value = { text, fileName: file.name, calendars: checked.calendars };
}

export function cancelImport(): void {
  importPending.value = null;
}

/** The user confirmed: the server saves the current data, replaces it, and the page reloads everything from it. */
export async function confirmImport(): Promise<boolean> {
  const pending = importPending.peek();
  if (!pending) return false;
  importPending.value = null;
  backupBusy.value = true;
  try {
    await postImport(pending.text);
    await loadAll();
    backupMessage.value = { kind: 'imported', text: t('backup.importOk') };
    return true;
  } catch (err) {
    let message: string;
    if (err instanceof ImportApiError && err.code === 'unsupported_version') message = t('backup.err.version', { version: '?' });
    else if (err instanceof ImportApiError && err.code === 'bad_backup') message = t('backup.err.format');
    else message = t('backup.err.network', { message: err instanceof Error ? err.message : String(err) });
    backupMessage.value = { kind: 'error', text: message };
    return false;
  } finally {
    backupBusy.value = false;
  }
}

// ------------------------------------------------------------------ reset everything

export const resetPending = signal(false);
export const resetBusy = signal(false);
export const resetError = signal<string | null>(null);

/** A backup with nothing in it: importing it empties the data folder (after the server's safety copy) = first start. */
export function emptyBackupText(now: number = Date.now()): string {
  return JSON.stringify({
    app: 'tuition-ticker',
    kind: 'backup',
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date(now).toISOString(),
    config: { schemaVersion: 1 },
    marks: { schemaVersion: 1 },
    slacks: { schemaVersion: 1 },
    calendars: [],
  });
}

export function askReset(): void {
  resetError.value = null;
  resetPending.value = true;
}

export function cancelReset(): void {
  resetPending.value = false;
}

function reloadPage(): void {
  window.location.hash = '#/';
  window.location.reload();
}

/**
 * The user confirmed: pending edits are sent first (so nothing can write the old data back afterwards), the server
 * saves a safety copy and empties settings, timetable, marks and slacking records, the browser's own stored values
 * (language, interface size, reminder bookkeeping) are cleared, and the page starts again from the first-run screen.
 */
export async function confirmReset(reload: () => void = reloadPage): Promise<boolean> {
  if (resetBusy.peek()) return false;
  resetBusy.value = true;
  resetError.value = null;
  try {
    await flushSaves();
    await postImport(emptyBackupText());
    for (const area of ['localStorage', 'sessionStorage'] as const) {
      try {
        globalThis[area]?.clear();
      } catch {
        /* blocked storage: nothing to clear */
      }
    }
    resetPending.value = false;
    reload();
    return true;
  } catch (err) {
    resetPending.value = false;
    resetError.value = t('reset.err', { message: err instanceof Error ? err.message : String(err) });
    return false;
  } finally {
    resetBusy.value = false;
  }
}

export function resetBackupState(): void {
  resetPending.value = false;
  resetBusy.value = false;
  resetError.value = null;
  backupMessage.value = null;
  importPending.value = null;
  backupBusy.value = false;
}
