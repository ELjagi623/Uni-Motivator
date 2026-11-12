import { describe, expect, it } from 'vitest';
import { buildPools } from '../../src/core/billing';
import { historySummary, periodSummary, type StatsInput, type StatsSession } from '../../src/core/stats';
import type { Course, MarkMap, SlackRecord } from '../../src/core/types';
import { academicYearsOf, focusYearOf, isSessionArchived, sessionsOfYear, yearRoleOf, yearStartMs } from '../../src/core/years';
import { NORTHERN, SOUTHERN, at } from './helpers';

// Two academic years (year starts 08-01): 2025 has two classes (Oct 2025), 2026 has three (Sep and Nov 2026).
const mk = (id: string, day: string, hours: number, courseId = 'A'): StatsSession => ({
  id,
  courseId,
  startMs: at(`${day}T09:00:00+08:00`),
  endMs: at(`${day}T09:00:00+08:00`) + hours * 3_600_000,
});
const y25 = [mk('o1', '2025-10-06', 2), mk('o2', '2025-10-13', 2)];
const y26 = [mk('n1', '2026-09-07', 3), mk('n2', '2026-09-14', 3), mk('n3', '2026-11-02', 1)];
const all = [...y25, ...y26];

describe('years: which academic years exist and what role each has', () => {
  it('lists the years that have sessions, oldest first, with counts and hours', () => {
    const years = academicYearsOf(all, NORTHERN, at('2026-10-01T10:00:00+08:00'));
    expect(years.map((y) => y.year)).toEqual([2025, 2026]);
    expect(years[0]).toMatchObject({ sessionCount: 2, totalSeconds: 4 * 3600, firstStartMs: y25[0].startMs, lastEndMs: y25[1].endMs });
    expect(years[1]).toMatchObject({ sessionCount: 3, totalSeconds: 7 * 3600 });
    expect(years[0].fromMs).toBe(yearStartMs(2025, NORTHERN));
    expect(years[0].toMs).toBe(years[1].fromMs);
  });

  it('now in the new year: the new year is current, the old year is an archive', () => {
    const years = academicYearsOf(all, NORTHERN, at('2026-10-01T10:00:00+08:00'));
    expect(years.map((y) => y.role)).toEqual(['archived', 'current']);
    expect(focusYearOf(years)).toBe(2026);
    expect(isSessionArchived(y25[0].startMs, at('2026-10-01T10:00:00+08:00'), NORTHERN)).toBe(true);
    expect(isSessionArchived(y26[0].startMs, at('2026-10-01T10:00:00+08:00'), NORTHERN)).toBe(false);
  });

  it('now in the old year: the old year is current and the new one is upcoming (not archived)', () => {
    const now = at('2025-11-20T10:00:00+08:00');
    const years = academicYearsOf(all, NORTHERN, now);
    expect(years.map((y) => y.role)).toEqual(['current', 'upcoming']);
    expect(focusYearOf(years)).toBe(2025);
    expect(isSessionArchived(y26[0].startMs, now, NORTHERN)).toBe(false);
    expect(isSessionArchived(y25[0].startMs, now, NORTHERN)).toBe(false);
  });

  it('the year turns over at the year start day (local midnight): 07-31 23:59 is still the old year, 08-01 00:00 is the new one', () => {
    expect(yearRoleOf(2025, at('2026-07-31T23:59:59+08:00'), NORTHERN)).toBe('current');
    expect(yearRoleOf(2025, at('2026-08-01T00:00:00+08:00'), NORTHERN)).toBe('archived');
    expect(yearRoleOf(2026, at('2026-08-01T00:00:00+08:00'), NORTHERN)).toBe('current');
  });

  it('the focus year: nearest upcoming year before the term starts, the latest archive after everything is over', () => {
    expect(focusYearOf(academicYearsOf(y26, NORTHERN, at('2026-07-01T10:00:00+08:00')))).toBe(2026); // before the year even starts
    expect(focusYearOf(academicYearsOf(all, NORTHERN, at('2027-09-01T10:00:00+08:00')))).toBe(2026); // the newest archive
    expect(focusYearOf([])).toBeNull();
  });

  it('works for the southern hemisphere (year = calendar year) and ignores empty sessions', () => {
    const s = [mk('s1', '2026-03-02', 2), mk('s2', '2027-03-01', 2), { id: 'zero', courseId: 'A', startMs: 5, endMs: 5 }];
    const years = academicYearsOf(s, SOUTHERN, at('2027-03-10T10:00:00+08:00'));
    expect(years.map((y) => [y.year, y.role])).toEqual([
      [2026, 'archived'],
      [2027, 'current'],
    ]);
  });

  it('sessionsOfYear picks the sessions of one year', () => {
    expect(sessionsOfYear(all, 2025, NORTHERN).map((s) => s.id)).toEqual(['o1', 'o2']);
    expect(sessionsOfYear(all, 2026, NORTHERN).map((s) => s.id)).toEqual(['n1', 'n2', 'n3']);
  });
});

describe('history over several academic years', () => {
  const courses: Course[] = [{ id: 'A', code: 'AAAA1000', name: 'Algebra', credits: null, color: '', match: { codes: ['AAAA1000'], titles: [] } }];
  // tuition 400.00 per semester pool; the 2025 pool (4 h) and the 2026 S1 pool (7 h)
  const pools = buildPools(all, { academic: NORTHERN, tuition: { defaultMinor: 40_000 } });
  const marks: MarkMap = { o2: { status: 'skipped' }, n3: { status: 'cancelled' } };
  const slacks: SlackRecord[] = [
    { id: 'r1', sessionId: 'o1', startMs: y25[0].startMs, endMs: y25[0].startMs + 30 * 60_000 },
    { id: 'r2', sessionId: 'n1', startMs: y26[0].startMs, endMs: y26[0].startMs + 15 * 60_000 },
  ];
  const input = (nowMs: number): StatsInput => ({ sessions: all, pools, courses, marks, slacks, nowMs });
  const NOW = at('2026-12-01T00:00:00+08:00');

  it('the total equals the sum of the years, and equals the one-pass summary of everything', () => {
    const h = historySummary(input(NOW), NORTHERN);
    expect(h.years.map((y) => y.year)).toEqual([2025, 2026]);
    const sum = (f: (y: (typeof h.years)[number]) => number) => h.years.reduce((a, y) => a + f(y), 0);
    expect(h.total.costMinor).toBe(sum((y) => y.costMinor));
    expect(h.total.slackMinor).toBe(sum((y) => y.slackMinor));
    expect(h.total.slackSeconds).toBe(sum((y) => y.slackSeconds));
    expect(h.total.sessionCount).toBe(sum((y) => y.sessionCount));
    expect(h.total.hours).toBeCloseTo(sum((y) => y.hours), 10);
    const direct = periodSummary(input(NOW), 0, Number.MAX_SAFE_INTEGER);
    expect(h.total).toMatchObject({ costMinor: direct.costMinor, sessionCount: direct.sessionCount, slackMinor: direct.slackMinor, slackSeconds: direct.slackSeconds, attendedCount: direct.attendedCount, countedSessions: direct.countedSessions });
    expect(h.total.attendanceRate).toBe(direct.attendanceRate);
  });

  it('per-year figures match the hand calculation (the 2025 pool: 400.00 over 4 h = 100.00 per hour)', () => {
    const h = historySummary(input(NOW), NORTHERN);
    const [a, b] = h.years;
    expect(a).toMatchObject({ year: 2025, sessionCount: 2, costMinor: 40_000, attendedCount: 1, countedSessions: 2, attendanceRate: 0.5, slackSeconds: 1800, slackMinor: 5_000 });
    // 2026 S1 pool: 400.00 over 7 h; n1 = 3 h, n2 = 3 h, n3 = 1 h (cancelled by the school: costs money, not an attendance chance)
    expect(b.year).toBe(2026);
    expect(b.sessionCount).toBe(3);
    expect(b.costMinor).toBe(40_000);
    expect(b.countedSessions).toBe(2);
    expect(h.total.costMinor).toBe(80_000);
  });

  it('only classes that have ended count: in the middle of 2026 the later classes are not in the history yet', () => {
    const early = historySummary(input(at('2026-09-07T10:00:00+08:00')), NORTHERN);
    expect(early.years.map((y) => y.year)).toEqual([2025, 2026]);
    expect(early.years[1]).toMatchObject({ sessionCount: 0, costMinor: 0 });
    expect(early.total.costMinor).toBe(40_000);
  });

  it('a single year is its own total; no sessions at all means an empty history', () => {
    const one = historySummary({ ...input(NOW), sessions: y25 }, NORTHERN);
    expect(one.years).toHaveLength(1);
    expect(one.total.costMinor).toBe(one.years[0].costMinor);
    const none = historySummary({ ...input(NOW), sessions: [] }, NORTHERN);
    expect(none.years).toEqual([]);
    expect(none.total).toMatchObject({ costMinor: 0, sessionCount: 0, attendanceRate: null });
  });
});
