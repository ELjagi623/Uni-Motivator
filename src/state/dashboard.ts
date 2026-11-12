// The dashboard's view model.
//
//  - `buildDashboardModel` takes a snapshot for one instant: which of the 6 states we are in (core `getStatus`), the
//    sessions involved, today's timeline, the tuition pool for the "tank", slack totals. It only has to be rebuilt
//    when the status can change (`validFromMs` .. `validUntilMs`) or the underlying data changes.
//  - `liveAt` evaluates the numbers that move with time (consumed money, countdowns, progress) for any `nowMs`,
//    always through core (`sessionStateAt`, `poolStateAt`): nothing is accumulated by ticking.
//  - The `dashboardModel` computed signal keeps returning the same object while it is still valid, so the page does
//    not re-render on every clock frame; the ticking parts (TickingNumber etc.) read `liveAt` themselves.
//
// All money formatting and arithmetic for the UI is here; src/ui only displays what it is given.

import { billingStateAt, findPoolOfSession, getPoolSession, poolStateAt, sessionStateAt, type Pool } from '../core/billing';
import { sessionOrdinal, type Ordinal } from '../core/ordinal';
import { getCurrency, formatMinor, type CurrencyCode } from '../core/money';
import { slackAmountMinor, slackSeconds } from '../core/slack';
import { getStatus, type StatusKind } from '../core/status';
import type { Course, MarkMap, MarkStatus, Session, SlackRecord } from '../core/types';
import { getLocale, t } from '../i18n';
import type { DocValue } from './data';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

// ------------------------------------------------------------------ types

export interface SessionView {
  id: string;
  startMs: number;
  endMs: number;
  courseId: string;
  courseName: string;
  courseCode: string | null;
  courseColor: string;
  /** Short label: course code, or the name when there is no code. */
  label: string;
  /** "session i of N" among the course's sessions of the same tuition pool. */
  ordinal: Ordinal | null;
  costMinor: number;
  /** Unit price, minor units per second. */
  ratePerSec: number;
  rateText: string;
  mark: MarkStatus | null;
  poolKey: string;
  /** Local wall-clock times, e.g. "09:00". */
  startText: string;
  endText: string;
}

export interface TimelineItem {
  id: string;
  left: string;
  width: string;
  color: string;
  label: string;
  startText: string;
  endText: string;
  current: boolean;
  cancelled: boolean;
}

export interface PoolView {
  key: string;
  year: number;
  semester: 1 | 2 | null;
  tuitionSet: boolean;
  tuitionMinor: number;
  sessionCount: number;
  /** Total class hours, one decimal. */
  hours: string;
  rateText: string;
}

export interface SettlementView {
  costMinor: number;
  slackSeconds: number;
  slackAmountMinor: number;
}

export interface TermSummary {
  sessionCount: number;
  hours: string;
  tuitionMinor: number;
  rateText: string;
  slackSeconds: number;
  slackAmountMinor: number;
}

export interface NextWhen {
  weekday: string;
  date: string;
  time: string;
}

export interface DashboardModel {
  kind: StatusKind;
  builtAtMs: number;
  validFromMs: number;
  validUntilMs: number;
  currency: CurrencyCode;
  /** Sessions in progress: the primary one first, overlapping ones after it. Empty unless kind is 'in-class'. */
  active: SessionView[];
  next: SessionView | null;
  prev: SessionView | null;
  /** Only in 'break' when the previous session was earlier today. */
  prevSettlement: SettlementView | null;
  timeline: TimelineItem[];
  timelineStartMs: number;
  timelineEndMs: number;
  /** The tuition pool shown in the "tank". */
  pool: PoolView | null;
  poolIndex: number;
  slackToday: { seconds: number; amountMinor: number };
  /** Sum of the cost of today's sessions (cancelled ones included, as everywhere in the app). */
  todaySpentMinor: number;
  daysUntilTerm: number | null;
  nextWhen: NextWhen | null;
  term: TermSummary | null;
  /** The pools (same objects as in the derived state) used for live evaluation. */
  pools: readonly Pool[];
}

export interface DashboardInputs {
  sessions: ReadonlyArray<Session & { courseId: string }>;
  courses: readonly Course[];
  pools: readonly Pool[];
  marks: MarkMap;
  slacks: readonly SlackRecord[];
  currency: CurrencyCode;
}

// ------------------------------------------------------------------ small formatting helpers

const pad2 = (n: number): string => String(n).padStart(2, '0');

export function clockText(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function dateText(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** "HH:MM:SS" (hours may exceed 99). Negative values count as 0. */
export function durationText(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

export function percentText(fraction: number): string {
  return (Math.min(1, Math.max(0, fraction)) * 100).toFixed(1);
}

/** Whole minutes in a number of seconds. */
export function minutesOf(totalSeconds: number): number {
  return Math.floor(totalSeconds / 60);
}

export function hoursText(totalSeconds: number): string {
  return (totalSeconds / 3600).toFixed(1);
}

/** Unit price in the currency's major unit with four decimals, e.g. "HK$0.3685". */
export function rateText(ratePerSecMinor: number, currency: CurrencyCode): string {
  return `${getCurrency(currency).symbol}${(ratePerSecMinor / 100).toFixed(4)}`;
}

function weekdayText(ms: number): string {
  return new Intl.DateTimeFormat(getLocale(), { weekday: 'short' }).format(new Date(ms));
}

function localMidnight(ms: number, plusDays = 0): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + plusDays).getTime();
}

/** Whole calendar days from `fromMs` to `toMs` in the computer's time zone. */
export function calendarDaysBetween(fromMs: number, toMs: number): number {
  return Math.round((localMidnight(toMs) - localMidnight(fromMs)) / DAY_MS);
}

export function marksOf(doc: DocValue): MarkMap {
  const raw = doc.marks;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as MarkMap) : {};
}

// ------------------------------------------------------------------ building the model

export function buildDashboardModel(inputs: DashboardInputs, nowMs: number): DashboardModel {
  const { sessions, pools, currency } = inputs;
  const status = getStatus(nowMs, sessions, inputs.marks);
  const courseById = new Map(inputs.courses.map((c) => [c.id, c]));

  const viewOf = (s: Session & { courseId: string }): SessionView => {
    const pool = findPoolOfSession(pools, s.id);
    const ps = pool ? getPoolSession(pool, s.id) : null;
    const course = courseById.get(s.courseId);
    const code = course?.code ?? null;
    const name = course?.name ?? s.title;
    return {
      id: s.id,
      startMs: s.startMs,
      endMs: s.endMs,
      courseId: s.courseId,
      courseName: name,
      courseCode: code,
      courseColor: course?.color ?? '',
      label: code ?? name,
      ordinal: pool ? sessionOrdinal(pool.sessions, s.id) : null,
      costMinor: ps?.costMinor ?? 0,
      ratePerSec: ps?.ratePerSec ?? 0,
      rateText: rateText(ps?.ratePerSec ?? 0, currency),
      mark: inputs.marks[s.id]?.status ?? null,
      poolKey: pool?.key ?? '',
      startText: clockText(s.startMs),
      endText: clockText(s.endMs),
    };
  };

  const active = status.current ? [status.current, ...status.alsoActive].map(viewOf) : [];
  const next = status.next ? viewOf(status.next) : null;
  const prev = status.prev ? viewOf(status.prev) : null;

  // Slack totals (the amount of a record is always derived: unit price x overlapping seconds).
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const rateOf = (sessionId: string): number => {
    const pool = findPoolOfSession(pools, sessionId);
    return (pool ? getPoolSession(pool, sessionId)?.ratePerSec : 0) ?? 0;
  };
  const slackOf = (sessionIds: ReadonlySet<string> | null): { seconds: number; amountMinor: number } => {
    let seconds = 0;
    let amountMinor = 0;
    for (const r of inputs.slacks) {
      const s = sessionById.get(r.sessionId);
      if (!s || (sessionIds && !sessionIds.has(s.id))) continue;
      seconds += slackSeconds(r, s, nowMs);
      amountMinor += slackAmountMinor(r, s, rateOf(s.id), nowMs);
    }
    return { seconds, amountMinor };
  };
  const todayIds = new Set(status.today.map((s) => s.id));
  const slackToday = slackOf(todayIds);

  let prevSettlement: SettlementView | null = null;
  if (status.kind === 'break' && prev && todayIds.has(prev.id)) {
    const own = slackOf(new Set([prev.id]));
    prevSettlement = { costMinor: prev.costMinor, slackSeconds: own.seconds, slackAmountMinor: own.amountMinor };
  }

  // Today's timeline.
  const todayViews = status.today.map(viewOf);
  const currentId = active[0]?.id ?? null;
  let timelineStartMs = 0;
  let timelineEndMs = 0;
  let timeline: TimelineItem[] = [];
  if (todayViews.length > 0) {
    const first = Math.min(...todayViews.map((v) => v.startMs));
    const last = Math.max(...todayViews.map((v) => v.endMs));
    timelineStartMs = Math.floor(first / HOUR_MS) * HOUR_MS;
    timelineEndMs = Math.max(Math.ceil(last / HOUR_MS) * HOUR_MS, timelineStartMs + HOUR_MS);
    const span = timelineEndMs - timelineStartMs;
    timeline = todayViews.map((v) => ({
      id: v.id,
      left: `${(((v.startMs - timelineStartMs) / span) * 100).toFixed(2)}%`,
      width: `${(((v.endMs - v.startMs) / span) * 100).toFixed(2)}%`,
      color: v.courseColor,
      label: v.label,
      startText: v.startText,
      endText: v.endText,
      current: v.id === currentId,
      cancelled: v.mark === 'cancelled',
    }));
  }

  // The pool behind the tank: the one of the current / next / previous session, else the last one.
  const refSession = active[0] ?? next ?? prev ?? null;
  const poolObj = (refSession ? findPoolOfSession(pools, refSession.id) : null) ?? pools[pools.length - 1] ?? null;
  const poolView = (p: Pool): PoolView => ({
    key: p.key,
    year: p.year,
    semester: p.semester,
    tuitionSet: p.tuitionMinor !== null,
    tuitionMinor: p.tuitionMinor ?? 0,
    sessionCount: p.sessions.length,
    hours: hoursText(p.totalSeconds),
    rateText: rateText(p.averageRatePerSec, currency),
  });

  const nextWhen: NextWhen | null = status.next ? { weekday: weekdayText(status.next.startMs), date: dateText(status.next.startMs), time: clockText(status.next.startMs) } : null;

  let term: TermSummary | null = null;
  if (status.kind === 'before-term' && poolObj) {
    const v = poolView(poolObj);
    term = { sessionCount: v.sessionCount, hours: v.hours, tuitionMinor: v.tuitionMinor, rateText: v.rateText, slackSeconds: 0, slackAmountMinor: 0 };
  } else if (status.kind === 'after-term') {
    const all = slackOf(null);
    const tuition = pools.reduce((sum, p) => sum + (p.tuitionMinor ?? 0), 0);
    const seconds = pools.reduce((sum, p) => sum + p.totalSeconds, 0);
    term = {
      sessionCount: pools.reduce((sum, p) => sum + p.sessions.length, 0),
      hours: hoursText(seconds),
      tuitionMinor: tuition,
      rateText: rateText(seconds > 0 ? tuition / seconds : 0, currency),
      slackSeconds: all.seconds,
      slackAmountMinor: all.amountMinor,
    };
  }

  // The model stays valid until the next session boundary or midnight (whichever comes first).
  let validFromMs = localMidnight(nowMs);
  let validUntilMs = localMidnight(nowMs, 1);
  for (const s of sessions) {
    for (const edge of [s.startMs, s.endMs]) {
      if (edge <= nowMs && edge > validFromMs) validFromMs = edge;
      if (edge > nowMs && edge < validUntilMs) validUntilMs = edge;
    }
  }

  return {
    kind: status.kind,
    builtAtMs: nowMs,
    validFromMs,
    validUntilMs,
    currency,
    active,
    next,
    prev,
    prevSettlement,
    timeline,
    timelineStartMs,
    timelineEndMs,
    pool: poolObj ? poolView(poolObj) : null,
    poolIndex: poolObj ? pools.indexOf(poolObj) : -1,
    slackToday,
    todaySpentMinor: todayViews.reduce((sum, v) => sum + v.costMinor, 0),
    daysUntilTerm: status.kind === 'before-term' && status.next ? calendarDaysBetween(nowMs, status.next.startMs) : null,
    nextWhen,
    term,
    pools,
  };
}

// ------------------------------------------------------------------ live values

export interface Live {
  sessionConsumedMinor: number;
  sessionRemainingMinor: number;
  sessionCostMinor: number;
  /** 0..1 */
  sessionProgress: number;
  elapsedSec: number;
  remainingSec: number;
  poolConsumedMinor: number;
  poolRemainingMinor: number;
  poolTuitionMinor: number;
  /** 0..1 */
  poolProgress: number;
  countdownSec: number;
  /** Left position of the "now" marker on today's timeline in percent, or null when `now` is outside it. */
  markerPct: number | null;
  /** The elapsed part of the shown session on the timeline (percent of the timeline's width). */
  elapsedLeftPct: number;
  elapsedWidthPct: number;
}

let liveCache: { model: DashboardModel; sessionId: string | null; nowMs: number; value: Live } | null = null;

/** The model's pool for display: the pool of the given session when it has one, else the model's tank pool. */
function poolFor(model: DashboardModel, sessionId: string | null): Pool | null {
  if (sessionId) {
    const p = findPoolOfSession(model.pools, sessionId);
    if (p) return p;
  }
  return model.poolIndex >= 0 ? model.pools[model.poolIndex] : null;
}

/** Evaluate everything that moves with time at `nowMs`. `sessionId` is the session being displayed (if any). */
export function liveAt(model: DashboardModel, sessionId: string | null, nowMs: number): Live {
  if (liveCache && liveCache.model === model && liveCache.sessionId === sessionId && liveCache.nowMs === nowMs) return liveCache.value;
  const view = sessionId ? [...model.active, model.next, model.prev].find((v) => v?.id === sessionId) ?? null : null;
  const pool = poolFor(model, sessionId);

  let sessionConsumed = 0;
  let sessionRemaining = 0;
  let sessionCost = 0;
  let sessionProgress = 0;
  if (pool && sessionId) {
    const st = sessionStateAt(pool, sessionId, nowMs);
    if (st) {
      sessionConsumed = st.consumedMinor;
      sessionRemaining = st.remainingMinor;
      sessionCost = st.costMinor;
      sessionProgress = st.progress;
    }
  }
  const ps = pool ? poolStateAt(pool, nowMs) : null;

  const span = model.timelineEndMs - model.timelineStartMs;
  const pct = (ms: number): number => (span > 0 ? ((ms - model.timelineStartMs) / span) * 100 : 0);
  const markerPct = span > 0 && nowMs >= model.timelineStartMs && nowMs <= model.timelineEndMs ? pct(nowMs) : null;
  let elapsedLeftPct = 0;
  let elapsedWidthPct = 0;
  const cur = model.active[0] ?? null;
  if (cur && span > 0) {
    elapsedLeftPct = pct(cur.startMs);
    elapsedWidthPct = Math.max(0, pct(Math.min(nowMs, cur.endMs)) - elapsedLeftPct);
  }

  const value: Live = {
    sessionConsumedMinor: sessionConsumed,
    sessionRemainingMinor: sessionRemaining,
    sessionCostMinor: sessionCost,
    sessionProgress,
    elapsedSec: view ? Math.max(0, Math.floor((Math.min(nowMs, view.endMs) - view.startMs) / 1000)) : 0,
    remainingSec: view ? Math.max(0, Math.ceil((view.endMs - nowMs) / 1000)) : 0,
    poolConsumedMinor: ps?.consumedMinor ?? 0,
    poolRemainingMinor: ps?.remainingMinor ?? 0,
    poolTuitionMinor: ps?.tuitionMinor ?? 0,
    poolProgress: ps?.progress ?? 0,
    countdownSec: model.next ? Math.max(0, Math.ceil((model.next.startMs - nowMs) / 1000)) : 0,
    markerPct,
    elapsedLeftPct,
    elapsedWidthPct,
  };
  liveCache = { model, sessionId, nowMs, value };
  return value;
}

/** CSS percentage string with two decimals. */
export function cssPercent(value: number): string {
  return `${Math.min(100, Math.max(0, value)).toFixed(2)}%`;
}

/** Width of the tank's fill (CSS percentage) at `nowMs`. */
export function poolFillWidth(model: DashboardModel, sessionId: string | null, nowMs: number): string {
  return cssPercent(liveAt(model, sessionId, nowMs).poolProgress * 100);
}

/** All pools together at `nowMs` (used by the title and the term summary). */
export function totalsAt(model: DashboardModel, nowMs: number): { consumedMinor: number; remainingMinor: number; tuitionMinor: number } {
  const b = billingStateAt(model.pools, nowMs);
  return { consumedMinor: b.consumedMinor, remainingMinor: b.remainingMinor, tuitionMinor: b.tuitionMinor };
}

/** The session the dashboard shows in the 'in-class' state, honouring the user's choice among overlaps. */
export function shownView(model: DashboardModel, selectedId: string | null): SessionView | null {
  if (model.active.length === 0) return null;
  return model.active.find((v) => v.id === selectedId) ?? model.active[0];
}

export function formatMoney(minor: number, currency: CurrencyCode): string {
  return formatMinor(minor, currency);
}

// ------------------------------------------------------------------ text helpers for the views

/** Values for the in-class copy templates ({course} {amount} {rate} {minutes}). */
export function inClassCopyVars(model: DashboardModel, view: SessionView, nowMs: number): Record<string, string | number> {
  const live = liveAt(model, view.id, nowMs);
  return { course: view.label, amount: formatMinor(live.sessionConsumedMinor, model.currency), rate: view.rateText, minutes: Math.floor(live.elapsedSec / 60) };
}

/**
 * One sentence describing the situation for screen readers. The page shows it in an `aria-live="polite"` region that
 * is refreshed at most once a minute (see `minuteBucket`).
 */
export function summaryText(model: DashboardModel, selectedId: string | null, nowMs: number): string {
  const view = shownView(model, selectedId);
  switch (model.kind) {
    case 'in-class': {
      if (!view) return '';
      const live = liveAt(model, view.id, nowMs);
      return t('a11y.inClass', { course: view.label, amount: formatMinor(live.sessionConsumedMinor, model.currency), minutes: Math.ceil(live.remainingSec / 60) });
    }
    case 'break': {
      const live = liveAt(model, model.next?.id ?? null, nowMs);
      return t('a11y.break', { course: model.next?.label ?? '', minutes: Math.ceil(live.countdownSec / 60) });
    }
    case 'done-today':
      return t('a11y.doneToday', { amount: formatMinor(model.todaySpentMinor, model.currency) });
    case 'no-class-today':
      return t('a11y.noClassToday');
    case 'before-term':
      return t('a11y.beforeTerm', { days: model.daysUntilTerm ?? 0 });
    default:
      return t('a11y.afterTerm');
  }
}
