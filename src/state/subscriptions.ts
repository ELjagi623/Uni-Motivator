// iCal subscription links, seen from the page: add one, sync now, show how the last sync went. The server does the
// downloading (and keeps the link to itself); this file calls it, refreshes the calendars and reports what the sync
// changed - in particular "unit price changed from X to Y".

import { signal } from '@preact/signals';
import { SyncApiError, addSubscription as apiAddSubscription, syncSubscription as apiSyncSubscription, type SubscriptionInfo } from '../api/client';
import { isCurrencyCode } from '../core/money';
import { t, type MessageKey } from '../i18n';
import { calendarNames, syncCalendarSources } from './calendars';
import { DEFAULT_CURRENCY } from './config';
import { config, refreshCalendars } from './data';
import { pools as savedPools } from './derived';
import { rateChanges, type RateChange } from './settings';

export interface SyncReport {
  /** The calendar the report is about ('' while a new link was being added and failed). */
  calendarId: string;
  status: 'ok' | 'error';
  /** Whether the calendar's content changed. */
  changed: boolean;
  /** Machine-readable reason when status is 'error'. */
  errorCode: string | null;
  /** Unit prices that moved because of the sync (empty when none did). */
  rateChanges: RateChange[];
}

/** The calendar id (or 'new' while a link is being added) whose download is running. */
export const syncing = signal<string | null>(null);
export const syncReport = signal<SyncReport | null>(null);

const ERROR_KEYS: Record<string, MessageKey> = {
  bad_url: 'sync.error.bad_url',
  timeout: 'sync.error.timeout',
  network: 'sync.error.network',
  http_error: 'sync.error.http_error',
  too_large: 'sync.error.too_large',
  not_icalendar: 'sync.error.not_icalendar',
  not_found: 'sync.error.not_found',
  already_subscribed: 'sync.error.already_subscribed',
  unreachable: 'sync.error.unreachable',
};

export function syncErrorText(code: string): string {
  return t(ERROR_KEYS[code] ?? 'sync.error.network');
}

/** "刚刚" / "5 分钟前" / "3 小时前" / "2 天前". A last-sync time in the future (fake `now` in tests) counts as just now. */
export function lastSyncText(info: Pick<SubscriptionInfo, 'lastSyncMs'>, nowMs: number): string {
  if (info.lastSyncMs === null) return t('sync.never');
  const minutes = Math.floor(Math.max(0, nowMs - info.lastSyncMs) / 60_000);
  if (minutes < 1) return t('sync.justNow');
  if (minutes < 60) return t('sync.minutesAgo', { n: minutes });
  if (minutes < 60 * 24) return t('sync.hoursAgo', { n: Math.floor(minutes / 60) });
  return t('sync.daysAgo', { n: Math.floor(minutes / (60 * 24)) });
}

/** "单价从 X 变为 Y / 秒" (already happened, unlike the "will change" preview of the settings dialog). */
export function syncRateText(change: RateChange): string {
  const text =
    change.fromText === null
      ? t('sync.rateFromUnset', { to: change.toText ?? '' })
      : change.toText === null
        ? t('sync.rateToUnset', { from: change.fromText })
        : t('sync.rate', { from: change.fromText, to: change.toText });
  return t('sync.ratePool', { pool: change.poolLabel, text });
}

async function run(busyKey: string, call: () => Promise<{ calendarId: string; changed: boolean }>): Promise<SyncReport> {
  syncing.value = busyKey;
  const oldPools = savedPools.peek();
  const currency = isCurrencyCode(config.peek().currency) ? config.peek().currency! : DEFAULT_CURRENCY;
  let report: SyncReport;
  try {
    const result = await call();
    await refreshCalendars();
    const names = { ...calendarNames.peek() };
    if (!names[result.calendarId]) names[result.calendarId] = t('settings.subscriptionName');
    calendarNames.value = names;
    syncCalendarSources();
    report = { calendarId: result.calendarId, status: 'ok', changed: result.changed, errorCode: null, rateChanges: rateChanges(oldPools, currency, savedPools.peek(), currency) };
  } catch (err) {
    // A failed download changes nothing (the server keeps the old calendar); only the subscription's error state moved.
    await refreshCalendars().catch(() => undefined);
    const code = err instanceof SyncApiError ? err.code : 'unreachable';
    report = { calendarId: busyKey === 'new' ? '' : busyKey, status: 'error', changed: false, errorCode: code, rateChanges: [] };
  } finally {
    syncing.value = null;
  }
  syncReport.value = report;
  return report;
}

/** Subscribe to a link. The server downloads it first; when that fails nothing is stored. */
export function subscribe(url: string): Promise<SyncReport> {
  return run('new', () => apiAddSubscription(url.trim()));
}

/** "立即同步": download the subscribed calendar again. */
export function syncNow(calendarId: string): Promise<SyncReport> {
  return run(calendarId, () => apiSyncSubscription(calendarId));
}

export function clearSyncReport(): void {
  syncReport.value = null;
}
