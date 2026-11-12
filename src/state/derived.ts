// Values derived from the stored data: calendar texts -> sessions -> billable sessions -> tuition pools.
// They are `computed` signals, so they are recomputed only when the underlying data changes (never because the
// clock ticks). All money maths is done by core.

import { computed } from '@preact/signals';
import { assignCourses } from '../core/courses';
import { buildPools, type BillableSession, type BillingConfig, type Pool } from '../core/billing';
import { expandIcs, mergeSessions } from '../core/ics/expand';
import { isCurrencyCode, type CurrencyCode } from '../core/money';
import type { Course, Session } from '../core/types';
import type { CalendarFile } from '../api/client';
import { activeCalendars, activeConfig } from './source';
import { DEFAULT_CURRENCY, defaultAcademic, type AppConfig } from './config';

export interface ParsedCalendarFile {
  id: string;
  sessions: Session[];
  /** True when the text could not be parsed as iCalendar. */
  failed: boolean;
}

const parseCache = new Map<string, { text: string; result: ParsedCalendarFile }>();

/** Parse (and cache by id + text) one calendar file. */
export function parseCalendarFile(file: CalendarFile): ParsedCalendarFile {
  const hit = parseCache.get(file.id);
  if (hit && hit.text === file.text) return hit.result;
  let result: ParsedCalendarFile;
  try {
    result = { id: file.id, sessions: expandIcs(file.text), failed: false };
  } catch {
    result = { id: file.id, sessions: [], failed: true };
  }
  parseCache.set(file.id, { text: file.text, result });
  return result;
}

/** Whether the text is valid iCalendar (nothing is cached). */
export function isParsableCalendar(text: string): boolean {
  try {
    expandIcs(text);
    return true;
  } catch {
    return false;
  }
}

export function sessionsOfFiles(files: readonly CalendarFile[]): Session[] {
  return mergeSessions(files.map((f) => parseCalendarFile(f).sessions));
}

/** The sessions of the confirmed courses, each tagged with its course id. */
export function billableOf(sessions: readonly Session[], courses: readonly Course[]): Array<Session & BillableSession & { courseId: string }> {
  const assigned = assignCourses(sessions, courses);
  const out: Array<Session & BillableSession & { courseId: string }> = [];
  for (const s of sessions) {
    const courseId = assigned.get(s.id);
    if (courseId) out.push({ ...s, courseId });
  }
  return out;
}

export function billingConfigOf(cfg: AppConfig): BillingConfig {
  const courses = cfg.courses ?? [];
  const credits: Record<string, number | null> = {};
  for (const c of courses) credits[c.id] = c.credits;
  return {
    academic: cfg.academic ?? defaultAcademic(),
    mode: cfg.billingMode ?? 'duration',
    tuition: cfg.tuition ?? { defaultMinor: null },
    credits,
  };
}

export const allSessions = computed<Session[]>(() => sessionsOfFiles(activeCalendars.value));
export const courses = computed<Course[]>(() => activeConfig.value.courses ?? []);
export const billableSessions = computed(() => billableOf(allSessions.value, courses.value));
export const pools = computed<Pool[]>(() => (billableSessions.value.length ? buildPools(billableSessions.value, billingConfigOf(activeConfig.value)) : []));
export const currency = computed<CurrencyCode>(() => (isCurrencyCode(activeConfig.value.currency) ? activeConfig.value.currency : DEFAULT_CURRENCY));
