// Independent QA checks for batch B1 (P0 + P1). Written by the test agent, not the developer.
// Expectations below are computed by hand from the fixtures / formulas, not copied from the core output.
import { describe, expect, it } from 'vitest';
import { expandIcs } from '../../src/core/ics/expand';
import { buildPools, billingStateAt, poolStateAt, summarizeMarks } from '../../src/core/billing';
import { checkSplitDate } from '../../src/core/academic';
import { getStatus } from '../../src/core/status';
import { countOf, pickEquivalent, itemPriceMinor } from '../../src/core/equivalents';
import { formatMinor, convert } from '../../src/core/money';
import { slackAmountMinor, closeFinishedSlacks } from '../../src/core/slack';
import { PRICE_PACK_HK } from '../../src/data/price-pack-hk';
import { readFixture, rng, NORTHERN, dailySessions, at } from '../core/helpers';

const HOUR = 3_600_000;

describe('QA P1.2 billing: 1000+ random now, independent oracle', () => {
  const sessions = expandIcs(readFixture('full-term.ics'));
  const TUITION = 398_000 * 100; // HK$398,000.00 in minor units

  const runChecks = (pools: ReturnType<typeof buildPools>, label: string) => {
    const r = rng(20261112);
    const first = Math.min(...sessions.map((s) => s.startMs));
    const last = Math.max(...sessions.map((s) => s.endMs));
    const nows: number[] = [];
    for (let i = 0; i < 1200; i++) nows.push(first - 2 * 86_400_000 + r() * (last - first + 4 * 86_400_000));
    for (const s of sessions) nows.push(s.startMs, s.endMs, s.startMs - 1, s.endMs + 1, s.startMs + 1);
    nows.sort((a, b) => a - b);
    expect(nows.length).toBeGreaterThanOrEqual(1000);

    let checked = 0;
    for (const pool of pools) {
      const tuition = pool.tuitionMinor as number;
      let prevConsumed = -1;
      for (const now of nows) {
        const st = poolStateAt(pool, now);
        expect(Number.isInteger(st.consumedMinor), `${label} consumed int @${now}`).toBe(true);
        expect(st.consumedMinor + st.remainingMinor, `${label} sum @${now}`).toBe(tuition);
        expect(st.consumedMinor).toBeGreaterThanOrEqual(0);
        expect(st.consumedMinor).toBeLessThanOrEqual(tuition);
        expect(st.consumedMinor).toBeGreaterThanOrEqual(prevConsumed); // monotone in now
        prevConsumed = st.consumedMinor;
        if (now <= pool.firstStartMs) expect(st.consumedMinor).toBe(0);
        if (now >= pool.lastEndMs) {
          expect(st.consumedMinor).toBe(tuition);
          expect(st.progress).toBe(1);
        }
        checked++;
      }
    }
    // Whole-term totals obey the same invariant.
    for (const now of nows) {
      const b = billingStateAt(pools, now);
      expect(b.consumedMinor + b.remainingMinor).toBe(b.tuitionMinor);
    }
    return checked;
  };

  it('duration mode: consumed+remaining===tuition, monotone, 0 before first class, full after last; matches linear oracle within 0.5 minor', () => {
    const pools = buildPools(sessions, { academic: NORTHERN, tuition: { defaultMinor: TUITION } });
    expect(pools.length).toBe(2); // semester 1 and semester 2 of the academic year
    const checked = runChecks(pools, 'duration');
    expect(checked).toBeGreaterThan(2000);

    // Independent oracle: in duration mode the cost is linear in elapsed class seconds.
    const r = rng(7);
    for (let k = 0; k < 400; k++) {
      const pool = pools[k % pools.length];
      const now = pool.firstStartMs + r() * (pool.lastEndMs - pool.firstStartMs + 2 * HOUR);
      let elapsed = 0;
      for (const s of pool.sessions) elapsed += Math.max(0, Math.min(now, s.endMs) - s.startMs) / 1000;
      const exact = ((pool.tuitionMinor as number) * elapsed) / pool.totalSeconds;
      const got = poolStateAt(pool, now).consumedMinor;
      expect(Math.abs(got - exact)).toBeLessThanOrEqual(0.5 + 1e-6);
    }
  });

  it('credit mode: same invariants, and each course gets tuition x credits / total credits (3:2 here)', () => {
    const withCourse = sessions.map((s) => ({ id: s.id, startMs: s.startMs, endMs: s.endMs, courseId: s.title }));
    const credits = { 'MFIN7001 Corporate Finance': 3, 'MFIN7002 Investment Analysis': 2 };
    const pools = buildPools(withCourse, { academic: NORTHERN, mode: 'credit', tuition: { defaultMinor: TUITION }, credits });
    runChecks(pools, 'credit');
    for (const pool of pools) {
      const sumCost = pool.sessions.reduce((a, s) => a + s.costMinor, 0);
      expect(sumCost).toBe(pool.tuitionMinor);
      const c7001 = pool.sessions.filter((s) => s.courseId === 'MFIN7001 Corporate Finance').reduce((a, s) => a + s.costExact, 0);
      expect(Math.abs(c7001 - (pool.tuitionMinor as number) * 0.6)).toBeLessThan(0.01);
    }
  });

  it('original numbers: 398,000 tuition, 100 x 3h sessions -> 0.3685 per second (HK$), single session = HK$3,980.00', () => {
    const list = dailySessions('2026-09-01', 100, 3).map((s) => ({ id: s.id, startMs: s.startMs, endMs: s.endMs }));
    const [pool] = buildPools(list, { academic: NORTHERN, tuition: { defaultMinor: 39_800_000 } });
    expect(pool.sessions.length).toBe(100);
    const perSecHKD = pool.averageRatePerSec / 100;
    expect(Math.round(perSecHKD * 10000) / 10000).toBe(0.3685);
    for (const s of pool.sessions) expect(s.costMinor).toBe(398_000);
    expect(formatMinor(398_000, 'HKD')).toBe('HK$3,980.00');
  });

  it('marks never change the unit price; summary totals match hand arithmetic', () => {
    const list = dailySessions('2026-09-01', 4, 2).map((s) => ({ id: s.id, startMs: s.startMs, endMs: s.endMs }));
    const pools = buildPools(list, { academic: NORTHERN, tuition: { defaultMinor: 40_000 } });
    const before = pools[0].averageRatePerSec;
    const marks = {
      [list[0].id]: { status: 'cancelled' as const },
      [list[1].id]: { status: 'skipped' as const },
      [list[2].id]: { lateMin: 15 },
    };
    const res = summarizeMarks(pools, marks);
    expect(pools[0].averageRatePerSec).toBe(before);
    expect(res.total.sessionCount).toBe(4);
    expect(res.total.cancelledMinor).toBe(10_000);
    expect(res.total.skippedMinor).toBe(10_000);
    // 15 min late at 40000/(4*7200 s) per second = 10000/7200 per second -> 900 s -> 1250 minor
    expect(res.total.lateMinor).toBe(1250);
    expect(res.total.lostMinor).toBe(10_000 + 1250);
  });
});

describe('QA P1.3 calendar expansion: three fixtures checked by hand', () => {
  it('full-term.ics: 58 sessions, 29 per semester, 174 h, EXDATE Thu 2026-10-01 absent, 2026-11-12 10:30 HK is inside a class', () => {
    const s = expandIcs(readFixture('full-term.ics'));
    expect(s.length).toBe(58);
    expect(s.filter((x) => x.startMs < at('2027-01-01T00:00:00+08:00')).length).toBe(29);
    const hours = s.reduce((a, x) => a + (x.endMs - x.startMs) / HOUR, 0);
    expect(hours).toBe(174);
    expect(s.some((x) => x.startMs === at('2026-10-01T10:00:00+08:00'))).toBe(false);
    expect(s.some((x) => x.startMs === at('2026-12-14T09:00:00+08:00'))).toBe(true);
    expect(s.some((x) => x.startMs === at('2026-12-21T09:00:00+08:00'))).toBe(false);
    const thu = s.find((x) => x.startMs === at('2026-11-12T10:00:00+08:00'));
    expect(thu && thu.endMs).toBe(at('2026-11-12T13:00:00+08:00'));
  });

  it('london-dst.ics: 09:00 London is 08:00Z before the 25 Oct 2026 switch and 09:00Z after it', () => {
    const s = expandIcs(readFixture('london-dst.ics'));
    expect(s.map((x) => x.startMs)).toEqual([
      at('2026-10-19T08:00:00Z'),
      at('2026-10-26T09:00:00Z'),
      at('2026-11-02T09:00:00Z'),
    ]);
    for (const x of s) expect(x.endMs - x.startMs).toBe(HOUR);
    expect(s[0].id).toBe('london@fixture|2026-10-19T08:00:00Z');
  });

  it('exdate.ics: COUNT=6 weekly with one EXDATE gives 5 sessions, Sep 21 absent', () => {
    const s = expandIcs(readFixture('exdate.ics'));
    expect(s.length).toBe(5);
    expect(s.some((x) => x.startMs === at('2026-09-21T10:00:00+08:00'))).toBe(false);
    expect(s.map((x) => x.startMs)).toEqual(
      ['2026-09-07', '2026-09-14', '2026-09-28', '2026-10-05', '2026-10-12'].map((d) => at(`${d}T10:00:00+08:00`)),
    );
  });
});

describe('QA P1.4 status, split date, slacking', () => {
  const s = expandIcs(readFixture('full-term.ics'));
  it('status at five hand-picked instants', () => {
    const inClass = getStatus(at('2026-11-12T10:30:00+08:00'), s, {});
    expect(inClass.kind).toBe('in-class');
    expect(inClass.current?.startMs).toBe(at('2026-11-12T10:00:00+08:00'));
    expect(getStatus(at('2026-11-12T13:30:00+08:00'), s, {}).kind).toBe('done-today');
    expect(getStatus(at('2026-10-03T12:00:00+08:00'), s, {}).kind).toBe('no-class-today');
    expect(getStatus(at('2026-08-01T12:00:00+08:00'), s, {}).kind).toBe('before-term');
    expect(getStatus(at('2027-06-01T12:00:00+08:00'), s, {}).kind).toBe('after-term');
  });

  it('split date: inside the winter gap -> ok; outside (10-15) -> suggest middle of the longest gap (about 12-31)', () => {
    const inside = checkSplitDate(s, NORTHERN);
    expect(inside.length).toBe(1);
    expect(inside[0].status).toBe('ok');
    expect(inside[0].suggestedSplit).toBeUndefined();

    const outside = checkSplitDate(s, { ...NORTHERN, splitDate: '10-15' });
    expect(outside[0].status).toBe('suggest');
    // longest gap: Mon 2026-12-14 12:00 HK -> Mon 2027-01-18 09:00 HK; midpoint lands on 31 Dec local
    expect(outside[0].suggestedSplit).toBe('12-31');
  });

  it('slacking: partial overlap counts only overlapping seconds; running record is capped at class end', () => {
    const session = { id: 'x', startMs: at('2026-11-12T10:00:00+08:00'), endMs: at('2026-11-12T13:00:00+08:00') };
    const closed = { id: 'r1', sessionId: 'x', startMs: session.startMs + 600_000, endMs: session.startMs + 2_400_000 };
    expect(slackAmountMinor(closed, session, 1, 0)).toBe(1800); // 30 min at 1 minor/s
    const running = { id: 'r2', sessionId: 'x', startMs: session.startMs + HOUR };
    const now = session.endMs + 3 * HOUR; // long after class end
    expect(slackAmountMinor(running, session, 1, now)).toBe(7200); // 2 h, not 5 h
    const closedOut = closeFinishedSlacks([running], new Map([['x', session]]), now);
    expect(closedOut.records[0].endMs).toBe(session.endMs);
  });
});

describe('QA P1.5 equivalents and money', () => {
  it('3,980 HKD / 45 HKD sanfan = 88 items (countOf)', () => {
    const sanfan = PRICE_PACK_HK.find((i) => i.id === 'sanfan');
    expect(sanfan).toBeDefined();
    expect(countOf(398_000, 'HKD', sanfan!).count).toBe(88);
  });

  it('pickEquivalent(3,980 HKD) = most expensive item <= amount (oracle over the pack)', () => {
    const amount = 398_000;
    const cands = PRICE_PACK_HK.filter((i) => i.currency === 'HKD' && i.price * 100 <= amount);
    const best = cands.reduce((a, b) => (b.price > a.price ? b : a));
    const eq = pickEquivalent(amount, 'HKD');
    expect(eq?.belowCheapest).toBe(false);
    expect(eq?.item.id).toBe(best.id);
    expect(itemPriceMinor(best, 'HKD')).toBeLessThanOrEqual(amount);
    // below the cheapest item -> fallback with belowCheapest true
    const tiny = pickEquivalent(1, 'HKD');
    expect(tiny?.belowCheapest).toBe(true);
    expect(tiny?.count).toBe(0);
  });

  it('formatting of 7 currencies and convert round trip < 0.01 minor over 1000 random amounts', () => {
    const codes = ['HKD', 'CNY', 'USD', 'GBP', 'EUR', 'CAD', 'AUD'] as const;
    for (const c of codes) expect(formatMinor(123_456, c)).toMatch(/\d{1,3}(,\d{3})*\.\d{2}$/);
    const r = rng(99);
    let worst = 0;
    for (let i = 0; i < 1000; i++) {
      const a = codes[Math.floor(r() * codes.length)];
      const b = codes[Math.floor(r() * codes.length)];
      const x = r() * 1e9;
      const back = convert(convert(x, a, b), b, a);
      worst = Math.max(worst, Math.abs(back - x));
    }
    expect(worst).toBeLessThan(0.01);
  });
});
