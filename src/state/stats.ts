// The statistics page's model: core's numbers (`computeStats`, `periodSummary`) formatted as text, plus the geometry
// of the two hand-drawn SVG charts (so the page itself does no arithmetic).

import type { Pool } from '../core/billing';
import { formatMinor, type CurrencyCode } from '../core/money';
import { computeStats, historySummary, periodSummary, weekRange, type CourseStat, type PeriodSummary, type StatsInput } from '../core/stats';
import { yearRoleOf, type YearRole } from '../core/years';
import { t } from '../i18n';
import { dateText, minutesOf, type DashboardInputs } from './dashboard';
import { addWeeks, attendanceText, isoWeekNumber, weekStartOf } from './sessions';
import { roleLabel, yearLabel } from './years';

export interface PeriodView {
  /** "本周" / "本学期" / "本学年" */
  label: string;
  spentText: string;
  hoursText: string;
  sessionsText: string;
  attendanceText: string;
  slackText: string;
  slackMinor: number;
  costMinor: number;
}

export interface CourseRow {
  courseId: string;
  label: string;
  /** The course name without the course code in front of it (empty when that leaves nothing). */
  subtitle: string;
  costText: string;
  perHourText: string;
  attendanceText: string;
  slackText: string;
  costMinor: number;
  /** Bar geometry inside the chart (viewBox units). */
  barY: number;
  barWidth: number;
}

export interface HighlightView {
  courseLabel: string;
  dateText: string;
  costText: string;
  slackText: string;
}

export interface SlackView {
  hasSlack: boolean;
  totalText: string;
  rateText: string;
  favouriteText: string;
  longestText: string;
}

export interface WeeklyBar {
  key: number;
  x: number;
  width: number;
  /** Whole bar (the week's cost). */
  y: number;
  height: number;
  /** The slack part, drawn over the bottom of the bar. */
  slackY: number;
  slackHeight: number;
  /** The label under the bar (every few weeks), or ''. */
  tick: string;
  title: string;
}

/** One line of the multi-year history: an academic year, or the total over all of them. */
export interface HistoryRow {
  /** The academic year; null for the total row. */
  year: number | null;
  label: string;
  role: YearRole | null;
  roleLabel: string;
  costMinor: number;
  costText: string;
  hoursText: string;
  sessionsText: string;
  attendanceText: string;
  slackText: string;
}

export interface HistoryView {
  rows: HistoryRow[];
  total: HistoryRow;
}

export interface StatsModel {
  /** False until a class has ended. */
  hasData: boolean;
  week: PeriodView;
  semester: PeriodView | null;
  /** "本学期" / "本学年" (empty when there is no pool yet). */
  semesterLabel: string;
  courses: CourseRow[];
  coursesChart: { width: number; height: number; labelWidth: number };
  expensive: HighlightView | null;
  lossy: HighlightView | null;
  slack: SlackView;
  weekly: { width: number; height: number; baseline: number; bars: WeeklyBar[] };
  currency: CurrencyCode;
  /** Per-year history and its total; null while the timetable covers a single academic year. */
  history: HistoryView | null;
}

export const COURSE_CHART = { width: 600, rowHeight: 34, labelWidth: 150, barMax: 330, barHeight: 14 } as const;
export const WEEKLY_CHART = { width: 600, height: 190, top: 14, bottom: 30, maxWeeks: 26 } as const;

const rate1 = (r: number | null): string => (r === null ? t('sessions.noValue') : `${(r * 100).toFixed(1)}%`);

function periodView(label: string, p: PeriodSummary, currency: CurrencyCode): PeriodView {
  return {
    label,
    spentText: formatMinor(p.costMinor, currency),
    hoursText: t('stats.hoursValue', { n: p.hours.toFixed(1) }),
    sessionsText: t('stats.sessionsValue', { n: p.sessionCount }),
    attendanceText: attendanceText(p.attendanceRate),
    slackText: t('stats.slackValue', { minutes: minutesOf(p.slackSeconds), amount: formatMinor(p.slackMinor, currency) }),
    slackMinor: p.slackMinor,
    costMinor: p.costMinor,
  };
}

function statsInputOf(inputs: DashboardInputs, nowMs: number): StatsInput {
  return { sessions: inputs.sessions, pools: inputs.pools, courses: inputs.courses, marks: inputs.marks, slacks: inputs.slacks, nowMs };
}

/** The tuition pool "this semester" means at `nowMs`: the one in progress, else the latest one that has started. */
export function currentPool(pools: readonly Pool[], nowMs: number): Pool | null {
  let chosen: Pool | null = null;
  for (const p of pools) if (p.firstStartMs <= nowMs) chosen = p;
  return chosen;
}

export function courseLabelOf(c: Pick<CourseStat, 'code' | 'name'>): string {
  return c.code ?? c.name;
}

function historyRowOf(label: string, year: number | null, role: YearRole | null, p: Omit<PeriodSummary, 'fromMs' | 'toMs'>, currency: CurrencyCode): HistoryRow {
  return {
    year,
    label,
    role,
    roleLabel: role ? roleLabel(role) : '',
    costMinor: p.costMinor,
    costText: formatMinor(p.costMinor, currency),
    hoursText: t('stats.hoursValue', { n: p.hours.toFixed(1) }),
    sessionsText: t('stats.sessionsValue', { n: p.sessionCount }),
    attendanceText: attendanceText(p.attendanceRate),
    slackText: p.slackMinor > 0 ? t('stats.slackValue', { minutes: minutesOf(p.slackSeconds), amount: formatMinor(p.slackMinor, currency) }) : t('sessions.noValue'),
  };
}

/** The history of every academic year and its total (core `historySummary`); null with fewer than two years. */
export function buildHistory(inputs: DashboardInputs, nowMs: number): HistoryView | null {
  if (!inputs.academic) return null;
  const h = historySummary(statsInputOf(inputs, nowMs), inputs.academic);
  if (h.years.length < 2) return null;
  const rows = h.years.map((y) => historyRowOf(yearLabel(y.year), y.year, yearRoleOf(y.year, nowMs, inputs.academic!), y, inputs.currency));
  return { rows, total: historyRowOf(t('stats.history.total'), null, null, h.total, inputs.currency) };
}

export function buildStatsModel(inputs: DashboardInputs, nowMs: number): StatsModel {
  const si = statsInputOf(inputs, nowMs);
  const stats = computeStats(si);
  const currency = inputs.currency;
  const hasData = stats.courses.length > 0;

  const wk = weekRange(nowMs);
  const week = periodView(t('stats.week'), periodSummary(si, wk.fromMs, wk.toMs), currency);

  const pool = currentPool(inputs.pools, nowMs);
  let semester: PeriodView | null = null;
  if (pool) {
    const ids = new Set(pool.sessions.map((s) => s.id));
    const sub: StatsInput = { ...si, sessions: si.sessions.filter((s) => ids.has(s.id)) };
    semester = periodView(pool.semester === null ? t('stats.year') : t('stats.semester'), periodSummary(sub, 0, Number.MAX_SAFE_INTEGER), currency);
  }

  // Chart 1: the courses, one bar each, scaled to the dearest course.
  const top = Math.max(1, ...stats.courses.map((c) => c.totalCostMinor));
  const courses: CourseRow[] = stats.courses.map((c, i) => ({
    courseId: c.courseId,
    label: courseLabelOf(c),
    subtitle: c.code && c.name.includes(c.code) ? c.name.replace(c.code, '').trim() : c.name === courseLabelOf(c) ? '' : c.name,
    costText: formatMinor(c.totalCostMinor, currency),
    perHourText: t('stats.perHour', { amount: formatMinor(c.costPerHourMinor, currency) }),
    attendanceText: attendanceText(c.attendanceRate),
    slackText: c.slackSeconds > 0 ? t('stats.slackValue', { minutes: minutesOf(c.slackSeconds), amount: formatMinor(c.slackMinor, currency) }) : t('sessions.noValue'),
    costMinor: c.totalCostMinor,
    barY: i * COURSE_CHART.rowHeight + 10,
    barWidth: Math.max(2, (c.totalCostMinor / top) * COURSE_CHART.barMax),
  }));

  const courseById = new Map(inputs.courses.map((c) => [c.id, c]));
  const highlight = (s: { courseId: string; startMs: number; costMinor: number; slackSeconds: number; slackMinor: number } | null): HighlightView | null => {
    if (!s) return null;
    const course = courseById.get(s.courseId);
    return {
      courseLabel: course ? courseLabelOf(course) : '',
      dateText: dateText(s.startMs),
      costText: formatMinor(s.costMinor, currency),
      slackText: s.slackSeconds > 0 ? t('stats.slackValue', { minutes: minutesOf(s.slackSeconds), amount: formatMinor(s.slackMinor, currency) }) : t('sessions.noValue'),
    };
  };

  const fav = stats.slack.favouriteCourse;
  const longest = stats.slack.longest;
  const slack: SlackView = {
    hasSlack: stats.slack.recordCount > 0,
    totalText: formatMinor(stats.slack.totalMinor, currency),
    rateText: rate1(stats.slack.slackRate),
    favouriteText: fav ? `${courseLabelOf(courseById.get(fav.courseId) ?? { code: null, name: '' })} · ${t('stats.slackValue', { minutes: minutesOf(fav.seconds), amount: formatMinor(fav.minor, currency) })}` : t('sessions.noValue'),
    longestText: longest
      ? `${courseLabelOf(courseById.get(longest.courseId) ?? { code: null, name: '' })} · ${t('stats.slackValue', { minutes: minutesOf(longest.seconds), amount: formatMinor(longest.minor, currency) })}`
      : t('sessions.noValue'),
  };

  // Chart 2: the cost of each week (up to the last 26), with the slack part highlighted.
  const ended = inputs.sessions.filter((s) => s.endMs <= nowMs);
  const bars: WeeklyBar[] = [];
  const baseline = WEEKLY_CHART.height - WEEKLY_CHART.bottom;
  if (ended.length > 0) {
    const first = weekStartOf(Math.min(...ended.map((s) => s.startMs)));
    const last = weekStartOf(nowMs);
    let starts: number[] = [];
    for (let w = first; w <= last && starts.length < 200; w = addWeeks(w, 1)) starts.push(w);
    starts = starts.slice(-WEEKLY_CHART.maxWeeks);
    const sums = starts.map((from) => periodSummary(si, from, addWeeks(from, 1)));
    const max = Math.max(1, ...sums.map((p) => p.costMinor));
    const slot = WEEKLY_CHART.width / Math.max(starts.length, 1);
    const plotHeight = baseline - WEEKLY_CHART.top;
    const every = Math.max(1, Math.ceil(starts.length / 8));
    starts.forEach((from, i) => {
      const p = sums[i];
      const h = p.costMinor > 0 ? Math.max(2, (p.costMinor / max) * plotHeight) : 0;
      const sh = p.slackMinor > 0 && p.costMinor > 0 ? Math.min(h, Math.max(2, (p.slackMinor / max) * plotHeight)) : 0;
      bars.push({
        key: from,
        x: i * slot + slot * 0.15,
        width: slot * 0.7,
        y: baseline - h,
        height: h,
        slackY: baseline - sh,
        slackHeight: sh,
        tick: i % every === 0 ? t('stats.weekTick', { n: isoWeekNumber(from) }) : '',
        title: `${t('stats.weekTick', { n: isoWeekNumber(from) })} · ${formatMinor(p.costMinor, currency)}${p.slackMinor > 0 ? ` · ${t('stats.legendSlack')} ${formatMinor(p.slackMinor, currency)}` : ''}`,
      });
    });
  }

  return {
    hasData,
    week,
    semester,
    semesterLabel: semester?.label ?? '',
    courses,
    coursesChart: { width: COURSE_CHART.width, height: Math.max(courses.length, 1) * COURSE_CHART.rowHeight + 6, labelWidth: COURSE_CHART.labelWidth },
    expensive: highlight(stats.mostExpensive),
    lossy: highlight(stats.mostLossy),
    slack,
    weekly: { width: WEEKLY_CHART.width, height: WEEKLY_CHART.height, baseline, bars },
    currency,
    history: buildHistory(inputs, nowMs),
  };
}
