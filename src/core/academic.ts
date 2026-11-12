// Academic years, semesters and the split-date sanity check. All day boundaries are local midnights
// (the computer's time zone), because "the day the second semester starts" is a local notion.

import type { AcademicConfig, Session } from './types';

export interface MonthDay {
  month: number; // 1-12
  day: number; // 1-31
}

export function parseMonthDay(text: string): MonthDay {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(text.trim());
  if (!m) throw new Error(`Invalid MM-DD value: ${text}`);
  const month = Number(m[1]);
  const day = Number(m[2]);
  // 2000 is a leap year, so 02-29 is accepted.
  const probe = new Date(2000, month - 1, day);
  if (month < 1 || month > 12 || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
    throw new Error(`Invalid MM-DD value: ${text}`);
  }
  return { month, day };
}

export function formatMonthDay(month: number, day: number): string {
  return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const lessThan = (a: MonthDay, b: MonthDay): boolean => a.month < b.month || (a.month === b.month && a.day < b.day);

/** Academic year label = the calendar year in which the academic year starts. */
export function academicYearOf(ms: number, cfg: AcademicConfig): number {
  const d = new Date(ms);
  const start = parseMonthDay(cfg.yearStart);
  const here: MonthDay = { month: d.getMonth() + 1, day: d.getDate() };
  return lessThan(here, start) ? d.getFullYear() - 1 : d.getFullYear();
}

/**
 * Local midnight (UTC ms) of the split date inside academic year `year`.
 * A split date earlier in the calendar than the year start (e.g. start 09-01, split 01-15) belongs to the next calendar year.
 */
export function splitDateMs(year: number, cfg: AcademicConfig): number {
  const start = parseMonthDay(cfg.yearStart);
  const split = parseMonthDay(cfg.splitDate);
  const calendarYear = lessThan(split, start) ? year + 1 : year;
  return new Date(calendarYear, split.month - 1, split.day).getTime();
}

export function semesterOf(ms: number, cfg: AcademicConfig): 1 | 2 {
  return ms >= splitDateMs(academicYearOf(ms, cfg), cfg) ? 2 : 1;
}

export interface Term {
  year: number;
  semester: 1 | 2;
}

export function termOf(ms: number, cfg: AcademicConfig): Term {
  return { year: academicYearOf(ms, cfg), semester: semesterOf(ms, cfg) };
}

/** Key of the tuition pool a session starting at `ms` belongs to: `2026` (year billing) or `2026-S1` / `2026-S2`. */
export function poolKeyOf(ms: number, cfg: AcademicConfig): string {
  const t = termOf(ms, cfg);
  return cfg.billingPeriod === 'year' ? String(t.year) : `${t.year}-S${t.semester}`;
}

/** Group sessions into pools by their start time. Every session lands in exactly one pool. */
export function groupByPool<T extends { startMs: number; endMs: number }>(sessions: readonly T[], cfg: AcademicConfig): Map<string, T[]> {
  const pools = new Map<string, T[]>();
  for (const s of sessions) {
    const key = poolKeyOf(s.startMs, cfg);
    const list = pools.get(key);
    if (list) list.push(s);
    else pools.set(key, [s]);
  }
  for (const list of pools.values()) list.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return pools;
}

export type SplitCheckStatus =
  | 'ok' // the split date lies inside the longest gap (the winter break)
  | 'suggest' // the split date is outside the longest gap; `suggestedSplit` is the middle of it
  | 'single-semester' // all of the year's sessions are on one side of the split date: nothing to compare
  | 'no-gap'; // fewer than two sessions

export interface SplitCheck {
  year: number;
  status: SplitCheckStatus;
  splitMs: number;
  /** Longest gap between two consecutive sessions of the year (UTC ms). */
  gapFromMs?: number;
  gapToMs?: number;
  /** `MM-DD` in the middle of the longest gap, only when status is "suggest". */
  suggestedSplit?: string;
}

function middleDay(fromMs: number, toMs: number): string {
  const mid = new Date(Math.floor((fromMs + toMs) / 2));
  let midnight = new Date(mid.getFullYear(), mid.getMonth(), mid.getDate());
  if (midnight.getTime() < fromMs) midnight = new Date(mid.getFullYear(), mid.getMonth(), mid.getDate() + 1);
  return formatMonthDay(midnight.getMonth() + 1, midnight.getDate());
}

/**
 * For every academic year that has sessions: is the split date inside the longest gap between sessions?
 * If not, suggest the middle day of that gap.
 */
export function checkSplitDate(sessions: readonly Session[], cfg: AcademicConfig): SplitCheck[] {
  const byYear = new Map<number, Session[]>();
  for (const s of sessions) {
    const y = academicYearOf(s.startMs, cfg);
    const list = byYear.get(y);
    if (list) list.push(s);
    else byYear.set(y, [s]);
  }
  const results: SplitCheck[] = [];
  for (const year of [...byYear.keys()].sort((a, b) => a - b)) {
    const list = byYear.get(year)!.slice().sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    const splitMs = splitDateMs(year, cfg);
    if (list.length < 2) {
      results.push({ year, status: 'no-gap', splitMs });
      continue;
    }
    let bestFrom = 0;
    let bestTo = 0;
    let bestLen = -1;
    let maxEnd = list[0].endMs;
    for (let i = 1; i < list.length; i++) {
      const gap = list[i].startMs - maxEnd;
      if (gap > bestLen) {
        bestLen = gap;
        bestFrom = maxEnd;
        bestTo = list[i].startMs;
      }
      maxEnd = Math.max(maxEnd, list[i].endMs);
    }
    if (bestLen <= 0) {
      results.push({ year, status: 'no-gap', splitMs });
      continue;
    }
    const allBefore = list.every((s) => s.startMs < splitMs);
    const allAfter = list.every((s) => s.startMs >= splitMs);
    if (allBefore || allAfter) {
      results.push({ year, status: 'single-semester', splitMs, gapFromMs: bestFrom, gapToMs: bestTo });
    } else if (bestFrom <= splitMs && splitMs <= bestTo) {
      results.push({ year, status: 'ok', splitMs, gapFromMs: bestFrom, gapToMs: bestTo });
    } else {
      results.push({ year, status: 'suggest', splitMs, gapFromMs: bestFrom, gapToMs: bestTo, suggestedSplit: middleDay(bestFrom, bestTo) });
    }
  }
  return results;
}
