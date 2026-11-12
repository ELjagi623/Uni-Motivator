// Manual classes in the app state: adding a course by hand (weekly arrangement), adding / removing one-off make-up
// classes, taking one class out of a weekly arrangement. The definitions are stored in the `manual` part of the marks
// document; the sessions are derived (core/manual.ts, derived.ts), so billing, marks and statistics need no special case.
//
// Every change that moves a unit price first asks "unit price will change from X to Y, recalculate?" (a pending
// confirmation); nothing is written until the user confirms. Classes of an archived academic year cannot be added or removed.

import { computed, signal } from '@preact/signals';
import { buildPools } from '../core/billing';
import { COURSE_COLORS, extractCourseCode } from '../core/courses';
import { mergeSessions } from '../core/ics/expand';
import {
  emptyManual,
  expandManual,
  expandWeekly,
  validateSingle,
  validateWeekly,
  wallDateOf,
  type ManualDoc,
  type ManualProblem,
  type ManualSingle,
  type ManualWeekly,
} from '../core/manual';
import { isCurrencyCode } from '../core/money';
import type { Course, Session } from '../core/types';
import { isSessionArchived } from '../core/years';
import { DEFAULT_CURRENCY, defaultAcademic, type AppConfig } from './config';
import { parseCreditsText } from './credits';
import { calendars, config, flushSaves, marks as marksDoc, setConfig, setDoc } from './data';
import { billableOf, billingConfigOf, manualDoc, pools as savedPools, sessionsOfFiles } from './derived';
import { demoActive } from './demoState';
import { activeNow, hourBucket } from './now';
import { rateChanges, type RateChange } from './settings';

export type ManualFail = ManualProblem | 'archived' | 'course' | 'credits' | 'demo';

export type ManualOutcome = { status: 'invalid'; problems: ManualFail[] } | { status: 'confirm' } | { status: 'added' } | { status: 'removed' };

export interface WeeklyForm {
  /** An existing course to add the arrangement to, or '' for a new course typed below. */
  courseId: string;
  name: string;
  code: string;
  credits: string;
  /** 0 = Sunday ... 6 = Saturday. */
  weekday: number;
  start: string;
  end: string;
  fromDate: string;
  toDate: string;
  /** Skipped dates as typed: YYYY-MM-DD separated by spaces, commas or semicolons. */
  skipText: string;
  timeZone: string;
}

export interface SingleForm {
  courseId: string;
  date: string;
  start: string;
  end: string;
  timeZone: string;
}

export function emptyWeeklyForm(): WeeklyForm {
  return { courseId: '', name: '', code: '', credits: '', weekday: 1, start: '09:00', end: '12:00', fromDate: '', toDate: '', skipText: '', timeZone: '' };
}

export function emptySingleForm(): SingleForm {
  return { courseId: '', date: '', start: '09:00', end: '12:00', timeZone: '' };
}

const SKIP_SEPARATORS = new RegExp(`[\\s,;${String.fromCharCode(0xff0c, 0xff1b, 0x3001)}]+`);

export function parseSkipDates(text: string): string[] {
  // separators: white space, comma, semicolon and their full-width forms (U+FF0C, U+FF1B, U+3001)
  return text.split(SKIP_SEPARATORS).filter((x) => x !== '');
}

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

let counter = 0;
function newId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}${counter.toString(36)}`;
}

// ------------------------------------------------------------------ the pending confirmation

export interface ManualPending {
  changes: RateChange[];
  apply: () => Promise<void>;
}

export const manualPending = signal<ManualPending | null>(null);

/** Goes up whenever a class has really been added; the add forms clear themselves on it (not when the price question is cancelled). */
export const manualAddedTick = signal(0);

function currencyOf(cfg: AppConfig) {
  return isCurrencyCode(cfg.currency) ? cfg.currency : DEFAULT_CURRENCY;
}

/** The price changes the edit would cause in tuition pools that already exist. */
export function previewChanges(cfg: AppConfig, nextCourses: Course[], nextDoc: ManualDoc): RateChange[] {
  const academic = cfg.academic ?? defaultAcademic();
  const old = savedPools.peek();
  const oldKeys = new Set(old.map((p) => p.key));
  const sessions = mergeSessions([sessionsOfFiles(calendars.peek()), expandManual(nextDoc)]);
  const billable = billableOf(sessions, nextCourses);
  const nextCfg: AppConfig = { ...cfg, academic, courses: nextCourses };
  const pools = billable.length > 0 ? buildPools(billable, billingConfigOf(nextCfg)) : [];
  const names = new Map(nextCourses.map((c) => [c.id, c.code ?? c.name]));
  return rateChanges(old, currencyOf(cfg), pools.filter((p) => oldKeys.has(p.key)), currencyOf(cfg), {
    oldMode: cfg.billingMode,
    newMode: cfg.billingMode,
    courseLabel: (id) => names.get(id) ?? '',
  });
}

async function writeManual(nextCourses: Course[], nextDoc: ManualDoc): Promise<void> {
  const cfg = config.peek();
  const doc = marksDoc.peek();
  setDoc('marks', { ...doc, manual: nextDoc });
  if (nextCourses !== (cfg.courses ?? [])) setConfig({ ...cfg, courses: nextCourses });
  await flushSaves();
}

/** Apply an edit, or ask first when it changes a unit price. */
function commitOrAsk(nextCourses: Course[], nextDoc: ManualDoc, done: 'added' | 'removed'): ManualOutcome {
  const changes = previewChanges(config.peek(), nextCourses, nextDoc);
  const apply = async () => {
    manualPending.value = null;
    await writeManual(nextCourses, nextDoc);
    if (done === 'added') manualAddedTick.value += 1;
  };
  if (changes.length === 0) {
    void apply();
    return { status: done };
  }
  manualPending.value = { changes, apply };
  return { status: 'confirm' };
}

export async function confirmManual(): Promise<void> {
  const p = manualPending.peek();
  if (p) await p.apply();
}

export function cancelManual(): void {
  manualPending.value = null;
}

/** True when any class in `sessions` belongs to an archived academic year. */
function touchesArchive(sessions: readonly Session[]): boolean {
  const academic = config.peek().academic ?? defaultAcademic();
  const now = activeNow.peek();
  return sessions.some((s) => isSessionArchived(s.startMs, now, academic));
}

// ------------------------------------------------------------------ adding

function courseFor(form: { courseId: string; name?: string; code?: string; credits?: string }, courses: readonly Course[]): { course: Course; created: boolean } | ManualFail {
  if (form.courseId) {
    const found = courses.find((c) => c.id === form.courseId);
    return found ? { course: found, created: false } : 'course';
  }
  const name = (form.name ?? '').trim();
  if (!name) return 'title';
  const credits = parseCreditsText(form.credits ?? '');
  if (credits === undefined) return 'credits';
  const code = (form.code ?? '').trim() ? (extractCourseCode(form.code ?? '') ?? (form.code ?? '').trim().toUpperCase()) : null;
  const id = `c-m-${hash(`${code ?? ''}|${name.toLowerCase()}`)}`;
  const existing = courses.find((c) => c.id === id);
  if (existing) return { course: existing, created: false };
  return {
    course: { id, code, name, credits, color: COURSE_COLORS[courses.length % COURSE_COLORS.length], match: { codes: code ? [code] : [], titles: [name.toLowerCase()] }, manual: true },
    created: true,
  };
}

export function addWeekly(form: WeeklyForm): ManualOutcome {
  if (demoActive.peek()) return { status: 'invalid', problems: ['demo'] };
  const courses = config.peek().courses ?? [];
  const found = courseFor(form, courses);
  // A course problem (no name, bad credits, nothing chosen) is reported together with the problems of the rest of the form.
  const courseProblem: ManualFail[] = typeof found === 'string' ? [found] : [];
  const rule: ManualWeekly = {
    id: newId('w'),
    courseId: typeof found === 'string' ? '' : found.course.id,
    title: typeof found === 'string' ? '-' : found.course.name,
    weekday: form.weekday,
    start: form.start,
    end: form.end,
    fromDate: form.fromDate,
    toDate: form.toDate,
    skipDates: parseSkipDates(form.skipText),
    timeZone: form.timeZone.trim() || undefined,
  };
  const problems: ManualFail[] = [...courseProblem, ...validateWeekly(rule)];
  if (problems.length > 0 || typeof found === 'string') return { status: 'invalid', problems };
  if (touchesArchive(expandWeekly(rule))) return { status: 'invalid', problems: ['archived'] };
  const doc = manualDoc.peek();
  const nextCourses = found.created ? [...courses, found.course] : (courses as Course[]);
  return commitOrAsk(nextCourses, { ...doc, weekly: [...doc.weekly, rule] }, 'added');
}

export function addSingle(form: SingleForm): ManualOutcome {
  if (demoActive.peek()) return { status: 'invalid', problems: ['demo'] };
  const courses = config.peek().courses ?? [];
  const course = courses.find((c) => c.id === form.courseId);
  if (!course) return { status: 'invalid', problems: ['course'] };
  const single: ManualSingle = { id: newId('s'), courseId: course.id, title: course.name, date: form.date, start: form.start, end: form.end, timeZone: form.timeZone.trim() || undefined };
  const problems = validateSingle(single);
  if (problems.length > 0) return { status: 'invalid', problems };
  const added = expandManual({ weekly: [], singles: [single] });
  if (touchesArchive(added)) return { status: 'invalid', problems: ['archived'] };
  const doc = manualDoc.peek();
  return commitOrAsk(courses as Course[], { ...doc, singles: [...doc.singles, single] }, 'added');
}

// ------------------------------------------------------------------ removing

/** Courses the user created by hand that no longer have any manual definition: dropped together with the last one. */
function pruneManualCourses(courses: readonly Course[], doc: ManualDoc): Course[] {
  const used = new Set([...doc.weekly.map((w) => w.courseId), ...doc.singles.map((s) => s.courseId)]);
  const kept = courses.filter((c) => !c.manual || used.has(c.id));
  return kept.length === courses.length ? (courses as Course[]) : kept;
}

export function removeWeekly(id: string): ManualOutcome {
  const doc = manualDoc.peek();
  const rule = doc.weekly.find((w) => w.id === id);
  if (!rule) return { status: 'invalid', problems: ['course'] };
  if (touchesArchive(expandWeekly(rule))) return { status: 'invalid', problems: ['archived'] };
  const next = { ...doc, weekly: doc.weekly.filter((w) => w.id !== id) };
  return commitOrAsk(pruneManualCourses(config.peek().courses ?? [], next), next, 'removed');
}

export function removeSingle(id: string): ManualOutcome {
  const doc = manualDoc.peek();
  const single = doc.singles.find((s) => s.id === id);
  if (!single) return { status: 'invalid', problems: ['course'] };
  if (touchesArchive(expandManual({ weekly: [], singles: [single] }))) return { status: 'invalid', problems: ['archived'] };
  const next = { ...doc, singles: doc.singles.filter((s) => s.id !== id) };
  return commitOrAsk(pruneManualCourses(config.peek().courses ?? [], next), next, 'removed');
}

/** Take one class out of the weekly arrangement it came from (its date joins the skipped dates). */
export function removeOccurrence(sessionId: string, startMs: number): ManualOutcome {
  const doc = manualDoc.peek();
  const single = doc.singles.find((s) => expandManual({ weekly: [], singles: [s] }).some((x) => x.id === sessionId));
  if (single) return removeSingle(single.id);
  const rule = doc.weekly.find((w) => expandWeekly(w).some((x) => x.id === sessionId));
  if (!rule) return { status: 'invalid', problems: ['course'] };
  if (touchesArchive([{ startMs } as Session])) return { status: 'invalid', problems: ['archived'] };
  const day = wallDateOf(startMs, rule.timeZone);
  const next = { ...doc, weekly: doc.weekly.map((w) => (w.id === rule.id ? { ...w, skipDates: [...new Set([...w.skipDates, day])] } : w)) };
  return commitOrAsk(config.peek().courses ?? [], next, 'removed');
}

// ------------------------------------------------------------------ what the page lists

export interface ManualItemView {
  id: string;
  kind: 'weekly' | 'single';
  courseId: string;
  title: string;
  weekday: number | null;
  start: string;
  end: string;
  fromDate: string;
  toDate: string;
  sessionCount: number;
  readOnly: boolean;
}

export const manualItems = computed<ManualItemView[]>(() => {
  void hourBucket.value;
  const doc = manualDoc.value;
  const academic = config.value.academic ?? defaultAcademic();
  const now = activeNow.peek();
  const items: ManualItemView[] = [];
  for (const w of doc.weekly) {
    const list = expandWeekly(w);
    items.push({ id: w.id, kind: 'weekly', courseId: w.courseId, title: w.title, weekday: w.weekday, start: w.start, end: w.end, fromDate: w.fromDate, toDate: w.toDate, sessionCount: list.length, readOnly: list.some((s) => isSessionArchived(s.startMs, now, academic)) });
  }
  for (const s of doc.singles) {
    const list = expandManual({ weekly: [], singles: [s] });
    items.push({ id: s.id, kind: 'single', courseId: s.courseId, title: s.title, weekday: null, start: s.start, end: s.end, fromDate: s.date, toDate: s.date, sessionCount: list.length, readOnly: list.some((x) => isSessionArchived(x.startMs, now, academic)) });
  }
  return items;
});

export function resetManualState(): void {
  manualPending.value = null;
}

export { emptyManual };
