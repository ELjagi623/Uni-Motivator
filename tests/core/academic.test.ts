import { describe, expect, it } from 'vitest';
import {
  academicYearOf,
  checkSplitDate,
  formatMonthDay,
  groupByPool,
  parseMonthDay,
  poolKeyOf,
  semesterOf,
  splitDateMs,
  termOf,
} from '../../src/core/academic';
import type { AcademicConfig, Session } from '../../src/core/types';
import { at, fixtureSessions, NORTHERN, NORTHERN_YEAR, SOUTHERN } from './helpers';

const session = (id: string, start: string, end: string): Session => ({ id, uid: id, title: id, location: '', startMs: at(start), endMs: at(end) });

describe('parseMonthDay', () => {
  it('parses valid values and rejects invalid ones', () => {
    expect(parseMonthDay('08-01')).toEqual({ month: 8, day: 1 });
    expect(parseMonthDay('2-29')).toEqual({ month: 2, day: 29 });
    for (const bad of ['13-01', '02-30', 'abc', '1201', '00-10', '08-00', '']) expect(() => parseMonthDay(bad), bad).toThrow();
    expect(formatMonthDay(1, 5)).toBe('01-05');
  });
});

describe('academic year and semester (northern preset 08-01 / 12-25)', () => {
  it('assigns academic years by the year start date', () => {
    expect(academicYearOf(at('2026-07-31T23:59:00+08:00'), NORTHERN)).toBe(2025);
    expect(academicYearOf(at('2026-08-01T00:00:00+08:00'), NORTHERN)).toBe(2026);
    expect(academicYearOf(at('2027-01-15T10:00:00+08:00'), NORTHERN)).toBe(2026);
  });

  it('a session starting at 00:00 local on the split date belongs to semester 2, the previous day to semester 1', () => {
    expect(semesterOf(at('2026-12-25T00:00:00+08:00'), NORTHERN)).toBe(2);
    expect(semesterOf(at('2026-12-24T23:59:59+08:00'), NORTHERN)).toBe(1);
    expect(semesterOf(at('2026-12-24T09:00:00+08:00'), NORTHERN)).toBe(1);
    expect(semesterOf(at('2027-02-01T09:00:00+08:00'), NORTHERN)).toBe(2);
  });

  it('a session that spans the split date is assigned by its start time', () => {
    const night = session('night', '2026-12-24T23:00:00+08:00', '2026-12-25T01:00:00+08:00');
    expect(termOf(night.startMs, NORTHERN)).toEqual({ year: 2026, semester: 1 });
    const next = session('next', '2026-12-25T00:00:00+08:00', '2026-12-25T02:00:00+08:00');
    expect(termOf(next.startMs, NORTHERN)).toEqual({ year: 2026, semester: 2 });
  });

  it('builds pool keys for semester and year billing', () => {
    expect(poolKeyOf(at('2026-10-01T09:00:00+08:00'), NORTHERN)).toBe('2026-S1');
    expect(poolKeyOf(at('2027-03-01T09:00:00+08:00'), NORTHERN)).toBe('2026-S2');
    expect(poolKeyOf(at('2027-03-01T09:00:00+08:00'), NORTHERN_YEAR)).toBe('2026');
  });
});

describe('southern preset (01-01 / 07-01)', () => {
  it('assigns years and semesters', () => {
    expect(termOf(at('2027-06-30T09:00:00+08:00'), SOUTHERN)).toEqual({ year: 2027, semester: 1 });
    expect(termOf(at('2027-07-01T00:00:00+08:00'), SOUTHERN)).toEqual({ year: 2027, semester: 2 });
    expect(termOf(at('2026-12-31T23:00:00+08:00'), SOUTHERN)).toEqual({ year: 2026, semester: 2 });
    expect(termOf(at('2027-01-01T00:00:00+08:00'), SOUTHERN)).toEqual({ year: 2027, semester: 1 });
  });
});

describe('a split date earlier in the calendar than the year start belongs to the next calendar year', () => {
  const cfg: AcademicConfig = { yearStart: '09-01', splitDate: '01-15', billingPeriod: 'semester' };
  it('uses January of the following calendar year', () => {
    expect(splitDateMs(2026, cfg)).toBe(new Date(2027, 0, 15).getTime());
    expect(termOf(at('2027-01-14T10:00:00+08:00'), cfg)).toEqual({ year: 2026, semester: 1 });
    expect(termOf(at('2027-01-15T00:00:00+08:00'), cfg)).toEqual({ year: 2026, semester: 2 });
    expect(termOf(at('2026-10-01T10:00:00+08:00'), cfg)).toEqual({ year: 2026, semester: 1 });
  });
});

describe('groupByPool', () => {
  it('puts every session of the full-term calendar into exactly one pool', () => {
    const sessions = fixtureSessions('full-term.ics');
    const pools = groupByPool(sessions, NORTHERN);
    expect([...pools.keys()].sort()).toEqual(['2026-S1', '2026-S2']);
    expect(pools.get('2026-S1')).toHaveLength(29);
    expect(pools.get('2026-S2')).toHaveLength(29);
    const all = [...pools.values()].flat();
    expect(all).toHaveLength(sessions.length);
    expect(new Set(all.map((s) => s.id)).size).toBe(sessions.length);
    for (const list of pools.values()) expect(list.map((s) => s.startMs)).toEqual([...list.map((s) => s.startMs)].sort((a, b) => a - b));
  });

  it('year billing gives a single pool', () => {
    const pools = groupByPool(fixtureSessions('full-term.ics'), NORTHERN_YEAR);
    expect([...pools.keys()]).toEqual(['2026']);
    expect(pools.get('2026')).toHaveLength(58);
  });
});

describe('checkSplitDate', () => {
  const term = fixtureSessions('full-term.ics');

  it('gives no suggestion when the split date lies inside the winter break', () => {
    const [r] = checkSplitDate(term, NORTHERN);
    expect(r.status).toBe('ok');
    expect(r.suggestedSplit).toBeUndefined();
    expect(r.year).toBe(2026);
    // The longest gap runs from the last class of semester 1 to the first class of semester 2.
    expect(r.gapFromMs).toBe(at('2026-12-14T12:00:00+08:00'));
    expect(r.gapToMs).toBe(at('2027-01-18T09:00:00+08:00'));
  });

  it('suggests the middle of the longest gap when the split date falls inside a semester', () => {
    const [r] = checkSplitDate(term, { ...NORTHERN, splitDate: '11-01' });
    expect(r.status).toBe('suggest');
    // 14 Dec 12:00 -> 18 Jan 09:00 has its middle at 31 Dec 22:30.
    expect(r.suggestedSplit).toBe('12-31');
    // Taking the suggestion makes the check pass.
    expect(checkSplitDate(term, { ...NORTHERN, splitDate: r.suggestedSplit! })[0].status).toBe('ok');
  });

  it('also catches a split date that lies in the middle of the second semester', () => {
    const [r] = checkSplitDate(term, { ...NORTHERN, splitDate: '03-01' });
    expect(r.status).toBe('suggest');
    expect(r.suggestedSplit).toBe('12-31');
  });

  it('reports a year whose sessions all sit on one side of the split date as a single semester (no suggestion)', () => {
    const results = checkSplitDate(term, SOUTHERN);
    expect(results.map((r) => [r.year, r.status])).toEqual([
      [2026, 'single-semester'],
      [2027, 'single-semester'],
    ]);
    expect(results.every((r) => r.suggestedSplit === undefined)).toBe(true);
  });

  it('reports no-gap for years with fewer than two sessions or only touching sessions', () => {
    expect(checkSplitDate([session('a', '2026-10-01T09:00:00+08:00', '2026-10-01T10:00:00+08:00')], NORTHERN)[0].status).toBe('no-gap');
    expect(checkSplitDate([], NORTHERN)).toEqual([]);
    const touching = [session('a', '2026-10-01T09:00:00+08:00', '2026-10-01T10:00:00+08:00'), session('b', '2026-10-01T10:00:00+08:00', '2026-10-01T11:00:00+08:00')];
    expect(checkSplitDate(touching, NORTHERN)[0].status).toBe('no-gap');
  });

  it('works per academic year', () => {
    const y1 = [session('a', '2026-10-01T09:00:00+08:00', '2026-10-01T10:00:00+08:00'), session('b', '2027-02-01T09:00:00+08:00', '2027-02-01T10:00:00+08:00')];
    const y2 = [session('c', '2027-10-01T09:00:00+08:00', '2027-10-01T10:00:00+08:00'), session('d', '2028-02-01T09:00:00+08:00', '2028-02-01T10:00:00+08:00')];
    const results = checkSplitDate([...y1, ...y2], NORTHERN);
    expect(results.map((r) => [r.year, r.status])).toEqual([
      [2026, 'ok'],
      [2027, 'ok'],
    ]);
  });

  it('handles a long session that overlaps later ones when measuring gaps', () => {
    const list = [
      session('long', '2026-09-01T09:00:00+08:00', '2026-12-30T09:00:00+08:00'), // swallows everything until 30 Dec
      session('mid', '2026-10-01T09:00:00+08:00', '2026-10-01T10:00:00+08:00'),
      session('late', '2027-02-01T09:00:00+08:00', '2027-02-01T10:00:00+08:00'),
    ];
    const [r] = checkSplitDate(list, NORTHERN); // split 25 Dec is before the long session ends -> not in the gap
    expect(r.status).toBe('suggest');
    expect(r.gapFromMs).toBe(at('2026-12-30T09:00:00+08:00'));
  });
});
