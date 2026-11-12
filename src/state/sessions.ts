// The session list page: one calendar week at a time, the user's marks, what past sessions cost, and the three
// summary figures (swallowed by the school / lost to skipping / attendance). All money comes from core
// (`sessionStateAt`, `summarizeMarks`, the slack functions); this file only selects, groups and formats.
//
//  - `buildSessionsModel` is pure (inputs + `now` + the chosen week) so it can be tested for any instant.
//  - The signals that bind this to the app (chosen week, selected row) are in sessionsState.ts, so that scripts can
//    import this pure file without the browser clock.
//  - The summary counts the sessions that have ended by `now` (`summarizeMarks(..., {asOfMs: now})`): a class that has
//    not happened yet has neither been swallowed nor skipped, and attendance only makes sense for classes that are over.

import { academicYearOf } from '../core/academic';
import { findPoolOfSession, getPoolSession, sessionStateAt, summarizeMarks, type MarkSummary } from '../core/billing';
import { skipCalculation } from '../core/equivalents';
import { formatMinor, type CurrencyCode } from '../core/money';
import { sessionOrdinal, type Ordinal } from '../core/ordinal';
import { slackAmountMinor, slackSeconds } from '../core/slack';
import type { MarkStatus } from '../core/types';
import { academicYearsOf, isSessionArchived, type YearRole } from '../core/years';
import { t } from '../i18n';
import { clockText, minutesOf, rateText, weekdayText, type DashboardInputs } from './dashboard';

export type SessionPhase = 'past' | 'ongoing' | 'upcoming';

export interface SessionRow {
  id: string;
  startMs: number;
  endMs: number;
  courseId: string;
  /** Course code, or the name when there is no code. */
  label: string;
  courseName: string;
  ordinal: Ordinal | null;
  /** "Mon 11/09" in the interface language. */
  dateText: string;
  /** "09:00-12:00" */
  timeText: string;
  /** "3 hours" / "50 minutes" in the interface language. */
  lengthText: string;
  /** Heading of the detail panel: "MFIN7001 · 11/12 10:00". */
  detailTitle: string;
  phase: SessionPhase;
  mark: MarkStatus | null;
  costMinor: number;
  /** The whole session's cost as money text. */
  fullCostText: string;
  /** What the "cost" column shows: the full cost (past), what has burned so far (ongoing) or a dash (upcoming). */
  costText: string;
  rateText: string;
  slackSeconds: number;
  slackAmountMinor: number;
  /** Slack minutes and amount as text, or null when there was no slacking. */
  slackText: string | null;
  /** True for a class of an archived academic year: the marks cannot be changed any more. */
  readOnly: boolean;
  /** The skip calculator sentence ("翘掉这节 = 扔掉 HK$3,980 ≈ 88 盒三餸饭"); null for cancelled classes. */
  skipText: string | null;
}

/** One academic year the list can jump to (only offered when the timetable covers more than one year). */
export interface SessionsYearChip {
  year: number;
  label: string;
  role: YearRole;
  /** Monday of the week to jump to; null = this week. */
  jumpWeekMs: number | null;
  /** True when the shown week belongs to this year. */
  active: boolean;
}

export interface MarksSummaryView {
  cancelledMinor: number;
  skippedMinor: number;
  /** attended / (ended - cancelled), or null when nothing has ended yet. */
  attendanceRate: number | null;
  cancelledCount: number;
  skippedCount: number;
  attendedCount: number;
  endedCount: number;
  cancelledText: string;
  skippedText: string;
  attendanceText: string;
}

export interface SessionsModel {
  hasSessions: boolean;
  builtAtMs: number;
  weekStartMs: number;
  /** Exclusive end of the week (next Monday 00:00). */
  weekEndMs: number;
  weekNumber: number;
  /** "Week 46 · 11/09 - 11/15" in the interface language. */
  weekLabel: string;
  /** Whether `now` lies in the shown week. */
  isCurrentWeek: boolean;
  canPrev: boolean;
  canNext: boolean;
  rows: SessionRow[];
  summary: MarksSummaryView;
  currency: CurrencyCode;
  years: SessionsYearChip[];
}

// ------------------------------------------------------------------ weeks (Monday to Sunday, local time)

/** Local Monday 00:00 of the week containing `ms`. */
export function weekStartOf(ms: number): number {
  const d = new Date(ms);
  const sinceMonday = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - sinceMonday).getTime();
}

/** The Monday `n` weeks after (negative: before) the Monday `weekStartMs`; daylight-saving safe. */
export function addWeeks(weekStartMs: number, n: number): number {
  const d = new Date(weekStartMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7 * n).getTime();
}

/** ISO 8601 week number of the week that starts on Monday `weekStartMs`. */
export function isoWeekNumber(weekStartMs: number): number {
  const monday = new Date(weekStartMs);
  const thursday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 3);
  const jan1 = new Date(thursday.getFullYear(), 0, 1);
  const dayOfYear = Math.round((thursday.getTime() - jan1.getTime()) / 86_400_000) + 1;
  return Math.floor((dayOfYear - 1) / 7) + 1;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

function monthDay(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

/** Whole hours ("3"), one decimal ("1.5") from an hour and a half on; minutes below that. */
export function lengthText(durationSec: number): string {
  if (durationSec < 5400) return t('sessions.lengthMinutes', { n: Math.round(durationSec / 60) });
  return t('sessions.lengthHours', { n: String(Math.round(durationSec / 360) / 10) });
}

export function attendanceText(rate: number | null): string {
  return rate === null ? t('sessions.noValue') : `${Math.round(rate * 100)}%`;
}

// ------------------------------------------------------------------ rows

function rowOf(inputs: DashboardInputs, session: DashboardInputs['sessions'][number], nowMs: number): SessionRow {
  const pool = findPoolOfSession(inputs.pools, session.id);
  const ps = pool ? getPoolSession(pool, session.id) : null;
  const state = pool ? sessionStateAt(pool, session.id, nowMs) : null;
  const course = inputs.courses.find((c) => c.id === session.courseId);
  const code = course?.code ?? null;
  const name = course?.name ?? session.title;
  const phase: SessionPhase = nowMs >= session.endMs ? 'past' : nowMs >= session.startMs ? 'ongoing' : 'upcoming';
  const costMinor = ps?.costMinor ?? 0;

  let slackSec = 0;
  let slackMinor = 0;
  for (const record of inputs.slacks) {
    if (record.sessionId !== session.id) continue;
    slackSec += slackSeconds(record, session, nowMs);
    slackMinor += slackAmountMinor(record, session, ps?.ratePerSec ?? 0, nowMs);
  }
  let slackText: string | null = null;
  if (slackSec > 0) {
    const minutes = minutesOf(slackSec);
    slackText = `${minutes > 0 ? t('sessions.slackMinutes', { n: minutes }) : t('sessions.slackBrief')} · ${t('dashboard.slackWasted')} ${formatMinor(slackMinor, inputs.currency)}`;
  }

  let costText = t('sessions.noValue');
  if (phase === 'past') costText = formatMinor(costMinor, inputs.currency);
  else if (phase === 'ongoing') costText = formatMinor(state?.consumedMinor ?? 0, inputs.currency);

  return {
    id: session.id,
    startMs: session.startMs,
    endMs: session.endMs,
    courseId: session.courseId,
    label: code ?? name,
    courseName: name,
    ordinal: pool ? sessionOrdinal(pool.sessions, session.id) : null,
    dateText: `${weekdayText(session.startMs)} ${monthDay(session.startMs)}`,
    timeText: `${clockText(session.startMs)}–${clockText(session.endMs)}`,
    lengthText: lengthText((session.endMs - session.startMs) / 1000),
    detailTitle: `${code ?? name} · ${monthDay(session.startMs)} ${clockText(session.startMs)}`,
    phase,
    mark: inputs.marks[session.id]?.status ?? null,
    costMinor,
    fullCostText: formatMinor(costMinor, inputs.currency),
    costText,
    rateText: rateText(ps?.ratePerSec ?? 0, inputs.currency),
    slackSeconds: slackSec,
    slackAmountMinor: slackMinor,
    slackText,
    readOnly: inputs.academic ? isSessionArchived(session.startMs, nowMs, inputs.academic) : false,
    skipText: inputs.marks[session.id]?.status === 'cancelled' ? null : skipTextOf(costMinor, inputs.currency),
  };
}

/** The skip calculator: what skipping this class throws away, in everyday boxes of rice (core's numbers). */
export function skipTextOf(costMinor: number, currency: CurrencyCode): string | null {
  const calc = skipCalculation(costMinor, currency);
  if (!calc || costMinor <= 0) return null;
  const amount = formatMinor(costMinor, currency);
  return calc.count >= 1
    ? t('sessions.calc.text', { amount, count: calc.count, unit: calc.item.unit, name: calc.item.name })
    : t('sessions.calc.less', { amount, unit: calc.item.unit, name: calc.item.name });
}

/** One session as a row (for the detail panel), or null when the id is unknown. */
export function sessionRowOf(inputs: DashboardInputs, sessionId: string, nowMs: number): SessionRow | null {
  const session = inputs.sessions.find((s) => s.id === sessionId);
  return session ? rowOf(inputs, session, nowMs) : null;
}

// ------------------------------------------------------------------ summary

export function summaryViewOf(summary: MarkSummary, currency: CurrencyCode): MarksSummaryView {
  return {
    cancelledMinor: summary.cancelledMinor,
    skippedMinor: summary.skippedMinor,
    attendanceRate: summary.attendanceRate,
    cancelledCount: summary.cancelledCount,
    skippedCount: summary.skippedCount,
    attendedCount: summary.attendedCount,
    endedCount: summary.sessionCount,
    cancelledText: formatMinor(summary.cancelledMinor, currency),
    skippedText: formatMinor(summary.skippedMinor, currency),
    attendanceText: attendanceText(summary.attendanceRate),
  };
}

/** The three figures at the top of the page, over every tuition pool, for sessions that have ended by `nowMs`. */
export function marksSummaryAt(inputs: DashboardInputs, nowMs: number): MarksSummaryView {
  return summaryViewOf(summarizeMarks(inputs.pools, inputs.marks, { asOfMs: nowMs }).total, inputs.currency);
}

// ------------------------------------------------------------------ the model

/**
 * @param requestedWeekStartMs the Monday the user navigated to, or null to follow today. A request outside the span
 *   of the calendar (first to last session week) is moved to the nearest week inside it.
 */
export function buildSessionsModel(inputs: DashboardInputs, nowMs: number, requestedWeekStartMs: number | null): SessionsModel {
  const summary = marksSummaryAt(inputs, nowMs);
  if (inputs.sessions.length === 0) {
    const start = weekStartOf(nowMs);
    return {
      hasSessions: false,
      builtAtMs: nowMs,
      weekStartMs: start,
      weekEndMs: addWeeks(start, 1),
      weekNumber: isoWeekNumber(start),
      weekLabel: '',
      isCurrentWeek: true,
      canPrev: false,
      canNext: false,
      rows: [],
      summary,
      currency: inputs.currency,
      years: [],
    };
  }
  let firstMs = Infinity;
  let lastMs = -Infinity;
  for (const s of inputs.sessions) {
    if (s.startMs < firstMs) firstMs = s.startMs;
    if (s.startMs > lastMs) lastMs = s.startMs;
  }
  const firstWeek = weekStartOf(firstMs);
  const lastWeek = weekStartOf(lastMs);
  const wanted = requestedWeekStartMs ?? weekStartOf(nowMs);
  const weekStartMs = wanted < firstWeek ? firstWeek : wanted > lastWeek ? lastWeek : weekStartOf(wanted);
  const weekEndMs = addWeeks(weekStartMs, 1);
  const rows = inputs.sessions
    .filter((s) => s.startMs >= weekStartMs && s.startMs < weekEndMs)
    .slice()
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
    .map((s) => rowOf(inputs, s, nowMs));
  const weekNumber = isoWeekNumber(weekStartMs);
  return {
    hasSessions: true,
    builtAtMs: nowMs,
    weekStartMs,
    weekEndMs,
    weekNumber,
    weekLabel: t('sessions.weekLabel', { n: weekNumber, from: monthDay(weekStartMs), to: monthDay(weekEndMs - 1) }),
    isCurrentWeek: nowMs >= weekStartMs && nowMs < weekEndMs,
    canPrev: weekStartMs > firstWeek,
    canNext: weekStartMs < lastWeek,
    rows,
    summary,
    currency: inputs.currency,
    years: yearChipsOf(inputs, nowMs, weekStartMs),
  };
}

/** The year buttons of the list: where each year's classes are, and which year the shown week belongs to. */
function yearChipsOf(inputs: DashboardInputs, nowMs: number, shownWeekStartMs: number): SessionsYearChip[] {
  const academic = inputs.academic;
  if (!academic) return [];
  const years = academicYearsOf(inputs.sessions, academic, nowMs);
  if (years.length < 2) return [];
  const shownYear = academicYearOf(shownWeekStartMs + 3 * 86_400_000, academic);
  return years.map((y) => ({
    year: y.year,
    label: t('years.label', { year: y.year }),
    role: y.role,
    jumpWeekMs: y.role === 'current' ? null : weekStartOf(y.role === 'archived' ? lastStartOf(inputs, y.year, academic) : y.firstStartMs),
    active: y.year === shownYear,
  }));
}

function lastStartOf(inputs: DashboardInputs, year: number, academic: NonNullable<DashboardInputs['academic']>): number {
  let last = -Infinity;
  for (const s of inputs.sessions) if (academicYearOf(s.startMs, academic) === year && s.startMs > last) last = s.startMs;
  return last;
}
