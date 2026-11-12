import { describe, expect, it } from 'vitest';
import { billingStateAt, poolStateAt, sessionStateAt } from '../../src/core/billing';
import { groupSessions } from '../../src/core/courses';
import { expandIcs } from '../../src/core/ics/expand';
import { getStatus } from '../../src/core/status';
import { buildConfig, initialDraft } from '../../src/state/onboarding';
import { buildDashboardModel, calendarDaysBetween, durationText, liveAt, shownView, summaryText } from '../../src/state/dashboard';
import { dashboardModel } from '../../src/state/dashboardState';
import { CLASS_END, CLASS_ID, CLASS_START, NOWS, fixtureConfig, fullTermText, hk, inputsFor } from './fixture-app';

const config = fixtureConfig();
const inputs = inputsFor(config, [fullTermText]);

describe('dashboard model: status mapping', () => {
  it.each(Object.entries(NOWS))('the page state for "%s" is the state core reports', (_name, nowMs) => {
    const model = buildDashboardModel(inputs, nowMs);
    expect(model.kind).toBe(getStatus(nowMs, inputs.sessions, inputs.marks).kind);
  });

  it('covers all six states with the six instants', () => {
    const kinds = Object.values(NOWS).map((n) => buildDashboardModel(inputs, n).kind);
    expect(kinds).toEqual(['before-term', 'in-class', 'break', 'done-today', 'no-class-today', 'after-term']);
  });
});

describe('dashboard model: numbers come from core', () => {
  const model = buildDashboardModel(inputs, NOWS.inClass);
  const view = model.active[0];
  const pool = inputs.pools.find((p) => p.key === view.poolKey)!;

  it('shows session i of N, the unit price and the cost of the running session', () => {
    expect(view.id).toBe(CLASS_ID);
    expect(view.ordinal).toEqual({ index: 10, total: 14 }); // the 10th of 14 Thursday classes this semester
    expect(view.label).toBe('MFIN7002');
    expect(view.rateText).toBe('HK$1.2708');
    expect(view.ratePerSec).toBe(pool.sessions.find((s) => s.id === CLASS_ID)!.ratePerSec);
    expect(view.costMinor).toBe(1372414);
  });

  it('live values equal sessionStateAt / poolStateAt at the same instant', () => {
    for (const nowMs of [CLASS_START, NOWS.inClass, NOWS.inClass + 1234, CLASS_END - 1]) {
      const live = liveAt(model, view.id, nowMs);
      const st = sessionStateAt(pool, view.id, nowMs)!;
      const ps = poolStateAt(pool, nowMs);
      expect(live.sessionConsumedMinor).toBe(st.consumedMinor);
      expect(live.sessionRemainingMinor).toBe(st.remainingMinor);
      expect(live.poolConsumedMinor).toBe(ps.consumedMinor);
      expect(live.poolRemainingMinor).toBe(ps.remainingMinor);
      expect(live.poolConsumedMinor + live.poolRemainingMinor).toBe(39_800_000);
    }
    const live = liveAt(model, view.id, NOWS.inClass);
    expect(live.elapsedSec).toBe(1800);
    expect(live.remainingSec).toBe(9000);
    expect(durationText(live.elapsedSec)).toBe('00:30:00');
    expect(durationText(live.remainingSec)).toBe('02:30:00');
  });

  it('keeps consumed + remaining equal to the tuition at 1000 instants around the term', () => {
    const start = hk('2026-08-01T00:00:00');
    const end = hk('2027-05-31T00:00:00');
    for (let i = 0; i < 1000; i++) {
      const nowMs = start + Math.floor(((end - start) * i) / 999);
      const m = buildDashboardModel(inputs, nowMs);
      const live = liveAt(m, m.active[0]?.id ?? null, nowMs);
      if (m.pool) expect(live.poolConsumedMinor + live.poolRemainingMinor).toBe(live.poolTuitionMinor);
      const total = billingStateAt(inputs.pools, nowMs);
      expect(total.consumedMinor + total.remainingMinor).toBe(total.tuitionMinor);
    }
  });

  it('break: countdown to the next class, its cost, and no settlement before the first class of the day', () => {
    const m = buildDashboardModel(inputs, NOWS.break);
    expect(m.kind).toBe('break');
    expect(m.next?.id).toBe(CLASS_ID);
    expect(liveAt(m, m.next!.id, NOWS.break).countdownSec).toBe(7200);
    expect(m.prevSettlement).toBeNull();
    expect(m.timeline).toHaveLength(1);
  });

  it('done today: spent today equals the cost of today\'s class; no class today: nothing today; next class is named', () => {
    const done = buildDashboardModel(inputs, NOWS.doneToday);
    expect(done.todaySpentMinor).toBe(1372414);
    expect(done.timeline).toHaveLength(1);
    const none = buildDashboardModel(inputs, NOWS.noClassToday);
    expect(none.todaySpentMinor).toBe(0);
    expect(none.timeline).toEqual([]);
    expect(none.nextWhen).not.toBeNull();
    expect(none.nextWhen!.time).toBe('09:00');
  });

  it('before the term: days until the first class and the pool\'s totals; after the term: the whole term\'s totals', () => {
    const before = buildDashboardModel(inputs, NOWS.beforeTerm);
    expect(before.daysUntilTerm).toBe(14);
    expect(before.term).toMatchObject({ sessionCount: 29, hours: '87.0', tuitionMinor: 39_800_000, rateText: 'HK$1.2708' });
    const after = buildDashboardModel(inputs, NOWS.afterTerm);
    expect(after.term).toMatchObject({ sessionCount: 58, hours: '174.0', tuitionMinor: 79_600_000 });
  });

  it('calendarDaysBetween counts local calendar days', () => {
    expect(calendarDaysBetween(hk('2026-08-20T23:59:00'), hk('2026-09-02T00:01:00'))).toBe(13);
    expect(calendarDaysBetween(hk('2026-08-20T00:01:00'), hk('2026-08-20T23:59:00'))).toBe(0);
  });
});

describe('dashboard model: overlapping classes', () => {
  const overlapText = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//t//t//EN',
    'BEGIN:VEVENT',
    'UID:a@t',
    'DTSTART:20261112T020000Z',
    'DTEND:20261112T050000Z',
    'RRULE:FREQ=WEEKLY;COUNT=6',
    'SUMMARY:AAAA1000 First',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:b@t',
    'DTSTART:20261112T030000Z',
    'DTEND:20261112T060000Z',
    'RRULE:FREQ=WEEKLY;COUNT=6',
    'SUMMARY:BBBB2000 Second',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');

  it('lists every session in progress, the primary one first, and honours the chosen one', () => {
    const sessions = expandIcs(overlapText);
    const built = buildConfig({ ...initialDraft(), tuitionText: '60000', billingPeriod: 'year' }, groupSessions(sessions), [{ id: 'x', name: 'x' }])!;
    const ov = inputsFor(built, [overlapText]);
    const nowMs = Date.parse('2026-11-12T03:30:00Z');
    const model = buildDashboardModel(ov, nowMs);
    expect(model.kind).toBe('in-class');
    expect(model.active.map((v) => v.label)).toEqual(['AAAA1000', 'BBBB2000']);
    expect(shownView(model, null)?.label).toBe('AAAA1000');
    expect(shownView(model, model.active[1].id)?.label).toBe('BBBB2000');
    expect(shownView(model, 'not-active')?.label).toBe('AAAA1000');
  });
});

describe('dashboard model: validity window', () => {
  it('stays valid until the next session boundary or midnight', () => {
    const m = buildDashboardModel(inputs, NOWS.inClass);
    expect(m.validFromMs).toBe(CLASS_START);
    expect(m.validUntilMs).toBe(CLASS_END);
    const early = buildDashboardModel(inputs, NOWS.break);
    expect(early.validUntilMs).toBe(CLASS_START);
    const quiet = buildDashboardModel(inputs, NOWS.noClassToday);
    expect(quiet.validUntilMs).toBeLessThanOrEqual(hk('2026-11-14T00:00:00'));
  });

  it('screen-reader summary names the class, the amount and the minutes left', () => {
    const m = buildDashboardModel(inputs, NOWS.inClass);
    expect(summaryText(m, null, NOWS.inClass)).toBe('上课中：MFIN7002，本节已消耗 HK$2,287.36，还剩约 150 分钟。');
    expect(summaryText(buildDashboardModel(inputs, NOWS.break), null, NOWS.break)).toContain('课间');
  });
});

describe('dashboardModel signal', () => {
  it('is a computed signal (declared; exercised in the component tests)', () => {
    expect(typeof dashboardModel.subscribe).toBe('function');
  });
});
