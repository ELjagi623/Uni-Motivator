import { describe, expect, it } from 'vitest';
import { buildPools } from '../../src/core/billing';
import { skipCalculation } from '../../src/core/equivalents';
import { DEFAULT_LEAD_MINUTES, END_GRACE_MS, dueReminders, endFigures, reminderKey } from '../../src/core/notify';
import { computeStats, periodSummary, weekRange, type StatsInput, type StatsSession } from '../../src/core/stats';
import type { Course, MarkMap, SlackRecord } from '../../src/core/types';
import { NORTHERN, at } from './helpers';

// A hand-made term: tuition 600.00 (60,000 minor) over 6 class hours, so every hour is worth exactly 100.00 (10,000).
//   course A: A1 Mon 09-07 09:00-11:00, A2 Mon 09-14 09:00-11:00      (2 h each, 20,000 each)
//   course B: B1 Tue 09-08 09:00-10:00, B2 Tue 09-15 09:00-10:00      (1 h each, 10,000 each)
const sessions: StatsSession[] = [
  { id: 'A1', courseId: 'A', startMs: at('2026-09-07T09:00:00+08:00'), endMs: at('2026-09-07T11:00:00+08:00') },
  { id: 'A2', courseId: 'A', startMs: at('2026-09-14T09:00:00+08:00'), endMs: at('2026-09-14T11:00:00+08:00') },
  { id: 'B1', courseId: 'B', startMs: at('2026-09-08T09:00:00+08:00'), endMs: at('2026-09-08T10:00:00+08:00') },
  { id: 'B2', courseId: 'B', startMs: at('2026-09-15T09:00:00+08:00'), endMs: at('2026-09-15T10:00:00+08:00') },
];
const courses: Course[] = [
  { id: 'A', code: 'AAAA1000', name: 'Algebra', credits: null, color: '', match: { codes: ['AAAA1000'], titles: [] } },
  { id: 'B', code: null, name: 'Biology', credits: null, color: '', match: { codes: [], titles: ['biology'] } },
];
const pools = buildPools(sessions, { academic: NORTHERN, tuition: { defaultMinor: 60_000 } });
const marks: MarkMap = { A2: { status: 'skipped' }, B2: { status: 'cancelled' } };
const slacks: SlackRecord[] = [
  { id: 'r1', sessionId: 'A1', startMs: at('2026-09-07T09:30:00+08:00'), endMs: at('2026-09-07T10:00:00+08:00') }, // 30 min = 5,000
  { id: 'r2', sessionId: 'B1', startMs: at('2026-09-08T09:00:00+08:00'), endMs: at('2026-09-08T09:06:00+08:00') }, // 6 min = 1,000
  { id: 'r3', sessionId: 'B1', startMs: at('2026-09-08T09:30:00+08:00'), endMs: at('2026-09-08T09:42:00+08:00') }, // 12 min = 2,000
];
const input = (nowMs: number): StatsInput => ({ sessions, pools, courses, marks, slacks, nowMs });
const AFTER = at('2026-09-20T00:00:00+08:00');

describe('stats: course ranking', () => {
  const stats = computeStats(input(AFTER));

  it('ranks courses by money, with cost per hour, attendance and slacking (hand-computed)', () => {
    expect(stats.courses.map((c) => c.courseId)).toEqual(['A', 'B']);
    const [a, b] = stats.courses;
    expect(a).toMatchObject({ sessionCount: 2, countedSessions: 2, attendedCount: 1, skippedCount: 1, cancelledCount: 0, attendanceRate: 0.5, hours: 4, totalCostMinor: 40_000, costPerHourMinor: 10_000, slackSeconds: 1800, slackMinor: 5_000 });
    // B2 was cancelled: it costs money (swallowed) but is not an attendance chance
    expect(b).toMatchObject({ sessionCount: 2, countedSessions: 1, attendedCount: 1, skippedCount: 0, cancelledCount: 1, attendanceRate: 1, hours: 2, totalCostMinor: 20_000, costPerHourMinor: 10_000, slackSeconds: 18 * 60, slackMinor: 3_000 });
    expect(stats.totalCostMinor).toBe(60_000);
    expect(stats.totalHours).toBe(6);
  });

  it('finds the most expensive session (earliest wins a tie) and the one with the most slacking', () => {
    expect(stats.mostExpensive).toMatchObject({ sessionId: 'A1', costMinor: 20_000 });
    expect(stats.mostLossy).toMatchObject({ sessionId: 'A1', slackSeconds: 1800, slackMinor: 5_000 });
  });

  it('slacking: total, rate, favourite course, longest single slack', () => {
    const s = stats.slack;
    expect(s.totalSeconds).toBe(1800 + 18 * 60);
    expect(s.totalMinor).toBe(8_000);
    expect(s.recordCount).toBe(3);
    // attended class time: A1 (2 h) + B1 (1 h) = 10,800 s
    expect(s.slackRate).toBeCloseTo(2880 / 10_800, 10);
    expect(s.favouriteCourse).toEqual({ courseId: 'A', seconds: 1800, minor: 5_000 });
    expect(s.longest).toEqual({ recordId: 'r1', sessionId: 'A1', courseId: 'A', seconds: 1800, minor: 5_000 });
  });

  it('counts only sessions that have ended: in the middle of A1 and before the term there is nothing to rank', () => {
    const during = computeStats(input(at('2026-09-07T10:00:00+08:00')));
    expect(during.courses).toEqual([]);
    expect(during.mostExpensive).toBeNull();
    expect(during.slack.totalSeconds).toBe(0); // the slack record in progress is not counted before its class has ended
    const empty = computeStats({ ...input(AFTER), sessions: [], slacks: [] });
    expect(empty.courses).toEqual([]);
    expect(empty.mostLossy).toBeNull();
    expect(empty.slack).toMatchObject({ totalSeconds: 0, totalMinor: 0, slackRate: null, favouriteCourse: null, longest: null });
  });

  it('a day later only A1 and B1 have ended: ranking and rates follow', () => {
    const early = computeStats(input(at('2026-09-08T12:00:00+08:00')));
    expect(early.courses.map((c) => [c.courseId, c.sessionCount, c.totalCostMinor])).toEqual([['A', 1, 20_000], ['B', 1, 10_000]]);
    expect(early.courses[0].attendanceRate).toBe(1);
  });

  it('no slack at all: no favourite, no longest, no lossy session', () => {
    const none = computeStats({ ...input(AFTER), slacks: [] });
    expect(none.slack.favouriteCourse).toBeNull();
    expect(none.mostLossy).toBeNull();
    expect(none.slack.slackRate).toBe(0);
  });
});

describe('stats: periods', () => {
  it('sums the classes that ended inside a week: cost, hours, attendance, slacking', () => {
    const week = weekRange(at('2026-09-08T12:00:00+08:00'));
    expect(week.fromMs).toBe(at('2026-09-07T00:00:00+08:00'));
    expect(week.toMs).toBe(at('2026-09-14T00:00:00+08:00'));
    const w = periodSummary(input(AFTER), week.fromMs, week.toMs);
    expect(w).toMatchObject({ sessionCount: 2, costMinor: 30_000, hours: 3, attendedCount: 2, countedSessions: 2, attendanceRate: 1, slackSeconds: 2880, slackMinor: 8_000 });
    const next = periodSummary(input(AFTER), week.toMs, week.toMs + 7 * 86_400_000);
    expect(next).toMatchObject({ sessionCount: 2, costMinor: 30_000, attendedCount: 0, countedSessions: 1, attendanceRate: 0, slackSeconds: 0 });
    const future = periodSummary(input(at('2026-09-08T12:00:00+08:00')), next.fromMs, next.toMs);
    expect(future.sessionCount).toBe(0);
    expect(future.attendanceRate).toBeNull();
  });

  it('the whole semester equals the sum of its weeks', () => {
    const all = periodSummary(input(AFTER), at('2026-08-01T00:00:00+08:00'), at('2026-12-25T00:00:00+08:00'));
    expect(all.costMinor).toBe(60_000);
    expect(all.sessionCount).toBe(4);
  });
});

describe('skip calculator', () => {
  it('HK$3,980 against the HK$45 box of three-dish rice is 88 boxes (core numbers)', () => {
    const c = skipCalculation(398_000, 'HKD')!;
    expect(c.item.id).toBe('sanfan');
    expect(c.count).toBe(88);
    expect(c.costMinor).toBe(398_000);
    expect(skipCalculation(0, 'HKD')!.count).toBe(0);
    expect(skipCalculation(398_000, 'HKD', [])).toBeNull();
  });
});

describe('reminders (notify)', () => {
  const cls = { id: 'S', startMs: at('2026-11-12T10:00:00+08:00'), endMs: at('2026-11-12T11:00:00+08:00') };
  const opts = { leadMinutes: 5 };

  it('returns the "before" reminder from N minutes before the start until the start, and the "end" reminder at the end', () => {
    expect(dueReminders(at('2026-11-12T09:54:59+08:00'), [cls], {}, opts)).toEqual([]);
    const before = dueReminders(at('2026-11-12T09:55:00+08:00'), [cls], {}, opts);
    expect(before).toEqual([{ key: reminderKey('before', 'S'), kind: 'before', sessionId: 'S', dueMs: at('2026-11-12T09:55:00+08:00') }]);
    expect(dueReminders(at('2026-11-12T09:59:59+08:00'), [cls], {}, opts)).toHaveLength(1);
    expect(dueReminders(at('2026-11-12T10:00:00+08:00'), [cls], {}, opts)).toEqual([]); // class started: too late
    expect(dueReminders(at('2026-11-12T10:30:00+08:00'), [cls], {}, opts)).toEqual([]);
    const end = dueReminders(at('2026-11-12T11:00:00+08:00'), [cls], {}, opts);
    expect(end.map((r) => [r.kind, r.sessionId, r.dueMs])).toEqual([['end', 'S', cls.endMs]]);
    expect(dueReminders(cls.endMs + END_GRACE_MS, [cls], {}, opts)).toEqual([]); // stale
  });

  it('never returns a reminder that has been fired already, so each of the two comes exactly once', () => {
    const fired = new Set<string>();
    let shown = 0;
    for (let t = at('2026-11-12T09:00:00+08:00'); t <= at('2026-11-12T12:00:00+08:00'); t += 1000) {
      for (const r of dueReminders(t, [cls], {}, opts, fired)) {
        fired.add(r.key);
        shown++;
      }
    }
    expect(shown).toBe(2);
    expect([...fired].sort()).toEqual(['before:S', 'end:S']);
  });

  it('honours the lead time (any N), zero switches "before" off, cancelled and skipped classes are silent', () => {
    expect(dueReminders(at('2026-11-12T09:30:00+08:00'), [cls], {}, { leadMinutes: 30 })).toHaveLength(1);
    expect(dueReminders(at('2026-11-12T09:30:00+08:00'), [cls], {}, { leadMinutes: 10 })).toHaveLength(0);
    expect(dueReminders(at('2026-11-12T09:59:00+08:00'), [cls], {}, { leadMinutes: 0 })).toEqual([]);
    expect(dueReminders(cls.endMs, [cls], {}, { leadMinutes: 0 })).toHaveLength(1); // the end reminder stays
    expect(dueReminders(at('2026-11-12T09:58:00+08:00'), [cls], { S: { status: 'cancelled' } }, opts)).toEqual([]);
    expect(dueReminders(cls.endMs, [cls], { S: { status: 'skipped' } }, opts)).toEqual([]);
    expect(DEFAULT_LEAD_MINUTES).toBe(5);
  });

  it('several classes: reminders come in time order', () => {
    const next = { id: 'T', startMs: at('2026-11-12T11:02:00+08:00'), endMs: at('2026-11-12T12:00:00+08:00') };
    const r = dueReminders(at('2026-11-12T11:00:30+08:00'), [next, cls], {}, opts);
    expect(r.map((x) => x.key)).toEqual(['before:T', 'end:S']); // by the moment they became due: 10:57 and 11:00
  });

  it('the end reminder carries the class cost and the slack minutes and money', () => {
    const rate = 10_000 / 3600; // minor units per second
    const s = { id: 'A1', startMs: sessions[0].startMs, endMs: sessions[0].endMs };
    const f = endFigures(s, 20_000, rate, slacks, s.endMs);
    expect(f).toEqual({ costMinor: 20_000, slackSeconds: 1800, slackMinutes: 30, slackMinor: 5_000 });
    const none = endFigures({ id: 'A2', startMs: sessions[1].startMs, endMs: sessions[1].endMs }, 20_000, rate, slacks, sessions[1].endMs);
    expect(none).toMatchObject({ slackSeconds: 0, slackMinutes: 0, slackMinor: 0 });
    const twoPieces = endFigures({ id: 'B1', startMs: sessions[2].startMs, endMs: sessions[2].endMs }, 10_000, rate, slacks, sessions[2].endMs);
    expect(twoPieces).toMatchObject({ slackMinutes: 18, slackMinor: 3_000 });
  });
});
