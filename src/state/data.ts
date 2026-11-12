// Global document state (config / marks / slacks / calendar texts) and its synchronisation with the local server.
//
//  - `loadAll()` fetches everything once (GET /api/data) and fills the signals.
//  - Every change to a document goes through `setDoc`; saves are debounced (500 ms) so a burst of edits becomes a
//    single PUT. `rev` numbers are kept here, outside the documents.
//  - A 409 (another tab saved first) re-fetches everything and shows a notice; local unsaved edits are dropped.

import { signal } from '@preact/signals';
import { ApiError, getData, putDoc, type CalendarFile, type DataBundle, type DocName, type RawDoc } from '../api/client';
import { t } from '../i18n';
import { emptyConfig, type AppConfig } from './config';

export interface DocValue {
  schemaVersion: number;
  [key: string]: unknown;
}

export const SAVE_DELAY_MS = 500;
const RETRY_DELAY_MS = 5000;

export const config = signal<AppConfig>(emptyConfig());
export const marks = signal<DocValue>({ schemaVersion: 1 });
export const slacks = signal<DocValue>({ schemaVersion: 1 });
export const calendars = signal<CalendarFile[]>([]);

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';
export const loadStatus = signal<LoadStatus>('idle');
export const loadError = signal<string | null>(null);
/** A one-line message for the user (e.g. "data was changed in another tab"). */
export const notice = signal<string | null>(null);

const docSignals = { config, marks, slacks } as const;
const revs: Record<DocName, number> = { config: 0, marks: 0, slacks: 0 };
const timers = new Map<DocName, ReturnType<typeof setTimeout>>();
const dirty = new Set<DocName>();
const inFlight = new Set<DocName>();
const waiters: Array<() => void> = [];

function stripRev(doc: RawDoc): DocValue {
  const { rev: _rev, ...rest } = doc;
  void _rev;
  return rest as DocValue;
}

function applyBundle(bundle: DataBundle): void {
  for (const name of ['config', 'marks', 'slacks'] as const) {
    revs[name] = bundle[name].rev;
    (docSignals[name] as { value: unknown }).value = stripRev(bundle[name]);
  }
  calendars.value = bundle.calendars;
}

function clearPending(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  dirty.clear();
}

function settle(): void {
  if (timers.size === 0 && inFlight.size === 0 && dirty.size === 0) {
    for (const w of waiters.splice(0)) w();
  }
}

/** Fetch every document and calendar from the server. Pending unsaved edits are discarded. */
export async function loadAll(): Promise<void> {
  loadStatus.value = 'loading';
  loadError.value = null;
  try {
    const bundle = await getData();
    clearPending();
    applyBundle(bundle);
    loadStatus.value = 'ready';
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
    loadStatus.value = 'error';
  }
  settle();
}

function schedule(name: DocName, delay: number): void {
  const existing = timers.get(name);
  if (existing !== undefined) clearTimeout(existing);
  timers.set(
    name,
    setTimeout(() => {
      timers.delete(name);
      void send(name);
    }, delay),
  );
}

async function send(name: DocName): Promise<void> {
  if (inFlight.has(name)) {
    // A request for this document is still running; send again right after it finishes.
    schedule(name, SAVE_DELAY_MS);
    return;
  }
  inFlight.add(name);
  dirty.delete(name);
  let conflict = false;
  try {
    const result = await putDoc(name, revs[name], docSignals[name].value as Record<string, unknown>);
    if (result.ok) revs[name] = result.rev;
    else conflict = true;
  } catch (err) {
    notice.value = t('sync.saveFailed', { message: err instanceof ApiError ? err.message : String(err) });
    dirty.add(name);
    schedule(name, RETRY_DELAY_MS);
    // Do not keep anyone waiting for flushSaves() while the server is unreachable.
    for (const w of waiters.splice(0)) w();
  } finally {
    inFlight.delete(name);
  }
  if (conflict) {
    await loadAll();
    notice.value = t('sync.conflict');
    return;
  }
  if (dirty.has(name) && !timers.has(name)) schedule(name, SAVE_DELAY_MS);
  settle();
}

/** Replace a document in memory and queue a debounced save. */
export function setDoc(name: 'config', value: AppConfig): void;
export function setDoc(name: 'marks' | 'slacks', value: DocValue): void;
export function setDoc(name: DocName, value: AppConfig | DocValue): void {
  (docSignals[name] as { value: unknown }).value = value;
  dirty.add(name);
  schedule(name, SAVE_DELAY_MS);
}

export function setConfig(next: AppConfig): void {
  setDoc('config', next);
}

/** Resolves when every queued save has been sent (used before leaving a flow that must be on disk). */
export function flushSaves(): Promise<void> {
  for (const name of [...timers.keys()]) {
    clearTimeout(timers.get(name));
    timers.delete(name);
    void send(name);
  }
  if (timers.size === 0 && inFlight.size === 0 && dirty.size === 0) return Promise.resolve();
  return new Promise((resolve) => waiters.push(resolve));
}

export function dismissNotice(): void {
  notice.value = null;
}

/** Test helper: back to the initial empty state. */
export function resetDataState(): void {
  clearPending();
  inFlight.clear();
  for (const w of waiters.splice(0)) w();
  config.value = emptyConfig();
  marks.value = { schemaVersion: 1 };
  slacks.value = { schemaVersion: 1 };
  calendars.value = [];
  revs.config = 0;
  revs.marks = 0;
  revs.slacks = 0;
  loadStatus.value = 'idle';
  loadError.value = null;
  notice.value = null;
}
