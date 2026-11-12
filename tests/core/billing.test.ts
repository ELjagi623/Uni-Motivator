import { describe, expect, it } from 'vitest';
import {
  billingStateAt,
  buildPools,
  findPoolOfSession,
  getPoolSession,
  poolStateAt,
  sessionStateAt,
  summarizeMarks,
  type BillableSession,
  type BillingConfig,
  type Pool,
} from '../../src/core/billing';
import { formatMinor } from '../../src/core/money';
import type { MarkMap } from '../../src/core/types';
import { at, dailySessions, fixtureSessions, NORTHERN, NORTHERN_YEAR, rng } from './helpers';

const TUITION = 39_800_000; // HK$398,000.00 in cents
const baseCfg: BillingConfig = { academic: NORTHERN, tuition: { defaultMinor: TUITION } };
const term = fixtureSessions('full-term.ics');

/** `now` values that stress every boundary: before, inside, between, after, exactly on starts and ends. */
function sampleNows(pools: Pool[], count: number, seed: number): number[] {
  const random = rng(seed);
  const all = pools.flatMap((p) => p.sessions);
  const first = Math.min(...all.map((s) => s.startMs));
  const last = Math.max(...all.map((s) => s.endMs));
  const nows: number[] = [first - 86_400_000, first - 1, first, first + 1, last - 1, last, last + 1, last + 365 * 86_400_000];
  for (const s of all) nows.push(s.startMs - 1, s.startMs, s.startMs + 1, s.endMs - 1, s.endMs, s.endMs + 1, Math.round((s.startMs + s.endMs) / 2));
  while (nows.length < count) nows.push(Math.round(first - 7 * 86_400_000 + random() * (last - first + 14 * 86_400_000)));
  return nows.sort((a, b) => a - b);
}

function expectInvariants(pools: Pool[], nows: number[]): void {
  let prevTotal = -1;
  const prevPool = new Map<string, number>();
  const totalTuition = pools.reduce((a, p) => a + (p.tuitionMinor ?? 0), 0);
  for (const now of nows) {
    let sumConsumed = 0;
    for (const p of pools) {
      const st = poolStateAt(p, now);
      expect(Number.isInteger(st.consumedMinor)).toBe(true);
      expect(Number.isInteger(st.remainingMinor)).toBe(true);
      expect(st.consumedMinor + st.remainingMinor).toBe(st.tuitionMinor); // strictly equal
      expect(st.consumedMinor).toBeGreaterThanOrEqual(0);
      expect(st.remainingMinor).toBeGreaterThanOrEqual(0);
      expect(st.progress).toBeGreaterThanOrEqual(0);
      expect(st.progress).toBeLessThanOrEqual(1);
      expect(st.consumedMinor).toBeGreaterThanOrEqual(prevPool.get(p.key) ?? 0); // monotone (nows are sorted)
      prevPool.set(p.key, st.consumedMinor);
      if (now <= p.firstStartMs) {
        expect(st.consumedMinor).toBe(0);
        expect(st.progress).toBe(0);
      }
      if (now >= p.lastEndMs) {
        expect(st.consumedMinor).toBe(st.tuitionMinor);
        expect(st.progress).toBe(1);
      }
      sumConsumed += st.consumedMinor;
    }
    const total = billingStateAt(pools, now);
    expect(total.consumedMinor + total.remainingMinor).toBe(total.tuitionMinor);
    expect(total.tuitionMinor).toBe(totalTuition);
    expect(total.consumedMinor).toBe(sumConsumed);
    expect(total.consumedMinor).toBeGreaterThanOrEqual(prevTotal);
    prevTotal = total.consumedMinor;
  }
}

describe('billing invariants on the full-term calendar (duration mode)', () => {
  const pools = buildPools(term, baseCfg);
  const nows = sampleNows(pools, 1500, 42);

  it('has one pool per semester with the right tuition', () => {
    expect(pools.map((p) => [p.key, p.tuitionMinor, p.sessions.length, p.semester])).toEqual([
      ['2026-S1', TUITION, 29, 1],
      ['2026-S2', TUITION, 29, 2],
    ]);
    expect(pools.every((p) => p.totalSeconds === 87 * 3600)).toBe(true);
  });

  it('holds consumed + remaining === tuition, monotonicity and the boundary values at 1500+ instants', () => {
    expect(nows.length).toBeGreaterThanOrEqual(1500);
    expectInvariants(pools, nows);
  });

  it('is 0 before the first class and the full tuition after the last class (whole calendar)', () => {
    const before = billingStateAt(pools, at('2026-08-01T00:00:00+08:00'));
    expect(before).toMatchObject({ consumedMinor: 0, remainingMinor: 2 * TUITION, progress: 0 });
    const after = billingStateAt(pools, at('2027-06-01T00:00:00+08:00'));
    expect(after).toMatchObject({ consumedMinor: 2 * TUITION, remainingMinor: 0, progress: 1 });
  });

  it('matches an independent brute-force computation (sum of unit price x elapsed seconds) within one cent', () => {
    const random = rng(7);
    for (const p of pools) {
      const rate = TUITION / p.totalSeconds;
      for (let i = 0; i < 400; i++) {
        const now = Math.round(p.firstStartMs - 3_600_000 + random() * (p.lastEndMs - p.firstStartMs + 7_200_000));
        let brute = 0;
        for (const s of p.sessions) brute += rate * Math.min(Math.max((now - s.startMs) / 1000, 0), s.durationSec);
        const got = poolStateAt(p, now).consumedMinor;
        expect(Math.abs(got - Math.min(brute, TUITION))).toBeLessThanOrEqual(0.51);
      }
    }
  });

  it('half way through a class the consumed amount is exactly half of that class cost on top of the earlier classes', () => {
    const p = pools[0];
    const sixth = p.sessions[5];
    const now = (sixth.startMs + sixth.endMs) / 2;
    const done = p.sessions.slice(0, 5).reduce((a, s) => a + s.costExact, 0);
    expect(poolStateAt(p, now).consumedMinor).toBe(Math.round(done + sixth.costExact / 2));
  });

  it('is derived from `now` alone: the order of calls does not matter (no accumulation)', () => {
    const a = nows.slice(0, 50).map((n) => poolStateAt(pools[0], n).consumedMinor);
    const b = nows
      .slice(0, 50)
      .reverse()
      .map((n) => poolStateAt(pools[0], n).consumedMinor)
      .reverse();
    expect(b).toEqual(a);
  });
});

describe('the original screenshot numbers', () => {
  // HK$398,000 over 100 sessions of 3 hours: HK$0.3685 per second, HK$3,980.00 per session.
  const sessions = dailySessions('2026-09-01', 100, 3);
  const pools = buildPools(sessions, { academic: { ...NORTHERN, billingPeriod: 'year' }, tuition: { defaultMinor: TUITION } });

  it('reproduces 0.3685 per second and HK$3,980.00 per session', () => {
    expect(pools).toHaveLength(1);
    const p = pools[0];
    const perSecondMajor = p.sessions[0].ratePerSec / 100;
    expect(Math.round(perSecondMajor * 10_000) / 10_000).toBe(0.3685);
    expect(p.averageRatePerSec / 100).toBeCloseTo(perSecondMajor, 12);
    for (const s of p.sessions) expect(s.costMinor).toBe(398_000);
    expect(formatMinor(p.sessions[0].costMinor, 'HKD')).toBe('HK$3,980.00');
    expect(p.sessions.reduce((a, s) => a + s.costMinor, 0)).toBe(TUITION);
  });

  it('shows the per-session consumption as 0, half, full', () => {
    const p = pools[0];
    const s = p.sessions[10];
    expect(sessionStateAt(p, s.id, s.startMs - 1)).toMatchObject({ consumedMinor: 0, remainingMinor: 398_000, progress: 0 });
    expect(sessionStateAt(p, s.id, s.startMs + 90 * 60_000)).toMatchObject({ consumedMinor: 199_000, remainingMinor: 199_000, progress: 0.5 });
    expect(sessionStateAt(p, s.id, s.endMs)).toMatchObject({ consumedMinor: 398_000, remainingMinor: 0, progress: 1 });
    expect(sessionStateAt(p, 'missing', s.endMs)).toBeNull();
  });

  it('after 10 sessions exactly 10/100 of the tuition is consumed', () => {
    const p = pools[0];
    expect(poolStateAt(p, p.sessions[9].endMs).consumedMinor).toBe(3_980_000);
    expect(poolStateAt(p, p.sessions[9].endMs).progress).toBeCloseTo(0.1, 12);
  });
});

describe('per-session integer costs', () => {
  it('always add up to exactly the tuition, even when it does not divide evenly', () => {
    const sessions = dailySessions('2026-09-01', 7, 1.5);
    for (const tuition of [1, 2, 99, 100, 1_000_003, 39_800_001]) {
      const [p] = buildPools(sessions, { academic: NORTHERN_YEAR, tuition: { defaultMinor: tuition } });
      expect(p.sessions.reduce((a, s) => a + s.costMinor, 0)).toBe(tuition);
      expect(p.sessions.every((s) => Number.isInteger(s.costMinor) && s.costMinor >= 0)).toBe(true);
      expectInvariants([p], sampleNows([p], 200, tuition));
    }
  });
});

describe('overlapping sessions', () => {
  it('bills both sessions (each is part of the denominator) and still satisfies the invariants', () => {
    const sessions = fixtureSessions('overlap.ics'); // 10-12 and 11-13, 4 hours in total
    const [p] = buildPools(sessions, { academic: NORTHERN_YEAR, tuition: { defaultMinor: 4_000_000 } });
    expect(p.totalSeconds).toBe(4 * 3600);
    expect(p.sessions.map((s) => s.costMinor)).toEqual([2_000_000, 2_000_000]);
    // 11:30 -> 1.5 h of the first class + 0.5 h of the second = 2 h of 4 h = half the tuition
    expect(poolStateAt(p, at('2026-11-12T11:30:00+08:00')).consumedMinor).toBe(2_000_000);
    expectInvariants([p], sampleNows([p], 300, 5));
  });

  it('handles a very long session that covers many short ones', () => {
    const long: BillableSession = { id: 'long', startMs: at('2026-09-01T00:00:00+08:00'), endMs: at('2026-09-02T00:00:00+08:00') };
    const shorts = dailySessions('2026-09-01', 5, 1).map((s) => ({ id: s.id, startMs: s.startMs - 0, endMs: s.endMs }));
    const [p] = buildPools([long, ...shorts.slice(0, 1)], { academic: NORTHERN_YEAR, tuition: { defaultMinor: 1_000_000 } });
    expectInvariants([p], sampleNows([p], 200, 9));
  });
});

describe('marks never change the price', () => {
  const sessions = dailySessions('2026-09-01', 100, 3);
  const cfg: BillingConfig = { academic: NORTHERN_YEAR, tuition: { defaultMinor: TUITION } };
  const pools = buildPools(sessions, cfg);
  const ids = pools[0].sessions.map((s) => s.id);

  const marks: MarkMap = {};
  for (let i = 0; i < 10; i++) marks[ids[i]] = { status: 'skipped' };
  for (let i = 10; i < 15; i++) marks[ids[i]] = { status: 'cancelled' };
  for (let i = 15; i < 18; i++) marks[ids[i]] = { lateMin: 30 };
  for (let i = 18; i < 20; i++) marks[ids[i]] = { earlyMin: 15 };

  it('keeps cancelled and skipped sessions in the denominator: rebuilding with marks around gives the same price', () => {
    const again = buildPools(sessions, cfg);
    expect(again[0].sessions[0].ratePerSec).toBe(pools[0].sessions[0].ratePerSec);
    expect(summarizeMarks(pools, marks).byPool['2026']).toBeDefined();
    // The marks object is not an input of buildPools / poolStateAt at all: the consumption is identical with or without it.
    const now = at('2026-10-20T11:00:00+08:00');
    expect(poolStateAt(pools[0], now)).toEqual(poolStateAt(again[0], now));
  });

  it('summarises school-swallowed tuition, skipped loss, late / early loss and attendance (hand-calculated)', () => {
    const { total, byPool } = summarizeMarks(pools, marks);
    expect(total.sessionCount).toBe(100);
    expect(total.cancelledCount).toBe(5);
    expect(total.skippedCount).toBe(10);
    expect(total.cancelledMinor).toBe(5 * 398_000); // 停课: school keeps HK$19,900.00
    expect(total.skippedMinor).toBe(10 * 398_000); // 翘课: HK$39,800.00 thrown away
    // 3 x 30 min late = 90 min at HK$0.36852/s = 90 x 60 x 36.85185 minor = 199,000
    expect(total.lateMinutes).toBe(90);
    expect(total.lateMinor).toBe(199_000);
    // 2 x 15 min early = 30 min = 66,333.33 minor
    expect(total.earlyMinutes).toBe(30);
    expect(total.earlyMinor).toBe(66_333);
    expect(total.lostMinor).toBe(3_980_000 + 199_000 + 66_333);
    expect(total.attendedCount).toBe(100 - 5 - 10);
    expect(total.attendanceRate).toBeCloseTo(85 / 95, 12); // cancelled classes are not the student's to attend
    expect(byPool['2026']).toEqual(total);
  });

  it('can restrict the summary to sessions that have already ended', () => {
    const asOf = pools[0].sessions[11].endMs; // 12 sessions are over: 10 skipped, 2 cancelled
    const { total } = summarizeMarks(pools, marks, { asOfMs: asOf });
    expect(total.sessionCount).toBe(12);
    expect(total.skippedCount).toBe(10);
    expect(total.cancelledCount).toBe(2);
    expect(total.attendedCount).toBe(0);
    expect(total.attendanceRate).toBe(0);
    expect(summarizeMarks(pools, marks, { asOfMs: pools[0].firstStartMs - 1 }).total.attendanceRate).toBeNull();
  });

  it('ignores late / early minutes on skipped or cancelled sessions and clamps them to the class length', () => {
    const odd: MarkMap = {
      [ids[0]]: { status: 'skipped', lateMin: 60 },
      [ids[1]]: { status: 'cancelled', earlyMin: 60 },
      [ids[2]]: { lateMin: 500, earlyMin: 500 }, // clamped: late 180, early 0 (nothing left)
      [ids[3]]: { lateMin: -5, earlyMin: -5 },
      'not-a-session': { status: 'skipped' },
    };
    const { total } = summarizeMarks(pools, odd);
    expect(total.lateMinutes).toBe(180);
    expect(total.earlyMinutes).toBe(0);
    expect(total.lateMinor).toBe(398_000);
    expect(total.skippedCount).toBe(1);
    expect(total.cancelledCount).toBe(1);
  });
});

describe('credit-weighted mode', () => {
  // Course A: 3 credits, 10 sessions of 2 h.  Course B: 1 credit, 5 sessions of 4 h.
  const a = dailySessions('2026-09-01', 10, 2, 'a').map((s) => ({ ...s, courseId: 'A' }));
  const b = dailySessions('2026-10-01', 5, 4, 'b').map((s) => ({ ...s, courseId: 'B' }));
  const cfg: BillingConfig = {
    academic: NORTHERN_YEAR,
    mode: 'credit',
    tuition: { defaultMinor: 1_000_000 },
    credits: { A: 3, B: 1 },
  };
  const [pool] = buildPools([...a, ...b], cfg);

  it('splits the tuition by credits, then by duration inside each course', () => {
    const costA = pool.sessions.filter((s) => s.courseId === 'A').reduce((x, s) => x + s.costExact, 0);
    const costB = pool.sessions.filter((s) => s.courseId === 'B').reduce((x, s) => x + s.costExact, 0);
    expect(costA).toBeCloseTo(750_000, 6);
    expect(costB).toBeCloseTo(250_000, 6);
    expect(pool.sessions.filter((s) => s.courseId === 'A').every((s) => s.costMinor === 75_000)).toBe(true);
    expect(pool.sessions.filter((s) => s.courseId === 'B').every((s) => s.costMinor === 50_000)).toBe(true);
    expect(pool.sessions.reduce((x, s) => x + s.costMinor, 0)).toBe(1_000_000);
    expect(pool.sessions[0].ratePerSec).toBeCloseTo(750_000 / (20 * 3600), 9);
  });

  it('satisfies every invariant', () => {
    expectInvariants([pool], sampleNows([pool], 1200, 11));
  });

  it('counts a course without credits as 1 credit and sessions without a course as one extra pseudo-course', () => {
    const [p] = buildPools([...a, ...b.map((s) => ({ ...s, courseId: undefined }))], { ...cfg, credits: { A: 3 } });
    const costA = p.sessions.filter((s) => s.courseId === 'A').reduce((x, s) => x + s.costExact, 0);
    expect(costA).toBeCloseTo(750_000, 6);
    expect(p.sessions.filter((s) => s.courseId === null).reduce((x, s) => x + s.costExact, 0)).toBeCloseTo(250_000, 6);
    expectInvariants([p], sampleNows([p], 300, 13));
  });

  it('with equal credits equals the duration-weighted split per course', () => {
    const [p] = buildPools([...a, ...b], { ...cfg, credits: { A: 2, B: 2 } });
    expect(p.sessions.filter((s) => s.courseId === 'A').reduce((x, s) => x + s.costExact, 0)).toBeCloseTo(500_000, 6);
  });

  it('works across the semester pools of the full-term calendar, with courses of different credits', () => {
    const withCourses = term.map((s) => ({ ...s, courseId: s.uid.includes('mon') ? 'MON' : 'THU' }));
    const pools = buildPools(withCourses, { academic: NORTHERN, mode: 'credit', tuition: { defaultMinor: TUITION }, credits: { MON: 4, THU: 2 } });
    for (const p of pools) {
      const mon = p.sessions.filter((s) => s.courseId === 'MON').reduce((x, s) => x + s.costExact, 0);
      expect(mon).toBeCloseTo((TUITION * 4) / 6, 3);
      expect(p.sessions.reduce((x, s) => x + s.costMinor, 0)).toBe(TUITION);
    }
    expectInvariants(pools, sampleNows(pools, 1500, 17));
  });
});

describe('tuition per pool', () => {
  it('lets one semester differ from another without touching the other pool', () => {
    const cfg: BillingConfig = { academic: NORTHERN, tuition: { defaultMinor: TUITION, byPool: { '2026-S2': 20_000_000 } } };
    const pools = buildPools(term, cfg);
    const base = buildPools(term, baseCfg);
    expect(pools[0].averageRatePerSec).toBe(base[0].averageRatePerSec);
    expect(pools[1].tuitionMinor).toBe(20_000_000);
    expect(pools[1].averageRatePerSec).toBeCloseTo(base[1].averageRatePerSec * (20_000_000 / TUITION), 9);
    expectInvariants(pools, sampleNows(pools, 400, 21));
  });

  it('treats a pool without tuition as "unset": money fields are 0, it is excluded from totals and listed', () => {
    const pools = buildPools(term, { academic: NORTHERN, tuition: { defaultMinor: null, byPool: { '2026-S1': TUITION } } });
    const unset = pools.find((p) => p.key === '2026-S2')!;
    expect(unset.tuitionMinor).toBeNull();
    expect(unset.sessions.every((s) => s.ratePerSec === 0 && s.costMinor === 0)).toBe(true);
    const st = poolStateAt(unset, at('2027-02-01T10:00:00+08:00'));
    expect(st).toMatchObject({ tuitionSet: false, tuitionMinor: 0, consumedMinor: 0, remainingMinor: 0 });
    expect(st.progress).toBeGreaterThan(0);
    const total = billingStateAt(pools, at('2027-02-01T10:00:00+08:00'));
    expect(total.unsetPoolKeys).toEqual(['2026-S2']);
    expect(total.tuitionMinor).toBe(TUITION);
    expect(total.consumedMinor).toBe(TUITION);
    expect(poolStateAt(unset, at('2027-06-01T00:00:00+08:00')).progress).toBe(1);
  });

  it('bills a whole academic year as a single pool when the period is "year"', () => {
    const pools = buildPools(term, { academic: NORTHERN_YEAR, tuition: { defaultMinor: 2 * TUITION } });
    expect(pools).toHaveLength(1);
    expect(pools[0].key).toBe('2026');
    expect(pools[0].semester).toBeNull();
    expect(pools[0].sessions).toHaveLength(58);
    expectInvariants(pools, sampleNows(pools, 1500, 23));
  });

  it('rejects tuition that is not a non-negative integer and malformed academic dates', () => {
    expect(() => buildPools(term, { academic: NORTHERN, tuition: { defaultMinor: 100.5 } })).toThrow(/integer/);
    expect(() => buildPools(term, { academic: NORTHERN, tuition: { defaultMinor: -1 } })).toThrow();
    expect(() => buildPools(term, { academic: { ...NORTHERN, splitDate: '99-99' }, tuition: { defaultMinor: 1 } })).toThrow();
  });

  it('copes with a zero tuition', () => {
    const pools = buildPools(term, { academic: NORTHERN, tuition: { defaultMinor: 0 } });
    expectInvariants(pools, sampleNows(pools, 100, 1));
    expect(poolStateAt(pools[0], at('2026-11-12T10:30:00+08:00')).consumedMinor).toBe(0);
  });
});

describe('lookups and edge cases', () => {
  it('finds the pool and the session record of a session id', () => {
    const pools = buildPools(term, baseCfg);
    const id = 'ft-thu-s1@fixture|2026-11-12T02:00:00Z';
    expect(findPoolOfSession(pools, id)?.key).toBe('2026-S1');
    expect(getPoolSession(pools[0], id)?.durationSec).toBe(3 * 3600);
    expect(getPoolSession(pools[0], 'nope')).toBeNull();
    expect(findPoolOfSession(pools, 'nope')).toBeNull();
  });

  it('returns no pools for no sessions, ignores sessions without a positive duration, and totals zero', () => {
    expect(buildPools([], baseCfg)).toEqual([]);
    const bad: BillableSession[] = [{ id: 'z', startMs: 5, endMs: 5 }];
    expect(buildPools(bad, baseCfg)).toEqual([]);
    expect(billingStateAt([], 123)).toEqual({ tuitionMinor: 0, consumedMinor: 0, remainingMinor: 0, progress: 0, unsetPoolKeys: [] });
    expect(summarizeMarks([], {}).total.attendanceRate).toBeNull();
  });
});
