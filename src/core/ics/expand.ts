import ICAL from 'ical.js';
import type { Session } from '../types';
import { parseIcs, type EventGroup, type ParsedCalendar } from './parse';

export interface ExpandOptions {
  /** Do not generate occurrences whose original start is later than this (UTC ms). Default: 760 days after each series starts. */
  horizonMs?: number;
  /** Safety valve per series. Default 3000. */
  maxPerSeries?: number;
}

const DAY_MS = 86_400_000;
const DEFAULT_HORIZON_DAYS = 760;
const DEFAULT_MAX_PER_SERIES = 3000;

/** Windows / Outlook zone names that sometimes appear as TZID without a VTIMEZONE. */
const WINDOWS_ZONES: Record<string, string> = {
  'china standard time': 'Asia/Shanghai',
  'taipei standard time': 'Asia/Taipei',
  'tokyo standard time': 'Asia/Tokyo',
  'singapore standard time': 'Asia/Singapore',
  'gmt standard time': 'Europe/London',
  'w. europe standard time': 'Europe/Berlin',
  'romance standard time': 'Europe/Paris',
  'eastern standard time': 'America/New_York',
  'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver',
  'pacific standard time': 'America/Los_Angeles',
  'aus eastern standard time': 'Australia/Sydney',
  'utc': 'UTC',
};

const formatterCache = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(tz: string): Intl.DateTimeFormat | null {
  if (formatterCache.has(tz)) return formatterCache.get(tz) ?? null;
  let fmt: Intl.DateTimeFormat | null = null;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  } catch {
    fmt = null;
  }
  formatterCache.set(tz, fmt);
  return fmt;
}

function resolveIana(tzid: string | undefined): string | null {
  if (!tzid) return null;
  const cleaned = tzid.trim().replace(/^"|"$/g, '');
  const mapped = WINDOWS_ZONES[cleaned.toLowerCase()] ?? cleaned;
  return formatterFor(mapped) ? mapped : null;
}

/** Offset (zone minus UTC) in ms of `tz` at the UTC instant `utcMs`. */
function zoneOffsetMs(utcMs: number, fmt: Intl.DateTimeFormat): number {
  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Wall-clock fields in an IANA zone -> UTC ms (handles DST; nonexistent times shift forward). */
function wallClockToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const fmt = formatterFor(tz);
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  if (!fmt) return guess;
  const first = guess - zoneOffsetMs(guess, fmt);
  const second = guess - zoneOffsetMs(first, fmt);
  return second;
}

/**
 * Convert an ical.js time to UTC ms.
 * - Times bound to UTC or a registered VTIMEZONE use ical.js' own conversion.
 * - Floating times (ical.js also reports TZIDs it does not know as floating) use `tzid` as an IANA zone when
 *   possible, otherwise the computer's local zone.
 */
export function timeToMs(t: ICAL.Time, tzid?: string): number {
  if (t.zone && t.zone.tzid !== 'floating') return t.toUnixTime() * 1000;
  const iana = resolveIana(tzid);
  if (iana) return wallClockToUtc(t.year, t.month, t.day, t.hour, t.minute, t.second, iana);
  return new Date(t.year, t.month - 1, t.day, t.hour, t.minute, t.second).getTime();
}

/** Second-precision UTC ISO string used inside session ids. */
export function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function makeSessionId(uid: string, originalStartMs: number): string {
  return `${uid}|${isoSeconds(originalStartMs)}`;
}

function tzidOf(event: ICAL.Event, prop: 'dtstart' | 'dtend'): string | undefined {
  const p = event.component.getFirstProperty(prop);
  const v = p ? p.getParameter('tzid') : undefined;
  return typeof v === 'string' ? v : undefined;
}

function isCancelled(event: ICAL.Event): boolean {
  const status = event.component.getFirstPropertyValue('status');
  return typeof status === 'string' && status.toUpperCase() === 'CANCELLED';
}

function isAllDay(event: ICAL.Event): boolean {
  const start = event.component.getFirstPropertyValue('dtstart');
  return !!start && (start as ICAL.Time).isDate === true;
}

function sessionFrom(
  uid: string,
  item: ICAL.Event,
  originalMs: number,
  start: ICAL.Time,
  end: ICAL.Time,
  fallbackTzid: string | undefined,
): Session | null {
  const startTzid = tzidOf(item, 'dtstart') ?? fallbackTzid;
  const startMs = timeToMs(start, startTzid);
  const endMs = timeToMs(end, tzidOf(item, 'dtend') ?? startTzid);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return {
    id: makeSessionId(uid, originalMs),
    uid,
    title: (item.summary ?? '').trim(),
    location: (item.location ?? '').trim(),
    startMs,
    endMs,
  };
}

function expandGroup(group: EventGroup, opts: ExpandOptions, out: Session[]): void {
  const maxPerSeries = opts.maxPerSeries ?? DEFAULT_MAX_PER_SERIES;
  const standalone = (event: ICAL.Event) => {
    if (isCancelled(event) || isAllDay(event)) return;
    const s = sessionFrom(group.uid, event, 0, event.startDate, event.endDate, undefined);
    if (!s) return;
    // The original start of a stand-alone event is its own start (or its RECURRENCE-ID for orphan exceptions).
    const idTime = event.component.hasProperty('recurrence-id') ? event.recurrenceId : event.startDate;
    const idTzid = event.component.hasProperty('recurrence-id')
      ? ((event.component.getFirstProperty('recurrence-id')?.getParameter('tzid') as string | undefined) ?? tzidOf(event, 'dtstart'))
      : tzidOf(event, 'dtstart');
    s.id = makeSessionId(group.uid, timeToMs(idTime, idTzid));
    out.push(s);
  };

  for (const orphan of group.orphans) standalone(orphan);
  const master = group.master;
  if (!master) return;
  if (isCancelled(master) || isAllDay(master)) return;

  if (!master.isRecurring()) {
    standalone(master);
    return;
  }

  const masterTzid = tzidOf(master, 'dtstart');
  const seriesStart = timeToMs(master.startDate, masterTzid);
  const horizon = opts.horizonMs ?? seriesStart + DEFAULT_HORIZON_DAYS * DAY_MS;
  const it = master.iterator();
  let count = 0;
  for (let next = it.next(); next; next = it.next()) {
    if (++count > maxPerSeries) break;
    const originalMs = timeToMs(next, masterTzid);
    if (originalMs > horizon) break;
    const details = master.getOccurrenceDetails(next);
    const item = details.item;
    if (isCancelled(item) || isAllDay(item)) continue;
    const s = sessionFrom(group.uid, item, originalMs, details.startDate, details.endDate, masterTzid);
    if (s) out.push(s);
  }
}

/** Expand a parsed calendar into concrete sessions (all-day and cancelled events removed). */
export function expandCalendar(cal: ParsedCalendar, opts: ExpandOptions = {}): Session[] {
  // The ical.js timezone registry is global: refill it with this calendar's VTIMEZONEs right before use.
  ICAL.TimezoneService.reset();
  for (const vtz of cal.vtimezones) {
    try {
      ICAL.TimezoneService.register(vtz);
    } catch {
      // A broken VTIMEZONE is ignored; affected times fall back to IANA / local handling.
    }
  }
  const out: Session[] = [];
  for (const group of cal.groups) expandGroup(group, opts, out);

  const byId = new Map<string, Session>();
  for (const s of out) if (!byId.has(s.id)) byId.set(s.id, s);
  return [...byId.values()].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || (a.id < b.id ? -1 : 1));
}

/** Parse + expand in one call. */
export function expandIcs(text: string, opts: ExpandOptions = {}): Session[] {
  return expandCalendar(parseIcs(text), opts);
}

/** Merge sessions from several calendar files, de-duplicating by id (first one wins). */
export function mergeSessions(lists: Session[][]): Session[] {
  const byId = new Map<string, Session>();
  for (const list of lists) for (const s of list) if (!byId.has(s.id)) byId.set(s.id, s);
  return [...byId.values()].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || (a.id < b.id ? -1 : 1));
}
