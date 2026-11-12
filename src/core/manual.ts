// Manual classes: a course the user types in by hand (course name + weekday + time + date range + skipped dates) and
// one-off make-up / extra classes. They expand into the same `Session` shape the calendar produces, so billing,
// marks, statistics and the status machine treat them like any other class.
//
// The definitions live in the `manual` part of the marks document; sessions are always derived from them (never stored).
// Session ids are `manual:<courseId>|<start UTC ISO, second precision>`, so marks and slacking records on a manual
// class are keyed like those on a calendar class.
//
// Dates are `YYYY-MM-DD`, times `HH:MM`, both wall-clock in `timeZone` (an IANA name) or, when absent, in the time
// zone of this computer.

import type { Session } from './types';

export interface ManualWeekly {
  id: string;
  courseId: string;
  /** The title the sessions carry (the course name). */
  title: string;
  /** 0 = Sunday ... 6 = Saturday. */
  weekday: number;
  start: string;
  end: string;
  fromDate: string;
  toDate: string;
  skipDates: string[];
  timeZone?: string;
}

export interface ManualSingle {
  id: string;
  courseId: string;
  title: string;
  date: string;
  start: string;
  end: string;
  timeZone?: string;
}

export interface ManualDoc {
  weekly: ManualWeekly[];
  singles: ManualSingle[];
}

export type ManualProblem = 'title' | 'weekday' | 'time' | 'order' | 'date' | 'range' | 'zone' | 'too-many';

/** The longest weekly arrangement accepted (a typo guard: 5 years of weeks would be 260). */
export const MAX_WEEKLY_SESSIONS = 400;

export const emptyManual = (): ManualDoc => ({ weekly: [], singles: [] });

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseDate(text: string): { y: number; m: number; d: number } | null {
  const m = DATE_RE.exec(text);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d ? { y, m: mo, d } : null;
}

export function parseTime(text: string): { h: number; min: number } | null {
  const m = TIME_RE.exec(text);
  return m ? { h: Number(m[1]), min: Number(m[2]) } : null;
}

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The zone's offset from UTC (ms, positive = east) at the instant `ms`. */
function zoneOffsetMs(ms: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(ms / 1000) * 1000;
}

/** UTC ms of the wall-clock moment `date` `time` in `zone` (this computer's zone when `zone` is absent). */
export function wallToUtc(date: { y: number; m: number; d: number }, time: { h: number; min: number }, zone?: string): number {
  if (!zone) return new Date(date.y, date.m - 1, date.d, time.h, time.min).getTime();
  const guess = Date.UTC(date.y, date.m - 1, date.d, time.h, time.min);
  const first = guess - zoneOffsetMs(guess, zone);
  // Across a daylight-saving change the offset at `first` can differ from the one at `guess`: settle once more.
  return guess - zoneOffsetMs(first, zone);
}

/** The wall-clock date (YYYY-MM-DD) of the instant `ms` in `zone` (this computer's zone when absent). */
export function wallDateOf(ms: number, zone?: string): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (!zone) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((x) => x.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function manualSessionId(courseId: string, startMs: number): string {
  return `manual:${courseId}|${new Date(startMs).toISOString().replace(/\.\d{3}Z$/, 'Z')}`;
}

function isoOfDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Calendar days from `from` to `to` inclusive, as UTC-midnight timestamps (pure date arithmetic, no zone involved). */
function daysBetween(from: { y: number; m: number; d: number }, to: { y: number; m: number; d: number }): number[] {
  const out: number[] = [];
  const end = Date.UTC(to.y, to.m - 1, to.d);
  for (let t = Date.UTC(from.y, from.m - 1, from.d); t <= end && out.length < 4000; t += 86_400_000) out.push(t);
  return out;
}

function timesProblems(start: string, end: string): ManualProblem[] {
  const a = parseTime(start);
  const b = parseTime(end);
  if (!a || !b) return ['time'];
  return b.h * 60 + b.min > a.h * 60 + a.min ? [] : ['order'];
}

export function validateWeekly(w: Omit<ManualWeekly, 'id'> & { id?: string }): ManualProblem[] {
  const out: ManualProblem[] = [];
  if (!w.title.trim()) out.push('title');
  if (!Number.isInteger(w.weekday) || w.weekday < 0 || w.weekday > 6) out.push('weekday');
  out.push(...timesProblems(w.start, w.end));
  const from = parseDate(w.fromDate);
  const to = parseDate(w.toDate);
  if (!from || !to || w.skipDates.some((d) => parseDate(d) === null)) out.push('date');
  else if (Date.UTC(to.y, to.m - 1, to.d) < Date.UTC(from.y, from.m - 1, from.d)) out.push('range');
  if (w.timeZone && !isValidTimeZone(w.timeZone)) out.push('zone');
  if (out.length === 0 && expandWeekly({ ...w, id: w.id ?? 'x' }).length > MAX_WEEKLY_SESSIONS) out.push('too-many');
  else if (out.length === 0 && expandWeekly({ ...w, id: w.id ?? 'x' }).length === 0) out.push('range');
  return out;
}

export function validateSingle(s: Omit<ManualSingle, 'id'> & { id?: string }): ManualProblem[] {
  const out: ManualProblem[] = [];
  if (!s.title.trim()) out.push('title');
  if (!parseDate(s.date)) out.push('date');
  out.push(...timesProblems(s.start, s.end));
  if (s.timeZone && !isValidTimeZone(s.timeZone)) out.push('zone');
  return out;
}

function makeSession(courseId: string, title: string, date: { y: number; m: number; d: number }, start: string, end: string, zone: string | undefined): Session | null {
  const a = parseTime(start);
  const b = parseTime(end);
  if (!a || !b) return null;
  const startMs = wallToUtc(date, a, zone);
  const endMs = wallToUtc(date, b, zone);
  if (!(endMs > startMs)) return null;
  return { id: manualSessionId(courseId, startMs), uid: `manual:${courseId}`, title, location: '', startMs, endMs, source: 'manual', courseId };
}

/** The classes of a weekly arrangement: every `weekday` from `fromDate` to `toDate` (inclusive) except the skipped dates. */
export function expandWeekly(w: ManualWeekly): Session[] {
  const from = parseDate(w.fromDate);
  const to = parseDate(w.toDate);
  if (!from || !to || validateShape(w)) return [];
  const skip = new Set(w.skipDates);
  const out: Session[] = [];
  for (const day of daysBetween(from, to)) {
    if (new Date(day).getUTCDay() !== w.weekday) continue;
    if (skip.has(isoOfDay(day))) continue;
    const date = parseDate(isoOfDay(day));
    const s = date ? makeSession(w.courseId, w.title, date, w.start, w.end, w.timeZone || undefined) : null;
    if (s) out.push(s);
  }
  return out;
}

function validateShape(w: ManualWeekly): boolean {
  return !Number.isInteger(w.weekday) || w.weekday < 0 || w.weekday > 6 || timesProblems(w.start, w.end).length > 0 || (!!w.timeZone && !isValidTimeZone(w.timeZone));
}

export function expandSingle(s: ManualSingle): Session | null {
  const date = parseDate(s.date);
  if (!date || (s.timeZone && !isValidTimeZone(s.timeZone))) return null;
  return makeSession(s.courseId, s.title, date, s.start, s.end, s.timeZone || undefined);
}

/** All manual sessions, sorted by start; a class that two definitions both produce (same course, same start) appears once. */
export function expandManual(doc: ManualDoc): Session[] {
  const byId = new Map<string, Session>();
  for (const w of doc.weekly) for (const s of expandWeekly(w)) byId.set(s.id, s);
  for (const single of doc.singles) {
    const s = expandSingle(single);
    if (s) byId.set(s.id, s);
  }
  return [...byId.values()].sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : 1));
}

// ------------------------------------------------------------------ reading the stored part leniently

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** The `manual` part of a marks document. Anything malformed is dropped, so a hand-edited file cannot break the app. */
export function manualFromDoc(raw: unknown): ManualDoc {
  const doc = emptyManual();
  if (!raw || typeof raw !== 'object') return doc;
  const r = raw as { weekly?: unknown; singles?: unknown };
  if (Array.isArray(r.weekly)) {
    for (const x of r.weekly as Array<Record<string, unknown>>) {
      if (!x || typeof x !== 'object' || !str(x.id) || !str(x.courseId)) continue;
      doc.weekly.push({
        id: str(x.id),
        courseId: str(x.courseId),
        title: str(x.title),
        weekday: typeof x.weekday === 'number' ? x.weekday : -1,
        start: str(x.start),
        end: str(x.end),
        fromDate: str(x.fromDate),
        toDate: str(x.toDate),
        skipDates: Array.isArray(x.skipDates) ? (x.skipDates as unknown[]).filter((d): d is string => typeof d === 'string') : [],
        timeZone: str(x.timeZone) || undefined,
      });
    }
  }
  if (Array.isArray(r.singles)) {
    for (const x of r.singles as Array<Record<string, unknown>>) {
      if (!x || typeof x !== 'object' || !str(x.id) || !str(x.courseId)) continue;
      doc.singles.push({ id: str(x.id), courseId: str(x.courseId), title: str(x.title), date: str(x.date), start: str(x.start), end: str(x.end), timeZone: str(x.timeZone) || undefined });
    }
  }
  return doc;
}
