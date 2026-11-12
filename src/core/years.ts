// Academic years as the app sees them: which years the timetable covers, which one is "current", and which are
// archived (read-only). Pure functions; `now` is always a parameter.
//
// A year is not stored anywhere: it follows from the sessions and the configured year start (see academic.ts). A new
// academic year therefore "exists" as soon as a calendar with classes in it is imported; its tuition pools are the
// ones academic.ts derives for it. Rules:
//  - the current year is the academic year that contains `now`; earlier years are archived (read-only); later years
//    are upcoming (editable, e.g. to cancel a class in advance);
//  - the focus year (what the main screen shows) is the current year when it has classes, else the nearest upcoming
//    one, else the most recent archived one.

import { academicYearOf, parseMonthDay } from './academic';
import type { AcademicConfig } from './types';

export type YearRole = 'current' | 'archived' | 'upcoming';

export interface YearSession {
  id: string;
  startMs: number;
  endMs: number;
}

export interface YearInfo {
  /** The calendar year in which the academic year starts (label "2026 学年"). */
  year: number;
  role: YearRole;
  /** Local midnight of the year's start day. */
  fromMs: number;
  /** Local midnight of the next year's start day (exclusive end). */
  toMs: number;
  sessionCount: number;
  totalSeconds: number;
  firstStartMs: number;
  lastEndMs: number;
}

/** Local midnight (UTC ms) of the start day of academic year `year`. */
export function yearStartMs(year: number, cfg: AcademicConfig): number {
  const start = parseMonthDay(cfg.yearStart);
  return new Date(year, start.month - 1, start.day).getTime();
}

export function yearRoleOf(year: number, nowMs: number, cfg: AcademicConfig): YearRole {
  const current = academicYearOf(nowMs, cfg);
  return year < current ? 'archived' : year > current ? 'upcoming' : 'current';
}

/** True when a session starting at `startMs` belongs to an academic year that is over at `nowMs` (read-only). */
export function isSessionArchived(startMs: number, nowMs: number, cfg: AcademicConfig): boolean {
  return academicYearOf(startMs, cfg) < academicYearOf(nowMs, cfg);
}

/** The academic years that have at least one session, oldest first. */
export function academicYearsOf(sessions: readonly YearSession[], cfg: AcademicConfig, nowMs: number): YearInfo[] {
  const byYear = new Map<number, YearSession[]>();
  for (const s of sessions) {
    if (s.endMs <= s.startMs) continue;
    const y = academicYearOf(s.startMs, cfg);
    const list = byYear.get(y);
    if (list) list.push(s);
    else byYear.set(y, [s]);
  }
  return [...byYear.keys()]
    .sort((a, b) => a - b)
    .map((year) => {
      const list = byYear.get(year) as YearSession[];
      return {
        year,
        role: yearRoleOf(year, nowMs, cfg),
        fromMs: yearStartMs(year, cfg),
        toMs: yearStartMs(year + 1, cfg),
        sessionCount: list.length,
        totalSeconds: list.reduce((sum, s) => sum + (s.endMs - s.startMs) / 1000, 0),
        firstStartMs: Math.min(...list.map((s) => s.startMs)),
        lastEndMs: Math.max(...list.map((s) => s.endMs)),
      };
    });
}

/** The year the main screen shows (see the rules at the top); null when there are no sessions. */
export function focusYearOf(years: readonly YearInfo[]): number | null {
  const current = years.find((y) => y.role === 'current');
  if (current) return current.year;
  const upcoming = years.find((y) => y.role === 'upcoming');
  if (upcoming) return upcoming.year;
  return years.length > 0 ? years[years.length - 1].year : null;
}

/** The sessions of one academic year. */
export function sessionsOfYear<T extends { startMs: number }>(sessions: readonly T[], year: number, cfg: AcademicConfig): T[] {
  return sessions.filter((s) => academicYearOf(s.startMs, cfg) === year);
}
