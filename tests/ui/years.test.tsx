// @vitest-environment happy-dom
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPools } from '../../src/core/billing';
import { formatMinor } from '../../src/core/money';
import { computeStats, historySummary } from '../../src/core/stats';
import { config, marks } from '../../src/state/data';
import { dashboardModel } from '../../src/state/dashboardState';
import { expandIcs } from '../../src/core/ics/expand';
import { rateText } from '../../src/state/dashboard';
import { allSessions, billableOf, billableSessions, billingConfigOf, pools } from '../../src/state/derived';
import { setMark } from '../../src/state/marks';
import { newYear, newYearPlan, setNewGroupSelected, startNewYear } from '../../src/state/newYear';
import { yearInfos } from '../../src/state/years';
import { boot, flushSaves, teardown } from './harness';
import { CLASS_ID, NEXT_CLASS_ID, NOWS, NOWS_Y2, fixtureConfig, fullTermText, hk, nextYearText, twoYearConfig } from '../state/fixture-app';
import { buildStatsModel } from '../../src/state/stats';
import { dashboardInputs } from '../../src/state/dashboardState';

const OLD_MARKS = { marks: { [CLASS_ID]: { status: 'skipped' } } };
const OLD_SLACKS = { records: [{ id: 'r-old', sessionId: CLASS_ID, startMs: hk('2026-11-12T10:00:00'), endMs: hk('2026-11-12T10:30:00') }] };
const twoYears = { configOverride: twoYearConfig(), texts: [fullTermText, nextYearText] };

afterEach(() => {
  teardown();
  vi.restoreAllMocks();
});

describe('two academic years: which one is current, which one is an archive', () => {
  it('now in the new year: 2027 is current and 2026 is a read-only archive; marking an old class is refused, a new one works', async () => {
    const h = await boot({ ...twoYears, path: '/sessions', nowMs: NOWS_Y2.inClass });
    expect(yearInfos.value.map((y) => [y.year, y.role])).toEqual([
      [2026, 'archived'],
      [2027, 'current'],
    ]);
    const putsBefore = h.server.puts('marks').length;
    expect(setMark(CLASS_ID, 'skipped')).toBe(false); // 2026-11-12 is in the archive
    expect(setMark('nx-thu-s1@fixture|2027-10-14T02:00:00Z', 'cancelled')).toBe(true);
    await flushSaves();
    expect(h.server.puts('marks').length).toBe(putsBefore + 1);
    expect((marks.value.marks as Record<string, unknown>)[CLASS_ID]).toBeUndefined();
    expect(marks.value.marks).toHaveProperty(['nx-thu-s1@fixture|2027-10-14T02:00:00Z']);
  });

  it('now in the old year: 2026 is current and the new year is upcoming, so its classes can be marked in advance', async () => {
    const h = await boot({ ...twoYears, path: '/sessions', nowMs: NOWS.inClass });
    expect(yearInfos.value.map((y) => [y.year, y.role])).toEqual([
      [2026, 'current'],
      [2027, 'upcoming'],
    ]);
    expect(setMark(CLASS_ID, 'skipped')).toBe(true);
    expect(setMark(NEXT_CLASS_ID, 'cancelled')).toBe(true);
    await flushSaves();
    expect(h.server.puts('marks').length).toBeGreaterThan(0);
  });

  it('the session list: archived classes have disabled mark buttons and a read-only note; a year switch jumps between the years', async () => {
    const h = await boot({ ...twoYears, path: '/sessions', nowMs: NOWS_Y2.inClass, docs: { marks: OLD_MARKS } });
    const chips = h.$$('#year-chips .year-chip');
    expect(chips.map((c) => c.getAttribute('data-year'))).toEqual(['2026', '2027']);
    expect(chips.map((c) => c.getAttribute('data-role'))).toEqual(['archived', 'current']);
    expect(chips[1].getAttribute('aria-pressed')).toBe('true'); // this week is in 2027
    // jump to the archive: its last week; select a class there
    await h.click('.year-chip[data-year="2026"]');
    expect(h.$('.year-chip[data-year="2026"]')?.getAttribute('aria-pressed')).toBe('true');
    const row = h.$('tr[data-session-id] .row-btn');
    expect(row).not.toBeNull();
    await h.click('tr[data-session-id] .row-btn');
    expect(h.$<HTMLButtonElement>('#mark-skip')?.disabled).toBe(true);
    expect(h.$<HTMLButtonElement>('#mark-cancel')?.disabled).toBe(true);
    expect(h.$('#readonly-note')?.textContent).toContain('已归档');
    // back to the current year: marks work again
    await h.click('.year-chip[data-year="2027"]');
    await h.click('tr[data-session-id] .row-btn');
    expect(h.$<HTMLButtonElement>('#mark-skip')?.disabled).toBe(false);
    expect(h.$('#readonly-note')).toBeNull();
  });

  it('the main screen shows the current year only: the tank is the 2027 semester, not a blend of both years', async () => {
    await boot({ ...twoYears, path: '/', nowMs: NOWS_Y2.inClass });
    expect(pools.value.map((p) => p.key)).toEqual(['2026-S1', '2026-S2', '2027-S1']);
    const model = dashboardModel.value;
    expect(model.kind).toBe('in-class');
    expect(model.pools.map((p) => p.key)).toEqual(['2027-S1']);
    expect(model.pool?.key).toBe('2027-S1');
  });

  it('between the years the main screen counts down to the new year instead of saying "no class today"', async () => {
    const h = await boot({ ...twoYears, path: '/', nowMs: NOWS_Y2.beforeTerm });
    expect(dashboardModel.value.kind).toBe('before-term');
    expect(h.$('#dashboard')?.getAttribute('data-status')).toBe('before-term');
    expect(dashboardModel.value.pool?.key).toBe('2027-S1');
    expect(dashboardModel.value.daysUntilTerm).toBe(17); // 2027-08-20 -> 2027-09-06
  });

  it('after the last class of the newest year, the screen shows the end-of-term summary of that year', async () => {
    await boot({ ...twoYears, path: '/', nowMs: NOWS_Y2.afterTerm });
    expect(dashboardModel.value.kind).toBe('after-term');
    expect(dashboardModel.value.term?.sessionCount).toBe(43);
  });
});

describe('statistics merge the history of the years', () => {
  it('the history total equals the sum of the years and the all-years total from core; the table shows it', async () => {
    const h = await boot({ ...twoYears, path: '/stats', nowMs: NOWS_Y2.afterTerm, docs: { marks: OLD_MARKS, slacks: OLD_SLACKS } });
    const inputs = dashboardInputs.value;
    const model = buildStatsModel(inputs, NOWS_Y2.afterTerm);
    expect(model.history).not.toBeNull();
    const rows = model.history!.rows;
    expect(rows.map((r) => r.year)).toEqual([2026, 2027]);
    expect(rows.reduce((sum, r) => sum + r.costMinor, 0)).toBe(model.history!.total.costMinor);
    const all = computeStats({ sessions: inputs.sessions, pools: inputs.pools, courses: inputs.courses, marks: inputs.marks, slacks: inputs.slacks, nowMs: NOWS_Y2.afterTerm });
    expect(model.history!.total.costMinor).toBe(all.totalCostMinor);
    const h2 = historySummary({ sessions: inputs.sessions, pools: inputs.pools, courses: inputs.courses, marks: inputs.marks, slacks: inputs.slacks, nowMs: NOWS_Y2.afterTerm }, inputs.academic!);
    expect(h2.total.costMinor).toBe(2 * 398_000_00 + 398_000_00); // two semesters in 2026, one in 2027: every pool fully over

    const costs = h.$$('#history-table [data-field="history-cost"]').map((c) => c.textContent);
    expect(costs).toEqual([formatMinor(2 * 398_000_00, 'HKD'), formatMinor(398_000_00, 'HKD'), formatMinor(3 * 398_000_00, 'HKD')]);
    expect(h.$$('#history-table tbody tr').map((r) => r.getAttribute('data-year'))).toEqual(['2026', '2027', 'total']);
    expect(h.$('#history-table tr[data-year="2026"]')?.getAttribute('data-role')).toBe('archived');
  });

  it('one academic year only: no history card (nothing to merge)', async () => {
    const h = await boot({ path: '/stats', nowMs: NOWS.afterTerm });
    expect(h.$('#history-card')).toBeNull();
  });
});

describe('settings: the academic years', () => {
  it('lists every year with its role; the tuition of an archived year cannot be edited, the current one can', async () => {
    const h = await boot({ ...twoYears, path: '/settings', nowMs: NOWS_Y2.inClass });
    const items = h.$$('#year-list li');
    expect(items.map((li) => li.getAttribute('data-year'))).toEqual(['2026', '2027']);
    expect(items.map((li) => li.querySelector('[data-field="year-role"]')?.textContent)).toEqual(['已归档 · 只读', '进行中']);
    expect(h.$('#year-list li[data-year="2027"] [data-field="year-facts"]')?.textContent).toBe('43 节 · 129.0 小时');
    expect(h.$<HTMLInputElement>('#pool-tuition-2026-S1')?.disabled).toBe(true);
    expect(h.$<HTMLInputElement>('#pool-tuition-2026-S2')?.disabled).toBe(true);
    expect(h.$<HTMLInputElement>('#pool-tuition-2027-S1')?.disabled).toBe(false);
    expect(h.$('[data-pool-key="2026-S1"] [data-field="archived-tag"]')).not.toBeNull();
  });
});

describe('importing a new academic year', () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it('keeps the old year\'s marks and slacking records, recognises only the new course, and builds the 2027 pool', async () => {
    const h = await boot({ path: '/settings', nowMs: NOWS_Y2.inClass, docs: { marks: OLD_MARKS, slacks: OLD_SLACKS } });
    expect(pools.value.map((p) => p.key)).toEqual(['2026-S1', '2026-S2']);
    const marksBefore = JSON.stringify(marks.value);
    const marksPuts = h.server.puts('marks').length;
    expect(h.$$('#year-list li')).toHaveLength(1);

    await act(async () => {
      await startNewYear([{ name: 'next-year.ics', data: bytes(nextYearText) }]);
    });
    await h.settle();
    const plan = newYearPlan.value!;
    expect(plan.newSessionCount).toBe(43);
    // MFIN7001 / MFIN7002 are known courses: only MFIN7003 needs a decision
    expect(plan.groups.map((g) => g.code)).toEqual(['MFIN7003']);
    expect(plan.newCourses.map((c) => c.code)).toEqual(['MFIN7003']);
    expect(plan.newPools.map((p) => [p.key, p.text])).toEqual([['2027-S1', '398,000.00']]);
    expect(plan.rateChanges).toEqual([]); // the existing semesters keep their unit price
    expect(h.$('#new-year-panel')).not.toBeNull();
    expect(h.$$('#new-year-panel .course-row')).toHaveLength(1);

    await h.type('#new-pool-2027-S1', '450000');
    await h.click('#new-year-confirm');
    await flushSaves();
    expect(newYear.value).toBeNull();
    expect(config.value.courses?.map((c) => c.code)).toEqual(['MFIN7001', 'MFIN7002', 'MFIN7003']);
    expect(config.value.tuition?.byPool?.['2027-S1']).toBe(450_000_00);
    expect(config.value.calendars).toHaveLength(2);
    expect(pools.value.map((p) => p.key)).toEqual(['2026-S1', '2026-S2', '2027-S1']);
    expect(pools.value.find((p) => p.key === '2027-S1')?.tuitionMinor).toBe(450_000_00);
    // the old year's pools are exactly as before
    const old = buildPools(billableSessions.value.filter((s) => s.startMs < hk('2027-06-01T00:00:00')), billingConfigOf(config.value));
    expect(old.map((p) => p.tuitionMinor)).toEqual([398_000_00, 398_000_00]);
    // marks and slacking records were not touched (no write at all) and the old class is now read-only
    expect(JSON.stringify(marks.value)).toBe(marksBefore);
    expect(h.server.puts('marks').length).toBe(marksPuts);
    expect(h.server.docs.slacks.records).toEqual(OLD_SLACKS.records);
    expect(setMark(CLASS_ID, null)).toBe(false);
    expect(h.$$('#year-list li').map((li) => li.getAttribute('data-role'))).toEqual(['archived', 'current']);
    expect(h.$('#new-year-status')?.textContent).toBe('新学年已建立。');
  });

  it('the tuition field is checked: zero / text blocks the confirmation, an unticked new course blocks it too', async () => {
    const h = await boot({ path: '/settings', nowMs: NOWS_Y2.inClass });
    await act(async () => {
      await startNewYear([{ name: 'next-year.ics', data: bytes(nextYearText) }]);
    });
    await h.settle();
    expect(h.$<HTMLButtonElement>('#new-year-confirm')?.disabled).toBe(false);
    await h.type('#new-pool-2027-S1', '0');
    expect(h.$<HTMLButtonElement>('#new-year-confirm')?.disabled).toBe(true);
    await h.type('#new-pool-2027-S1', '398000');
    expect(h.$<HTMLButtonElement>('#new-year-confirm')?.disabled).toBe(false);
    // untick the new course: the new calendar then adds only classes of known courses, which is fine
    const box = h.$<HTMLInputElement>('#new-year-panel .course-row input[type="checkbox"]')!;
    await act(async () => box.click());
    await h.settle();
    expect(newYearPlan.value!.newCourses).toEqual([]);
    expect(h.$<HTMLButtonElement>('#new-year-confirm')?.disabled).toBe(false);
    expect(newYearPlan.value!.newPools.map((p) => p.key)).toEqual(['2027-S1']);
  });

  it('cancel deletes the calendar file this import added and changes nothing else', async () => {
    const h = await boot({ path: '/settings', nowMs: NOWS_Y2.inClass });
    const cfgBefore = JSON.stringify(config.value);
    await act(async () => {
      await startNewYear([{ name: 'next-year.ics', data: bytes(nextYearText) }]);
    });
    await h.settle();
    expect(allSessions.value.length).toBeGreaterThan(58);
    await h.click('#new-year-cancel');
    expect(newYear.value).toBeNull();
    expect(h.server.calendars.size).toBe(1);
    expect(allSessions.value).toHaveLength(58);
    expect(JSON.stringify(config.value)).toBe(cfgBefore);
    expect(h.$('#new-year-status')?.textContent).toBe('已取消，刚导入的日历文件已删除。');
  });

  it('a file that adds nothing new (already imported) is reported and starts no flow', async () => {
    const h = await boot({ path: '/settings', nowMs: NOWS.inClass });
    await act(async () => {
      await startNewYear([{ name: 'full-term.ics', data: bytes(fullTermText) }]);
    });
    await h.settle();
    expect(newYear.value).toBeNull();
    expect(h.$('#new-year-status')?.textContent).toContain('没有读到新的课节');
    expect(h.$('#new-year-panel')).toBeNull();
  });

  it('extra classes in an existing semester show "unit price from X to Y" in the panel (X, Y from core)', async () => {
    const one = { ...fixtureConfig(), courses: (fixtureConfig().courses ?? []).slice(0, 1) };
    const h = await boot({ path: '/settings', nowMs: NOWS.inClass, configOverride: one });
    // a second calendar with the same course in the same semesters: twice as many classes, so the unit price halves
    const doubled = fullTermText.replace(/UID:(ft-[a-z0-9-]+)@fixture/g, (_m, id: string) => `UID:${id}-b@fixture`);
    await act(async () => {
      await startNewYear([{ name: 'more.ics', data: bytes(doubled) }]);
    });
    // the second course (also in the new file) is not ticked: only the known course's classes change the price
    for (const g of newYearPlan.value!.groups) setNewGroupSelected(g.key, false);
    await h.settle();
    const plan = newYearPlan.value!;
    const course = one.courses[0];
    const sessions = [...expandIcs(fullTermText), ...expandIcs(doubled)];
    const before = buildPools(billableOf(expandIcs(fullTermText), [course]), billingConfigOf(one));
    const after = buildPools(billableOf(sessions, [course]), billingConfigOf(one));
    expect(plan.newPools).toEqual([]);
    expect(plan.rateChanges.map((c) => [c.poolKey, c.fromText, c.toText])).toEqual(
      after.map((p) => [p.key, rateText(before.find((b) => b.key === p.key)!.averageRatePerSec, 'HKD'), rateText(p.averageRatePerSec, 'HKD')]),
    );
    expect(plan.rateChanges.length).toBeGreaterThan(0);
    expect(h.$$('#new-year-rate-changes li').length).toBe(plan.rateChanges.length);
    expect(h.$('#new-year-rate-changes li')?.textContent).toContain('单价将从');
  });
});
