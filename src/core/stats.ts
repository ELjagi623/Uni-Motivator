// Statistics over the timetable, the user's marks and the slacking records at an instant `nowMs`. Pure functions.
//
// Counting rules (all "up to now"):
//  - Only sessions that have ended by `nowMs` count; their cost is the integer cost core gave them (`costMinor`).
//  - A cancelled (停课) session still costs money (the school swallowed it) but is not an attendance opportunity.
//  - Slack amounts are derived, never stored: `round(unit price x overlapping seconds)` per record, like everywhere else.

import { academicYearOf } from './academic';
import type { Pool } from './billing';
import { slackAmountMinor, slackSeconds } from './slack';
import type { AcademicConfig, Course, MarkMap, SlackRecord } from './types';

export interface StatsSession {
  id: string;
  courseId: string;
  startMs: number;
  endMs: number;
}

export interface StatsInput {
  /** Billable sessions (the ones that belong to a confirmed course). */
  sessions: readonly StatsSession[];
  pools: readonly Pool[];
  courses: readonly Course[];
  marks: MarkMap;
  slacks: readonly SlackRecord[];
  nowMs: number;
}

export interface CourseStat {
  courseId: string;
  name: string;
  code: string | null;
  /** Sessions that have ended. */
  sessionCount: number;
  /** Sessions that have ended and were not cancelled. */
  countedSessions: number;
  attendedCount: number;
  skippedCount: number;
  cancelledCount: number;
  /** attended / counted; null when no class that counts has ended. */
  attendanceRate: number | null;
  /** Hours of the sessions that have ended. */
  hours: number;
  /** Cost of the sessions that have ended (integer minor units). */
  totalCostMinor: number;
  /** totalCost / hours, rounded to an integer; 0 when there are no hours. */
  costPerHourMinor: number;
  slackSeconds: number;
  slackMinor: number;
}

export interface SessionStat {
  sessionId: string;
  courseId: string;
  startMs: number;
  costMinor: number;
  slackSeconds: number;
  slackMinor: number;
}

export interface SlackStats {
  totalSeconds: number;
  totalMinor: number;
  /** Slack seconds / seconds of classes that were attended (not skipped, not cancelled); null when there were none. */
  slackRate: number | null;
  recordCount: number;
  /** The course with the most slack time, or null when nothing was slacked. */
  favouriteCourse: { courseId: string; seconds: number; minor: number } | null;
  /** The longest single slack (clipped to its class). */
  longest: { recordId: string; sessionId: string; courseId: string; seconds: number; minor: number } | null;
}

export interface PeriodSummary {
  fromMs: number;
  toMs: number;
  sessionCount: number;
  costMinor: number;
  hours: number;
  attendedCount: number;
  countedSessions: number;
  attendanceRate: number | null;
  slackSeconds: number;
  slackMinor: number;
}

export interface Stats {
  courses: CourseStat[];
  /** The most expensive session that has ended (earliest wins a tie); null before any class. */
  mostExpensive: SessionStat | null;
  /** The session with the most slacking (slack > 0), or null. */
  mostLossy: SessionStat | null;
  slack: SlackStats;
  totalCostMinor: number;
  totalHours: number;
}

function ratePerSecOf(pools: readonly Pool[], sessionId: string): { rate: number; cost: number } {
  for (const p of pools) {
    const i = p.indexById.get(sessionId);
    if (i !== undefined) return { rate: p.sessions[i].ratePerSec, cost: p.sessions[i].costMinor };
  }
  return { rate: 0, cost: 0 };
}

interface Row {
  s: StatsSession;
  costMinor: number;
  durationSec: number;
  status: 'cancelled' | 'skipped' | 'attended';
  slackSec: number;
  slackMinor: number;
}

function endedRows(input: StatsInput): Row[] {
  const bySession = new Map<string, { sec: number; minor: number }>();
  const sessionById = new Map(input.sessions.map((s) => [s.id, s]));
  for (const r of input.slacks) {
    const s = sessionById.get(r.sessionId);
    if (!s) continue;
    const { rate } = ratePerSecOf(input.pools, s.id);
    const acc = bySession.get(s.id) ?? { sec: 0, minor: 0 };
    acc.sec += slackSeconds(r, s, input.nowMs);
    acc.minor += slackAmountMinor(r, s, rate, input.nowMs);
    bySession.set(s.id, acc);
  }
  const rows: Row[] = [];
  for (const s of input.sessions) {
    if (s.endMs > input.nowMs) continue;
    const mark = input.marks[s.id]?.status;
    const slack = bySession.get(s.id) ?? { sec: 0, minor: 0 };
    rows.push({
      s,
      costMinor: ratePerSecOf(input.pools, s.id).cost,
      durationSec: (s.endMs - s.startMs) / 1000,
      status: mark === 'cancelled' ? 'cancelled' : mark === 'skipped' ? 'skipped' : 'attended',
      slackSec: slack.sec,
      slackMinor: slack.minor,
    });
  }
  return rows;
}

const sessionStat = (r: Row): SessionStat => ({ sessionId: r.s.id, courseId: r.s.courseId, startMs: r.s.startMs, costMinor: r.costMinor, slackSeconds: r.slackSec, slackMinor: r.slackMinor });

/** Course ranking (most money first), the most expensive / most "losing" session and the slacking figures. */
export function computeStats(input: StatsInput): Stats {
  const rows = endedRows(input);
  const byCourse = new Map<string, CourseStat>();
  for (const course of input.courses) {
    byCourse.set(course.id, {
      courseId: course.id,
      name: course.name,
      code: course.code,
      sessionCount: 0,
      countedSessions: 0,
      attendedCount: 0,
      skippedCount: 0,
      cancelledCount: 0,
      attendanceRate: null,
      hours: 0,
      totalCostMinor: 0,
      costPerHourMinor: 0,
      slackSeconds: 0,
      slackMinor: 0,
    });
  }
  let attendedSeconds = 0;
  let totalCost = 0;
  let totalSeconds = 0;
  for (const r of rows) {
    const c = byCourse.get(r.s.courseId);
    if (!c) continue;
    c.sessionCount++;
    c.hours += r.durationSec / 3600;
    c.totalCostMinor += r.costMinor;
    c.slackSeconds += r.slackSec;
    c.slackMinor += r.slackMinor;
    if (r.status === 'cancelled') c.cancelledCount++;
    else {
      c.countedSessions++;
      if (r.status === 'skipped') c.skippedCount++;
      else {
        c.attendedCount++;
        attendedSeconds += r.durationSec;
      }
    }
    totalCost += r.costMinor;
    totalSeconds += r.durationSec;
  }
  const courses = [...byCourse.values()].filter((c) => c.sessionCount > 0);
  for (const c of courses) {
    c.attendanceRate = c.countedSessions > 0 ? c.attendedCount / c.countedSessions : null;
    c.costPerHourMinor = c.hours > 0 ? Math.round(c.totalCostMinor / c.hours) : 0;
  }
  courses.sort((a, b) => b.totalCostMinor - a.totalCostMinor || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  let mostExpensive: Row | null = null;
  let mostLossy: Row | null = null;
  for (const r of rows) {
    if (!mostExpensive || r.costMinor > mostExpensive.costMinor || (r.costMinor === mostExpensive.costMinor && r.s.startMs < mostExpensive.s.startMs)) mostExpensive = r;
    if (r.slackSec > 0 && (!mostLossy || r.slackSec > mostLossy.slackSec || (r.slackSec === mostLossy.slackSec && r.s.startMs < mostLossy.s.startMs))) mostLossy = r;
  }

  const sessionById = new Map(input.sessions.map((s) => [s.id, s]));
  let longest: SlackStats['longest'] = null;
  let recordCount = 0;
  let slackTotalSec = 0;
  let slackTotalMinor = 0;
  for (const rec of input.slacks) {
    const s = sessionById.get(rec.sessionId);
    if (!s || s.endMs > input.nowMs) continue; // like everything here: only classes that are over
    const sec = slackSeconds(rec, s, input.nowMs);
    if (sec <= 0) continue;
    const minor = slackAmountMinor(rec, s, ratePerSecOf(input.pools, s.id).rate, input.nowMs);
    recordCount++;
    slackTotalSec += sec;
    slackTotalMinor += minor;
    if (!longest || sec > longest.seconds) longest = { recordId: rec.id, sessionId: s.id, courseId: s.courseId, seconds: sec, minor };
  }
  const favourite = [...courses].filter((c) => c.slackSeconds > 0).sort((a, b) => b.slackSeconds - a.slackSeconds || (a.name < b.name ? -1 : 1))[0];

  return {
    courses,
    mostExpensive: mostExpensive ? sessionStat(mostExpensive) : null,
    mostLossy: mostLossy ? sessionStat(mostLossy) : null,
    slack: {
      totalSeconds: slackTotalSec,
      totalMinor: slackTotalMinor,
      slackRate: attendedSeconds > 0 ? slackTotalSec / attendedSeconds : null,
      recordCount,
      favouriteCourse: favourite ? { courseId: favourite.courseId, seconds: favourite.slackSeconds, minor: favourite.slackMinor } : null,
      longest,
    },
    totalCostMinor: totalCost,
    totalHours: totalSeconds / 3600,
  };
}

/** Sessions that ended inside [fromMs, toMs) (and by `input.nowMs`): cost, hours, attendance and slacking. */
export function periodSummary(input: StatsInput, fromMs: number, toMs: number): PeriodSummary {
  const rows = endedRows(input).filter((r) => r.s.endMs > fromMs && r.s.endMs <= toMs);
  let counted = 0;
  let attended = 0;
  let cost = 0;
  let seconds = 0;
  let slackSec = 0;
  let slackMinor = 0;
  for (const r of rows) {
    cost += r.costMinor;
    seconds += r.durationSec;
    slackSec += r.slackSec;
    slackMinor += r.slackMinor;
    if (r.status !== 'cancelled') {
      counted++;
      if (r.status === 'attended') attended++;
    }
  }
  return {
    fromMs,
    toMs,
    sessionCount: rows.length,
    costMinor: cost,
    hours: seconds / 3600,
    attendedCount: attended,
    countedSessions: counted,
    attendanceRate: counted > 0 ? attended / counted : null,
    slackSeconds: slackSec,
    slackMinor,
  };
}

/** Local Monday 00:00 .. next Monday 00:00 of the week containing `ms`. */
export function weekRange(ms: number): { fromMs: number; toMs: number } {
  const d = new Date(ms);
  const sinceMonday = (d.getDay() + 6) % 7;
  return { fromMs: new Date(d.getFullYear(), d.getMonth(), d.getDate() - sinceMonday).getTime(), toMs: new Date(d.getFullYear(), d.getMonth(), d.getDate() - sinceMonday + 7).getTime() };
}

/**
 * A "nice" value axis from 0 up to at least `maxMinor`: the step is 1, 2, 2.5, 5 or 10 times a power of ten (never
 * less than one whole currency unit), with about `targetTicks` steps. All values are in minor units (cents).
 */
export function niceAxis(maxMinor: number, targetTicks = 4): { stepMinor: number; maxMinor: number; ticks: number[] } {
  const maxMajor = Math.max(1, maxMinor / 100);
  const raw = maxMajor / Math.max(1, targetTicks);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  const stepMajor = Math.max(1, nice * magnitude);
  const count = Math.max(1, Math.ceil(maxMajor / stepMajor - 1e-9));
  const stepMinor = Math.round(stepMajor * 100);
  return { stepMinor, maxMinor: stepMinor * count, ticks: Array.from({ length: count + 1 }, (_, i) => i * stepMinor) };
}

// ------------------------------------------------------------------ history over several academic years

export interface YearHistory extends PeriodSummary {
  /** The academic year (label = the calendar year it starts in). */
  year: number;
}

export interface HistorySummary {
  /** One summary per academic year that has sessions, oldest first. */
  years: YearHistory[];
  /** The sum of the years: cost, hours, counts and slacking add up; attendance is recomputed from the summed counts. */
  total: Omit<PeriodSummary, 'fromMs' | 'toMs'>;
}

/**
 * Per-year totals for sessions that have ended by `input.nowMs`, and their sum. Old years are read-only archives but
 * count in the history like any other year, so the total always equals the sum of the years.
 */
export function historySummary(input: StatsInput, cfg: AcademicConfig): HistorySummary {
  const byYear = new Map<number, StatsSession[]>();
  for (const s of input.sessions) {
    const y = academicYearOf(s.startMs, cfg);
    const list = byYear.get(y);
    if (list) list.push(s);
    else byYear.set(y, [s]);
  }
  const years: YearHistory[] = [...byYear.keys()]
    .sort((a, b) => a - b)
    .map((year) => ({ year, ...periodSummary({ ...input, sessions: byYear.get(year) as StatsSession[] }, 0, Number.MAX_SAFE_INTEGER) }));
  const total = { sessionCount: 0, costMinor: 0, hours: 0, attendedCount: 0, countedSessions: 0, attendanceRate: null as number | null, slackSeconds: 0, slackMinor: 0 };
  for (const y of years) {
    total.sessionCount += y.sessionCount;
    total.costMinor += y.costMinor;
    total.hours += y.hours;
    total.attendedCount += y.attendedCount;
    total.countedSessions += y.countedSessions;
    total.slackSeconds += y.slackSeconds;
    total.slackMinor += y.slackMinor;
  }
  total.attendanceRate = total.countedSessions > 0 ? total.attendedCount / total.countedSessions : null;
  return { years, total };
}
