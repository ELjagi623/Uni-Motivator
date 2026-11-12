// Class reminders: "class starts in N minutes" and "class is over" while the page is open.
//
// Which reminders are due is decided by core (`dueReminders`); this file shows them. With browser permission they are
// native notifications (`new Notification(...)`, looked up on `window` at the moment of use); without it (denied, not
// asked yet, unsupported) they appear inside the page, so they are never lost.

import { effect, computed, signal } from '@preact/signals';
import { findPoolOfSession, getPoolSession } from '../core/billing';
import { dueReminders, endFigures, reminderKey, type Reminder } from '../core/notify';
import { formatMinor } from '../core/money';
import { t } from '../i18n';
import { DEFAULT_REMINDERS, type ReminderConfig } from './config';
import { marksOf } from './dashboard';
import { config, setConfig } from './data';
import { demoActive } from './demoState';
import { billableSessions, courses, currency, pools } from './derived';
import { secondBucket, activeNow } from './now';
import { slackRecords } from './slackRecords';
import { activeMarks } from './source';

export type NotifyPermission = 'granted' | 'denied' | 'default' | 'unsupported';

interface NotificationLike {
  permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission> | void;
  new (title: string, options?: NotificationOptions): unknown;
}

function api(): NotificationLike | null {
  const N = (globalThis as { Notification?: NotificationLike }).Notification;
  return N ?? null;
}

export function readPermission(): NotifyPermission {
  return api()?.permission ?? 'unsupported';
}

export const permission = signal<NotifyPermission>(readPermission());

export const reminderConfig = computed<ReminderConfig>(() => ({ ...DEFAULT_REMINDERS, ...(config.value.reminders ?? {}) }));

/** Change the reminder settings (takes effect at the next second; saved like any other setting). */
export function setReminderConfig(patch: Partial<ReminderConfig>): void {
  setConfig({ ...config.peek(), reminders: { ...reminderConfig.peek(), ...patch } });
}

/** Ask the browser for permission (must be called from a click). Returns the resulting state. */
export async function requestNotifyPermission(): Promise<NotifyPermission> {
  const N = api();
  if (!N) {
    permission.value = 'unsupported';
    return 'unsupported';
  }
  try {
    await N.requestPermission();
  } catch {
    /* some browsers throw when asked outside a click */
  }
  permission.value = readPermission();
  return permission.value;
}

/** Turn reminders on (asking for permission the first time) or off. */
export async function setRemindersEnabled(enabled: boolean): Promise<void> {
  setReminderConfig({ enabled });
  permission.value = readPermission();
  if (enabled && permission.value === 'default') await requestNotifyPermission();
}

// ------------------------------------------------------------------ in-page reminders

export interface Toast {
  id: string;
  text: string;
  /** Extra line, e.g. why this was not a browser notification. */
  note: string | null;
}

export const toasts = signal<Toast[]>([]);

export function dismissToast(id: string): void {
  toasts.value = toasts.value.filter((x) => x.id !== id);
}

// ------------------------------------------------------------------ what is shown

const FIRED_STORAGE_KEY = 'tt-reminders-fired';
const fired = new Set<string>(loadFired());

function loadFired(): string[] {
  try {
    const raw = globalThis.sessionStorage?.getItem(FIRED_STORAGE_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveFired(): void {
  try {
    globalThis.sessionStorage?.setItem(FIRED_STORAGE_KEY, JSON.stringify([...fired].slice(-200)));
  } catch {
    /* private mode: the reminders just may repeat after a reload */
  }
}

/** Test helper: forget which reminders were shown. */
export function resetReminderState(): void {
  fired.clear();
  saveFired();
  toasts.value = [];
  permission.value = readPermission();
}

function textOf(reminder: Reminder, nowMs: number): string | null {
  const session = billableSessions.peek().find((s) => s.id === reminder.sessionId);
  if (!session) return null;
  const course = courses.peek().find((c) => c.id === session.courseId);
  const label = course?.code ?? course?.name ?? session.title;
  const pool = findPoolOfSession(pools.peek(), session.id);
  const ps = pool ? getPoolSession(pool, session.id) : null;
  const cur = currency.peek();
  const costMinor = ps?.costMinor ?? 0;
  if (reminder.kind === 'before') {
    return t('notify.before', { course: label, minutes: Math.max(1, Math.ceil((session.startMs - nowMs) / 60_000)), amount: formatMinor(costMinor, cur) });
  }
  const f = endFigures(session, costMinor, ps?.ratePerSec ?? 0, slackRecords.peek(), nowMs);
  return f.slackSeconds > 0
    ? t('notify.endSlack', { course: label, amount: formatMinor(f.costMinor, cur), minutes: f.slackMinutes, wasted: formatMinor(f.slackMinor, cur) })
    : t('notify.endNoSlack', { course: label, amount: formatMinor(f.costMinor, cur) });
}

function deliver(key: string, text: string): void {
  const N = api();
  permission.value = readPermission();
  if (N && N.permission === 'granted') {
    try {
      new N(t('notify.title'), { body: text, tag: key });
      return;
    } catch {
      /* fall through to the in-page message */
    }
  }
  const note = permission.value === 'denied' ? t('notify.deniedNote') : null;
  toasts.value = [...toasts.value, { id: key, text, note }].slice(-3);
}

/** Show whatever is due at `nowMs` (each reminder at most once). Returns the keys shown. */
export function runReminders(nowMs: number): string[] {
  const cfg = reminderConfig.peek();
  if (!cfg.enabled || demoActive.peek()) return [];
  const due = dueReminders(nowMs, billableSessions.peek(), marksOf(activeMarks.peek()), { leadMinutes: cfg.leadMinutes }, fired);
  const shown: string[] = [];
  for (const r of due) {
    fired.add(r.key);
    const text = textOf(r, nowMs);
    if (text) {
      deliver(r.key, text);
      shown.push(r.key);
    }
  }
  if (due.length > 0) saveFired();
  return shown;
}

/** Check once a second. Returns a stop function. */
export function startReminders(): () => void {
  return effect(() => {
    void secondBucket.value;
    runReminders(activeNow.peek());
  });
}

export { reminderKey };
