import { describe, expect, it } from 'vitest';
import { assignCourses } from '../../src/core/courses';
import { buildPools, billingStateAt } from '../../src/core/billing';
import { expandManual, expandSingle, expandWeekly, isValidTimeZone, manualFromDoc, manualSessionId, parseDate, parseTime, validateSingle, validateWeekly, wallToUtc, type ManualWeekly } from '../../src/core/manual';
import type { Course } from '../../src/core/types';
import { NORTHERN, at, iso } from './helpers';

// Tuesdays 14:00-17:00 from 2026-09-08 to 2026-12-01, except 2026-10-06 (Hong Kong time; the tests run in Asia/Hong_Kong).
const weekly: ManualWeekly = {
  id: 'w1',
  courseId: 'c-manual',
  title: 'Seminar',
  weekday: 2,
  start: '14:00',
  end: '17:00',
  fromDate: '2026-09-08',
  toDate: '2026-12-01',
  skipDates: ['2026-10-06'],
};
// Hand-made list: Sep 8, 15, 22, 29, (Oct 6 skipped), Oct 13, 20, 27, Nov 3, 10, 17, 24, Dec 1
const EXPECTED_DAYS = ['2026-09-08', '2026-09-15', '2026-09-22', '2026-09-29', '2026-10-13', '2026-10-20', '2026-10-27', '2026-11-03', '2026-11-10', '2026-11-17', '2026-11-24', '2026-12-01'];

describe('manual classes: a weekly arrangement', () => {
  const sessions = expandWeekly(weekly);

  it('every Tuesday 14:00-17:00 from 09-08 to 12-01 without 10-06 gives 12 classes at the hand-computed times', () => {
    expect(sessions).toHaveLength(12);
    expect(sessions.map((s) => s.startMs)).toEqual(EXPECTED_DAYS.map((d) => at(`${d}T14:00:00+08:00`)));
    expect(sessions.map((s) => s.endMs)).toEqual(EXPECTED_DAYS.map((d) => at(`${d}T17:00:00+08:00`)));
    expect(sessions.some((s) => iso(s.startMs).startsWith('2026-10-06'))).toBe(false);
  });

  it('they are manual classes: source "manual", ids start with "manual:", the id is the course and the start in UTC', () => {
    for (const s of sessions) {
      expect(s.source).toBe('manual');
      expect(s.id.startsWith('manual:')).toBe(true);
      expect(s.courseId).toBe('c-manual');
    }
    expect(sessions[0].id).toBe('manual:c-manual|2026-09-08T06:00:00Z');
    expect(manualSessionId('c-manual', at('2026-09-08T14:00:00+08:00'))).toBe(sessions[0].id);
  });

  it('the end date is inclusive, a range with no matching weekday is refused, and the skip list may hold dates outside the range', () => {
    expect(expandWeekly({ ...weekly, fromDate: '2026-09-09', toDate: '2026-09-14' })).toEqual([]);
    expect(validateWeekly({ ...weekly, fromDate: '2026-09-09', toDate: '2026-09-14' })).toContain('range');
    expect(expandWeekly({ ...weekly, skipDates: ['2026-01-01'] })).toHaveLength(13);
  });

  it('validates the input: empty name, bad weekday, bad / reversed times, bad dates, reversed range, unknown zone, too many weeks', () => {
    expect(validateWeekly(weekly)).toEqual([]);
    expect(validateWeekly({ ...weekly, title: '  ' })).toContain('title');
    expect(validateWeekly({ ...weekly, weekday: 7 })).toContain('weekday');
    expect(validateWeekly({ ...weekly, start: '9:00' })).toContain('time');
    expect(validateWeekly({ ...weekly, start: '17:00', end: '14:00' })).toContain('order');
    expect(validateWeekly({ ...weekly, fromDate: '2026-02-30' })).toContain('date');
    expect(validateWeekly({ ...weekly, skipDates: ['x'] })).toContain('date');
    expect(validateWeekly({ ...weekly, fromDate: '2026-12-02', toDate: '2026-09-01' })).toContain('range');
    expect(validateWeekly({ ...weekly, timeZone: 'Mars/Base' })).toContain('zone');
    expect(validateWeekly({ ...weekly, fromDate: '2020-01-01', toDate: '2029-12-31' })).toContain('too-many');
  });

  it('a time zone makes the wall-clock times that zone\'s: 14:00 in London in summer is 13:00 UTC; in winter 14:00 UTC', () => {
    const london = expandWeekly({ ...weekly, timeZone: 'Europe/London', fromDate: '2026-09-08', toDate: '2026-11-10', skipDates: [] });
    expect(iso(london[0].startMs)).toBe('2026-09-08T13:00:00Z'); // BST (UTC+1)
    expect(iso(london[london.length - 1].startMs)).toBe('2026-11-10T14:00:00Z'); // GMT after 10-25
    expect(iso(wallToUtc({ y: 2026, m: 10, d: 25 }, { h: 1, min: 30 }, 'Europe/London'))).toMatch(/^2026-10-25T0[01]:30:00Z$/);
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('Nope')).toBe(false);
  });
});

describe('manual classes: one-off make-up classes and parsing', () => {
  it('a single class expands to one session on that day; bad input gives none', () => {
    const s = expandSingle({ id: 's1', courseId: 'c1', title: 'Make-up', date: '2026-11-14', start: '10:00', end: '12:30' })!;
    expect(s.startMs).toBe(at('2026-11-14T10:00:00+08:00'));
    expect(s.endMs).toBe(at('2026-11-14T12:30:00+08:00'));
    expect(s.id).toBe('manual:c1|2026-11-14T02:00:00Z');
    expect(expandSingle({ id: 's', courseId: 'c', title: 'x', date: 'bad', start: '10:00', end: '11:00' })).toBeNull();
    expect(validateSingle({ title: 'x', courseId: 'c', date: '2026-11-14', start: '11:00', end: '10:00' })).toEqual(['order']);
    expect(validateSingle({ title: '', courseId: 'c', date: '2026-13-01', start: '10:00', end: '11:00' })).toEqual(['title', 'date']);
  });

  it('expandManual sorts by start and a class two definitions both give appears once', () => {
    const doc = { weekly: [weekly], singles: [{ id: 's1', courseId: 'c-manual', title: 'Seminar', date: '2026-09-08', start: '14:00', end: '17:00' }, { id: 's2', courseId: 'c-manual', title: 'Seminar', date: '2026-09-01', start: '09:00', end: '10:00' }] };
    const all = expandManual(doc);
    expect(all).toHaveLength(13);
    expect(all[0].startMs).toBe(at('2026-09-01T09:00:00+08:00'));
    expect(all.map((s) => s.startMs)).toEqual([...all.map((s) => s.startMs)].sort((a, b) => a - b));
  });

  it('reads the stored part leniently: junk entries are dropped, nothing throws', () => {
    expect(manualFromDoc(undefined)).toEqual({ weekly: [], singles: [] });
    expect(manualFromDoc('x')).toEqual({ weekly: [], singles: [] });
    const m = manualFromDoc({ weekly: [{ id: 'a', courseId: 'c', title: 't', weekday: 1, start: '09:00', end: '10:00', fromDate: '2026-09-07', toDate: '2026-09-14', skipDates: ['2026-09-14', 5] }, 7, { id: '' }], singles: [null, { id: 's', courseId: 'c', date: '2026-09-07', start: '09:00', end: '10:00' }] });
    expect(m.weekly).toHaveLength(1);
    expect(m.weekly[0].skipDates).toEqual(['2026-09-14']);
    expect(m.singles).toHaveLength(1);
    expect(parseDate('2026-02-29')).toBeNull();
    expect(parseTime('24:00')).toBeNull();
    expect(parseTime('23:59')).toEqual({ h: 23, min: 59 });
  });
});

describe('manual classes in billing', () => {
  const course: Course = { id: 'c-manual', code: null, name: 'Seminar', credits: null, color: '', match: { codes: [], titles: [] }, manual: true };

  it('a manual session is matched to its course by id (no title match needed) and is billed like any other class', () => {
    const sessions = expandWeekly(weekly);
    const assigned = assignCourses(sessions, [course]);
    expect(assigned.size).toBe(12);
    const pools = buildPools(sessions.map((s) => ({ ...s, courseId: course.id })), { academic: NORTHERN, tuition: { defaultMinor: 120_000 } });
    expect(pools[0].sessions.map((s) => s.costMinor)).toEqual(Array(12).fill(10_000)); // 1,200.00 over 12 identical classes
  });

  it('consumed + remaining equals the tuition at every instant for a mix of manual and other classes', () => {
    const cal = [{ id: 'cal|1', startMs: at('2026-09-01T09:00:00+08:00'), endMs: at('2026-09-01T11:30:00+08:00') }, { id: 'cal|2', startMs: at('2026-11-30T09:00:00+08:00'), endMs: at('2026-11-30T12:00:00+08:00') }];
    const all = [...cal, ...expandWeekly(weekly)];
    const pools = buildPools(all, { academic: NORTHERN, tuition: { defaultMinor: 398_000_00 } });
    for (let i = 0; i < 400; i++) {
      const now = at('2026-08-30T00:00:00+08:00') + i * 17_000_000;
      const st = billingStateAt(pools, now);
      expect(st.consumedMinor + st.remainingMinor).toBe(st.tuitionMinor);
    }
  });
});
