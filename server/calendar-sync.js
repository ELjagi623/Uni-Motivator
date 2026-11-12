// iCal subscription links: download a calendar from an http(s) URL, store it as data/calendars/<id>.ics and keep it
// up to date (once at start-up, then every 6 hours; or on demand through POST /api/calendars/:id/sync).
//
// Privacy: a subscription link is a secret (anyone who has it can read the calendar). It lives only in
// data/subscriptions.json on this computer; it is never returned by the API, never logged and never part of an error
// message (errors are fixed strings plus a machine-readable `code`).
//
// Plain Node built-ins only (global `fetch`, AbortController, timers).

import { randomBytes } from 'node:crypto';

export const SYNC_TIMEOUT_MS = 15_000;
export const SYNC_MAX_BYTES = 5 * 1024 * 1024;
export const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

const MESSAGES = {
  bad_url: 'the subscription link is not a valid http or https address',
  timeout: 'the calendar server did not answer in time',
  network: 'the calendar server could not be reached',
  http_error: 'the calendar server refused the request',
  too_large: 'the calendar is larger than 5 MB',
  not_icalendar: 'the answer is not an iCalendar file (it does not start with BEGIN:VCALENDAR)',
  not_found: 'there is no subscription for this calendar',
  already_subscribed: 'this link is already subscribed',
};

const STATUS = { bad_url: 400, not_found: 404 };

export class SyncError extends Error {
  /** @param {keyof typeof MESSAGES} code  @param {string} [detail] extra text that never contains the link */
  constructor(code, detail) {
    super(detail ? `${MESSAGES[code]} (${detail})` : MESSAGES[code]);
    this.name = 'SyncError';
    this.code = code;
    this.status = STATUS[code] ?? 502;
  }
}

/** Validate a subscription link. `webcal://` is the same thing as `https://` and is accepted as such. */
export function parseSubscriptionUrl(input) {
  if (typeof input !== 'string' || input.trim() === '' || input.length > 4096) throw new SyncError('bad_url');
  let text = input.trim();
  if (/^webcals?:\/\//i.test(text)) text = text.replace(/^webcals?:/i, 'https:');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new SyncError('bad_url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SyncError('bad_url');
  if (!url.hostname) throw new SyncError('bad_url');
  return url;
}

/**
 * Download one calendar. Resolves to the text; rejects with a SyncError (no message ever contains the link).
 * @param {string | URL} link
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, maxBytes?: number}} [options]
 */
export async function fetchCalendarText(link, { fetchImpl = globalThis.fetch, timeoutMs = SYNC_TIMEOUT_MS, maxBytes = SYNC_MAX_BYTES } = {}) {
  const url = link instanceof URL ? link : parseSubscriptionUrl(link);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    let res;
    try {
      res = await fetchImpl(url, { signal: controller.signal, redirect: 'follow', headers: { Accept: 'text/calendar, text/plain, */*' } });
    } catch {
      throw new SyncError(timedOut ? 'timeout' : 'network');
    }
    if (!res.ok) {
      await res.body?.cancel?.().catch(() => undefined);
      throw new SyncError('http_error', `HTTP ${res.status}`);
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel?.().catch(() => undefined);
      throw new SyncError('too_large');
    }
    const chunks = [];
    let total = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new SyncError('too_large');
        }
        chunks.push(value);
      }
    } catch (err) {
      if (err instanceof SyncError) throw err;
      throw new SyncError(timedOut ? 'timeout' : 'network');
    }
    const text = Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '');
    if (!/^\s*BEGIN:VCALENDAR/i.test(text)) throw new SyncError('not_icalendar');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} options
 * @param {ReturnType<import('./store.js').createStore>} options.store
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 * @param {number} [options.intervalMs]
 * @param {typeof setInterval} [options.setIntervalFn]   injectable so tests can fire the periodic sync by hand
 * @param {typeof clearInterval} [options.clearIntervalFn]
 * @param {(line: string) => void} [options.log]
 */
export function createCalendarSync({
  store,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = SYNC_TIMEOUT_MS,
  maxBytes = SYNC_MAX_BYTES,
  intervalMs = SYNC_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  log = (line) => console.error(line),
}) {
  const running = new Map(); // calendar id -> promise of the sync in progress

  const download = (url) => fetchCalendarText(url, { fetchImpl, timeoutMs, maxBytes });

  /** Subscribe to a link: it is downloaded first, and nothing is stored when that fails. */
  async function addSubscription(link) {
    const url = parseSubscriptionUrl(link);
    const subs = store.readSubscriptions();
    if (subs.some((s) => s.url === url.href)) throw new SyncError('already_subscribed');
    const text = await download(url);
    const id = `sub-${randomBytes(5).toString('hex')}`;
    store.writeCalendar(id, text);
    const lastSyncMs = now();
    store.writeSubscriptions([...store.readSubscriptions(), { id, url: url.href, addedMs: lastSyncMs, lastSyncMs, lastError: null }]);
    return { calendarId: id, lastSyncMs, changed: true };
  }

  async function runSync(id) {
    const sub = store.readSubscriptions().find((s) => s.id === id);
    if (!sub) throw new SyncError('not_found');
    const patch = (fields) => store.writeSubscriptions(store.readSubscriptions().map((s) => (s.id === id ? { ...s, ...fields } : s)));
    let text;
    try {
      text = await download(sub.url);
    } catch (err) {
      const code = err instanceof SyncError ? err.code : 'network';
      log(`[sync] ${id}: failed (${code}); the stored calendar was not changed`);
      patch({ lastError: code });
      throw err instanceof SyncError ? err : new SyncError('network');
    }
    const before = store.readCalendars().find((c) => c.id === id)?.text;
    const changed = before !== text;
    if (changed) store.writeCalendar(id, text);
    const lastSyncMs = now();
    patch({ lastSyncMs, lastError: null });
    return { calendarId: id, lastSyncMs, changed };
  }

  /** Re-download one subscribed calendar. On failure the stored calendar is left exactly as it was. */
  function syncCalendar(id) {
    const busy = running.get(id);
    if (busy) return busy;
    const p = runSync(id).finally(() => running.delete(id));
    running.set(id, p);
    return p;
  }

  /** Sync every subscription; never rejects (failures are recorded per subscription). */
  async function syncAll() {
    const results = [];
    for (const sub of store.readSubscriptions()) {
      try {
        results.push(await syncCalendar(sub.id));
      } catch (err) {
        results.push({ calendarId: sub.id, error: err instanceof SyncError ? err.code : 'network' });
      }
    }
    return results;
  }

  let timer = null;
  /** One sync now, then one every `intervalMs`. The timer does not keep the process alive. */
  function start() {
    if (timer) return stop;
    void syncAll();
    timer = setIntervalFn(() => void syncAll(), intervalMs);
    timer?.unref?.();
    return stop;
  }
  function stop() {
    if (timer) clearIntervalFn(timer);
    timer = null;
  }

  return { addSubscription, syncCalendar, syncAll, start, stop };
}
