import { describe, expect, it } from 'vitest';
import { findPoolOfSession, getPoolSession, summarizeMarks } from '../../src/core/billing';
import { formatMinor } from '../../src/core/money';
import { addWeeks, buildSessionsModel, isoWeekNumber, lengthText, sessionRowOf, weekStartOf } from '../../src/state/sessions';
import { CLASS_ID, NOWS, fixtureConfig, fullTermText, hk, inputsFor } from './fixture-app';

const inputs = inputsFor(fixtureConfig(), [fullTermText]);
const MON_ID = 'ft-mon-s1@fixture|2026-11-09T01:00:00Z';
const costOf = (id: string) => getPoolSession(findPoolOfSession(inputs.pools, id)!, id)!.costMinor;

describe('sessions: weeks', () => {
  it('weeks run Monday to Sunday in local time and are numbered like ISO 8601 (2026-11-12 is in week 46)', () => {
    const monday = weekStartOf(NOWS.inClass);
    expect(new Date(monday).getDay()).toBe(1);
    expect(monday).toBe(hk('2026-11-09T00:00:00'));
    expect(weekStartOf(hk('2026-11-15T23:59:59'))).toBe(monday); // Sunday
    expect(weekStartOf(hk('2026-11-16T00:00:00'))).toBe(addWeeks(monday, 1));
    expect(addWeeks(monday, -2)).toBe(hk('2026-10-26T00:00:00'));
    expect(isoWeekNumber(monday)).toBe(46);
    expect(isoWeekNumber(hk('2026-12-28T00:00:00'))).toBe(53); // 2026 has 53 ISO weeks
    expect(isoWeekNumber(hk('2027-01-04T00:00:00'))).toBe(1);
  });

  it('shows the week of "now" by default: label, rows in time order, navigation limits', () => {
    const model = buildSessionsModel(inputs, NOWS.inClass, null);
    expect(model.weekLabel).toBe('第 46 周 · 11/09 – 11/15');
    expect(model.isCurrentWeek).toBe(true);
    expect(model.rows.map((r) => r.label)).toEqual(['MFIN7001', 'MFIN7002']);
    expect(model.rows.map((r) => r.phase)).toEqual(['past', 'ongoing']);
    expect(model.canPrev).toBe(true);
    expect(model.canNext).toBe(true);
    expect(model.rows[0].timeText).toBe('09:00–12:00');
    expect(model.rows[0].lengthText).toBe('3 小时');
  });

  it('keeps a requested week inside the span of the calendar', () => {
    const first = buildSessionsModel(inputs, NOWS.inClass, hk('2020-01-06T00:00:00'));
    expect(first.canPrev).toBe(false);
    expect(first.weekStartMs).toBe(hk('2026-08-31T00:00:00'));
    const last = buildSessionsModel(inputs, NOWS.inClass, hk('2030-01-07T00:00:00'));
    expect(last.canNext).toBe(false);
    expect(new Date(last.weekStartMs).getFullYear()).toBe(2027);
    const before = buildSessionsModel(inputs, NOWS.beforeTerm, null); // "now" before the term: the first week
    expect(before.weekStartMs).toBe(hk('2026-08-31T00:00:00'));
  });

  it('an empty calendar gives an empty model', () => {
    const empty = buildSessionsModel({ ...inputs, sessions: [], pools: [] }, NOWS.inClass, null);
    expect(empty.hasSessions).toBe(false);
    expect(empty.rows).toEqual([]);
    expect(empty.summary.attendanceText).toBe('—');
  });
});

describe('sessions: rows', () => {
  const model = buildSessionsModel(inputs, NOWS.inClass, null);

  it('past classes show their full cost, the running one what has burned, future ones a dash', () => {
    const [past, ongoing] = model.rows;
    expect(past.costText).toBe(formatMinor(costOf(MON_ID), 'HKD'));
    expect(ongoing.id).toBe(CLASS_ID);
    expect(ongoing.costText).toBe('HK$2,287.36'); // 30 of 180 minutes of HK$13,724.14, as core rounds it
    const next = buildSessionsModel(inputs, NOWS.inClass, addWeeks(model.weekStartMs, 1));
    expect(next.rows.every((r) => r.phase === 'upcoming' && r.costText === '—')).toBe(true);
  });

  it('shows session i of N and the unit price of the session\'s pool', () => {
    const row = sessionRowOf(inputs, CLASS_ID, NOWS.inClass)!;
    expect(row.ordinal).toEqual({ index: 10, total: 14 });
    expect(row.rateText).toBe('HK$1.2708');
    expect(row.detailTitle).toBe('MFIN7002 · 11/12 10:00');
    expect(sessionRowOf(inputs, 'nope', NOWS.inClass)).toBeNull();
  });

  it('lists the slacking done in a session: minutes and the amount (derived, never stored)', () => {
    const withSlack = {
      ...inputs,
      slacks: [
        { id: 'a', sessionId: MON_ID, startMs: hk('2026-11-09T10:00:00'), endMs: hk('2026-11-09T10:12:00') },
        { id: 'b', sessionId: MON_ID, startMs: hk('2026-11-09T11:00:00'), endMs: hk('2026-11-09T11:00:20') },
      ],
    };
    const row = buildSessionsModel(withSlack, NOWS.inClass, null).rows[0];
    expect(row.slackSeconds).toBe(12 * 60 + 20);
    expect(row.slackText).toBe(`摸鱼 12 分钟 · 浪费 ${formatMinor(row.slackAmountMinor, 'HKD')}`);
    const brief = buildSessionsModel({ ...inputs, slacks: [{ id: 'c', sessionId: MON_ID, startMs: hk('2026-11-09T10:00:00'), endMs: hk('2026-11-09T10:00:30') }] }, NOWS.inClass, null).rows[0];
    expect(brief.slackText).toContain('不到 1 分钟');
    expect(model.rows[0].slackText).toBeNull();
  });

  it('formats class lengths', () => {
    expect(lengthText(3 * 3600)).toBe('3 小时');
    expect(lengthText(5400)).toBe('1.5 小时');
    expect(lengthText(50 * 60)).toBe('50 分钟');
  });
});

describe('sessions: marks and the summary', () => {
  it('counts only classes that have ended; a cancelled class in the future is not swallowed yet', () => {
    const futureThu = inputs.sessions.find((s) => s.startMs > NOWS.inClass)!;
    const marks = { [MON_ID]: { status: 'skipped' as const }, [futureThu.id]: { status: 'cancelled' as const } };
    const nowSummary = buildSessionsModel({ ...inputs, marks }, NOWS.inClass, null).summary;
    expect(nowSummary.skippedMinor).toBe(costOf(MON_ID));
    expect(nowSummary.cancelledMinor).toBe(0);
    const later = buildSessionsModel({ ...inputs, marks }, futureThu.endMs + 1000, null).summary;
    expect(later.cancelledMinor).toBe(costOf(futureThu.id));
    expect(later.cancelledCount).toBe(1);
  });

  it('the three figures are core\'s numbers, formatted', () => {
    const marks = { [MON_ID]: { status: 'skipped' as const }, [CLASS_ID]: { status: 'cancelled' as const } };
    const nowMs = hk('2026-12-01T00:00:00');
    const view = buildSessionsModel({ ...inputs, marks }, nowMs, null).summary;
    const core = summarizeMarks(inputs.pools, marks, { asOfMs: nowMs }).total;
    expect(view.skippedText).toBe(formatMinor(core.skippedMinor, 'HKD'));
    expect(view.cancelledText).toBe(formatMinor(core.cancelledMinor, 'HKD'));
    expect(view.attendanceRate).toBe(core.attendanceRate);
    expect(view.attendanceText).toBe(`${Math.round((core.attendanceRate as number) * 100)}%`);
  });

  it('shows the mark on the row; marks do not change the cost column', () => {
    const marks = { [MON_ID]: { status: 'skipped' as const } };
    const plain = buildSessionsModel(inputs, NOWS.inClass, null).rows[0];
    const marked = buildSessionsModel({ ...inputs, marks }, NOWS.inClass, null).rows[0];
    expect(plain.mark).toBeNull();
    expect(marked.mark).toBe('skipped');
    expect(marked.costText).toBe(plain.costText);
    expect(marked.costMinor).toBe(plain.costMinor);
  });
});
